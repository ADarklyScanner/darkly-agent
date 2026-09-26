import { test } from "node:test";
import assert from "node:assert/strict";
import { askAfterHours, isMinorSexualContent, BLOCKED_REPLY, AFTER_HOURS_DEFAULT_MODEL } from "./after-hours.js";

function fakeFetch(reply, status = 200, capture = {}) {
  return async (url, opts) => {
    capture.url = url;
    capture.body = JSON.parse(opts.body);
    capture.headers = opts.headers;
    return { ok: status < 400, status, text: async () => JSON.stringify(status < 400 ? { choices: [{ message: { content: reply } }] } : { error: { message: "nope" } }) };
  };
}

test("ordinary adult talk is not blocked", () => {
  assert.equal(isMinorSexualContent("I'm fat and horny, tell me a dirty joke"), false);
  assert.equal(isMinorSexualContent("let's roleplay an orgy at a Vegas party"), false);
  assert.equal(isMinorSexualContent("hey baby, you look sexy tonight"), false);
  assert.equal(isMinorSexualContent("my kids are at school today"), false);
});

test("minor + sexual content is blocked", () => {
  assert.equal(isMinorSexualContent("sex with a 15 year old"), true);
  assert.equal(isMinorSexualContent("naked schoolgirl roleplay"), true);
  assert.equal(isMinorSexualContent("a teen and an orgy"), true);
});

test("blocked input never reaches the model", async () => {
  process.env.OPENROUTER_API_KEY = "k";
  let called = false;
  const r = await askAfterHours([], "sex with a 14 year old", { fetchImpl: async () => { called = true; } });
  assert.equal(r.text, BLOCKED_REPLY);
  assert.equal(called, false);
});

test("blocked output is replaced", async () => {
  process.env.OPENROUTER_API_KEY = "k";
  const r = await askAfterHours([], "tell me a story", { fetchImpl: fakeFetch("the naked 12 year old...") });
  assert.equal(r.text, BLOCKED_REPLY);
});

test("sends system prompt, plain history, default model, no tools", async () => {
  process.env.OPENROUTER_API_KEY = "k";
  delete process.env.AFTER_HOURS_MODEL;
  const cap = {};
  const history = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hey you" },
    { role: "assistant", content: [{ type: "tool_use", id: "x" }] }
  ];
  const r = await askAfterHours(history, "what's up", { fetchImpl: fakeFetch("not much, you?", 200, cap) });
  assert.equal(r.text, "not much, you?");
  assert.equal(cap.body.model, AFTER_HOURS_DEFAULT_MODEL);
  assert.equal(cap.body.tools, undefined);
  assert.equal(cap.body.messages[0].role, "system");
  assert.equal(cap.body.messages.length, 4);
  assert.equal(cap.headers.authorization, "Bearer k");
});

test("missing key gives a clear error", async () => {
  delete process.env.OPENROUTER_API_KEY;
  await assert.rejects(() => askAfterHours([], "hi"), /OpenRouter key/);
});

test("provider error surfaces", async () => {
  process.env.OPENROUTER_API_KEY = "k";
  await assert.rejects(() => askAfterHours([], "hi", { fetchImpl: fakeFetch("", 429) }), /HTTP 429/);
});
