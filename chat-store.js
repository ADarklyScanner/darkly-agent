/**
 * chat-store.js — durable console chat history.
 *
 * The console previously kept conversation history in a plain in-memory
 * Map (server.js's old `sessions`) and generated a brand-new random
 * session id on every single page load. Two failures stacked on top of
 * each other: a Railway restart or redeploy wiped every conversation
 * outright, and even between restarts, simply reopening the console page
 * lost access to the previous conversation, because there was no way
 * back to its session id. This module fixes the first half (durability);
 * server.js's client-side JS fixes the second half (keeping the same
 * session id across page loads, via localStorage).
 *
 * Kept deliberately simple: one JSON object on the persistent volume
 * (via state.js), sessionId -> {messages, lastActiveAt}, written through
 * on every change. This is a personal single-user console, not a
 * multi-tenant chat product — a handful of live sessions (one browser,
 * one phone) is the realistic ceiling, so a single small file beats an
 * append-only log or a database here.
 */

import { readState, writeState } from "./state.js";

const CHAT_STATE_FILE = "darkly-chat-sessions.json";

// A hard ceiling on how many distinct sessions this file will ever hold,
// regardless of how many different session ids show up over time (a
// cleared localStorage, a stray script hitting /chat with a fresh id
// every time). Without this, an ever-growing set of small session
// entries is still an ever-growing file. Least-recently-active sessions
// are pruned first, never the most recently used ones.
export const MAX_SESSIONS = 20;

// Per-session message cap, matching the trim server.js already did
// before this file existed (history.length > 40 -> drop the oldest 2).
// Centralized here so every write path applies it consistently — the
// pre-existing code only trimmed on the main chat path, silently
// skipping it on the "LIST LEADS" shortcut.
export const MAX_MESSAGES_PER_SESSION = 200;

function emptyStore() {
  return { sessions: {} };
}

function load() {
  const raw = readState(CHAT_STATE_FILE, null);
  if (!raw || typeof raw !== "object" || typeof raw.sessions !== "object" || raw.sessions === null) {
    return emptyStore();
  }
  return raw;
}

let store = load();

function touch(sid) {
  if (!store.sessions[sid]) {
    store.sessions[sid] = { messages: [], lastActiveAt: null };
  }
  store.sessions[sid].lastActiveAt = new Date().toISOString();
  return store.sessions[sid];
}

/** Drop the least-recently-active sessions once the total exceeds
 * MAX_SESSIONS. A session with no lastActiveAt yet (should not normally
 * happen — touch() always sets it) sorts as oldest, so it's pruned first
 * rather than assumed safe to keep. */
function prune() {
  const ids = Object.keys(store.sessions);
  if (ids.length <= MAX_SESSIONS) return;

  const bySid = ids
    .map((sid) => ({ sid, lastActiveAt: store.sessions[sid].lastActiveAt || "" }))
    .sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? -1 : a.lastActiveAt > b.lastActiveAt ? 1 : 0));

  const toDrop = bySid.slice(0, ids.length - MAX_SESSIONS);
  for (const { sid } of toDrop) delete store.sessions[sid];
}

function persist() {
  prune();
  writeState(CHAT_STATE_FILE, store);
}

/**
 * The message array for a session — {role, content} pairs, exactly the
 * shape askClaude()'s caller already builds — creating an empty one if
 * this session id hasn't been seen before. Returns the SAME array
 * reference across calls within this process, so callers push directly
 * onto it (matching the old Map-based API) and then call saveHistory(sid)
 * to persist and apply the size cap.
 */
export function getHistory(sid) {
  return touch(sid).messages;
}

/**
 * Persist a session's current history to disk, trimming it to
 * MAX_MESSAGES_PER_SESSION first if it's grown past that, and pruning
 * old sessions if the total session count has grown past MAX_SESSIONS.
 * Call this after every push onto the array getHistory() returned.
 */
export function saveHistory(sid) {
  const session = touch(sid);
  if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
    session.messages.splice(0, session.messages.length - MAX_MESSAGES_PER_SESSION);
  }
  persist();
}

/** Clear one session's history (a "new conversation" action), leaving
 * every other session untouched. */
export function resetHistory(sid) {
  delete store.sessions[sid];
  persist();
}

/** How many sessions currently exist and how many messages each holds —
 * for a status/debug view, not exposed to the console UI itself. */
export function listSessions() {
  return Object.entries(store.sessions).map(([sid, s]) => ({
    sid,
    messageCount: s.messages.length,
    lastActiveAt: s.lastActiveAt
  }));
}

/** Test seam: forget the in-memory store and re-read from disk, the way
 * a fresh process would on restart. Mirrors state.js's own
 * resetStateDir(). */
export function resetChatStoreForTests() {
  store = load();
}
