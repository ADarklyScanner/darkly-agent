/**
 * Tests for chat-store.js — run with: node chat-store.test.mjs
 *
 * The failure mode this exists to catch: a conversation that looks like
 * it survived a restart but didn't (isolate with DARKLY_STATE_DIR, same
 * lesson learned the hard way in autotrader.test.mjs — state.js checks a
 * mounted /data volume BEFORE $HOME, so only DARKLY_STATE_DIR reliably
 * isolates a test on a machine that happens to have a writable /data);
 * one session's history leaking into or clobbering another's; and
 * unbounded growth (either message count per session, or total sessions)
 * since this file has no other size limit of its own.
 */

import os from "node:os";
import path from "node:path";
process.env.DARKLY_STATE_DIR = path.join(os.tmpdir(), `darkly-chatstore-test-${process.pid}`);

const {
  getHistory,
  saveHistory,
  resetHistory,
  listSessions,
  resetChatStoreForTests,
  MAX_SESSIONS,
  MAX_MESSAGES_PER_SESSION
} = await import("./chat-store.js");

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

/* ------------------------------------------------------------------ */

console.log("\ngetHistory — basic session lifecycle");

check("a new session id starts with an empty array", getHistory("s1").length === 0);

{
  const h = getHistory("s1");
  h.push({ role: "user", content: "hi" });
  h.push({ role: "assistant", content: "hello" });
  check("pushing onto the returned array is visible on the next call (same reference)",
    getHistory("s1").length === 2);
}

console.log("\nsessions are isolated from each other");

{
  getHistory("s2").push({ role: "user", content: "different session" });
  saveHistory("s2");
  check("s1 is unaffected by writes to s2", getHistory("s1").length === 2);
  check("s2 has exactly its own message", getHistory("s2").length === 1 && getHistory("s2")[0].content === "different session");
}

console.log("\nsaveHistory — persistence across a simulated restart");

{
  saveHistory("s1");
  resetChatStoreForTests(); // simulate a fresh process re-reading from disk
  const restored = getHistory("s1");
  check("history survives a simulated restart", restored.length === 2, JSON.stringify(restored));
  check("message content survives intact", restored[0].content === "hi" && restored[1].content === "hello");
  check("the other session also survives", getHistory("s2").length === 1);
}

console.log("\nsaveHistory — per-session message cap");

{
  resetHistory("cap-test");
  const h = getHistory("cap-test");
  for (let i = 0; i < MAX_MESSAGES_PER_SESSION + 15; i++) {
    h.push({ role: i % 2 === 0 ? "user" : "assistant", content: `msg-${i}` });
  }
  saveHistory("cap-test");

  const after = getHistory("cap-test");
  check(`trims down to at most ${MAX_MESSAGES_PER_SESSION} messages`, after.length === MAX_MESSAGES_PER_SESSION, after.length);
  check("keeps the MOST RECENT messages, not the oldest",
    after[after.length - 1].content === `msg-${MAX_MESSAGES_PER_SESSION + 14}`, after[after.length - 1]);
}

console.log("\nresetHistory — clears one session, leaves others alone");

{
  resetHistory("s2");
  check("the reset session is empty afterward", getHistory("s2").length === 0);
  check("an unrelated session (s1) is untouched by resetting s2", getHistory("s1").length === 2);
}

console.log("\nsession count cap (MAX_SESSIONS) — least-recently-active pruned first");

{
  // Start clean so this section's counting isn't affected by sessions
  // created earlier in this file.
  resetChatStoreForTests();
  for (const sid of ["s1", "s2", "cap-test"]) resetHistory(sid);

  const ids = [];
  for (let i = 0; i < MAX_SESSIONS + 5; i++) {
    const sid = `session-${i}`;
    ids.push(sid);
    getHistory(sid).push({ role: "user", content: `hello from ${sid}` });
    saveHistory(sid);
  }

  const sessions = listSessions();
  check(`total sessions never exceeds MAX_SESSIONS (${MAX_SESSIONS})`,
    sessions.length === MAX_SESSIONS, sessions.length);

  const survivingIds = new Set(sessions.map((s) => s.sid));
  const oldestFive = ids.slice(0, 5);
  const newestFive = ids.slice(-5);
  check("the earliest-created (least-recently-active) sessions were pruned",
    oldestFive.every((sid) => !survivingIds.has(sid)), [...survivingIds]);
  check("the most recently active sessions survive",
    newestFive.every((sid) => survivingIds.has(sid)), [...survivingIds]);

  // Re-touching an old survivor should protect it from the next round of
  // pruning even though it was created early.
  const stillAlive = ids.find((sid) => survivingIds.has(sid) && !newestFive.includes(sid));
  if (stillAlive) {
    getHistory(stillAlive).push({ role: "user", content: "still here" });
    saveHistory(stillAlive);
    getHistory("one-more-new-session").push({ role: "user", content: "x" });
    saveHistory("one-more-new-session");
    check("touching an existing session refreshes its recency and protects it from pruning",
      listSessions().some((s) => s.sid === stillAlive));
  } else {
    check("(skipped: no mid-range survivor to re-touch in this run)", true);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
