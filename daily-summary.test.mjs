/** node daily-summary.test.mjs — the after-close email the owner reads instead of watching anything. */
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
process.env.DARKLY_STATE_DIR = path.join(os.tmpdir(), `darkly-summary-test-${process.pid}`);
process.env.ALPACA_KEY_ID = "K"; process.env.ALPACA_SECRET_KEY = "S";
process.env.GMAIL_USER = ""; process.env.ALERT_EMAIL_TO = "";

let equity = 100000, spy = 500;
globalThis.fetch = async (url) => {
  const u = String(url);
  const body = u.includes("/account") ? { account_number: "x", equity: String(equity), last_equity: "100000", cash: "1000", buying_power: "1000", trading_blocked: false }
    : u.includes("/positions") ? [{ symbol: "AAPL", qty: "10", side: "long", avg_entry_price: "100", current_price: "110", market_value: "1100", cost_basis: "1000", unrealized_pl: "100", unrealized_plpc: "0.1" }]
    : u.includes("/bars") ? { bars: { SPY: [{ t: "2026-09-25T04:00:00Z", o: spy, h: spy, l: spy, c: spy, v: 1 }] } }
    : {};
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

const { buildDailySummary, maybeSendDailySummary } = await import("./autotrader.js");

const first = await buildDailySummary({ today: "2026-09-28" });
assert.match(first.text, /Since 2026-09-28: bot \+0\.00%/);

equity = 105000; spy = 510;           // bot +5%, SPY +2%
const second = await buildDailySummary({ today: "2026-09-29" });
assert.match(second.text, /bot \+5\.00%\s+vs\s+just holding SPY \+2\.00%/);
assert.match(second.subject, /AHEAD of SPY/);
assert.match(second.text, /AAPL .*\(\+10\.00%\)/);

// Weekend / before close / unconfigured email never send.
assert.equal((await maybeSendDailySummary(new Date("2026-09-26T21:00:00Z"))).reason, "weekend");
assert.equal((await maybeSendDailySummary(new Date("2026-09-28T19:00:00Z"))).reason, "before close");
assert.equal((await maybeSendDailySummary(new Date("2026-09-28T21:00:00Z"))).reason, "email not configured");
console.log(second.subject + "\n" + second.text);
console.log("daily-summary: all passed");
