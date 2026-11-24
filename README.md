# token-launch-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/yono123/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/yono123/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Launch Radar ranks pre-token protocols by implied launch value. The model is fitted on the snapshot's own live protocols — log market cap on log TVL, seven-day growth and tokenless age, with per-category intercepts shrunk toward the global line — then applied to every protocol that records no token, watchlist first and early protocols below the $50M floor after it. Validation is reported, not hidden: a stratified holdout and two walk-forward cuts over listing time, with the holdout's middle half shown as each row's value range. Every board row carries a farm plan whose cost is computed from stated parameters (gas per action by chain, actions per week, programme length, bridge and slippage allowances). The dashboard is a static offline page: sortable, filterable, with a detail view per protocol.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Node 22.18 or later, standard library only. The run writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` into the output directory, deterministically.

---

<sub>Entered on [make.fun](https://make.fun/?ref=wcmp8016&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
