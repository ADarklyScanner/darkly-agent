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
import crypto from "node:crypto";
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
    whisperUrl: "http://127.0.0.1:8081",
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
  res.end(type === "application/json" && !Buffer.isBuffer(body) ? JSON.stringify(body) : body);   // files are sent as they are
}

async function timedFetch(url, opts = {}, ms = 60000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  if (opts.signal) { if (opts.signal.aborted) c.abort(); else opts.signal.addEventListener("abort", () => c.abort(), { once: true }); }   // the caller gave up
  try { return await fetch(url, { ...opts, signal: c.signal }); }
  catch (e) { if (/^https:/.test(String(url))) markOffline(); throw e; }   // the internet just failed: don't make her wait on it again
  finally { clearTimeout(t); }
}

let onlineCache = { at: 0, ok: false };
const markOffline = () => { onlineCache = { at: Date.now(), ok: false }; };
async function checkOnline() {
  if (Date.now() - onlineCache.at < 15000) return onlineCache.ok;
  let ok = false;
  try { const r = await timedFetch("https://api.anthropic.com/v1/models", { method: "GET" }, 4000); ok = r.status > 0; } catch {}
  onlineCache = { at: Date.now(), ok };
  return ok;
}

// "ok" (ready), "loading" (started, still reading the model into memory) or "down"
async function localState() {
  try {
    const r = await timedFetch(config().localUrl + "/health", {}, 2000);
    if (r.ok) setTimeout(benchBrain, 0);
    return r.ok ? "ok" : r.status === 503 ? "loading" : "down";
  } catch { return brainBusy() ? "ok" : "down"; }
}
async function checkLocal() { return (await localState()) === "ok"; }

// The whole point is that she works with no internet, so the offline brain is looked after:
// if it isn't running, start it (brain.sh picks a model that fits), at most once every 2 minutes.
const BRAIN_SH = path.join(ROOT, "brain.sh");
// robot-tune is timing the brain and has it stopped on purpose (a leftover marker older than 15 minutes is ignored)
const tuning = () => { try { return Date.now() - fs.statSync(path.join(DATA, ".tuning")).mtimeMs < 15 * 60000; } catch { return false; } };
let brainStartedAt = 0;
function startBrain(why) {
  if (Date.now() - brainStartedAt < 120000 || !fs.existsSync(BRAIN_SH) || fs.existsSync(path.join(DATA, ".stopping")) || tuning() || brainRunning()) return false;
  brainStartedAt = Date.now();
  log({ kind: "brain", detail: "offline brain isn't running; starting it (" + why + ")" });
  try { const c = spawn("bash", [BRAIN_SH], { detached: true, stdio: "ignore" }); c.on("error", () => {}); c.unref(); } catch { return false; }
  return true;
}
// Wait for the offline brain to be ready (it can take a while to load a big model).
async function waitForBrain(maxMs = 120000, signal) {
  const t0 = Date.now();
  let st = await localState();
  if (st === "down") startBrain("needed now");
  while (st !== "ok" && Date.now() - t0 < maxMs && !signal?.aborted) {
    await new Promise(r => setTimeout(r, 1500)); st = await localState();
    if (st === "down" && Date.now() - t0 > 20000 && Date.now() - brainStartedAt > 20000 && !brainRunning()) break;   // it isn't coming
  }
  return st === "ok";
}
// Is the brain's program alive (even if it isn't answering yet)? Not by process name alone: on some Termux
// versions programs run under another name, so the brain loop also writes its process number to a file.
function brainRunning() {
  for (const f of [".brain-pid", ".brain-loop-pid"]) {
    try { const pid = parseInt(fs.readFileSync(path.join(DATA, f), "utf8")); if (pid > 1 && /llama|brain-loop/.test(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"))) return true; } catch {}
  }
  try { return execFileSync("pgrep", ["-f", "llama-server"], { timeout: 3000 }).length > 0; } catch { return false; }
}

// ---- offline hearing: whisper.cpp on the phone (robot-hearing-setup installs it) ----
const WHISPER_DIRS = [path.join(os.homedir(), "whisper.cpp/build/bin"), "/data/data/com.termux/files/usr/bin"];
const findBin = name => { for (const d of WHISPER_DIRS) { const f = path.join(d, name); if (fs.existsSync(f)) return f; } return null; };
function whisperModel() {
  const c = config().whisperModel; if (c && fs.existsSync(c.replace(/^~/, os.homedir()))) return c.replace(/^~/, os.homedir());
  const dir = path.join(os.homedir(), "models");
  try { const f = fs.readdirSync(dir).filter(n => /^ggml-.*\.bin$/.test(n)).sort((a, b) => fs.statSync(path.join(dir, b)).size - fs.statSync(path.join(dir, a)).size)[0]; return f ? path.join(dir, f) : null; } catch { return null; }
}
async function whisperUp() { try { const r = await timedFetch(config().whisperUrl + "/health", {}, 1500); return r.status > 0; } catch { return false; } }
async function hearingState() {
  if (await whisperUp()) return "ready";
  return findBin("whisper-cli") && whisperModel() ? "slow" : "none";      // "slow": works, but loads the model for every sentence
}
// Whisper invents these when it's handed silence or noise.
const HALLUCINATED = /^\W*(\[.*\]|\(.*\)|thank you\.?|thanks for watching\.?|you\.?|bye\.?|\.+|so\.?|okay\.?)\W*$/i;
async function transcribe(wav) {
  let text = null;
  if (await whisperUp()) {
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");
    form.append("temperature", "0.0"); form.append("temperature_inc", "0.2"); form.append("response_format", "json");
    const r = await timedFetch(config().whisperUrl + "/inference", { method: "POST", body: form }, 60000);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("whisper: " + (j.error || r.status));
    text = j.text || "";
  } else {
    const cli = findBin("whisper-cli"), model = whisperModel();
    if (!cli || !model) return null;
    const tmp = path.join(os.tmpdir(), `nessari-${Date.now()}.wav`);
    fs.writeFileSync(tmp, wav);
    try { text = await run(cli, ["-m", model, "-f", tmp, "-nt", "-np", "-l", "en", "-t", "4"], 90000); } finally { fs.rmSync(tmp, { force: true }); }
    if (text === null) throw new Error("whisper-cli failed");
  }
  text = text.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  return HALLUCINATED.test(text) ? "" : text;
}

// ---- whole-phone hardware via Termux:API (every sensor the phone has) ----
import { execFile, execFileSync, spawn } from "node:child_process";
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
    top_p: 0.95, min_p: 0.05, top_k: 80,                // (0 would mean "weigh every word in the vocabulary": a sort of 128,000 numbers for each token written)
    repeat_penalty: 1.12, repeat_last_n: 512, presence_penalty: lively ? 0.5 : 0.25, frequency_penalty: lively ? 0.3 : 0.1,
    dry_multiplier: 0.8, dry_base: 1.75, dry_allowed_length: 2, dry_penalty_last_n: 1024,
    seed: Math.floor(Math.random() * 2 ** 31)
  };
}
// ---- talking to the offline brain so that it always gets an answer out ----
// Small on-phone models have a small context window; a request that doesn't fit is refused outright.
// So: measure the window, trim the conversation to fit, and if it's still refused, retry in simpler shapes.
let localProps = { at: 0, n_ctx: 4096 };
async function localCtx() {
  if (Date.now() - localProps.at < 60000) return localProps.n_ctx;
  try {
    const j = await (await timedFetch(config().localUrl + "/props", {}, 3000)).json();
    const n = j.default_generation_settings?.n_ctx || j.n_ctx;
    if (n > 256) localProps = { at: Date.now(), n_ctx: n };
  } catch {}
  return localProps.n_ctx;
}
const estTokens = s => Math.ceil(String(s).length / 3.2) + 8;            // on the safe side

// How fast THIS phone's offline brain reads and writes (tokens a second), measured from its real answers and
// remembered in data/.brain-speed.json. A phone brain reads slowly: hand it more than it can get through in
// about half a minute and it never answers in time. So what she sends is sized to the measured speed.
const SPEED_FILE = path.join(DATA, ".brain-speed.json");
const brainModel = () => { try { return path.basename(fs.readFileSync(path.join(DATA, ".brain-model"), "utf8").trim()); } catch { return ""; } };
let speed = { read: 0, write: 0, basis: 0, model: "" };
try { speed = { ...speed, ...JSON.parse(fs.readFileSync(SPEED_FILE, "utf8")) }; } catch {}
const saveSpeed = () => { try { fs.writeFileSync(SPEED_FILE, JSON.stringify(speed)); } catch {} };
function noteSpeed(t) {
  if (!t) return;
  const model = brainModel();
  if (speed.model !== model) speed = { read: 0, write: 0, basis: 0, model };          // a different brain: measure again
  const mix = (old, v) => old ? old * 0.6 + v * 0.4 : v;
  if (t.prompt_n >= 40 && t.prompt_per_second > 0) speed.read = +mix(speed.read, t.prompt_per_second).toFixed(1);
  if (t.predicted_n >= 6 && t.predicted_per_second > 0) speed.write = +mix(speed.write, t.predicted_per_second).toFixed(1);
  // "basis" is the speed the prompt sizes are worked out from. It only moves when the real speed has clearly
  // changed: every change reshuffles her notes, and the brain then has to read them all over again.
  if (speed.read && (!speed.basis || speed.read < speed.basis * 0.7 || speed.read > speed.basis * 1.6)) speed.basis = speed.read;
  saveSpeed();
}
// Token budgets: her standing notes (read once, then remembered by the brain's cache) and the live conversation.
// Neither depends on how long the answer may be, so every kind of request shares the same notes.
function budgets(nctx, maxTok) {
  const read = speed.model === brainModel() && speed.basis > 0 ? speed.basis : 12;     // unmeasured: assume a slow phone
  const step = n => Math.floor(n / 150) * 150;
  const sys = Math.min(Math.max(450, step(read * 60)), step(nctx * 0.5));       // about 40 s of reading, done ahead of time
  // The conversation is only read in full after a restart or when old turns are dropped; normally the brain
  // already holds it and reads just the newest message. So it may be as long as the notes.
  const chat = Math.max(200, Math.min(Math.max(600, step(read * 60)), nctx - sys - maxTok - 64));
  return { sys, chat };
}
const squeeze = (c, tokens) => { const keep = Math.floor(tokens * 3.2); return c.length <= keep ? c : c.slice(0, Math.floor(keep * 0.7)) + "\n…\n" + c.slice(-Math.floor(keep * 0.3)); };
const fitSystem = (content, sys) => squeeze(String(content || ""), sys - 8);
// Her notes are cut to their budget the same way every time (so the brain's cache of them stays valid),
// then the newest messages are kept until the conversation budget is used up.
function fitMessages(messages, { sys, chat }) {
  const msgs = (messages || []).map(m => ({ role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }));
  const out = [];
  if (msgs.length && msgs[0].role === "system") out.push({ role: "system", content: fitSystem(msgs.shift().content, sys) });
  if (!msgs.length) return out;
  const last = msgs.pop();
  last.content = squeeze(last.content, Math.max(150, Math.floor(chat * 0.7)));
  let left = chat - estTokens(last.content);
  const kept = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const cost = estTokens(msgs[i].content);
    if (cost > left) break;
    left -= cost; kept.unshift(msgs[i]);
  }
  while (kept.length && kept[0].role !== "user") kept.shift();           // the conversation has to start with him
  return [...out, ...kept, last];
}
// The plainest shape there is, for models whose chat format rejects system messages or uneven turns:
// instructions folded into the first user message, strictly user/assistant/user.
function compatMessages(msgs) {
  const sys = msgs.filter(m => m.role === "system").map(m => m.content).join("\n\n");
  const out = [];
  for (const m of msgs.filter(m => m.role !== "system")) {
    const role = m.role === "assistant" ? "assistant" : "user";
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += "\n" + m.content; else out.push({ role, content: m.content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  if (!out.length) out.push({ role: "user", content: "Hello." });
  if (sys) out[0].content = sys + "\n\n---\n\n" + out[0].content;
  return out;
}
const llamaError = t => { let msg = t; try { const j = JSON.parse(t); msg = j.error?.message || (typeof j.error === "string" ? j.error : "") || j.message || t; } catch {} return String(msg).replace(/\s+/g, " ").slice(0, 240); };
// One request to the offline brain. Different llama.cpp versions accept different settings, and a setting one
// version refuses ("Field 'x': ...") must never cost her the answer: it's dropped and the request sent again.
const refusedFields = new Set();
let inFlight = 0;                                                        // requests the brain is working on right now
const brainBusy = () => inFlight > 0;
async function llamaPost(payload, ms, signal) {
  for (let i = 0; i < 6; i++) {
    for (const f of refusedFields) delete payload[f];
    let r; inFlight++;
    try { r = await timedFetch(config().localUrl + "/v1/chat/completions", { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }, ms); }
    finally { inFlight--; }
    if (r.status !== 400) return { r };
    const msg = llamaError(await r.text());
    const f = (msg.match(/Field '([\w.]+)'/i) || msg.match(/(?:unknown|unsupported|invalid|unrecognized)\s+(?:field|parameter|key|option)\s*:?\s*['"`]?([\w.]+)/i) || [])[1];
    if (!f || !(f in payload) || ["messages", "max_tokens", "stream"].includes(f)) return { status: 400, msg };
    refusedFields.add(f);
    log({ kind: "brain", detail: `this llama version refuses the setting "${f}"; leaving it out from now on (${msg.slice(0, 120)})` });
  }
  return { status: 400, msg: "too many refused settings" };
}
let lastLocalError = "", warmAbort = null;
// Which standing notes the brain's cache currently starts with ("" = something else, e.g. after the check-up's
// test question). Warming up is skipped only while it still holds hers.
let cacheSys = "";
const sysHash = content => crypto.createHash("sha1").update(brainKey() + "\n" + content).digest("hex");
async function localChat(body, stream, signal) {
  warmAbort?.abort();                                                    // a real question beats warming up
  const nctx = await localCtx();
  const maxTok = Math.min(body.max_tokens || 300, Math.floor(nctx / 3));
  const b = budgets(nctx, maxTok), small = { sys: Math.min(b.sys, 300), chat: Math.min(b.chat, 250) };
  const attempts = [
    () => ({ messages: fitMessages(body.messages, b), ...localSampling(body) }),
    () => ({ messages: compatMessages(fitMessages(body.messages, b)), temperature: 0.8 }),
    () => ({ messages: compatMessages(fitMessages(body.messages, small)) })
  ];
  let err = "";
  for (let i = 0; i < attempts.length; i++) {
    if (signal?.aborted) return { error: "cancelled" };                  // she moved on (he said something new): stop generating
    let out;
    const payload = attempts[i]();
    const holds = payload.messages[0]?.role === "system" ? sysHash(payload.messages[0].content) : "";
    cacheSys = "";
    try { out = await llamaPost({ ...payload, max_tokens: maxTok, stream, cache_prompt: true }, stream ? 240000 : 180000, signal); }
    catch (e) {
      if (signal?.aborted) return { error: "cancelled" };
      const slow = e.name === "AbortError";
      err = slow ? "it was still reading after 3 minutes (this phone is reading slowly; she'll send it less next time)" : "no answer (" + (e.cause?.code || e.message) + ")";
      log({ kind: "error", where: "local brain", try: i + 1, detail: err });
      if (slow) { const r = Math.max(2, (speed.basis || 12) / 2); speed = { ...speed, model: brainModel(), read: r, basis: r }; saveSpeed(); if (i < 2) i = 1; }   // straight to the smallest request
      else if (!(await waitForBrain(60000, signal))) break;              // it went away: give it a chance to come back, once
      continue;
    }
    if (out.r?.ok) { lastLocalError = ""; cacheSys = holds; return { r: out.r }; }
    const msg = out.msg ?? llamaError(await out.r.text()), status = out.status || out.r.status;
    err = `${status} ${msg}`;
    log({ kind: "error", where: "local brain", try: i + 1, detail: err });
    if (status === 503) await waitForBrain(120000, signal);              // still loading the model: wait, then go again
  }
  lastLocalError = err;
  return { error: err };
}
// Right after the brain starts: a short test so its speed is known before the first real question.
// (A number at the front makes the text new every time; otherwise the brain would remember it and "read" it instantly.)
let benchRunning = false, benchedFor = "";
const brainKey = () => brainModel() + "|" + (() => { try { return fs.readFileSync(path.join(DATA, ".brain-pid"), "utf8").trim(); } catch { return ""; } })();
const speedKnown = () => speed.model === brainModel() && speed.basis > 0;
async function benchBrain() {
  const key = brainKey();
  if (speedKnown()) { benchedFor = key; return; }                        // already measured for this model (kept between restarts)
  if (benchRunning || warmAbort || inFlight || benchedFor === key) return;
  benchRunning = true;
  const c = warmAbort = new AbortController();
  try {
    cacheSys = "";
    const filler = "The quick brown robot rolls across the kitchen floor, looks at the cat, and wonders what to say next. ".repeat(9);
    const { r } = await llamaPost({ messages: [{ role: "user", content: `Note ${Math.floor(Math.random() * 1e9)}. ${filler}\nCount from one to ten in words.` }], max_tokens: 16, temperature: 0.5, stream: false }, 120000, c.signal);
    if (r?.ok) { const j = await r.json().catch(() => ({})); noteSpeed(j.timings); benchedFor = key; log({ kind: "brain", detail: `offline brain speed on this phone: reads ${speed.read || "?"} and writes ${speed.write || "?"} tokens a second` }); }
  } catch {} finally { benchRunning = false; if (warmAbort === c) warmAbort = null; }
}
// Have the brain read her standing notes ahead of time (it keeps them in its cache), so the first real
// question only has to read the question. Stopped the moment a real question arrives.
async function warmBrain(system) {
  if (!system) return { ok: false };
  if (warmAbort || inFlight) return { ok: false, busy: warmAbort ? "warming or measuring already" : "answering" };
  const st = await localState();
  if (st !== "ok") return { ok: false, busy: "brain is " + st };
  if (!speedKnown()) { benchBrain(); return { ok: false, measuring: true }; }           // know the speed first: it decides how much she gets to read
  const nctx = await localCtx(), b = budgets(nctx, 220), content = fitSystem(system, b.sys);
  const key = sysHash(content);
  if (key === cacheSys) return { ok: true, already: true };
  const c = warmAbort = new AbortController(), t0 = Date.now();
  try {
    const { r } = await llamaPost({ messages: [{ role: "system", content }, { role: "user", content: "Hi." }], max_tokens: 1, stream: false, cache_prompt: true }, 240000, c.signal);
    if (!r?.ok) return { ok: false };
    const j = await r.json().catch(() => ({})); noteSpeed(j.timings); cacheSys = key;
    return { ok: true, ms: Date.now() - t0, tokens: j.timings?.prompt_n };
  } catch { return { ok: false, interrupted: c.signal.aborted }; }
  finally { if (warmAbort === c) warmAbort = null; }
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

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".mjs": "text/javascript", ".wasm": "application/wasm", ".task": "application/octet-stream", ".tflite": "application/octet-stream" };

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
      const [online, lstate, hearing] = await Promise.all([checkOnline(), localState(), hearingState()]);
      const local = lstate === "ok";
      if (lstate === "down") startBrain("status check found it down");
      const keys = apiKeys();
      const gkeys = geminiKeys();
      return send(res, 200, { online, local, localState: lstate, localError: lastLocalError || undefined, localSpeed: speed.read ? { read: speed.read, write: speed.write } : undefined, localModel: brainModel() || undefined, tuning: tuning() || undefined, localRoom: Math.floor((budgets(localProps.n_ctx, 220).sys - 8) * 3.2), localChatRoom: Math.floor(budgets(localProps.n_ctx, 220).chat * 3.2), hearing, remote: !!config().remote, hasKey: keys.length > 0, keyCount: keys.length, keyInUse: keys.length ? Math.min(activeKey, keys.length - 1) + 1 : 0,
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
        notifications: ["termux-notification-list", [], 8000],
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
        notifications: "Android Settings > Notifications > Device & app notifications (Notification access) > Termux:API > Allow",
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
    if (p === "/api/phone/routines" && req.method === "GET") return send(res, 200, { routines: phone.listRoutines() });
    if (p === "/api/phone/routines" && req.method === "DELETE") return send(res, 200, { forgotten: phone.forgetRoutine(url.searchParams.get("goal") || "") });
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
      const gone = new AbortController(); res.on("close", () => { if (!res.writableEnded) gone.abort(); });
      if (tuning()) return send(res, 503, { error: "The offline brain is being tuned right now (robot-tune). It'll be back in a few minutes." });
      if (!(await waitForBrain(120000, gone.signal))) return send(res, 503, { error: "The offline brain isn't running and wouldn't start. In Termux run: robot-doctor" });
      const { r, error } = await localChat(body, false, gone.signal);
      if (error) return send(res, 502, { error: "The offline brain refused: " + error });
      const j = await r.json().catch(() => ({}));
      noteSpeed(j.timings);
      return send(res, 200, { text: j.choices?.[0]?.message?.content || "", timings: j.timings && { read: j.timings.prompt_n, readPerSec: j.timings.prompt_per_second, cached: j.timings.cache_n, wrote: j.timings.predicted_n, writePerSec: j.timings.predicted_per_second } });
    }
    if (p === "/api/local/warm" && req.method === "POST") {
      const body = await readBody(req);
      return send(res, 200, await warmBrain(body.system));
    }

    // ---- offline brain, streamed: words arrive as they're generated so she can start talking sooner ----
    if (p === "/api/local-stream" && req.method === "POST") {
      const body = await readBody(req);
      const gone = new AbortController(); res.on("close", () => { if (!res.writableEnded) gone.abort(); });
      if (tuning()) return send(res, 503, { error: "The offline brain is being tuned right now (robot-tune). It'll be back in a few minutes." });
      if (!(await waitForBrain(120000, gone.signal))) return send(res, 503, { error: "The offline brain isn't running and wouldn't start. In Termux run: robot-doctor" });
      const { r, error } = await localChat(body, true, gone.signal);
      if (error || !r.body) return send(res, 502, { error: "The offline brain refused: " + (error || "empty answer") });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      let tail = "";
      try { for await (const chunk of r.body) { res.write(chunk); tail = (tail + Buffer.from(chunk).toString("utf8")).slice(-3000); } } catch {}
      const m = tail.match(/"timings":(\{[^{}]*\})/);                    // the last piece says how fast it went
      if (m) try { noteSpeed(JSON.parse(m[1])); } catch {}
      return res.end();
    }

    // ---- offline hearing: a WAV clip in, the words out ----
    if (p === "/api/hear" && req.method === "POST") {
      const wav = await readRaw(req, 6 * 1024 * 1024);
      const t0 = Date.now();
      const text = await transcribe(wav);
      if (text === null) return send(res, 503, { error: "Offline hearing isn't installed. In Termux run: robot-hearing-setup" });
      return send(res, 200, { text, ms: Date.now() - t0 });
    }
    // ---- offline reading: printed text in a camera picture, via tesseract (pkg install tesseract) ----
    if (p === "/api/ocr" && req.method === "POST") {
      const img = await readRaw(req, 12 * 1024 * 1024);
      const tmp = path.join(os.tmpdir(), `nessari-ocr-${Date.now()}.jpg`);
      fs.writeFileSync(tmp, img);
      try {
        let text = await run("tesseract", [tmp, "stdout", "-l", "eng", "--psm", "3"], 40000);
        if (text === null) return send(res, 503, { error: "The text reader isn't installed. In Termux run: pkg install tesseract" });
        if (text.replace(/[^a-z0-9]/gi, "").length < 3) text = (await run("tesseract", [tmp, "stdout", "-l", "eng", "--psm", "11"], 40000)) || "";   // sparse text: signs, labels
        // keep lines that look like words, drop the specks OCR makes out of texture
        const lines = text.split("\n").map(l => l.trim()).filter(l => l.replace(/[^a-z0-9]/gi, "").length >= 2 && l.replace(/[^a-z0-9 ]/gi, "").length / l.length > 0.6);
        return send(res, 200, { text: lines.join("\n") });
      } finally { fs.rmSync(tmp, { force: true }); }
    }
    // ---- offline voice: the phone's own text-to-speech, for when Chrome's voice needs the internet ----
    if (p === "/api/say" && req.method === "POST") {
      const body = await readBody(req);
      const text = String(body.text || "").slice(0, 1500); if (!text) return send(res, 200, { ok: true });
      const args = ["-r", String(Math.min(3, Math.max(0.3, Number(body.rate) || 1))), "-p", String(Math.min(2, Math.max(0.1, Number(body.pitch) || 1))), text];
      const out = await run("termux-tts-speak", args, 15000 + text.length * 150);
      if (out === null) return send(res, 503, { error: "The phone's text-to-speech didn't answer (Termux:API)" });
      return send(res, 200, { ok: true });
    }
    if (p === "/api/say/stop" && req.method === "POST") { run("pkill", ["-f", "termux-tts-speak"], 3000); return send(res, 200, { ok: true }); }

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
phone.init({ dataDir: DATA, apiKeys, geminiKeys, geminiModels, timedFetch, log, config: () => ({ ...config(), port: PORT }), GEMINI_BASE,
  CLAUDE_URL: process.env.ROBOT_CLAUDE_URL || "https://api.anthropic.com/v1/messages" });
// Listens on all interfaces so the optional remote page works; everything except /remote is refused
// for other devices (see the isLocal check at the top of the handler).
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Darkly robot brain on http://127.0.0.1:${PORT}  (files: ${DATA})`);
  log({ kind: "boot", port: PORT });
});
