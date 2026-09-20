/**
 * Tests for trading.js's checkGuardrails() treating exits differently from
 * entries — node guardrail-exits.test.mjs
 *
 * Reported bug: a $1,000 max-position-size guardrail blocked a SELL of a
 * position (BAK) that was worth more than that, and separately, a cooldown
 * meant to space out new buys was also delaying sells — so liquidating
 * several positions in a row tripped the same throttle as opening eight
 * new ones back to back. Both guardrails exist to pace or cap NEW risk;
 * neither has any business blocking a trade that only reduces risk.
 *
 * apps/trading.test.mjs already pins the one guardrail that was already
 * exit-aware (tradability, #5) and deliberately neutralizes cooldown and
 * the daily trade count via env vars so its own tests aren't affected by
 * them. This file does the opposite on purpose: it turns cooldown, the
 * daily loss ceiling, and the position-size cap ALL the way up, then
 * proves a sell sails through every one of them while a buy is still
 * correctly stopped — the distinction is the entire point, so a test that
 * only checked "sells are never blocked" could pass by accident if the
 * guardrails were just broken, not fixed.
 */

process.env.ALPACA_KEY_ID = "TEST_KEY";
process.env.ALPACA_SECRET_KEY = "TEST_SECRET";

import os from "node:os";
import path from "node:path";
process.env.DARKLY_STATE_DIR = path.join(os.tmpdir(), `darkly-guardrail-exits-test-${process.pid}`);

// Deliberately strict, and deliberately NOT neutralized like
// trading.test.mjs does — these tests exist specifically to exercise
// what happens when a trade is attempted while every one of these is
// actively in force.
process.env.MAX_TRADES_PER_DAY = "100"; // generous: isolate the OTHER guardrails, not this one
process.env.TRADE_COOLDOWN_MINUTES = "30";
process.env.MAX_POSITION_USD = "500";
process.env.MAX_DAILY_LOSS_USD = "200";

const { placeOrder } = await import("./trading.js");

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

const realFetch = globalThis.fetch;

function stubByUrl(routes) {
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    for (const [pattern, respond] of routes) {
      if (pattern.test(u)) {
        const r = respond(u, opts);
        return { ok: r.status === undefined || (r.status >= 200 && r.status < 300), status: r.status ?? 200, text: async () => JSON.stringify(r.body ?? r) };
      }
    }
    throw new Error(`Unhandled stubbed URL in test: ${u}`);
  };
}

function healthyAccount(overrides = {}) {
  return {
    account_number: "TEST",
    status: "ACTIVE",
    currency: "USD",
    equity: "10000",
    last_equity: "10000",
    cash: "5000",
    buying_power: "10000",
    pattern_day_trader: false,
    trading_blocked: false,
    ...overrides
  };
}

function acceptedOrder(symbol, side, extra = {}) {
  return {
    id: `order_${symbol}_${side}_${Math.random().toString(36).slice(2, 8)}`,
    symbol,
    side,
    type: "market",
    status: "accepted",
    submitted_at: new Date().toISOString(),
    qty: null,
    notional: "100",
    ...extra
  };
}

/* ------------------------------------------------------------------ *
 * Cooldown: a sell right after a buy is not throttled, but a second buy
 * right after the first still is.
 * ------------------------------------------------------------------ */

console.log("\nCooldown between trades is exit-exempt");

function tradableAsset(symbol) {
  return { symbol, tradable: true, status: "active" };
}

{
  stubByUrl([
    [/\/account$/, () => ({ body: healthyAccount() })],
    [/\/assets\//, (u) => ({ body: tradableAsset(u.split("/").pop()) })],
    [/\/orders$/, (u, opts) => {
      const body = JSON.parse(opts.body);
      return { body: acceptedOrder(body.symbol, body.side) };
    }]
  ]);

  const firstBuy = await placeOrder({ symbol: "AAPL", side: "buy", notional: 100, rationale: "opening" });
  check("the first buy of the day places normally", firstBuy.placed === true, JSON.stringify(firstBuy));

  const sellRightAfter = await placeOrder({ symbol: "AAPL", side: "sell", notional: 100, rationale: "exiting" });
  check(
    "a sell placed seconds after a buy is NOT blocked by cooldown",
    sellRightAfter.placed === true,
    JSON.stringify(sellRightAfter)
  );

  const secondBuyRightAfter = await placeOrder({ symbol: "MSFT", side: "buy", notional: 100, rationale: "opening #2" });
  check(
    "a second BUY placed seconds after the first is still blocked by cooldown (the guardrail still works for entries)",
    secondBuyRightAfter.placed === false,
    JSON.stringify(secondBuyRightAfter)
  );
  check(
    "the block names cooldown specifically",
    secondBuyRightAfter.blockedBy.some((b) => /cooldown/i.test(b)),
    secondBuyRightAfter.blockedBy
  );

  globalThis.fetch = realFetch;
}

/* ------------------------------------------------------------------ *
 * Daily loss ceiling: stops new buys, never stops an exit — hitting it
 * is exactly when being able to cut a position matters most.
 * ------------------------------------------------------------------ */

console.log("\nDaily loss ceiling is exit-exempt");

{
  // equity 8000 vs last_equity 10000 => dayPnl -2000, well past -200.
  stubByUrl([
    [/\/account$/, () => ({ body: healthyAccount({ equity: "8000", last_equity: "10000" }) })],
    [/\/assets\//, (u) => ({ body: tradableAsset(u.split("/").pop()) })],
    [/\/orders$/, (u, opts) => {
      const body = JSON.parse(opts.body);
      return { body: acceptedOrder(body.symbol, body.side) };
    }]
  ]);

  const blockedBuy = await placeOrder({ symbol: "NVDA", side: "buy", notional: 100, rationale: "opening during a bad day" });
  check("a buy is blocked once the daily loss ceiling is breached", blockedBuy.placed === false, JSON.stringify(blockedBuy));
  check(
    "the block explains it as the daily loss limit, still says 'no new positions'",
    blockedBuy.blockedBy.some((b) => /daily loss limit hit/i.test(b) && /no new positions/i.test(b)),
    blockedBuy.blockedBy
  );

  const allowedSell = await placeOrder({ symbol: "NVDA", side: "sell", notional: 100, rationale: "cutting the loss" });
  check(
    "a sell is NOT blocked by the same daily loss ceiling — you can still cut the position",
    allowedSell.placed === true,
    JSON.stringify(allowedSell)
  );

  globalThis.fetch = realFetch;
}

/* ------------------------------------------------------------------ *
 * Position size ceiling: the reported bug. A sell worth more than the
 * cap (like BAK) must still go through.
 * ------------------------------------------------------------------ */

console.log("\nPosition size ceiling is exit-exempt (the reported BAK bug)");

{
  stubByUrl([
    [/\/account$/, () => ({ body: healthyAccount() })],
    [/\/assets\//, (u) => ({ body: tradableAsset(u.split("/").pop()) })],
    [/\/orders$/, (u, opts) => {
      const body = JSON.parse(opts.body);
      return { body: acceptedOrder(body.symbol, body.side) };
    }]
  ]);

  const blockedBuy = await placeOrder({ symbol: "BAK", side: "buy", notional: 5000, rationale: "opening too big" });
  check("a buy over the position-size cap is still blocked", blockedBuy.placed === false, JSON.stringify(blockedBuy));
  check(
    "the block names the max position size specifically",
    blockedBuy.blockedBy.some((b) => /exceeds max position size/i.test(b)),
    blockedBuy.blockedBy
  );

  const allowedSell = await placeOrder({ symbol: "BAK", side: "sell", notional: 5000, rationale: "exiting a position worth more than the cap" });
  check(
    "a sell worth MORE than the position-size cap is NOT blocked by it — you can always get out",
    allowedSell.placed === true,
    JSON.stringify(allowedSell)
  );
  check(
    "the trade log still records the estimated value for a sell, even though it wasn't enforced",
    allowedSell.guardrailContext && allowedSell.guardrailContext.estimatedUsd === 5000,
    JSON.stringify(allowedSell.guardrailContext)
  );

  globalThis.fetch = realFetch;
}

{
  // A qty-only market sell has to price itself off a live quote to
  // estimate its value. If that lookup fails, a BUY would correctly be
  // blocked ("could not determine the order's dollar value") — but for a
  // SELL, there is nothing to enforce in the first place, so it must not
  // be blocked just because the value couldn't be estimated either.
  stubByUrl([
    [/\/account$/, () => ({ body: healthyAccount() })],
    [/\/orders$/, (u, opts) => {
      const body = JSON.parse(opts.body);
      return { body: acceptedOrder(body.symbol, body.side, { qty: body.qty, notional: null }) };
    }]
    // Deliberately no quote endpoint stubbed: estimateOrderValue's quote
    // fetch will throw and the caller treats that as "unknown", not "0".
  ]);

  const sellWithUnknownValue = await placeOrder({ symbol: "ORCL", side: "sell", qty: 10, rationale: "exiting, price unknown" });
  check(
    "a sell whose value can't be estimated is still not blocked by the position-size check",
    sellWithUnknownValue.placed === true,
    JSON.stringify(sellWithUnknownValue)
  );

  globalThis.fetch = realFetch;
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
