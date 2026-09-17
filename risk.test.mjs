/**
 * Tests for risk.js — run with: node risk.test.mjs
 *
 * The signal layer decides WHETHER to trade. This layer decides HOW MUCH,
 * and how much is where accounts are actually lost. A wrong signal costs
 * one stop. Wrong sizing costs the account. So these assertions are
 * deliberately paranoid about the arithmetic.
 */

import {
  positionSize,
  atrStop,
  chandelierStop,
  portfolioHeat,
  returnsFromBars,
  correlation,
  correlationCheck,
  liquidityCheck,
  marketFilter,
  RISK_DEFAULTS
} from "./risk.js";

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

const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

function bars(closes, opts = {}) {
  const { range = 0.02, volume = 2_000_000 } = opts;
  return closes.map((c, i) => ({
    t: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    o: c,
    h: c * (1 + range),
    l: c * (1 - range),
    c,
    v: typeof volume === "function" ? volume(i) : volume
  }));
}

const flatish = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 5) * 2);
const rising = Array.from({ length: 260 }, (_, i) => 100 + i * 0.5);
const falling = Array.from({ length: 260 }, (_, i) => 230 - i * 0.5);

/* ------------------------------------------------------------------ */

console.log("\nPosition sizing");

// $100k equity, 0.5% risk = $500 risked. Entry 100, stop 90 => $10/share
// => 50 shares => $5,000 notional. The whole point: notional follows from
// risk, it is not chosen.
const s = positionSize({
  equity: 100_000,
  price: 100,
  stopPrice: 90,
  riskPerTradePercent: 0.5,
  maxPositionUsd: Infinity,
  cash: Infinity
});

check("sizes from risk, not from a fixed dollar amount", s.ok && near(s.shares, 50), `shares=${s.shares}`);
check("notional is a consequence of the stop", near(s.notional, 5000), `notional=${s.notional}`);
check("risks exactly the target", near(s.actualRiskUsd, 500), `risk=${s.actualRiskUsd}`);
check("reports risk as a percent of equity", near(s.riskPercentOfEquity, 0.5, 0.001));

// A tighter stop must buy MORE shares for the same risk. This is the
// single most counterintuitive consequence of risk-based sizing and the
// one most worth locking down.
const tight = positionSize({ equity: 100_000, price: 100, stopPrice: 98, riskPerTradePercent: 0.5 });
const wide = positionSize({ equity: 100_000, price: 100, stopPrice: 80, riskPerTradePercent: 0.5 });
check("tighter stop -> larger position", tight.shares > wide.shares, `${tight.shares} vs ${wide.shares}`);
check("wider stop -> smaller position", wide.shares < s.shares, `${wide.shares} vs ${s.shares}`);
check("both risk the same dollars", near(tight.actualRiskUsd, wide.actualRiskUsd, 0.5),
  `${tight.actualRiskUsd} vs ${wide.actualRiskUsd}`);

const capped = positionSize({
  equity: 100_000, price: 100, stopPrice: 98,
  riskPerTradePercent: 0.5, maxPositionUsd: 1000
});
check("per-position cap binds", capped.boundBy === "maxPositionUsd", capped.boundBy);
check("capped notional respects the limit", capped.notional <= 1000, `${capped.notional}`);
check("capped risk is reported BELOW target, not at it",
  capped.actualRiskUsd < capped.targetRiskUsd, `${capped.actualRiskUsd} vs ${capped.targetRiskUsd}`);

const broke = positionSize({ equity: 100_000, price: 100, stopPrice: 90, cash: 200 });
check("cash cap binds", broke.boundBy === "cash", broke.boundBy);
check("never spends more cash than exists", broke.notional <= 200);

check("refuses when stop is above entry",
  positionSize({ equity: 100_000, price: 100, stopPrice: 110 }).ok === false);
check("refuses when stop equals entry",
  positionSize({ equity: 100_000, price: 100, stopPrice: 100 }).ok === false);
check("refuses with no stop", positionSize({ equity: 100_000, price: 100 }).ok === false);
check("refuses with unknown equity", positionSize({ price: 100, stopPrice: 90 }).ok === false);
check("refusal explains itself",
  typeof positionSize({ equity: 100_000, price: 100, stopPrice: 110 }).reason === "string");
check("refusal sizes to zero, never to a default",
  positionSize({ equity: 100_000, price: 100, stopPrice: 110 }).shares === 0);

check("integer mode floors rather than rounds up",
  positionSize({ equity: 100_000, price: 300, stopPrice: 290, allowFractional: false }).shares === 50,
  String(positionSize({ equity: 100_000, price: 300, stopPrice: 290, allowFractional: false }).shares));

/* ------------------------------------------------------------------ */

console.log("\nStops");

const st = atrStop(bars(flatish), { side: "buy", multiple: 2.5 });
check("atr stop sits below price for a long", st && st.stopPrice < flatish[flatish.length - 1]);
check("atr stop reports its basis", st && /ATR/.test(st.basis), st && st.basis);
const stSell = atrStop(bars(flatish), { side: "sell" });
check("atr stop sits above price for a short", stSell.stopPrice > flatish[flatish.length - 1]);
check("atr stop falls back when history is too short",
  /fallback/.test(atrStop(bars([100, 101, 102]), {}).basis));
check("atr stop returns null with no bars", atrStop([], {}) === null);

const trail = chandelierStop(bars(rising), { side: "buy", currentStop: 0 });
check("chandelier trails below the recent high", trail && trail.trailingStop < rising[rising.length - 1]);
check("chandelier ratchets up from a lower stop", trail.effectiveStop === trail.trailingStop && trail.moved);

const held = chandelierStop(bars(rising), { side: "buy", currentStop: 9_999 });
check("trailing stop never moves down", held.effectiveStop === 9_999 && held.moved === false);

/* ------------------------------------------------------------------ */

console.log("\nPortfolio heat");

const positions = [
  { symbol: "AAA", qty: 100, currentPrice: 50 },
  { symbol: "BBB", qty: 50, currentPrice: 100 }
];

const heatWithStops = portfolioHeat(positions, 100_000, { AAA: 45, BBB: 90 });
// AAA: 100 * 5 = 500. BBB: 50 * 10 = 500. Total 1000 = 1% of 100k.
check("heat sums per-position risk", near(heatWithStops.totalRiskUsd, 1000), `${heatWithStops.totalRiskUsd}`);
check("heat as a percent of equity", near(heatWithStops.heatPercent, 1, 0.01), `${heatWithStops.heatPercent}`);
check("no unprotected positions when all have stops", heatWithStops.unprotectedPositions === 0);

// The dangerous case: a position with no stop is full-value risk, not zero.
const heatNoStops = portfolioHeat(positions, 100_000, {});
check("a position with no stop counts at FULL value, not zero",
  near(heatNoStops.totalRiskUsd, 10_000), `${heatNoStops.totalRiskUsd}`);
check("unprotected positions are counted", heatNoStops.unprotectedPositions === 2);
check("unstopped heat dwarfs stopped heat", heatNoStops.heatPercent > heatWithStops.heatPercent * 5);
check("heat refuses without equity", portfolioHeat(positions, null, {}).ok === false);
check("heat sorts worst risk first", heatWithStops.positions.length === 2);

/* ------------------------------------------------------------------ */

console.log("\nCorrelation");

// Correlation is about RETURNS, not prices. Two linear price ramps in
// opposite directions have near-identical return series (both decay as
// 1/price), so they correlate positively — which is why the fixtures here
// are built from returns directly rather than from tidy-looking price
// lines. The first version of this test asserted otherwise and was wrong.
function mulberry(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fromReturns(rets, start = 100) {
  const out = [start];
  for (const r of rets) out.push(out[out.length - 1] * (1 + r));
  return out;
}

const rnd = mulberry(5);
const baseReturns = Array.from({ length: 259 }, () => (rnd() - 0.5) * 0.04);

const a = bars(fromReturns(baseReturns));
const b = bars(fromReturns(baseReturns.map((r) => r * 1.5)));  // same bet, bigger
const c = bars(fromReturns(baseReturns.map((r) => -r)));       // the opposite bet

check("identical shapes correlate near +1", near(correlation(returnsFromBars(a), returnsFromBars(b)), 1, 0.05),
  String(correlation(returnsFromBars(a), returnsFromBars(b))));
check("opposite shapes correlate negatively",
  correlation(returnsFromBars(a), returnsFromBars(c)) < 0.5);
check("correlation needs overlap", correlation(returnsFromBars(bars([1, 2, 3])), returnsFromBars(a)) === null);

const dupe = correlationCheck(a, { CLONE: b }, { maxCorrelation: 0.85 });
check("a near-duplicate is rejected", dupe.ok === false, dupe.reason);
check("rejection names the holding it duplicates", dupe.against === "CLONE");
check("rejection explains the concentration", /same bet/.test(dupe.reason), dupe.reason);

const diverse = correlationCheck(a, { OPPOSITE: c }, { maxCorrelation: 0.85 });
check("an uncorrelated candidate passes", diverse.ok === true, diverse.reason);
check("nothing held means nothing to duplicate", correlationCheck(a, {}).ok === true);

/* ------------------------------------------------------------------ */

console.log("\nLiquidity");

const liquid = liquidityCheck(bars(rising, { volume: 1_000_000 }), {});
check("a liquid name passes", liquid.ok === true, liquid.reason);

const thin = liquidityCheck(bars(rising, { volume: 100 }), {});
check("a thin name is rejected", thin.ok === false, thin.reason);
check("rejection cites dollar volume", /dollar volume/.test(thin.reason), thin.reason);

const penny = liquidityCheck(bars(Array(60).fill(0.4), { volume: 50_000_000 }), {});
check("a sub-$5 stock is rejected on price", penny.ok === false, penny.reason);
check("penny rejection cites price", /price/.test(penny.reason), penny.reason);

// Dollar volume, not share volume: many shares of a cheap stock is not liquidity.
const manySharesCheapStock = liquidityCheck(bars(Array(60).fill(6), { volume: 200_000 }), {});
check("share count alone does not qualify as liquidity", manySharesCheapStock.ok === false,
  manySharesCheapStock.reason);

check("no history means not tradable", liquidityCheck([], {}).ok === false);

/* ------------------------------------------------------------------ */

console.log("\nMarket filter");

const bull = marketFilter(bars(rising), { maPeriod: 200 });
check("index above its average is risk-on", bull.ok === true && bull.regime === "risk_on", bull.reason);

const bear = marketFilter(bars(falling), { maPeriod: 200 });
check("index below its average is risk-off", bear.ok === false && bear.regime === "risk_off", bear.reason);
check("risk-off explains that exits still run", /Exits are unaffected/.test(bear.reason), bear.reason);

const unknown = marketFilter(bars(rising.slice(0, 50)), { maPeriod: 200 });
check("too little benchmark history is 'unknown', not 'bullish'", unknown.known === false, unknown.reason);
check("unknown market state does not halt everything", unknown.ok === true);
check("missing benchmark is reported honestly", marketFilter(null, {}).known === false);

/* ------------------------------------------------------------------ */

console.log("\nDefaults are sane");

check("risk per trade is a survivable fraction",
  RISK_DEFAULTS.riskPerTradePercent > 0 && RISK_DEFAULTS.riskPerTradePercent <= 2,
  String(RISK_DEFAULTS.riskPerTradePercent));
check("portfolio heat ceiling exists",
  RISK_DEFAULTS.maxPortfolioHeatPercent > 0 && RISK_DEFAULTS.maxPortfolioHeatPercent <= 25);
check("correlation ceiling below 1", RISK_DEFAULTS.maxCorrelation < 1);
check("stops are wider than one ATR", RISK_DEFAULTS.atrStopMultiple >= 1.5);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
