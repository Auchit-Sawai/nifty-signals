# Nifty 50 Signals

Live dashboard: **https://auchit-sawai.github.io/nifty-signals/**

Daily 5/13 EMA crossover signals for every Nifty 50 stock, with a 30-year backtest. It started as a Google Sheet with one tab per stock (GOOGLEFINANCE + formulas), which took 5–10 minutes to recalculate every day. The same rules now run as a script on GitHub Actions, and the page loads in about a second.

## Rules

- **Buy:** close > 10-day SMA, 5 EMA crosses above 13 EMA, volume > 5-day average volume
- **Short:** the mirror image
- **Stop-loss:** 3% from the signal price; otherwise the trade ends at the next opposite signal

## How it works

| Piece | What it does |
| --- | --- |
| `scripts/update.mjs` | Downloads daily OHLCV, computes indicators, signals and the backtest, writes JSON to `docs/data/` |
| `.github/workflows/update.yml` | Runs the script every weekday at 16:47 IST and commits the new data |
| `docs/index.html` | Static dashboard (signals, backtest, per-stock charts) served by GitHub Pages |

Run locally: `node scripts/update.mjs`, then open `docs/index.html` through any static server.

Educational project, not investment advice.
