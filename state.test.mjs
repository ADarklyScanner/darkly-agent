/**
 * Tests for state.js — run with: node state.test.mjs
 *
 * Two things have to be true for this system's memory to be worth having:
 * a write that is interrupted must not destroy what was already there, and
 * history must be able to grow for years without the hot path getting
 * slower. Both are asserted here, the second with a file large enough that
 * a naive implementation would be visibly slow.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH = path.join(os.tmpdir(), "darkly-state-test");
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
process.env.DARKLY_STATE_DIR = SCRATCH;

const {
  stateDir,
  statePath,
  stateInfo,
  readState,
  writeState,
  appendLine,
  tailLines,
  archiveInfo,
  resetStateDir
} = await import("./state.js");

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

console.log("\nDirectory resolution");

check("uses the configured directory", stateDir() === SCRATCH, stateDir());
check("reports durability honestly", stateInfo().durable === true, JSON.stringify(stateInfo()));
check("path joins onto the state dir", statePath("x.json") === path.join(SCRATCH, "x.json"));

/* ------------------------------------------------------------------ */

console.log("\nRead and write");

check("missing file returns the fallback", readState("nope.json", { a: 1 }).a === 1);
check("write then read round-trips", writeState("t.json", { n: 42 }) && readState("t.json", null).n === 42);

fs.writeFileSync(statePath("corrupt.json"), "{ this is not json");
check("corrupt file returns the fallback, does not throw",
  readState("corrupt.json", { safe: true }).safe === true);

fs.writeFileSync(statePath("null.json"), "null");
check("a file containing null returns the fallback",
  readState("null.json", { safe: true }).safe === true);

// The dangerous case: a truncated write must not read back as "no trades".
writeState("trades.json", [{ id: 1 }, { id: 2 }]);
const before = readState("trades.json", []);
check("writes are atomic (no .tmp left behind)",
  !fs.readdirSync(SCRATCH).some((f) => f.includes(".tmp-")),
  fs.readdirSync(SCRATCH).join(","));
check("existing data survives a subsequent write", before.length === 2);

/* ------------------------------------------------------------------ */

console.log("\nAppend-only archive");

check("tail of a missing archive is empty", tailLines("missing.jsonl", 10).length === 0);

for (let i = 1; i <= 5; i++) appendLine("small.jsonl", { i });
const small = tailLines("small.jsonl", 10);
check("reads back everything when asked for more than exists", small.length === 5);
check("order is preserved oldest-first", small[0].i === 1 && small[4].i === 5);
check("tail respects the limit", tailLines("small.jsonl", 2).map((r) => r.i).join(",") === "4,5");

// Records larger than the 64KB read chunk, so the backwards seek has to
// cross chunk boundaries to find even one line.
appendLine("big.jsonl", { pad: "x".repeat(100_000), tag: "first" });
appendLine("big.jsonl", { pad: "y".repeat(100_000), tag: "second" });
const big = tailLines("big.jsonl", 2);
check("handles records larger than the read chunk", big.length === 2, `got ${big.length}`);
check("multi-chunk records parse correctly",
  big[0].tag === "first" && big[1].tag === "second",
  JSON.stringify(big.map((b) => b.tag)));

// Multi-byte characters straddling a chunk boundary must not corrupt a line.
for (let i = 0; i < 400; i++) appendLine("utf8.jsonl", { i, s: "é→𝄞".repeat(200) });
const utf8 = tailLines("utf8.jsonl", 5);
check("utf-8 across chunk boundaries survives", utf8.length === 5, `got ${utf8.length}`);
check("utf-8 content is intact", utf8.every((r) => r.s.startsWith("é→𝄞")));
check("indices are contiguous at the tail",
  utf8.map((r) => r.i).join(",") === "395,396,397,398,399",
  utf8.map((r) => r.i).join(","));

/* ------------------------------------------------------------------ */

console.log("\nGrowth: appending stays cheap as history accumulates");

// ~5,000 records at roughly the size of a real run record. This is about
// nine months of 15-minute runs.
const runShaped = { signals: Array.from({ length: 17 }, (_, i) => ({ symbol: `S${i}`, score: 50, indicators: { a: 1, b: 2, c: 3 } })) };

const t0 = Date.now();
for (let i = 0; i < 5000; i++) appendLine("growth.jsonl", { i, ...runShaped });
const appendMs = Date.now() - t0;

const info = archiveInfo("growth.jsonl");
check("archive grew to a realistic size", info.megabytes > 5, `${info.megabytes} MB`);
check("record count is estimated sanely", Math.abs(info.records - 5000) < 500, String(info.records));

// The first 100 appends vs the last 100: if appending were a
// read-modify-write, the last ones would be dramatically slower.
const tEarly = Date.now();
for (let i = 0; i < 100; i++) appendLine("growth2.jsonl", { i, ...runShaped });
const earlyMs = Date.now() - tEarly;

const tLate = Date.now();
for (let i = 0; i < 100; i++) appendLine("growth.jsonl", { i, ...runShaped });
const lateMs = Date.now() - tLate;

check("appending to a large archive is not slower than to an empty one",
  lateMs <= earlyMs + 100, `empty: ${earlyMs}ms, large: ${lateMs}ms`);

const tRead = Date.now();
const recent = tailLines("growth.jsonl", 20);
const readMs = Date.now() - tRead;

check("reading the recent past is fast regardless of size", readMs < 250, `${readMs}ms`);
check("reading the tail returns the newest records", recent.length === 20, String(recent.length));
check("total append time stayed reasonable", appendMs < 20_000, `${appendMs}ms for 5000`);

console.log(
  `\n  (archive ${info.megabytes} MB, ${info.records} records; tail read ${readMs}ms)`
);

/* ------------------------------------------------------------------ */

console.log("\nresetStateDir — actually picks up a NEW directory, not just re-checks the old one");

{
  // Self-caught bug: this used to be a top-level `const CANDIDATES`
  // evaluated once at import time, so resetStateDir() forgot the cached
  // *directory* but stateDir() still iterated the *same frozen list* —
  // meaning a test (or anything else) that changed DARKLY_STATE_DIR
  // after import and called resetStateDir() silently landed back on the
  // original directory (or /data) instead of the new one. Found while
  // writing leads-store.test.mjs, which genuinely needs several distinct
  // durable stores within one process.
  const before = stateDir();

  const SCRATCH2 = path.join(os.tmpdir(), "darkly-state-test-2");
  fs.rmSync(SCRATCH2, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH2, { recursive: true });
  process.env.DARKLY_STATE_DIR = SCRATCH2;
  resetStateDir();

  check("stateDir() reflects the newly-set DARKLY_STATE_DIR after reset", stateDir() === SCRATCH2, stateDir());
  check("it's actually a different directory than before", stateDir() !== before);

  writeState("resettest.json", { marker: "in-scratch2" });
  check("writes after reset land in the new directory", fs.existsSync(path.join(SCRATCH2, "resettest.json")));
  check("the OLD directory does not receive the new write",
    !fs.existsSync(path.join(SCRATCH, "resettest.json")));

  // Restore for anything that runs after this block in-process.
  process.env.DARKLY_STATE_DIR = SCRATCH;
  resetStateDir();
  check("resetting back to the original directory works too", stateDir() === SCRATCH);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
