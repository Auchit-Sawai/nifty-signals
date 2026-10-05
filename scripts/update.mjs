// Daily data refresh: downloads Nifty 50 price history, applies the
// 5/13 EMA + 10-SMA + volume rules, runs a backtest, and writes JSON
// for the dashboard in docs/data/.
import { mkdir, writeFile } from 'node:fs/promises';

const TICKERS = [
  'ADANIENT', 'ADANIPORTS', 'APOLLOHOSP', 'ASIANPAINT', 'AXISBANK', 'BAJAJ-AUTO', 'BAJAJFINSV',
  'BAJFINANCE', 'BEL', 'BHARTIARTL', 'BPCL', 'BRITANNIA', 'CIPLA', 'COALINDIA', 'DRREDDY',
  'EICHERMOT', 'GRASIM', 'HCLTECH', 'HDFCBANK', 'HDFCLIFE', 'HEROMOTOCO', 'HINDALCO',
  'HINDUNILVR', 'ICICIBANK', 'INDUSINDBK', 'INFY', 'ITC', 'JSWSTEEL', 'KOTAKBANK', 'LT', 'LTM',
  'M&M', 'MARUTI', 'NESTLEIND', 'NTPC', 'ONGC', 'POWERGRID', 'RELIANCE', 'SBILIFE', 'SBIN',
  'SHRIRAMFIN', 'SUNPHARMA', 'TATACONSUM', 'TMCV', 'TATASTEEL', 'TCS', 'TECHM', 'TITAN', 'WIPRO',
  'ULTRACEMCO',
];
const STOP_LOSS = 0.03;      // 3% stop, same as the sheet's M4
const CHART_BARS = 750;      // ~3 years of daily bars per stock page
const OUT = new URL('../docs/data/', import.meta.url);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const round = (x, d = 2) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const day = ts => new Date(ts * 1000 + 5.5 * 3600e3).toISOString().slice(0, 10); // IST date

async function fetchHistory(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker + '.NS')}?period1=0&period2=${Math.floor(Date.now() / 1000)}&interval=1d&events=split`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = (await res.json()).chart.result[0];
      const q = r.indicators.quote[0];
      const bars = [];
      r.timestamp.forEach((ts, i) => {
        if (q.close[i] == null || q.open[i] == null) return;
        bars.push({ d: day(ts), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] ?? 0 });
      });
      return { name: r.meta.longName || r.meta.shortName || ticker, bars };
    } catch (e) {
      if (attempt === 4) throw new Error(`${ticker}: ${e.message}`);
      await sleep(1500 * attempt);
    }
  }
}

// Same columns as each stock tab in the sheet: G=10 SMA, H=5 EMA, I=13 EMA,
// J=5-day volume SMA, K=BUY, L=SHORT. EMAs are seeded with the first close
// (the sheet seeds from 0, which distorts the first few weeks).
function addSignals(bars) {
  const k5 = 2 / 6, k13 = 2 / 14;
  let sumC = 0, sumV = 0;
  bars.forEach((b, i) => {
    sumC += b.c; sumV += b.v;
    if (i >= 10) sumC -= bars[i - 10].c;
    if (i >= 5) sumV -= bars[i - 5].v;
    b.sma10 = i >= 9 ? sumC / 10 : null;
    b.vol5 = i >= 4 ? sumV / 5 : null;
    b.ema5 = i ? b.c * k5 + bars[i - 1].ema5 * (1 - k5) : b.c;
    b.ema13 = i ? b.c * k13 + bars[i - 1].ema13 * (1 - k13) : b.c;
    b.sig = '';
    if (i < 10) return;
    const p = bars[i - 1];
    if (b.c > b.sma10 && b.ema5 > b.ema13 && p.ema5 <= p.ema13 && b.v > b.vol5) b.sig = 'BUY';
    if (b.c < b.sma10 && b.ema5 < b.ema13 && p.ema5 >= p.ema13 && b.v > b.vol5) b.sig = 'SHORT';
  });
}

// One trade per signal: enter at the signal-day close, exit at the first
// close that breaches the 3% stop, or at the next opposite signal.
function backtest(bars) {
  const trades = [];
  bars.forEach((b, i) => {
    if (!b.sig) return;
    const long = b.sig === 'BUY';
    const stop = long ? b.c * (1 - STOP_LOSS) : b.c * (1 + STOP_LOSS);
    let exit = null, reason = 'open';
    for (let j = i + 1; j < bars.length; j++) {
      const x = bars[j];
      if (long ? x.c <= stop : x.c >= stop) { exit = j; reason = 'stop'; break; }
      if (x.sig === (long ? 'SHORT' : 'BUY')) { exit = j; reason = 'reverse'; break; }
    }
    const end = exit ?? bars.length - 1;
    const ret = long ? bars[end].c / b.c - 1 : 1 - bars[end].c / b.c;
    trades.push({ side: b.sig, entryDate: b.d, entry: b.c, exitDate: bars[end].d, exit: bars[end].c, ret, days: end - i, reason });
  });
  return trades;
}

function stats(trades) {
  const closed = trades.filter(t => t.reason !== 'open');
  const wins = closed.filter(t => t.ret > 0);
  const gain = wins.reduce((s, t) => s + t.ret, 0);
  const loss = -closed.filter(t => t.ret <= 0).reduce((s, t) => s + t.ret, 0);
  const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  return {
    trades: closed.length,
    winRate: closed.length ? wins.length / closed.length : null,
    avgReturn: avg(closed.map(t => t.ret)),
    avgWin: avg(wins.map(t => t.ret)),
    avgLoss: avg(closed.filter(t => t.ret <= 0).map(t => t.ret)),
    profitFactor: loss ? gain / loss : null,
    avgDays: avg(closed.map(t => t.days)),
    stopRate: closed.length ? closed.filter(t => t.reason === 'stop').length / closed.length : null,
  };
}

// Latest signal of a side, and what has happened to it since (mirrors the
// sheet's Buy Dates / Short Sell Dates dashboards plus the stop-loss column).
function latestState(bars, side, trades) {
  const t = trades.filter(x => x.side === side).at(-1);
  if (!t) return null;
  const last = bars.at(-1);
  const status = t.entryDate === last.d ? 'ACTIVE TODAY' : t.reason === 'open' ? 'OPEN' : t.reason === 'stop' ? 'STOPPED OUT' : 'REVERSED';
  const move = side === 'BUY' ? last.c / t.entry - 1 : 1 - last.c / t.entry;
  return {
    date: t.entryDate, price: round(t.entry), status, movePct: round(move * 100),
    exitDate: t.reason === 'open' ? null : t.exitDate, exitPrice: t.reason === 'open' ? null : round(t.exit),
    tradePct: round(t.ret * 100),
  };
}

const pct = x => round(x == null ? null : x * 100);
const fmtStats = s => ({ ...s, winRate: pct(s.winRate), avgReturn: pct(s.avgReturn), avgWin: pct(s.avgWin), avgLoss: pct(s.avgLoss), profitFactor: round(s.profitFactor), avgDays: round(s.avgDays, 1), stopRate: pct(s.stopRate) });

await mkdir(new URL('stocks/', OUT), { recursive: true });
const stocks = [], allTrades = [], failed = [];
let totalRows = 0;

for (const ticker of TICKERS) {
  let h;
  try { h = await fetchHistory(ticker); } catch (e) { console.error(e.message); failed.push(ticker); continue; }
  const { bars } = h;
  addSignals(bars);
  const trades = backtest(bars);
  allTrades.push(...trades.map(t => ({ ticker, ...t })));
  totalRows += bars.length;
  const last = bars.at(-1), prev = bars.at(-2);
  stocks.push({
    ticker, name: h.name, from: bars[0].d, rows: bars.length, date: last.d,
    price: round(last.c), dayPct: round((last.c / prev.c - 1) * 100),
    trend: last.ema5 > last.ema13 ? 'UP' : 'DOWN',
    buy: latestState(bars, 'BUY', trades), short: latestState(bars, 'SHORT', trades),
    stopLossPct: STOP_LOSS * 100,
    stats: fmtStats(stats(trades)),
  });
  const slim = bars.slice(-CHART_BARS).map(b => [b.d, round(b.o), round(b.h), round(b.l), round(b.c), b.v, round(b.ema5), round(b.ema13), round(b.sma10), b.sig]);
  await writeFile(new URL(`stocks/${encodeURIComponent(ticker)}.json`, OUT),
    JSON.stringify({ ticker, name: h.name, cols: ['d', 'o', 'h', 'l', 'c', 'v', 'ema5', 'ema13', 'sma10', 'sig'], bars: slim,
      trades: trades.slice(-40).map(t => ({ ...t, entry: round(t.entry), exit: round(t.exit), ret: pct(t.ret) })) }));
  console.log(`${ticker.padEnd(11)} ${bars.length} bars from ${bars[0].d}, ${trades.length} signals`);
  await sleep(400);
}

if (stocks.length < TICKERS.length * 0.8) throw new Error(`Only ${stocks.length} stocks fetched — not publishing`);

// Yearly hit rate across all closed trades, for the backtest chart.
const byYear = {};
for (const t of allTrades.filter(t => t.reason !== 'open')) {
  const y = t.entryDate.slice(0, 4);
  (byYear[y] ??= []).push(t);
}

const summary = {
  updated: new Date().toISOString(),
  asOf: stocks.map(s => s.date).sort().at(-1),
  rules: { ema: [5, 13], sma: 10, volSma: 5, stopLossPct: STOP_LOSS * 100 },
  universe: { stocks: stocks.length, rows: totalRows, failed },
  overall: { all: fmtStats(stats(allTrades)), buy: fmtStats(stats(allTrades.filter(t => t.side === 'BUY'))), short: fmtStats(stats(allTrades.filter(t => t.side === 'SHORT'))) },
  recent: fmtStats(stats(allTrades.filter(t => t.entryDate >= `${new Date().getFullYear() - 5}`))),
  years: Object.keys(byYear).sort().map(y => ({ year: y, ...fmtStats(stats(byYear[y])) })),
  stocks,
};
await writeFile(new URL('summary.json', OUT), JSON.stringify(summary));
console.log(`\nDone: ${stocks.length} stocks, ${totalRows} rows, ${allTrades.length} signals. Failed: ${failed.join(', ') || 'none'}`);
