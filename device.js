/**
 * device.js — a phone the agent can ask for specific, named things.
 *
 * WHAT THIS IS NOT
 *
 * It is not remote control of a phone. The agent cannot open apps it was
 * not told about, cannot tap around a screen, and cannot invent a new
 * capability. It can only ask for actions the DEVICE has declared, by
 * name, with typed parameters.
 *
 * That constraint is the whole design, and the reason for it is concrete:
 * this agent reads untrusted web pages. A page can contain text shaped
 * like an instruction, and a model acting on that text is how "read this
 * website" becomes "do something in my banking app". An allowlist of
 * named actions means a poisoned page cannot conjure a capability that
 * does not exist — the worst it can do is ask for something already on
 * the list, which is the next layer's problem.
 *
 * THE LAYERS
 *
 * 1. DECLARED ACTIONS ONLY. The device registers a manifest. Anything not
 *    in it is refused here, before it ever reaches the phone.
 *
 * 2. EFFECT TIERS. Each action says whether it only reads ("read") or
 *    changes something ("write"). Reads can run unattended; writes are
 *    marked as requiring confirmation and the phone must ask the human
 *    before doing them. That check lives on the DEVICE on purpose — a
 *    confirmation the server could bypass is decoration, while one the
 *    phone enforces is a real boundary.
 *
 * 3. PROVENANCE. Every command records whether the agent had consumed
 *    untrusted external content before issuing it. The phone can surface
 *    that in its prompt ("this was requested after the agent read a web
 *    page"), which is exactly the signal a person needs to spot an
 *    injected instruction.
 *
 * 4. EXPIRY AND BOUNDS. Commands expire, the queue is capped, and
 *    everything is written to a durable audit log. A command that sat
 *    unclaimed for an hour should not suddenly execute when the phone
 *    comes back online.
 *
 * TRANSPORT
 *
 * The phone is behind NAT and cannot be dialled, so it polls: the agent
 * enqueues, the device collects, executes, and posts the result back.
 * Nothing here ever connects out to the phone.
 */

import { randomUUID } from "node:crypto";
import { readState, writeState, appendLine, tailLines } from "./state.js";

const MANIFEST_FILE = "darkly-device-manifest.json";
const QUEUE_FILE = "darkly-device-queue.json";
const AUDIT_FILE = "darkly-device-audit.jsonl";

export const MAX_QUEUED_COMMANDS = 50;
export const COMMAND_TTL_MS = 10 * 60 * 1000; // an unclaimed command goes stale fast
export const RESULT_RETENTION_MS = 60 * 60 * 1000;

export const EFFECTS = ["read", "write"];

/* ------------------------------------------------------------------ *
 * Manifest
 * ------------------------------------------------------------------ */

function loadManifest() {
  const m = readState(MANIFEST_FILE, null);
  return m && typeof m === "object" ? m : null;
}

/**
 * The device declares what it can do.
 *
 * Validation is strict because this list is the security boundary: a
 * malformed action that silently defaulted to "read" would let a
 * side-effecting capability run without confirmation, so anything
 * ambiguous is rejected outright rather than assumed safe.
 */
export function registerDevice({ deviceId, name, actions } = {}) {
  if (!deviceId || typeof deviceId !== "string") throw new Error("`deviceId` is required.");
  if (!Array.isArray(actions) || actions.length === 0) throw new Error("`actions` must be a non-empty array.");
  if (actions.length > 200) throw new Error("Too many actions declared (cap is 200).");

  const seen = new Set();
  const clean = actions.map((a, i) => {
    if (!a || typeof a !== "object") throw new Error(`Action ${i} is not an object.`);
    if (!a.id || !/^[a-z][a-z0-9_.]*$/.test(a.id)) {
      throw new Error(`Action ${i} needs an id matching /^[a-z][a-z0-9_.]*$/ (got ${JSON.stringify(a.id)}).`);
    }
    if (seen.has(a.id)) throw new Error(`Duplicate action id "${a.id}".`);
    seen.add(a.id);

    if (!a.description || String(a.description).length < 10) {
      throw new Error(`Action "${a.id}" needs a description the user will understand when asked to approve it.`);
    }
    if (!EFFECTS.includes(a.effect)) {
      throw new Error(
        `Action "${a.id}" must declare effect "read" or "write". It is not defaulted: an action whose effect is unclear would otherwise run without confirmation.`
      );
    }

    return {
      id: a.id,
      description: String(a.description),
      effect: a.effect,
      params: a.params && typeof a.params === "object" ? a.params : {},
      // A device may insist on confirmation even for a read.
      alwaysConfirm: Boolean(a.alwaysConfirm)
    };
  });

  const manifest = {
    deviceId,
    name: name || deviceId,
    actions: clean,
    registeredAt: new Date().toISOString()
  };

  writeState(MANIFEST_FILE, manifest);
  audit({ type: "register", deviceId, actionCount: clean.length });
  return { ok: true, deviceId, actionCount: clean.length, actions: clean.map((a) => a.id) };
}

export function getManifest() {
  return loadManifest();
}

export function listActions() {
  const m = loadManifest();
  if (!m) {
    return {
      registered: false,
      actions: [],
      note:
        "No device has registered any actions. The phone app has to POST its manifest to /device/register before the agent can ask it for anything. Until then there is nothing it can do on the phone, and it should say so rather than implying otherwise."
    };
  }
  return {
    registered: true,
    deviceId: m.deviceId,
    name: m.name,
    registeredAt: m.registeredAt,
    actions: m.actions.map((a) => ({
      id: a.id,
      description: a.description,
      effect: a.effect,
      params: a.params,
      requiresConfirmation: a.effect === "write" || a.alwaysConfirm
    }))
  };
}

/* ------------------------------------------------------------------ *
 * Queue
 * ------------------------------------------------------------------ */

function loadQueue() {
  const q = readState(QUEUE_FILE, []);
  return Array.isArray(q) ? q : [];
}

function saveQueue(q) {
  return writeState(QUEUE_FILE, q);
}

function audit(entry) {
  appendLine(AUDIT_FILE, { at: new Date().toISOString(), ...entry });
}

function prune(queue, now = Date.now()) {
  return queue.filter((c) => {
    const age = now - new Date(c.createdAt).getTime();
    if (c.status === "pending" && age > COMMAND_TTL_MS) return false;
    if (c.status !== "pending" && age > RESULT_RETENTION_MS) return false;
    return true;
  });
}

/**
 * Ask the device to do something.
 *
 * `untrustedContext` is the caller's honest declaration that the agent
 * had consumed external content (a web page, a search result, a fetched
 * document) before deciding to issue this. It is not a block on its own —
 * researching a venue and then logging a shift is perfectly ordinary —
 * but it travels with the command so the phone can say so while asking,
 * and so the audit log shows it afterwards.
 */
export function enqueueCommand({ actionId, params = {}, reason, untrustedContext = false } = {}) {
  const manifest = loadManifest();
  if (!manifest) {
    return {
      ok: false,
      error: "No device has registered. There is nothing on the phone to call yet.",
      registered: false
    };
  }

  const action = manifest.actions.find((a) => a.id === actionId);
  if (!action) {
    // The allowlist doing its job. Say what exists rather than hinting
    // that a different phrasing might work.
    return {
      ok: false,
      error: `"${actionId}" is not an action this device declared. The agent can only request actions from the device's own manifest.`,
      availableActions: manifest.actions.map((a) => a.id)
    };
  }

  // Parameters are restricted to those the action declared, so a caller
  // cannot smuggle extra fields through to the device.
  const declared = Object.keys(action.params || {});
  const supplied = Object.keys(params || {});
  const undeclaredParams = supplied.filter((k) => !declared.includes(k));
  if (undeclaredParams.length > 0) {
    return {
      ok: false,
      error: `Action "${actionId}" does not accept: ${undeclaredParams.join(", ")}. It accepts: ${declared.join(", ") || "(no parameters)"}.`
    };
  }

  let queue = prune(loadQueue());
  const pending = queue.filter((c) => c.status === "pending");
  if (pending.length >= MAX_QUEUED_COMMANDS) {
    return {
      ok: false,
      error: `There are already ${pending.length} commands waiting for the device. It is probably offline — not queueing more.`
    };
  }

  const requiresConfirmation = action.effect === "write" || action.alwaysConfirm;

  const command = {
    id: randomUUID(),
    actionId,
    params,
    reason: reason ? String(reason).slice(0, 500) : null,
    effect: action.effect,
    requiresConfirmation,
    untrustedContext: Boolean(untrustedContext),
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + COMMAND_TTL_MS).toISOString()
  };

  queue.push(command);
  saveQueue(queue);
  audit({ type: "enqueue", commandId: command.id, actionId, effect: action.effect, requiresConfirmation, untrustedContext: command.untrustedContext, reason: command.reason });

  return {
    ok: true,
    commandId: command.id,
    status: "pending",
    effect: action.effect,
    requiresConfirmation,
    untrustedContext: command.untrustedContext,
    expiresAt: command.expiresAt,
    note: requiresConfirmation
      ? "Queued. This action changes something, so the phone must ask the user to approve it before running. It will not happen on its own."
      : "Queued. The phone will pick this up the next time it polls."
  };
}

/** What the device should run. Claiming marks them so they are not re-issued. */
export function claimCommands({ deviceId, max = 10 } = {}) {
  const manifest = loadManifest();
  if (!manifest) return { ok: false, error: "No device registered." };
  if (deviceId && deviceId !== manifest.deviceId) {
    return { ok: false, error: "This deviceId does not match the registered device." };
  }

  const now = Date.now();
  let queue = prune(loadQueue(), now);
  const claimable = queue.filter((c) => c.status === "pending").slice(0, Math.max(1, Math.min(50, max)));

  for (const c of claimable) {
    c.status = "claimed";
    c.claimedAt = new Date(now).toISOString();
  }
  saveQueue(queue);

  return {
    ok: true,
    count: claimable.length,
    commands: claimable.map((c) => ({
      id: c.id,
      actionId: c.actionId,
      params: c.params,
      reason: c.reason,
      effect: c.effect,
      requiresConfirmation: c.requiresConfirmation,
      // The phone shows this to the user. It is the difference between
      // "your agent wants to do X" and "your agent wants to do X, right
      // after reading a web page" — which is what makes an injected
      // instruction visible to a human.
      requestedAfterReadingExternalContent: c.untrustedContext,
      expiresAt: c.expiresAt
    }))
  };
}

/**
 * The device reports what happened.
 *
 * A device may report that the user declined, which is a first-class
 * outcome rather than an error: a refused action is the system working.
 */
export function recordResult({ commandId, ok, result, error, declined } = {}) {
  if (!commandId) throw new Error("`commandId` is required.");

  const queue = prune(loadQueue());
  const command = queue.find((c) => c.id === commandId);
  if (!command) {
    return { ok: false, error: "No such command, or it expired before the device reported back." };
  }
  if (command.status === "done" || command.status === "declined" || command.status === "failed") {
    return { ok: false, error: `Command ${commandId} already reported ${command.status}.` };
  }

  if (declined) {
    command.status = "declined";
    command.completedAt = new Date().toISOString();
  } else if (ok) {
    command.status = "done";
    command.result = result !== undefined ? result : null;
    command.completedAt = new Date().toISOString();
  } else {
    command.status = "failed";
    command.error = error ? String(error).slice(0, 1000) : "The device reported a failure with no detail.";
    command.completedAt = new Date().toISOString();
  }

  saveQueue(queue);
  audit({ type: "result", commandId, actionId: command.actionId, status: command.status });
  return { ok: true, commandId, status: command.status };
}

/** Look up what happened to a command. */
export function getResult(commandId) {
  const queue = prune(loadQueue());
  const command = queue.find((c) => c.id === commandId);
  if (!command) {
    return {
      found: false,
      note: "No such command. It may have expired unclaimed, which happens when the phone is offline — nothing ran."
    };
  }

  return {
    found: true,
    commandId: command.id,
    actionId: command.actionId,
    status: command.status,
    effect: command.effect,
    result: command.result,
    error: command.error,
    requestedAfterReadingExternalContent: command.untrustedContext,
    createdAt: command.createdAt,
    completedAt: command.completedAt,
    note:
      command.status === "pending"
        ? "Still waiting for the phone to pick this up. Nothing has run."
        : command.status === "claimed"
          ? "The phone has it and is working on it or waiting for the user to approve."
          : command.status === "declined"
            ? "The user declined this on the phone. It did not run, and that is a normal outcome, not a failure to work around."
            : undefined
  };
}

/** Recent commands, for the user to see what has been asked for. */
export function recentCommands(limit = 20) {
  const queue = prune(loadQueue());
  return {
    count: queue.length,
    commands: queue
      .slice(-Math.max(1, Math.min(50, limit)))
      .reverse()
      .map((c) => ({
        id: c.id,
        actionId: c.actionId,
        status: c.status,
        effect: c.effect,
        requestedAfterReadingExternalContent: c.untrustedContext,
        createdAt: c.createdAt,
        completedAt: c.completedAt
      }))
  };
}

/** The durable audit trail, newest last. */
export function auditLog(limit = 50) {
  return { entries: tailLines(AUDIT_FILE, Math.max(1, Math.min(500, limit))) };
}

/** Test seam. */
export function _resetDeviceForTests() {
  writeState(MANIFEST_FILE, null);
  writeState(QUEUE_FILE, []);
}
