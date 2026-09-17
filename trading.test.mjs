/**
 * Tests for the market-data layer — run with: node trading.test.mjs
 *
 * These exist because of a silent failure that was worse than a crash:
 * getBars asked Alpaca for 120 bars without a `start`, Alpaca treated the
 * limit as a response cap rather than a lookback, and every symbol came
 * back with a single bar. The strategy then reported a calm "insufficient
 * history" for the whole universe, which reads like a market condition
 * rather than a broken request. Nothing threw. Nothing looked wrong.
 *
 * A signal engine that cannot tell "no data" from "no opinion" is not safe
 * to automate, so the request shape is now tested directly.
 */

// Credentials are captured at module load, so they must exist before import.
process.env.ALPACA_KEY_ID = "TEST_KEY";
process.env.ALPACA_SECRET_KEY = "TEST_SECRET";

// state.js resolves and MEMOIZES its directory on first use — set this
// before anything in this file can trigger a trade-log write, so tests
// never touch a real trade log on whatever machine runs them.
import os from "node:os";
import path from "node:path";
process.env.DARKLY_STATE_DIR = path.join(os.tmpdir(), `darkly-trading-test-${process.pid}`);

// The guardrail tests below place several orders in the same run to
// exercise the tradability guardrail in isolation. The cooldown and
// daily-trade-count guardrails are real and tested through their own
// path elsewhere in this codebase's design (checkGuardrails) — pinning
// them off here keeps this file's asserts about tradability, not timing.
process.env.TRADE_COOLDOWN_MINUTES = "0";
process.env.MAX_TRADES_PER_DAY = "1000";

const { barsLookbackDays, getBars, getAssetInfo, placeOrder } = await import("./trading.js");

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

console.log("\nLookback sizing");

// The core invariant: trading days are sparser than calendar days, so a
// daily-bar lookback must always reach back further than the bar count.
for (const n of [30, 60, 120, 250, 500]) {
  const days = barsLookbackDays("1Day", n);
  check(
    `1Day/${n} reaches back further than ${n} calendar days`,
    days > n * 1.4,
    `got ${days}`
  );
}

check("1Day/120 covers a year of trading", barsLookbackDays("1Day", 120) >= 180,
  `got ${barsLookbackDays("1Day", 120)}`);
check("1Hour shrinks the window", barsLookbackDays("1Hour", 100) < barsLookbackDays("1Day", 100));
check("1Min shrinks it further", barsLookbackDays("1Min", 390) < barsLookbackDays("1Hour", 390));
check("1Week widens it", barsLookbackDays("1Week", 52) > barsLookbackDays("1Day", 52));
check("unknown timeframe still returns a sane window",
  barsLookbackDays("banana", 100) > 100, `got ${barsLookbackDays("banana", 100)}`);
check("never returns zero or negative", [1, 5, 1000].every((n) =>
  barsLookbackDays("1Day", n) > 0));

/* ------------------------------------------------------------------ */

console.log("\nRequest shape (the actual bug)");

const captured = [];
const realFetch = globalThis.fetch;

function stubFetch(payloads) {
  let i = 0;
  globalThis.fetch = async (url) => {
    captured.push(String(url));
    const body = payloads[Math.min(i++, payloads.length - 1)];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body)
    };
  };
}

function fakeBars(n, from = 100) {
  return Array.from({ length: n }, (_, i) => ({
    t: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    o: from + i, h: from + i + 1, l: from + i - 1, c: from + i, v: 1000
  }));
}

stubFetch([{ bars: { AAPL: fakeBars(120) }, next_page_token: null }]);
const out = await getBars({ symbols: ["AAPL"], timeframe: "1Day", limit: 120 });
const url = captured[0];

check("request sends an explicit start", /[?&]start=\d{4}-\d{2}-\d{2}/.test(url), url);
check("request sorts oldest-first", /[?&]sort=asc/.test(url), url);
check("request carries the symbol", /symbols=AAPL/.test(url), url);

const started = new Date(url.match(/[?&]start=(\d{4}-\d{2}-\d{2})/)[1]);
const daysBack = (Date.now() - started.getTime()) / 86400000;
check("start is far enough back for 120 daily bars", daysBack >= 180, `got ${Math.round(daysBack)} days`);

check("returns the bars keyed by symbol", Array.isArray(out.AAPL) && out.AAPL.length === 120,
  `got ${out.AAPL && out.AAPL.length}`);

/* ------------------------------------------------------------------ */

console.log("\nPagination");

captured.length = 0;
stubFetch([
  { bars: { MSFT: fakeBars(60, 100) }, next_page_token: "page2" },
  { bars: { MSFT: fakeBars(60, 160) }, next_page_token: null }
]);

const paged = await getBars({ symbols: ["MSFT"], timeframe: "1Day", limit: 120 });
check("follows next_page_token", captured.length === 2, `made ${captured.length} requests`);
check("second request carries the token", /page_token=page2/.test(captured[1]), captured[1]);
check("pages are concatenated", paged.MSFT.length === 120, `got ${paged.MSFT.length}`);
check("concatenated bars stay oldest-first",
  new Date(paged.MSFT[0].t) < new Date(paged.MSFT[paged.MSFT.length - 1].t));

captured.length = 0;
stubFetch([{ bars: { NVDA: fakeBars(300) }, next_page_token: null }]);
const trimmed = await getBars({ symbols: ["NVDA"], limit: 120 });
check("trims to the requested limit", trimmed.NVDA.length === 120, `got ${trimmed.NVDA.length}`);
check("trimming keeps the most recent bars",
  trimmed.NVDA[trimmed.NVDA.length - 1].c === fakeBars(300)[299].c);

/* ------------------------------------------------------------------ */

console.log("\nGuards");

let threw = false;
try {
  await getBars({ symbols: [] });
} catch (e) {
  threw = /at least one symbol/i.test(e.message);
}
check("empty symbol list throws rather than querying", threw);

globalThis.fetch = realFetch;

/* ------------------------------------------------------------------ *
 * Asset tradability
 *
 * Naming discipline matters here specifically: this is a check of
 * structural tradability (delisted / inactive / unsupported), not live
 * halt detection, and the tests below exist partly to pin that the
 * function never claims more than it verifies.
 * ------------------------------------------------------------------ */

console.log("\ngetAssetInfo");

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

{
  const seenUrls = [];
  globalThis.fetch = async (url) => {
    seenUrls.push(String(url));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        symbol: "AAPL",
        tradable: true,
        status: "active",
        exchange: "NASDAQ",
        shortable: true,
        easy_to_borrow: true,
        fractionable: true,
        marginable: true
      })
    };
  };

  const info = await getAssetInfo("aapl");
  check("the request URL uses the UPPERCASED symbol", /\/assets\/AAPL$/.test(seenUrls[0]), seenUrls[0]);
  check("tradable is read as a real boolean", info.tradable === true);
  check("status passes through", info.status === "active");
  check("snake_case fields are translated to camelCase", info.easyToBorrow === true && info.fractionable === true);
}

{
  let threw = null;
  try { await getAssetInfo(""); } catch (e) { threw = e; }
  check("an empty symbol throws rather than requesting '/assets/'", threw !== null);
}

globalThis.fetch = realFetch;

/* ------------------------------------------------------------------ *
 * The tradability guardrail, exercised through placeOrder() — this is
 * the actual code path that protects both manual and autotrader orders.
 * ------------------------------------------------------------------ */

console.log("\nplaceOrder() tradability guardrail");

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

{
  stubByUrl([
    [/\/account$/, () => ({ body: ACCOUNT_OK })],
    [/\/assets\/UNTRADABLE$/, () => ({ body: { symbol: "UNTRADABLE", tradable: false, status: "inactive" } })]
  ]);

  const result = await placeOrder({ symbol: "UNTRADABLE", side: "buy", notional: 100, rationale: "test" });

  check("a buy in an inactive/untradable symbol is blocked, not silently placed", result.placed === false);
  check("the block names the actual reason", result.blockedBy.some((b) => /not tradable/i.test(b)), result.blockedBy);
  check("the guardrail context records what was found", result.guardrailContext.assetInfo.status === "inactive");

  globalThis.fetch = realFetch;
}

{
  stubByUrl([
    [/\/account$/, () => ({ body: ACCOUNT_OK })],
    [/\/assets\/GOOD$/, () => ({ body: { symbol: "GOOD", tradable: true, status: "active" } })],
    [/\/orders$/, () => ({ body: { id: "order_1", symbol: "GOOD", side: "buy", type: "market", status: "accepted", submitted_at: new Date().toISOString(), qty: null, notional: "100" } })]
  ]);

  const result = await placeOrder({ symbol: "GOOD", side: "buy", notional: 100, rationale: "test" });
  check("a buy in a tradable, active symbol is allowed through this guardrail", result.placed === true, JSON.stringify(result));

  globalThis.fetch = realFetch;
}

{
  // Fail closed: if Alpaca can't be asked, the order does not go through
  // on the assumption that silence means "fine".
  stubByUrl([
    [/\/account$/, () => ({ body: ACCOUNT_OK })],
    [/\/assets\/UNKNOWN$/, () => ({ status: 404, body: { message: "asset not found" } })]
  ]);

  const result = await placeOrder({ symbol: "UNKNOWN", side: "buy", notional: 100, rationale: "test" });
  check("an asset lookup failure blocks the buy rather than assuming it's fine", result.placed === false);
  check("the block explains it as an inability to verify, not a false claim of untradability",
    result.blockedBy.some((b) => /could not verify/i.test(b)), result.blockedBy);

  globalThis.fetch = realFetch;
}

{
  // The one deliberate exception: a SELL that reduces/closes a position
  // must not be trapped by a symbol Alpaca has since disabled — otherwise
  // this guardrail would make an existing position impossible to exit.
  stubByUrl([
    [/\/account$/, () => ({ body: ACCOUNT_OK })],
    [/\/orders$/, () => ({ body: { id: "order_2", symbol: "DELISTED", side: "sell", type: "market", status: "accepted", submitted_at: new Date().toISOString(), qty: "10", notional: null } })]
  ]);

  const result = await placeOrder({ symbol: "DELISTED", side: "sell", notional: 100, rationale: "exiting" });
  // No /assets/ route was registered above, so if the guardrail incorrectly
  // called getAssetInfo for a sell, that call would throw ("unhandled
  // stubbed URL"), get caught, and turn into a block — placed would be
  // false. Its being true here is itself proof the assets endpoint was
  // never called for this sell.
  check("a sell is never blocked by the tradability check, so an exit is always possible", result.placed === true, JSON.stringify(result));

  globalThis.fetch = realFetch;
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
