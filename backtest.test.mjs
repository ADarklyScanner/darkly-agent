/**
 * Tests for backtest.js — run with: node backtest.test.mjs
 *
 * The failure mode this file exists to catch is not "the backtest looks
 * pessimistic" or "the backtest looks optimistic" — it's a backtest that
 * quietly cheats. Three cheats specifically:
 *   - filling a decision at a price that was only known after the decision
 *     was made (lookahead)
 *   - misaligning two symbols' calendars so day i means different dates
 *   - inventing an exit for a position that never actually closed
 * Each has a direct test below rather than being inferred from a P&L number
 * looking reasonable.
 */

import { alignByDate, filterDateRange, simulate, backtest, runWindows, sharpeRatio, BACKTEST_DEFAULTS } from "./backtest.js";

let pass = 0;
let fail = 0;

function check(label, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label} ${detail}`);
  }
}

/* ------------------------------------------------------------------ *
 * Synthetic data generation
 *
 * A tiny deterministic PRNG so failures are reproducible, and an OHLC
 * generator where open and close are deliberately different values (a
 * fixed overnight gap on top of the day's own drift) — real bars behave
 * that way, and a generator that set open === close would hide any bug
 * where the simulator fills a trade at the wrong one of the two.
 * ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dayIso(offset) {
  const d = new Date(Date.UTC(2020, 0, 1));
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString();
}

/**
 * bars(n, { start, drift, noise, gap, volume, seed })
 *   drift: fractional close-over-previous-close drift per day (e.g. 0.01 = +1%/day)
 *   noise: random +/- fractional wobble added to drift each day
 *   gap:   fixed fractional overnight gap applied to the open, distinct from drift,
 *          so open != close and a test can tell which one a fill used.
 */
function bars(n, options = {}) {
  const { start = 100, drift = 0, noise = 0, gap = 0.002, volume = 2_000_000, seed = 1 } = options;
  const rand = mulberry32(seed);
  const out = [];
  let prevClose = start;

  for (let i = 0; i < n; i++) {
    const wobble = noise ? (rand() - 0.5) * 2 * noise : 0;
    const open = prevClose * (1 + gap);
    const close = open * (1 + drift + wobble);
    const high = Math.max(open, close) * 1.003;
    const low = Math.min(open, close) * 0.997;
    out.push({ t: dayIso(i), o: round4(open), h: round4(high), l: round4(low), c: round4(close), v: volume });
    prevClose = close;
  }
  return out;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function flatUniverse(n, symbols, benchmarkSymbol, opts = {}) {
  const out = {};
  symbols.forEach((s, idx) => {
    out[s] = bars(n, { seed: 10 + idx, ...opts });
  });
  out[benchmarkSymbol] = bars(n, { seed: 999, ...opts });
  return out;
}

const WARMUP = BACKTEST_DEFAULTS.warmupBars;

/* ==================================================================== *
 * alignByDate
 * ==================================================================== */

console.log("\nalignByDate");

{
  const a = bars(10, { seed: 1 });
  const b = bars(10, { seed: 2 }).filter((_, i) => i !== 4); // drop day index 4
  const { dates, bars: aligned } = alignByDate({ A: a, B: b });

  check("drops a date missing from any symbol", dates.length === 9, `got ${dates.length}`);
  check("every symbol comes back the same length", aligned.A.length === aligned.B.length);
  check("remaining bars are still date-matched",
    aligned.A.every((bar, i) => bar.t.slice(0, 10) === aligned.B[i].t.slice(0, 10)));
  check("the dropped day is genuinely gone from both",
    !dates.includes(a[4].t.slice(0, 10)));
}

{
  const { dates, bars: aligned } = alignByDate({ SOLO: bars(5, { seed: 3 }) });
  check("a single symbol aligns against itself with no loss", dates.length === 5 && aligned.SOLO.length === 5);
}

{
  const { dates } = alignByDate({});
  check("no symbols produces no dates", dates.length === 0);
}

/* ==================================================================== *
 * filterDateRange
 * ==================================================================== */

console.log("\nfilterDateRange");

{
  const b = bars(20, { seed: 4 });
  const start = b[5].t.slice(0, 10);
  const end = b[10].t.slice(0, 10);
  const sliced = filterDateRange(b, { start, end });

  check("range is inclusive of both ends", sliced.length === 6, `got ${sliced.length}`);
  check("first kept bar matches start", sliced[0].t.slice(0, 10) === start);
  check("last kept bar matches end", sliced[sliced.length - 1].t.slice(0, 10) === end);
  check("no bound returns everything", filterDateRange(b, {}).length === b.length);
  check("non-array input returns empty rather than throwing", filterDateRange(null, {}).length === 0);
}

/* ==================================================================== *
 * simulate() — guards
 * ==================================================================== */

console.log("\nsimulate() guards");

{
  const data = flatUniverse(WARMUP + 5, ["AAA"], "SPY");
  const missing = simulate(data, { universe: ["AAA", "ZZZ"] });
  check("refuses when a universe symbol has no bars", missing.ok === false);
  check("the refusal names the missing symbol", /ZZZ/.test(missing.error), missing.error);
}

{
  const data = flatUniverse(WARMUP - 10, ["AAA"], "SPY");
  const short = simulate(data, { universe: ["AAA"] });
  check("refuses when there is less history than the warmup requires", short.ok === false);
  check("the refusal explains the warmup requirement", /warmup/i.test(short.error), short.error);
}

/* ==================================================================== *
 * simulate() — a flat, signal-free market trades nothing
 * ==================================================================== */

console.log("\nsimulate() on a flat market");

{
  // Zero drift, zero noise: every indicator that depends on change is
  // neutral, so nothing should ever look like a buy or a sell.
  const data = flatUniverse(WARMUP + 40, ["FLAT"], "SPY", { drift: 0, noise: 0, gap: 0 });
  const sim = simulate(data, { universe: ["FLAT"], startingEquity: 50000 });

  check("flat data still produces a valid run", sim.ok === true, sim.error);
  if (sim.ok) {
    check("no trades on a perfectly flat tape", sim.closedTrades.length === 0);
    check("nothing left open either", sim.openAtEnd.length === 0);
    check("equity is unchanged with nothing traded", sim.finalEquity === sim.startingEquity,
      `${sim.finalEquity} vs ${sim.startingEquity}`);
    check("an equity point exists for every trading day considered",
      sim.equitySeries.length === sim.period.tradingDays);
  }
}

/* ==================================================================== *
 * simulate() — a sustained uptrend produces at least one entry, filled
 * at the NEXT day's open, never the decision day's close (no lookahead)
 * ==================================================================== */

console.log("\nsimulate() on a sustained uptrend (entries + no-lookahead)");

{
  const n = WARMUP + 120;
  const data = flatUniverse(n, ["UP"], "SPY", { drift: 0.012, noise: 0.001, gap: 0.001, volume: 5_000_000 });
  const sim = simulate(data, { universe: ["UP"], startingEquity: 100000 });

  check("a strong uptrend runs cleanly", sim.ok === true, sim.error);

  const trades = sim.ok ? [...sim.closedTrades, ...sim.openAtEnd.map((p) => ({ ...p, entryPriceRaw: p.entryPrice }))] : [];
  check("at least one position was taken over 120 trading days of a clean uptrend", trades.length > 0);

  if (sim.ok && sim.closedTrades.length + sim.openAtEnd.length > 0) {
    const aligned = alignByDate(data).bars.UP;
    const dateIndex = new Map(alignByDate(data).dates.map((d, i) => [d, i]));

    const checkFill = (entryAt, entryPrice, label) => {
      const idx = dateIndex.get(entryAt.slice(0, 10));
      const bar = aligned[idx];
      const prevBar = aligned[idx - 1];
      check(`${label}: entry price matches that day's OPEN, not close`,
        Math.abs(bar.o - entryPrice) < 1e-6, `bar.o=${bar.o} entryPrice=${entryPrice}`);
      check(`${label}: entry price is NOT the previous day's close (would mean same-day fill)`,
        Math.abs(prevBar.c - entryPrice) > 1e-9 || Math.abs(bar.o - prevBar.c) < 1e-9);
    };

    const first = sim.closedTrades[0] || sim.openAtEnd[0];
    if (first) checkFill(first.entryAt, first.entryPrice, "first position");
  }
}

/* ==================================================================== *
 * simulate() — stop-loss and take-profit actually fire
 * ==================================================================== */

console.log("\nsimulate() exits");

{
  // Rise long enough to get bought, then crater hard for a few days —
  // enough to blow through both the trailing stop and the fixed
  // stop-loss, whichever triggers first.
  const n = WARMUP + 60;
  const rise = bars(n - 10, { seed: 5, drift: 0.015, noise: 0.001, volume: 5_000_000 });
  const lastClose = rise[rise.length - 1].c;
  const crash = bars(10, { start: lastClose, drift: -0.12, noise: 0.001, volume: 5_000_000, seed: 6 });
  const sym = [...rise, ...crash.map((b, i) => ({ ...b, t: dayIso(n - 10 + i) }))];

  const bench = bars(n, { seed: 999, drift: 0.0005, volume: 5_000_000 });
  const data = { CRASH: sym, SPY: bench };

  const sim = simulate(data, { universe: ["CRASH"], startingEquity: 100000 });
  check("crash scenario runs without error", sim.ok === true, sim.error);

  if (sim.ok) {
    check("the crash produced at least one closed trade", sim.closedTrades.length > 0);
    if (sim.closedTrades.length > 0) {
      const losers = sim.closedTrades.filter((t) => t.pnl < 0);
      check("at least one closed trade lost money", losers.length > 0);
      check("a losing exit cites a stop, not a signal reversal",
        losers.some((t) => /stop/i.test(t.exitRationale)),
        losers.map((t) => t.exitRationale).join(" | "));
    }
  }
}

/* ==================================================================== *
 * simulate() — unresolved positions and unfilled tail orders are
 * reported, never silently resolved
 * ==================================================================== */

console.log("\nsimulate() end-of-data honesty");

{
  // Exactly one decision day: the last bar in the dataset. Any order
  // decided there has no following day to fill on.
  const n = WARMUP + 1;
  const data = flatUniverse(n, ["TAIL"], "SPY", { drift: 0.02, noise: 0.001, gap: 0.001, volume: 5_000_000 });
  const sim = simulate(data, { universe: ["TAIL"], startingEquity: 100000 });

  check("single-decision-day run completes", sim.ok === true, sim.error);
  if (sim.ok) {
    check("nothing was opened (there was no next day to fill on)", sim.openAtEnd.length === 0 && sim.closedTrades.length === 0);
    check("an unfilled tail order is flagged in warnings",
      sim.warnings.some((w) => /never filled/i.test(w)), JSON.stringify(sim.warnings));
  }
}

{
  const n = WARMUP + 120;
  const data = flatUniverse(n, ["HOLD"], "SPY", { drift: 0.012, noise: 0.001, gap: 0.001, volume: 5_000_000 });
  const sim = simulate(data, { universe: ["HOLD"], startingEquity: 100000 });

  if (sim.ok && sim.openAtEnd.length > 0) {
    check("an open-at-end position is flagged in warnings, not silently dropped",
      sim.warnings.some((w) => /still open at the end/i.test(w)), JSON.stringify(sim.warnings));
    check("an open position carries a mark price and unrealized pnl",
      Number.isFinite(sim.openAtEnd[0].markPrice) && Number.isFinite(sim.openAtEnd[0].unrealizedPnl));
  } else {
    check("(skipped: this run happened to close everything before the data ended)", true);
  }
}

/* ==================================================================== *
 * backtest() — the scored report
 * ==================================================================== */

console.log("\nbacktest() report");

{
  const n = WARMUP + 150;
  const data = flatUniverse(n, ["UP2"], "SPY", { drift: 0.01, noise: 0.0015, gap: 0.001, volume: 5_000_000 });
  const report = backtest(data, { universe: ["UP2"], startingEquity: 100000 });

  check("report builds", report.ok === true, report.error);
  if (report.ok) {
    check("carries a performance summary from performance.js", typeof report.performance.sampleSize === "number");
    check("carries a drawdown", report.drawdown && "drawdownPercent" in report.drawdown);
    check("carries a benchmark comparison", report.benchmark && report.benchmark.symbol === "SPY");
    check("benchmark return is computed from the same period the strategy traded", report.benchmark.buyHoldReturnPercent !== null);
    check("beatBuyAndHold is a real boolean when both returns are known",
      report.beatBuyAndHold === true || report.beatBuyAndHold === false);
    check("honesty caveats are present and non-empty", Array.isArray(report.honesty) && report.honesty.length > 0);
    check("honesty explicitly says this is not a predictor of future results",
      report.honesty.some((h) => /not predict|predicts future/i.test(h)), report.honesty.join(" | "));

    const manualReturn = ((report.finalEquity - report.startingEquity) / report.startingEquity) * 100;
    check("strategyReturnPercent matches finalEquity/startingEquity arithmetic",
      Math.abs(manualReturn - report.strategyReturnPercent) < 0.01);
  }
}

{
  const n = WARMUP + 5;
  const data = flatUniverse(n, ["TOOSHORT"], "SPY");
  const report = backtest(data, { universe: ["TOOSHORT"], warmupBars: WARMUP + 100 });
  check("a backtest() on an impossible warmup still fails cleanly, not with an exception", report.ok === false);
}

/* ==================================================================== *
 * runWindows()
 * ==================================================================== */

console.log("\nrunWindows()");

{
  const n = WARMUP + 200;
  const data = flatUniverse(n, ["W"], "SPY", { drift: 0.008, noise: 0.002, gap: 0.001, volume: 5_000_000 });
  const { dates } = alignByDate(data);

  const mid = dates[Math.floor(dates.length / 2)];
  const windows = [
    { label: "first half", start: dates[0], end: mid },
    { label: "second half", start: mid, end: dates[dates.length - 1] }
  ];

  const result = runWindows(data, windows, { universe: ["W"] });

  check("runs one report per window", result.windows.length === 2);
  check("each window keeps its own label", result.windows[0].label === "first half" && result.windows[1].label === "second half");
  check("windowCount reflects the input", result.windowCount === 2);
  check("consistency narrative is produced", typeof result.consistency === "string" && result.consistency.length > 0);
  check("carries its own honesty note about what multi-window testing does and does not prove",
    typeof result.honesty === "string" && /out-of-sample/i.test(result.honesty));
}

{
  const result = runWindows({}, [], {});
  check("zero windows does not throw", result.windowCount === 0 && result.usableCount === 0);
}

/* ==================================================================== *
 * sharpeRatio — the pure function, on constructed equity series
 * ==================================================================== */

console.log("\nsharpeRatio — degenerate inputs");

{
  const r = sharpeRatio([]);
  check("empty series: sharpe is null, not 0 or NaN", r.sharpe === null);
  check("empty series: explains why in missing", r.missing.length > 0);
}

{
  const r = sharpeRatio([{ equity: 100000 }]);
  check("a single equity point: no return exists, sharpe stays null", r.sharpe === null);
}

{
  // Three points -> two returns, both exactly zero -> zero variance. (Two
  // points would give only one return, which hits the "not enough
  // returns" branch before variance is even computed — see the next
  // case, which pins that distinct branch.)
  const r = sharpeRatio([{ equity: 100000 }, { equity: 100000 }, { equity: 100000 }]);
  check("flat equity across 3+ points: sharpe is null (not Infinity/NaN)", r.sharpe === null);
  check("explains the zero-variance case rather than dividing by zero silently",
    /zero/i.test(r.caveat), r.caveat);
}

{
  const r = sharpeRatio([{ equity: 100000 }, { equity: 100000 }]);
  check("exactly one return: too few to estimate variance, sharpe stays null",
    r.sharpe === null && r.sampleSize === 1);
}

{
  const r = sharpeRatio([{ equity: 100000 }, { equity: 0 }, { equity: 50000 }]);
  check("a zero prior-equity day is excluded rather than producing Infinity/NaN",
    Number.isFinite(r.stdevDailyReturnPercent) || r.stdevDailyReturnPercent === null);
  check("the excluded day is named in missing", r.missing.some((m) => /zero/i.test(m)), JSON.stringify(r.missing));
}

console.log("\nsharpeRatio — a steady uptrend has a large positive Sharpe");

{
  // Perfectly steady 0.1%/day growth, no noise: the whole point of Sharpe
  // is return-per-unit-of-volatility, so a smooth uptrend should score far
  // higher than a noisy one with the same average return.
  const smooth = [];
  let eq = 100000;
  for (let i = 0; i < 120; i++) {
    smooth.push({ index: i, equity: eq });
    eq *= 1.001;
  }
  const r = sharpeRatio(smooth);
  check("a smooth uptrend has sharpe > 0", r.sharpe > 0, r.sharpe);
  check("sampleSize counts the returns, not the equity points (one fewer)", r.sampleSize === 119, r.sampleSize);
  check("meanDailyReturnPercent is close to the constructed 0.1%/day",
    Math.abs(r.meanDailyReturnPercent - 0.1) < 0.01, r.meanDailyReturnPercent);
  check("annualizedReturnPercent is roughly meanDaily * 252",
    Math.abs(r.annualizedReturnPercent - r.meanDailyReturnPercent * 252) < 0.01);
  check("120 trading days clears the reliability floor", r.reliable === true);
}

console.log("\nsharpeRatio — same average return, more noise -> lower Sharpe");

{
  const rand = mulberry32(42);
  function series(driftPct, noisePct, n) {
    const out = [];
    let eq = 100000;
    for (let i = 0; i < n; i++) {
      out.push({ index: i, equity: eq });
      const wobble = (rand() - 0.5) * 2 * noisePct;
      eq *= 1 + driftPct + wobble;
    }
    return out;
  }

  const calm = sharpeRatio(series(0.001, 0.0002, 150));
  const noisy = sharpeRatio(series(0.001, 0.01, 150));

  check("both have a defined sharpe", Number.isFinite(calm.sharpe) && Number.isFinite(noisy.sharpe));
  check("the calmer series (same avg return, less noise) scores a higher Sharpe",
    calm.sharpe > noisy.sharpe, `calm=${calm.sharpe} noisy=${noisy.sharpe}`);
}

console.log("\nsharpeRatio — reliability floor and options");

{
  const short = [];
  let eq = 100000;
  for (let i = 0; i < 10; i++) {
    short.push({ index: i, equity: eq });
    eq *= 1.002;
  }
  const r = sharpeRatio(short);
  check("fewer than MIN_RELIABLE_SHARPE_DAYS usable returns is flagged unreliable", r.reliable === false);
  check("the caveat says the sample is short, not that the number is wrong",
    /short|noise/i.test(r.caveat), r.caveat);
}

{
  const smooth = [];
  let eq = 100000;
  for (let i = 0; i < 120; i++) {
    smooth.push({ index: i, equity: eq });
    eq *= 1.001;
  }
  const annualDefault = sharpeRatio(smooth);
  const withRiskFree = sharpeRatio(smooth, { riskFreeAnnualPercent: 50 });
  check("a nonzero risk-free rate lowers the Sharpe of the same series",
    withRiskFree.sharpe < annualDefault.sharpe, `${withRiskFree.sharpe} vs ${annualDefault.sharpe}`);

  // periodsPerYear scales annualized volatility by sqrt(periodsPerYear), so
  // this needs an actually-noisy series — a perfectly smooth one has
  // ~zero daily variance and both annualizations round to ~0 either way.
  const rand = mulberry32(7);
  const noisy = [];
  let eq2 = 100000;
  for (let i = 0; i < 120; i++) {
    noisy.push({ index: i, equity: eq2 });
    eq2 *= 1 + 0.001 + (rand() - 0.5) * 2 * 0.01;
  }
  const daily = sharpeRatio(noisy);
  const weekly = sharpeRatio(noisy, { periodsPerYear: 52 });
  check("a custom periodsPerYear is honored in the annualization",
    weekly.periodsPerYear === 52 && weekly.annualizedVolatilityPercent !== daily.annualizedVolatilityPercent,
    `weekly=${weekly.annualizedVolatilityPercent} daily=${daily.annualizedVolatilityPercent}`);
}

{
  // Accepts either the full equityCurve/equitySeries point shape or a
  // plain array of numbers, same convention as performance.js's
  // maxDrawdown, so callers don't have to reshape data just for this.
  const points = [{ equity: 100000 }, { equity: 100500 }, { equity: 101200 }];
  const numbers = [100000, 100500, 101200];
  check("plain numeric array and {equity} objects give the same result",
    sharpeRatio(points).sharpe === sharpeRatio(numbers).sharpe);
}

/* ==================================================================== *
 * sharpeRatio wired into backtest()'s report
 * ==================================================================== */

console.log("\nbacktest() report includes sharpe, built from its own equitySeries");

{
  const n = WARMUP + 200;
  const data = flatUniverse(n, ["S"], "SPY", { drift: 0.006, noise: 0.004, gap: 0.001, volume: 5_000_000 });
  const report = backtest(data, { universe: ["S"] });

  check("backtest() report carries a sharpe field", report.sharpe !== undefined);
  check("it matches calling sharpeRatio on the report's own equitySeries directly",
    report.sharpe.sharpe === sharpeRatio(report.equitySeries).sharpe);
  check("sample size in sharpe is one less than the equity series length (returns, not points)",
    report.sharpe.sampleSize === report.equitySeries.length - 1);
}

{
  // A universe with no bars at all still produces a (single-point)
  // equitySeries from simulate()'s starting balance — sharpe must stay
  // null/well-formed rather than throwing when there's nothing to score.
  const report = backtest({}, { universe: [] });
  check("an empty universe does not crash sharpe", report.ok === false || report.sharpe !== undefined);
}

/* ------------------------------------------------------------------ */

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
