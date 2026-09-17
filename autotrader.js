/**
 * autotrader.js — the unattended trading loop.
 *
 * Design principles, in priority order:
 *
 *  1. It must be observable before it is trusted. The default mode is
 *     signal_only: it does the full analysis and writes down exactly what
 *     it WOULD have done, and places nothing. You promote it to execute
 *     once the log convinces you, not before.
 *  2. It must fail closed. Anything it cannot verify — market state,
 *     account state, order value — stops the trade rather than proceeding
 *     on an assumption.
 *  3. It must be auditable. Every run is recorded with its inputs, its
 *     decisions and its reasons, whether or not it acted.
 *  4. It must be stoppable. A kill switch halts it immediately and
 *     survives restarts.
 *
 * What it does NOT have is an edge. It applies conventional indicators to
 * public data. Treat every number it produces as a hypothesis to be
 * measured against the trade log, never as a prediction.
 */

import {
  readState,
  writeState,
  stateInfo,
  appendLine,
  tailLines,
  archiveInfo
} from "./state.js";

import {
  getAccount,
  getPositions,
  getBars,
  getClock,
  placeOrder,
  reconcileFills,
  getAssetInfo,
  LIMITS,
  isLiveEndpoint
} from "./trading.js";

import { scoreSymbol, AGGRESSIVENESS } from "./strategy.js";

import { classifyRunForAlert, shouldSendAlert, schedulerHeartbeat } from "./alerts.js";
import { alertingConfigured, sendAlertMail } from "./mailer.js";
import { configFingerprint, deploymentInfo } from "./audit.js";

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

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

const STATE_FILE = "darkly-autotrader.json";
const RUN_ARCHIVE = "darkly-runs.jsonl";

export const CONFIG = {
  // off | signal_only | execute
  mode: (process.env.AUTO_TRADE_MODE || "signal_only").toLowerCase(),
  intervalMinutes: Number(process.env.AUTO_TRADE_INTERVAL_MINUTES || 15),
  aggressiveness: (process.env.AUTO_TRADE_AGGRESSIVENESS || "moderate").toLowerCase(),
  universe: String(process.env.AUTO_TRADE_UNIVERSE || "AAPL,MSFT,NVDA,AMZN,GOOGL,META,AMD,COST")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  positionUsd: Number(process.env.AUTO_TRADE_POSITION_USD || 500),
  maxPositions: Number(process.env.AUTO_TRADE_MAX_POSITIONS || 5),
  stopLossPercent: Number(process.env.AUTO_TRADE_STOP_LOSS_PERCENT || 8),
  takeProfitPercent: Number(process.env.AUTO_TRADE_TAKE_PROFIT_PERCENT || 15),
  // How long a given alert REASON stays throttled before repeating (see
  // alerts.js's shouldSendAlert). A new/different reason still alerts
  // immediately regardless of this window.
  alertThrottleMinutes: Number(process.env.ALERT_THROTTLE_MINUTES || 60)
};

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

function loadState() {
  const state = readState(STATE_FILE, null);
  if (!state || typeof state !== "object") {
    return { killSwitch: false, runs: [], lastRunAt: null };
  }
  return state;
}

function saveState(state) {
  // The hot state file holds only what a status check needs. Full run
  // history goes to the append-only archive below, where it can grow
  // indefinitely without this file ever getting slower to write.
  writeState(STATE_FILE, { ...state, runs: (state.runs || []).slice(-40) });
}

export function getKillSwitch() {
  return Boolean(loadState().killSwitch);
}

export function setKillSwitch(on, reason = null) {
  const state = loadState();
  state.killSwitch = Boolean(on);
  state.killSwitchReason = on ? reason : null;
  state.killSwitchAt = new Date().toISOString();
  saveState(state);
  return { killSwitch: state.killSwitch, reason: state.killSwitchReason };
}

export function getRuns(limit = 20) {
  // The archive is the complete record; the hot state is a fallback for
  // the case where the archive has not been written yet.
  const archived = tailLines(RUN_ARCHIVE, limit);
  if (archived.length > 0) return archived.reverse();

  const runs = loadState().runs || [];
  return runs.slice(-limit).reverse();
}

/** How much history exists, and where. */
export function getHistoryInfo() {
  return {
    ...stateInfo(),
    archive: { file: RUN_ARCHIVE, ...archiveInfo(RUN_ARCHIVE) },
    hotStateRuns: (loadState().runs || []).length,
    note: "Run history is append-only and is never trimmed. Appending stays constant-time however large it grows, and reads seek from the end rather than loading the file."
  };
}

/** Persist trailing stops without disturbing the run history. */
function saveStops(stops) {
  const state = loadState();
  state.stops = stops;
  saveState(state);
}

/** The trailing stop currently protecting each open position. */
export function getStops() {
  return loadState().stops || {};
}

function recordRun(run) {
  // The archive is the permanent record and is written first: if the
  // process dies between these two writes, the history survives and only
  // the cached copy is stale.
  appendLine(RUN_ARCHIVE, run);

  const state = loadState();
  state.runs = [...(state.runs || []), run];
  state.lastRunAt = run.startedAt;
  saveState(state);

  // Fire-and-forget: alerting is a side effect of recording a run, not a
  // condition of it. recordRun stays synchronous so every existing call
  // site above is unaffected, and nothing here can make a run itself
  // fail. Queued as a microtask so it runs after runOnce's own `finally`
  // has set run.finishedAt, since some call sites call recordRun before
  // that block runs.
  queueMicrotask(() => {
    maybeAlert(run).catch((e) => {
      console.error("Alert dispatch failed", e?.message || e);
    });
  });
}

function getLastAlert() {
  return loadState().lastAlert || null;
}

function saveLastAlert(alert) {
  const state = loadState();
  state.lastAlert = alert;
  saveState(state);
}

/**
 * Decide whether this run is worth waking someone up for and, if so, send
 * it. Never throws out of here — see alerts.js's doc comment for why a
 * completed-but-erroring run and a fully silent scheduler are treated as
 * two distinct failure modes; this function handles only the former.
 */
async function maybeAlert(run) {
  const classification = classifyRunForAlert(run);
  if (!classification.alert) return;

  const lastAlert = getLastAlert();
  if (!shouldSendAlert({ classification, lastAlert, throttleMinutes: CONFIG.alertThrottleMinutes })) {
    return;
  }

  // Stay quiet, not broken, until the user deliberately configures a
  // destination — see mailer.js for why this has no default recipient.
  if (!alertingConfigured()) return;

  const sent = await sendAlertMail({
    subject: `[Darkly ${classification.severity === "notice" ? "notice" : "ALERT"}] ${run.mode} run — ${run.startedAt}`,
    text:
      `${classification.reason}\n\n` +
      `Mode: ${run.mode}\n` +
      `Started: ${run.startedAt}\n` +
      `Finished: ${run.finishedAt || "n/a"}\n` +
      (run.account ? `Account equity: ${run.account.equity}, day P&L: ${run.account.dayPnl}\n` : "")
  });

  if (sent.ok) {
    saveLastAlert({
      at: new Date().toISOString(),
      reason: classification.reason,
      severity: classification.severity
    });
  }
}

/**
 * Is the scheduler itself still running? Distinct from maybeAlert above:
 * this has nothing to inspect from inside a run, by design — the failure
 * it catches is that no run happened at all. Exposed through GET /health
 * in server.js for an external uptime pinger, not through email, since a
 * scheduler that's already stopped can't be relied on to send its own
 * "I've stopped" email.
 */
export function getHeartbeat() {
  const state = loadState();
  return schedulerHeartbeat({ lastRunAt: state.lastRunAt, intervalMinutes: CONFIG.intervalMinutes });
}

/** Whether alert email is configured, and what was last sent — surfaced
 * alongside the heartbeat so /health can show the whole alerting picture
 * in one place. */
export function getAlertStatus() {
  return {
    configured: alertingConfigured(),
    throttleMinutes: CONFIG.alertThrottleMinutes,
    lastAlert: getLastAlert()
  };
}

/**
 * The human-readable settings behind the short `configFingerprint`
 * stamped on every run — so "this run's fingerprint is a1b2c3..." can
 * actually be resolved back into real numbers on demand, instead of the
 * (much larger, endlessly repeated) full config having to be written into
 * every single archived run just in case someone needs to look it up.
 */
export function getCurrentConfigDetails() {
  return {
    fingerprint: configFingerprint({ CONFIG, RISK_DEFAULTS, AGGRESSIVENESS }),
    CONFIG,
    RISK_DEFAULTS,
    AGGRESSIVENESS,
    deployment: deploymentInfo()
  };
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

export async function runOnce(options = {}) {
  const startedAt = new Date().toISOString();
  const force = Boolean(options.force);
  const mode = (options.mode || CONFIG.mode).toLowerCase();

  const run = {
    startedAt,
    mode,
    forced: force,
    aggressiveness: CONFIG.aggressiveness,
    // Which CODE (deployed commit, via Railway's own git env vars) and
    // which CONFIG (a hash of the actual runtime settings) produced this
    // run's decisions — see audit.js. Both travel with the run into the
    // append-only archive, so a run from before a parameter change is
    // never mistaken for one made under today's settings.
    deployment: deploymentInfo(),
    configFingerprint: configFingerprint({ CONFIG, RISK_DEFAULTS, AGGRESSIVENESS }),
    skipped: null,
    signals: [],
    decisions: [],
    errors: []
  };

  try {
    if (mode === "off" && !force) {
      run.skipped = "Autotrader mode is off.";
      recordRun(run);
      return run;
    }

    if (getKillSwitch()) {
      run.skipped = "Kill switch is engaged. Disengage it before trading resumes.";
      recordRun(run);
      return run;
    }

    // --- Market must be open, verified with the broker's own clock ---
    let clock;
    try {
      clock = await getClock();
    } catch (e) {
      run.skipped = `Could not read the market clock (${e.message}). Failing closed.`;
      run.errors.push(String(e.message || e));
      recordRun(run);
      return run;
    }

    run.marketOpen = clock.isOpen;
    run.nextOpen = clock.nextOpen;

    if (!clock.isOpen && !force) {
      run.skipped = `Market closed. Next open ${clock.nextOpen}.`;
      recordRun(run);
      return run;
    }

    // --- Live account and position state ---
    const [account, positions] = await Promise.all([getAccount(), getPositions()]);

    run.account = {
      equity: account.equity,
      cash: account.cash,
      dayPnl: account.dayPnl,
      mode: account.mode
    };

    if (account.tradingBlocked) {
      run.skipped = "Alpaca reports trading is blocked on this account.";
      recordRun(run);
      return run;
    }

    // A breached daily loss ceiling stops the session outright. The
    // per-order guardrail would catch it too, but stopping here means we
    // do not spend the run pretending to consider trades we cannot make.
    if (account.dayPnl <= -Math.abs(LIMITS.maxDailyLossUsd)) {
      run.skipped = `Daily loss limit reached (${account.dayPnl}). No further trading today.`;
      recordRun(run);
      return run;
    }

    // Find out what previously submitted orders actually did. Until this
    // runs, the trade log holds intentions only, and a log of intentions
    // cannot be scored.
    try {
      run.reconciled = await reconcileFills({ limit: 60 });
    } catch (e) {
      run.errors.push(`Fill reconciliation failed: ${e.message}`);
    }

    const held = new Map(positions.map((p) => [p.symbol, p]));

    // --- Universe: the watchlist plus anything currently held, because
    //     an open position always needs evaluating for an exit ---
    const universe = Array.from(new Set([...CONFIG.universe, ...held.keys()]));
    run.universe = universe;

    // The benchmark rides along in the same request: the market filter
    // needs 200+ bars of it, and one extra symbol costs nothing.
    const benchmarkSymbol = RISK_DEFAULTS.benchmarkSymbol;
    const fetchList = Array.from(new Set([...universe, benchmarkSymbol]));

    let barsBySymbol = {};
    try {
      barsBySymbol = await getBars({
        symbols: fetchList,
        timeframe: "1Day",
        limit: Math.max(250, RISK_DEFAULTS.benchmarkMaPeriod + 30)
      });
    } catch (e) {
      run.skipped = `Could not fetch price history (${e.message}). Failing closed.`;
      run.errors.push(String(e.message || e));
      recordRun(run);
      return run;
    }

    // A feed that hands back a stub of history for everything is a fetch
    // failure wearing the costume of a market condition. If nothing has
    // enough history to analyse, no new position gets opened this run.
    // Exits are unaffected: those are driven by live position P&L, not bars.
    const MIN_BARS = 30;
    const usable = universe.filter(
      (s) => (barsBySymbol[s] || []).length >= MIN_BARS
    );
    const historyTrusted = usable.length > 0;

    run.barCoverage = {
      minBars: MIN_BARS,
      usable: usable.length,
      of: universe.length
    };

    if (!historyTrusted) {
      run.errors.push(
        `No symbol returned at least ${MIN_BARS} bars. Price history is being treated as unavailable, so no new positions will be opened. This is a data problem, not a market signal.`
      );
    }

    // --- Score everything ---
    for (const symbol of universe) {
      const bars = barsBySymbol[symbol];
      if (!bars || bars.length === 0) {
        run.errors.push(`No bars returned for ${symbol}.`);
        continue;
      }
      run.signals.push(
        scoreSymbol(symbol, bars, { aggressiveness: CONFIG.aggressiveness })
      );
    }

    // --- Is the broad tape in an uptrend? ---
    const market = marketFilter(barsBySymbol[benchmarkSymbol] || [], {});
    run.market = { symbol: benchmarkSymbol, ...market };

    // --- Trailing stops, carried across runs ---
    //
    // This is only possible now that state survives a restart. A trailing
    // stop that resets every deploy is not a trailing stop, it is a
    // decoration.
    const stops = { ...(loadState().stops || {}) };

    for (const position of positions) {
      const bars = barsBySymbol[position.symbol];
      if (!bars || bars.length < 20) continue;

      const existing = stops[position.symbol]?.stopPrice ?? null;
      const trail = chandelierStop(bars, { side: "buy", currentStop: existing });
      if (!trail) continue;

      if (trail.moved || existing === null) {
        stops[position.symbol] = {
          stopPrice: trail.effectiveStop,
          updatedAt: new Date().toISOString(),
          basis: trail.basis
        };
      }
    }

    run.stops = stops;

    // --- Decide ---
    const decisions = [];

    // Exits first: freeing capital and cutting losers takes precedence
    // over opening anything new.
    for (const position of positions) {
      const signal = run.signals.find((s) => s.symbol === position.symbol);
      const pnlPercent = Number(position.unrealizedPlPercent);
      const price = Number(position.currentPrice ?? position.current_price);
      const trailing = stops[position.symbol]?.stopPrice ?? null;

      let exitReason = null;

      // A breached trailing stop comes first: it is the exit that stops a
      // winner round-tripping into a loser, which the percentage stop
      // below cannot see because it only measures distance from entry.
      if (trailing !== null && Number.isFinite(price) && price <= trailing) {
        exitReason = `Trailing stop hit: ${price} at or below ${trailing} (${stops[position.symbol].basis}).`;
      } else if (pnlPercent <= -Math.abs(CONFIG.stopLossPercent)) {
        exitReason = `Stop loss: position is ${pnlPercent}% against a -${CONFIG.stopLossPercent}% limit.`;
      } else if (pnlPercent >= Math.abs(CONFIG.takeProfitPercent)) {
        exitReason = `Take profit: position is +${pnlPercent}% against a +${CONFIG.takeProfitPercent}% target.`;
      } else if (signal && /sell/.test(signal.action)) {
        exitReason = `Signal turned ${signal.action}. ${signal.reason}`;
      }

      if (exitReason) {
        decisions.push({
          symbol: position.symbol,
          side: "sell",
          qty: position.qty,
          reason: exitReason,
          signal: signal || null
        });
      }
    }

    // --- Entries ---
    const exiting = new Set(
      decisions.filter((d) => d.side === "sell").map((d) => d.symbol)
    );

    const openAfterExits = positions.length - exiting.size;
    let room = Math.max(0, CONFIG.maxPositions - openAfterExits);

    // Current portfolio heat, counting only what we will still hold.
    const surviving = positions.filter((p) => !exiting.has(p.symbol));
    const heat = portfolioHeat(
      surviving,
      account.equity,
      Object.fromEntries(
        Object.entries(stops).map(([k, v]) => [k, v.stopPrice])
      )
    );
    run.heat = heat;

    let projectedHeatPercent = heat.ok ? heat.heatPercent : null;

    const rejected = [];
    const candidates =
      historyTrusted && market.ok
        ? run.signals
            .filter((s) => /buy/.test(s.action) && !held.has(s.symbol))
            .sort((a, b) => b.score - a.score)
        : [];

    if (historyTrusted && !market.ok) {
      run.note = market.reason;
    }

    // Bars of what we will still hold, for the correlation test.
    const heldBars = {};
    for (const p of surviving) {
      if (barsBySymbol[p.symbol]) heldBars[p.symbol] = barsBySymbol[p.symbol];
    }

    for (const signal of candidates) {
      if (room <= 0) {
        rejected.push({ symbol: signal.symbol, reason: "No position slots left." });
        break;
      }

      const bars = barsBySymbol[signal.symbol];

      // 1. Will Alpaca even accept a buy in this name? This is structural
      //    tradability (not delisted, not disabled) — it is NOT live halt
      //    detection, which needs data this account tier does not have. A
      //    lookup failure blocks rather than assumes the name is fine.
      try {
        const asset = await getAssetInfo(signal.symbol);
        if (!asset.tradable || asset.status !== "active") {
          rejected.push({
            symbol: signal.symbol,
            reason: `Not tradable on Alpaca (status: ${asset.status}, tradable: ${asset.tradable}).`,
            stage: "tradability"
          });
          continue;
        }
      } catch (e) {
        rejected.push({
          symbol: signal.symbol,
          reason: `Could not verify tradability: ${e.message}`,
          stage: "tradability"
        });
        continue;
      }

      // 2. Is it liquid enough to trade without the spread eating the edge?
      const liquidity = liquidityCheck(bars, {});
      if (!liquidity.ok) {
        rejected.push({ symbol: signal.symbol, reason: liquidity.reason, stage: "liquidity" });
        continue;
      }

      // 3. Is it actually a new bet?
      const corr = correlationCheck(bars, heldBars, {});
      if (!corr.ok) {
        rejected.push({ symbol: signal.symbol, reason: corr.reason, stage: "correlation" });
        continue;
      }

      // 4. Where does the exit go, and therefore how big can this be?
      const stop = atrStop(bars, { side: "buy" });
      if (!stop) {
        rejected.push({ symbol: signal.symbol, reason: "No stop could be computed.", stage: "stop" });
        continue;
      }

      const size = positionSize({
        equity: account.equity,
        price: Number(bars[bars.length - 1].c),
        stopPrice: stop.stopPrice,
        cash: account.cash,
        maxPositionUsd: Math.min(CONFIG.positionUsd, LIMITS.maxPositionUsd)
      });

      if (!size.ok) {
        rejected.push({ symbol: signal.symbol, reason: size.reason, stage: "sizing" });
        continue;
      }

      // 5. Does the portfolio have room for this much risk?
      const addedHeat = (size.actualRiskUsd / account.equity) * 100;
      if (
        projectedHeatPercent !== null &&
        projectedHeatPercent + addedHeat > RISK_DEFAULTS.maxPortfolioHeatPercent
      ) {
        rejected.push({
          symbol: signal.symbol,
          stage: "heat",
          reason: `Portfolio heat would reach ${(projectedHeatPercent + addedHeat).toFixed(2)}%, over the ${RISK_DEFAULTS.maxPortfolioHeatPercent}% ceiling.`
        });
        continue;
      }

      decisions.push({
        symbol: signal.symbol,
        side: "buy",
        notional: size.notional,
        shares: size.shares,
        stopPrice: stop.stopPrice,
        risk: {
          riskUsd: size.actualRiskUsd,
          riskPercentOfEquity: size.riskPercentOfEquity,
          stopPercent: size.stopPercent,
          boundBy: size.boundBy,
          basis: stop.basis
        },
        correlation: { max: corr.maxCorrelation, against: corr.against },
        liquidity: { avgDollarVolume: liquidity.avgDollarVolume },
        reason: `${signal.reason} Sized to risk $${size.actualRiskUsd} (${size.riskPercentOfEquity}% of equity) with a stop at ${stop.stopPrice} (${stop.basis}).`,
        signal
      });

      if (projectedHeatPercent !== null) projectedHeatPercent += addedHeat;
      heldBars[signal.symbol] = bars;
      room--;
    }

    run.rejected = rejected;
    run.projectedHeatPercent =
      projectedHeatPercent === null ? null : Number(projectedHeatPercent.toFixed(3));
    run.decisions = decisions;

    // Remember the stops for the next run, and seed stops for anything
    // being opened now so the first trailing update has a floor to ratchet
    // from rather than inventing one.
    for (const d of decisions) {
      if (d.side === "buy" && d.stopPrice) {
        stops[d.symbol] = {
          stopPrice: d.stopPrice,
          updatedAt: new Date().toISOString(),
          basis: d.risk?.basis || "initial ATR stop"
        };
      }
      if (d.side === "sell") delete stops[d.symbol];
    }
    saveStops(stops);

    // --- Act, or don't ---
    if (mode !== "execute") {
      run.executed = false;
      run.note =
        "signal_only mode: decisions were recorded but no orders were placed. Set AUTO_TRADE_MODE=execute to act on them.";
      recordRun(run);
      return run;
    }

    run.executed = true;

    for (const decision of decisions) {
      try {
        const result = await placeOrder({
          symbol: decision.symbol,
          side: decision.side,
          type: "market",
          qty: decision.side === "sell" ? decision.qty : undefined,
          notional: decision.side === "buy" ? decision.notional : undefined,
          rationale: `[autotrader ${CONFIG.aggressiveness}] ${decision.reason}`,

          // Carry the decision's context into the trade log so the trade
          // can be scored later against what it was expected to do. A log
          // without the stop price cannot express an outcome in R.
          signal: decision.signal
            ? { ...decision.signal, stopPrice: decision.stopPrice ?? decision.signal.stopPrice }
            : null
        });

        decision.result = result;

        // Guardrail blocks are a normal, expected outcome, not an error.
        if (!result.placed) decision.blocked = result.blockedBy;
      } catch (e) {
        decision.error = String(e.message || e);
        run.errors.push(`${decision.symbol}: ${decision.error}`);
      }
    }

    recordRun(run);
    return run;
  } catch (e) {
    run.errors.push(String(e.message || e));
    run.skipped = `Run aborted: ${e.message}`;
    recordRun(run);
    return run;
  } finally {
    run.finishedAt = new Date().toISOString();
  }
}

/* ------------------------------------------------------------------ *
 * Scheduler
 * ------------------------------------------------------------------ */

let timer = null;

export function startScheduler() {
  if (timer) return { started: false, reason: "Already running." };
  if (CONFIG.mode === "off") {
    return { started: false, reason: "AUTO_TRADE_MODE is off." };
  }

  const intervalMs = Math.max(1, CONFIG.intervalMinutes) * 60 * 1000;

  timer = setInterval(() => {
    runOnce().catch((e) => {
      console.error("[autotrader] run failed:", e.message);
    });
  }, intervalMs);

  // Do not fire immediately on boot: a deploy loop would otherwise turn
  // into a burst of trades.
  console.log(
    `[autotrader] scheduled every ${CONFIG.intervalMinutes}m in ${CONFIG.mode} mode (${isLiveEndpoint() ? "LIVE" : "PAPER"})`
  );

  return { started: true, intervalMinutes: CONFIG.intervalMinutes, mode: CONFIG.mode };
}

export function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    return { stopped: true };
  }
  return { stopped: false, reason: "Not running." };
}

export function getStatus() {
  const state = loadState();
  return {
    mode: CONFIG.mode,
    schedulerRunning: Boolean(timer),
    intervalMinutes: CONFIG.intervalMinutes,
    aggressiveness: CONFIG.aggressiveness,
    universe: CONFIG.universe,
    maxPositions: CONFIG.maxPositions,
    positionUsd: CONFIG.positionUsd,
    stopLossPercent: CONFIG.stopLossPercent,
    takeProfitPercent: CONFIG.takeProfitPercent,
    killSwitch: Boolean(state.killSwitch),
    killSwitchReason: state.killSwitchReason || null,
    lastRunAt: state.lastRunAt || null,
    tradingMode: isLiveEndpoint() ? "LIVE" : "PAPER",
    guardrails: LIMITS,

    // Risk controls are part of the system's identity, not a footnote.
    // Anything describing what this thing does should be able to see them.
    risk: {
      riskPerTradePercent: RISK_DEFAULTS.riskPerTradePercent,
      maxPortfolioHeatPercent: RISK_DEFAULTS.maxPortfolioHeatPercent,
      maxCorrelation: RISK_DEFAULTS.maxCorrelation,
      minDollarVolume: RISK_DEFAULTS.minDollarVolume,
      minPrice: RISK_DEFAULTS.minPrice,
      atrStopMultiple: RISK_DEFAULTS.atrStopMultiple,
      atrTrailMultiple: RISK_DEFAULTS.atrTrailMultiple,
      benchmark: RISK_DEFAULTS.benchmarkSymbol,
      benchmarkMaPeriod: RISK_DEFAULTS.benchmarkMaPeriod
    },

    trailingStops: state.stops || {},

    // Whether any of this is actually being remembered.
    storage: getHistoryInfo()
  };
}
