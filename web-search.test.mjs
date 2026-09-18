/**
 * Tests for web-search.js — run with: node web-search.test.mjs
 *
 * Two things matter most here.
 *
 * First, that an unconfigured deployment says so plainly and usefully
 * instead of returning an empty result set — because "no results" and "no
 * search provider" look identical to a caller, and confusing the two
 * would let the agent report that it found nothing when in fact it never
 * looked.
 *
 * Second, that Gemini's search-grounded output never gets confused with
 * retrieved results. It is model-generated prose with citations attached,
 * and this codebase deliberately treats Gemini output as unverified; the
 * shape of the return value has to make that impossible to miss.
 */

import { webSearch, availableProviders, searchConfigured, searchStatus, _setFetchForTests } from "./web-search.js";

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

const NO_KEYS = {};

/* ------------------------------------------------------------------ */

console.log("\nProvider detection");

check("nothing configured means nothing available", availableProviders(NO_KEYS).length === 0);
check("searchConfigured is false with no keys", searchConfigured(NO_KEYS) === false);
check("a Brave key makes Brave available",
  availableProviders({ BRAVE_API_KEY: "k" }).some((p) => p.id === "brave"));
check("an empty-string key does not count",
  availableProviders({ BRAVE_API_KEY: "   " }).length === 0);

check("Google CSE needs BOTH the key and the engine id",
  availableProviders({ GOOGLE_CSE_KEY: "k" }).length === 0 &&
  availableProviders({ GOOGLE_CSE_KEY: "k", GOOGLE_CSE_ID: "id" }).some((p) => p.id === "google_cse"));

check("a Gemini key alone makes search possible",
  searchConfigured({ GEMINI_API_KEY: "g" }) === true);

check("real search engines outrank Gemini grounding",
  availableProviders({ GEMINI_API_KEY: "g", BRAVE_API_KEY: "b" })[0].id === "brave");

check("Gemini is marked as model-summarized, not retrieved",
  availableProviders({ GEMINI_API_KEY: "g" })[0].kind === "model_summarized");
check("Brave is marked as retrieved",
  availableProviders({ BRAVE_API_KEY: "b" })[0].kind === "retrieved");

console.log("\nUnconfigured deployments explain themselves");

{
  const status = searchStatus(NO_KEYS);
  check("status reports not configured", status.configured === false);
  check("status names the keys that would fix it",
    /BRAVE_API_KEY/.test(status.note) && /TAVILY_API_KEY/.test(status.note) && /GEMINI_API_KEY/.test(status.note));
  check("status points out that page reading still works without a key",
    /read_web_page/.test(status.note), status.note);

  const r = await webSearch("anything", { env: NO_KEYS });
  check("a search with no provider returns ok:false, not empty results", r.ok === false);
  check("it does not pretend to have searched", r.results.length === 0 && r.configured === false);
  check("it explains how to enable search", /BRAVE_API_KEY/.test(r.note));
}

{
  const status = searchStatus({ GEMINI_API_KEY: "g" });
  check("a Gemini-only deployment is warned about summary quality",
    /model-generated/.test(status.note) && /verify/i.test(status.note), status.note);
}

console.log("\nRetrieved providers normalize to one shape");

function stubJson(payload, ok = true, status = 200) {
  _setFetchForTests(async () => ({
    ok,
    status,
    json: async () => payload
  }));
}

{
  stubJson({
    web: {
      results: [
        { title: "Reno events this weekend", url: "https://visitrenotahoe.com/events", description: "Big <b>concert</b> Saturday", age: "2 days ago" },
        { title: "Second", url: "https://example.com/2", description: "Another" }
      ]
    }
  });
  const r = await webSearch("reno events", { env: { BRAVE_API_KEY: "k" } });
  check("Brave results come back ok", r.ok === true && r.provider === "brave");
  check("results are normalized to title/url/snippet",
    r.results[0].title === "Reno events this weekend" &&
      r.results[0].url === "https://visitrenotahoe.com/events" &&
      r.results[0].snippet === "Big concert Saturday",
    JSON.stringify(r.results[0]));
  check("HTML in snippets is stripped", !/[<>]/.test(r.results[0].snippet));
  check("retrieved results are marked as retrieved", r.kind === "retrieved");
  check("retrieved results carry no unverified-summary caveat", r.caveat === undefined);
}

{
  stubJson({ results: [{ title: "T", url: "https://t.example/1", content: "body text", published_date: "2026-09-15" }] });
  const r = await webSearch("q", { env: { TAVILY_API_KEY: "k" } });
  check("Tavily normalizes to the same shape",
    r.ok && r.results[0].url === "https://t.example/1" && r.results[0].snippet === "body text");
  check("published dates are preserved when given", r.results[0].published === "2026-09-15");
}

{
  stubJson({ organic: [{ title: "S", link: "https://s.example/1", snippet: "snip", date: "Sep 14, 2026" }] });
  const r = await webSearch("q", { env: { SERPER_API_KEY: "k" } });
  check("Serper normalizes link -> url", r.ok && r.results[0].url === "https://s.example/1");
}

{
  stubJson({ items: [{ title: "G", link: "https://g.example/1", snippet: "snip" }] });
  const r = await webSearch("q", { env: { GOOGLE_CSE_KEY: "k", GOOGLE_CSE_ID: "id" } });
  check("Google CSE normalizes items -> results", r.ok && r.results[0].url === "https://g.example/1");
}

{
  stubJson({ web: { results: Array.from({ length: 50 }, (_, i) => ({ title: `t${i}`, url: `https://e.com/${i}`, description: "" })) } });
  const r = await webSearch("q", { env: { BRAVE_API_KEY: "k" }, count: 5 });
  check("the requested result count is respected", r.results.length === 5, String(r.results.length));

  const capped = await webSearch("q", { env: { BRAVE_API_KEY: "k" }, count: 999 });
  check("an absurd count is capped rather than passed through", capped.results.length <= 20);
}

console.log("\nGemini grounding is kept distinguishable from real search");

{
  _setFetchForTests(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        {
          content: { parts: [{ text: "There is a concert at Lawlor on Saturday and the Aces play Sunday." }] },
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: "https://unr.edu/events/1", title: "Lawlor Events" } },
              { web: { uri: "https://milb.com/reno", title: "Reno Aces" } }
            ]
          }
        }
      ]
    })
  }));

  const r = await webSearch("reno events this weekend", { env: { GEMINI_API_KEY: "g" } });

  check("Gemini search returns ok", r.ok === true && r.provider === "gemini");
  check("it is labeled model_summarized, NOT retrieved", r.kind === "model_summarized", r.kind);
  check("the model's prose lands in `summary`, not in `results`",
    typeof r.summary === "string" && r.summary.includes("Lawlor") &&
      r.results.every((x) => !x.snippet));
  check("grounding URLs are surfaced so they can be verified",
    r.results.map((x) => x.url).includes("https://unr.edu/events/1"));
  check("a loud caveat is attached", typeof r.caveat === "string" && r.caveat.length > 80);
  check("the caveat says the summary is generated, not retrieved",
    /MODEL-GENERATED/.test(r.caveat), r.caveat);
  check("the caveat tells the caller to verify with read_web_page",
    /read_web_page/.test(r.caveat));
  check("the caveat forbids citing the summary itself",
    /never cite the summary/i.test(r.caveat));
  check("its source quality is rated low (aggregator)", r.sourceQuality === "aggregator");
}

console.log("\nFailure handling and fallback");

{
  // Brave fails, Tavily works: research should keep going, and say so.
  let call = 0;
  _setFetchForTests(async (url) => {
    call++;
    if (String(url).includes("brave")) return { ok: false, status: 429, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ results: [{ title: "ok", url: "https://t/1", content: "c" }] }) };
  });

  const r = await webSearch("q", { env: { BRAVE_API_KEY: "b", TAVILY_API_KEY: "t" } });
  check("a failing provider falls through to the next", r.ok === true && r.provider === "tavily");
  check("the failure is reported rather than hidden",
    r.attempts.length === 1 && r.attempts[0].provider === "brave" && /429/.test(r.attempts[0].error),
    JSON.stringify(r.attempts));
}

{
  _setFetchForTests(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  const r = await webSearch("q", { env: { BRAVE_API_KEY: "b", TAVILY_API_KEY: "t" } });
  check("when every provider fails, ok is false", r.ok === false);
  check("the error names each provider that failed",
    /brave/.test(r.error) && /tavily/.test(r.error), r.error);
  check("a total failure is NOT reported as zero results", r.results.length === 0 && r.error !== undefined);
}

{
  _setFetchForTests(async () => {
    throw new Error("socket hang up");
  });
  const r = await webSearch("q", { env: { BRAVE_API_KEY: "b" } });
  check("a thrown network error is caught and reported", r.ok === false && /socket hang up/.test(r.error));
}

{
  const r = await webSearch("q", { env: { BRAVE_API_KEY: "b" }, provider: "tavily" });
  check("asking for an unconfigured provider by name fails clearly",
    r.ok === false && /not configured/.test(r.error) && /brave/.test(r.error), r.error);
}

{
  stubJson({ web: { results: [{ title: "x", url: "https://e/1", description: "d" }] } });
  const r = await webSearch("q", { env: { BRAVE_API_KEY: "b", TAVILY_API_KEY: "t" }, provider: "brave" });
  check("asking for a configured provider by name uses it", r.ok === true && r.provider === "brave");
}

_setFetchForTests(null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
