/**
 * gemini.js — a deliberately unreliable idea generator.
 *
 * This is NOT a second source of facts and NOT a fallback for when
 * Anthropic is unavailable (see llm-provider.js for that — it exists
 * specifically to guarantee identical rules across providers). This is
 * the opposite: a tool that exists because a model that is frequently
 * wrong is sometimes exactly what you want. Wrong-but-fluent output is
 * useless for research and dangerous for trading, and genuinely useful
 * for "give me twenty weird angles on this, half of them will be nonsense
 * and that's fine." Confidently wrong is a bug in every other tool in
 * this codebase; here it is the feature being asked for.
 *
 * So the one rule that matters is containment: whatever comes back from
 * this must never quietly become an ingredient in a factual answer, a
 * trade rationale, or anything else this agent presents as reliable. It
 * gets a label, every time, and the caller (server.js's system prompt)
 * is responsible for keeping that label attached when it relays the
 * output rather than smoothing it into the agent's own voice.
 *
 * Pure request/response shaping is exported separately from the network
 * call so it can be tested without hitting Google's API.
 */

const DEFAULT_MODEL = "gemini-2.5-flash";

export function geminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

/** The request body Google's generateContent endpoint expects. Pure, testable. */
export function buildGeminiRequestBody(prompt, options = {}) {
  const body = {
    contents: [{ role: "user", parts: [{ text: String(prompt || "") }] }]
  };

  // Deliberately favors variety over caution: this tool's entire value is
  // divergent, unlikely associations. A low temperature here would just
  // produce a worse, hedgier version of what the primary model already
  // does, at which point there is no reason for this tool to exist.
  body.generationConfig = {
    temperature: options.temperature ?? 1.4,
    maxOutputTokens: options.maxOutputTokens ?? 1024
  };

  return body;
}

/** Google's response shape -> plain text, or a clear error if there is none. */
export function extractGeminiText(data) {
  const candidate = data && Array.isArray(data.candidates) ? data.candidates[0] : null;
  const parts = candidate && candidate.content && candidate.content.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p.text || "").join("").trim() : "";

  if (!text) {
    const blockReason = data && data.promptFeedback && data.promptFeedback.blockReason;
    if (blockReason) {
      throw new Error(`Gemini declined to answer (${blockReason}).`);
    }
    throw new Error("Gemini returned no usable text.");
  }

  return text;
}

/**
 * Call Gemini and get back raw, unverified, possibly-wrong text.
 *
 * Throws plainly if GEMINI_API_KEY is not set, rather than silently
 * skipping — a tool the model can call should never fail invisibly.
 */
export async function callGemini(prompt, options = {}) {
  if (!geminiConfigured()) {
    throw new Error("GEMINI_API_KEY is not set, so the Gemini brainstorming tool is unavailable.");
  }

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildGeminiRequestBody(prompt, options))
  });

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Gemini returned a non-JSON response (HTTP ${res.status}): ${raw.slice(0, 300)}`);
  }

  if (!res.ok) {
    const msg = data?.error?.message || raw.slice(0, 300);
    const err = new Error(`Gemini call failed (HTTP ${res.status}): ${msg}`);
    err.status = res.status;
    throw err;
  }

  return { text: extractGeminiText(data), model };
}
