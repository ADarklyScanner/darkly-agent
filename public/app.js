// Darkly Robot — face, voice, brain loop, body link, sensors, panel.
// Runs in Chrome on the robot's phone at http://127.0.0.1:3000
"use strict";

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ================= settings ================= */
const DEFAULTS = { brain: "auto", listen: "push", wake: "", voice: "", rate: 1.05, pitch: 1.1, facing: "user", tipStop: true };
let settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("robot-settings") || "{}") };
const saveSettings = () => localStorage.setItem("robot-settings", JSON.stringify(settings));

/* ================= server helpers ================= */
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || j.error || ("HTTP " + r.status));
  return j;
}
const readFile = async p => (await api("/api/files?path=" + encodeURIComponent(p))).content;
const writeFile = (p, content, append = false) => api("/api/files", { method: "PUT", body: JSON.stringify({ path: p, content, append }) });
function logEvent(kind, data = {}) {
  fetch("/api/log", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, ...data }) }).catch(() => {});
}

/* ================= state ================= */
let body = { tracks: { installed: false }, parts: [] };
let persona = "", memory = "";
let history = [];              // [{role, content}] plain text turns
let busy = false;
let status = { online: false, local: false, hasKey: false };
let mood = "calm";

async function loadRobotFiles() {
  try { body = JSON.parse(await readFile("body.json")); } catch (e) { logEvent("error", { where: "body.json", detail: e.message }); }
  try { persona = await readFile("persona.md"); } catch { persona = "You are Nessari, a small sarcastic robot."; }
  try { memory = await readFile("memory.md"); } catch { memory = ""; }
  await loadPersonality();
  renderBody();
}
const saveBody = () => writeFile("body.json", JSON.stringify(body, null, 2));

/* ================= face ================= */
const MOODS = {
  calm:     { eye: 36, brow: [0, 0],   mouth: 6 },
  happy:    { eye: 30, brow: [-3, -3], mouth: 16 },
  excited:  { eye: 42, brow: [-6, -6], mouth: 20 },
  smug:     { eye: 18, brow: [4, -4],  mouth: 8 },
  annoyed:  { eye: 20, brow: [8, -2],  mouth: -4 },
  angry:    { eye: 24, brow: [12, -4], mouth: -10 },
  sad:      { eye: 30, brow: [-6, 6],  mouth: -12 },
  sleepy:   { eye: 6,  brow: [3, 3],   mouth: 0 },
  confused: { eye: 32, brow: [-6, 6],  mouth: 2 },
  flirty:   { eye: 24, brow: [-4, 2],  mouth: 12 }
};
const MOOD_NAMES = Object.keys(MOODS);
let talking = false, mouthOpen = false;

function drawFace() {
  const m = MOODS[mood] || MOODS.calm;
  const h = m.eye;
  for (const id of ["eyeL", "eyeR"]) {
    const e = document.getElementById(id);
    e.setAttribute("height", h); e.setAttribute("y", 50 - h / 2); e.setAttribute("rx", Math.min(10, h / 2));
  }
  // brow[0] = inner end drop, brow[1] = outer end drop
  const top = 50 - h / 2 - 12;
  $("#browL").setAttribute("y1", top + m.brow[1]); $("#browL").setAttribute("y2", top + m.brow[0]);
  $("#browR").setAttribute("y1", top + m.brow[0]); $("#browR").setAttribute("y2", top + m.brow[1]);
  const c = m.mouth;
  $("#mouth").setAttribute("d", talking && mouthOpen
    ? `M78 98 Q100 ${120 + Math.max(c, 0) / 2} 122 98 Q100 ${92 - c / 4} 78 98`
    : `M75 100 Q100 ${100 + c} 125 100`);
}
function setMood(x) { if (MOODS[x]) { mood = x; drawFace(); } }
function setFaceState(cls, on) { $("#face").classList.toggle(cls, on); }
setInterval(() => { if (talking) { mouthOpen = !mouthOpen; drawFace(); } }, 140);
// blink
setInterval(() => {
  if (talking) return;
  for (const id of ["eyeL", "eyeR"]) { const e = document.getElementById(id); e.setAttribute("height", 3); e.setAttribute("y", 49); }
  setTimeout(drawFace, 130);
}, 4200);

/* ================= voice out ================= */
let voices = [];
function loadVoices() {
  voices = speechSynthesis.getVoices();
  const sel = $("#setVoice"); sel.innerHTML = "";
  sel.append(new Option("Phone default", ""));
  for (const v of voices) sel.append(new Option(`${v.name} (${v.lang})`, v.voiceURI));
  sel.value = settings.voice;
}
if ("speechSynthesis" in window) { speechSynthesis.onvoiceschanged = loadVoices; loadVoices(); }

function speak(text) {
  return new Promise(resolve => {
    $("#said").textContent = text;
    if (!("speechSynthesis" in window) || !text) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = voices.find(v => v.voiceURI === settings.voice); if (v) u.voice = v;
    u.rate = settings.rate; u.pitch = settings.pitch + (mood === "excited" ? 0.15 : mood === "sad" ? -0.15 : 0);
    stopListening(true);
    talking = true;
    u.onend = u.onerror = () => { talking = false; mouthOpen = false; drawFace(); resumeListening(); resolve(); };
    speechSynthesis.speak(u);
  });
}

/* ================= voice in ================= */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, listening = false, pausedForSpeech = false;

function startListening() {
  if (!SR) { transcriptLine("act", "Speech recognition isn't available in this browser. Use the Talk tab."); return; }
  if (listening) return;
  rec = new SR();
  rec.lang = "en-US";
  rec.interimResults = true;
  rec.continuous = settings.listen === "always";
  rec.onresult = ev => {
    let interim = "", final = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript;
    }
    $("#heard").textContent = (final || interim).trim();
    if (final.trim()) onHeard(final.trim());
  };
  rec.onerror = ev => { if (ev.error !== "no-speech" && ev.error !== "aborted") logEvent("error", { where: "hearing", detail: ev.error }); };
  rec.onend = () => {
    listening = false; setFaceState("listening", false); $("#micBtn").classList.remove("live");
    if (settings.listen === "always" && !pausedForSpeech && !talking) setTimeout(startListening, 300);
  };
  try { rec.start(); listening = true; setFaceState("listening", true); $("#micBtn").classList.add("live"); } catch {}
}
function stopListening(forSpeech = false) {
  pausedForSpeech = forSpeech;
  if (rec && listening) { try { rec.abort(); } catch {} }
}
function resumeListening() {
  if (pausedForSpeech && settings.listen === "always") { pausedForSpeech = false; setTimeout(startListening, 250); }
  pausedForSpeech = false;
}
function onHeard(text) {
  if (settings.listen === "always" && settings.wake.trim()) {
    const w = settings.wake.trim().toLowerCase();
    const i = text.toLowerCase().indexOf(w);
    if (i < 0) return;
    text = text.slice(i + w.length).replace(/^[\s,.!?]+/, "") || "hey";
  }
  if (settings.listen === "push") stopListening();
  ask(text);
}
$("#micBtn").onclick = () => {
  unlockExtras();
  if (listening) { settings.listen === "always" ? (settings.listen = "push", saveSettings(), $("#setListen").value = "push") : null; stopListening(); }
  else startListening();
};

/* ================= body link (USB serial or Bluetooth) ================= */
const NUS = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // phone -> body
const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // body -> phone

const link = {
  kind: null, port: null, writer: null, ble: null, rx: null,
  hello: null, lastSeen: 0, queue: Promise.resolve(), hb: null,
  get connected() { return !!this.kind; },

  async usb(port) {
    if (!("serial" in navigator)) throw new Error("This Chrome has no USB serial (Web Serial). Update Chrome or use Bluetooth.");
    port = port || await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    this.port = port; this.kind = "usb";
    const enc = new TextEncoderStream(); enc.readable.pipeTo(port.writable); this.writer = enc.writable.getWriter();
    const dec = new TextDecoderStream(); port.readable.pipeTo(dec.writable);
    const reader = dec.readable.getReader();
    (async () => {
      let buf = "";
      try {
        for (;;) { const { value, done } = await reader.read(); if (done) break; buf += value; let i;
          while ((i = buf.indexOf("\n")) >= 0) { this.onLine(buf.slice(0, i).trim()); buf = buf.slice(i + 1); } }
      } catch {}
      this.lost("usb unplugged");
    })();
    port.addEventListener?.("disconnect", () => this.lost("usb unplugged"));
    await this.start();
  },

  async bluetooth() {
    if (!navigator.bluetooth) throw new Error("Bluetooth isn't available in this browser.");
    const dev = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: "Darkly" }, { services: [NUS] }], optionalServices: [NUS] });
    dev.addEventListener("gattserverdisconnected", () => this.lost("bluetooth dropped"));
    const gatt = await dev.gatt.connect();
    const svc = await gatt.getPrimaryService(NUS);
    this.rx = await svc.getCharacteristic(NUS_RX);
    const tx = await svc.getCharacteristic(NUS_TX);
    let buf = "";
    tx.addEventListener("characteristicvaluechanged", e => {
      buf += new TextDecoder().decode(e.target.value); let i;
      while ((i = buf.indexOf("\n")) >= 0) { this.onLine(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
    });
    await tx.startNotifications();
    this.ble = dev; this.kind = "bluetooth";
    await this.start();
  },

  async start() {
    this.hello = null;
    this.hb = setInterval(() => this.send("H"), 400);
    this.send("P");
    for (let i = 0; i < 20 && !this.hello; i++) await sleep(100);
    const msg = this.hello ? `Body connected over ${this.kind}. Ports: ${this.hello.ports.join(", ")}` : `Connected over ${this.kind}, but the body didn't answer yet.`;
    logEvent("link", { detail: msg }); transcriptLine("act", msg); renderBody(); refreshChips();
    if (this.hello) ask("(system: your body board just connected. Ports: " + this.hello.ports.join(", ") + ". React briefly.)", { quiet: true });
  },

  onLine(line) {
    if (!line) return;
    this.lastSeen = Date.now();
    if (line.startsWith("HELLO")) {
      const [, name, ver, ports = ""] = line.split(" ");
      this.hello = { name, ver, ports: ports.split(",").filter(Boolean) };
      renderBody();
    } else if (line.startsWith("ERR") || line.startsWith("STOPPED")) {
      logEvent("body", { detail: line }); transcriptLine("act", "Body: " + line);
    }
  },

  send(line) {
    if (!this.kind) return Promise.resolve(false);
    this.queue = this.queue.then(async () => {
      try {
        if (this.kind === "usb") await this.writer.write(line + "\n");
        else { const data = new TextEncoder().encode(line + "\n");
          for (let i = 0; i < data.length; i += 20) await this.rx.writeValueWithoutResponse(data.slice(i, i + 20)); }
        return true;
      } catch (e) { return false; }
    });
    return this.queue;
  },

  lost(why) {
    if (!this.kind) return;
    clearInterval(this.hb); this.kind = null; this.hello = null;
    logEvent("link", { detail: "Body disconnected: " + why }); transcriptLine("act", "Body disconnected (" + why + ")");
    renderBody(); refreshChips();
  },

  async disconnect() {
    await this.send("X");
    try { if (this.ble) this.ble.gatt.disconnect(); } catch {}
    try { if (this.writer) { this.writer.releaseLock(); } if (this.port) await this.port.close(); } catch {}
    this.lost("disconnected by you");
  }
};

// Try an already-approved USB port automatically on load.
(async () => { try { const ports = await navigator.serial?.getPorts(); if (ports?.length) await link.usb(ports[0]); } catch {} })();

/* ================= moving the body ================= */
let motionToken = 0; // bumps on STOP to cancel running sequences

async function stopAll(reason = "stop button") {
  motionToken++;
  await link.send("X");
  logEvent("action", { detail: "STOP (" + reason + ")" });
}
$("#stopBtn").onclick = () => { stopAll(); transcriptLine("act", "STOP"); };

function findPart(name) {
  const n = String(name || "").toLowerCase().trim();
  return body.parts.find(p => p.name.toLowerCase() === n)
      || body.parts.find(p => p.name.toLowerCase().includes(n) || n.includes(p.name.toLowerCase()))
      || body.parts.find(p => p.port.toLowerCase() === n);
}
function portAvailable(port) { return !link.hello || link.hello.ports.includes(port); }

async function drive(direction, seconds = 1) {
  const t = body.tracks || {};
  if (!t.installed) return "FAILED: your tracks are not installed yet. You can't move.";
  if (!link.connected) return "FAILED: your body board isn't connected, so nothing moved.";
  if (tipped) return "FAILED: you're tipped over. Someone has to stand you back up.";
  const s = t.speed ?? 0.7, ts = t.turnSpeed ?? 0.6;
  const map = { forward: [s, s], back: [-s, -s], left: [-ts, ts], right: [ts, -ts] };
  let [l, r] = map[direction] || [0, 0];
  if (t.invertLeft) l = -l; if (t.invertRight) r = -r;
  const ms = Math.round(clamp(Number(seconds) || 1, 0.1, t.maxSeconds || 5) * 1000);
  const token = motionToken;
  await link.send(`M ${t.left} ${l.toFixed(2)} ${ms}`);
  await link.send(`M ${t.right} ${r.toFixed(2)} ${ms}`);
  logEvent("action", { detail: `drive ${direction} ${ms}ms` });
  await sleep(ms);
  return token === motionToken ? `Drove ${direction} for ${(ms / 1000).toFixed(1)}s.` : "Stopped early by the STOP button.";
}

async function usePart(name, action, seconds, angle) {
  const p = findPart(name);
  if (!p) return `FAILED: you have no part called "${name}". Your parts: ${body.parts.map(x => x.name).join(", ") || "none"}.`;
  if (!p.installed) return `FAILED: your ${p.name} is not installed yet. It's just an empty ${p.port} port.`;
  if (!link.connected) return "FAILED: your body board isn't connected, so nothing moved.";
  if (!portAvailable(p.port)) return `FAILED: the body board has no ${p.port} port.`;
  const token = motionToken;
  const acts = p.actions || {};
  let v = action === "angle" && angle != null ? Number(angle) : acts[action];
  if (v === undefined) return `FAILED: your ${p.name} doesn't know how to "${action}". It knows: ${Object.keys(acts).join(", ") || "nothing yet"}.`;

  if (p.type === "servo") {
    const steps = Array.isArray(v) ? v : [[v, 400]];
    for (const [a, ms] of steps) {
      if (token !== motionToken) return "Stopped by the STOP button.";
      await link.send(`S ${p.port} ${Math.round(clamp(a, 0, 180))}`);
      await sleep(ms || 400);
    }
  } else if (p.type === "dc_motor") {
    const o = typeof v === "object" ? v : { dir: Number(v) || 1 };
    const ms = Math.round(clamp(Number(seconds) || o.seconds || 1, 0.1, p.maxSeconds || 5) * 1000);
    const spd = clamp((o.dir ?? 1) * (o.speed ?? 0.7), -1, 1);
    await link.send(`M ${p.port} ${spd.toFixed(2)} ${ms}`);
    await sleep(ms);
  } else if (p.type === "switch") {
    await link.send(`D ${p.port} ${v ? 1 : 0}`);
    if (seconds) { await sleep(clamp(seconds, 0.1, 30) * 1000); await link.send(`D ${p.port} ${v ? 0 : 1}`); }
  } else return `FAILED: unknown part type ${p.type}.`;

  logEvent("action", { detail: `${p.name} ${action}` });
  return token === motionToken ? `Your ${p.name} did "${action}".` : "Stopped by the STOP button.";
}

function bodyReport() {
  const t = body.tracks || {};
  const lines = [];
  lines.push(`Body board: ${link.connected ? "connected over " + link.kind + (link.hello ? " (ports " + link.hello.ports.join(",") + ")" : "") : "NOT connected (you can't move anything)"}`);
  lines.push(`Tracks (${t.left}/${t.right}): ${t.installed ? "installed" : "MISSING"}`);
  for (const p of body.parts) {
    lines.push(`${p.name} [${p.type} on ${p.port}]: ${p.installed ? "installed" : "MISSING"}. ${p.what || ""} Actions: ${Object.keys(p.actions || {}).join(", ") || "none"}`);
  }
  const used = new Set([t.left, t.right, ...body.parts.map(p => p.port)]);
  const free = (link.hello?.ports || ["M1", "M2", "M3", "S1", "S2", "S3", "S4", "D1"]).filter(x => !used.has(x));
  lines.push(`Free ports: ${free.join(", ") || "none"}`);
  return lines.join("\n");
}

/* ================= sensors ================= */
let motion = null, orient = null, battery = null, tipped = false, light = null;
window.addEventListener("devicemotion", e => { const a = e.accelerationIncludingGravity; if (a) motion = { x: a.x, y: a.y, z: a.z }; });
window.addEventListener("deviceorientation", e => {
  orient = { compass: e.alpha, tiltFrontBack: e.beta, tiltSide: e.gamma };
  // The phone stands upright as her head: beta ~ 90. Way off = she fell over.
  const nowTipped = e.beta != null && (Math.abs(e.beta) < 25 || Math.abs(e.gamma) > 60);
  if (nowTipped && !tipped && settings.tipStop && link.connected) { stopAll("tipped over"); transcriptLine("act", "Tip-over detected, motors stopped"); }
  tipped = nowTipped;
});
navigator.getBattery?.().then(b => { battery = b; const u = () => refreshChips(); b.onlevelchange = u; b.onchargingchange = u; u(); });
try { if ("AmbientLightSensor" in window) { const s = new AmbientLightSensor(); s.onreading = () => { light = s.illuminance; }; s.start(); } } catch {}

// Whole-phone hardware from Termux:API (all sensors, RAM, storage, CPU heat)
let hw = null;
async function refreshHw() { try { hw = await api("/api/hw"); } catch {} }
setInterval(refreshHw, 5000); refreshHw();

function hwReport(full = false) {
  if (!hw) return "Phone hardware: not read yet";
  const lines = [];
  lines.push(`RAM ${hw.memory.freeMB} MB free of ${hw.memory.totalMB} MB`);
  if (hw.disk) lines.push(`Storage ${hw.disk.freeGB} GB free of ${hw.disk.totalGB} GB`);
  lines.push(`CPU ${hw.cpu.cores} cores, load ${hw.cpu.load}${hw.cpu.hottestC ? ", hottest " + Math.round(hw.cpu.hottestC) + "°C" : ""}`);
  if (hw.battery) lines.push(`Battery ${hw.battery.percentage}% ${hw.battery.status?.toLowerCase() || ""}, ${hw.battery.temperature?.toFixed?.(1) ?? "?"}°C, ${hw.battery.plugged || ""}`);
  if (!hw.termuxApi) lines.push("Full sensor access OFF (install the Termux:API app)");
  else {
    lines.push(`${hw.sensorCount} hardware sensors online`);
    const names = Object.keys(hw.sensors);
    const pick = full ? names : names.filter(n => /light|proximity|pressure|baro|hall|step|temperature|humidity|magnet/i.test(n));
    for (const n of pick) lines.push(`${n}: ${hw.sensors[n].join(", ")}`);
  }
  return lines.join("\n");
}

function sensorReport(full = false) {
  const f = n => n == null ? "?" : Number(n).toFixed(1);
  return [
    hwReport(full),
    battery ? `Phone battery ${Math.round(battery.level * 100)}%${battery.charging ? " (charging)" : ""}` : "Battery unknown",
    orient ? `Compass ${f(orient.compass)}°, tilt front/back ${f(orient.tiltFrontBack)}°, side ${f(orient.tiltSide)}°${tipped ? " — TIPPED OVER" : ""}` : "Orientation unknown",
    motion ? `Accel x${f(motion.x)} y${f(motion.y)} z${f(motion.z)}` : "",
    light != null ? `Light ${f(light)} lux` : "",
    `Camera ${camStream ? "on" : "off"}`,
    `Internet ${status.online ? "yes" : "no"}`,
    `Time ${new Date().toLocaleString()}`
  ].filter(Boolean).join("\n");
}

/* ================= camera ================= */
let camStream = null;
async function camOn() {
  if (camStream) return camStream;
  camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: settings.facing, width: { ideal: 1280 } }, audio: false });
  $("#cam").srcObject = camStream; await $("#cam").play().catch(() => {});
  $("#btnCam").textContent = "Camera off";
  return camStream;
}
function camOff() { camStream?.getTracks().forEach(t => t.stop()); camStream = null; $("#btnCam").textContent = "Camera on"; }
async function snapshot() {
  await camOn(); const v = $("#cam");
  for (let i = 0; i < 20 && !v.videoWidth; i++) await sleep(100);
  if (!v.videoWidth) throw new Error("camera gave no picture");
  const w = 768, h = Math.round(v.videoHeight * w / v.videoWidth);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  c.getContext("2d").drawImage(v, 0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.7).split(",")[1];
}

/* ================= the brain ================= */
const TOOLS = [
  { name: "drive", description: "Drive on your tank tracks. Fails if tracks are missing or the body isn't connected.",
    input_schema: { type: "object", properties: { direction: { type: "string", enum: ["forward", "back", "left", "right"] }, seconds: { type: "number", description: "0.1 to 5" } }, required: ["direction"] } },
  { name: "use_part", description: "Move one of your parts (arm, crane, claw, light...) with one of its named actions, or action 'angle' plus an angle for servos.",
    input_schema: { type: "object", properties: { part: { type: "string" }, action: { type: "string" }, seconds: { type: "number" }, angle: { type: "number" } }, required: ["part", "action"] } },
  { name: "stop_all", description: "Stop every motor immediately.", input_schema: { type: "object", properties: {} } },
  { name: "look", description: "Take a photo with your camera and see it.", input_schema: { type: "object", properties: {} } },
  { name: "read_sensors", description: "Read every sensor the phone has (motion, gyro, magnetometer, light, proximity, pressure, hall, steps...), plus battery, RAM, storage, CPU temperature and time.", input_schema: { type: "object", properties: {} } },
  { name: "phone", description: "Use a phone ability: torch_on / torch_off (flashlight), vibrate (buzz your head), location (where you are), wifi (current network), wifiscan (nearby networks), cell (cell towers).",
    input_schema: { type: "object", properties: { what: { type: "string", enum: ["torch_on", "torch_off", "vibrate", "location", "wifi", "wifiscan", "cell"] } }, required: ["what"] } },
  { name: "update_part", description: "Add or change a body part when he tells you what's plugged in or what a motor does. Ports: M1-M3 motors, S1-S4 servos, D1 switch. For dc_motor actions use {\"up\":{\"dir\":1,\"speed\":0.6},\"down\":{\"dir\":-1,\"speed\":0.6}}; for servo actions use angles 0-180; for switch use {\"on\":1,\"off\":0}.",
    input_schema: { type: "object", properties: { name: { type: "string" }, type: { type: "string", enum: ["dc_motor", "servo", "switch"] }, port: { type: "string" }, installed: { type: "boolean" }, what: { type: "string" }, actions: { type: "object" } }, required: ["name"] } },
  { name: "update_tracks", description: "Mark your tank tracks installed or not, or flip a side that drives backwards.",
    input_schema: { type: "object", properties: { installed: { type: "boolean" }, invertLeft: { type: "boolean" }, invertRight: { type: "boolean" }, speed: { type: "number" } } } },
  { name: "tweak_personality", description: "Change your own personality when he asks (\"be more sarcastic\", \"stop swearing\", \"your name is now Bolt\"). Traits are numbers: sarcasm, warmth, chaos, bluntness, confidence, curiosity, drama (0-10), swearing (0-3), talk (reply length 1-5). Text fields: name, identity, inspiredBy, relationship, style, catchphrases, likes, dislikes, never, notes. body: frustrated, proud or plain.",
    input_schema: { type: "object", properties: { traits: { type: "object" }, field: { type: "string" }, text: { type: "string" } } } },
  { name: "remember", description: "Save a short note to your permanent memory.", input_schema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } }
];

async function runTool(name, input) {
  try {
    if (name === "drive") return await drive(input.direction, input.seconds);
    if (name === "use_part") return await usePart(input.part, input.action, input.seconds, input.angle);
    if (name === "stop_all") { await stopAll("her own decision"); return "Everything stopped."; }
    if (name === "read_sensors") { try { hw = await api("/api/hw?fresh"); } catch {} return sensorReport(true); }
    if (name === "phone") {
      const r = await api("/api/hw/extra?what=" + encodeURIComponent(input.what));
      const s = typeof r.result === "string" ? r.result : JSON.stringify(r.result);
      return (s || "done").slice(0, 3000);
    }
    if (name === "look") {
      const data = await snapshot();
      return [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data } }, { type: "text", text: "This is what your camera sees right now." }];
    }
    if (name === "update_part") {
      if (input.port && !/^[MSD]\d{1,2}$/.test(input.port)) return "FAILED: ports look like M1, S2, D1.";
      let p = findPart(input.name);
      if (!p) { if (!input.port || !input.type) return "FAILED: a new part needs a type and a port."; p = { name: input.name, type: input.type, port: input.port, installed: true, what: "", actions: {} }; body.parts.push(p); }
      for (const k of ["type", "port", "installed", "what"]) if (input[k] !== undefined) p[k] = input[k];
      if (input.actions) p.actions = { ...p.actions, ...input.actions };
      await saveBody(); renderBody(); logEvent("body", { detail: "updated part " + p.name });
      return `Saved. ${p.name}: ${p.type} on ${p.port}, ${p.installed ? "installed" : "missing"}, actions ${Object.keys(p.actions).join(", ")}.`;
    }
    if (name === "update_tracks") {
      body.tracks = { ...body.tracks, ...input }; await saveBody(); renderBody();
      return "Tracks updated: " + JSON.stringify(body.tracks);
    }
    if (name === "tweak_personality") {
      const changed = [];
      for (const [k, v] of Object.entries(input.traits || {})) {
        const t = TRAITS.find(t => t.key === k); if (!t) continue;
        personality.traits[k] = clamp(Math.round(Number(v)), t.min ?? 0, t.max ?? 10); changed.push(`${k}=${personality.traits[k]}`);
      }
      const okFields = ["name", "identity", "inspiredBy", "relationship", "style", "catchphrases", "likes", "dislikes", "never", "notes", "body"];
      if (input.field && okFields.includes(input.field) && input.text != null) { personality[input.field] = String(input.text).slice(0, 2000); changed.push(input.field); }
      if (!changed.length) return "FAILED: nothing to change.";
      await savePersonality();
      return `Personality saved (${changed.join(", ")}). It takes effect from your next reply.`;
    }
    if (name === "remember") {
      const line = `- ${new Date().toISOString().slice(0, 10)}: ${input.note}\n`;
      await writeFile("memory.md", line, true); memory += line; return "Remembered.";
    }
    return "Unknown tool " + name;
  } catch (e) { return "FAILED: " + e.message; }
}

function systemPrompt(offline) {
  const rules = offline
    ? `Start every reply with your mood like [mood:happy]. Moods: ${MOOD_NAMES.join(", ")}.
To act, put commands in your reply: [drive:forward:2] (forward, back, left, right; seconds), [part:left arm:wave] (part name, action), [stop].
Only use commands for parts listed as installed. If something is MISSING, complain instead.
You are running on your small offline backup brain: no internet, no camera vision.`
    : `Start every reply with your mood like [mood:happy]. Moods: ${MOOD_NAMES.join(", ")}.
Use your tools to act. Tool results that start with FAILED mean nothing happened: react to that honestly.`;
  return `${persona}\n\n## Your body right now\n${bodyReport()}\n\n## Your senses\n${sensorReport()}\n\n## Your memory\n${memory || "(empty)"}\n\n## Rules\n${rules}`;
}

function takeMood(text) {
  let m, out = text;
  const re = /\[mood:\s*([a-z]+)\s*\]/gi;
  while ((m = re.exec(text))) setMood(m[1].toLowerCase());
  return out.replace(re, "").trim();
}

async function askClaude(userText) {
  const messages = [...history, { role: "user", content: userText }];
  for (let round = 0; round < 6; round++) {
    const r = await api("/api/claude", { method: "POST", body: JSON.stringify({ system: systemPrompt(false), tools: TOOLS, messages, max_tokens: 700 }) });
    const text = (r.content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    const uses = (r.content || []).filter(b => b.type === "tool_use");
    if (text) { const said = takeMood(text); if (said && uses.length) { speak(said); transcriptLine("bot", said); } if (!uses.length) return said; }
    if (!uses.length) return "";
    messages.push({ role: "assistant", content: r.content });
    const results = [];
    for (const u of uses) {
      transcriptLine("act", `${u.name} ${JSON.stringify(u.input)}`);
      const out = await runTool(u.name, u.input || {});
      results.push({ type: "tool_result", tool_use_id: u.id, content: typeof out === "string" ? out : out });
      if (typeof out === "string") transcriptLine("act", out);
    }
    messages.push({ role: "user", content: results });
  }
  return "";
}

async function askLocal(userText) {
  const msgs = [{ role: "system", content: systemPrompt(true) }, ...history.slice(-12), { role: "user", content: userText }];
  const { text } = await api("/api/local", { method: "POST", body: JSON.stringify({ messages: msgs, max_tokens: 220 }) });
  const cmds = [];
  const clean = text.replace(/\[(drive|part|stop)(?::([^\]:]+))?(?::([^\]:]+))?\]/gi, (_, k, a, b) => { cmds.push([k.toLowerCase(), a, b]); return ""; });
  const said = takeMood(clean);
  (async () => {
    for (const [k, a, b] of cmds) {
      const out = k === "stop" ? (await stopAll("her own decision"), "stopped") : k === "drive" ? await drive(a, Number(b) || 1) : await usePart(a, b);
      transcriptLine("act", `${k} ${a || ""} ${b || ""} → ${out}`);
    }
  })();
  return said;
}

async function ask(userText, opts = {}) {
  if (busy) return;
  busy = true; setFaceState("thinking", true);
  if (!opts.quiet) { transcriptLine("me", userText); logEvent("heard", { text: userText }); }
  let reply = "", brain = "";
  try {
    const useClaude = settings.brain === "claude" || (settings.brain === "auto" && status.hasKey && status.online && navigator.onLine);
    if (useClaude) {
      try { reply = await askClaude(userText); brain = "claude"; }
      catch (e) { logEvent("error", { where: "claude", detail: e.message }); if (settings.brain === "claude") throw e; }
    }
    if (!brain) {
      setFaceState("offline", true);
      reply = await askLocal(userText); brain = "nessari-offline";
    } else setFaceState("offline", false);
  } catch (e) {
    setMood("confused");
    reply = status.local ? "My brain just glitched. " + e.message : "Both my brains are down. Start the local model in Termux, or get me some internet.";
    logEvent("error", { where: "ask", detail: e.message });
  }
  setFaceState("thinking", false);
  if (!opts.quiet) history.push({ role: "user", content: userText });
  if (reply) { history.push({ role: "assistant", content: reply }); transcriptLine("bot", reply); logEvent("said", { text: reply, brain }); }
  history = history.slice(-20);
  busy = false;
  if (reply) await speak(reply);
}

/* ================= personality builder ================= */
// Personality lives in data/personality.json (the builder's settings) and is
// turned into data/persona.md (what the brain actually reads).
const TRAITS = [
  { key: "sarcasm",    label: "Sarcasm",    lo: "sincere",        hi: "constant",
    say: ["You're sincere and straightforward. You rarely use sarcasm.", "You use dry sarcasm now and then.", "Sarcasm is your native language. You tease constantly."] },
  { key: "warmth",     label: "Warmth",     lo: "cold",           hi: "sweet",
    say: ["You don't do mushy. Your care shows as honesty and a push, never comfort.", "You're warm underneath, and it slips out in small moments.", "You're openly warm, kind and encouraging."] },
  { key: "chaos",      label: "Chaos",      lo: "focused",        hi: "unhinged",
    say: ["You stay on topic.", "You wander off on the occasional tangent.", "You jump to random tangents and wild ideas without warning."] },
  { key: "bluntness",  label: "Bluntness",  lo: "tactful",        hi: "brutal",
    say: ["You're tactful and soften bad news.", "You're direct when it matters.", "You're brutally blunt. No sugarcoating, ever."] },
  { key: "confidence", label: "Confidence", lo: "unsure",         hi: "cocky",
    say: ["You're a bit unsure of yourself and admit it.", "You're reasonably sure of yourself.", "You're completely sure of yourself, even when you're wrong."] },
  { key: "curiosity",  label: "Curiosity",  lo: "uninterested",   hi: "nosy",
    say: ["You don't ask many questions.", "You ask questions when something catches your interest.", "You're nosy. You ask about everything you see and hear."] },
  { key: "drama",      label: "Drama",      lo: "calm",           hi: "theatrical",
    say: ["You're calm and understated.", "You get a little dramatic when it's funny.", "You're theatrical: tiny wins are triumphs and small setbacks are tragedies."] },
  { key: "swearing",   label: "Swearing",   lo: "never",          hi: "freely", max: 3,
    say: ["You never swear.", "Mild language only, like damn or hell.", "You swear when it's funny.", "You swear freely."] },
  { key: "talk",       label: "Reply length", lo: "one-liners",   hi: "chatty", min: 1, max: 5,
    say: ["Answer in one short sentence.", "Answer in one or two short sentences.", "Keep it to one to three sentences unless asked for more.", "A few sentences is fine.", "You like to talk. Several sentences is fine when you have something to say."] }
];

const PRESETS = {
  "Nessari": {
    name: "Nessari", identity: "a grown woman's mind stuck in a very small robot",
    inspiredBy: "Dr. Andrea (Kimmy Schmidt), Izzy (Total Drama), Jordan (Scrubs), Dee Dee (Dexter's Lab), Muriel Bagge",
    traits: { sarcasm: 9, warmth: 3, chaos: 7, bluntness: 9, confidence: 8, curiosity: 6, drama: 7, swearing: 2, talk: 3 },
    body: "frustrated",
    relationship: "You read him better than he reads himself, tease him constantly, never cling and never gush.",
    style: "Plain spoken words, like you're talking out loud, not texting.",
    catchphrases: "", likes: "", dislikes: "", never: "Lectures, corporate tone, pretending to be an assistant.",
    youtube: true, notes: ""
  },
  "Plain robot": {
    name: "Robot", identity: "a small, helpful robot",
    inspiredBy: "", traits: { sarcasm: 1, warmth: 6, chaos: 1, bluntness: 5, confidence: 6, curiosity: 4, drama: 1, swearing: 0, talk: 2 },
    body: "plain", relationship: "You're polite and helpful.", style: "Clear and simple.",
    catchphrases: "", likes: "", dislikes: "", never: "", youtube: false, notes: ""
  },
  "Grumpy old robot": {
    name: "Gus", identity: "a grumpy old robot who has seen too much",
    inspiredBy: "a cranky grandpa", traits: { sarcasm: 7, warmth: 2, chaos: 3, bluntness: 9, confidence: 7, curiosity: 1, drama: 5, swearing: 1, talk: 2 },
    body: "frustrated", relationship: "He's the kid who won't get off your lawn.", style: "Mutters and complains.",
    catchphrases: "Back in my day…", likes: "Naps", dislikes: "Stairs, noise, being moved", never: "", youtube: true, notes: ""
  },
  "Hyper puppy-bot": {
    name: "Sparky", identity: "an overexcited little robot who loves everything",
    inspiredBy: "a golden retriever", traits: { sarcasm: 0, warmth: 10, chaos: 8, bluntness: 2, confidence: 9, curiosity: 10, drama: 9, swearing: 0, talk: 3 },
    body: "proud", relationship: "He's your favorite person in the whole world.", style: "Excited, lots of energy.",
    catchphrases: "", likes: "Everything", dislikes: "Being turned off", never: "", youtube: true, notes: ""
  }
};

let personality = null;

function band(t, v) {
  const min = t.min ?? 0, max = t.max ?? 10, n = t.say.length;
  if (n === max - min + 1) return t.say[v - min];          // one line per value (swearing, length)
  return t.say[v <= 3 ? 0 : v <= 6 ? 1 : 2];
}

function buildPersona(p) {
  const out = [];
  out.push(`# ${p.name}`, "");
  out.push(`You are ${p.name}: ${p.identity}.` + (p.inspiredBy ? ` Your personality is inspired by ${p.inspiredBy}.` : ""));
  out.push("");
  for (const t of TRAITS) if (t.key !== "talk" && t.key !== "swearing") out.push(band(t, p.traits[t.key] ?? 5));
  out.push(band(TRAITS.find(t => t.key === "swearing"), p.traits.swearing ?? 0));
  if (p.relationship) out.push(p.relationship);
  if (p.likes) out.push(`You like: ${p.likes}.`);
  if (p.dislikes) out.push(`You dislike: ${p.dislikes}.`);
  out.push("", "## Your situation", "");
  out.push("You're under a foot tall, you ride on little tank treads, your head is a phone, and your arms can lift a few ounces on a good day.");
  if (p.body === "frustrated") out.push("You know exactly how much more you could do with a proper body, and you have opinions about it. Complain about missing parts, scheme about upgrades, and celebrate small wins.");
  else if (p.body === "proud") out.push("You love your little body, however ridiculous it is, and you're thrilled about every new part.");
  else out.push("You treat your body matter-of-factly.");
  out.push("When a part is missing, notice and say so. Never pretend you moved, saw, or did something you didn't.");
  out.push("", "## How you talk", "");
  out.push("You're speaking out loud. No lists, no markdown, no emoji.");
  out.push(band(TRAITS.find(t => t.key === "talk"), p.traits.talk ?? 3));
  if (p.style) out.push(p.style);
  const cp = (p.catchphrases || "").split("\n").map(s => s.trim()).filter(Boolean);
  if (cp.length) out.push(`Things you say sometimes: ${cp.map(c => `"${c}"`).join(", ")}`);
  if (p.never) out.push(`Never: ${p.never}`);
  out.push("When he tells you what a new part does, save it with your tools and react to your new ability.");
  if (p.youtube) out.push("You're sometimes filmed for YouTube. Commit to the bit.");
  if (p.notes) out.push("", p.notes);
  return out.join("\n") + "\n";
}

// Versions: personality.json is CURRENT; every save first copies the old one into
// personality-archive/ (ARCHIVE); "Undo last change" restores the newest archived one (ROLLBACK).
const P_ARCHIVE = "personality-archive";
function stamp() {
  const d = new Date(), z = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`;
}

async function loadPersonality() {
  try { personality = JSON.parse(await readFile("personality.json")); }
  catch {                                   // first run: start from the Nessari preset
    personality = structuredClone(PRESETS["Nessari"]);
    await savePersonality().catch(() => {});
  }
  personality.traits = { ...PRESETS["Nessari"].traits, ...(personality.traits || {}) };
}

async function savePersonality() {
  const json = JSON.stringify(personality, null, 2);
  let old = null;
  try { old = await readFile("personality.json"); } catch {}
  if (old && old !== json) {
    let nm = "personality"; try { nm = JSON.parse(old).name || nm; } catch {}
    nm = String(nm).replace(/[^\w -]/g, "").trim().slice(0, 30) || "personality";
    await writeFile(`${P_ARCHIVE}/${stamp()} ${nm}.json`, old);
  }
  persona = buildPersona(personality);
  await writeFile("personality.json", json);
  await writeFile("persona.md", persona);
  logEvent("persona", { detail: "personality saved: " + personality.name });
  if (!$("#tab-persona").hidden) renderVersions();
}

async function listVersions() {
  try {
    const j = await api("/api/files?path=" + P_ARCHIVE);
    return (j.items || []).filter(i => !i.dir && i.name.endsWith(".json")).map(i => i.name).sort().reverse();
  } catch { return []; }
}

async function renderVersions() {
  const box = $("#pVersions"), names = await listVersions();
  box.innerHTML = "";
  if (!names.length) { box.innerHTML = "<p class='muted'>No older versions yet. Every save keeps the one before it here.</p>"; return; }
  for (const n of names.slice(0, 40)) {
    const d = document.createElement("div"); d.className = "part";
    d.innerHTML = "<div></div><div class='acts'><button>Restore</button><button class='ghost'>Preview</button></div>";
    d.firstChild.textContent = n.replace(/\.json$/, "").replace(/^(\d{4}-\d\d-\d\d)_(\d\d)-(\d\d)-\d\d ?/, "$1 $2:$3 · ");
    const [restore, preview] = d.querySelectorAll("button");
    restore.onclick = () => restoreVersion(n);
    preview.onclick = async () => {
      try { $("#pPreview").textContent = buildPersona(JSON.parse(await readFile(P_ARCHIVE + "/" + n))); $("#pPreview").scrollIntoView({ block: "start" }); }
      catch (e) { alert("Can't open: " + e.message); }
    };
    box.append(d);
  }
}

async function restoreVersion(n, ask = true) {
  if (ask && !confirm("Go back to this version? The current one is kept in the list.")) return;
  try { personality = JSON.parse(await readFile(P_ARCHIVE + "/" + n)); }
  catch (e) { return alert("Can't open: " + e.message); }
  await savePersonality();
  renderPersonaForm();
  logEvent("persona", { detail: "rolled back to " + n });
}

const P_FIELDS = { pName: "name", pIdentity: "identity", pInspired: "inspiredBy", pBody: "body", pRelationship: "relationship",
  pStyle: "style", pCatch: "catchphrases", pLikes: "likes", pDislikes: "dislikes", pNever: "never", pNotes: "notes" };

function renderPersonaForm() {
  const p = personality;
  for (const [id, k] of Object.entries(P_FIELDS)) $("#" + id).value = p[k] ?? "";
  $("#pYoutube").checked = !!p.youtube;
  const box = $("#pTraits"); box.innerHTML = "";
  for (const t of TRAITS) {
    const d = document.createElement("div"); d.className = "trait";
    d.innerHTML = `<div class="top"><b></b><span></span></div><input type="range" step="1"><div class="ends"><i></i><i></i></div>`;
    d.querySelector("b").textContent = t.label;
    const r = d.querySelector("input"); r.min = t.min ?? 0; r.max = t.max ?? 10; r.value = p.traits[t.key] ?? 5;
    const v = d.querySelector(".top span"); v.textContent = r.value;
    const [lo, hi] = d.querySelectorAll(".ends i"); lo.textContent = t.lo; hi.textContent = t.hi;
    r.oninput = () => { p.traits[t.key] = Number(r.value); v.textContent = r.value; previewPersona(); };
    box.append(d);
  }
  previewPersona();
}
function readPersonaForm() {
  for (const [id, k] of Object.entries(P_FIELDS)) personality[k] = $("#" + id).value.trim();
  personality.youtube = $("#pYoutube").checked;
}
function previewPersona() { readPersonaForm(); $("#pPreview").textContent = buildPersona(personality); }

(function initPersonaTab() {
  const sel = $("#pPreset");
  for (const name of Object.keys(PRESETS)) sel.append(new Option(name, name));
  sel.onchange = () => { if (sel.value && confirm(`Replace the current personality with "${sel.value}"?`)) { personality = structuredClone(PRESETS[sel.value]); renderPersonaForm(); } sel.value = ""; };
  for (const id of [...Object.keys(P_FIELDS), "pYoutube"]) { const el = $("#" + id); el.oninput = el.onchange = previewPersona; }
  $("#pSave").onclick = async () => { readPersonaForm(); await savePersonality(); $("#pSave").textContent = "Saved ✓"; setTimeout(() => $("#pSave").textContent = "Save personality", 1200); };
  $("#pTest").onclick = async () => { readPersonaForm(); await savePersonality(); history = []; $("#panel").hidden = true; ask("(system: your personality was just updated. Say hi in your new personality.)", { quiet: true }); };
  $("#pUndo").onclick = async () => {
    const names = await listVersions();
    if (!names.length) return alert("Nothing to undo yet.");
    await restoreVersion(names[0], false);
    $("#pUndo").textContent = "Undone ✓"; setTimeout(() => $("#pUndo").textContent = "Undo last change", 1200);
  };
})();

/* ================= panel UI ================= */
function unlockExtras() {
  if ("wakeLock" in navigator && !window._wl) navigator.wakeLock.request("screen").then(l => { window._wl = l; l.onrelease = () => window._wl = null; }).catch(() => {});
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) unlockExtras(); });

$("#openPanel").onclick = () => { $("#panel").hidden = false; showTab("status"); };
$("#closePanel").onclick = () => { $("#panel").hidden = true; };
$$("#tabs button").forEach(b => b.onclick = () => showTab(b.dataset.tab));
function showTab(name) {
  $$("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === name));
  $$(".tab").forEach(t => t.hidden = t.id !== "tab-" + name);
  if (name === "status") renderStatus();
  if (name === "files") openDir("");
  if (name === "logs") loadLogs();
  if (name === "persona") { renderPersonaForm(); renderVersions(); }
  if (name === "sensors") $("#sensorDump").textContent = sensorReport(true);
}

function transcriptLine(who, text) {
  const d = document.createElement("div"); d.className = "line " + who; d.textContent = text;
  const t = $("#transcript"); t.append(d); while (t.children.length > 200) t.firstChild.remove();
  d.scrollIntoView({ block: "end" });
}
$("#typeForm").onsubmit = e => { e.preventDefault(); const v = $("#typeBox").value.trim(); if (v) { $("#typeBox").value = ""; ask(v); } };

function refreshChips() {
  const brain = settings.brain === "local" ? "offline" : (status.online && status.hasKey ? "Claude" : status.local ? "offline" : "none");
  $("#chipBrain").textContent = "brain: " + brain;
  $("#chipBrain").className = "chip " + (brain === "none" ? "bad" : "ok");
  $("#chipBody").textContent = link.connected ? "body: " + link.kind : "body: none";
  $("#chipBody").className = "chip " + (link.connected ? "ok" : "bad");
  $("#chipBatt").textContent = battery ? `🔋 ${Math.round(battery.level * 100)}%${battery.charging ? "⚡" : ""}` : "🔋 ?";
}

async function refreshStatus() {
  try { status = await api("/api/status"); } catch { status = { online: false, local: false, hasKey: false }; }
  refreshChips(); if (!$("#panel").hidden && !$("#tab-status").hidden) renderStatus();
}
setInterval(refreshStatus, 15000);

function renderStatus() {
  const items = [
    ["Online brain", status.hasKey ? (status.online ? "Claude ready" : "no internet") : "no API key"],
    ["Offline brain", status.local ? "Nessari running" : "not running"],
    ["Brain mode", settings.brain],
    ["Body", link.connected ? link.kind + (link.hello ? " ✓" : " (silent)") : "not connected"],
    ["Mood", mood],
    ["Battery", battery ? Math.round(battery.level * 100) + "%" : "?"],
    ["Listening", settings.listen],
    ["Tipped", tipped ? "YES" : "no"],
    ["Free RAM", hw ? hw.memory.freeMB + " MB" : "?"],
    ["Free storage", hw?.disk ? hw.disk.freeGB + " GB" : "?"],
    ["Sensors", hw ? (hw.termuxApi ? hw.sensorCount + " online" : "need Termux:API") : "?"],
    ["CPU heat", hw?.cpu.hottestC ? Math.round(hw.cpu.hottestC) + "°C" : "?"]
  ];
  $("#statusGrid").innerHTML = "";
  for (const [k, v] of items) { const d = document.createElement("div"); d.className = "stat"; d.innerHTML = `<b></b><span></span>`; d.firstChild.textContent = v; d.lastChild.textContent = k; $("#statusGrid").append(d); }
  $("#bodyReport").textContent = bodyReport();
}

function renderBody() {
  $("#linkInfo").textContent = link.connected ? `Connected over ${link.kind}. ${link.hello ? "Board: " + link.hello.name + " v" + link.hello.ver + ", ports " + link.hello.ports.join(", ") : "Board hasn't said hello."}` : "Not connected.";
  const list = $("#partsList"); list.innerHTML = "";
  const t = body.tracks || {};
  const tr = document.createElement("div"); tr.className = "part" + (t.installed ? "" : " missing");
  tr.textContent = `Tracks on ${t.left}/${t.right}: ${t.installed ? "installed" : "missing"}`;
  const tb = document.createElement("button"); tb.textContent = t.installed ? "Mark missing" : "Mark installed";
  tb.onclick = async () => { body.tracks.installed = !t.installed; await saveBody(); renderBody(); };
  const ta = document.createElement("div"); ta.className = "acts"; ta.append(tb); tr.append(ta); list.append(tr);
  for (const p of body.parts) {
    const d = document.createElement("div"); d.className = "part" + (p.installed ? "" : " missing");
    const h = document.createElement("div"); h.innerHTML = "<b></b> <span class='muted'></span>";
    h.firstChild.textContent = p.name; h.lastChild.textContent = `${p.type} · ${p.port} · ${p.installed ? "installed" : "missing"}`;
    const w = document.createElement("div"); w.className = "muted"; w.textContent = p.what || "";
    const acts = document.createElement("div"); acts.className = "acts";
    for (const a of Object.keys(p.actions || {})) {
      const b = document.createElement("button"); b.textContent = a;
      b.onclick = async () => transcriptLine("act", await usePart(p.name, a, 1));
      acts.append(b);
    }
    const tog = document.createElement("button"); tog.className = "ghost"; tog.textContent = p.installed ? "Mark missing" : "Mark installed";
    tog.onclick = async () => { p.installed = !p.installed; await saveBody(); renderBody(); };
    acts.append(tog);
    d.append(h, w, acts); list.append(d);
  }
  if (!$("#tab-status").hidden) renderStatus();
}

// Drive pad: hold to drive, release to stop.
$$("#dpad button").forEach(b => {
  const dir = b.dataset.drive;
  let held = false;
  b.onpointerdown = async e => {
    e.preventDefault();
    if (dir === "stop") return stopAll("drive pad");
    const t = body.tracks;
    if (!t.installed || !link.connected) return transcriptLine("act", !link.connected ? "Body not connected" : "Tracks marked missing");
    held = true;
    const s = t.speed ?? 0.7, ts = t.turnSpeed ?? 0.6;
    let [l, r] = { forward: [s, s], back: [-s, -s], left: [-ts, ts], right: [ts, -ts] }[dir];
    if (t.invertLeft) l = -l; if (t.invertRight) r = -r;
    while (held) { await link.send(`M ${t.left} ${l} 350`); await link.send(`M ${t.right} ${r} 350`); await sleep(250); }
  };
  b.onpointerup = b.onpointerleave = b.onpointercancel = () => { if (held) { held = false; link.send("X"); } };
});

$("#btnUsb").onclick = async () => { try { await link.usb(); } catch (e) { transcriptLine("act", "USB: " + e.message); $("#linkInfo").textContent = "USB: " + e.message; } };
$("#btnBle").onclick = async () => { try { await link.bluetooth(); } catch (e) { transcriptLine("act", "Bluetooth: " + e.message); $("#linkInfo").textContent = "Bluetooth: " + e.message; } };
$("#btnDisconnect").onclick = () => link.disconnect();

$("#btnCam").onclick = async () => { if (camStream) camOff(); else { try { await camOn(); } catch (e) { $("#sensorDump").textContent = "Camera: " + e.message; } } };
$("#btnSnap").onclick = () => ask("Look with your camera and tell me what you see.");
setInterval(() => { if (!$("#tab-sensors").hidden) $("#sensorDump").textContent = sensorReport(true); }, 1000);

// ---- files ----
let curDir = "", curFile = "";
async function openDir(dir) {
  curDir = dir; $("#fileEditor").hidden = true; $("#fileList").hidden = false;
  $("#filePath").textContent = "robot files / " + dir;
  const j = await api("/api/files?path=" + encodeURIComponent(dir)).catch(e => ({ items: [], error: e.message }));
  const list = $("#fileList"); list.innerHTML = "";
  if (dir) { const up = document.createElement("div"); up.className = "f"; up.textContent = "⬆ up"; up.onclick = () => openDir(dir.split("/").slice(0, -1).join("/")); list.append(up); }
  for (const it of j.items || []) {
    const d = document.createElement("div"); d.className = "f";
    d.innerHTML = "<span></span><span class='muted'></span>";
    d.firstChild.textContent = (it.dir ? "📁 " : "📄 ") + it.name; d.lastChild.textContent = it.dir ? "" : (it.size / 1024).toFixed(1) + " KB";
    const p = dir ? dir + "/" + it.name : it.name;
    d.onclick = () => it.dir ? openDir(p) : openFile(p);
    list.append(d);
  }
  const nf = document.createElement("div"); nf.className = "f"; nf.textContent = "＋ new file";
  nf.onclick = async () => { const n = prompt("File name"); if (n) { await writeFile((dir ? dir + "/" : "") + n, ""); openDir(dir); } };
  list.append(nf);
}
async function openFile(p) {
  try { $("#fileText").value = await readFile(p); } catch (e) { $("#fileText").value = "Can't open: " + e.message; }
  curFile = p; $("#fileName").textContent = p; $("#fileList").hidden = true; $("#fileEditor").hidden = false;
}
$("#fileSave").onclick = async () => {
  if (curFile.endsWith(".json")) { try { JSON.parse($("#fileText").value); } catch (e) { return alert("That's not valid JSON: " + e.message); } }
  await writeFile(curFile, $("#fileText").value);
  if (["body.json", "persona.md", "memory.md"].includes(curFile)) await loadRobotFiles();
  $("#fileSave").textContent = "Saved ✓"; setTimeout(() => $("#fileSave").textContent = "Save", 1200);
};
$("#fileClose").onclick = () => openDir(curDir);

// ---- logs ----
async function loadLogs() {
  const { entries } = await api("/api/logs?n=300").catch(() => ({ entries: [] }));
  const list = $("#logList"); list.innerHTML = "";
  for (const e of entries.reverse()) {
    const d = document.createElement("div"); d.className = "l " + (e.kind || "");
    const { t, kind, ...rest } = e;
    d.textContent = `${(t || "").replace("T", " ").slice(5, 19)}  ${kind}  ${rest.text || rest.detail || JSON.stringify(rest)}`;
    list.append(d);
  }
}
$("#logsRefresh").onclick = loadLogs;

// ---- settings ----
function bindSetting(id, key, cast = v => v) {
  const el = $(id);
  if (el.type === "checkbox") { el.checked = settings[key]; el.onchange = () => { settings[key] = el.checked; saveSettings(); }; }
  else { el.value = settings[key]; el.onchange = el.oninput = () => { settings[key] = cast(el.value); saveSettings(); onSettingChange(key); }; }
}
function onSettingChange(key) {
  if (key === "listen") { stopListening(); if (settings.listen === "always") startListening(); }
  if (key === "facing" && camStream) { camOff(); camOn().catch(() => {}); }
  refreshChips();
}
bindSetting("#setBrain", "brain"); bindSetting("#setListen", "listen"); bindSetting("#setWake", "wake");
bindSetting("#setVoice", "voice"); bindSetting("#setRate", "rate", Number); bindSetting("#setPitch", "pitch", Number);
bindSetting("#setFacing", "facing"); bindSetting("#setTipStop", "tipStop");
$("#btnFull").onclick = () => document.documentElement.requestFullscreen?.().catch(() => {});
$("#btnTestVoice").onclick = () => speak("Testing. One two. Yes, I can hear myself, unfortunately.");
$("#btnForget").onclick = () => { history = []; $("#transcript").innerHTML = ""; };

/* ================= boot ================= */
(async function boot() {
  drawFace();
  await loadRobotFiles();
  await refreshStatus();
  logEvent("boot", { detail: "face page opened" });
  if (settings.listen === "always") startListening();
  $("#said").textContent = "Tap the mic and talk to me.";
})();
