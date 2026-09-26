/**
 * node hard-ceilings.test.mjs
 *
 * The hard safety ceilings in trading.js must hold no matter what the
 * console's Guardrails panel saved — this is the exact Sept 20, 2026
 * setting (500 trades/day, $1M per position, $1M daily loss) that let one
 * chat session put the whole account into a handful of names.
 */
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
process.env.DARKLY_STATE_DIR = path.join(os.tmpdir(), `darkly-ceiling-test-${process.pid}`);
process.env.ALPACA_KEY_ID = "TEST_KEY";
process.env.ALPACA_SECRET_KEY = "TEST_SECRET";

const { updateGuardrails, effectiveLimits, HARD_CEILINGS } = await import("./trading.js");

updateGuardrails({ maxTradesPerDay: 500, maxPositionUsd: 1000000, maxDailyLossUsd: 1000000, cooldownMinutes: 0 });

const L = effectiveLimits(107270.44);
assert.equal(L.maxTradesPerDay, HARD_CEILINGS.maxTradesPerDay);
assert.equal(L.maxPositionUsd, 10727.04);
assert.equal(L.maxDailyLossUsd, 3218.11);

// Tighter user settings still win.
updateGuardrails({ maxTradesPerDay: 5, maxPositionUsd: 500, maxDailyLossUsd: 200 });
const T = effectiveLimits(107270.44);
assert.equal(T.maxTradesPerDay, 5);
assert.equal(T.maxPositionUsd, 500);
assert.equal(T.maxDailyLossUsd, 200);

// Unknown equity falls back to the configured limits (the account check fails closed separately).
const U = effectiveLimits(null);
assert.equal(U.maxPositionUsd, 500);

console.log("hard-ceilings: all passed");
