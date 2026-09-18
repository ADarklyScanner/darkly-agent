/**
 * llm-provider.js — talk to a second model without talking to it differently.
 *
 * The chat agent runs on Anthropic. When Anthropic's credits or rate limit
 * are exhausted, the honest options are: stop and say so, or fail over to
 * another provider WITHOUT changing what the model is told or allowed to
 * do. Everything short of that is a silent downgrade wearing the costume
 * of uptime — a fallback model with a thinner system prompt or a looser
 * tool-calling contract will sound just as confident while following none
 * of the same rules, which is worse than an error message.
 *
 * So the rule this file exists to enforce: the SAME system prompt and the
 * SAME tool list travel to whichever provider actually answers. Only the
 * wire format changes. server.js keeps one canonical message shape
 * (Anthropic's content-block format) for the whole conversation history;
 * this file's only job is translating at the two edges — building an
 * OpenAI-style request from that canonical form, and translating an
 * OpenAI-style response back into it — so the surrounding tool-execution
 * loop never needs to know which provider produced a given turn.
 *
 * Pure functions only, except callFallbackModel(), which is the one
 * network call and is kept small and separately testable-by-mocking.
 */

/* ------------------------------------------------------------------ *
 * 1. Deciding whether a failure is worth failing over for
 * ------------------------------------------------------------------ */

/**
 * Is this the shape of "out of credits / rate limited / provider
 * overloaded", as opposed to a real bug?
 *
 * Deliberately narrow. A malformed request, a bad API key, or a genuine
 * server error in OUR OWN tool-calling code should surface as an error,
 * not get quietly swallowed by a fallback that will just guess instead.
 * Falling back on everything turns every bug into a worse, harder-to-spot
 * bug: the symptom becomes "answers are subtly wrong" instead of "chat is
 * down", and the latter gets fixed same day while the former can run for
 * weeks.
 */
export function isQuotaOrRateLimitError(error) {
  if (!error) return false;

  const status = Number(error.status ?? error.statusCode ?? error.response?.status);
  if (status === 429 || status === 529) return true;

  const message = String(
    error.message || error.error?.message || error.error?.error?.message || ""
  ).toLowerCase();

  return (
    /credit balance/.test(message) ||
    /insufficient_quota/.test(message) ||
    /quota exceeded/.test(message) ||
    /exceeded.*quota/.test(message) ||
    /rate limit/.test(message) ||
    /overloaded/.test(message)
  );
}

/* ------------------------------------------------------------------ *
 * 2. Outbound translation: canonical (Anthropic-shaped) -> OpenAI-shaped
 * ------------------------------------------------------------------ */

/** CLAUDE_TOOLS (Anthropic tool schema) -> OpenAI function-calling schema. */
export function toolsToOpenAI(tools) {
  return (tools || []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema || { type: "object", properties: {} }
    }
  }));
}

/**
 * The conversation so far, in server.js's canonical shape, -> OpenAI chat
 * messages. Canonical shape is exactly what gets pushed onto `messages`
 * in askClaude():
 *   { role: "user", content: "plain string" }
 *   { role: "assistant", content: [ {type:"text",text}, {type:"tool_use",id,name,input}, ... ] }
 *   { role: "user", content: [ {type:"tool_result", tool_use_id, content, is_error?}, ... ] }
 *
 * OpenAI has no grouped "tool result" message — each result is its own
 * { role: "tool", tool_call_id, content } message, so a single canonical
 * user-turn full of tool results expands into several OpenAI messages.
 */
export function canonicalMessagesToOpenAI(messages) {
  const out = [];

  for (const m of messages || []) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }

    if (!Array.isArray(m.content)) continue;

    if (m.role === "assistant") {
      const text = m.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const toolUses = m.content.filter((b) => b.type === "tool_use");

      const assistantMsg = { role: "assistant", content: text || null };
      if (toolUses.length > 0) {
        assistantMsg.tool_calls = toolUses.map((tu) => ({
          id: tu.id,
          type: "function",
          function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) }
        }));
      }
      out.push(assistantMsg);
      continue;
    }

    // role === "user" carrying tool_result blocks (and/or stray text blocks)
    for (const block of m.content) {
      if (block.type === "tool_result") {
        out.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content:
            typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "")
        });
      } else if (block.type === "text") {
        out.push({ role: "user", content: block.text });
      }
    }
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * 3. Inbound translation: OpenAI-shaped response -> canonical content
 * ------------------------------------------------------------------ */

/**
 * An OpenAI-style response `message` -> Anthropic-style content blocks,
 * so the caller can push { role: "assistant", content: <this> } onto the
 * SAME messages array Anthropic responses go into, and the rest of the
 * tool-execution loop stays provider-blind.
 *
 * A tool call whose arguments are not valid JSON is not discarded or
 * guessed at — it comes back as a tool_use block carrying
 * `_argumentParseError`, so the caller can feed the model back a proper
 * tool_result error and let it retry, the same way a live API failure on
 * that one tool would be handled.
 */
export function openAIMessageToCanonicalContent(message) {
  const blocks = [];
  const content = message && message.content;
  if (content) blocks.push({ type: "text", text: content });

  for (const tc of (message && message.tool_calls) || []) {
    const fn = tc.function || {};
    let input = {};
    let parseError = null;
    try {
      input = fn.arguments ? JSON.parse(fn.arguments) : {};
    } catch (e) {
      parseError = e.message;
    }

    const block = { type: "tool_use", id: tc.id, name: fn.name, input };
    if (parseError) block._argumentParseError = parseError;
    blocks.push(block);
  }

  return blocks;
}

/* ------------------------------------------------------------------ *
 * 4. The one network call
 * ------------------------------------------------------------------ */

export function fallbackConfigured() {
  return Boolean(process.env.LITELLM_BASE_URL && process.env.LITELLM_MODEL);
}

function fallbackUrl() {
  const base = String(process.env.LITELLM_BASE_URL || "").replace(/\/+$/, "");
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

/**
 * fetch(), but bounded. This is the one network call in the file, used
 * only when Anthropic itself is failing over (rate-limited or out of
 * credits) — which makes an unbounded hang here worse than usual: it
 * would mean the ONE path meant to keep the agent answering during an
 * outage is itself the thing left hanging. A generous timeout, since a
 * full chat completion with a large tool list can legitimately take a
 * while. Same AbortController pattern already used in
 * sources.js/web-read.js/toolkit.js.
 */
const DEFAULT_TIMEOUT_MS = 60000;

export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`Fallback model timed out after ${timeoutMs}ms.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call the configured fallback (a LiteLLM-proxied endpoint, or anything
 * else that speaks the OpenAI chat-completions + tools wire format) with
 * the SAME system prompt and SAME tools Anthropic would have received.
 *
 * Returns { content } in canonical (Anthropic-shaped) form, so the caller
 * can treat it exactly like an Anthropic response from here on.
 *
 * Auth: sends whatever LITELLM_API_KEY holds, if set. Not every LiteLLM
 * deployment requires a key (a private proxy may not), so its absence is
 * not treated as a configuration error here — but if the fallback needs
 * one and it is not set, the request will fail and that failure is
 * surfaced rather than silently retried a third way.
 */
export async function callFallbackModel({ system, tools, messages }) {
  const apiKey = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || "";

  const body = {
    model: process.env.LITELLM_MODEL,
    messages: [{ role: "system", content: system }, ...canonicalMessagesToOpenAI(messages)],
    tools: toolsToOpenAI(tools)
  };

  const res = await fetchWithTimeout(fallbackUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Fallback model returned a non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  if (!res.ok) {
    const msg = data?.error?.message || data?.error || text.slice(0, 300);
    const err = new Error(`Fallback model call failed (HTTP ${res.status}): ${msg}`);
    err.status = res.status;
    throw err;
  }

  const choice = data.choices && data.choices[0];
  if (!choice || !choice.message) {
    throw new Error("Fallback model response had no choices/message to read.");
  }

  return {
    content: openAIMessageToCanonicalContent(choice.message),
    model: data.model || process.env.LITELLM_MODEL
  };
}
