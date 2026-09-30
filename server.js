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

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.ROBOT_DATA || path.join(ROOT, "data");
const PUBLIC = path.join(ROOT, "public");
const LOG_FILE = path.join(DATA, "logs", "robot-log.jsonl");

fs.mkdirSync(path.join(DATA, "logs"), { recursive: true });

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

function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  for (const f of [path.join(os.homedir(), ".robot-key"), path.join(DATA, ".key")]) {
    try { const k = fs.readFileSync(f, "utf8").trim(); if (k) return k; } catch {}
  }
  return "";
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

let hwCache = { at: 0, data: null }, sensorList = null;
async function hardware(force = false) {
  if (!force && Date.now() - hwCache.at < 4000 && hwCache.data) return hwCache.data;
  if (sensorList === null) {
    const l = parseJson(await run("termux-sensor", ["-l"], 8000));
    sensorList = l?.sensors || [];
  }
  const [sens, batt] = await Promise.all([
    sensorList.length ? run("termux-sensor", ["-a", "-n", "1"], 8000) : null,
    run("termux-battery-status", [], 5000)
  ]);
  // termux-sensor prints one JSON object per reading
  let readings = {};
  if (sens) { const m = sens.match(/\{[\s\S]*\}/); readings = parseJson(m?.[0]) || {}; }
  const simple = {};
  for (const [name, v] of Object.entries(readings)) simple[name] = (v.values || []).map(x => +Number(x).toFixed(2));
  const load = os.loadavg()[0];
  hwCache = { at: Date.now(), data: {
    termuxApi: sensorList.length > 0,
    sensorCount: sensorList.length, sensors: simple,
    battery: parseJson(batt),
    memory: memInfo(), disk: diskInfo(),
    cpu: { cores: os.cpus().length, load: +load.toFixed(2), hottestC: cpuTemps() },
    uptimeMin: Math.round(os.uptime() / 60)
  } };
  return hwCache.data;
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    // ---- status ----
    if (p === "/api/status") {
      const [online, local] = await Promise.all([checkOnline(), checkLocal()]);
      return send(res, 200, { online, local, hasKey: !!apiKey(), model: config().claudeModel, time: new Date().toISOString() });
    }

    // ---- every sensor + RAM/storage/CPU ----
    if (p === "/api/hw") return send(res, 200, await hardware(url.searchParams.has("fresh")));
    if (p === "/api/hw/extra") {
      // on-demand phone abilities through Termux:API
      const what = url.searchParams.get("what");
      const cmds = {
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
      if (out === null) return send(res, 503, { error: "Termux:API not installed or permission missing" });
      return send(res, 200, { what, result: parseJson(out) ?? out.trim() ?? "ok" });
    }

    // ---- online brain: Claude ----
    if (p === "/api/claude" && req.method === "POST") {
      const key = apiKey();
      if (!key) return send(res, 400, { error: "No Claude API key. Put it in ~/.robot-key" });
      const body = await readBody(req);
      const payload = { model: config().claudeModel, max_tokens: 1024, ...body };
      const r = await timedFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(payload)
      }, 90000);
      const text = await r.text();
      if (!r.ok) log({ kind: "error", where: "claude", status: r.status, detail: text.slice(0, 300) });
      res.writeHead(r.status, { "Content-Type": "application/json" });
      return res.end(text);
    }

    // ---- offline brain: local llama-server (Nessari) ----
    if (p === "/api/local" && req.method === "POST") {
      const body = await readBody(req);
      const r = await timedFetch(config().localUrl + "/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: body.messages, max_tokens: body.max_tokens || 300, temperature: 0.8, stream: false })
      }, 180000);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return send(res, 502, { error: "Local brain error", detail: j });
      return send(res, 200, { text: j.choices?.[0]?.message?.content || "" });
    }

    // ---- files ----
    if (p === "/api/files" && req.method === "GET") {
      const target = safePath(url.searchParams.get("path") || "");
      const st = fs.statSync(target);
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
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Darkly robot brain on http://127.0.0.1:${PORT}  (files: ${DATA})`);
  log({ kind: "boot", port: PORT });
});
