// Launch Radar page logic: renders window.RADAR (written by main.ts as
// data.js beside this folder) into a sortable, filterable board with a
// per-protocol detail view. No network, no storage, no dependencies.

const R = window.RADAR;
const rows = R.rows;
const $ = (id) => document.getElementById(id);

const fmtUsd = (n) => {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n)}`;
};
const fmtAge = (days) => (days >= 365 ? `${(days / 365).toFixed(1)}y` : `${days}d`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- header

function renderKpis() {
  const m = R.model;
  const kpis = [
    [R.protocol_count, 'protocols scanned'],
    [`${R.board_size}`, 'on the board'],
    [`${R.model.live_fit_count}`, 'live protocols fitted'],
    [`${m.holdout.medianRatio.toFixed(2)}x`, 'holdout median ratio'],
    [`$${R.floor_usd / 1e6}M`, 'watchlist floor'],
  ];
  $('kpis').innerHTML = kpis.map(([v, l]) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`).join('');
}

function renderModelStrip() {
  const m = R.model;
  const wf = m.walk_forward
    .map((w) => `fit before ${w.cut}: median error ${w.report.medianAbsLogError.toFixed(2)} log on ${w.report.n} later listings`)
    .join(' &middot; ');
  $('model-strip').innerHTML =
    `<span>Model: <b>log value = ${m.intercept.toFixed(2)} + ${m.on_log_tvl.toFixed(2)}&middot;log TVL + ${m.on_growth.toFixed(3)}&middot;7d growth + ${m.on_log_age.toFixed(2)}&middot;log age</b>, category intercepts shrunk (k=${m.shrinkage_k})</span>` +
    `<span>Holdout (n=${m.holdout.n}): median ratio <b>${m.holdout.medianRatio.toFixed(2)}x</b>, middle half ${m.holdout.p25Ratio.toFixed(2)}x&ndash;${m.holdout.p75Ratio.toFixed(2)}x</span>` +
    `<span>Walk-forward: <b>${wf}</b></span>` +
    `<span>Board range uses the holdout middle half, shown per row</span>`;
}

// ---------------------------------------------------------------- filters

function fillFilterOptions() {
  const cats = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort();
  $('f-category').innerHTML = '<option value="">All categories</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');
  const chains = [...new Set(rows.flatMap((r) => r.chains))].sort();
  $('f-chain').innerHTML = '<option value="">All chains</option>' + chains.map((c) => `<option>${esc(c)}</option>`).join('');
}

function currentView() {
  const q = $('q').value.trim().toLowerCase();
  const cat = $('f-category').value;
  const chain = $('f-chain').value;
  const watchOnly = $('f-watch').checked;
  const maxCost = $('f-cost').value === '' ? Infinity : Number($('f-cost').value);
  let view = rows.filter((r) =>
    (q === '' || r.name.toLowerCase().includes(q) || r.slug.includes(q)) &&
    (cat === '' || r.category === cat) &&
    (chain === '' || r.chains.includes(chain)) &&
    (!watchOnly || r.watchlist) &&
    r.farm_cost_usd <= maxCost);
  const sort = $('f-sort').value;
  const by = {
    rank: (a, b) => a.rank - b.rank,
    tvl: (a, b) => b.tvl_usd - a.tvl_usd,
    growth: (a, b) => (b.change_7d ?? -Infinity) - (a.change_7d ?? -Infinity),
    cheap: (a, b) => a.farm_cost_usd - b.farm_cost_usd,
    age: (a, b) => b.age_days - a.age_days,
  }[sort];
  return view.sort(by);
}

// ---------------------------------------------------------------- board

let selectedSlug = null;

function renderBoard() {
  const view = currentView();
  $('count').textContent = `${view.length} of ${rows.length} protocols`;
  $('rows').innerHTML = view.map((r) => {
    const growth = r.change_7d === null ? '&ndash;'
      : `<span class="${r.change_7d >= 0 ? 'up' : 'down'}">${r.change_7d >= 0 ? '+' : ''}${r.change_7d.toFixed(1)}%</span>`;
    return `<tr data-slug="${esc(r.slug)}" class="${r.slug === selectedSlug ? 'selected' : ''}">
      <td>${r.rank}</td>
      <td class="name">${esc(r.name)}${r.watchlist ? '<span class="badge">watchlist</span>' : ''}</td>
      <td>${esc(r.category ?? '—')}</td>
      <td>${fmtUsd(r.tvl_usd)}</td><td>${growth}</td><td>${fmtAge(r.age_days)}</td>
      <td><b>${fmtUsd(r.implied_value_usd)}</b></td>
      <td>${fmtUsd(r.implied_low_usd)}&ndash;${fmtUsd(r.implied_high_usd)}</td>
      <td>${fmtUsd(r.farm_cost_usd)}</td><td>${r.cost_pct_of_value.toFixed(3)}%</td></tr>`;
  }).join('');
  for (const tr of document.querySelectorAll('#rows tr')) {
    tr.addEventListener('click', () => select(tr.dataset.slug, true));
  }
}

// ---------------------------------------------------------------- detail

function select(slug, rerender) {
  selectedSlug = slug;
  const r = rows.find((x) => x.slug === slug);
  const box = $('detail');
  if (!r) {
    box.innerHTML = '<p class="empty">Select a protocol on the board to see its value breakdown and farm plan.</p>';
    return;
  }
  const steps = r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('');
  box.innerHTML = `
    <h2>${esc(r.name)}${r.watchlist ? '<span class="badge">watchlist</span>' : ''}</h2>
    <div class="sub">Rank #${r.rank} &middot; ${esc(r.category ?? 'Uncategorised')} &middot; ${esc(r.chains.join(', '))} &middot; records no token in the snapshot</div>
    <h3>Value breakdown</h3>
    <table>
      <tr><td>Implied value</td><td><b>${fmtUsd(r.implied_value_usd)}</b></td></tr>
      <tr><td>Holdout range</td><td>${fmtUsd(r.implied_low_usd)} – ${fmtUsd(r.implied_high_usd)}</td></tr>
      <tr><td>TVL</td><td>${fmtUsd(r.tvl_usd)}</td></tr>
      <tr><td>Base multiple (fitted)</td><td>${r.base_multiple.toFixed(2)}x TVL</td></tr>
      <tr><td>Growth factor (7d ${r.change_7d === null ? 'n/a' : `${r.change_7d.toFixed(1)}%`})</td><td>${r.growth_factor.toFixed(2)}x</td></tr>
      <tr><td>Maturity factor (${fmtAge(r.age_days)} tokenless)</td><td>${r.maturity_factor.toFixed(2)}x</td></tr>
    </table>
    <h3>Farm plan — ${esc(r.farm_archetype)}</h3>
    <ol>${steps}</ol>
    <div class="verdict">Modelled farm cost <b>${fmtUsd(r.farm_cost_usd)}</b> over ${r.farm_weeks} weeks is
    <b>${r.cost_pct_of_value.toFixed(3)}%</b> of the implied value. Costs are parameter estimates
    (gas by chain, actions per week, bridges, slippage), not live quotes — and no token or airdrop is promised.</div>`;
}

// ---------------------------------------------------------------- boot

function applyQuery() {
  const params = new URLSearchParams(location.search);
  if (params.get('cat')) $('f-category').value = params.get('cat');
  if (params.get('watch')) $('f-watch').checked = true;
  if (params.get('detail')) selectedSlug = params.get('detail');
}

renderKpis();
renderModelStrip();
fillFilterOptions();
applyQuery();
renderBoard();
select(selectedSlug ?? (rows[0] && rows[0].slug), false);
for (const id of ['q', 'f-category', 'f-chain', 'f-watch', 'f-cost', 'f-sort']) {
  $(id).addEventListener('input', renderBoard);
  $(id).addEventListener('change', renderBoard);
}
