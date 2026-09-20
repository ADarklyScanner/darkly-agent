/**
 * Tests for the Guardrails panel's editable-limits feature in trading.js —
 * node guardrails.test.mjs
 *
 * Before this, LIMITS (maxTradesPerDay/maxPositionUsd/maxDailyLossUsd/
 * cooldownMinutes) was read once from env vars at module load and never
 * changed again short of a redeploy. The console's Guardrails panel now
 * lets a value be typed in and saved, so this pins the three things that
 * would silently break that feature: a saved edit actually reaching the
 * live LIMITS object the autotrader's risk checks import (not a copy of
 * it), a bad value being rejected wholesale rather than partially applied,
 * and a saved edit surviving a process restart when storage is durable —
 * the exact case state.js's stateInfo() exists to distinguish.
 */

// state.js resolves and memoizes its directory on first use, and
// trading.js reads any saved guardrail override at module load time, so
// both must be set before the very first import below — same reasoning
// trading.test.mjs documents for its own DARKLY_STATE_DIR.
import os from "node:os";
import path from "node:path";
process.env.DARKLY_STATE_DIR = path.join(os.tmpdir(), `darkly-guardrails-test-${process.pid}`);
process.env.ALPACA_KEY_ID = "TEST_KEY";
process.env.ALPACA_SECRET_KEY = "TEST_SECRET";
process.env.MAX_TRADES_PER_DAY = "10";
process.env.MAX_POSITION_USD = "1000";
process.env.MAX_DAILY_LOSS_USD = "500";
process.env.TRADE_COOLDOWN_MINUTES = "5";

const { LIMITS, updateGuardrails } = await import("./trading.js");

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

function throws(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

/* ------------------------------------------------------------------ *
 * Starting state: nothing saved yet, so LIMITS is exactly the env vars
 * ------------------------------------------------------------------ */

console.log("\nBefore any save, LIMITS matches the env-var defaults");
{
  check("maxTradesPerDay", LIMITS.maxTradesPerDay === 10);
  check("maxPositionUsd", LIMITS.maxPositionUsd === 1000);
  check("maxDailyLossUsd", LIMITS.maxDailyLossUsd === 500);
  check("cooldownMinutes", LIMITS.cooldownMinutes === 5);
}

/* ------------------------------------------------------------------ *
 * A valid update mutates the live LIMITS object in place
 * ------------------------------------------------------------------ */

console.log("\nupdateGuardrails() with valid values");
{
  const result = updateGuardrails({
    maxTradesPerDay: 20,
    maxPositionUsd: 2500,
    maxDailyLossUsd: 750,
    cooldownMinutes: 15
  });
  check("returns the new values", result.maxTradesPerDay === 20 && result.cooldownMinutes === 15);
  check(
    "mutates the SAME LIMITS object other modules already imported (live binding)",
    LIMITS.maxTradesPerDay === 20 && LIMITS.maxPositionUsd === 2500 &&
    LIMITS.maxDailyLossUsd === 750 && LIMITS.cooldownMinutes === 15
  );
}

/* ------------------------------------------------------------------ *
 * A partial patch only touches the fields it names
 * ------------------------------------------------------------------ */

console.log("\nA partial patch leaves the other fields untouched");
{
  updateGuardrails({ cooldownMinutes: 30 });
  check("the named field changed", LIMITS.cooldownMinutes === 30);
  check("an unnamed field is untouched", LIMITS.maxTradesPerDay === 20);
}

/* ------------------------------------------------------------------ *
 * Bad input is rejected wholesale, never partially applied
 * ------------------------------------------------------------------ */

console.log("\nValidation rejects bad values without partially applying them");
{
  const before = { ...LIMITS };

  let err = throws(() => updateGuardrails({ maxTradesPerDay: "not a number" }));
  check("a non-numeric value throws", err !== null);
  check("the thrown error carries a 400 statusCode", err && err.statusCode === 400);
  check("LIMITS is unchanged after a rejected non-numeric value", JSON.stringify(LIMITS) === JSON.stringify(before));

  err = throws(() => updateGuardrails({ maxPositionUsd: -5 }));
  check("a negative value below the bound throws", err !== null);
  check("LIMITS is unchanged after a rejected out-of-range value", JSON.stringify(LIMITS) === JSON.stringify(before));

  err = throws(() => updateGuardrails({ cooldownMinutes: 999999 }));
  check("a value above the bound throws", err !== null);

  // One valid field alongside one invalid field: the whole call is
  // rejected, so the valid field's value must NOT have snuck through.
  err = throws(() => updateGuardrails({ maxTradesPerDay: 50, maxPositionUsd: -1 }));
  check("a mixed valid+invalid patch throws", err !== null);
  check(
    "the valid field in a mixed patch is NOT applied when another field fails",
    LIMITS.maxTradesPerDay === before.maxTradesPerDay
  );

  err = throws(() => updateGuardrails({ notARealField: 1 }));
  check("a patch with no recognized fields throws", err !== null);
  check("its message says so", /no recognized/i.test(err ? err.message : ""), err && err.message);

  err = throws(() => updateGuardrails(null));
  check("null does not crash, throws a clear error instead", err !== null);
  err = throws(() => updateGuardrails("nope"));
  check("a non-object does not crash, throws a clear error instead", err !== null);

  check("LIMITS is still exactly what it was before this whole block", JSON.stringify(LIMITS) === JSON.stringify(before));
}

/* ------------------------------------------------------------------ *
 * Persistence: a saved edit survives a fresh module load (a "restart"),
 * which is the entire point of routing it through state.js at all.
 * ------------------------------------------------------------------ */

console.log("\nA saved edit survives a fresh import (simulated restart)");
{
  updateGuardrails({ maxTradesPerDay: 77, maxPositionUsd: 4321, maxDailyLossUsd: 999, cooldownMinutes: 3 });

  const reloaded = await import(`./trading.js?cachebust=${Date.now()}`);
  check(
    "the reloaded module's LIMITS starts from the saved values, not the env-var defaults",
    reloaded.LIMITS.maxTradesPerDay === 77 &&
    reloaded.LIMITS.maxPositionUsd === 4321 &&
    reloaded.LIMITS.maxDailyLossUsd === 999 &&
    reloaded.LIMITS.cooldownMinutes === 3,
    JSON.stringify(reloaded.LIMITS)
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
