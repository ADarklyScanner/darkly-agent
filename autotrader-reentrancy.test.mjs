/**
 * Tests for runOnce()'s reentrancy guard — run with:
 *   node autotrader-reentrancy.test.mjs
 *
 * runOnce() is reachable from three places that don't know about each
 * other: the scheduler's setInterval (which fires on a fixed clock
 * regardless of whether the previous run finished), the
 * run_autotrader_now chat tool, and POST /autotrader-run. Two runs
 * executing concurrently isn't just wasted work — trading.js's own
 * placeOrder() serialization (see trading-concurrency.test.mjs) closes
 * the double-submission risk at that layer, but a second full run
 * still means duplicate signal scoring, duplicate risk calc, and a
 * confusing audit trail. This proves a run already in progress causes
 * the next call to short-circuit immediately rather than execute
 * alongside it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH = path.join(os.tmpdir(), `darkly-autotrader-reentrancy-${process.pid}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });

process.env.HOME = SCRATCH;
process.env.DARKLY_STATE_DIR = SCRATCH;
process.env.ALPACA_KEY_ID = "TEST_KEY";
process.env.ALPACA_SECRET_KEY = "TEST_SECRET";
process.env.AUTO_TRADE_UNIVERSE = "AAA";
process.env.MAX_TRADES_PER_DAY = "50";
process.env.TRADE_COOLDOWN_MINUTES = "0";

const { runOnce, _isRunInProgressForTests, _resetRunInProgressForTests } =
  await import("./autotrader.js");

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

function bars(n = 260, start = 100) {
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p = p * 1.004;
    out.push({
      t: new Date(Date.now() - (n - i) * 86400000).toISOString(),
      o: p, h: p * 1.01, l: p * 0.99, c: p, v: 1_000_000
    });
  }
  return out;
}

const world = { bars: bars() };
let clockDelayMs = 0;

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

  if (u.includes("/clock")) {
    // The artificial delay: gives a concurrent second call a real window
    // to observe this run as still in progress, the same way a slow
    // network round-trip would in production.
    if (clockDelayMs) await new Promise((r) => setTimeout(r, clockDelayMs));
    return json({ timestamp: new Date().toISOString(), is_open: true, next_open: null, next_close: null });
  }
  if (u.includes("/account")) {
    return json({ account_number: "T", status: "ACTIVE", currency: "USD", equity: "100000", last_equity: "100000", cash: "100000", buying_power: "100000", trading_blocked: false });
  }
  if (u.includes("/positions")) return json([]);
  // The universe scan's cheap pass: a one-symbol "market" so runOnce has
  // exactly the same real work to do (score AAA) as before this scan
  // replaced the fixed AUTO_TRADE_UNIVERSE watchlist - this test cares
  // about overlap timing, not universe composition, so it stays minimal.
  if (u.includes("/assets?")) {
    return json([{ symbol: "AAA", tradable: true, status: "active", exchange: "TEST", class: "us_equity", shortable: true, fractionable: true, marginable: true }]);
  }
  if (u.includes("/assets/")) {
    const symbol = decodeURIComponent(u.split("/assets/")[1] || "");
    return json({ symbol, tradable: true, status: "active", exchange: "TEST", shortable: true, easy_to_borrow: true, fractionable: true, marginable: true });
  }
  if (u.includes("/stocks/bars")) return json({ bars: { AAA: world.bars }, next_page_token: null });
  if (u.includes("/stocks/snapshots")) {
    const last = world.bars.at(-1);
    const prev = world.bars.length > 1 ? world.bars.at(-2) : last;
    return json({ snapshots: { AAA: { latestTrade: { p: last.c }, dailyBar: { c: last.c, v: last.v }, prevDailyBar: { c: prev.c } } } });
  }
  if (u.includes("/orders") && (init.method || "GET") === "POST") {
    const body = JSON.parse(init.body);
    return json({ id: "order-1", symbol: body.symbol, side: body.side, type: body.type, qty: body.qty || null, notional: body.notional || null, status: "accepted", submitted_at: new Date().toISOString() });
  }
  if (u.includes("/orders")) return json([]);
  return json({});
};

/* ------------------------------------------------------------------ */
console.log("\nReentrancy guard");

_resetRunInProgressForTests();
check("not in progress before anything runs", _isRunInProgressForTests() === false);

clockDelayMs = 40;
const slowRun = runOnce({ mode: "signal_only", force: true }); // not awaited yet

// Give the slow run's first await (the delayed /clock fetch) a moment to
// actually start before checking the flag and firing the second call.
await new Promise((r) => setTimeout(r, 5));
check("flag is set while a run is genuinely in flight", _isRunInProgressForTests() === true);

const overlapping = await runOnce({ mode: "signal_only", force: true });
check("a call arriving mid-run is skipped, not executed alongside it",
  overlapping.skipped === "A run is already in progress; this one was skipped rather than allowed to overlap it.",
  overlapping.skipped);
check("the skipped run does no signal work", overlapping.signals.length === 0);
check("the skip is still auditable, not a silent no-op", overlapping.skipped !== null);

const firstResult = await slowRun;
check("the original run completed normally once its own work finished",
  firstResult.skipped === null || firstResult.signals.length > 0, JSON.stringify(firstResult.skipped));

check("flag clears once the run actually finishes", _isRunInProgressForTests() === false);

clockDelayMs = 0;
const sequential = await runOnce({ mode: "signal_only", force: true });
check("a call after the flag clears runs normally, not skipped",
  sequential.skipped === null, sequential.skipped);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
