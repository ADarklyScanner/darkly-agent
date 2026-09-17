/**
 * backtest.js — replay the strategy against historical bars.
 *
 * READ THIS BEFORE READING ANY NUMBER THIS MODULE PRODUCES. The same rule
 * that governs performance.js governs this file even harder: a backtest is
 * not evidence of a future edge, it is a description of what a fixed set of
 * rules would have done on one historical sample. A strategy can look great
 * on a backtest and lose money live for reasons a backtest structurally
 * cannot see (real slippage, real fills, a market regime that never
 * recurs). This module exists to catch strategies that are BROKEN — that
 * lose money even with the benefit of hindsight-free historical replay —
 * not to certify strategies that are GOOD.
 *
 * Three design choices exist specifically to keep this honest:
 *
 *   1. NO LOOKAHEAD. A decision made from a day's closing bar is never
 *      filled at that same day's price. It is queued and filled at the
 *      NEXT day's open — the earliest a real system could have acted on
 *      information it only had after the close. Stop/target exits are the
 *      one exception: the stop level was fixed at the close of a PRIOR day,
 *      so checking it against the current day's intraday range does not
 *      use information from the future.
 *
 *   2. THE SAME RULES AS PRODUCTION. Entry filtering (liquidity ->
 *      correlation -> stop -> sizing -> portfolio heat) and exit precedence
 *      (trailing stop -> fixed stop-loss -> take-profit -> sell signal)
 *      mirror autotrader.js's runOnce() exactly, on purpose. A backtest of
 *      a DIFFERENT set of rules than the one actually trading answers a
 *      different question than the one being asked.
 *
 *   3. NOTHING IS FIT TO THIS DATA. Every threshold used here (ADX bands,
 *      aggressiveness cutoffs, risk-per-trade, correlation ceiling, ATR
 *      multiples) is a fixed constant carried in from strategy.js/risk.js,
 *      not something this module searches over. Running a backtest and then
 *      hand-tuning those constants until this backtest looks good is
 *      exactly the in-sample mistake this file is meant to help avoid — see
 *      runWindows() below, which exists so a strategy can be checked on more
 *      than one period before anyone gets attached to a single number.
 *
 * Pure functions only: no network, no state file, no clock. All bars are
 * supplied by the caller (typically a getBars() call made once, up front).
 */

import { scoreSymbol } from "./strategy.js";
import {
  positionSize,
  atrStop,
  chandelierStop,
  portfolioHeat,
  correlationCheck,
  liquidityCheck,
  marketFilter,
  RISK_DEFAULTS
} from "./risk.js";
import { summarize, maxDrawdown, MIN_RELIABLE_SAMPLE } from "./performance.js";

/* ------------------------------------------------------------------ *
 * Defaults — mirrors autotrader.js's CONFIG, kept independent so this
 * module never has to import autotrader.js (which reaches for env vars,
 * the state file and the broker). A backtest should be runnable with
 * nothing but bars in memory.
 * ------------------------------------------------------------------ */

export const BACKTEST_DEFAULTS = {
  aggressiveness: "moderate",
  startingEquity: 100000,
  positionUsd: Number(process.env.AUTO_TRADE_POSITION_USD || 500),
  maxPositionUsd: Number(process.env.MAX_POSITION_USD || 1000),
  maxPositions: Number(process.env.AUTO_TRADE_MAX_POSITIONS || 5),
  stopLossPercent: Number(process.env.AUTO_TRADE_STOP_LOSS_PERCENT || 8),
  takeProfitPercent: Number(process.env.AUTO_TRADE_TAKE_PROFIT_PERCENT || 15),
  benchmarkSymbol: RISK_DEFAULTS.benchmarkSymbol,
  warmupBars: Math.max(60, RISK_DEFAULTS.benchmarkMaPeriod + 10)
};

/* ------------------------------------------------------------------ *
 * Date helpers
 * ------------------------------------------------------------------ */

function dateKey(t) {
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Filter one symbol's bars to a date range. Both ends inclusive; either may
 * be omitted. Used to carve out held-out windows before alignment, so a
 * "2023 only" backtest never sees a single bar from outside 2023.
 */
export function filterDateRange(bars, range = {}) {
  if (!Array.isArray(bars)) return [];
  const start = range.start ? new Date(range.start).getTime() : -Infinity;
  const end = range.end ? new Date(range.end).getTime() : Infinity;
  return bars.filter((b) => {
    const t = new Date(b.t).getTime();
    return Number.isFinite(t) && t >= start && t <= end;
  });
}

/**
 * Align every symbol's bars onto the same trading-day calendar.
 *
 * A backtest that steps through symbols at "the same index" is only valid
 * if index i really is the same calendar day for every symbol. Different
 * IPO dates, halts and data gaps make that false in general, so this
 * intersects the dates present in EVERY supplied symbol (including the
 * benchmark) and returns each symbol's bars reindexed onto exactly that
 * date list. A symbol with a gap loses that day for every OTHER symbol too
 * — a conservative choice, since the alternative (interpolating or holding
 * a stale bar) would quietly fabricate price data.
 */
export function alignByDate(barsBySymbol) {
  const symbols = Object.keys(barsBySymbol || {});
  const maps = {};

  for (const s of symbols) {
    const m = new Map();
    for (const b of barsBySymbol[s] || []) {
      const k = dateKey(b.t);
      if (k) m.set(k, b);
    }
    maps[s] = m;
  }

  let dateSet = null;
  for (const s of symbols) {
    const keys = new Set(maps[s].keys());
    dateSet = dateSet === null ? keys : new Set([...dateSet].filter((d) => keys.has(d)));
  }

  const dates = Array.from(dateSet || []).sort();
  const bars = {};
  for (const s of symbols) bars[s] = dates.map((d) => maps[s].get(d));

  return { dates, bars, symbolCount: symbols.length };
}

function round(n, dp = 6) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/* ------------------------------------------------------------------ *
 * The simulator
 * ------------------------------------------------------------------ */

/**
 * Walk the aligned calendar forward one trading day at a time, applying
 * the same decision rules autotrader.js uses live, and return the raw
 * simulation output. backtest() below turns this into a scored report;
 * this function is exported separately so the mechanics (fills, no
 * lookahead, ordering) can be tested on their own.
 */
export function simulate(barsBySymbol, options = {}) {
  const cfg = { ...BACKTEST_DEFAULTS, ...options };
  const benchmarkSymbol = cfg.benchmarkSymbol;
  const universe = Array.isArray(cfg.universe)
    ? cfg.universe.map((s) => String(s).toUpperCase())
    : Object.keys(barsBySymbol || {}).filter((s) => s !== benchmarkSymbol);

  const warnings = [];

  const rangeFiltered = {};
  for (const [symbol, bars] of Object.entries(barsBySymbol || {})) {
    rangeFiltered[symbol] = cfg.dateRange ? filterDateRange(bars, cfg.dateRange) : bars;
  }

  const needed = [...universe, benchmarkSymbol];
  const missing = needed.filter((s) => !rangeFiltered[s] || rangeFiltered[s].length === 0);
  if (missing.length > 0) {
    return {
      ok: false,
      error: `No bars for: ${missing.join(", ")}. Every universe symbol and the benchmark (${benchmarkSymbol}) must be supplied.`
    };
  }

  const { dates, bars } = alignByDate(
    Object.fromEntries(needed.map((s) => [s, rangeFiltered[s]]))
  );

  const n = dates.length;
  const warmup = cfg.warmupBars;

  if (n <= warmup) {
    return {
      ok: false,
      error: `Only ${n} aligned trading day(s) across all symbols after intersecting dates, but ${warmup} are needed as a warmup before the first decision. Widen the date range, shorten warmupBars, or check that the symbols actually overlap in time.`
    };
  }

  // --- Portfolio state -------------------------------------------------
  let cash = cfg.startingEquity;
  const positions = new Map(); // symbol -> { qty, entryPrice, entryAt, entryStop, entryRationale }
  const stops = new Map(); // symbol -> current trailing stop price
  let pending = []; // orders decided at close of day i-1, filled at open of day i

  const closedTrades = [];
  const equitySeries = [];
  const rejectedSample = [];
  let daysConsidered = 0;

  const priceOf = (symbol, i) => {
    const b = bars[symbol][i];
    return b ? Number(b.c) : null;
  };

  const markToMarket = (i) => {
    let equity = cash;
    for (const [symbol, pos] of positions) {
      const b = bars[symbol][i];
      const price = b ? Number(b.c) : pos.entryPrice;
      equity += pos.qty * price;
    }
    return equity;
  };

  for (let i = warmup; i < n; i++) {
    // --- 1. Fill anything decided at yesterday's close, at today's open ---
    const stillPending = [];
    for (const order of pending) {
      const b = bars[order.symbol][i];
      if (!b) {
        stillPending.push(order); // symbol had no bar today; try again next day
        continue;
      }
      const openPrice = Number(b.o);

      if (order.type === "sell") {
        const pos = positions.get(order.symbol);
        if (pos) {
          const exitPrice = openPrice;
          closedTrades.push(buildClosedTrade(order.symbol, pos, exitPrice, dates[i], order.reason));
          positions.delete(order.symbol);
          stops.delete(order.symbol);
        }
      } else if (order.type === "buy") {
        if (positions.has(order.symbol)) continue; // already holding; decision is stale
        const qty = order.notionalTarget / openPrice;
        if (!Number.isFinite(qty) || qty <= 0) continue;
        cash -= order.notionalTarget;
        positions.set(order.symbol, {
          qty,
          entryPrice: openPrice,
          entryAt: dates[i],
          entryStop: order.stopPriceAtDecision,
          entryRationale: order.reason
        });
        stops.set(order.symbol, order.stopPriceAtDecision);
      }
    }
    pending = stillPending;

    // --- 2. Intraday stop / target checks, using levels fixed BEFORE today ---
    for (const [symbol, pos] of Array.from(positions.entries())) {
      const b = bars[symbol][i];
      if (!b) continue;
      const low = Number(b.l);
      const high = Number(b.h);
      const open = Number(b.o);
      const trailing = stops.get(symbol) ?? null;

      let exitPrice = null;
      let reason = null;

      if (trailing !== null && low <= trailing) {
        // A stop order fills at the stop price, or worse on a gap down.
        exitPrice = open < trailing ? open : trailing;
        reason = `Trailing stop hit intraday at ${trailing}.`;
      } else {
        const stopLossPrice = pos.entryPrice * (1 - cfg.stopLossPercent / 100);
        const takeProfitPrice = pos.entryPrice * (1 + cfg.takeProfitPercent / 100);
        if (low <= stopLossPrice) {
          exitPrice = open < stopLossPrice ? open : stopLossPrice;
          reason = `Fixed stop-loss hit: -${cfg.stopLossPercent}% from entry (${pos.entryPrice}).`;
        } else if (high >= takeProfitPrice) {
          exitPrice = open > takeProfitPrice ? open : takeProfitPrice;
          reason = `Take-profit hit: +${cfg.takeProfitPercent}% from entry (${pos.entryPrice}).`;
        }
      }

      if (exitPrice !== null) {
        cash += pos.qty * exitPrice;
        closedTrades.push(buildClosedTrade(symbol, pos, exitPrice, dates[i], reason));
        positions.delete(symbol);
        stops.delete(symbol);
      }
    }

    // --- 3. Mark to market at today's close ---
    equitySeries.push({ index: i, at: dates[i], equity: round(markToMarket(i), 6) });
    daysConsidered++;

    // --- 4. Decide, using bars through today's close; execute tomorrow ---
    const barsSoFar = {};
    for (const s of [...universe, benchmarkSymbol]) barsSoFar[s] = bars[s].slice(0, i + 1).filter(Boolean);

    const market = marketFilter(barsSoFar[benchmarkSymbol], {});

    const signals = new Map();
    for (const symbol of universe) {
      const sBars = barsSoFar[symbol];
      if (!sBars || sBars.length < 30) continue;
      signals.set(symbol, scoreSymbol(symbol, sBars, { aggressiveness: cfg.aggressiveness }));
    }

    // Update trailing stops for positions surviving into tomorrow.
    for (const [symbol, pos] of positions) {
      const sBars = barsSoFar[symbol];
      if (!sBars || sBars.length < 20) continue;
      const trail = chandelierStop(sBars, { side: "buy", currentStop: stops.get(symbol) ?? null });
      if (trail && (trail.moved || !stops.has(symbol))) stops.set(symbol, trail.effectiveStop);
    }

    // Exits by signal (trailing/fixed exits already handled above, same day).
    for (const [symbol] of positions) {
      if (pending.some((o) => o.symbol === symbol && o.type === "sell")) continue;
      const signal = signals.get(symbol);
      if (signal && /sell/.test(signal.action)) {
        pending.push({ type: "sell", symbol, reason: `Signal turned ${signal.action}. ${signal.reason}` });
      }
    }

    // Entries.
    const exitingSymbols = new Set(pending.filter((o) => o.type === "sell").map((o) => o.symbol));
    const survivingCount = positions.size - exitingSymbols.size;
    let room = Math.max(0, cfg.maxPositions - survivingCount);

    const equityNow = markToMarket(i);
    const survivingStops = {};
    for (const [symbol] of positions) {
      if (!exitingSymbols.has(symbol)) survivingStops[symbol] = stops.get(symbol);
    }
    const survivingPositionsForHeat = Array.from(positions.entries())
      .filter(([symbol]) => !exitingSymbols.has(symbol))
      .map(([symbol, pos]) => ({ symbol, qty: pos.qty, currentPrice: priceOf(symbol, i) ?? pos.entryPrice }));

    const heat = portfolioHeat(survivingPositionsForHeat, equityNow, survivingStops);
    let projectedHeatPercent = heat.ok ? heat.heatPercent : null;

    const heldBars = {};
    for (const [symbol] of positions) {
      if (!exitingSymbols.has(symbol)) heldBars[symbol] = barsSoFar[symbol];
    }

    const candidates =
      market.ok
        ? Array.from(signals.values())
            .filter((s) => /buy/.test(s.action) && !positions.has(s.symbol))
            .sort((a, b) => b.score - a.score)
        : [];

    for (const signal of candidates) {
      if (room <= 0) {
        rejectedSample.push({ at: dates[i], symbol: signal.symbol, reason: "No position slots left." });
        break;
      }
      const sBars = barsSoFar[signal.symbol];

      const liquidity = liquidityCheck(sBars, {});
      if (!liquidity.ok) {
        rejectedSample.push({ at: dates[i], symbol: signal.symbol, stage: "liquidity", reason: liquidity.reason });
        continue;
      }

      const corr = correlationCheck(sBars, heldBars, {});
      if (!corr.ok) {
        rejectedSample.push({ at: dates[i], symbol: signal.symbol, stage: "correlation", reason: corr.reason });
        continue;
      }

      const stop = atrStop(sBars, { side: "buy" });
      if (!stop) {
        rejectedSample.push({ at: dates[i], symbol: signal.symbol, stage: "stop", reason: "No stop could be computed." });
        continue;
      }

      const size = positionSize({
        equity: equityNow,
        price: priceOf(signal.symbol, i),
        stopPrice: stop.stopPrice,
        cash,
        maxPositionUsd: Math.min(cfg.positionUsd, cfg.maxPositionUsd)
      });

      if (!size.ok) {
        rejectedSample.push({ at: dates[i], symbol: signal.symbol, stage: "sizing", reason: size.reason });
        continue;
      }

      const addedHeat = (size.actualRiskUsd / equityNow) * 100;
      if (projectedHeatPercent !== null && projectedHeatPercent + addedHeat > RISK_DEFAULTS.maxPortfolioHeatPercent) {
        rejectedSample.push({
          at: dates[i],
          symbol: signal.symbol,
          stage: "heat",
          reason: `Portfolio heat would reach ${(projectedHeatPercent + addedHeat).toFixed(2)}%, over the ${RISK_DEFAULTS.maxPortfolioHeatPercent}% ceiling.`
        });
        continue;
      }

      pending.push({
        type: "buy",
        symbol: signal.symbol,
        notionalTarget: size.notional,
        stopPriceAtDecision: stop.stopPrice,
        reason: `${signal.reason} Sized to risk $${size.actualRiskUsd} (${size.riskPercentOfEquity}% of equity) with a stop at ${stop.stopPrice} (${stop.basis}).`
      });

      if (projectedHeatPercent !== null) projectedHeatPercent += addedHeat;
      heldBars[signal.symbol] = sBars;
      room--;
    }
  }

  // Anything still queued at the end of the data has no "tomorrow" to fill on.
  if (pending.length > 0) {
    warnings.push(
      `${pending.length} decision(s) made on the final trading day were never filled — there is no following day's open in this dataset to execute them at.`
    );
  }

  // Positions still open at the end are not force-closed: an open position
  // is not a loss or a win, it is unresolved, and closing it at the last
  // close price would invent an exit that never happened.
  const openAtEnd = Array.from(positions.entries()).map(([symbol, pos]) => ({
    symbol,
    qty: round(pos.qty, 6),
    entryPrice: pos.entryPrice,
    entryAt: pos.entryAt,
    markPrice: priceOf(symbol, n - 1),
    unrealizedPnl: round((priceOf(symbol, n - 1) - pos.entryPrice) * pos.qty, 6)
  }));

  if (openAtEnd.length > 0) {
    warnings.push(
      `${openAtEnd.length} position(s) were still open at the end of the data and are excluded from the closed-trade statistics below — they are neither a win nor a loss, they are unresolved.`
    );
  }

  return {
    ok: true,
    period: { start: dates[warmup], end: dates[n - 1], tradingDays: daysConsidered },
    warmupDays: warmup,
    universe,
    benchmarkSymbol,
    startingEquity: cfg.startingEquity,
    finalEquity: round(markToMarket(n - 1), 6),
    closedTrades,
    openAtEnd,
    equitySeries,
    rejectedSample: rejectedSample.slice(-50),
    rejectedCount: rejectedSample.length,
    params: {
      aggressiveness: cfg.aggressiveness,
      positionUsd: cfg.positionUsd,
      maxPositionUsd: cfg.maxPositionUsd,
      maxPositions: cfg.maxPositions,
      stopLossPercent: cfg.stopLossPercent,
      takeProfitPercent: cfg.takeProfitPercent,
      riskDefaults: RISK_DEFAULTS
    },
    warnings
  };
}

function buildClosedTrade(symbol, pos, exitPrice, exitAt, exitReason) {
  const pnl = (exitPrice - pos.entryPrice) * pos.qty;
  const pnlPercent = pos.entryPrice ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100 : null;
  const entryT = new Date(pos.entryAt).getTime();
  const exitT = new Date(exitAt).getTime();
  const holdingDays =
    Number.isFinite(entryT) && Number.isFinite(exitT) ? (exitT - entryT) / 86400000 : null;

  const riskPerShare = Number.isFinite(pos.entryStop) ? pos.entryPrice - pos.entryStop : null;
  const r = riskPerShare && riskPerShare > 0 ? round((exitPrice - pos.entryPrice) / riskPerShare, 6) : null;

  return {
    symbol,
    entryAt: pos.entryAt,
    exitAt,
    entryPrice: round(pos.entryPrice, 6),
    exitPrice: round(exitPrice, 6),
    qty: round(pos.qty, 6),
    pnl: round(pnl, 6),
    pnlPercent: round(pnlPercent, 6),
    holdingDays: round(holdingDays, 6),
    entryRationale: pos.entryRationale,
    exitRationale: exitReason,
    stopPrice: pos.entryStop ?? null,
    r
  };
}

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

function caveats(sim) {
  const out = [
    "This is a historical replay of fixed rules, not a live trading result. Nothing here predicts future performance.",
    "Fills assume the strategy could always trade at the stop/target price or the next bar's open, with no commission and no market-impact slippage beyond a gap-down/gap-up adjustment. Real fills are worse on average, especially in illiquid names or fast markets.",
    "The signal thresholds, ADX bands and risk parameters used here were fixed in strategy.js/risk.js before this backtest ran, not fit to this data — but they were still designed and reviewed by someone who had seen how markets generally behave, which is a softer, harder-to-eliminate form of the same in-sample risk.",
    "Daily bars only: intraday stop/target order is approximated (low/high touch), not simulated tick by tick."
  ];
  if (sim.closedTrades.length < MIN_RELIABLE_SAMPLE) {
    out.push(
      `Only ${sim.closedTrades.length} closed trade(s) resulted from this period — below the ${MIN_RELIABLE_SAMPLE}-trade floor where these statistics stop being mostly noise.`
    );
  }
  return out;
}

/**
 * Run a full backtest and score it with the same honesty machinery as
 * live performance (performance.js), plus a benchmark buy-and-hold
 * comparison so "the strategy made money" can be checked against
 * "the market went up and so did everything in it".
 */
export function backtest(barsBySymbol, options = {}) {
  const sim = simulate(barsBySymbol, options);
  if (!sim.ok) return sim;

  const performance = summarize(sim.closedTrades);
  const drawdown = maxDrawdown(sim.equitySeries);

  const benchBars = alignByDate({ b: barsBySymbol[sim.benchmarkSymbol] || [] }).bars.b;
  const rangeBench = options.dateRange ? filterDateRange(barsBySymbol[sim.benchmarkSymbol] || [], options.dateRange) : (barsBySymbol[sim.benchmarkSymbol] || []);
  const alignedBench = alignByDate({ [sim.benchmarkSymbol]: rangeBench })[sim.benchmarkSymbol];

  // Recompute the benchmark's own start/end over exactly the simulated
  // period (warmup day through the last day), for a fair comparison.
  const bench = { symbol: sim.benchmarkSymbol, startPrice: null, endPrice: null, buyHoldReturnPercent: null, note: null };
  const fullBench = filterDateRange(barsBySymbol[sim.benchmarkSymbol] || [], {
    start: sim.period.start,
    end: sim.period.end
  });
  if (fullBench.length >= 2) {
    bench.startPrice = Number(fullBench[0].c);
    bench.endPrice = Number(fullBench[fullBench.length - 1].c);
    bench.buyHoldReturnPercent = bench.startPrice
      ? round(((bench.endPrice - bench.startPrice) / bench.startPrice) * 100, 4)
      : null;
    bench.note = `${sim.benchmarkSymbol} buy-and-hold over the same ${sim.period.start} to ${sim.period.end} window the strategy was allowed to trade in — the baseline of doing nothing.`;
  } else {
    bench.note = "Not enough benchmark bars in this window to compute a buy-and-hold comparison.";
  }

  const strategyReturnPercent = sim.startingEquity
    ? round(((sim.finalEquity - sim.startingEquity) / sim.startingEquity) * 100, 4)
    : null;

  return {
    ok: true,
    period: sim.period,
    universe: sim.universe,
    benchmarkSymbol: sim.benchmarkSymbol,
    params: sim.params,
    startingEquity: sim.startingEquity,
    finalEquity: sim.finalEquity,
    strategyReturnPercent,
    benchmark: bench,
    beatBuyAndHold:
      bench.buyHoldReturnPercent === null || strategyReturnPercent === null
        ? null
        : strategyReturnPercent > bench.buyHoldReturnPercent,
    performance,
    drawdown,
    tradeCounts: {
      closed: sim.closedTrades.length,
      openAtEnd: sim.openAtEnd.length,
      rejected: sim.rejectedCount
    },
    openAtEnd: sim.openAtEnd,
    closedTrades: sim.closedTrades,
    equitySeries: sim.equitySeries,
    rejectedSample: sim.rejectedSample,
    warnings: sim.warnings,
    honesty: caveats(sim)
  };
}

/**
 * Run the identical, unmodified strategy across several independent date
 * windows and report each on its own, rather than one number from one
 * period. A strategy that only "works" in one window is telling you
 * something; this makes that visible instead of hiding it behind whichever
 * window happened to be picked.
 *
 * windows: [{ label, start, end }, ...]. The same options (and therefore
 * the same parameters) are used for every window — this function does not
 * support re-tuning between windows, on purpose.
 */
export function runWindows(barsBySymbol, windows = [], options = {}) {
  const results = windows.map((w) => {
    const report = backtest(barsBySymbol, { ...options, dateRange: { start: w.start, end: w.end } });
    return { label: w.label, start: w.start, end: w.end, report };
  });

  const usable = results.filter((r) => r.report.ok);
  const allBeat = usable.length > 0 && usable.every((r) => r.report.beatBuyAndHold === true);
  const noneBeat = usable.length > 0 && usable.every((r) => r.report.beatBuyAndHold === false);

  let consistency;
  if (usable.length === 0) {
    consistency = "No window produced a usable backtest.";
  } else if (allBeat) {
    consistency = `Beat buy-and-hold in all ${usable.length} window(s) tested. That is more encouraging than a single window, but it is still not proof: the windows may share a common regime (e.g. all bull markets), and this list of windows was chosen by a person, not sampled at random.`;
  } else if (noneBeat) {
    consistency = `Did not beat buy-and-hold in any of the ${usable.length} window(s) tested. Simplicity has a real base rate advantage here — a strategy that adds cost, taxes and complexity needs to clear that bar convincingly, not just occasionally.`;
  } else {
    consistency = `Beat buy-and-hold in some windows and not others (${usable.length} tested). That mixed result is itself informative: it suggests whatever edge exists is regime-dependent rather than persistent, which is the ordinary finding for strategies built on public indicators.`;
  }

  return {
    windows: results,
    windowCount: windows.length,
    usableCount: usable.length,
    consistency,
    honesty:
      "Running the same fixed rules across multiple windows is the closest this harness comes to out-of-sample validation. It still is not out-of-sample in the strict sense if the rules were ever adjusted after looking at any of these periods — if that happened, rerun on a window that has never been looked at before trusting this."
  };
}
