/**
 * Tests for llm-provider.js — run with: node llm-provider.test.mjs
 *
 * The property that matters most here is not "the translation works" in
 * the abstract, it's "nothing is lost or invented crossing the boundary":
 * every tool call Anthropic would have seen still reaches the fallback
 * model with the same name and arguments, and every tool result the
 * fallback model asked for makes it back in a shape the rest of the loop
 * already knows how to handle. A translation bug here reads as the model
 * mysteriously forgetting a tool call ever happened.
 */

import {
  isQuotaOrRateLimitError,
  toolsToOpenAI,
  canonicalMessagesToOpenAI,
  openAIMessageToCanonicalContent,
  fallbackConfigured,
  callFallbackModel,
  fetchWithTimeout
} from "./llm-provider.js";

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

/* ==================================================================== *
 * isQuotaOrRateLimitError
 * ==================================================================== */

console.log("\nisQuotaOrRateLimitError");

check("429 status triggers fallback", isQuotaOrRateLimitError({ status: 429 }));
check("529 (Anthropic overloaded) triggers fallback", isQuotaOrRateLimitError({ status: 529 }));
check("string status codes are coerced", isQuotaOrRateLimitError({ status: "429" }));
check("credit-balance message triggers fallback even with a 400 status",
  isQuotaOrRateLimitError({ status: 400, message: "Your credit balance is too low to access the API." }));
check("insufficient_quota message triggers fallback",
  isQuotaOrRateLimitError({ message: "Error: insufficient_quota" }));
check("nested error.message shape is read too",
  isQuotaOrRateLimitError({ error: { message: "rate limit exceeded, please retry" } }));
check("doubly-nested error.error.message shape is read too",
  isQuotaOrRateLimitError({ error: { error: { message: "You have exceeded your current quota" } } }));

check("a genuine 401 (bad key) does NOT trigger fallback",
  !isQuotaOrRateLimitError({ status: 401, message: "invalid x-api-key" }));
check("a genuine 400 (malformed request) does NOT trigger fallback",
  !isQuotaOrRateLimitError({ status: 400, message: "messages: array too long" }));
check("a generic 500 does NOT trigger fallback",
  !isQuotaOrRateLimitError({ status: 500, message: "internal server error" }));
check("null/undefined error does not throw and is not a fallback trigger",
  !isQuotaOrRateLimitError(null) && !isQuotaOrRateLimitError(undefined));

/* ==================================================================== *
 * toolsToOpenAI
 * ==================================================================== */

console.log("\ntoolsToOpenAI");

{
  const claudeTools = [
    { name: "get_quote", description: "Live price.", input_schema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } }
  ];
  const openAiTools = toolsToOpenAI(claudeTools);

  check("wraps each tool as a function-type entry", openAiTools[0].type === "function");
  check("keeps the tool name", openAiTools[0].function.name === "get_quote");
  check("keeps the description", openAiTools[0].function.description === "Live price.");
  check("carries the input schema through as parameters",
    openAiTools[0].function.parameters.required[0] === "symbol");
  check("an empty/missing list produces an empty array", toolsToOpenAI(undefined).length === 0);
  check("a tool with no input_schema still gets a valid parameters object",
    toolsToOpenAI([{ name: "x", description: "d" }])[0].function.parameters.type === "object");
}

/* ==================================================================== *
 * canonicalMessagesToOpenAI
 * ==================================================================== */

console.log("\ncanonicalMessagesToOpenAI (outbound)");

{
  const canonical = [
    { role: "user", content: "What's my equity?" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "call_1", name: "get_account", input: { verbose: true } }
      ]
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: JSON.stringify({ equity: 100000 }) }
      ]
    }
  ];

  const openAi = canonicalMessagesToOpenAI(canonical);

  check("plain string user message passes through unchanged", openAi[0].role === "user" && openAi[0].content === "What's my equity?");
  check("assistant text+tool_use becomes one assistant message", openAi[1].role === "assistant");
  check("assistant message keeps its text", openAi[1].content === "Let me check.");
  check("assistant message carries exactly one tool_call", openAi[1].tool_calls.length === 1);
  check("tool_call id is preserved (this is what links the result back)", openAi[1].tool_calls[0].id === "call_1");
  check("tool_call name is preserved", openAi[1].tool_calls[0].function.name === "get_account");
  check("tool_call arguments are a JSON STRING, not an object (OpenAI wire format)",
    typeof openAi[1].tool_calls[0].function.arguments === "string");
  check("tool_call arguments round-trip to the original input",
    JSON.parse(openAi[1].tool_calls[0].function.arguments).verbose === true);

  check("a grouped tool_result block becomes its own role:tool message", openAi[2].role === "tool");
  check("the tool message's tool_call_id matches the assistant's tool_call id",
    openAi[2].tool_call_id === "call_1");
  check("the tool message content survives as a string",
    JSON.parse(openAi[2].content).equity === 100000);
}

{
  // Multiple tool calls in one assistant turn, multiple results in the
  // following user turn — the common case in a real multi-tool round.
  const canonical = [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "a", name: "get_positions", input: {} },
        { type: "tool_use", id: "b", name: "get_quote", input: { symbol: "AAPL" } }
      ]
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "[]" },
        { type: "tool_result", tool_use_id: "b", content: "{\"price\":230}" }
      ]
    }
  ];
  const openAi = canonicalMessagesToOpenAI(canonical);

  check("an assistant turn with no text has null content, not an empty string",
    openAi[0].content === null);
  check("both tool calls survive in order", openAi[0].tool_calls.map((t) => t.id).join(",") === "a,b");
  check("two grouped results expand into two separate tool messages", openAi.length === 3);
  check("expanded tool messages keep their own ids in order",
    openAi[1].tool_call_id === "a" && openAi[2].tool_call_id === "b");
}

check("an empty conversation produces an empty array", canonicalMessagesToOpenAI([]).length === 0);
check("undefined input does not throw", canonicalMessagesToOpenAI(undefined).length === 0);

/* ==================================================================== *
 * openAIMessageToCanonicalContent (inbound)
 * ==================================================================== */

console.log("\nopenAIMessageToCanonicalContent (inbound)");

{
  const msg = { role: "assistant", content: "Here's what I found.", tool_calls: null };
  const blocks = openAIMessageToCanonicalContent(msg);
  check("a plain text reply becomes a single text block", blocks.length === 1 && blocks[0].type === "text");
  check("text content is preserved exactly", blocks[0].text === "Here's what I found.");
}

{
  const msg = {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_9", function: { name: "get_quote", arguments: JSON.stringify({ symbol: "MSFT" }) } }]
  };
  const blocks = openAIMessageToCanonicalContent(msg);
  check("no text content produces no text block", !blocks.some((b) => b.type === "text"));
  check("a tool call becomes a tool_use block", blocks[0].type === "tool_use");
  check("tool_use id round-trips (needed to match the eventual tool_result back to it)", blocks[0].id === "call_9");
  check("tool_use name round-trips", blocks[0].name === "get_quote");
  check("tool_use arguments are parsed back into a real object", blocks[0].input.symbol === "MSFT");
  check("a clean parse carries no error flag", !("_argumentParseError" in blocks[0]));
}

{
  // A fallback model hallucinating malformed JSON arguments is a real risk
  // with smaller models — this must not throw, and must not silently drop
  // the tool call or invent a plausible-looking substitute.
  const msg = {
    role: "assistant",
    tool_calls: [{ id: "call_bad", function: { name: "place_order", arguments: "{symbol: AAPL, qty: 10" } }]
  };
  const blocks = openAIMessageToCanonicalContent(msg);
  check("malformed JSON arguments do not throw", blocks.length === 1);
  check("a parse failure is flagged rather than guessed at", typeof blocks[0]._argumentParseError === "string");
  check("input falls back to an empty object rather than partial/invented data",
    Object.keys(blocks[0].input).length === 0);
  check("the tool name is still preserved even when arguments are broken", blocks[0].name === "place_order");
}

check("a message with neither content nor tool_calls produces no blocks",
  openAIMessageToCanonicalContent({ role: "assistant" }).length === 0);

/* ==================================================================== *
 * Round-trip: canonical -> OpenAI -> canonical should be lossless for
 * what the tool-execution loop actually reads (name, id, input).
 * ==================================================================== */

console.log("\nRound-trip fidelity");

{
  const original = [
    { type: "text", text: "Checking your account." },
    { type: "tool_use", id: "rt_1", name: "get_account", input: { detail: "full" } }
  ];

  const asOpenAiAssistant = canonicalMessagesToOpenAI([{ role: "assistant", content: original }])[0];
  const roundTripped = openAIMessageToCanonicalContent(asOpenAiAssistant);

  const tu = roundTripped.find((b) => b.type === "tool_use");
  check("tool_use id survives the round trip", tu.id === "rt_1");
  check("tool_use name survives the round trip", tu.name === "get_account");
  check("tool_use input survives the round trip", tu.input.detail === "full");
  check("text survives the round trip", roundTripped.find((b) => b.type === "text").text === "Checking your account.");
}

/* ==================================================================== *
 * fallbackConfigured
 * ==================================================================== */

console.log("\nfallbackConfigured");

{
  const savedBase = process.env.LITELLM_BASE_URL;
  const savedModel = process.env.LITELLM_MODEL;

  delete process.env.LITELLM_BASE_URL;
  delete process.env.LITELLM_MODEL;
  check("false when neither var is set", fallbackConfigured() === false);

  process.env.LITELLM_BASE_URL = "https://example.invalid";
  check("false when only the base URL is set", fallbackConfigured() === false);

  process.env.LITELLM_MODEL = "groq/llama-3.3-70b";
  check("true once both are set", fallbackConfigured() === true);

  if (savedBase === undefined) delete process.env.LITELLM_BASE_URL; else process.env.LITELLM_BASE_URL = savedBase;
  if (savedModel === undefined) delete process.env.LITELLM_MODEL; else process.env.LITELLM_MODEL = savedModel;
}

/* ==================================================================== *
 * callFallbackModel — the one network call, exercised with a stubbed
 * fetch so URL construction, auth, and error handling are covered
 * without ever making a real request.
 * ==================================================================== */

console.log("\ncallFallbackModel");

const realFetch = globalThis.fetch;
const savedEnv = {
  LITELLM_BASE_URL: process.env.LITELLM_BASE_URL,
  LITELLM_MODEL: process.env.LITELLM_MODEL,
  LITELLM_API_KEY: process.env.LITELLM_API_KEY
};

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
  process.env.LITELLM_BASE_URL = "https://proxy.example.com/v1";
  process.env.LITELLM_MODEL = "groq/llama-3.3-70b";
  process.env.LITELLM_API_KEY = "test-key-123";

  const calls = stubFetch(() =>
    jsonResponse(200, {
      model: "groq/llama-3.3-70b",
      choices: [{ message: { role: "assistant", content: "The account has $100,000 equity." } }]
    })
  );

  const result = await callFallbackModel({
    system: "You are Darkly Agent.",
    tools: [{ name: "get_account", description: "d", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "What's my equity?" }]
  });

  check("appends /chat/completions to a bare base URL", calls[0].url === "https://proxy.example.com/v1/chat/completions", calls[0].url);
  check("sends a bearer token from LITELLM_API_KEY", calls[0].init.headers.authorization === "Bearer test-key-123");
  check("sends the configured model", JSON.parse(calls[0].init.body).model === "groq/llama-3.3-70b");
  check("sends the system prompt as the first message", JSON.parse(calls[0].init.body).messages[0].role === "system");
  check("translates tools into OpenAI function format", JSON.parse(calls[0].init.body).tools[0].type === "function");
  check("returns canonical-shaped content", result.content[0].type === "text" && result.content[0].text.includes("100,000"));
  check("reports which model actually answered", result.model === "groq/llama-3.3-70b");
}

{
  process.env.LITELLM_BASE_URL = "https://proxy.example.com/v1/chat/completions";
  stubFetch(() => jsonResponse(200, { choices: [{ message: { content: "ok" } }] }));
  const result = await callFallbackModel({ system: "s", tools: [], messages: [] });
  check("does not double-append /chat/completions if the base URL already has it", result.content[0].text === "ok");
}

{
  delete process.env.LITELLM_API_KEY;
  const calls = stubFetch(() => jsonResponse(200, { choices: [{ message: { content: "ok" } }] }));
  await callFallbackModel({ system: "s", tools: [], messages: [] });
  check("no authorization header is sent when no key is configured", !("authorization" in calls[0].init.headers));
}

{
  stubFetch(() => jsonResponse(429, { error: { message: "rate limited" } }));
  let threw = null;
  try {
    await callFallbackModel({ system: "s", tools: [], messages: [] });
  } catch (e) {
    threw = e;
  }
  check("a non-2xx response throws rather than returning a fake success", threw !== null);
  check("the thrown error carries the HTTP status", threw && threw.status === 429);
  check("the thrown error message includes the server's own error message", threw && /rate limited/.test(threw.message));
}

{
  globalThis.fetch = async () => ({ status: 502, ok: false, text: async () => "<html>Bad Gateway</html>" });
  let threw = null;
  try {
    await callFallbackModel({ system: "s", tools: [], messages: [] });
  } catch (e) {
    threw = e;
  }
  check("a non-JSON error body (e.g. a proxy's HTML error page) does not crash the caller", threw !== null);
}

{
  stubFetch(() => jsonResponse(200, { choices: [] }));
  let threw = null;
  try {
    await callFallbackModel({ system: "s", tools: [], messages: [] });
  } catch (e) {
    threw = e;
  }
  check("an empty choices array is treated as a failure, not a silent empty reply", threw !== null);
}

globalThis.fetch = realFetch;
for (const [k, v] of Object.entries(savedEnv)) {
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
}

/* ------------------------------------------------------------------ */

console.log("\nfetchWithTimeout: a stalled fallback call must not hang forever");

{
  globalThis.fetch = (url, options = {}) => new Promise((resolve, reject) => {
    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        reject(err);
      });
    }
  });

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
