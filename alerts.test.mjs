/**
 * Tests for alerts.js — run with: node alerts.test.mjs
 *
 * These pin the two things that actually matter for a decision that only
 * ever gets checked by reading a live inbox: (1) noise gets suppressed —
 * benign skips never alert, a repeat of the same problem stays quiet
 * within its throttle window — and (2) signal never gets suppressed by
 * accident — a genuinely new/different reason always gets through
 * immediately, and a dead scheduler is detected on its own terms.
 */

import { classifyRunForAlert, shouldSendAlert, schedulerHeartbeat } from "./alerts.js";

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

/* ------------------------------------------------------------------ */

console.log("\nclassifyRunForAlert — benign cases never alert");

check("null/non-object run does not alert", classifyRunForAlert(null).alert === false);
check("undefined run does not alert", classifyRunForAlert(undefined).alert === false);
check("a run with no errors does not alert",
  classifyRunForAlert({ errors: [], skipped: null }).alert === false);
check("market-closed skip with no errors does not alert",
  classifyRunForAlert({ errors: [], skipped: "Market closed. Next open 2026-09-18." }).alert === false);
check("mode-off skip with no errors does not alert",
  classifyRunForAlert({ errors: [], skipped: "Autotrader mode is off." }).alert === false);
check("signal_only completion with no errors does not alert",
  classifyRunForAlert({ errors: [], executed: false, note: "signal_only mode..." }).alert === false);
check("missing errors array (undefined) does not alert or throw",
  classifyRunForAlert({ skipped: null }).alert === false);

/* ------------------------------------------------------------------ */

console.log("\nclassifyRunForAlert — real problems alert");

{
  const c = classifyRunForAlert({ errors: ["AAPL: order rejected"], skipped: null });
  check("a run with a real error alerts", c.alert === true);
  check("a real error is severity 'error'", c.severity === "error");
  check("the reason carries the actual error text", /order rejected/.test(c.reason), c.reason);
}

{
  const c = classifyRunForAlert({ errors: ["fetch failed", "timeout"], skipped: null });
  check("multiple errors all get folded into the reason",
    /fetch failed/.test(c.reason) && /timeout/.test(c.reason), c.reason);
}

check("falsy/empty-string errors are filtered before deciding",
  classifyRunForAlert({ errors: [null, "", undefined], skipped: null }).alert === false);

/* ------------------------------------------------------------------ */

console.log("\nclassifyRunForAlert — daily loss halt is a notice, not an error");

{
  const c = classifyRunForAlert({
    errors: ["Daily loss limit reached (-620). No further trading today."],
    skipped: "Daily loss limit reached (-620). No further trading today.",
    account: { dayPnl: -620 }
  });
  check("a daily loss halt still alerts (worth knowing about)", c.alert === true);
  check("a daily loss halt is severity 'notice', not 'error'", c.severity === "notice", c.severity);
  check("the notice explains it's the guardrail working as designed",
    /guardrail working as designed/i.test(c.reason), c.reason);
  check("the notice includes the actual P&L figure", /-620/.test(c.reason), c.reason);
}

{
  const c = classifyRunForAlert({
    errors: ["Daily loss limit reached (-40). No further trading today."],
    skipped: "Daily loss limit reached (-40). No further trading today."
    // no run.account at all
  });
  check("a daily loss halt with no account object still classifies without throwing",
    c.severity === "notice");
  check("falls back to 'unknown P&L' when account.dayPnl is missing",
    /unknown P&L/.test(c.reason), c.reason);
}

check("daily-loss-limit matching is case-insensitive",
  classifyRunForAlert({ errors: ["x"], skipped: "DAILY LOSS LIMIT reached" }).severity === "notice");

/* ------------------------------------------------------------------ */

console.log("\nclassifyRunForAlert — a clean run that actually traded alerts too");

{
  const c = classifyRunForAlert({
    errors: [],
    executed: true,
    decisions: [
      { symbol: "AAPL", side: "buy", notional: 500, result: { placed: true } }
    ]
  });
  check("a clean run with a placed buy alerts", c.alert === true);
  check("a placed trade is its own severity, not 'error' or 'notice'", c.severity === "trade", c.severity);
  check("the reason names the symbol and side", /BUY AAPL/.test(c.reason), c.reason);
  check("a buy reason quotes the dollar amount", /\$500/.test(c.reason), c.reason);
  check("the reason says exactly 1 trade (singular)", /Placed 1 trade:/.test(c.reason), c.reason);
}

{
  const c = classifyRunForAlert({
    errors: [],
    executed: true,
    decisions: [
      { symbol: "AAPL", side: "buy", notional: 500, result: { placed: true } },
      { symbol: "MSFT", side: "sell", qty: 3, result: { placed: true } }
    ]
  });
  check("multiple placed trades all appear in the reason",
    /BUY AAPL/.test(c.reason) && /SELL MSFT/.test(c.reason), c.reason);
  check("a sell reason quotes shares, not a dollar amount", /3 sh/.test(c.reason), c.reason);
  check("the reason pluralizes correctly for 2 trades", /Placed 2 trades:/.test(c.reason), c.reason);
}

check("a decision that was proposed but BLOCKED by a guardrail does not alert",
  classifyRunForAlert({
    errors: [],
    executed: true,
    decisions: [{ symbol: "AAPL", side: "buy", notional: 500, blocked: "Daily trade cap reached" }]
  }).alert === false);

check("a decision with no result at all (rejected before sizing) does not alert",
  classifyRunForAlert({
    errors: [],
    executed: true,
    decisions: [{ symbol: "AAPL", side: "buy", notional: 500 }]
  }).alert === false);

check("signal_only mode (executed:false) never alerts even if decisions look tradeable",
  classifyRunForAlert({
    errors: [],
    executed: false,
    decisions: [{ symbol: "AAPL", side: "buy", notional: 500, result: { placed: true } }]
  }).alert === false);

check("a run with no decisions array at all does not alert or throw",
  classifyRunForAlert({ errors: [], executed: true }).alert === false);

{
  // An error elsewhere in the same run takes priority over a placed
  // trade — "something went wrong" must never be masked by "and also it
  // traded fine over here."
  const c = classifyRunForAlert({
    errors: ["NVDA: order rejected"],
    executed: true,
    decisions: [{ symbol: "AAPL", side: "buy", notional: 500, result: { placed: true } }]
  });
  check("errors win over a placed trade in the same run", c.severity === "error", c.severity);
}

/* ------------------------------------------------------------------ */

console.log("\nshouldSendAlert — throttling by reason, not just by time");

const T0 = new Date("2026-09-17T12:00:00.000Z").getTime();

check("a non-alerting classification never sends",
  shouldSendAlert({ classification: { alert: false }, lastAlert: null, now: T0 }) === false);

check("the very first alert (no lastAlert) always sends",
  shouldSendAlert({ classification: { alert: true, reason: "boom" }, lastAlert: null, now: T0 }) === true);

check("a lastAlert missing 'at' is treated as no prior alert",
  shouldSendAlert({ classification: { alert: true, reason: "boom" }, lastAlert: { reason: "boom" }, now: T0 }) === true);

check("a lastAlert missing 'reason' is treated as no prior alert",
  shouldSendAlert({ classification: { alert: true, reason: "boom" }, lastAlert: { at: new Date(T0).toISOString() }, now: T0 }) === true);

{
  const lastAlert = { at: new Date(T0 - 5 * 60000).toISOString(), reason: "boom" };
  check("the SAME reason within the throttle window is suppressed",
    shouldSendAlert({ classification: { alert: true, reason: "boom" }, lastAlert, throttleMinutes: 60, now: T0 }) === false);
}

{
  const lastAlert = { at: new Date(T0 - 61 * 60000).toISOString(), reason: "boom" };
  check("the SAME reason past the throttle window sends again",
    shouldSendAlert({ classification: { alert: true, reason: "boom" }, lastAlert, throttleMinutes: 60, now: T0 }) === true);
}

{
  const lastAlert = { at: new Date(T0 - 1 * 60000).toISOString(), reason: "boom" };
  check("a DIFFERENT reason sends immediately even seconds after the last alert",
    shouldSendAlert({ classification: { alert: true, reason: "totally different problem" }, lastAlert, throttleMinutes: 60, now: T0 }) === true);
}

{
  const lastAlert = { at: new Date(T0 - 60 * 60000).toISOString(), reason: "boom" };
  check("exactly at the throttle boundary counts as elapsed",
    shouldSendAlert({ classification: { alert: true, reason: "boom" }, lastAlert, throttleMinutes: 60, now: T0 }) === true);
}

/* ------------------------------------------------------------------ */

console.log("\nschedulerHeartbeat — detecting the scheduler going quiet");

check("no lastRunAt ever recorded reports alive:null, not a false 'stale'",
  schedulerHeartbeat({ lastRunAt: null, intervalMinutes: 15 }).alive === null);

check("an invalid timestamp reports alive:null rather than throwing",
  schedulerHeartbeat({ lastRunAt: "not-a-date", intervalMinutes: 15 }).alive === null);

{
  const now = T0;
  const lastRunAt = new Date(T0 - 10 * 60000).toISOString();
  const hb = schedulerHeartbeat({ lastRunAt, intervalMinutes: 15, now });
  check("a run 10 minutes ago on a 15-minute cadence is alive", hb.alive === true);
  check("minutesSinceLastRun is computed correctly", hb.minutesSinceLastRun === 10, hb.minutesSinceLastRun);
}

{
  const now = T0;
  const lastRunAt = new Date(T0 - 44 * 60000).toISOString();
  const hb = schedulerHeartbeat({ lastRunAt, intervalMinutes: 15, now });
  check("just under 3x the interval (44 of 45 min) is still alive", hb.alive === true, JSON.stringify(hb));
}

{
  const now = T0;
  const lastRunAt = new Date(T0 - 46 * 60000).toISOString();
  const hb = schedulerHeartbeat({ lastRunAt, intervalMinutes: 15, now });
  check("just over 3x the interval (46 of 45 min) is stale", hb.alive === false, JSON.stringify(hb));
  check("the stale note explains the scheduler itself may have stopped",
    /scheduler itself may have stopped/.test(hb.note), hb.note);
}

{
  // 100 minutes since the last run, on a 15-minute cadence, is well past
  // the default 3x grace (45m) but still under a widened 10x grace (150m).
  const now = T0;
  const lastRunAt = new Date(T0 - 100 * 60000).toISOString();
  const defaultGrace = schedulerHeartbeat({ lastRunAt, intervalMinutes: 15, now });
  const widenedGrace = schedulerHeartbeat({ lastRunAt, intervalMinutes: 15, now, staleMultiple: 10 });
  check("a custom staleMultiple is honored", defaultGrace.alive === false && widenedGrace.alive === true,
    JSON.stringify({ defaultGrace, widenedGrace }));
}

check("a missing/garbage intervalMinutes falls back to a sane default rather than 0",
  schedulerHeartbeat({ lastRunAt: new Date(T0 - 1000).toISOString(), intervalMinutes: undefined, now: T0 }).staleAfterMinutes === 45);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
