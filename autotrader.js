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

import fs from "node:fs";
import path from "node:path";

import {
  getAccount,
  getPositions,
  getBars,
  getClock,
  placeOrder,
  LIMITS,
  isLiveEndpoint
} from "./trading.js";

import { scoreSymbol } from "./strategy.js";

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

const STATE_FILE = path.join(process.env.HOME || ".", "darkly-autotrader.json");

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
  takeProfitPercent: Number(process.env.AUTO_TRADE_TAKE_PROFIT_PERCENT || 15)
};

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
  } catch (e) {
    /* a corrupt state file must not be able to start trading */
  }
  return { killSwitch: false, runs: [], lastRunAt: null };
}

function saveState(state) {
  try {
    const trimmed = { ...state, runs: (state.runs || []).slice(-100) };
    fs.writeFileSync(STATE_FILE, JSON.stringify(trimmed, null, 2));
  } catch (e) {
    /* best effort; never let logging failure crash the loop */
  }
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
  const runs = loadState().runs || [];
  return runs.slice(-limit).reverse();
}

function recordRun(run) {
  const state = loadState();
  state.runs = [...(state.runs || []), run];
  state.lastRunAt = run.startedAt;
  saveState(state);
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

    const held = new Map(positions.map((p) => [p.symbol, p]));

    // --- Universe: the watchlist plus anything currently held, because
    //     an open position always needs evaluating for an exit ---
    const universe = Array.from(new Set([...CONFIG.universe, ...held.keys()]));
    run.universe = universe;

    let barsBySymbol = {};
    try {
      barsBySymbol = await getBars({ symbols: universe, timeframe: "1Day", limit: 120 });
    } catch (e) {
      run.skipped = `Could not fetch price history (${e.message}). Failing closed.`;
      run.errors.push(String(e.message || e));
      recordRun(run);
      return run;
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

    // --- Decide ---
    const decisions = [];

    // Exits first: freeing capital and cutting losers takes precedence
    // over opening anything new.
    for (const position of positions) {
      const signal = run.signals.find((s) => s.symbol === position.symbol);
      const pnlPercent = Number(position.unrealizedPlPercent);

      let exitReason = null;

      if (pnlPercent <= -Math.abs(CONFIG.stopLossPercent)) {
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

    // Entries, best score first, subject to how much room is left.
    const openAfterExits =
      positions.length - decisions.filter((d) => d.side === "sell").length;
    let room = Math.max(0, CONFIG.maxPositions - openAfterExits);

    const candidates = run.signals
      .filter((s) => /buy/.test(s.action) && !held.has(s.symbol))
      .sort((a, b) => b.score - a.score);

    for (const signal of candidates) {
      if (room <= 0) break;

      // Size in dollars, never shares. A notional order has an exactly
      // known value, so the position-size guardrail can evaluate it
      // without depending on a quote lookup that might fail.
      const notional = Math.min(
        CONFIG.positionUsd,
        LIMITS.maxPositionUsd,
        Math.max(0, account.cash - 1)
      );

      if (notional < 1) {
        run.errors.push(`Insufficient cash to open ${signal.symbol}.`);
        break;
      }

      decisions.push({
        symbol: signal.symbol,
        side: "buy",
        notional: Number(notional.toFixed(2)),
        reason: signal.reason,
        signal
      });

      room--;
    }

    run.decisions = decisions;

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
          rationale: `[autotrader ${CONFIG.aggressiveness}] ${decision.reason}`
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
    guardrails: LIMITS
  };
}
