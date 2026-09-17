// Use the platform temp dir, not a hardcoded /tmp: Android/Termux does not
// permit writing to /tmp, and os.tmpdir() honours TMPDIR there.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH = path.join(os.tmpdir(), "darkly-autotest");
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
process.env.HOME = SCRATCH;

const { runOnce, setKillSwitch, getStatus, getRuns } =
  await import("./autotrader.js");

let pass=0, fail=0;
const check=(l,c,d="")=>{ c?(pass++,console.log(`  ok   ${l}`)):(fail++,console.log(`  FAIL ${l} ${d}`)); };

console.log("\nFail-closed behaviour (no credentials, no network)");

const offRun = await runOnce({ mode: "off" });
check("mode=off skips", offRun.skipped === "Autotrader mode is off.", offRun.skipped);
check("mode=off places nothing", !offRun.executed);

setKillSwitch(true, "test");
const killed = await runOnce({ mode: "execute", force: true });
check("kill switch halts execute mode", /Kill switch/.test(killed.skipped || ""), killed.skipped);
check("kill switch run places nothing", !killed.executed);
setKillSwitch(false);

const noClock = await runOnce({ mode: "execute", force: true });
check("unreachable clock fails closed", /clock|aborted|credentials/i.test(noClock.skipped || ""), noClock.skipped);
check("unreachable clock places nothing", !noClock.executed, `executed=${noClock.executed}`);
check("failure is recorded, not swallowed", (noClock.errors||[]).length > 0 || !!noClock.skipped);

console.log("\nState");
const status = getStatus();
check("default mode is signal_only", status.mode === "signal_only", status.mode);
check("reports PAPER", status.tradingMode === "PAPER", status.tradingMode);
check("kill switch readable", status.killSwitch === false);
check("guardrails surfaced", typeof status.guardrails.maxPositionUsd === "number");

const runs = getRuns(10);
check("runs are logged", runs.length >= 3, `got ${runs.length}`);
check("newest run first", new Date(runs[0].startedAt) >= new Date(runs[runs.length-1].startedAt));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail===0?0:1);
