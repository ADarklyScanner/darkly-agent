/**
 * alerts.js — deciding WHETHER an autotrader run is worth waking someone
 * up for, and not doing it more than once for the same ongoing problem.
 *
 * The scheduler previously ran every 15 minutes with nothing but the
 * deploy log to show for it — a genuine failure (a broken credential, an
 * unhandled exception, the process silently stuck) looked identical to
 * quiet, working correctly right up until someone happened to check. This
 * module is the decision logic for closing that gap; the actual sending
 * lives in mailer.js and the actual scheduling loop lives in autotrader.js.
 * Kept separate and pure so "should this have alerted" is a one-line
 * assertion instead of something only checkable by reading a live inbox.
 *
 * Three outcomes, deliberately treated differently:
 *   - a run that COMPLETED but reported something wrong (errors, an
 *     unexpected skip) — alert, but only once per throttle window, since a
 *     genuine outage can easily span many 15-minute runs and nobody wants
 *     forty identical emails for one broken API key.
 *   - a run that completed cleanly AND actually placed one or more trades
 *     — not a problem, but the one outcome of a clean run someone would
 *     actually want to be told about rather than checking the console for.
 *     Kept to its own "trade" severity so it never reads like an error.
 *   - the scheduler going quiet entirely (no run recorded in far longer
 *     than the configured interval) — this can't be detected from inside
 *     a run that never happened, so it is checked separately, from
 *     whatever last successfully recorded, by getHeartbeat() in
 *     autotrader.js and surfaced through the /health endpoint instead of
 *     an autotrader-run-triggered email.
 */

/**
 * A run recording "market closed" or "signal_only, nothing placed" is
 * completely normal and must never alert — those are correct behavior,
 * not failures. Distinguish that from a run that recorded a real error, a
 * skip that itself indicates a problem, or a clean run that actually
 * placed a trade (the one "nothing is wrong, but you'll want to know"
 * outcome).
 */
export function classifyRunForAlert(run) {
  if (!run || typeof run !== "object") {
    return { alert: false, severity: null, reason: null };
  }

  const errors = Array.isArray(run.errors) ? run.errors.filter(Boolean) : [];

  // A benign, expected skip (market closed, mode off, signal_only) is
  // reported via run.skipped/run.note but carries no errors. An actual
  // error list, or a skip that itself indicates a problem (kill switch
  // aside — that is a deliberate human action, not a failure), is always
  // alert-worthy and takes priority over anything below.
  if (errors.length > 0) {
    // A daily-loss-limit skip is the guardrail doing exactly its job. It
    // is worth knowing about, but it is a risk event, not a system
    // failure — flagged at a lower severity so it does not read the same
    // as "the trading loop is broken."
    const isDailyLossHalt = /daily loss limit/i.test(run.skipped || "");

    return {
      alert: true,
      severity: isDailyLossHalt ? "notice" : "error",
      reason: isDailyLossHalt
        ? `Daily loss limit reached (${run.account?.dayPnl ?? "unknown P&L"}). Trading halted for the rest of the day — this is the guardrail working as designed, not a bug.`
        : errors.join(" | ")
    };
  }

  // No errors. Still worth a look if the run actually acted: a decision
  // only counts here once it cleared every guardrail and Alpaca confirmed
  // the order (result.placed) — a decision that was merely proposed,
  // rejected, or blocked is not "news" the way a placed trade is.
  const placed = Array.isArray(run.decisions)
    ? run.decisions.filter((d) => d && d.result && d.result.placed)
    : [];

  if (run.executed && placed.length > 0) {
    const summary = placed
      .map((d) => `${String(d.side || "").toUpperCase()} ${d.symbol} (${
        d.side === "buy" ? `$${d.notional}` : `${d.qty} sh`
      })`)
      .join(", ");

    return {
      alert: true,
      severity: "trade",
      reason: `Placed ${placed.length} trade${placed.length === 1 ? "" : "s"}: ${summary}`
    };
  }

  return { alert: false, severity: null, reason: null };
}

/**
 * Should an alert actually go out right now, given the last one sent?
 *
 * Throttled by REASON, not just by time: a new, different error while an
 * old one is still within its throttle window still alerts immediately —
 * silence should never hide a second, unrelated problem behind the first.
 */
export function shouldSendAlert({ classification, lastAlert, throttleMinutes = 60, now = Date.now() }) {
  if (!classification || !classification.alert) return false;
  if (!lastAlert || !lastAlert.at || !lastAlert.reason) return true;

  if (lastAlert.reason !== classification.reason) return true;

  const elapsedMin = (now - new Date(lastAlert.at).getTime()) / 60000;
  return elapsedMin >= throttleMinutes;
}

/**
 * Is the scheduler itself still alive? Unlike classifyRunForAlert, this
 * has nothing to inspect from inside a run — by definition, the failure
 * this catches is that no run happened at all. Called with whatever the
 * caller last recorded (lastRunAt) and the configured interval.
 *
 * A generous multiple (3x) of the interval before calling it stale: a
 * slow deploy, a brief Railway hiccup, or one long-running fetch should
 * not itself read as "the scheduler died."
 */
export function schedulerHeartbeat({ lastRunAt, intervalMinutes, now = Date.now(), staleMultiple = 3 }) {
  if (!lastRunAt) {
    return { alive: null, minutesSinceLastRun: null, note: "No run has ever been recorded." };
  }

  const last = new Date(lastRunAt).getTime();
  if (!Number.isFinite(last)) {
    return { alive: null, minutesSinceLastRun: null, note: "lastRunAt is not a valid timestamp." };
  }

  const minutesSinceLastRun = Math.round(((now - last) / 60000) * 10) / 10;
  const staleAfter = Math.max(1, Number(intervalMinutes) || 15) * staleMultiple;
  const alive = minutesSinceLastRun <= staleAfter;

  return {
    alive,
    minutesSinceLastRun,
    staleAfterMinutes: staleAfter,
    note: alive
      ? `Last run ${minutesSinceLastRun} minute(s) ago, within the expected ~${Number(intervalMinutes) || 15}-minute cadence.`
      : `Last run was ${minutesSinceLastRun} minute(s) ago, well past the expected ~${Number(intervalMinutes) || 15}-minute cadence (threshold ${staleAfter}m). The scheduler itself may have stopped, not just declined to trade.`
  };
}
