/**
 * End-to-end tests for the autotrader decision loop.
 * Run with: node autotrader.integration.test.mjs
 *
 * autotrader.test.mjs proves the loop fails closed when it cannot see.
 * This file proves what it does when it CAN see — which is the part that
 * spends money and was, until now, the only part with no coverage.
 *
 * Every Alpaca call is stubbed. Nothing here touches the network, and the
 * whole market is hand-built so each assertion has exactly one cause.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH = path.join(os.tmpdir(), "darkly-autotrader-integration");
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });

process.env.HOME = SCRATCH;
process.env.DARKLY_STATE_DIR = SCRATCH;
process.env.ALPACA_KEY_ID = "TEST_KEY";
process.env.ALPACA_SECRET_KEY = "TEST_SECRET";
// The live scan (universe.js) now decides each cycle's symbols, not
// this fixed list - AUTO_TRADE_UNIVERSE only still matters as
// run_backtest's default elsewhere, so setting it here does nothing for
// this file. AAA/BBB/CCC/DDD reach the deep-pass pipeline below because
// stubMarket()'s /assets and /stocks/snapshots routes list them as the
// entire (tiny, hand-built) tradable market.
//
// The universe scan's OWN cheap price/dollar-volume floor is deliberately
// disabled (0) here: this file's job is to test the deep-pass pipeline -
// scoring, sizing, risk.js's liquidityCheck, tradability - with a known,
// hand-built world, including CCC (illiquid) and DDD (a penny stock)
// specifically BECAUSE they should be rejected by that deep-pass
// liquidity check. If the cheap pass's own floor were left at its live
// default, it would filter CCC/DDD out before they ever reached the
// check this file exists to exercise. universe.test.mjs is where that
// cheap-pass filtering itself gets tested.
process.env.AUTO_TRADE_UNIVERSE_MIN_PRICE = "0";
process.env.AUTO_TRADE_UNIVERSE_MIN_DOLLAR_VOLUME = "0";
process.env.AUTO_TRADE_MAX_POSITIONS = "5";
// Deliberately generous so risk-based sizing is the binding constraint
// here. The interaction with tight caps is asserted separately below —
// see "When caps bind, sizing says so".
process.env.AUTO_TRADE_POSITION_USD = "100000";
process.env.MAX_POSITION_USD = "100000";
// Let the risk-based sizing bind in these checks, not the hard 10%-of-equity ceiling
// (that ceiling has its own test: hard-ceilings.test.mjs).
process.env.HARD_MAX_POSITION_PERCENT = "100";
process.env.HARD_MAX_DAILY_LOSS_PERCENT = "100";
process.env.MAX_TRADES_PER_DAY = "50";
process.env.TRADE_COOLDOWN_MINUTES = "0";

const { runOnce, getStops } = await import("./autotrader.js");

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

/* ---------------------------- fixtures ---------------------------- */

function mulberry(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A price series with a drift and reproducible noise. */
function series(n, drift, noise, seed, start = 100) {
  const r = mulberry(seed);
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p = p * (1 + drift + (r() - 0.5) * noise);
    out.push(p);
  }
  return out;
}

function toBars(closes, volume = 3_000_000, seed = 3) {
  const r = mulberry(seed);
  const n = closes.length;
  return closes.map((c, i) => ({
    t: new Date(Date.UTC(2025, 0, 1) + (i - n) * -0 + i * 86400000).toISOString(),
    o: c,
    h: c * (1 + r() * 0.015),
    l: c * (1 - r() * 0.015),
    c,
    v: typeof volume === "function" ? volume(i) : volume
  }));
}

const N = 260;

// A market where AAA and BBB are strong, clean uptrends; CCC is thin;
// DDD is a penny stock. SPY decides the regime.
const world = {
  bars: {
    AAA: toBars(series(N, 0.004, 0.012, 11)),
    BBB: toBars(series(N, 0.0035, 0.012, 22)),
    CCC: toBars(series(N, 0.004, 0.012, 33), 500),          // illiquid
    DDD: toBars(series(N, 0.004, 0.012, 44, 1), 90_000_000), // ~$1 stock
    SPY: toBars(series(N, 0.0015, 0.006, 55))
  },
  clockOpen: true,
  positions: [],
  equity: 100_000,
  cash: 100_000,
  orders: [],
  untradableSymbols: []
};

const placed = [];

function stubMarket() {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

    if (u.includes("/clock")) {
      return json({
        timestamp: new Date().toISOString(),
        is_open: world.clockOpen,
        next_open: "2026-09-18T13:30:00Z",
        next_close: "2026-09-17T20:00:00Z"
      });
    }

    if (u.includes("/account")) {
      return json({
        account_number: "TEST",
        status: "ACTIVE",
        currency: "USD",
        equity: String(world.equity),
        last_equity: String(world.equity),
        cash: String(world.cash),
        buying_power: String(world.cash),
        trading_blocked: false
      });
    }

    if (u.includes("/positions")) {
      return json(world.positions);
    }

    // The universe scan's cheap pass: the whole tradable "market" here is
    // exactly the hand-built symbols this file gives bars for, MINUS the
    // SPY benchmark - SPY was never part of CONFIG.universe before this
    // scan existed, and giving it real bars would let it start winning
    // the ranking and entering the deep pass as a genuine candidate,
    // which no test below is written to expect. Deliberately does NOT
    // consult untradableSymbols: that fixture exists to prove the DEEP
    // pass's own getAssetInfo check (below) catches a name whose
    // tradability changed after this cheap listing was fetched - folding
    // it in here would make that symbol vanish before deep analysis and
    // the test it is for would never fire.
    if (u.includes("/assets?")) {
      const symbols = Object.keys(world.bars).filter((s) => s !== "SPY");
      return json(symbols.map((symbol) => ({
        symbol,
        tradable: true,
        status: "active",
        exchange: "TEST",
        class: "us_equity",
        shortable: true,
        fractionable: true,
        marginable: true
      })));
    }

    if (u.includes("/assets/")) {
      const symbol = decodeURIComponent(u.split("/assets/")[1] || "");
      const untradable = world.untradableSymbols.includes(symbol);
      return json({
        symbol,
        tradable: !untradable,
        status: untradable ? "inactive" : "active",
        exchange: "TEST",
        shortable: true,
        easy_to_borrow: true,
        fractionable: true,
        marginable: true
      });
    }

    if (u.includes("/stocks/bars")) {
      const symbols = decodeURIComponent(
        (u.match(/symbols=([^&]+)/) || [, ""])[1]
      ).split(",");
      const bars = {};
      for (const s of symbols) if (world.bars[s]) bars[s] = world.bars[s];
      return json({ bars, next_page_token: null });
    }

    if (u.includes("/stocks/snapshots")) {
      const symbols = decodeURIComponent(
        (u.match(/symbols=([^&]+)/) || [, ""])[1]
      ).split(",");
      const snapshots = {};
      for (const s of symbols) {
        const bars = world.bars[s];
        if (!bars || bars.length === 0) continue;
        const last = bars.at(-1);
        const prev = bars.length > 1 ? bars.at(-2) : last;
        snapshots[s] = {
          latestTrade: { p: last.c },
          dailyBar: { c: last.c, v: last.v },
          prevDailyBar: { c: prev.c }
        };
      }
      return json({ snapshots });
    }

    if (u.includes("/orders") && (init.method || "GET") === "POST") {
      const body = JSON.parse(init.body);
      placed.push(body);
      return json({
        id: `order-${placed.length}`,
        symbol: body.symbol,
        side: body.side,
        type: body.type,
        qty: body.qty || null,
        notional: body.notional || null,
        status: "accepted",
        submitted_at: new Date().toISOString()
      });
    }

    if (u.includes("/orders")) {
      return json([]);
    }

    return json({});
  };
}

function reset(overrides = {}) {
  placed.length = 0;
  world.clockOpen = true;
  world.positions = [];
  world.equity = 100_000;
  world.cash = 100_000;
  world.untradableSymbols = [];
  Object.assign(world, overrides);
  stubMarket();
}

/* ------------------------------------------------------------------ */

console.log("\nSignal-only mode does the work but touches nothing");

reset();
const dry = await runOnce({ mode: "signal_only", force: true });

check("scores the whole universe", dry.signals.length >= 4, `${dry.signals.length} signals`);
check("real history reaches the model",
  dry.signals.every((s) => !/Insufficient history/.test(s.reason)),
  dry.signals.find((s) => /Insufficient/.test(s.reason))?.reason);
check("places no orders", placed.length === 0, `${placed.length} placed`);
check("says why nothing was placed", /signal_only/.test(dry.note || ""), dry.note);
check("records decisions anyway", Array.isArray(dry.decisions));

/* ------------------------------------------------------------------ */

console.log("\nEntries are sized by risk, not by a fixed dollar amount");

reset();
const live = await runOnce({ mode: "execute", force: true });
const buys = live.decisions.filter((d) => d.side === "buy");

check("opens something in a healthy tape", buys.length > 0, JSON.stringify(live.rejected));
check("every buy carries a stop", buys.every((d) => d.stopPrice > 0));
check("every stop sits below entry",
  buys.every((d) => d.stopPrice < Number(world.bars[d.symbol].at(-1).c)));
check("every buy reports the dollars it risks",
  buys.every((d) => d.risk && d.risk.riskUsd > 0));
check("risk per trade stays near the configured fraction",
  buys.every((d) => d.risk.riskPercentOfEquity <= 0.6),
  JSON.stringify(buys.map((d) => d.risk.riskPercentOfEquity)));
check("notional follows from the stop, not from a constant",
  new Set(buys.map((d) => d.notional)).size === buys.length || buys.length === 1,
  JSON.stringify(buys.map((d) => d.notional)));
check("sizing reports that risk was the binding constraint",
  buys.every((d) => d.risk.boundBy === "risk"),
  JSON.stringify(buys.map((d) => d.risk.boundBy)));
check("orders actually reach the broker", placed.length === live.decisions.length);
check("buy orders are notional", placed.filter((p) => p.side === "buy").every((p) => p.notional));

/* ------------------------------------------------------------------ */

console.log("\nTradability filters");

const rejectedSymbols = Object.fromEntries(
  (live.rejected || []).map((r) => [r.symbol, r])
);

check("an illiquid name is rejected", rejectedSymbols.CCC?.stage === "liquidity",
  JSON.stringify(rejectedSymbols.CCC));
check("a sub-$5 name is rejected", rejectedSymbols.DDD?.stage === "liquidity",
  JSON.stringify(rejectedSymbols.DDD));
check("rejections explain themselves",
  (live.rejected || []).every((r) => typeof r.reason === "string" && r.reason.length > 10));
check("nothing illiquid was bought", !placed.some((p) => p.symbol === "CCC" || p.symbol === "DDD"));

/* ------------------------------------------------------------------ */

console.log("\nA structurally untradable name is rejected before liquidity is even checked");

reset({ untradableSymbols: ["AAA"] });
const untradableRun = await runOnce({ mode: "execute", force: true });
const aaaRejection = (untradableRun.rejected || []).find((r) => r.symbol === "AAA");

check("AAA (otherwise the strongest signal) is rejected for tradability, not scored past it",
  aaaRejection && aaaRejection.stage === "tradability", JSON.stringify(aaaRejection));
check("the rejection names what was found", /not tradable/i.test(aaaRejection?.reason || ""), aaaRejection?.reason);
check("AAA was never bought", !placed.some((p) => p.symbol === "AAA"));
check("a healthy, unrelated symbol is unaffected by another symbol's tradability rejection",
  untradableRun.decisions.some((d) => d.side === "buy" && d.symbol === "BBB"),
  JSON.stringify(untradableRun.decisions));

/* ------------------------------------------------------------------ */

console.log("\nThe market filter gates entries but never exits");

reset({
  bars: { ...world.bars, SPY: toBars(series(N, -0.002, 0.006, 77)) },
  positions: [
    {
      symbol: "AAA",
      qty: "10",
      side: "long",
      avg_entry_price: "100",
      current_price: "50",
      market_value: "500",
      cost_basis: "1000",
      unrealized_pl: "-500",
      unrealized_plpc: "-0.5"
    }
  ]
});

const bear = await runOnce({ mode: "execute", force: true });

check("risk-off is detected", bear.market.regime === "risk_off", JSON.stringify(bear.market));
check("no new longs in a downtrending tape",
  bear.decisions.filter((d) => d.side === "buy").length === 0);
check("the losing position is still exited",
  bear.decisions.some((d) => d.side === "sell" && d.symbol === "AAA"),
  JSON.stringify(bear.decisions));
check("the run says why it stood aside", /below its .* average/.test(bear.note || ""), bear.note);

// Restore the bull benchmark for what follows.
world.bars.SPY = toBars(series(N, 0.0015, 0.006, 55));

/* ------------------------------------------------------------------ */

console.log("\nTrailing stops ratchet and persist");

reset({
  positions: [
    {
      symbol: "AAA",
      qty: "10",
      side: "long",
      avg_entry_price: "100",
      current_price: String(world.bars.AAA.at(-1).c),
      market_value: "1000",
      cost_basis: "1000",
      unrealized_pl: "0",
      unrealized_plpc: "0.02"
    }
  ]
});

const first = await runOnce({ mode: "signal_only", force: true });
const stopAfterFirst = getStops().AAA?.stopPrice;

check("a held position gets a trailing stop", stopAfterFirst > 0, String(stopAfterFirst));
check("the stop is stored, not just reported", getStops().AAA?.basis !== undefined);

// Price rises: the stop must follow it up.
world.bars.AAA = toBars(series(N + 20, 0.004, 0.012, 11));
world.positions[0].current_price = String(world.bars.AAA.at(-1).c);

await runOnce({ mode: "signal_only", force: true });
const stopAfterRise = getStops().AAA?.stopPrice;
check("stop ratchets up as price rises", stopAfterRise > stopAfterFirst,
  `${stopAfterFirst} -> ${stopAfterRise}`);

// A modest pullback that stays ABOVE the trailing stop. The stop must
// hold its level rather than drifting down with price.
//
// The first version of this test dropped price so far it breached the
// stop, the position was exited, and the stored stop was correctly
// cleared — which looked like a bug and was not. A pullback and a breach
// are different events and the test now distinguishes them.
const risen = series(N + 20, 0.004, 0.012, 11);
const pullback = [
  ...risen,
  risen.at(-1) * 0.99,
  risen.at(-1) * 0.985,
  risen.at(-1) * 0.98
];
world.bars.AAA = toBars(pullback);
world.positions[0].current_price = String(pullback.at(-1));

check("the pullback stays above the stop (fixture sanity)",
  pullback.at(-1) > stopAfterRise, `${pullback.at(-1)} vs ${stopAfterRise}`);

await runOnce({ mode: "signal_only", force: true });
check("stop never loosens on a pullback", getStops().AAA?.stopPrice >= stopAfterRise,
  `${stopAfterRise} -> ${getStops().AAA?.stopPrice}`);

/* ------------------------------------------------------------------ */

console.log("\nA breached trailing stop forces an exit");

reset({
  positions: [
    {
      symbol: "AAA",
      qty: "10",
      side: "long",
      avg_entry_price: "10",
      current_price: "1",          // far below any trailing stop
      market_value: "10",
      cost_basis: "100",
      unrealized_pl: "-90",
      unrealized_plpc: "-0.9"
    }
  ]
});

const stopped = await runOnce({ mode: "signal_only", force: true });
const exit = stopped.decisions.find((d) => d.symbol === "AAA" && d.side === "sell");
check("the position is exited", Boolean(exit), JSON.stringify(stopped.decisions));
check("the exit names its trigger", /stop/i.test(exit?.reason || ""), exit?.reason);
check("exiting clears the stored stop", getStops().AAA === undefined,
  JSON.stringify(getStops().AAA));

/* ------------------------------------------------------------------ */

console.log("\nWhen caps bind, sizing says so");

// The user's hard guardrails sit UNDER the risk model. With a small
// per-position cap and a large account, risk-based sizing cannot operate:
// every position is cap-bound and the risk layer is decorative. That is a
// legitimate configuration, but it must be visible rather than implied.
const { positionSize } = await import("./risk.js");

const capBound = positionSize({
  equity: 100_000,
  price: 100,
  stopPrice: 92,
  riskPerTradePercent: 0.5,
  maxPositionUsd: 1000
});

check("a tight cap binds instead of risk", capBound.boundBy === "maxPositionUsd", capBound.boundBy);
check("cap-bound risk is far below the target",
  capBound.actualRiskUsd < capBound.targetRiskUsd / 2,
  `${capBound.actualRiskUsd} vs ${capBound.targetRiskUsd}`);
check("the cap is named in the notes",
  capBound.notes.some((n) => /per-position limit/.test(n)), JSON.stringify(capBound.notes));

/* ------------------------------------------------------------------ */

console.log("\nPortfolio heat is capped");

const manyPositions = ["P1", "P2", "P3"].map((s) => ({
  symbol: s,
  qty: "200",
  side: "long",
  avg_entry_price: "100",
  current_price: "100",
  market_value: "20000",
  cost_basis: "20000",
  unrealized_pl: "0",
  unrealized_plpc: "0"
}));

reset({ positions: manyPositions, equity: 100_000, cash: 100_000 });

const hot = await runOnce({ mode: "signal_only", force: true });
check("heat is measured", hot.heat && hot.heat.ok, JSON.stringify(hot.heat));
check("positions with no stop count at full value",
  hot.heat.unprotectedPositions === 3, String(hot.heat.unprotectedPositions));
check("heat is enormous when nothing is protected", hot.heat.heatPercent > 50,
  String(hot.heat.heatPercent));
check("no new risk is added when heat is over the ceiling",
  hot.decisions.filter((d) => d.side === "buy").length === 0,
  JSON.stringify(hot.decisions.filter((d) => d.side === "buy")));
check("the refusal is recorded as a heat rejection",
  (hot.rejected || []).some((r) => r.stage === "heat"),
  JSON.stringify(hot.rejected));

/* ------------------------------------------------------------------ */

console.log("\nState survives across runs");

const runs = (await import("./autotrader.js")).getRuns(50);
check("runs accumulate", runs.length >= 6, `${runs.length} runs`);
check("each run records its market view", runs.some((r) => r.market));
check("each run records what it rejected and why", runs.some((r) => (r.rejected || []).length));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
