/**
 * Tests for device.js — run with: node device.test.mjs
 *
 * This module is the one place where the agent can cause something to
 * happen in the physical world, in a process that also reads untrusted
 * web pages. So the tests are mostly adversarial: they try to invoke
 * actions the device never declared, to smuggle extra parameters through,
 * to get a side-effecting action to run without confirmation, and to make
 * a stale command fire late.
 *
 * The property being defended is narrow and worth stating: a web page the
 * agent reads must not be able to produce a capability that does not
 * exist, and must not be able to make a write happen without a human on
 * the phone saying yes.
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const SCRATCH = path.join(os.tmpdir(), `darkly-device-test-${process.pid}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
process.env.DARKLY_STATE_DIR = SCRATCH;

const {
  registerDevice,
  listActions,
  enqueueCommand,
  claimCommands,
  recordResult,
  getResult,
  recentCommands,
  auditLog,
  _resetDeviceForTests,
  MAX_QUEUED_COMMANDS
} = await import("./device.js");

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

function throwsWith(label, fn, matcher) {
  try {
    fn();
    check(label, false, "did not throw");
  } catch (e) {
    check(label, matcher ? matcher.test(e.message) : true, e.message);
  }
}

const MANIFEST = {
  deviceId: "pixel-9",
  name: "Johnny's phone",
  actions: [
    { id: "calendar.next_event", description: "Read the next event on the calendar", effect: "read", params: {} },
    { id: "notifications.count", description: "Count unread notifications", effect: "read", params: {} },
    { id: "drive_mode.start", description: "Start the driving routine (do not disturb, navigation, music)", effect: "write", params: { profile: "string" } },
    { id: "shift.log", description: "Log a completed driving shift with its earnings", effect: "write", params: { hours: "number", earnings: "number" } },
    { id: "location.current", description: "Read the phone's current location", effect: "read", params: {}, alwaysConfirm: true }
  ]
};

/* ------------------------------------------------------------------ */

console.log("\nBefore any device registers");

_resetDeviceForTests();

{
  const l = listActions();
  check("reports that nothing is registered", l.registered === false && l.actions.length === 0);
  check("explains what would have to happen", /POST its manifest/.test(l.note));
  check("tells the agent to say so rather than imply otherwise", /rather than implying otherwise/.test(l.note));

  const r = enqueueCommand({ actionId: "anything" });
  check("no command can be queued with no device", r.ok === false && r.registered === false);
}

console.log("\nRegistering a manifest");

{
  const r = registerDevice(MANIFEST);
  check("registers", r.ok === true && r.actionCount === 5);

  const l = listActions();
  check("lists the declared actions", l.actions.length === 5);
  check("reads are marked as not needing confirmation",
    l.actions.find((a) => a.id === "calendar.next_event").requiresConfirmation === false);
  check("writes are marked as needing confirmation",
    l.actions.find((a) => a.id === "drive_mode.start").requiresConfirmation === true);
  check("a read flagged alwaysConfirm still needs confirmation",
    l.actions.find((a) => a.id === "location.current").requiresConfirmation === true);
  check("parameter shapes are exposed so the agent knows what to send",
    l.actions.find((a) => a.id === "shift.log").params.hours === "number");
}

console.log("\nManifest validation — the security boundary is strict on purpose");

throwsWith("requires a deviceId", () => registerDevice({ actions: MANIFEST.actions }), /deviceId.*required/);
throwsWith("requires at least one action", () => registerDevice({ deviceId: "x", actions: [] }), /non-empty/);
throwsWith("rejects a malformed action id",
  () => registerDevice({ deviceId: "x", actions: [{ id: "Bad Id!", description: "long enough here", effect: "read" }] }), /id matching/);
throwsWith("rejects duplicate action ids",
  () => registerDevice({ deviceId: "x", actions: [
    { id: "a.b", description: "long enough here", effect: "read" },
    { id: "a.b", description: "long enough here", effect: "read" }
  ]}), /Duplicate/);
throwsWith("requires a description a human could act on",
  () => registerDevice({ deviceId: "x", actions: [{ id: "a.b", description: "hi", effect: "read" }] }), /description the user will understand/);

// The most important validation: effect is never defaulted.
throwsWith("refuses an action with no declared effect",
  () => registerDevice({ deviceId: "x", actions: [{ id: "a.b", description: "does something vague" }] }), /must declare effect/);
throwsWith("refuses an invalid effect",
  () => registerDevice({ deviceId: "x", actions: [{ id: "a.b", description: "does something vague", effect: "maybe" }] }), /must declare effect/);
check("and explains why it is not defaulted", (() => {
  try {
    registerDevice({ deviceId: "x", actions: [{ id: "a.b", description: "does something vague" }] });
    return false;
  } catch (e) {
    return /run without confirmation/.test(e.message);
  }
})());

console.log("\nThe allowlist: undeclared actions cannot be invoked");

registerDevice(MANIFEST);

{
  // This is the shape of an injected instruction from a web page.
  const evil = enqueueCommand({ actionId: "banking.transfer", params: { to: "attacker", amount: 5000 } });
  check("an action the device never declared is refused", evil.ok === false);
  check("the refusal says the manifest is the limit",
    /only request actions from the device's own manifest/.test(evil.error), evil.error);
  check("it lists what actually exists instead of hinting at a rephrasing",
    Array.isArray(evil.availableActions) && evil.availableActions.includes("shift.log"));

  check("a near-miss id is still refused", enqueueCommand({ actionId: "drive_mode.stop" }).ok === false);
  check("case differences do not sneak through", enqueueCommand({ actionId: "Drive_Mode.start" }).ok === false);
}

{
  // Extra parameters must not reach the device.
  const smuggle = enqueueCommand({
    actionId: "shift.log",
    params: { hours: 8, earnings: 200, shellCommand: "rm -rf /" }
  });
  check("undeclared parameters are refused", smuggle.ok === false);
  check("the error names the offending parameter and what is allowed",
    /shellCommand/.test(smuggle.error) && /hours/.test(smuggle.error), smuggle.error);

  const clean = enqueueCommand({ actionId: "shift.log", params: { hours: 8, earnings: 200 } });
  check("declared parameters are accepted", clean.ok === true);
}

console.log("\nEffect tiers and confirmation");

{
  _resetDeviceForTests();
  registerDevice(MANIFEST);

  const read = enqueueCommand({ actionId: "calendar.next_event" });
  check("a read queues without requiring confirmation", read.ok === true && read.requiresConfirmation === false);
  check("its note says the phone will just pick it up", /pick this up/.test(read.note));

  const write = enqueueCommand({ actionId: "drive_mode.start", params: { profile: "night" } });
  check("a write requires confirmation", write.ok === true && write.requiresConfirmation === true);
  check("its note says it will not happen on its own",
    /must ask the user to approve/.test(write.note) && /will not happen on its own/.test(write.note), write.note);
  check("the effect travels with the command", write.effect === "write");

  const sensitiveRead = enqueueCommand({ actionId: "location.current" });
  check("a read the device marked alwaysConfirm still requires confirmation",
    sensitiveRead.requiresConfirmation === true);
}

console.log("\nProvenance: commands issued after reading the web are flagged");

{
  _resetDeviceForTests();
  registerDevice(MANIFEST);

  const clean = enqueueCommand({ actionId: "drive_mode.start", params: { profile: "day" } });
  check("an ordinary command is not flagged", clean.untrustedContext === false);

  const tainted = enqueueCommand({
    actionId: "drive_mode.start",
    params: { profile: "day" },
    untrustedContext: true,
    reason: "after reading a venue page"
  });
  check("a command issued after external content is flagged", tainted.untrustedContext === true);

  const claimed = claimCommands({ deviceId: "pixel-9" });
  const flaggedOne = claimed.commands.find((c) => c.id === tainted.commandId);
  check("the flag reaches the phone under a name a human can understand",
    flaggedOne.requestedAfterReadingExternalContent === true);
  check("the unflagged one is not marked",
    claimed.commands.find((c) => c.id === clean.commandId).requestedAfterReadingExternalContent === false);

  const looked = getResult(tainted.commandId);
  check("the flag is visible afterwards too", looked.requestedAfterReadingExternalContent === true);
}

console.log("\nThe polling cycle");

{
  _resetDeviceForTests();
  registerDevice(MANIFEST);
  const cmd = enqueueCommand({ actionId: "notifications.count" });

  const first = claimCommands({ deviceId: "pixel-9" });
  check("the device receives pending commands", first.count === 1 && first.commands[0].actionId === "notifications.count");
  check("the description-level params come through", first.commands[0].params !== undefined);

  const second = claimCommands({ deviceId: "pixel-9" });
  check("a claimed command is not handed out twice", second.count === 0);

  check("before a result, status is claimed, and it says nothing has finished",
    getResult(cmd.commandId).status === "claimed");

  recordResult({ commandId: cmd.commandId, ok: true, result: { unread: 4 } });
  const done = getResult(cmd.commandId);
  check("the result comes back", done.status === "done" && done.result.unread === 4);

  const again = recordResult({ commandId: cmd.commandId, ok: true, result: { unread: 9 } });
  check("a command cannot report twice", again.ok === false && /already reported/.test(again.error));
}

{
  _resetDeviceForTests();
  registerDevice(MANIFEST);
  const cmd = enqueueCommand({ actionId: "drive_mode.start", params: { profile: "night" } });
  claimCommands({ deviceId: "pixel-9" });

  recordResult({ commandId: cmd.commandId, declined: true });
  const r = getResult(cmd.commandId);
  check("a user declining is recorded as declined, not as an error", r.status === "declined");
  check("and is described as the system working, not something to route around",
    /normal outcome, not a failure to work around/.test(r.note), r.note);
}

{
  _resetDeviceForTests();
  registerDevice(MANIFEST);
  const cmd = enqueueCommand({ actionId: "calendar.next_event" });
  claimCommands({ deviceId: "pixel-9" });
  recordResult({ commandId: cmd.commandId, ok: false, error: "Calendar permission not granted" });
  const r = getResult(cmd.commandId);
  check("a device-side failure is reported with its reason", r.status === "failed" && /permission/.test(r.error));
}

console.log("\nDevice identity and unknown commands");

{
  _resetDeviceForTests();
  registerDevice(MANIFEST);
  enqueueCommand({ actionId: "calendar.next_event" });

  const wrong = claimCommands({ deviceId: "someone-elses-phone" });
  check("a different deviceId cannot collect this phone's commands", wrong.ok === false && /does not match/.test(wrong.error));

  check("reporting a result for an unknown command is refused",
    recordResult({ commandId: "00000000-0000-0000-0000-000000000000", ok: true }).ok === false);
  throwsWith("a result with no command id is refused", () => recordResult({ ok: true }), /commandId.*required/);

  const missing = getResult("00000000-0000-0000-0000-000000000000");
  check("looking up an unknown command says nothing ran", missing.found === false && /nothing ran/.test(missing.note));
}

console.log("\nExpiry and bounds");

{
  _resetDeviceForTests();
  registerDevice(MANIFEST);

  // A command that sat unclaimed while the phone was offline must not
  // suddenly execute an hour later.
  const cmd = enqueueCommand({ actionId: "drive_mode.start", params: { profile: "night" } });
  const queueFile = path.join(SCRATCH, "darkly-device-queue.json");
  const queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
  queue[0].createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  fs.writeFileSync(queueFile, JSON.stringify(queue));

  const claimed = claimCommands({ deviceId: "pixel-9" });
  check("a stale pending command is never handed to the device", claimed.count === 0, String(claimed.count));
  check("and looking it up shows it simply expired", getResult(cmd.commandId).found === false);
}

{
  _resetDeviceForTests();
  registerDevice(MANIFEST);
  let lastResult = null;
  for (let i = 0; i < MAX_QUEUED_COMMANDS + 5; i++) {
    lastResult = enqueueCommand({ actionId: "notifications.count" });
  }
  check("the queue is bounded", lastResult.ok === false && /already .* commands waiting/.test(lastResult.error), lastResult.error);
  check("and the reason given is that the phone is probably offline", /probably offline/.test(lastResult.error));
}

console.log("\nAudit trail");

{
  _resetDeviceForTests();
  registerDevice(MANIFEST);
  const c = enqueueCommand({ actionId: "shift.log", params: { hours: 6, earnings: 180 }, reason: "end of shift", untrustedContext: true });
  claimCommands({ deviceId: "pixel-9" });
  recordResult({ commandId: c.commandId, ok: true, result: { logged: true } });

  const log = auditLog(50);
  const enq = log.entries.find((e) => e.type === "enqueue" && e.commandId === c.commandId);
  const res = log.entries.find((e) => e.type === "result" && e.commandId === c.commandId);

  check("enqueueing is audited", Boolean(enq));
  check("the audit records the effect and whether confirmation was needed",
    enq.effect === "write" && enq.requiresConfirmation === true);
  check("the audit records the provenance flag", enq.untrustedContext === true);
  check("the audit records the stated reason", enq.reason === "end of shift");
  check("the outcome is audited", res && res.status === "done");
  check("registration is audited", log.entries.some((e) => e.type === "register"));

  const recent = recentCommands(10);
  check("recent commands are listable for the user", recent.count >= 1);
  check("and show the provenance flag",
    recent.commands[0].requestedAfterReadingExternalContent === true);
}

console.log("\nDurability");

{
  _resetDeviceForTests();
  registerDevice(MANIFEST);
  const c = enqueueCommand({ actionId: "calendar.next_event" });
  const reloaded = await import(`./device.js?cachebust=${Date.now()}`);
  check("the manifest survives a reload", reloaded.listActions().actions.length === 5);
  check("queued commands survive a reload", reloaded.getResult(c.commandId).found === true);
}

fs.rmSync(SCRATCH, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
