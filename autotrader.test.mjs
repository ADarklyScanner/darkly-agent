// Use the platform temp dir, not a hardcoded /tmp: Android/Termux does not
// permit writing to /tmp, and os.tmpdir() honours TMPDIR there.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH = path.join(os.tmpdir(), "darkly-autotest");
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
process.env.HOME = SCRATCH;

// state.js checks a mounted /data volume BEFORE $HOME (see state.js's
// CANDIDATES). On a machine that actually has a writable /data — this
// dev sandbox does, to mimic Railway's mounted volume — setting only
// HOME above does not isolate this test at all: every run still lands
// in the real, persistent /data, accumulating alongside runs from every
// previous test invocation this session. DARKLY_STATE_DIR outranks even
// /data, so this is the one override that actually guarantees a clean,
// private archive regardless of what the host machine happens to mount.
process.env.DARKLY_STATE_DIR = SCRATCH;

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

console.log("\nAudit trail (which code/config produced each run)");
check("every run carries a deployment field", runs.every((r) => r.deployment !== undefined));
check("no RAILWAY_GIT_* vars in this test environment -> deployment is honestly 'unknown'",
  runs.every((r) => r.deployment.known === false));
check("every run carries a configFingerprint", runs.every((r) => typeof r.configFingerprint === "string" && r.configFingerprint.length > 0));
check("two runs made back-to-back with no config change share the same fingerprint",
  new Set(runs.map((r) => r.configFingerprint)).size === 1, JSON.stringify(runs.map((r) => r.configFingerprint)));

const { getCurrentConfigDetails } = await import("./autotrader.js");
const details = getCurrentConfigDetails();
check("getCurrentConfigDetails() fingerprint matches what runs are stamped with",
  details.fingerprint === runs[0].configFingerprint);
check("getCurrentConfigDetails() exposes the actual settings behind the fingerprint",
  details.CONFIG && details.RISK_DEFAULTS && details.AGGRESSIVENESS);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail===0?0:1);
