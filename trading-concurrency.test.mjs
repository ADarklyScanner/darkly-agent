/**
 * Tests for the placeOrder() serialization fix — run with:
 *   node trading-concurrency.test.mjs
 *
 * checkGuardrails() reads today's trade count and decides before the
 * order is ever submitted to Alpaca, and logTrade() only runs after that
 * (real, awaited) network round-trip completes. placeOrder() is callable
 * from three independent places at once — the autotrader's scheduled
 * run, a manual "place a trade" chat tool, and a manually triggered
 * autotrader run — none of which know about each other or about a run
 * already in flight. Two calls that both start before either has logged
 * its trade can both read the same "under the limit" snapshot and both
 * go through, silently exceeding MAX_TRADES_PER_DAY.
 *
 * This file proves that no longer happens: two concurrent placeOrder()
 * calls, with the daily cap set to 1, must result in exactly one
 * accepted trade and one blocked one — never two accepted, and never a
 * false block of the only trade that should have gone through.
 */

process.env.ALPACA_KEY_ID = "TEST_KEY";
process.env.ALPACA_SECRET_KEY = "TEST_SECRET";
process.env.MAX_TRADES_PER_DAY = "1";
// Isolate the day-limit race specifically; the cooldown guardrail has its
// own well-established coverage elsewhere.
process.env.TRADE_COOLDOWN_MINUTES = "0";

import os from "node:os";
import path from "node:path";
process.env.DARKLY_STATE_DIR = path.join(os.tmpdir(), `darkly-trading-concurrency-test-${process.pid}`);

const { placeOrder, getTradeLog } = await import("./trading.js");

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

const ACCOUNT_OK = {
  account_number: "TEST",
  status: "ACTIVE",
  currency: "USD",
  equity: "100000",
  last_equity: "100000",
  cash: "50000",
  buying_power: "100000",
  pattern_day_trader: false,
  trading_blocked: false
};

const realFetch = globalThis.fetch;

/* ------------------------------------------------------------------ */
console.log("\nConcurrent placeOrder() calls vs. the daily-trade-count guardrail");

{
  globalThis.fetch = async (url, opts) => {
    const u = String(url);

    if (/\/account$/.test(u)) {
      // A real async gap, same shape as the genuine Alpaca round-trip.
      // Without serialization, this is exactly the window where a second
      // concurrent call's checkGuardrails() reads the trade log before
      // this call has logged anything into it.
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, status: 200, text: async () => JSON.stringify(ACCOUNT_OK) };
    }
    if (/\/assets\//.test(u)) {
      const sym = u.split("/").pop();
      return { ok: true, status: 200, text: async () => JSON.stringify({ symbol: sym, tradable: true, status: "active" }) };
    }
    if (/\/orders$/.test(u)) {
      const body = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          id: "order_" + body.symbol,
          symbol: body.symbol,
          side: body.side,
          type: body.type,
          status: "accepted",
          submitted_at: new Date().toISOString(),
          qty: null,
          notional: body.notional
        })
      };
    }
    throw new Error(`Unhandled stubbed URL in concurrency test: ${u}`);
  };

  const [resA, resB] = await Promise.all([
    placeOrder({ symbol: "SYMA", side: "buy", notional: 100, rationale: "race test A" }),
    placeOrder({ symbol: "SYMB", side: "buy", notional: 100, rationale: "race test B" })
  ]);

  const placedCount = [resA, resB].filter((r) => r.placed).length;
  check("exactly one of two concurrent orders is placed, never both",
    placedCount === 1, JSON.stringify([resA, resB]));

  const blocked = resA.placed ? resB : resA;
  check("the other is blocked citing the daily trade limit, not silently allowed through",
    !blocked.placed && blocked.blockedBy.some((b) => /daily trade limit/i.test(b)),
    JSON.stringify(blocked));

  const log = getTradeLog(10);
  const acceptedToday = log.filter((t) => t.accepted).length;
  check("the trade log itself has exactly one accepted trade, not two",
    acceptedToday === 1, `got ${acceptedToday}`);

  globalThis.fetch = realFetch;
}

/* ------------------------------------------------------------------ */
console.log("\nSerialization doesn't wedge future calls after a block or an error");

{
  // MAX_TRADES_PER_DAY is still 1 and a trade was already logged above —
  // a fresh, non-concurrent call should still be evaluated correctly
  // (blocked, cleanly, not hung) rather than the chain getting stuck
  // behind the earlier settled calls.
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (/\/account$/.test(u)) return { ok: true, status: 200, text: async () => JSON.stringify(ACCOUNT_OK) };
    throw new Error(`Unhandled stubbed URL: ${u}`);
  };

  const result = await placeOrder({ symbol: "SYMC", side: "buy", notional: 100, rationale: "after the race" });
  check("a later call is still evaluated (not hung behind the earlier chain)",
    result.placed === false && result.blockedBy.some((b) => /daily trade limit/i.test(b)),
    JSON.stringify(result));

  globalThis.fetch = realFetch;
}

/* ------------------------------------------------------------------ */
console.log("\nfetchWithTimeout: a stalled Alpaca call must not hang forever");

{
  globalThis.fetch = (url, options = {}) => new Promise((resolve, reject) => {
    // Simulates a network stall: never resolves on its own. If the
    // AbortSignal is honored, aborting the fetch is what settles this
    // promise; if it isn't, this hangs until the test runner's own
    // timeout kills the process — a failure either way, just a slower
    // one, so a short explicit timeoutMs is used here to keep the test
    // itself fast regardless.
    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        reject(err);
      });
    }
  });

  const { fetchWithTimeout } = await import("./trading.js");
  const start = Date.now();
  let threw = null;
  try {
    await fetchWithTimeout("https://example.invalid/stalls-forever", {}, 50);
  } catch (e) {
    threw = e;
  }
  const elapsed = Date.now() - start;

  check("a stalled request eventually throws instead of hanging forever", threw !== null);
  check("the error explains it was a timeout", /timed out/i.test(threw && threw.message), threw && threw.message);
  check("it throws at roughly the requested timeout, not immediately or way past it",
    elapsed >= 40 && elapsed < 2000, `${elapsed}ms`);

  globalThis.fetch = realFetch;
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
