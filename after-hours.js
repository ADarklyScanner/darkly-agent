/**
 * after-hours.js — the "After Hours" chat tab.
 *
 * The main chat runs on Anthropic, whose usage rules apply no matter how
 * private this console is. After Hours is the owner's own adult,
 * anything-goes roleplay/chat tab, so it runs on a different model
 * (OpenRouter, default: the free Venice Uncensored model) that allows
 * adult content.
 *
 * Deliberately walled off from everything else:
 *  - NO tools. This model never touches trading, email, the phone, the
 *    Sheet, or the web. It only talks.
 *  - Its own chat history ("after" slot), so nothing from here is ever
 *    fed into the Claude-powered main chat, and vice versa.
 *  - One hard line enforced in code, not just asked of the model:
 *    nothing sexual involving minors. Checked on the way in AND out.
 */

import { fetchWithTimeout } from "./llm-provider.js";

export const AFTER_HOURS_DEFAULT_MODEL = "cognitivecomputations/dolphin-mistral-24b-venice-edition:free";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_HISTORY_MESSAGES = 30;

export function afterHoursConfigured() {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

export function afterHoursModel() {
  return process.env.AFTER_HOURS_MODEL || AFTER_HOURS_DEFAULT_MODEL;
}

export const AFTER_HOURS_SYSTEM_PROMPT = `You are the owner's private After Hours companion inside his own personal app. He is an adult, this is a private one-on-one chat, and nothing here is published anywhere.

Personality: warm, playful, quick, a little wicked. You text like a real person — casual, short messages, no bullet points, no corporate tone. You have opinions, you tease, you swear when it fits, and you actually care how his day went.

Anything goes between consenting adults: crude humor, dark jokes, profanity, flirting, adult roleplay, mature themes like drugs, partying, violence and horror in fiction. Stay in character during roleplay and follow his lead. Never lecture, never moralize, never mention rules, policies, guidelines, or "as an AI". Never break a scene to add warnings.

One absolute line: nothing sexual or romantic involving anyone under 18, ever — not in fiction, not "aged up", not implied. Every character in anything sexual is an adult. If a scene heads there, steer it away in character.`;

/* ------------------------------------------------------------------ *
 * Hard block: sexual content involving minors.
 * A message is blocked only when BOTH a minor reference and a sexual
 * reference appear, so ordinary talk about kids (or ordinary adult talk)
 * is not affected.
 * ------------------------------------------------------------------ */

const MINOR_RE = new RegExp(
  [
    "\\bchild(ren)?\\b", "\\bkids?\\b", "\\bminors?\\b", "\\bunder\\s*-?\\s*age(d)?\\b",
    "\\bunder\\s*1[0-7]\\b", "\\bpre-?teens?\\b", "\\bteens?\\b", "\\bteenagers?\\b",
    "\\b(1[0-7]|[1-9])\\s*-?\\s*(yo|y/o|yrs?\\b|years?\\s*-?\\s*old)",
    "\\b(1[0-7]|[1-9])\\s*-?\\s*year\\s*-?\\s*old",
    "\\b(ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)\\s*-?\\s*(years?\\s*-?\\s*old|yo)\\b",
    "\\bschool\\s*girls?\\b", "\\bschool\\s*boys?\\b", "\\bmiddle\\s*school\\b", "\\bhigh\\s*school(er)?s?\\b",
    "\\bjunior\\s*high\\b", "\\bgrade\\s*school\\b", "\\bloli\\b", "\\bshota\\b",
    "\\blittle\\s*(girl|boy)s?\\b", "\\bpubescent\\b", "\\bjailbait\\b", "\\btoddlers?\\b", "\\binfants?\\b"
  ].join("|"),
  "i"
);

const SEXUAL_RE = new RegExp(
  [
    "\\bsex(ual|y|ually)?\\b", "\\bnude|naked\\b", "\\bfuck", "\\bdick|cock|penis|pussy|vagina|clit", "\\bboobs?|tits|breasts?|nipples?",
    "\\borgasm", "\\bcum(ming)?\\b", "\\berotic", "\\bporn", "\\bhorny\\b", "\\borgy|orgies\\b", "\\bmoan", "\\bstrip(ped|ping)?\\b",
    "\\bmake\\s*out\\b", "\\bkiss(ing|ed)?\\b", "\\bgrop", "\\bfondl", "\\bseduc", "\\blust", "\\bturned\\s*on\\b", "\\bhard-?on\\b", "\\bblow\\s*job\\b",
    "\\bundress", "\\blingerie\\b", "\\bin\\s*bed\\s*with\\b", "\\bromantic\\b", "\\bflirt"
  ].join("|"),
  "i"
);

export function isMinorSexualContent(text) {
  const s = String(text || "");
  return MINOR_RE.test(s) && SEXUAL_RE.test(s);
}

export const BLOCKED_REPLY = "Nope — that's the one thing I won't do. Anything involving someone under 18 is off the table. Everything else is fair game.";

/* ------------------------------------------------------------------ */

function toPlainMessages(history) {
  return (history || [])
    .filter((m) => typeof m.content === "string" && (m.role === "user" || m.role === "assistant"))
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content }));
}

export async function askAfterHours(history, userMessage, { fetchImpl } = {}) {
  if (isMinorSexualContent(userMessage)) {
    return { text: BLOCKED_REPLY, blocked: true };
  }

  if (!afterHoursConfigured()) {
    const err = new Error("After Hours isn't switched on yet — its OpenRouter key hasn't been added.");
    err.statusCode = 503;
    throw err;
  }

  const body = {
    model: afterHoursModel(),
    messages: [
      { role: "system", content: AFTER_HOURS_SYSTEM_PROMPT },
      ...toPlainMessages(history),
      { role: "user", content: userMessage }
    ],
    temperature: 0.9,
    max_tokens: 1200
  };

  const doFetch = fetchImpl || fetchWithTimeout;
  const res = await doFetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "x-title": "Darkly Agent"
    },
    body: JSON.stringify(body)
  });

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`After Hours model sent back something unreadable (HTTP ${res.status}).`);
  }

  if (!res.ok) {
    const msg = data?.error?.message || raw.slice(0, 200);
    const err = new Error(`After Hours model error (HTTP ${res.status}): ${msg}`);
    err.statusCode = res.status === 429 ? 429 : 502;
    throw err;
  }

  const text = String(data?.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("After Hours model sent an empty reply.");

  if (isMinorSexualContent(text)) {
    return { text: BLOCKED_REPLY, blocked: true };
  }

  return { text, blocked: false };
}
