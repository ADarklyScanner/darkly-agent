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

const { barsLookbackDays, getBars } = await import("./trading.js");

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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
