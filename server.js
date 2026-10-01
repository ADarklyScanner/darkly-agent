// Darkly Robot brain server. Runs in Termux on the robot's phone.
// - Serves the face / control panel page at http://127.0.0.1:3000
// - Holds the Claude API key and forwards requests to Claude (online brain)
// - Forwards to the local llama-server (offline Nessari brain)
// - Reads and writes the robot's own files (personality, memory, body, logs)
// No npm packages needed. Node 22+.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import * as phone from "./phone.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.ROBOT_DATA || path.join(ROOT, "data");
const PUBLIC = path.join(ROOT, "public");
const LOG_FILE = path.join(DATA, "logs", "robot-log.jsonl");

fs.mkdirSync(path.join(DATA, "logs"), { recursive: true });

// Photos, videos and voice memos go to the phone's gallery (Pictures/Nessari) when Termux has storage access.
const SHARED = path.join(os.homedir(), "storage", "shared");
function mediaDir(kind) {
  const base = fs.existsSync(SHARED) ? path.join(SHARED, kind === "voice" ? "Recordings" : kind === "video" ? "Movies" : "Pictures", "Nessari")
                                     : path.join(DATA, "media", kind);
  fs.mkdirSync(base, { recursive: true });
  return base;
}
async function readRaw(req, limit) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error("File too large"); chunks.push(c); }
  return Buffer.concat(chunks);
}

// ---- remote control from another phone on the same Wi-Fi (off unless config.json has "remote": true) ----
const remote = { queue: [], state: {}, photo: null };
// live video: offers from her page and answers from viewers, keyed by session (no trickle ICE; same Wi-Fi)
const rtc = {};
const isLocal = req => { const a = req.socket.remoteAddress || ""; return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1"; };
function lanIPs() {
  return Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === "IPv4" && !i.internal).map(i => i.address);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function config() {
  return {
    port: 3000,
    claudeModel: "claude-sonnet-5-5",
    localUrl: "http://127.0.0.1:8080",
    ...readJson(path.join(DATA, "config.json"), {})
  };
}

// Keys live in ~/.robot-key, one per line. Line 1 is the main key; the rest are backups,
// used in order when a key is out of credit, rate-limited, or rejected.
// Lines starting with # are ignored, so you can label them.
function apiKeys() {
  const keys = [];
  if (process.env.ANTHROPIC_API_KEY) keys.push(process.env.ANTHROPIC_API_KEY.trim());
  for (const f of [path.join(os.homedir(), ".robot-key"), path.join(DATA, ".key")]) {
    try {
      for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
        const k = line.trim();
        if (/^sk-ant-\S{20,}$/.test(k) && !keys.includes(k)) keys.push(k);   // only real-looking keys; stray text is ignored
      }
    } catch {}
  }
  return keys;
}
// Gemini keys: ~/.robot-gemini-key, same format (one per line, # for labels).
function geminiKeys() {
  const keys = [];
  if (process.env.GEMINI_API_KEY) keys.push(process.env.GEMINI_API_KEY.trim());
  try {
    for (const line of fs.readFileSync(path.join(os.homedir(), ".robot-gemini-key"), "utf8").split(/\r?\n/)) {
      const k = line.trim();
      if (/^[\w-]{30,}$/.test(k) && !keys.includes(k)) keys.push(k);         // only real-looking keys; stray text is ignored
    }
  } catch {}
  return keys;
}
let activeGemini = 0;
const GEMINI_BASE = process.env.ROBOT_GEMINI_URL || "https://generativelanguage.googleapis.com/v1beta";

// Gemini models to try, best first: newest stable Flash, older Flash versions, then Flash-Lite.
// When one is overloaded ("high demand"), the next is tried. config.json "geminiModel" forces one.
let geminiModelCache = null;          // first choice, shown on the Status tab
let geminiModelList = null;
async function geminiModels(key) {
  const cfg = config().geminiModel;
  if (cfg && cfg !== "auto") return [cfg];
  if (geminiModelList) return geminiModelList;
  let list = [];
  try {
    const r = await timedFetch(`${GEMINI_BASE}/models?pageSize=200&key=${encodeURIComponent(key)}`, {}, 8000);
    const j = await r.json();
    const names = (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => String(m.name).replace(/^models\//, ""));
    const byVersion = re => names.map(n => [n, n.match(re)]).filter(([, m]) => m)
      .sort((a, b) => parseFloat(b[1][1]) - parseFloat(a[1][1])).map(([n]) => n);
    list = [...byVersion(/^gemini-(\d+(?:\.\d+)?)-flash$/), ...byVersion(/^gemini-(\d+(?:\.\d+)?)-flash-lite$/)];
    for (const alias of ["gemini-flash-latest", "gemini-flash-lite-latest"]) if (names.includes(alias) && !list.length) list.push(alias);
  } catch {}
  if (!list.length) list = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
  geminiModelList = list.slice(0, 4);
  geminiModelCache = geminiModelList[0];
  log({ kind: "brain", detail: "Gemini models: " + geminiModelList.join(", ") });
  return geminiModelList;
}
const geminiBusy = status => status === 500 || status === 503 || status === 504;
const geminiKeyProblem = (status, text) =>
  status === 401 || status === 403 || status === 429 || (status === 400 && /api key|API_KEY/i.test(text));

let activeKey = 0;                 // index of the key currently in use
const apiKey = () => apiKeys()[activeKey] || apiKeys()[0] || "";

// Errors where a different key could work: bad/disabled key, no credit, rate limit.
function keyProblem(status, text) {
  if (status === 401 || status === 403 || status === 429) return true;
  return status === 400 && /credit|billing|balance/i.test(text);
}

function log(entry) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
  } catch {}
}

function tailLog(n) {
  try {
    const lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n");
    return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// Keep every file operation inside the data folder.
function safePath(rel) {
  const p = path.resolve(DATA, String(rel || "").replace(/^\/+/, ""));
  if (p !== DATA && !p.startsWith(DATA + path.sep)) throw new Error("Path is outside the robot's files");
  return p;
}

async function readBody(req, limit = 12 * 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error("Request too large"); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

async function timedFetch(url, opts = {}, ms = 60000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal }); } finally { clearTimeout(t); }
}

let onlineCache = { at: 0, ok: false };
async function checkOnline() {
  if (Date.now() - onlineCache.at < 15000) return onlineCache.ok;
  let ok = false;
  try { const r = await timedFetch("https://api.anthropic.com/v1/models", { method: "GET" }, 4000); ok = r.status > 0; } catch {}
  onlineCache = { at: Date.now(), ok };
  return ok;
}

async function checkLocal() {
  try { const r = await timedFetch(config().localUrl + "/health", {}, 2000); return r.ok; } catch { return false; }
}

// ---- whole-phone hardware via Termux:API (every sensor the phone has) ----
import { execFile } from "node:child_process";
function run(cmd, args, ms = 6000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: ms, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err && !out ? null : String(out || "")));
  });
}
const parseJson = s => { try { return JSON.parse(s); } catch { return null; } };

function memInfo() {
  const m = {};
  try { for (const l of fs.readFileSync("/proc/meminfo", "utf8").split("\n")) { const [k, v] = l.split(":"); if (v) m[k.trim()] = parseInt(v) * 1024; } } catch {}
  return { totalMB: Math.round((m.MemTotal || os.totalmem()) / 1048576), freeMB: Math.round((m.MemAvailable || os.freemem()) / 1048576) };
}
function diskInfo() {
  try { const s = fs.statfsSync(DATA); return { totalGB: +(s.blocks * s.bsize / 1e9).toFixed(1), freeGB: +(s.bavail * s.bsize / 1e9).toFixed(1) }; } catch { return null; }
}
function cpuTemps() {
  const out = [];
  try {
    for (const z of fs.readdirSync("/sys/class/thermal")) {
      if (!z.startsWith("thermal_zone")) continue;
      const t = parseInt(fs.readFileSync(`/sys/class/thermal/${z}/temp`, "utf8"));
      if (t > 0) out.push(t > 1000 ? t / 1000 : t);
    }
  } catch {}
  return out.length ? Math.max(...out) : null;
}

// Sampling for the offline brain. Small models fall into loops ("is that a ghost?" x12) at low variety:
// a fresh random seed every time, a penalty on repeating recent words, and DRY (stops repeating whole phrases).
function localSampling(body) {
  const lively = body.lively ? 1 : 0;                  // spontaneous lines get more variety than answers to questions
  return {
    temperature: Math.min(1.3, Number(body.temperature) || (lively ? 1.0 : 0.8)),
    top_p: 0.95, min_p: 0.05, top_k: 0,
    repeat_penalty: 1.12, repeat_last_n: 512, presence_penalty: lively ? 0.5 : 0.25, frequency_penalty: lively ? 0.3 : 0.1,
    dry_multiplier: 0.8, dry_base: 1.75, dry_allowed_length: 2, dry_penalty_last_n: -1,
    seed: Math.floor(Math.random() * 2 ** 31)
  };
}
let hwCache = { at: 0, data: null }, sensorList = null, hwRunning = null, sensorFails = 0, sensorPauseUntil = 0;
// Reading EVERY sensor at once, or starting a new read while the last is still running, makes Termux:API pop up
// "Error in termuxApiReceiver". So: only the sensors she uses, one read at a time, cleanup after, and back off on errors.
const WANTED_SENSORS = /accelerometer|gyroscope|light|proximity|magnetic|pressure|gravity|step counter|hall/i;
const SKIP_SENSORS = /uncalibrated|wake.?up|secondary|non.?wakeup.*non|tilt detector|pickup|motion detect|significant|stationary|interrupt|sar|grip|auto.?rotat|device.?orient|game.?rotation|geomagnetic.?rotation|\bstep detector/i;
async function hardware(force = false) {
  if (!force && Date.now() - hwCache.at < 6000 && hwCache.data) return hwCache.data;
  if (hwRunning) return hwRunning;                     // one read at a time
  hwRunning = readHardware().finally(() => { hwRunning = null; });
  return hwRunning;
}
async function readHardware() {
  if (sensorList === null) {
    const l = parseJson(await run("termux-sensor", ["-l"], 8000));
    const all = l?.sensors || [];
    // one of each kind, the plain version
    const seen = new Set();
    sensorList = all.filter(n => WANTED_SENSORS.test(n) && !SKIP_SENSORS.test(n)).filter(n => {
      const kind = (n.match(WANTED_SENSORS) || [""])[0].toLowerCase(); if (seen.has(kind)) return false; seen.add(kind); return true;
    });
    if (all.length && !sensorList.length) sensorList = all.slice(0, 4);
    if (l) sensorList.total = all.length;
  }
  const sensorsOk = sensorList.length && Date.now() > sensorPauseUntil;
  const [sens, batt] = await Promise.all([
    sensorsOk ? run("termux-sensor", ["-s", sensorList.join(","), "-n", "1"], 6000) : null,
    run("termux-battery-status", [], 5000)
  ]);
  if (sensorsOk) {
    if (!sens || !/\{/.test(sens)) {
      run("termux-sensor", ["-c"], 4000);             // release any listener the failed read left behind
      if (++sensorFails >= 3) { sensorPauseUntil = Date.now() + 5 * 60000; sensorFails = 0; log({ kind: "error", where: "sensors", detail: "sensor reads keep failing; pausing them for 5 minutes" }); }
    } else sensorFails = 0;
  }
  // termux-sensor prints one JSON object per reading
  let readings = {};
  if (sens) { const m = sens.match(/\{[\s\S]*\}/); readings = parseJson(m?.[0]) || {}; }
  const simple = {};
  for (const [name, v] of Object.entries(readings)) simple[name] = (v.values || []).map(x => +Number(x).toFixed(2));
  const load = os.loadavg()[0];
  hwCache = { at: Date.now(), data: {
    termuxApi: sensorList.length > 0 || !!batt,
    sensorCount: sensorList.total || sensorList.length, sensors: simple, sensorsPaused: Date.now() < sensorPauseUntil,
    battery: parseJson(batt),
    memory: memInfo(), disk: diskInfo(),
    cpu: { cores: os.cpus().length, load: +load.toFixed(2), hottestC: cpuTemps() },
    uptimeMin: Math.round(os.uptime() / 60)
  } };
  return hwCache.data;
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".mjs": "text/javascript", ".wasm": "application/wasm", ".task": "application/octet-stream", ".tflite": "application/octet-stream" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    // Anything not from this phone may ONLY use the remote page, and only if remote is switched on with a PIN.
    if (!isLocal(req)) {
      const cfg = config();
      if (!cfg.remote || !cfg.remotePin) return send(res, 403, { error: "Remote control is off. Turn it on in her Settings." });
      const okFiles = ["/remote", "/remote.html", "/icon-192.png", "/manifest.webmanifest"];
      if (req.method === "GET" && okFiles.includes(p)) {
        const f = path.join(PUBLIC, p === "/remote" ? "remote.html" : p.slice(1));
        return send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || "text/html");
      }
      const pin = url.searchParams.get("pin") || req.headers["x-pin"];
      if (String(pin) !== String(cfg.remotePin)) return send(res, 401, { error: "Wrong PIN" });
      if (p === "/api/remote/send" && req.method === "POST") {
        const body = await readBody(req, 64 * 1024);
        remote.queue.push({ ...body, at: Date.now() }); remote.queue = remote.queue.slice(-50);
        log({ kind: "remote", detail: JSON.stringify(body).slice(0, 200) });
        return send(res, 200, { ok: true });
      }
      if (p === "/api/remote/state") return send(res, 200, { ...remote.state, photoAt: remote.photo?.at || 0 });
      if (p === "/api/remote/rtc" && req.method === "GET") return send(res, 200, { offer: rtc[url.searchParams.get("session")]?.offer || null });
      if (p === "/api/remote/rtc" && req.method === "POST") {
        const body = await readBody(req, 256 * 1024);
        if (!/^[\w-]{8,64}$/.test(body.session || "")) return send(res, 400, { error: "bad session" });
        rtc[body.session] = { ...(rtc[body.session] || {}), answer: body.answer, at: Date.now() };
        return send(res, 200, { ok: true });
      }
      if (p === "/api/remote/photo" && remote.photo) return send(res, 200, remote.photo.buf, "image/jpeg");
      return send(res, 404, { error: "Not found" });
    }

    // ---- remote control: the robot's own page picks up commands and reports its state ----
    if (p === "/api/rtc/offer" && req.method === "POST") {
      const body = await readBody(req, 256 * 1024);
      rtc[body.session] = { offer: body.offer, at: Date.now() };
      for (const [k, v] of Object.entries(rtc)) if (Date.now() - v.at > 10 * 60000) delete rtc[k];
      return send(res, 200, { ok: true });
    }
    if (p === "/api/rtc/answer") return send(res, 200, { answer: rtc[url.searchParams.get("session")]?.answer || null });
    if (p === "/api/remote/poll") { const q = remote.queue; remote.queue = []; return send(res, 200, { commands: q }); }
    if (p === "/api/remote/report" && req.method === "POST") { remote.state = { ...(await readBody(req, 256 * 1024)), at: Date.now() }; return send(res, 200, { ok: true }); }
    if (p === "/api/remote/photo" && req.method === "PUT") { remote.photo = { buf: await readRaw(req, 8 * 1024 * 1024), at: Date.now() }; return send(res, 200, { ok: true }); }
    if (p === "/api/remote/info") {
      const cfg = config();
      return send(res, 200, { enabled: !!cfg.remote, pin: cfg.remotePin || null, urls: lanIPs().map(ip => `http://${ip}:${PORT}/remote`) });
    }

    // ---- her changelog (ships with the code, so updates bring a new one) ----
    if (p === "/api/changelog") {
      let text = ""; try { text = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8"); } catch {}
      return send(res, 200, { text });
    }

    // ---- save a photo / video / voice memo to the phone's gallery ----
    if (p === "/api/media" && req.method === "PUT") {
      const kind = ["photo", "video", "voice"].includes(url.searchParams.get("kind")) ? url.searchParams.get("kind") : "photo";
      const ext = { photo: "jpg", video: "webm", voice: "webm" }[kind];
      const label = String(url.searchParams.get("label") || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
      const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
      const file = path.join(mediaDir(kind), `nessari-${stamp}${label ? "-" + label : ""}.${ext}`);
      fs.writeFileSync(file, await readRaw(req, 150 * 1024 * 1024));
      run("termux-media-scan", [file], 5000);                 // so it shows up in the Gallery app
      log({ kind: "media", detail: file });
      return send(res, 200, { ok: true, file, shown: file.replace(os.homedir() + "/storage/shared/", "") });
    }
    // ---- status ----
    if (p === "/api/status") {
      const [online, local] = await Promise.all([checkOnline(), checkLocal()]);
      const keys = apiKeys();
      const gkeys = geminiKeys();
      return send(res, 200, { online, local, remote: !!config().remote, hasKey: keys.length > 0, keyCount: keys.length, keyInUse: keys.length ? Math.min(activeKey, keys.length - 1) + 1 : 0,
        geminiKeyCount: gkeys.length, geminiKeyInUse: gkeys.length ? Math.min(activeGemini, gkeys.length - 1) + 1 : 0, geminiModel: geminiModelCache,
        model: config().claudeModel, time: new Date().toISOString() });
    }

    // ---- online brain #2: Gemini (OpenAI-style chat format) ----
    if (p === "/api/gemini" && req.method === "POST") {
      const keys = geminiKeys();
      if (!keys.length) return send(res, 400, { error: "No Gemini key. Put it in ~/.robot-gemini-key" });
      const body = await readBody(req);
      if (activeGemini >= keys.length) activeGemini = 0;
      let r, text, done = false;
      keyLoop:
      for (let tries = 0; tries < keys.length; tries++) {
        const i = (activeGemini + tries) % keys.length;
        const models = await geminiModels(keys[i]);
        for (const [mi, model] of models.entries()) {
          const call = extra => timedFetch(`${GEMINI_BASE}/openai/chat/completions`, {
            method: "POST",
            headers: { authorization: "Bearer " + keys[i], "content-type": "application/json" },
            body: JSON.stringify({ model, max_tokens: 1500, ...body, ...extra })
          }, 90000);
          r = await call({ reasoning_effort: "low" });            // keep thinking short: she's talking out loud
          text = await r.text();
          if (r.status === 400 && /reasoning/i.test(text)) { r = await call({}); text = await r.text(); }
          if (r.ok) {
            if (i !== activeGemini) { log({ kind: "key", detail: `Switched to Gemini key #${i + 1}` }); activeGemini = i; }
            if (mi > 0) log({ kind: "brain", detail: `Gemini ${models[0]} was busy; answered with ${model}` });
            done = true; break keyLoop;
          }
          log({ kind: "error", where: "gemini", key: i + 1, model, status: r.status, detail: text.slice(0, 300) });
          if (r.status === 404) { geminiModelList = null; continue; }   // model retired: try the next, re-pick later
          if (!geminiBusy(r.status)) break;                             // not "busy": another model won't help
        }
        if (!geminiKeyProblem(r.status, text)) break;
      }
      let errMsg = null;
      if (!r.ok) { try { const j = JSON.parse(text); errMsg = (Array.isArray(j) ? j[0] : j)?.error?.message; } catch {} }
      if (errMsg) return send(res, r.status, { error: errMsg });
      res.writeHead(r.status, { "Content-Type": "application/json" });
      return res.end(text);
    }

    // ---- every sensor + RAM/storage/CPU ----
    if (p === "/api/hw") return send(res, 200, await hardware(url.searchParams.has("fresh")));
    if (p === "/api/hw/extra") {
      // on-demand phone abilities through Termux:API
      const what = url.searchParams.get("what");
      const num = (min, max) => String(Math.round(Math.min(max, Math.max(min, Number(url.searchParams.get("value")) || 0))));
      const text = String(url.searchParams.get("text") || "").slice(0, 300);
      const cmds = {
        brightness: ["termux-brightness", [num(0, 255)], 4000],
        volume: ["termux-volume", ["music", num(0, 15)], 4000],
        notify: ["termux-notification", ["--title", "Nessari", "--content", text || "Hey.", "--id", "nessari"], 5000],
        toast: ["termux-toast", [text || "Hey."], 4000],
        location: ["termux-location", ["-p", "network", "-r", "once"], 20000],
        wifi: ["termux-wifi-connectioninfo", [], 5000],
        wifiscan: ["termux-wifi-scaninfo", [], 10000],
        cell: ["termux-telephony-cellinfo", [], 8000],
        torch_on: ["termux-torch", ["on"], 4000],
        torch_off: ["termux-torch", ["off"], 4000],
        vibrate: ["termux-vibrate", ["-d", "300", "-f"], 4000]
      };
      const c = cmds[what];
      if (!c) return send(res, 400, { error: "unknown: " + what });
      const out = await run(c[0], c[1], c[2]);
      const HELP = {
        brightness: "Android Settings > Apps > Termux:API > 'Modify system settings' > Allow",
        location: "Android Settings > Apps > Termux:API > Permissions > Location > Allow",
        wifiscan: "Android Settings > Apps > Termux:API > Permissions > Location > Allow (Wi-Fi scans need it)",
        cell: "Android Settings > Apps > Termux:API > Permissions > Phone and Location > Allow",
        notify: "Android Settings > Apps > Termux:API > Notifications > Allow",
        torch_on: "Android Settings > Apps > Termux:API > Permissions > Camera > Allow"
      };
      if (out === null || /error|permission|denied/i.test(out) && !/^\s*[{[]/.test(out)) {
        log({ kind: "error", where: "termux-api " + what, detail: (out || "no answer").trim().slice(0, 200) });
        return send(res, 503, { error: `Termux:API couldn't do "${what}". ${HELP[what] ? "Fix: " + HELP[what] : "Check that the Termux:API app (from F-Droid) is installed."}` });
      }
      return send(res, 200, { what, result: parseJson(out) ?? out.trim() ?? "ok" });
    }

    // Flashlight blink pattern: [on, off, on, off...] in ms. The torch is slow to switch, so ~250ms is the shortest blink.
    if (p === "/api/hw/torch-pattern" && req.method === "POST") {
      const body = await readBody(req);
      const pat = (Array.isArray(body.pattern) ? body.pattern : []).slice(0, 120).map(n => Math.min(3000, Math.max(0, Number(n) || 0)));
      if (pat.reduce((a, b) => a + b, 0) > 45000) return send(res, 400, { error: "Pattern too long (45s max)" });
      send(res, 200, { ok: true });                          // answer now, blink in the background
      (async () => {
        for (let i = 0; i < pat.length; i++) {
          if (i % 2 === 0 && pat[i] > 0) await run("termux-torch", ["on"], 3000);
          if (i % 2 === 1 || pat[i] > 0) { await new Promise(r => setTimeout(r, Math.max(0, pat[i] - 150))); }
          if (i % 2 === 0 && pat[i] > 0) await run("termux-torch", ["off"], 3000);
        }
        await run("termux-torch", ["off"], 3000);
      })();
      return;
    }

    // ---- driving the phone itself (Wireless debugging / adb; see phone.js) ----
    if (p === "/api/phone/task" && req.method === "POST") {
      const body = await readBody(req);
      return send(res, 200, await phone.runTask(body.goal, { maxSteps: Math.min(40, body.maxSteps || 25) }));
    }
    if (p === "/api/phone/stop" && req.method === "POST") return send(res, 200, { stopped: phone.stop() });
    if (p === "/api/phone/status") return send(res, 200, phone.status());
    if (p === "/api/phone/quick" && req.method === "POST") {
      const body = await readBody(req);
      try { return send(res, 200, { result: await phone.quick(body.cmd, body.arg) }); }
      catch (e) { return send(res, 200, { result: "FAILED: " + e.message }); }
    }

    // ---- online brain: Claude ----
    if (p === "/api/claude" && req.method === "POST") {
      const keys = apiKeys();
      if (!keys.length) return send(res, 400, { error: "No Claude API key. Put it in ~/.robot-key" });
      const body = await readBody(req);
      const payload = JSON.stringify({ model: config().claudeModel, max_tokens: 1024, ...body });
      if (activeKey >= keys.length) activeKey = 0;
      let r, text;
      // Try the key in use first, then each backup once.
      for (let tries = 0; tries < keys.length; tries++) {
        const i = (activeKey + tries) % keys.length;
        r = await timedFetch(process.env.ROBOT_CLAUDE_URL || "https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": keys[i], "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: payload
        }, 90000);
        text = await r.text();
        if (r.ok) {
          if (i !== activeKey) { log({ kind: "key", detail: `Switched to Claude key #${i + 1}` }); activeKey = i; }
          break;
        }
        log({ kind: "error", where: "claude", key: i + 1, status: r.status, detail: text.slice(0, 300) });
        if (!keyProblem(r.status, text)) break;           // not a key problem; another key won't help
      }
      res.writeHead(r.status, { "Content-Type": "application/json" });
      return res.end(text);
    }

    // ---- offline brain: local llama-server (Nessari) ----
    if (p === "/api/local" && req.method === "POST") {
      const body = await readBody(req);
      const r = await timedFetch(config().localUrl + "/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // cache_prompt: reuse the already-read start of the conversation instead of re-reading it every time
        body: JSON.stringify({ messages: body.messages, max_tokens: body.max_tokens || 300, ...localSampling(body), stream: false, cache_prompt: true })
      }, 180000);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return send(res, 502, { error: "Local brain error", detail: j });
      return send(res, 200, { text: j.choices?.[0]?.message?.content || "" });
    }

    // ---- offline brain, streamed: words arrive as they're generated so she can start talking sooner ----
    if (p === "/api/local-stream" && req.method === "POST") {
      const body = await readBody(req);
      const r = await timedFetch(config().localUrl + "/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: body.messages, max_tokens: body.max_tokens || 300, ...localSampling(body), stream: true, cache_prompt: true })
      }, 300000);
      if (!r.ok || !r.body) return send(res, 502, { error: "Local brain error " + r.status });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      for await (const chunk of r.body) res.write(chunk);
      return res.end();
    }

    // ---- files ----
    if (p === "/api/files" && req.method === "GET") {
      const target = safePath(url.searchParams.get("path") || "");
      const st = fs.statSync(target, { throwIfNoEntry: false });
      if (!st) return send(res, 404, { error: "No such file yet" });   // normal for files she hasn't made yet
      if (st.isDirectory()) {
        const items = fs.readdirSync(target, { withFileTypes: true })
          .filter(d => !d.name.startsWith("."))
          .map(d => ({ name: d.name, dir: d.isDirectory(), size: d.isDirectory() ? 0 : fs.statSync(path.join(target, d.name)).size }))
          .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
        return send(res, 200, { path: path.relative(DATA, target), items });
      }
      if (st.size > 2 * 1024 * 1024) return send(res, 413, { error: "File too big to open here" });
      return send(res, 200, { path: path.relative(DATA, target), content: fs.readFileSync(target, "utf8") });
    }
    if (p === "/api/files" && req.method === "PUT") {
      const body = await readBody(req);
      const target = safePath(body.path);
      if (target === DATA) throw new Error("Need a file name");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (body.append) fs.appendFileSync(target, String(body.content ?? ""));
      else fs.writeFileSync(target, String(body.content ?? ""));
      log({ kind: "file", action: body.append ? "append" : "write", path: body.path });
      return send(res, 200, { ok: true });
    }

    // ---- logs ----
    if (p === "/api/log" && req.method === "POST") {
      const body = await readBody(req);
      log(body);
      return send(res, 200, { ok: true });
    }
    if (p === "/api/logs") {
      return send(res, 200, { entries: tailLog(Math.min(Number(url.searchParams.get("n")) || 100, 1000)) });
    }

    // ---- static page ----
    if (req.method === "GET") {
      const file = path.resolve(PUBLIC, p === "/" ? "index.html" : "." + p);
      if (!file.startsWith(PUBLIC)) return send(res, 404, { error: "Not found" });
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || "application/octet-stream");
      }
    }
    return send(res, 404, { error: "Not found" });
  } catch (e) {
    const msg = e.name === "AbortError" ? "Timed out" : String(e.message || e);
    log({ kind: "error", where: p, detail: msg });
    return send(res, e instanceof SyntaxError ? 400 : 500, { error: msg });
  }
});

const PORT = Number(process.env.PORT) || config().port;
phone.init({ apiKeys, geminiKeys, geminiModels, timedFetch, log, config: () => ({ ...config(), port: PORT }), GEMINI_BASE,
  CLAUDE_URL: process.env.ROBOT_CLAUDE_URL || "https://api.anthropic.com/v1/messages" });
// Listens on all interfaces so the optional remote page works; everything except /remote is refused
// for other devices (see the isLocal check at the top of the handler).
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Darkly robot brain on http://127.0.0.1:${PORT}  (files: ${DATA})`);
  log({ kind: "boot", port: PORT });
});
