// Launch-radar model for token-radar-01, written for this entry.
//
// Idea in one paragraph: the snapshot's protocols that already record a token
// are the only honest teachers available. Fit log(market cap) on log(TVL), the
// seven-day TVL change and the protocol's age on those 129 live protocols,
// letting each category shift the intercept (shrunk toward the global line
// when a category has few live examples). Then read every pre-token protocol
// through that fitted surface: its implied value is what a token would be
// worth if the market priced this protocol's record the way it prices the
// live set's records. The fit is validated two ways — a stratified holdout
// and a walk-forward over listing time — and both error reports travel with
// the board into the dashboard, so a reader can see how wide the error bars
// honestly are instead of being handed a single confident number.
//
// Everything here is deterministic: no clock, no randomness, no network.
// The "now" of the model is the snapshot's own as_of date.

// ---------------------------------------------------------------------------
// Snapshot types and parsing
// ---------------------------------------------------------------------------

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot: protocols and watchlist must be arrays');
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** Whole days from an ISO date to the snapshot's as_of date; 0 when unknown. */
export function ageInDays(listedAt: string | null, asOf: string): number {
  if (listedAt === null) return 0;
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  const end = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / DAY_MS));
}

/** The seven-day change as the model sees it: missing reads 0, wild reads clamped hard. */
export function growthInput(change7d: number | null): number {
  if (change7d === null || !Number.isFinite(change7d)) return 0;
  return Math.max(-40, Math.min(40, change7d));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[at]!;
}

/** Solve a small dense linear system by Gaussian elimination with pivoting. */
function solveLinear(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(a[pivot]![col]!) < 1e-12) continue;
    const swap = a[col]!;
    a[col] = a[pivot]!;
    a[pivot] = swap;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r]![col]! / a[col]![col]!;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) a[r]![c] = a[r]![c]! - factor * a[col]![c]!;
    }
  }
  return a.map((row, i) => (Math.abs(row[i]!) < 1e-12 ? 0 : row[n]! / row[i]!));
}

/** Weighted least squares for y ~ X beta, with a whisper of ridge for stability. */
function fitWls(rows: number[][], targets: number[], weights: number[]): number[] {
  const width = rows[0]!.length;
  const xtx: number[][] = Array.from({ length: width }, () => new Array<number>(width).fill(0));
  const xty: number[] = new Array<number>(width).fill(0);
  rows.forEach((row, i) => {
    const w = weights[i]!;
    for (let a = 0; a < width; a++) {
      xty[a] = xty[a]! + w * row[a]! * targets[i]!;
      for (let b = 0; b < width; b++) xtx[a]![b] = xtx[a]![b]! + w * row[a]! * row[b]!;
    }
  });
  for (let a = 1; a < width; a++) xtx[a]![a] = xtx[a]![a]! + 1e-9;
  return solveLinear(xtx, xty);
}

/**
 * Robust fit: plain least squares first, then two reweighting passes that
 * down-weight rows whose residual is large next to the median absolute
 * residual. The live set holds a few protocols whose market cap sits orders
 * of magnitude off their TVL; without this they drag the whole surface.
 */
function fitRobust(rows: number[][], targets: number[]): number[] {
  let beta = fitWls(rows, targets, rows.map(() => 1));
  for (let pass = 0; pass < 2; pass++) {
    const residuals = rows.map((row, i) => targets[i]! - row.reduce((s, x, k) => s + x * beta[k]!, 0));
    const scale = Math.max(0.05, median(residuals.map((r) => Math.abs(r))) * 1.4826);
    const weights = residuals.map((r) => 1 / Math.max(1, Math.abs(r) / (1.5 * scale)));
    beta = fitWls(rows, targets, weights);
  }
  return beta;
}

// ---------------------------------------------------------------------------
// Which protocols may stand on the board
// ---------------------------------------------------------------------------

const PRODUCT_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/**
 * A wrapped, staked or bridged product of a token that already trades is not
 * a launch waiting to happen. This mirrors the watchlist's own definition so
 * the early rows below the floor are held to the same standard as the 40.
 */
export function isProductOfTradedToken(p: Protocol): boolean {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return true;
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return true;
  if (VERSION_SUFFIX.test(p.name)) return true;
  return EXCHANGE_PREFIXES.some((prefix) => p.name.startsWith(`${prefix} `) || p.name === prefix);
}

export function recordsToken(p: Protocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

// ---------------------------------------------------------------------------
// The fitted value surface
// ---------------------------------------------------------------------------

export interface ValueFit {
  intercept: number;
  onLogTvl: number;
  onGrowth: number;
  onLogAge: number;
  /** Shrunk per-category intercept offsets, keyed by category name. */
  categoryShift: Map<string, number>;
  liveCount: number;
}

const SHRINKAGE_K = 6;

function featuresOf(p: Protocol, asOf: string): number[] {
  const age = ageInDays(p.listed_at, asOf);
  return [1, Math.log(Math.max(1, p.tvl_usd)), growthInput(p.change_7d), Math.log(1 + age)];
}

function categoryKey(p: Protocol): string {
  return p.category ?? 'Uncategorised';
}

/** Fit the global line, then shrink each category's mean residual into an offset. */
export function fitValueSurface(live: Protocol[], asOf: string): ValueFit {
  const rows = live.map((p) => featuresOf(p, asOf));
  const targets = live.map((p) => Math.log(Math.max(1, p.mcap_usd ?? 1)));
  const beta = fitRobust(rows, targets);
  const residualByCategory = new Map<string, number[]>();
  live.forEach((p, i) => {
    const predicted = rows[i]!.reduce((sum, x, k) => sum + x * beta[k]!, 0);
    const key = categoryKey(p);
    const bucket = residualByCategory.get(key) ?? [];
    bucket.push(targets[i]! - predicted);
    residualByCategory.set(key, bucket);
  });
  const categoryShift = new Map<string, number>();
  for (const [key, residuals] of residualByCategory) {
    const n = residuals.length;
    categoryShift.set(key, (median(residuals) * n) / (n + SHRINKAGE_K));
  }
  return {
    intercept: beta[0]!,
    onLogTvl: beta[1]!,
    onGrowth: beta[2]!,
    onLogAge: beta[3]!,
    categoryShift,
    liveCount: live.length,
  };
}

/** The model's log implied value for one protocol, and its parts for display. */
export function impliedParts(fit: ValueFit, p: Protocol, asOf: string): {
  logValue: number;
  baseMultiple: number;
  growthFactor: number;
  maturityFactor: number;
  categoryShift: number;
} {
  const f = featuresOf(p, asOf);
  const shift = fit.categoryShift.get(categoryKey(p)) ?? 0;
  const logValue = fit.intercept + shift + fit.onLogTvl * f[1]! + fit.onGrowth * f[2]! + fit.onLogAge * f[3]!;
  return {
    logValue,
    baseMultiple: Math.exp(fit.intercept + shift + (fit.onLogTvl - 1) * f[1]!),
    growthFactor: Math.exp(fit.onGrowth * f[2]!),
    maturityFactor: Math.exp(fit.onLogAge * f[3]!),
    categoryShift: shift,
  };
}

// ---------------------------------------------------------------------------
// Validation: holdout and walk-forward, reported honestly
// ---------------------------------------------------------------------------

export interface ErrorReport {
  n: number;
  medianRatio: number;
  medianAbsLogError: number;
  p25Ratio: number;
  p75Ratio: number;
}

function scoreFit(fit: ValueFit, test: Protocol[], asOf: string): ErrorReport {
  const ratios: number[] = [];
  const absErrors: number[] = [];
  for (const p of test) {
    const actual = Math.max(1, p.mcap_usd ?? 1);
    const predicted = Math.exp(impliedParts(fit, p, asOf).logValue);
    ratios.push(predicted / actual);
    absErrors.push(Math.abs(Math.log(predicted / actual)));
  }
  return {
    n: test.length,
    medianRatio: median(ratios),
    medianAbsLogError: median(absErrors),
    p25Ratio: quantile(ratios, 0.25),
    p75Ratio: quantile(ratios, 0.75),
  };
}

/**
 * Stratified 70/30 split: within each category (sorted by slug), an evenly
 * spaced 30% goes to test — positions where the cumulative 0.3 share crosses
 * a whole number — so small categories contribute proportionally too.
 */
export function holdoutReport(live: Protocol[], asOf: string): ErrorReport {
  const byCategory = new Map<string, Protocol[]>();
  for (const p of live) {
    const bucket = byCategory.get(categoryKey(p)) ?? [];
    bucket.push(p);
    byCategory.set(categoryKey(p), bucket);
  }
  const train: Protocol[] = [];
  const test: Protocol[] = [];
  for (const key of [...byCategory.keys()].sort()) {
    const group = byCategory.get(key)!.sort((a, b) => (a.slug < b.slug ? -1 : 1));
    group.forEach((p, i) => {
      const crosses = Math.floor((i + 1) * 0.3) > Math.floor(i * 0.3);
      (crosses ? test : train).push(p);
    });
  }
  return scoreFit(fitValueSurface(train, asOf), test, asOf);
}

/** Fit on protocols listed before each cut, score on those listed after it. */
export function walkForwardReports(live: Protocol[], asOf: string): { cut: string; report: ErrorReport }[] {
  const cuts = ['2023-07-01', '2024-07-01'];
  const out: { cut: string; report: ErrorReport }[] = [];
  for (const cut of cuts) {
    const train = live.filter((p) => p.listed_at !== null && p.listed_at < cut);
    const test = live.filter((p) => p.listed_at !== null && p.listed_at >= cut);
    if (train.length < 20 || test.length < 5) continue;
    out.push({ cut, report: scoreFit(fitValueSurface(train, asOf), test, asOf) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Farm plans with a stated cost model
// ---------------------------------------------------------------------------

interface Archetype {
  label: string;
  actionsPerWeek: number;
  weeks: number;
  capitalUsd: number;
  venue: string;
  routine: string;
}

const ARCHETYPES: Record<string, Archetype> = {
  'swap-and-lp': {
    label: 'Swap flow + concentrated liquidity',
    actionsPerWeek: 9, weeks: 10, capitalUsd: 1500,
    venue: 'its main pool',
    routine: 'route swaps through the protocol and keep a tight-range LP position rebalanced',
  },
  'lend-loop': {
    label: 'Supply, borrow and repay cycles',
    actionsPerWeek: 6, weeks: 12, capitalUsd: 2000,
    venue: 'its largest money market',
    routine: 'supply collateral, borrow conservatively against it and repay on a weekly cycle',
  },
  'vault-deposit': {
    label: 'Vault deposit with periodic top-ups',
    actionsPerWeek: 3, weeks: 12, capitalUsd: 2500,
    venue: 'its flagship vault',
    routine: 'deposit into the vault, top up on a schedule and rotate between its strategies',
  },
  'stake-and-vote': {
    label: 'Stake and governance participation',
    actionsPerWeek: 2, weeks: 14, capitalUsd: 1200,
    venue: 'its staking contract',
    routine: 'stake the base asset, claim and restake rewards, and vote where governance is live',
  },
  'basis-and-hedge': {
    label: 'Basis position with a hedge leg',
    actionsPerWeek: 7, weeks: 8, capitalUsd: 3000,
    venue: 'its main basis market',
    routine: 'hold the basis position, rebalance the hedge leg and harvest the funding spread',
  },
  'active-user': {
    label: 'Regular product usage',
    actionsPerWeek: 5, weeks: 10, capitalUsd: 800,
    venue: 'its main product surface',
    routine: 'use the core product on a weekly rhythm so the wallet builds a real usage history',
  },
};

function archetypeFor(category: string | null): Archetype {
  switch (category) {
    case 'Dexs':
    case 'Derivatives':
    case 'Perps':
      return ARCHETYPES['swap-and-lp']!;
    case 'Lending':
    case 'CDP':
      return ARCHETYPES['lend-loop']!;
    case 'Yield':
    case 'Yield Aggregator':
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
      return ARCHETYPES['vault-deposit']!;
    case 'Staking Pool':
    case 'Liquid Restaking':
      return ARCHETYPES['stake-and-vote']!;
    case 'Basis Trading':
    case 'Leveraged Farming':
      return ARCHETYPES['basis-and-hedge']!;
    default:
      return ARCHETYPES['active-user']!;
  }
}

/** Rough per-action gas in USD by the chain the action lands on. */
function gasPerActionUsd(chain: string): number {
  if (chain === 'Ethereum') return 9.5;
  if (chain === 'Solana') return 0.05;
  if (chain === 'Bitcoin') return 2.4;
  if (['Base', 'Arbitrum', 'Optimism', 'zkSync Era', 'Linea', 'Scroll', 'Blast', 'Mode'].includes(chain)) return 0.35;
  if (['Polygon', 'BSC', 'Avalanche', 'Gnosis', 'Fantom', 'Mantle'].includes(chain)) return 0.55;
  return 1.1;
}

export interface FarmPlan {
  archetype: string;
  totalCostUsd: number;
  weeks: number;
  capitalUsd: number;
  steps: string[];
}

const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

/** Build one protocol's farm plan: concrete steps, each carrying cost or time. */
export function farmPlanFor(p: Protocol, impliedUsd: number): FarmPlan {
  const arch = archetypeFor(p.category);
  const primaryChain = p.chains[0] ?? 'Ethereum';
  const gas = gasPerActionUsd(primaryChain);
  const actionCount = arch.actionsPerWeek * arch.weeks;
  const gasCost = gas * actionCount;
  const bridgeCost = p.chains.length > 1 ? Math.min(4, p.chains.length - 1) * 11 : 0;
  const slippageCost = arch.capitalUsd * 0.004;
  const totalCost = Math.max(9, Math.round(gasCost + bridgeCost + slippageCost));
  const costPct = impliedUsd > 0 ? (totalCost / impliedUsd) * 100 : 0;
  const chainList = p.chains.slice(0, 3).join(', ') || primaryChain;
  const steps = [
    `Open ${p.name} on ${primaryChain} and complete its onboarding or first deposit in week 1; budget ${money(gas * 3)} for the setup transactions and keep the position inside ${arch.venue}.`,
    `Commit ${money(arch.capitalUsd)} of working capital to the ${arch.label.toLowerCase()} route and ${arch.routine}, starting the same week so the wallet's history is continuous.`,
    `Run ${arch.actionsPerWeek} actions a week for ${arch.weeks} weeks on ${chainList} (about ${actionCount} transactions); at roughly ${money(gas)} gas per action on ${primaryChain} that is ${money(gasCost)} of network fees.`,
    p.chains.length > 1
      ? `Spread activity across its ${p.chains.length} chains rather than one: allow about ${money(bridgeCost)} in bridge fees and one extra transaction per chain each fortnight.`
      : `Stay on ${primaryChain} for the whole programme; with a single chain there is no bridge budget, so the full fee estimate is gas plus slippage only.`,
    `Review the position every two weeks and log TVL share and points or season progress where ${p.name} shows them; stop adding capital if the programme's rules change mid-season.`,
    `Total modelled cost is ${money(totalCost)} over ${arch.weeks} weeks (gas ${money(gasCost)}, bridges ${money(bridgeCost)}, slippage allowance ${money(slippageCost)}), which is ${costPct.toFixed(3)}% of the ${money(impliedUsd)} implied value: an estimate from the stated parameters, not a promise of a token or an airdrop.`,
  ];
  return { archetype: arch.label, totalCostUsd: totalCost, weeks: arch.weeks, capitalUsd: arch.capitalUsd, steps };
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number;
  watchlist: boolean;
  implied_low_usd: number;
  implied_high_usd: number;
  base_multiple: number;
  growth_factor: number;
  maturity_factor: number;
  farm_cost_usd: number;
  farm_weeks: number;
  farm_archetype: string;
  cost_pct_of_value: number;
}

export interface Radar {
  as_of: string;
  source: string;
  floor_usd: number;
  protocol_count: number;
  live_count: number;
  pre_token_count: number;
  excluded_product_count: number;
  board_size: number;
  early_size: number;
  model: {
    live_fit_count: number;
    intercept: number;
    on_log_tvl: number;
    on_growth: number;
    on_log_age: number;
    shrinkage_k: number;
    holdout: ErrorReport;
    walk_forward: { cut: string; report: ErrorReport }[];
    band_low_multiplier: number;
    band_high_multiplier: number;
  };
  rows: BoardRow[];
}

const BOARD_TARGET = 200;

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: Radar } {
  const asOf = snapshot.as_of;
  const watchlist = new Set(snapshot.watchlist);
  const live = snapshot.protocols.filter((p) => recordsToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const preToken = snapshot.protocols.filter((p) => !recordsToken(p));
  const candidates = preToken.filter((p) => !isProductOfTradedToken(p));

  const fit = fitValueSurface(live, asOf);
  const holdout = holdoutReport(live, asOf);
  const walkForward = walkForwardReports(live, asOf);
  const bandLow = Math.max(0.05, holdout.p25Ratio);
  const bandHigh = Math.min(20, holdout.p75Ratio);

  const scored = candidates.map((p) => {
    const parts = impliedParts(fit, p, asOf);
    const raw = Math.exp(parts.logValue);
    const implied = Math.max(1000, Math.min(100_000_000_000_000, Math.round(raw)));
    return { p, parts, implied };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : 1));

  // The board: every watchlist protocol, then the strongest early candidates
  // below the floor, up to the target size.
  const chosen = new Map<string, (typeof scored)[number]>();
  for (const s of scored) if (watchlist.has(s.p.slug)) chosen.set(s.p.slug, s);
  for (const s of scored) {
    if (chosen.size >= BOARD_TARGET) break;
    chosen.set(s.p.slug, s);
  }
  const finalScored = [...chosen.values()].sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : 1));

  const board: BoardRow[] = [];
  let previous = Number.POSITIVE_INFINITY;
  finalScored.forEach((s, i) => {
    let implied = Math.min(s.implied, previous);
    if (i > 0 && implied >= previous) implied = previous - 1;
    previous = implied;
    const plan = farmPlanFor(s.p, implied);
    board.push({
      slug: s.p.slug,
      name: s.p.name,
      rank: i + 1,
      implied_value_usd: implied,
      farm_steps: plan.steps,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      age_days: ageInDays(s.p.listed_at, asOf),
      watchlist: watchlist.has(s.p.slug),
      implied_low_usd: Math.max(1, Math.round(implied * bandLow)),
      implied_high_usd: Math.min(100_000_000_000_000, Math.round(implied * bandHigh)),
      base_multiple: Number(s.parts.baseMultiple.toFixed(3)),
      growth_factor: Number(s.parts.growthFactor.toFixed(3)),
      maturity_factor: Number(s.parts.maturityFactor.toFixed(3)),
      farm_cost_usd: plan.totalCostUsd,
      farm_weeks: plan.weeks,
      farm_archetype: plan.archetype,
      cost_pct_of_value: Number(((plan.totalCostUsd / implied) * 100).toFixed(4)),
    });
  });

  const radar: Radar = {
    as_of: asOf,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    protocol_count: snapshot.protocols.length,
    live_count: live.length,
    pre_token_count: preToken.length,
    excluded_product_count: preToken.length - candidates.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.watchlist).length,
    model: {
      live_fit_count: fit.liveCount,
      intercept: Number(fit.intercept.toFixed(4)),
      on_log_tvl: Number(fit.onLogTvl.toFixed(4)),
      on_growth: Number(fit.onGrowth.toFixed(4)),
      on_log_age: Number(fit.onLogAge.toFixed(4)),
      shrinkage_k: SHRINKAGE_K,
      holdout,
      walk_forward: walkForward,
      band_low_multiplier: Number(bandLow.toFixed(3)),
      band_high_multiplier: Number(bandHigh.toFixed(3)),
    },
    rows: board,
  };
  return { board, radar };
}

/** The data file the dashboard reads: the whole radar as one script. */
export function dataScript(radar: Radar): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}

/** A local mirror of the gate's board checks; null when the board is clean. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  const values = new Set<number>();
  for (const row of board) {
    if (!slugs.has(row.slug)) return `row ${row.slug} is not a snapshot protocol`;
    if (seen.has(row.slug)) return `slug ${row.slug} appears twice`;
    seen.add(row.slug);
    if (row.name.trim() === '') return `row ${row.slug} has an empty name`;
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd <= 0 || row.implied_value_usd > 100_000_000_000_000) {
      return `row ${row.slug} has an out-of-range implied value`;
    }
    values.add(row.implied_value_usd);
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `row ${row.slug} has ${row.farm_steps.length} farm steps`;
    for (const step of row.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `row ${row.slug} has a farm step of ${len} characters`;
    }
  }
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  byRank.forEach((row, i) => {
    if (row.rank !== i + 1) return `ranks are not exactly 1..N (rank ${row.rank} at position ${i + 1})`;
    if (i > 0 && row.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `implied value rises at rank ${row.rank}`;
  });
  if (board.length > 1 && values.size === 1) return 'every implied value is the same';
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist slug ${slug} is missing from the board`;
  }
  return null;
}
