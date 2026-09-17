/**
 * Tests for gemini.js — run with: node gemini.test.mjs
 *
 * This tool is allowed to be wrong. It is not allowed to be silently
 * broken: a missing key, a blocked prompt, or an empty response must all
 * come back as a clear error rather than an empty string that could be
 * mistaken for "Gemini had nothing to add."
 */

import { geminiConfigured, buildGeminiRequestBody, extractGeminiText, callGemini } from "./gemini.js";

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

const savedKey = process.env.GEMINI_API_KEY;
const savedModel = process.env.GEMINI_MODEL;

/* ==================================================================== *
 * geminiConfigured
 * ==================================================================== */

console.log("\ngeminiConfigured");

delete process.env.GEMINI_API_KEY;
check("false with no key set", geminiConfigured() === false);
process.env.GEMINI_API_KEY = "test-key";
check("true once a key is set", geminiConfigured() === true);

/* ==================================================================== *
 * buildGeminiRequestBody
 * ==================================================================== */

console.log("\nbuildGeminiRequestBody");

{
  const body = buildGeminiRequestBody("give me ten weird product ideas");
  check("wraps the prompt in Gemini's contents/parts shape",
    body.contents[0].parts[0].text === "give me ten weird product ideas");
  check("defaults to a high temperature (variety is the point of this tool)",
    body.generationConfig.temperature > 1.0, body.generationConfig.temperature);
  check("a non-string prompt is coerced rather than throwing",
    buildGeminiRequestBody(null).contents[0].parts[0].text === "null" ||
    buildGeminiRequestBody(undefined).contents[0].parts[0].text === "");
  check("temperature is overridable", buildGeminiRequestBody("x", { temperature: 0.3 }).generationConfig.temperature === 0.3);
  check("maxOutputTokens is overridable", buildGeminiRequestBody("x", { maxOutputTokens: 50 }).generationConfig.maxOutputTokens === 50);
}

/* ==================================================================== *
 * extractGeminiText
 * ==================================================================== */

console.log("\nextractGeminiText");

{
  const data = { candidates: [{ content: { parts: [{ text: "Idea one. " }, { text: "Idea two." }] } }] };
  check("concatenates multiple parts", extractGeminiText(data) === "Idea one. Idea two.");
}

{
  let threw = null;
  try { extractGeminiText({ candidates: [] }); } catch (e) { threw = e; }
  check("no candidates throws rather than returning empty string", threw !== null);
}

{
  let threw = null;
  try { extractGeminiText({ promptFeedback: { blockReason: "SAFETY" } }); } catch (e) { threw = e; }
  check("a blocked prompt throws a specific, named error", threw !== null && /SAFETY/.test(threw.message), threw?.message);
}

{
  let threw = null;
  try { extractGeminiText({}); } catch (e) { threw = e; }
  check("a completely empty response throws rather than returning undefined text", threw !== null);
}

check("does not throw on null input, and throws the not-usable-text error", (() => {
  try { extractGeminiText(null); return false; } catch { return true; }
})());

/* ==================================================================== *
 * callGemini — network call, stubbed
 * ==================================================================== */

console.log("\ncallGemini");

const realFetch = globalThis.fetch;
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return calls;
}
function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
}

{
  process.env.GEMINI_API_KEY = "secret-abc";
  process.env.GEMINI_MODEL = "gemini-2.5-flash";

  const calls = stubFetch(() =>
    jsonResponse(200, { candidates: [{ content: { parts: [{ text: "A shoe that argues back." }] } }] })
  );

  const result = await callGemini("weird product ideas");

  check("calls the configured model in the URL", calls[0].url.includes("/models/gemini-2.5-flash:generateContent"));
  check("sends the API key as a query param, not a header", calls[0].url.includes("key=secret-abc"));
  check("does not leak the key into request headers", !JSON.stringify(calls[0].init.headers).includes("secret-abc"));
  check("returns the generated text", result.text === "A shoe that argues back.");
  check("reports which model answered", result.model === "gemini-2.5-flash");
}

{
  delete process.env.GEMINI_API_KEY;
  let threw = null;
  try { await callGemini("x"); } catch (e) { threw = e; }
  check("refuses plainly when no key is configured, without attempting a network call", threw !== null && /GEMINI_API_KEY/.test(threw.message));
  process.env.GEMINI_API_KEY = "secret-abc";
}

{
  stubFetch(() => jsonResponse(400, { error: { message: "API key not valid" } }));
  let threw = null;
  try { await callGemini("x"); } catch (e) { threw = e; }
  check("a bad API key surfaces Google's own error message", threw !== null && /API key not valid/.test(threw.message));
  check("the thrown error carries the HTTP status", threw && threw.status === 400);
}

{
  globalThis.fetch = async () => ({ status: 503, ok: false, text: async () => "Service Unavailable" });
  let threw = null;
  try { await callGemini("x"); } catch (e) { threw = e; }
  check("a non-JSON error body does not crash the caller", threw !== null);
}

globalThis.fetch = realFetch;
if (savedKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedKey;
if (savedModel === undefined) delete process.env.GEMINI_MODEL; else process.env.GEMINI_MODEL = savedModel;

/* ------------------------------------------------------------------ */

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
