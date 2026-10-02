// Phone driving: Nessari operates the phone she lives on (open apps, read the screen, tap, swipe, type)
// through Android's own Wireless debugging (ADB), paired once with `robot-dedicate`. No root needed.
//
// It runs here on the server, not in the browser, so it keeps working while her face is in the background.
// Each step: read the screen (UI element list + screenshot) → ask the online brain for ONE action → do it → repeat.
//
// Guardrails: only when he asks (never on her own), a hard step/time limit, STOP cancels, and anything that
// spends money, sends messages, deletes things or changes accounts must be in his request or she stops and asks.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

let deps = null;                 // { apiKeys, geminiKeys, geminiModels, timedFetch, log, config, GEMINI_BASE, CLAUDE_URL }
export function init(d) { deps = d; }

// ---------------- adb ----------------
const sh = (cmd, args, ms = 15000, binary = false) => new Promise(res => {
  execFile(cmd, args, { timeout: ms, maxBuffer: 32 * 1024 * 1024, encoding: binary ? "buffer" : "utf8" },
    (err, out, errOut) => res({ ok: !err, out: out || (binary ? Buffer.alloc(0) : ""), err: String(errOut || err?.message || "") }));
});
let serial = null;
const FIXED = "127.0.0.1:5555";
// Getting control of her own phone, in order of preference:
//  1. already connected
//  2. the fixed local port (set up below; survives Wireless debugging turning off and Wi-Fi drops, until a reboot)
//  3. switch Wireless debugging on herself (Termux was given permission by robot-dedicate), find its port, connect,
//     then switch the phone to the fixed local port so 2. works from then on.
export async function ensureAdb() {
  const d = await sh("adb", ["devices"], 8000);
  if (!d.ok && /ENOENT|not found/i.test(d.err)) throw new Error("adb isn't installed. In Termux: pkg install android-tools");
  const live = d.out.split("\n").map(l => l.trim().split(/\s+/)).find(p => p[1] === "device");
  if (live) { serial = live[0]; return serial; }
  for (const l of d.out.split("\n")) { const [sr, st] = l.trim().split(/\s+/); if (/offline|unauthorized/.test(st || "")) await sh("adb", ["disconnect", sr], 4000); }   // stale leftovers
  if (/connected/.test((await sh("adb", ["connect", FIXED], 6000)).out) && await ready(FIXED)) { serial = FIXED; return serial; }
  let tls = await mdnsConnect();
  if (!tls) {
    await sh("settings", ["put", "global", "adb_wifi_enabled", "1"], 5000);     // works once robot-dedicate granted the permission
    for (let i = 0; i < 6 && !tls; i++) { await new Promise(r => setTimeout(r, 1500)); tls = await mdnsConnect(); }
  }
  if (tls) {
    await sh("adb", ["-s", tls, "tcpip", "5555"], 10000);                    // from now on: a fixed local port
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 1200));
      if (/connected/.test((await sh("adb", ["connect", FIXED], 6000)).out) && await ready(FIXED)) { serial = FIXED; return serial; }
    }
    serial = tls; return serial;
  }
  throw new Error("I can't reach my own phone controls. This is needed once after each restart: be on Wi-Fi or the hotspot, then run robot-dedicate (it pairs and gives me permission to turn Wireless debugging on myself next time).");
}
async function ready(s) { return /device/.test((await sh("adb", ["-s", s, "get-state"], 5000)).out); }
async function mdnsConnect() {
  const m = await sh("adb", ["mdns", "services"], 8000);
  const hit = m.out.match(/_adb-tls-connect\._tcp\.?\s+([\d.]+:\d+)/) || m.out.match(/_adb-tls-connect[^\n]*?([\d.]+:\d+)/);
  if (!hit) return null;
  const c = await sh("adb", ["connect", hit[1]], 10000);
  return /connected/.test(c.out) && await ready(hit[1]) ? hit[1] : null;
}
const adb = (args, ms, binary) => sh("adb", ["-s", serial, ...args], ms, binary);
const shell = (cmd, ms = 15000) => adb(["shell", cmd], ms);
const q = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

let screen = { w: 1080, h: 2340 };
async function screenSize() {
  const r = await shell("wm size"); const m = r.out.match(/(\d+)x(\d+)\s*$/m);
  if (m) screen = { w: +m[1], h: +m[2] };
}

// Read what's on screen: every visible element with text/description, as a numbered list.
async function readScreen() {
  await shell("uiautomator dump /sdcard/.nessari-ui.xml >/dev/null 2>&1", 20000);
  const x = (await shell("cat /sdcard/.nessari-ui.xml", 10000)).out;
  const pkg = (x.match(/package="([^"]+)"/) || [])[1] || "?";
  const els = [];
  for (const m of x.matchAll(/<node ([^>]+?)\/?>/g)) {
    const a = {}; for (const kv of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) a[kv[1]] = kv[2];
    const b = (a.bounds || "").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/); if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number); if (x2 - x1 < 4 || y2 - y1 < 4) continue;
    const label = (a.text || a["content-desc"] || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#10;/g, " ").trim();
    const id = (a["resource-id"] || "").split("/").pop();
    const clickable = a.clickable === "true" || a["long-clickable"] === "true";
    const editable = /EditText/.test(a.class || "");
    if (!label && !clickable && !editable) continue;
    els.push({ label: label.slice(0, 80), id, clickable, editable, checked: a.checked === "true" ? true : undefined,
      cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2), box: [x1, y1, x2, y2] });
  }
  return { pkg, els: els.slice(0, 90) };
}
async function screenshotB64() {
  const r = await adb(["exec-out", "screencap", "-p"], 20000, true);
  return r.ok && r.out.length > 1000 ? r.out.toString("base64") : null;
}

// ---------------- apps ----------------
const KNOWN = { youtube: "com.google.android.youtube", chrome: "com.android.chrome", camera: "com.sec.android.app.camera",
  settings: "com.android.settings", gallery: "com.sec.android.gallery3d", photos: "com.google.android.apps.photos",
  maps: "com.google.android.apps.maps", "play store": "com.android.vending", spotify: "com.spotify.music", clock: "com.sec.android.app.clockpackage",
  calculator: "com.sec.android.app.popupcalculator", messages: "com.samsung.android.messaging", phone: "com.samsung.android.dialer",
  contacts: "com.samsung.android.app.contacts", termux: "com.termux", files: "com.sec.android.app.myfiles", "my files": "com.sec.android.app.myfiles",
  gmail: "com.google.android.gm", calendar: "com.samsung.android.calendar", notes: "com.samsung.android.app.notes", "f-droid": "org.fdroid.fdroid" };
async function findPackage(name) {
  const n = String(name).toLowerCase().trim();
  if (KNOWN[n]) return KNOWN[n];
  if (/^[a-z0-9_]+(\.[a-z0-9_]+)+$/i.test(n)) return n;
  const list = (await shell("pm list packages")).out.split("\n").map(l => l.replace("package:", "").trim()).filter(Boolean);
  const word = n.replace(/[^a-z0-9]/g, "");
  return list.find(p => p.split(".").pop() === word) || list.find(p => p.includes(word)) || null;
}
async function openApp(name) {
  const pkg = await findPackage(name);
  if (!pkg) return `FAILED: couldn't find an app called "${name}".`;
  const r = await shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
  return /Events injected: 1/.test(r.out) ? `Opened ${name} (${pkg}).` : `FAILED: couldn't open ${pkg}.`;
}
export async function backToFace() {
  try { await ensureAdb(); await shell(`am start -a android.intent.action.VIEW -d http://127.0.0.1:${deps.config().port || 3000}`); } catch {}
}

// ---------------- guardrails ----------------
const RISKY = /\b(buy|purchase|pay|place order|checkout|subscribe|send money|transfer|confirm payment|delete|erase|factory reset|uninstall|remove account|sign out|log out|post|publish|send)\b/i;
function allowedByGoal(label, goal) {
  const m = String(label).match(RISKY); if (!m) return true;
  return new RegExp("\\b" + m[1].split(" ")[0], "i").test(goal);              // he asked for that kind of thing
}

// ---------------- one action ----------------
async function act(a, s, goal) {
  const el = Number.isInteger(a.index) ? s.els[a.index] : null;
  switch (a.action) {
    case "open_app": return await openApp(a.app);
    case "tap": {
      const x = el ? el.cx : Math.round(a.x), y = el ? el.cy : Math.round(a.y);
      if (el && !allowedByGoal(el.label, goal)) return `BLOCKED: "${el.label}" looks like it spends money, sends something or deletes something, and he didn't ask for that. Ask him first.`;
      if (!(x >= 0 && y >= 0 && x <= screen.w && y <= screen.h)) return "FAILED: tap is off-screen.";
      await shell(`input tap ${x} ${y}`); return `Tapped ${el ? `"${el.label || el.id}"` : `${x},${y}`}.`;
    }
    case "long_press": { const x = el ? el.cx : a.x, y = el ? el.cy : a.y; await shell(`input swipe ${x} ${y} ${x} ${y} 700`); return "Long-pressed."; }
    case "type": {
      if (el) await shell(`input tap ${el.cx} ${el.cy}`);
      const text = String(a.text || "").slice(0, 500);
      for (const chunk of text.match(/.{1,40}/gs) || []) await shell(`input text ${q(chunk.replace(/ /g, "%s"))}`);
      if (a.enter) await shell("input keyevent 66");
      return `Typed "${text}"${a.enter ? " and pressed enter" : ""}.`;
    }
    case "swipe": {
      const d = { up: [0.5, 0.75, 0.5, 0.3], down: [0.5, 0.3, 0.5, 0.75], left: [0.85, 0.5, 0.15, 0.5], right: [0.15, 0.5, 0.85, 0.5] }[a.direction] || [0.5, 0.75, 0.5, 0.3];
      await shell(`input swipe ${Math.round(d[0] * screen.w)} ${Math.round(d[1] * screen.h)} ${Math.round(d[2] * screen.w)} ${Math.round(d[3] * screen.h)} 350`);
      return `Swiped ${a.direction || "up"}.`;
    }
    case "key": {
      const k = { home: 3, back: 4, recents: 187, enter: 66, volume_up: 24, volume_down: 25, mute: 164, play_pause: 85, power: 26 }[a.key];
      if (!k) return "FAILED: keys are home, back, recents, enter, volume_up, volume_down, mute, play_pause.";
      await shell(`input keyevent ${k}`); return `Pressed ${a.key}.`;
    }
    case "wait": await new Promise(r => setTimeout(r, Math.min(8, +a.seconds || 2) * 1000)); return "Waited.";
    default: return `FAILED: unknown action "${a.action}".`;
  }
}

// ---------------- the brain call (Claude or Gemini, whichever works) ----------------
const SYSTEM = `You are Nessari, operating the Android phone you live on, step by step, to do what he asked.
Each turn you get the current app, a numbered list of on-screen elements (with text, whether clickable/editable, and center coordinates) and usually a screenshot.
Reply with ONLY one JSON object, no other text:
{"action":"open_app","app":"youtube"} | {"action":"tap","index":12} | {"action":"tap","x":540,"y":1200} | {"action":"long_press","index":3}
{"action":"type","index":4,"text":"cats","enter":true} | {"action":"swipe","direction":"up|down|left|right"} | {"action":"key","key":"back|home|recents|enter|volume_up|volume_down|play_pause"}
{"action":"wait","seconds":2} | {"action":"done","summary":"what you did, one or two sentences in your own voice"} | {"action":"ask","question":"what you need him to decide"}
Rules: prefer tapping by index. One action per reply. If something didn't work, try a different way, not the same thing again.
Never spend money, send messages or emails, post anything, delete anything, or change accounts, passwords or security settings unless his request clearly says to; if a step needs that, use "ask".
If the note says the screen did not change, your last action did nothing: scroll, go back, or pick another element instead of repeating it.
If you're stuck after a few tries, use "done" and say honestly what went wrong.`;

async function think(messages) {
  const imgOf = m => m.image;
  // Gemini first (OpenAI-style), then Claude.
  for (const key of deps.geminiKeys()) {
    const models = await deps.geminiModels(key);
    const msgs = [{ role: "system", content: SYSTEM }, ...messages.map(m => ({ role: m.role,
      content: m.image ? [{ type: "text", text: m.text }, { type: "image_url", image_url: { url: "data:image/png;base64," + m.image } }] : m.text }))];
    const r = await deps.timedFetch(`${deps.GEMINI_BASE}/openai/chat/completions`, { method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({ model: models[0], messages: msgs, max_tokens: 600, reasoning_effort: "low" }) }, 60000).catch(() => null);
    if (r?.ok) { const j = await r.json(); return j.choices?.[0]?.message?.content || ""; }
  }
  for (const key of deps.apiKeys()) {
    const msgs = messages.map(m => ({ role: m.role, content: m.image
      ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: m.image } }, { type: "text", text: m.text }] : m.text }));
    const r = await deps.timedFetch(deps.CLAUDE_URL, { method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: deps.config().claudeModel, max_tokens: 600, system: SYSTEM, messages: msgs }) }, 60000).catch(() => null);
    if (r?.ok) { const j = await r.json(); return (j.content || []).filter(b => b.type === "text").map(b => b.text).join(""); }
  }
  throw new Error("no online brain answered. Working out a new phone task needs Gemini or Claude; without internet I can only repeat phone tasks I've done before, or just open an app");
}
const parseAction = t => { const m = String(t).match(/\{[\s\S]*\}/); try { return m ? JSON.parse(m[0]) : null; } catch { return null; } };

// ---------------- routines: things she's done before, replayed without any AI ----------------
// When a task finishes successfully, the taps and typing that got there are saved by what was tapped (its text or id,
// not where it was on screen). Asked for the same thing again, she replays them directly: quick, free, and it works
// with no internet. If the screen doesn't match any more, she drops the routine and works it out afresh.
const routinesFile = () => path.join(deps.dataDir || ".", "phone-routines.json");
let routines = null;
function loadRoutines() { if (!routines) { try { routines = JSON.parse(fs.readFileSync(routinesFile(), "utf8")); } catch { routines = []; } } return routines; }
const saveRoutines = () => { try { fs.writeFileSync(routinesFile(), JSON.stringify(routines, null, 1)); } catch {} };
const goalKey = g => [...new Set(String(g).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(w => w.length > 1 && !/^(the|an|and|to|for|me|my|please|can|you|on|in|it|up|phone)$/.test(w)))].sort();
function findRoutine(goal) {
  const k = goalKey(goal); let best = null, bs = 0;
  for (const r of loadRoutines()) { const inter = r.key.filter(w => k.includes(w)).length, sc = inter / Math.max(1, new Set([...r.key, ...k]).size); if (sc > bs) { bs = sc; best = r; } }
  return bs >= 0.85 ? best : null;                                    // only when it's really the same request
}
export function listRoutines() { return loadRoutines().map(r => ({ goal: r.goal, steps: r.steps.length, runs: r.runs || 0 })); }
export function forgetRoutine(goal) { const n = loadRoutines().length, r = findRoutine(goal) || routines.find(x => x.goal.toLowerCase().includes(String(goal).toLowerCase())); if (r) { routines = routines.filter(x => x !== r); saveRoutines(); } return n !== routines.length; }
const findEl = (s, st) => s.els.find(e => st.label && e.label === st.label) || s.els.find(e => st.id && e.id === st.id && (!st.label || !e.label)) || (st.label ? s.els.find(e => e.label && e.label.toLowerCase() === st.label.toLowerCase()) : null);
async function replay(r, goal) {
  const done = [];
  for (const st of r.steps) {
    if (task.cancel) throw new Error("stopped");
    let res;
    if (st.label || st.id) {                                           // a step on a particular button or field: find it on the screen as it is now
      let s, el;
      for (let tries = 0; tries < 4 && !el; tries++) { s = await readScreen(); el = findEl(s, st); if (!el) await new Promise(z => setTimeout(z, 900)); }
      if (!el) return { ok: false, done, why: `couldn't find "${st.label || st.id}" on the screen this time` };
      res = await act({ ...st, index: s.els.indexOf(el) }, s, goal);
    } else res = await act(st, { els: [] }, goal);
    if (/^(FAILED|BLOCKED)/.test(res)) return { ok: false, done, why: res };
    done.push({ action: st.action + (st.app ? " " + st.app : "") + (st.label ? ` "${st.label}"` : ""), result: res });
    notify(`(from memory) ${st.action}${st.app ? " " + st.app : ""}${st.label ? ` "${st.label}"` : ""}`);
    await new Promise(z => setTimeout(z, st.action === "open_app" ? 2200 : 1000));
  }
  return { ok: true, done };
}
const screenSig = s => s.pkg + "|" + s.els.map(e => e.label || e.id).join("|").slice(0, 600);

// ---------------- the task loop ----------------
let task = null;                 // { goal, steps:[], state, result, cancel }
export function status() { return task ? { goal: task.goal, state: task.state, steps: task.steps.slice(-30), result: task.result } : { state: "idle" }; }
export function stop() { if (task && task.state === "running") { task.cancel = true; return true; } return false; }

function notify(text) {
  execFile("termux-notification", ["--id", "nessari-phone", "--title", "Nessari is using the phone", "--content", text.slice(0, 200), "--ongoing",
    "--button1", "STOP", "--button1-action", `curl -s -X POST http://127.0.0.1:${deps.config().port || 3000}/api/phone/stop`], () => {});
}
const unnotify = () => execFile("termux-notification-remove", ["nessari-phone"], () => {});

export async function runTask(goal, { maxSteps = 25, returnToFace = true } = {}) {
  if (task?.state === "running") return { ok: false, text: "FAILED: I'm already in the middle of using the phone." };
  task = { goal: String(goal).slice(0, 500), steps: [], state: "running", result: null, cancel: false };
  const t0 = Date.now();
  try {
    await ensureAdb(); await screenSize();
    // done this before? do it from memory (no AI needed)
    const known = findRoutine(task.goal);
    if (known) {
      const rp = await replay(known, task.goal);
      task.steps.push(...rp.done);
      if (rp.ok) {
        known.runs = (known.runs || 0) + 1; known.lastOk = Date.now(); saveRoutines();
        task.state = "done"; task.result = `Done from memory, the way it worked last time (${known.steps.length} steps, no AI needed). ${known.summary || ""}`.trim();
        deps.log({ kind: "phone", detail: "replayed routine: " + known.goal });
        return { ok: true, text: `${task.state}: ${task.result} (${task.steps.length} steps)` };
      }
      known.fails = (known.fails || 0) + 1; if (known.fails >= 2) { routines = routines.filter(x => x !== known); } saveRoutines();
      deps.log({ kind: "phone", detail: `routine didn't fit (${rp.why}); working it out again` });
      task.steps.push({ action: "memory", result: `my remembered way didn't fit (${rp.why}); working it out again` });
    }
    const history = [], trace = [];
    let lastSig = null;
    for (let i = 0; i < maxSteps; i++) {
      if (task.cancel) throw new Error("stopped");
      if (Date.now() - t0 > 4 * 60000) throw new Error("took too long (4 minutes)");
      const s = await readScreen();
      const shot = await screenshotB64();
      const list = s.els.map((e, k) => `${k}: ${e.label ? `"${e.label}"` : "(no text)"}${e.id ? ` #${e.id}` : ""}${e.clickable ? " [tap]" : ""}${e.editable ? " [text field]" : ""}${e.checked ? " [on]" : ""} @${e.cx},${e.cy}`).join("\n");
      // reflect: did the last action actually change anything?
      const sig = screenSig(s), stuck = lastSig !== null && sig === lastSig && task.steps.length && !/^Waited/.test(task.steps[task.steps.length - 1].result);
      lastSig = sig;
      const text = `Goal: ${task.goal}\nStep ${i + 1}. Current app: ${s.pkg}. Screen ${screen.w}x${screen.h}.\n${stuck ? "NOTE: the screen did NOT change after your last action. It had no effect: do something different.\n" : ""}On-screen elements:\n${list || "(none readable; use the screenshot)"}\n` +
        (task.steps.length ? `Your previous actions: ${task.steps.slice(-6).map(x => `${x.action} → ${x.result}`).join(" | ")}` : "");
      history.push({ role: "user", text, image: shot });
      const recent = history.slice(-3).map((m, k, arr) => k < arr.length - 1 ? { role: m.role, text: m.text.split("\nOn-screen")[0] } : m);  // only the latest screen in full
      const reply = await think(recent);
      history.push({ role: "assistant", text: reply });
      const a = parseAction(reply);
      if (!a) { task.steps.push({ action: "?", result: "couldn't read the plan" }); continue; }
      if (a.action === "done") {
        task.state = "done"; task.result = a.summary || "Done.";
        // remember how, if it went cleanly and wasn't a failure report
        if (trace.length && trace.length <= 15 && !/couldn't|could not|failed|unable|stuck|didn't work|went wrong/i.test(task.result)) {
          loadRoutines(); routines = routines.filter(r => r.key.join(" ") !== goalKey(task.goal).join(" "));
          routines.push({ goal: task.goal, key: goalKey(task.goal), steps: trace, summary: String(task.result).slice(0, 200), learned: Date.now(), runs: 0 });
          routines = routines.slice(-40); saveRoutines();
        }
        break;
      }
      if (a.action === "ask") { task.state = "needs_you"; task.result = a.question || "I need you to decide something."; break; }
      notify(`${a.action}${a.app ? " " + a.app : ""}${a.text ? ` "${a.text}"` : ""}${Number.isInteger(a.index) && s.els[a.index] ? ` "${s.els[a.index].label}"` : ""}`);
      const r = await act(a, s, task.goal);
      if (!/^(FAILED|BLOCKED)/.test(r) && a.action !== "wait") {             // keep the working steps, described by WHAT was tapped
        const el = Number.isInteger(a.index) ? s.els[a.index] : null;
        if (a.action === "tap" && !el) trace.length = 99;                 // tapped bare coordinates: not replayable, so don't save this one
        else trace.push({ action: a.action, app: a.app, text: a.text, enter: a.enter, direction: a.direction, key: a.key, label: el?.label || undefined, id: el && !el.label ? el.id : undefined });
      }
      task.steps.push({ action: a.action + (a.app ? ` ${a.app}` : "") + (Number.isInteger(a.index) && s.els[a.index] ? ` "${s.els[a.index].label}"` : ""), result: r });
      deps.log({ kind: "phone", detail: `${a.action}: ${r}` });
      await new Promise(r => setTimeout(r, a.action === "open_app" ? 2200 : 1000));   // let the screen settle
    }
    if (task.state === "running") { task.state = "done"; task.result = `Stopped after ${maxSteps} steps without finishing.`; }
  } catch (e) {
    task.state = e.message === "stopped" ? "stopped" : "failed";
    task.result = e.message === "stopped" ? "Stopped." : e.message;
  } finally {
    unnotify();
    if (returnToFace) await backToFace();
  }
  return { ok: task.state === "done", text: `${task.state}: ${task.result} (${task.steps.length} steps)` };
}

// Quick single actions (no thinking loop).
export async function quick(cmd, arg) {
  await ensureAdb(); await screenSize();
  if (cmd === "open_app") return await openApp(arg);
  if (cmd === "key") return await act({ action: "key", key: arg }, { els: [] }, "");
  if (cmd === "read_screen") {
    const s = await readScreen();
    return `App: ${s.pkg}\n` + s.els.filter(e => e.label).slice(0, 60).map(e => `- ${e.label}${e.clickable ? " (button)" : ""}`).join("\n");
  }
  if (cmd === "screenshot") return await screenshotB64();
  if (cmd === "check") return `Connected to my own phone controls (${serial}).`;
  return "FAILED: unknown";
}
