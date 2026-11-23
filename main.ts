// Token launch radar — entrypoint for token-radar-01 (Node 22, stdlib only).
//
// Reads the sealed DefiLlama snapshot, fits the value model in lib/model.ts on
// the protocols that already record a token, ranks the pre-token protocols by
// implied value, and writes the four things the gate and the judge consume:
// board.json (the ranked board), data.js (the same board for the page),
// dashboard/ and screenshots/ (copied from this repository), and dossier.json
// (built with the vendored make.fun library, byte for byte as the scorer
// rebuilds it). No network, no clock, no randomness: two runs write the
// same bytes.
//
// Local run:  mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoDir = fileURLToPath(new URL('.', import.meta.url));

/** Read `--name value` or `--name=value` from argv, else the fallback. */
function readArg(name: string, fallback: string): string {
  const flag = `--${name}`;
  const at = process.argv.indexOf(flag);
  if (at >= 0 && process.argv[at + 1] !== undefined) return process.argv[at + 1]!;
  const joined = process.argv.find((a) => a.startsWith(`${flag}=`));
  return joined === undefined ? fallback : joined.slice(flag.length + 1);
}

function fail(message: string, code: number): never {
  process.stderr.write(`launch-radar: ${message}\n`);
  process.exit(code);
}

const inputArg = readArg('input', '/input');
const snapshotPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  fail(`no snapshot at ${snapshotPath} — pass --input <snapshot.json|dir> or mount the sealed /input`, 2);
}
const outputDir = readArg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) fail(`the model produced a board the gate refuses: ${issue}`, 1);

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outputDir, 'data.js'), dataScript(radar));

/** Copy a directory tree of regular files, skipping dot-names at every level. */
function copyTree(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) copied.push(...copyTree(src, dst));
    else if (entry.isFile() && statSync(src).isFile()) {
      copyFileSync(src, dst);
      copied.push(entry.name);
    }
  }
  return copied;
}

const dashboardFiles = copyTree(join(repoDir, 'dashboard'), join(outputDir, 'dashboard'));
const shotFiles = copyTree(join(repoDir, 'screenshots'), join(outputDir, 'screenshots'));
if (dashboardFiles.length < 3) fail(`dashboard/ copied ${dashboardFiles.length} files — the page needs index.html, a stylesheet and a script`, 1);
if (shotFiles.length < 3) fail(`screenshots/ holds ${shotFiles.length} images — hand in 3: the board, a detail view and a filtered view`, 1);
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
for (const name of shotFiles) {
  if (!IMAGE_NAME.test(name)) fail(`screenshots/${name}: names are letters, digits and . _ -, 1 to 128 characters`, 1);
}

// The dossier goes last: it is built from the dashboard and screenshots now
// sitting in the output directory, exactly as the scorer rebuilds it.
const dossier = buildDossier(outputDir, {
  text_max_bytes: 65_536,
  screenshots: { max: 4, max_bytes: 524_288 },
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
});
writeFileSync(join(outputDir, 'dossier.json'), dossier);

process.stdout.write(
  `launch-radar: ${snapshot.protocols.length} protocols read, ${radar.live_count} live fitted, ${board.length} rows ranked (${radar.early_size} early, ${snapshot.watchlist.length} watchlist)\n` +
    `launch-radar: holdout median ratio ${radar.model.holdout.medianRatio.toFixed(3)} on ${radar.model.holdout.n} held-out protocols\n` +
    `launch-radar: wrote board.json, data.js, dashboard/ (${dashboardFiles.length} files), screenshots/ (${shotFiles.length} images), dossier.json (${dossier.length} bytes)\n`,
);
