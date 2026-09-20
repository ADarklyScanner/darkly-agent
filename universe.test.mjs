/**
 * Tests for universe.js — the full-market scan that replaced the fixed
 * 8-symbol watchlist.
 *
 * The one property every test here ultimately protects: a scan that
 * cannot honestly rank the market returns ok:false and finalists:[],
 * NEVER a fixed list standing in for a real result. That guarantee is
 * what "never silently fall back to the old watchlist" actually means
 * in code, so it gets checked from several angles rather than once.
 */

process.env.ALPACA_KEY_ID = "TEST_KEY";
process.env.ALPACA_SECRET_KEY = "TEST_SECRET";

import os from "node:os";
import path from "node:path";
process.env.DARKLY_STATE_DIR = path.join(os.tmpdir(), `darkly-universe-test-${process.pid}`);

const { buildUniverse, UNIVERSE_DEFAULTS } = await import("./universe.js");

let pass = 0;
let fail = 0;
function check(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${detail}`); }
}

const realFetch = globalThis.fetch;

function asset(symbol, over = {}) {
  return {
    symbol, tradable: true, status: "active", exchange: "NASDAQ", class: "us_equity",
    shortable: true, fractionable: true, marginable: true, ...over
  };
}

function snap(price, prevClose, volume) {
  return { latestTrade: { p: price }, dailyBar: { c: price, v: volume }, prevDailyBar: { c: prevClose } };
}

/** Routes /assets to `assets` and /stocks/snapshots to `snapshotsBySymbol`. */
function stubMarket(assets, snapshotsBySymbol, { snapshotError = false } = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (/\/assets\?/.test(u)) {
      return { ok: true, status: 200, text: async () => JSON.stringify(assets) };
    }
    if (/\/stocks\/snapshots\?/.test(u)) {
      if (snapshotError) throw new Error("simulated network failure");
      const symbols = decodeURIComponent(u.match(/symbols=([^&]+)/)[1]).split(",");
      const snapshots = {};
      for (const s of symbols) if (snapshotsBySymbol[s]) snapshots[s] = snapshotsBySymbol[s];
      return { ok: true, status: 200, text: async () => JSON.stringify({ snapshots }) };
    }
    throw new Error(`Unhandled stubbed URL in test: ${u}`);
  };
}

/* ------------------------------------------------------------------ */

console.log("\nHappy path: ranking a small market");

{
  const assets = [asset("BIGVOL"), asset("SMALLVOL"), asset("PENNY"), asset("THIN")];
  const snapshots = {
    BIGVOL: snap(100, 95, 5000000),   // huge dollar volume, up 5.3%
    SMALLVOL: snap(50, 49.5, 200000), // modest dollar volume, up 1%
    PENNY: snap(0.5, 0.48, 10000000), // below the price floor despite huge share volume
    THIN: snap(80, 80, 100)           // below the dollar-volume floor
  };
  stubMarket(assets, snapshots);

  const result = await buildUniverse({ finalistCount: 10 });

  check("scan succeeds when data is complete", result.ok === true, result.error);
  check("all four structurally eligible assets counted", result.stats.eligibleForSnapshot === 4, result.stats.eligibleForSnapshot);
  check("full snapshot coverage recorded", result.stats.snapshotCoverage === 4, result.stats.snapshotCoverage);
  check("the sub-$3 penny stock is excluded by the price floor", !result.finalists.includes("PENNY"), result.finalists);
  check("price floor exclusion is counted", result.stats.excludedByPriceFloor === 1, result.stats.excludedByPriceFloor);
  check("the low-dollar-volume name is excluded", !result.finalists.includes("THIN"), result.finalists);
  check("dollar volume floor exclusion is counted", result.stats.excludedByVolumeFloor === 1, result.stats.excludedByVolumeFloor);
  check("the two qualifying names both make the finalist list", result.finalists.includes("BIGVOL") && result.finalists.includes("SMALLVOL"), result.finalists);
  check("higher dollar volume + momentum ranks first", result.ranked[0].symbol === "BIGVOL", JSON.stringify(result.ranked));
  check("reasons explain the funnel in plain language", typeof result.stats.reasons[0] === "string" && result.stats.reasons[0].length > 0);

  globalThis.fetch = realFetch;
}

console.log("\nStructural exclusions");

{
  const assets = [
    asset("GOODCO"),
    asset("DELISTEDCO", { tradable: false, status: "inactive" }),
    asset("OTCCO", { exchange: "OTC" }),
    asset("SOMEFUND", { class: "us_option" })
  ];
  const snapshots = { GOODCO: snap(20, 19, 1000000) };
  stubMarket(assets, snapshots);

  const result = await buildUniverse({ finalistCount: 10 });

  check("non-tradable/inactive assets excluded and counted", result.stats.excludedNotTradable === 1, result.stats.excludedNotTradable);
  check("OTC-exchange assets excluded and counted", result.stats.excludedByExchange === 1, result.stats.excludedByExchange);
  check("non-equity asset class excluded and counted", result.stats.excludedByAssetClass === 1, result.stats.excludedByAssetClass);
  check("only the one genuinely eligible symbol reaches the snapshot pass", result.stats.eligibleForSnapshot === 1, result.stats.eligibleForSnapshot);
  check("that symbol becomes a finalist", result.finalists.includes("GOODCO"), result.finalists);

  globalThis.fetch = realFetch;
}

console.log("\nfinalistCount caps the shortlist, does not change ranking");

{
  const symbols = Array.from({ length: 20 }, (_, i) => `SYM${i}`);
  const assets = symbols.map((s) => asset(s));
  const snapshots = {};
  symbols.forEach((s, i) => { snapshots[s] = snap(50, 49, 1000000 + i * 100000); }); // strictly increasing dollar volume
  stubMarket(assets, snapshots);

  const result = await buildUniverse({ finalistCount: 5 });

  check("finalist list is capped at finalistCount", result.finalists.length === 5, result.finalists.length);
  check("the cap keeps the highest-ranked names", result.finalists.includes("SYM19") && !result.finalists.includes("SYM0"), result.finalists);

  globalThis.fetch = realFetch;
}

console.log("\nFail-closed: asset list unavailable");

{
  globalThis.fetch = async (url) => {
    if (/\/assets\?/.test(String(url))) throw new Error("Alpaca is down");
    throw new Error("should not reach snapshots if assets failed");
  };

  const result = await buildUniverse();
  check("scan reports failure, not a thrown exception", result.ok === false);
  check("finalists is an empty array, never a fallback list", Array.isArray(result.finalists) && result.finalists.length === 0, result.finalists);
  check("the error names what actually failed", /asset list/i.test(result.error), result.error);
  check("the error explicitly disclaims falling back to a fixed watchlist", /fixed watchlist/i.test(result.error), result.error);

  globalThis.fetch = realFetch;
}

console.log("\nFail-closed: nothing structurally eligible");

{
  stubMarket([asset("ONLYONE", { tradable: false, status: "inactive" })], {});
  const result = await buildUniverse();
  check("zero eligible symbols fails closed rather than scanning nothing", result.ok === false);
  check("finalists stays empty", result.finalists.length === 0);
  globalThis.fetch = realFetch;
}

console.log("\nFail-closed: snapshot pass too incomplete to trust");

{
  // 10 eligible symbols, but the snapshot pass only returns data for 2 of
  // them (20% coverage) - well under the default 50% minimum.
  const symbols = Array.from({ length: 10 }, (_, i) => `S${i}`);
  const assets = symbols.map((s) => asset(s));
  const snapshots = { S0: snap(50, 49, 1000000), S1: snap(60, 59, 1000000) };
  stubMarket(assets, snapshots);

  const result = await buildUniverse();
  check("badly incomplete coverage fails closed", result.ok === false);
  check("finalists is empty, not the 2 symbols that DID come back", result.finalists.length === 0, result.finalists);
  check("coverage counts are still reported for diagnosis", result.stats.snapshotCoverage === 2 && result.stats.eligibleForSnapshot === 10);
  check("the error explains it's a coverage problem", /coverage|incomplete/i.test(result.error), result.error);

  globalThis.fetch = realFetch;
}

console.log("\nPartial coverage above the minimum is tolerated, not treated as failure");

{
  // 10 eligible, 6 come back (60% - above the default 50% floor).
  const symbols = Array.from({ length: 10 }, (_, i) => `P${i}`);
  const assets = symbols.map((s) => asset(s));
  const snapshots = {};
  for (let i = 0; i < 6; i++) snapshots[`P${i}`] = snap(50, 49, 1000000);
  stubMarket(assets, snapshots);

  const result = await buildUniverse();
  check("coverage above the minimum succeeds", result.ok === true, result.error);
  check("failedData reflects the 4 that did not come back", result.stats.failedData === 4, result.stats.failedData);
  check("finalists drawn only from symbols that actually had data", result.finalists.every((s) => Number(s.slice(1)) < 6), result.finalists);

  globalThis.fetch = realFetch;
}

console.log("\nA snapshot request that throws marks symbols missing, not the whole scan failed");

{
  const symbols = ["A", "B"];
  const assets = symbols.map((s) => asset(s));
  stubMarket(assets, {}, { snapshotError: true });

  const result = await buildUniverse();
  // With the only chunk erroring, coverage is 0/2 = 0%, below the
  // minimum - this should still fail closed, just via the coverage path
  // rather than throwing out of buildUniverse itself.
  check("does not throw even when the transport itself throws", result !== undefined);
  check("still reports ok:false rather than crashing the caller", result.ok === false);
  check("finalists is empty", result.finalists.length === 0);

  globalThis.fetch = realFetch;
}

console.log("\nDefaults are sane");
check("finalistCount default is a real positive number", UNIVERSE_DEFAULTS.finalistCount > 0);
check("OTC is excluded by default", UNIVERSE_DEFAULTS.excludedExchanges.includes("OTC"));
check("minCoverageFraction default is between 0 and 1", UNIVERSE_DEFAULTS.minCoverageFraction > 0 && UNIVERSE_DEFAULTS.minCoverageFraction < 1);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
