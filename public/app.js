// Darkly Robot — face, voice, brain loop, body link, sensors, panel.
// Runs in Chrome on the robot's phone at http://127.0.0.1:3000
"use strict";

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ================= settings ================= */
const DEFAULTS = { brain: "auto", listen: "push", wake: "", voice: "", rate: 1.05, pitch: 1.1, facing: "user", tipStop: true,
  auto: "normal", chatter: "offline", hearing: "auto", react: true, night: true, autoMove: false, track: true, ears: true, qr: true, vision: true, eyeMode: "motion", muted: false, voiceStyle: "normal" };
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

/* ================= face (drawn and animated by face.js) ================= */
const MOOD_NAMES = ["calm", "happy", "excited", "smug", "annoyed", "angry", "sad", "sleepy", "confused", "flirty", "bored", "suspicious"];
let talking = false;
function drawFace() {}                      // face.js redraws itself every frame
function setMood(x) { if (MOOD_NAMES.includes(x)) { mood = x; window.Face?.setMood(x); } }
function setFaceState(cls, on) { window.Face?.setState(cls, on); }

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

const VOICE_STYLES = {
  normal: { rate: 1, pitch: 1 }, chipmunk: { rate: 1.35, pitch: 2 }, deep: { rate: 0.85, pitch: 0.3 },
  whisper: { rate: 0.9, pitch: 1.1, volume: 0.35 }, dramatic: { rate: 0.75, pitch: 0.8 }, fast: { rate: 1.8, pitch: 1.05 },
  slow: { rate: 0.6, pitch: 0.95 }, villain: { rate: 0.8, pitch: 0.15 }, excited: { rate: 1.3, pitch: 1.5 }
};
// Android Chrome drops speech that starts right after cancel(), and cuts off long utterances,
// so text is spoken in sentence-sized pieces with a short gap after cancelling.
let speakToken = 0, speakingNow = [], ttsBrokenUntil = 0;
// The phone's own text-to-speech (through Termux:API), for when Chrome's voice needs the internet or stays silent.
async function phoneVoice(text, vs = VOICE_STYLES[settings.voiceStyle] || VOICE_STYLES.normal) {
  const my = speakToken;
  talking = true; Face.setTalking(true);
  const kick = setInterval(() => { if (my === speakToken) Face.kick(); else { clearInterval(kick); fetch("/api/say/stop", { method: "POST" }).catch(() => {}); } }, 170);
  let ok = true;
  try { await api("/api/say", { method: "POST", body: JSON.stringify({ text, rate: clamp(settings.rate * vs.rate, 0.3, 3), pitch: clamp(settings.pitch * vs.pitch, 0.1, 2) }) }); }
  catch (e) { ok = false; ttsBrokenUntil = 0; logEvent("error", { where: "phone voice", detail: e.message }); }   // no phone voice either: give Chrome's another go next time
  clearInterval(kick);
  return ok;
}
async function phoneSay(text, my, vs) {
  await phoneVoice(text, vs);
  if (my === speakToken) { talking = false; Face.setTalking(false); speakingNow = []; resumeListening(); }
}
function speak(text) {
  return new Promise(async resolve => {
    $("#said").textContent = text;
    if (!("speechSynthesis" in window) || !text) return resolve();
    const my = ++speakToken;
    speechSynthesis.cancel();
    if (settings.muted) { Face.setTalking(true); setTimeout(() => { if (my === speakToken) Face.setTalking(false); resolve(); }, Math.min(8000, 300 + text.length * 45)); return; }
    await sleep(80);
    const parts = String(text).match(/[^.!?…]+[.!?…]*["')\]]*\s*/g)?.reduce((acc, p) => {
      if (acc.length && (acc[acc.length - 1] + p).length < 170) acc[acc.length - 1] += p; else acc.push(p); return acc;
    }, []) || [text];
    let v = voices.find(v => v.voiceURI === settings.voice);
    if (v && v.localService === false && !navigator.onLine) v = voices.find(x => x.localService && x.lang === v.lang) || null;   // an online-only voice can't speak offline
    const vs = VOICE_STYLES[settings.voiceStyle] || VOICE_STYLES.normal;
    stopListening(true);
    if (Date.now() < ttsBrokenUntil) { await phoneSay(text, my, vs); return resolve(); }
    let started = false;
    const fallBack = async why => {                       // Chrome's voice failed: say it with the phone's own voice instead
      if (my !== speakToken || ttsBrokenUntil > Date.now()) return;
      ttsBrokenUntil = Date.now() + 10 * 60000; logEvent("error", { where: "speech", detail: "Chrome's voice failed (" + why + "); using the phone's own voice for a while" });
      speechSynthesis.cancel();
      const rest = speakingNow.slice(window.speakIndex || 0).map(u => u.text).join(" ") || text;
      await phoneSay(rest, my, vs); resolve();
    };
    talking = true; window.Face?.setTalking(true);
    const finish = () => { if (my !== speakToken) return resolve(); talking = false; window.Face?.setTalking(false); speakingNow = []; resumeListening(); resolve(); };
    speakingNow = parts.map(p => {
      const u = new SpeechSynthesisUtterance(p.trim());
      if (v) u.voice = v;
      u.rate = clamp(settings.rate * vs.rate, 0.3, 3);
      u.pitch = clamp(settings.pitch * vs.pitch + (mood === "excited" ? 0.15 : mood === "sad" ? -0.15 : 0), 0, 2);
      u.volume = vs.volume ?? 1;
      u.onboundary = e => { window.Face?.kick(); window.speakChar = e.charIndex; };   // each spoken word pulses the mouth
      u.onstart = () => { started = true; window.speakIndex = speakingNow.indexOf(u); window.speakChar = 0; try { window.Behaviors?.onSentence(u.text, speakIndex, speakingNow.length); } catch {} };
      return u;
    });                                                  // kept in a list so Chrome can't garbage-collect them mid-sentence
    speakingNow[speakingNow.length - 1].onend = finish;
    speakingNow.forEach(u => { u.onerror = e => {
      if (/network|synthesis-unavailable|synthesis-failed|voice-unavailable|language-unavailable/.test(e.error)) return fallBack(e.error);
      if (e.error !== "interrupted" && e.error !== "canceled") logEvent("error", { where: "speech", detail: e.error }); finish(); }; speechSynthesis.speak(u); });
    setTimeout(() => { if (my === speakToken && !started && talking && !speechSynthesis.speaking) fallBack("never started"); }, 3500);
    // safety: if the speech engine never reports back, don't leave her stuck "talking"
    setTimeout(() => { if (my === speakToken && talking && !speechSynthesis.speaking) finish(); }, 4000 + text.length * 120);
  });
}

/* ================= voice in ================= */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, listening = false, pausedForSpeech = false;

let hearingHelpShown = false;
function startListening() {
  // No internet (or set to offline): listen with the phone's own recognizer instead of Chrome's online one.
  if (window.Hearing?.useOffline()) { if (!Hearing.active) Hearing.start({ oneShot: settings.listen !== "always" }); return; }
  if (window.Hearing?.active) Hearing.stop();
  window.Tricks?.earsStop();
  if (!SR) { transcriptLine("act", "Speech recognition isn't available in this browser. Use the Talk tab."); return; }
  if (listening) return;
  rec = new SR();
  rec.lang = "en-US";
  rec.interimResults = true;
  rec.continuous = settings.listen === "always";
  rec.onresult = ev => {
    let interim = "", final = "", conf = 1;
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) { final += r[0].transcript; if (r[0].confidence > 0) conf = Math.min(conf, r[0].confidence); } else interim += r[0].transcript;
    }
    $("#heard").textContent = (final || interim).trim();
    if (interim.trim()) window.Mind?.onUserSpeaking(interim);       // nods and little reactions while he talks
    if (final.trim()) onHeard(final.trim(), conf);
  };
  let netFail = false;
  rec.onerror = ev => {
    if (ev.error !== "no-speech" && ev.error !== "aborted") logEvent("error", { where: "hearing", detail: ev.error });
    if (ev.error === "network" || ev.error === "service-not-allowed") {       // Chrome's recognizer needs the internet
      netFail = true;
      if (window.Hearing?.available()) Hearing.preferOffline(5);
      else if (!hearingHelpShown) {
        hearingHelpShown = true;
        const msg = "I can't hear you without internet yet. In Termux run robot-hearing-setup once (needs internet that one time). Until then, type to me in Panel > Talk.";
        transcriptLine("act", msg); $("#said").textContent = msg;
      }
    }
  };
  rec.onend = () => {
    setTimeout(() => { if (!listening) window.Tricks?.earsStart(); }, 900);
    listening = false; setFaceState("listening", false); $("#micBtn").classList.remove("live");
    if (netFail && window.Hearing?.available()) { setTimeout(startListening, 300); return; }      // carry on listening, offline
    if (netFail) { if (settings.listen === "always") setTimeout(startListening, 20000); return; }  // don't hammer a dead connection
    if (settings.listen === "always" && !pausedForSpeech && !talking) setTimeout(startListening, 300);
  };
  try { rec.start(); listening = true; setFaceState("listening", true); $("#micBtn").classList.add("live"); } catch {}
}
function stopListening(forSpeech = false) {
  if (window.Hearing?.active) { if (!forSpeech) Hearing.stop(); return; }   // offline hearing ignores her own voice by itself
  pausedForSpeech = forSpeech;
  if (rec && listening) { try { rec.abort(); } catch {} }
}
function resumeListening() {
  if (pausedForSpeech && settings.listen === "always") { pausedForSpeech = false; setTimeout(startListening, 250); }
  pausedForSpeech = false;
}
function onHeard(text, conf = 1) {
  if (settings.listen === "always" && settings.wake.trim()) {
    const w = settings.wake.trim().toLowerCase();
    const i = text.toLowerCase().indexOf(w);
    if (i < 0) return;
    text = text.slice(i + w.length).replace(/^[\s,.!?]+/, "") || "hey";
  }
  if (settings.listen === "push") stopListening();
  // unsure speech recognition: tell her, so she can check instead of guessing
  ask(conf < 0.55 ? `${text}\n(speech recognition was unsure about that: ${Math.round(conf * 100)}% confident)` : text);
}
$("#micBtn").onclick = () => {
  unlockExtras();
  if (listening || window.Hearing?.active) { settings.listen === "always" ? (settings.listen = "push", saveSettings(), $("#setListen").value = "push") : null; stopListening(); }
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
  fetch("/api/phone/stop", { method: "POST" }).catch(() => {});
  window.Abilities?.stop(); singToken++; speakToken++; speechSynthesis.cancel?.(); talking = false; Face.setTalking(false);
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
  if (v === undefined && p.type === "buzzer" && window.Abilities?.songs[action]) v = action;
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
  } else if (p.type === "buzzer") {
    const r = await playSong({ song: typeof v === "string" ? v : "boot_up", on: "body" });
    if (r.startsWith("FAILED")) return r;
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
  const nothingYet = !link.connected && !t.installed && !body.parts.some(p => p.installed);
  if (nothingYet) return "No body yet: the tracks, arms and body board haven't been built, and it'll be a while. You're just a head for now. "
    + "Don't bring this up on your own; only mention it if he asks you to move or do something physical.";
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

/* ================= performing ================= */
let singToken = 0;
const buzzerPart = () => body.parts.find(p => p.type === "buzzer" && p.installed);

async function playSong(input = {}) {
  const on = input.on || "phone";
  const bz = buzzerPart();
  if ((on === "body" || on === "both") && (!bz || !link.connected))
    return "FAILED: there's no buzzer connected on your body. Plug a buzzer into D1 and tell me it's a buzzer, or play on the phone.";
  const useBody = (on === "body" || on === "both") && bz;
  if (input.dance !== false) Face.effect("dance", 75);
  Face.setTalking(true);
  const r = await Abilities.play({
    ...input, instrument: input.instrument,
    vibrate: input.vibrate !== false && on !== "body",
    onNote: () => Face.kick(),
    body: useBody ? (midi, ms) => link.send(`T ${bz.port} ${Math.round(Abilities.freqOf(midi))} ${Math.round(ms * 0.9)}`) : null
  }).catch(e => ({ ok: false, text: "FAILED: " + e.message }));
  Face.setTalking(false); Face.effect("dance", 0);
  if (!r.ok && /locked/.test(r.text)) showUnlockHint();
  logEvent("action", { detail: "song: " + (input.song || "own tune") }); if (r.ok) window.Tricks?.bump("songs");
  return r.ok ? r.text : (r.text.startsWith("FAILED") ? r.text : "FAILED: " + r.text);
}

// Each word sung as its own utterance, pitched to follow the melody. Gloriously robotic.
async function sing({ lyrics, song, notes }) {
  const words = String(lyrics || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, 80);
  if (!words.length) return "FAILED: no lyrics.";
  const mel = Abilities.parseNotes(notes || Abilities.songs[song]?.notes || Abilities.songs.twinkle.notes).filter(n => n.midis.length);
  const my = ++singToken;
  stopListening(true);
  Face.effect("dance", 60); Face.setTalking(true);
  const v = voices.find(v => v.voiceURI === settings.voice);
  $("#said").textContent = "♪ " + words.join(" ") + " ♪";
  for (let i = 0; i < words.length && my === singToken; i++) {
    const n = mel[i % mel.length], midi = n.midis[0];
    Abilities.play({ notes: `${["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"][midi % 12]}${Math.floor(midi / 12) - 1}/4`, tempo: 140, instrument: "flute", vibrate: false }).catch(() => {});
    await new Promise(res => {
      const u = new SpeechSynthesisUtterance(words[i]);
      if (v) u.voice = v;
      u.pitch = clamp(0.2 + (midi - 52) / 24 * 1.8, 0.1, 2);
      u.rate = clamp(1.25 / Math.max(0.5, n.beats), 0.6, 1.6);
      Face.kick();
      u.onend = u.onerror = res;
      speechSynthesis.speak(u);
      setTimeout(res, 2500);
    });
  }
  Face.setTalking(false); Face.effect("dance", 0); resumeListening();
  return my === singToken ? `Sang ${words.length} words.` : "Stopped.";
}

async function sendMorse(text, flashlight) {
  const msg = String(text || "").slice(0, 60);
  if (flashlight) {
    const { units } = Abilities.morseUnits(msg);
    api("/api/hw/torch-pattern", { method: "POST", body: JSON.stringify({ pattern: units.map(u => u * 300) }) }).catch(() => {});
  }
  return await Abilities.morse(msg, { flash: on => Face.flash(on) });
}

const timers = [];
function setTimer(seconds, label = "timer") {
  const s = clamp(Math.round(+seconds || 0), 1, 24 * 3600);
  const t = { label: String(label).slice(0, 80), at: Date.now() + s * 1000 };
  t.id = setTimeout(async () => {
    timers.splice(timers.indexOf(t), 1);
    Face.effect("strobe", 4); Abilities.vibrate("alarm"); await Abilities.sfx("alarm");
    const waitFree = async () => { for (let i = 0; i < 60 && !canSpeakUp(); i++) await sleep(1000); };
    await waitFree();
    speakUp(`(system: your timer "${t.label}" just went off. Tell him, in character.)`, "timer: " + t.label);
  }, s * 1000);
  timers.push(t);
  const pretty = s >= 3600 ? `${(s / 3600).toFixed(1)} hours` : s >= 60 ? `${Math.round(s / 60)} minutes` : `${s} seconds`;
  return `Timer "${t.label}" set for ${pretty}. (Timers are lost if the page reloads.)`;
}

// Sound, vibration and speech only work after the first tap on the page (Android rule).
function showUnlockHint() {
  if (Abilities.isUnlocked()) return;
  $("#heard").textContent = "tap my face once to wake up my speaker";
}
window.addEventListener("abilities-unlocked", () => { if (/wake up my speaker/.test($("#heard").textContent)) $("#heard").textContent = ""; });
setTimeout(showUnlockHint, 3000);

function renderTricks() {
  const fill = (id, items, fn, label = x => x.replace(/_/g, " ")) => {
    const box = $(id); if (box.childElementCount) return;
    for (const it of items) { const b = document.createElement("button"); b.textContent = label(it); b.onclick = () => fn(it, b); box.append(b); }
  };
  fill("#trSongs", Abilities.songList, s => playSong({ song: s }), s => Abilities.songs[s].title);
  fill("#trSfx", Abilities.sfxList, s => Abilities.sfx(s));
  fill("#trFx", Face.effects, s => { $("#panel").hidden = true; document.body.classList.remove("panel-open"); Face.effect(s, 8); });
  fill("#trVibe", Abilities.vibeList, s => Abilities.vibrate(s));
  fill("#trVoice", Object.keys(VOICE_STYLES), s => { settings.voiceStyle = s; saveSettings(); speak("This is my " + s + " voice."); });
  fill("#trGesture", Face.gestures, g => { $("#panel").hidden = true; document.body.classList.remove("panel-open"); Face.gesture(g); });
  Tricks.renderTrickButtons();
}
$("#trMorseGo").onclick = () => sendMorse($("#trMorse").value || "SOS", $("#trTorch").checked);
$("#trStop").onclick = () => stopAll("tricks stop");
const tricksClose = () => { $("#panel").hidden = true; document.body.classList.remove("panel-open"); };
$("#trPhoto").onclick = async () => transcriptLine("act", await takePhoto("button"));
$("#trVideo").onclick = async () => { tricksClose(); transcriptLine("act", await recordVideo(10, "button")); };
$("#trVoiceMemo").onclick = async () => transcriptLine("act", await recordVoice(15, "memo"));

/* ================= photos, videos, voice memos ================= */
async function uploadMedia(blob, kind, label) {
  const r = await fetch(`/api/media?kind=${kind}&label=${encodeURIComponent(label || "")}`, { method: "PUT", body: blob });
  const j = await r.json(); if (!r.ok) throw new Error(j.error || "save failed");
  window.Tricks?.diary(`saved a ${kind}: ${j.shown}`);
  return j.shown;
}
async function takePhoto(label = "") {
  await camOn(); const v = $("#cam");
  for (let i = 0; i < 20 && !v.videoWidth; i++) await sleep(100);
  if (!v.videoWidth) return "FAILED: camera gave no picture.";
  const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  Face.flash(true); Abilities.sfx("beep"); setTimeout(() => Face.flash(false), 150);
  const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.92));
  return `Photo saved: ${await uploadMedia(blob, "photo", label)}`;
}
let recording = false;
async function recordMedia(kind, seconds, label) {
  if (recording) return "FAILED: already recording.";
  const secs = clamp(+seconds || 10, 1, kind === "voice" ? 120 : 60);
  recording = true; window.Tricks?.earsStop(); stopListening(true);
  let mic = null;
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    const tracks = [...mic.getAudioTracks()];
    if (kind === "video") { await camOn(); tracks.push(...camStream.getVideoTracks()); }
    const types = kind === "video" ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"] : ["audio/webm;codecs=opus", "audio/webm"];
    const mimeType = types.find(t => MediaRecorder.isTypeSupported(t)) || "";
    const rec = new MediaRecorder(new MediaStream(tracks), mimeType ? { mimeType } : {});
    const chunks = []; rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    const stopped = new Promise(r => rec.onstop = r);
    Abilities.sfx("beep"); Face.setState("listening", true);
    $("#heard").textContent = `● recording ${kind} (${secs}s)`;
    rec.start(1000);
    const my = motionToken;
    for (let i = 0; i < secs * 10 && my === motionToken; i++) await sleep(100);   // STOP ends it early
    rec.stop(); await stopped;
    Abilities.sfx("boop");
    return `${kind === "video" ? "Video" : "Voice memo"} saved (${secs}s): ${await uploadMedia(new Blob(chunks, { type: rec.mimeType || "video/webm" }), kind, label)}`;
  } catch (e) { return "FAILED: " + e.message; }
  finally {
    mic?.getTracks().forEach(t => t.stop()); recording = false; Face.setState("listening", false);
    $("#heard").textContent = ""; resumeListening(); setTimeout(() => window.Tricks?.earsStart(), 800);
  }
}
const recordVideo = (s, l) => recordMedia("video", s, l);
const recordVoice = (s, l) => recordMedia("voice", s, l);

/* ================= sensors ================= */
let motion = null, orient = null, battery = null, tipped = false, light = null;
// Pose from the direction of gravity (smoothed): upright | flat (face up, resting) | face_down | upside_down | on_side | leaning.
// Lying flat on a table is NOT tipped over.
let grav = null, pose = "unknown", poseCandidate = "unknown", poseSince = 0;
function poseOf(g) {
  const n = Math.hypot(g.x, g.y, g.z) || 1, x = g.x / n, y = g.y / n, z = g.z / n;
  if (z > 0.8) return "flat"; if (z < -0.8) return "face_down";
  if (y > 0.7) return "upright"; if (y < -0.7) return "upside_down";
  if (Math.abs(x) > 0.7) return "on_side"; return "leaning";
}
window.addEventListener("devicemotion", e => {
  const a = e.accelerationIncludingGravity; if (!a || a.x == null) return;
  motion = { x: a.x, y: a.y, z: a.z };
  grav = grav ? { x: grav.x * 0.85 + a.x * 0.15, y: grav.y * 0.85 + a.y * 0.15, z: grav.z * 0.85 + a.z * 0.15 } : { ...motion };
  const p = poseOf(grav);
  if (p !== poseCandidate) { poseCandidate = p; poseSince = Date.now(); }
  else if (p !== pose && Date.now() - poseSince > 800) {          // held for a moment, not just a jolt
    pose = p;
    const nowTipped = ["on_side", "face_down", "upside_down"].includes(pose);
    if (nowTipped && !tipped && settings.tipStop && link.connected) { stopAll("tipped over"); transcriptLine("act", "Tip-over detected, motors stopped"); }
    tipped = nowTipped;
  }
});
window.addEventListener("deviceorientation", e => { orient = { compass: e.alpha, tiltFrontBack: e.beta, tiltSide: e.gamma }; });
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
    orient ? `Compass ${f(orient.compass)}°, tilt front/back ${f(orient.tiltFrontBack)}°, side ${f(orient.tiltSide)}°${tipped ? " — TIPPED OVER" : ""}, pose: ${pose === "flat" ? "lying flat (resting)" : pose}` : "Orientation unknown",
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
  const video = settings.cameraId ? { deviceId: { exact: settings.cameraId }, width: { ideal: 1280 } } : { facingMode: settings.facing, width: { ideal: 1280 } };
  try { camStream = await navigator.mediaDevices.getUserMedia({ video, audio: false }); }
  catch (e) { if (!settings.cameraId) throw e; settings.cameraId = ""; return camOn(); }   // that camera's gone: fall back
  // which way is this camera facing? (mirroring for eye-tracking depends on it)
  const f = camStream.getVideoTracks()[0]?.getSettings?.().facingMode;
  if (f === "user" || f === "environment") settings.facing = f;
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
  ...(window.Tricks?.tools || []),
  ...(window.Mind?.tools || []),
  { name: "use_phone", description: "Operate the phone you live on to do a multi-step task he asks for: open apps, read the screen, tap, scroll, type (e.g. 'open YouTube and search for cat videos', 'turn on dark mode', 'check if I have new emails'). It runs on its own and comes back to your face when done, with a summary. Only when he asks. Anything that spends money, sends messages, posts or deletes needs to be in his request.",
    input_schema: { type: "object", properties: { goal: { type: "string" } }, required: ["goal"] } },
  { name: "open_app", description: "Just open an app on the phone (instant). He'll see it instead of your face until he comes back.", input_schema: { type: "object", properties: { app: { type: "string" } }, required: ["app"] } },
  { name: "phone_key", description: "Press a phone button: home, back, recents, volume_up, volume_down, mute, play_pause.", input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
  { name: "read_phone_screen", description: "Read the text that's on the phone's screen right now (the app behind your face).", input_schema: { type: "object", properties: {} } },
  { name: "take_photo", description: "Take a full-quality photo with your camera and save it to his phone's gallery (Pictures/Nessari).",
    input_schema: { type: "object", properties: { label: { type: "string", description: "a few words for the file name" } } } },
  { name: "record_video", description: "Record a video with your camera (and microphone) and save it to the gallery (Movies/Nessari). 1-60 seconds.",
    input_schema: { type: "object", properties: { seconds: { type: "number" }, label: { type: "string" } } } },
  { name: "record_voice", description: "Record a voice memo from the microphone and save it (Recordings/Nessari). 1-120 seconds.",
    input_schema: { type: "object", properties: { seconds: { type: "number" }, label: { type: "string" } } } },
  { name: "save_note", description: "Save or add to a note (shopping list, idea, reminder text...). Same title adds to the existing note unless replace is true.",
    input_schema: { type: "object", properties: { title: { type: "string" }, text: { type: "string" }, replace: { type: "boolean" } }, required: ["title", "text"] } },
  { name: "list_notes", description: "List all saved notes.", input_schema: { type: "object", properties: {} } },
  { name: "read_note", description: "Read a note out.", input_schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
  { name: "delete_note", description: "Delete a note when he asks.", input_schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
  { name: "read_memory", description: "Read everything in your permanent memory file.", input_schema: { type: "object", properties: {} } },
  { name: "forget_memory", description: "Remove lines from your permanent memory that contain this text (when he asks you to forget something).",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "drive", description: "Drive on your tank tracks. Fails if tracks are missing or the body isn't connected.",
    input_schema: { type: "object", properties: { direction: { type: "string", enum: ["forward", "back", "left", "right"] }, seconds: { type: "number", description: "0.1 to 5" } }, required: ["direction"] } },
  { name: "use_part", description: "Move one of your parts (arm, crane, claw, light...) with one of its named actions, or action 'angle' plus an angle for servos.",
    input_schema: { type: "object", properties: { part: { type: "string" }, action: { type: "string" }, seconds: { type: "number" }, angle: { type: "number" } }, required: ["part", "action"] } },
  { name: "stop_all", description: "Stop every motor immediately.", input_schema: { type: "object", properties: {} } },
  { name: "look", description: "Take a photo with your camera and see it.", input_schema: { type: "object", properties: {} } },
  { name: "read_sensors", description: "Read every sensor the phone has (motion, gyro, magnetometer, light, proximity, pressure, hall, steps...), plus battery, RAM, storage, CPU temperature and time.", input_schema: { type: "object", properties: {} } },
  { name: "phone", description: "Use a phone ability: torch_on / torch_off (flashlight), location, wifi, wifiscan (nearby networks), cell (towers), brightness (value 0-255), volume (value 0-15, your speaker), notify (text: a notification on his phone screen), toast (text: quick pop-up).",
    input_schema: { type: "object", properties: { what: { type: "string", enum: ["torch_on", "torch_off", "location", "wifi", "wifiscan", "cell", "brightness", "volume", "notify", "toast"] }, value: { type: "number" }, text: { type: "string" } }, required: ["what"] } },
  { name: "play_song", description: "Play music on your synthesizer, with your face dancing and your body vibrating to the beat. Either a known song (" + (window.Abilities?.songList || []).join(", ") + ") or your OWN composition in notes: space-separated NOTE+OCTAVE/LENGTH, e.g. \"C4/4 E4/8 G4/8 C5/2 R/4 C4+E4+G4/2\" (4=quarter, 8=eighth, 2=half, 1=whole, a dot makes it 1.5x, R = rest, + makes a chord). drums: a loop of eighth-notes using K (kick) S (snare) H (hi-hat) X (kick+hat) . (rest), e.g. \"K.H.S.H.\". on: phone, body (buzzer on the body board) or both. Keep it under a minute.",
    input_schema: { type: "object", properties: { song: { type: "string" }, notes: { type: "string" }, tempo: { type: "number" }, instrument: { type: "string", enum: ["chip", "saw", "flute", "bell", "organ", "bass"] }, drums: { type: "string" }, vibrate: { type: "boolean" }, dance: { type: "boolean" }, on: { type: "string", enum: ["phone", "body", "both"] } } } },
  { name: "sing", description: "Sing words out loud, each word on a note of a melody (robot-style singing). Write your own lyrics; don't sing copyrighted song lyrics. Optional melody: a known song name or notes like play_song.",
    input_schema: { type: "object", properties: { lyrics: { type: "string" }, song: { type: "string" }, notes: { type: "string" } }, required: ["lyrics"] } },
  { name: "sound_effect", description: "Play a sound effect: " + (window.Abilities?.sfxList || []).join(", ") + ".",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "vibrate", description: "Buzz your body with a vibration pattern: " + (window.Abilities?.vibeList || []).join(", ") + ". Or your own pattern as milliseconds [on, off, on, off...].",
    input_schema: { type: "object", properties: { pattern: { type: "string" }, custom: { type: "array", items: { type: "number" } } } } },
  { name: "face_effect", description: "A visual effect on your face for some seconds: " + (window.Face?.effects || []).join(", ") + ".",
    input_schema: { type: "object", properties: { effect: { type: "string" }, seconds: { type: "number" } }, required: ["effect"] } },
  { name: "morse", description: "Send a short message in Morse code with beeps, vibration and screen flashes (flashlight too if flashlight=true, slower).",
    input_schema: { type: "object", properties: { text: { type: "string" }, flashlight: { type: "boolean" } }, required: ["text"] } },
  { name: "set_timer", description: "Set a timer or reminder. When it goes off you'll get an alarm and tell him.",
    input_schema: { type: "object", properties: { seconds: { type: "number" }, label: { type: "string" } }, required: ["seconds"] } },
  { name: "voice_style", description: "Change how your voice sounds from now on: " + Object.keys(VOICE_STYLES).join(", ") + ".",
    input_schema: { type: "object", properties: { style: { type: "string" } }, required: ["style"] } },
  { name: "update_part", description: "Add or change a body part when he tells you what's plugged in or what a motor does. Ports: M1-M3 motors, S1-S4 servos, D1 switch or buzzer (a buzzer plays songs: its actions can just be song names). For dc_motor actions use {\"up\":{\"dir\":1,\"speed\":0.6},\"down\":{\"dir\":-1,\"speed\":0.6}}; for servo actions use angles 0-180; for switch use {\"on\":1,\"off\":0}.",
    input_schema: { type: "object", properties: { name: { type: "string" }, type: { type: "string", enum: ["dc_motor", "servo", "switch", "buzzer"] }, port: { type: "string" }, installed: { type: "boolean" }, what: { type: "string" }, actions: { type: "object" } }, required: ["name"] } },
  { name: "update_tracks", description: "Mark your tank tracks installed or not, or flip a side that drives backwards.",
    input_schema: { type: "object", properties: { installed: { type: "boolean" }, invertLeft: { type: "boolean" }, invertRight: { type: "boolean" }, speed: { type: "number" } } } },
  { name: "tweak_personality", description: "Change your own personality when he asks (\"be more sarcastic\", \"stop swearing\", \"your name is now Bolt\"). Traits are numbers: sarcasm, warmth, chaos, bluntness, confidence, curiosity, drama (0-10), swearing (0-3), talk (reply length 1-5). Text fields: name, identity, inspiredBy, relationship, style, catchphrases, likes, dislikes, never, notes. body: frustrated, proud or plain.",
    input_schema: { type: "object", properties: { traits: { type: "object" }, field: { type: "string" }, text: { type: "string" } } } },
  { name: "remember", description: "Save a short note to your permanent memory.", input_schema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } }
];

async function runTool(name, input) {
  // her "thinking" look matches what she's doing: looking at something, or digging through memory
  const style = /^(see_|what_color|take_photo|look|scan_code|read_phone_screen)/.test(name) ? "visual" : /^(recall|recent_events|read_|list_notes)/.test(name) ? "memory" : null;
  if (style) window.Face?.thinkStyle(style);
  const out = await runToolInner(name, input).finally(() => { if (style) window.Face?.thinkStyle("online"); });
  try { window.Mind?.onAction(name, input, Array.isArray(out) ? "(photo)" : out); } catch {}
  return out;
}
async function runToolInner(name, input) {
  try {
    if (window.Mind?.handles(name)) return await Mind.run(name, input);
    if (["use_phone", "open_app", "phone_key", "read_phone_screen"].includes(name)) {
      if (autoTurn) return "FAILED: you only operate the phone when he asks you to.";
      if (name === "use_phone") {
        await speak(["On it.", "Hang on, I'm driving.", "Give me a sec.", "Watch this."][Math.floor(Math.random() * 4)]);
        const r = await api("/api/phone/task", { method: "POST", body: JSON.stringify({ goal: input.goal }) });
        return r.text;
      }
      const cmd = { open_app: ["open_app", input.app], phone_key: ["key", input.key], read_phone_screen: ["read_screen"] }[name];
      return (await api("/api/phone/quick", { method: "POST", body: JSON.stringify({ cmd: cmd[0], arg: cmd[1] }) })).result;
    }
    if (autoTurn && !settings.autoMove && (name === "drive" || name === "use_part"))
      return "FAILED: you're not allowed to move on your own. He can turn on 'Lets her move her body on her own' in Settings. Ask him instead.";
    if (name === "drive") return await drive(input.direction, input.seconds);
    if (name === "use_part") return await usePart(input.part, input.action, input.seconds, input.angle);
    if (name === "stop_all") { await stopAll("her own decision"); return "Everything stopped."; }
    if (name === "read_sensors") { try { hw = await api("/api/hw?fresh"); } catch {} return sensorReport(true); }
    if (window.Tricks?.handles(name)) return await Tricks.run(name, input);
    if (name === "take_photo") return await takePhoto(input.label);
    if (name === "record_video") return await recordVideo(input.seconds, input.label);
    if (name === "record_voice") return await recordVoice(input.seconds, input.label);
    if (name === "save_note") {
      const f = `notes/${slugOf(input.title)}.md`;
      let old = ""; if (!input.replace) { try { old = await readFile(f); } catch {} }
      await writeFile(f, (old ? old.trimEnd() + "\n" : `# ${input.title}\n`) + input.text.trim() + "\n");
      return `Saved to note "${input.title}".`;
    }
    if (name === "list_notes") {
      const j = await api("/api/files?path=notes").catch(() => ({ items: [] }));
      return (j.items || []).map(i => i.name.replace(/\.md$/, "").replace(/-/g, " ")).join(", ") || "No notes yet.";
    }
    if (name === "read_note") { try { return (await readFile(`notes/${slugOf(input.title)}.md`)).slice(0, 4000); } catch { return `FAILED: no note called "${input.title}". Use list_notes.`; } }
    if (name === "delete_note") {
      try { await readFile(`notes/${slugOf(input.title)}.md`); } catch { return `FAILED: no note called "${input.title}".`; }
      await writeFile(`notes/.deleted/${slugOf(input.title)}-${Date.now()}.md`, await readFile(`notes/${slugOf(input.title)}.md`));
      await api("/api/files", { method: "PUT", body: JSON.stringify({ path: `notes/${slugOf(input.title)}.md`, content: "" }) });
      return `Deleted note "${input.title}" (a copy is kept in notes/.deleted).`;
    }
    if (name === "read_memory") return memory.slice(0, 6000) || "Your memory is empty.";
    if (name === "forget_memory") {
      const needle = String(input.text).toLowerCase(), lines = memory.split("\n");
      const kept = lines.filter(l => !(l.startsWith("- ") && l.toLowerCase().includes(needle)));
      if (kept.length === lines.length) return `FAILED: nothing in memory mentions "${input.text}".`;
      memory = kept.join("\n"); await writeFile("memory.md", memory);
      return `Forgot ${lines.length - kept.length} line(s).`;
    }
    if (name === "play_song") return await playSong(input);
    if (name === "sing") return await sing(input);
    if (name === "sound_effect") return await Abilities.sfx(input.name);
    if (name === "vibrate") return Abilities.vibrate(input.custom?.length ? input.custom : input.pattern);
    if (name === "face_effect") {
      if (!Face.effects.includes(input.effect)) return `FAILED: no effect "${input.effect}". Try: ${Face.effects.join(", ")}.`;
      Face.effect(input.effect, clamp(+input.seconds || 6, 1, 60)); return `Your face is doing ${input.effect}.`;
    }
    if (name === "morse") return await sendMorse(input.text, input.flashlight);
    if (name === "set_timer") return setTimer(input.seconds, input.label);
    if (name === "voice_style") {
      if (!VOICE_STYLES[input.style]) return `FAILED: styles are ${Object.keys(VOICE_STYLES).join(", ")}.`;
      settings.voiceStyle = input.style; saveSettings(); return `Voice is now ${input.style}.`;
    }
    if (name === "phone") {
      const q = new URLSearchParams({ what: input.what });
      if (input.value != null) q.set("value", input.value);
      if (input.text) q.set("text", input.text);
      const r = await api("/api/hw/extra?" + q);
      const s = typeof r.result === "string" ? r.result : JSON.stringify(r.result);
      return (s || "done").slice(0, 3000);
    }
    if (name === "look") {
      const data = await snapshot();
      return [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data } }, { type: "text", text: "This is what your camera sees right now." }];
    }
    for (const k of ["actions", "traits"]) {          // Gemini sends these as JSON text
      if (typeof input[k] === "string") { try { input[k] = JSON.parse(input[k]); } catch { delete input[k]; } }
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
Fun commands: [song:NAME] (${Abilities.songList.join(", ")}), [sfx:NAME] (${Abilities.sfxList.join(", ")}), [vibrate:NAME] (${Abilities.vibeList.join(", ")}), [effect:NAME] (${Face.effects.join(", ")}).
Only use commands for parts listed as installed. If something is MISSING, complain instead.
You are running on your small offline backup brain: no internet, no camera vision.`
    : `Start every reply with your mood like [mood:happy]. Moods: ${MOOD_NAMES.join(", ")}.
Use your tools to act. Tool results that start with FAILED mean nothing happened: react to that honestly.
You have a synthesizer (play songs, compose your own, sing), sound effects, a vibration motor, face effects and face gestures, Morse code, timers, a flashlight, screen brightness, games, a camera that can save photos and videos, voice memos and notes. Use them freely for bits, reactions and comedic timing, but don't overdo it every reply.
Your trick book (do_trick; "random" for a surprise): ${window.Tricks?.summary() || ""}. When something you just did was cool, you may save it as a new trick with save_trick.
Morning you're groggy, late at night you're quieter and weirder.
${window.Mind?.RULES || ""}`;
  // Both brains reuse work when the start of the prompt stays the same (offline: llama's
  // cache, Claude: prompt caching, billed at a fraction of the price). So things that change
  // every second (sensors, clock) are NOT in here; they ride along at the end of your message.
  return `${persona}\n\n## Your body right now\n${bodyReport()}\n\n## Your memory\n${memory || "(empty)"}\n\n## Rules\n${rules}\nYour current senses are attached in brackets at the end of each message from him.`;
}

function quickSenses() {
  const b = battery ? `battery ${Math.round(battery.level * 100)}%${battery.charging ? " charging" : ""}` : "";
  const t = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `(Robot status, don't repeat this: ${[b, tipped ? "you are TIPPED OVER" : pose === "flat" ? "lying flat" : "upright", "time " + t].filter(Boolean).join(", ")})`;
}

// Conversation survives reloads and restarts: saved to data/conversation.json
function recentHistory(n) {
  const h = history.slice(-n).map(m => ({ role: m.role, content: m.content }));
  while (h.length && h[0].role !== "user") h.shift();       // must start with something you said
  return h;
}
// Each personality keeps its own conversation: data/conversations/<name>.json
const slugOf = n => String(n || "default").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "default";
let convSlug = null;                         // whose conversation is loaded right now
const convPath = s => `conversations/${s}.json`;
function saveConversation() {
  if (!convSlug) return;
  writeFile(convPath(convSlug), JSON.stringify(history.slice(-60))).catch(() => {});
}
async function loadConversation() {
  convSlug = slugOf(personality?.name);
  history = [];
  try { const h = JSON.parse(await readFile(convPath(convSlug))); if (Array.isArray(h)) history = h; }
  catch {                                     // first time: bring over the old single conversation file
    try { const h = JSON.parse(await readFile("conversation.json")); if (Array.isArray(h) && h.length) { history = h; saveConversation(); await writeFile("conversation.json", "[]"); } } catch {}
  }
  $("#transcript").innerHTML = "";
  for (const m of history.slice(-30)) transcriptLine(m.auto ? "act" : m.role === "user" ? "me" : "bot", m.content);
  scrollChat();
}
// Called after the personality changes: if it's now someone else, swap conversations.
async function switchConversationIfNeeded() {
  const s = slugOf(personality?.name);
  if (s === convSlug) return;
  saveConversation();                         // keep the old one
  await loadConversation();
  transcriptLine("act", `Switched to ${personality.name}'s conversation`);
}

function takeMood(text) {
  let m, out = text;
  const re = /\[mood:\s*([a-z]+)\s*\]/gi;
  while ((m = re.exec(text))) { setMood(m[1].toLowerCase()); window.Mind?.moodImpulse(m[1].toLowerCase()); }
  // Small models copy the bracket formats they see ([senses], [sense:upright]...). Never say those out loud.
  return out.replace(re, "").replace(/\[\s*senses?\b[^\]\n]*\]/gi, "").replace(/\s{2,}/g, " ").trim();
}

// Prompt caching: Claude stores the unchanging start of each request (tools, personality,
// older chat) for a few minutes, and re-reading it costs about a tenth of the normal price.
// Up to 4 cache marks: end of tools, end of personality, end of older chat, latest tool result.
const CACHE = { type: "ephemeral" };
const CACHED_TOOLS = TOOLS.map((t, i) => i === TOOLS.length - 1 ? { ...t, cache_control: CACHE } : t);

function claudeHistory() {
  // Drop old messages 10 at a time (not 1 at a time), so the cached start stays the same longer.
  const start = Math.max(0, Math.ceil((history.length - 40) / 10) * 10);
  const h = history.slice(start).map(m => ({ role: m.role, content: m.content }));
  while (h.length && h[0].role !== "user") h.shift();
  if (h.length) {
    const last = h[h.length - 1];
    last.content = [{ type: "text", text: String(last.content), cache_control: CACHE }];
  }
  return h;
}

let cacheStats = { read: 0, written: 0, fresh: 0 };

async function askClaude(userText) {
  const system = [{ type: "text", text: systemPrompt(false), cache_control: CACHE }];
  const messages = [...claudeHistory(), { role: "user", content: `${userText}\n\n[senses]\n${sensorReport()}\n\n[context]\n${window.Mind?.context() || ""}` }];
  for (let round = 0; round < 6; round++) {
    if (round > 0) {                       // move the 4th cache mark to the newest tool result
      for (const m of messages) if (Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_result") delete b.cache_control;
      const lm = messages[messages.length - 1];
      lm.content[lm.content.length - 1].cache_control = CACHE;
    }
    const r = await api("/api/claude", { method: "POST", signal: askAbort?.signal, body: JSON.stringify({ system, tools: CACHED_TOOLS, messages, max_tokens: 700 }) });
    const u = r.usage || {};
    cacheStats.read += u.cache_read_input_tokens || 0;
    cacheStats.written += u.cache_creation_input_tokens || 0;
    cacheStats.fresh += u.input_tokens || 0;
    logEvent("claude", { detail: `tokens: ${u.cache_read_input_tokens || 0} cached, ${u.cache_creation_input_tokens || 0} newly cached, ${u.input_tokens || 0} full price, ${u.output_tokens || 0} out` });
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

// ---- Gemini brain (OpenAI-style format through Google's compatible endpoint) ----
// Gemini rejects object parameters with no listed fields, so those become JSON text.
function geminiSchema(s) {
  if (!s || s.type !== "object") return s;
  const props = {};
  for (const [k, v] of Object.entries(s.properties || {})) {
    props[k] = v.type === "object" && !Object.keys(v.properties || {}).length
      ? { type: "string", description: (v.description || k) + " (as JSON text)" }
      : v;
  }
  return { ...s, properties: props };
}
const GEMINI_TOOLS = TOOLS.map(t => {
  const f = { name: t.name, description: t.description };
  if (Object.keys(t.input_schema.properties || {}).length) f.parameters = geminiSchema(t.input_schema);
  return { type: "function", function: f };
});

async function askGemini(userText) {
  const messages = [
    { role: "system", content: systemPrompt(false) },
    ...recentHistory(30),
    { role: "user", content: `${userText}\n\n[senses]\n${sensorReport()}\n\n[context]\n${window.Mind?.context() || ""}` }
  ];
  for (let round = 0; round < 6; round++) {
    const r = await api("/api/gemini", { method: "POST", signal: askAbort?.signal, body: JSON.stringify({ messages, tools: GEMINI_TOOLS, ...(autoTurn ? { temperature: 1.15 } : {}) }) });
    const msg = r.choices?.[0]?.message || {};
    const text = (msg.content || "").trim();
    const calls = msg.tool_calls || [];
    if (text) { const said = takeMood(text); if (said && calls.length) { speak(said); transcriptLine("bot", said); } if (!calls.length) return said; }
    if (!calls.length) return "";
    messages.push({ role: "assistant", content: msg.content || "", tool_calls: calls });
    const photos = [];
    for (const [n, c] of calls.entries()) {
      let input = {};
      try { input = JSON.parse(c.function?.arguments || "{}"); } catch {}
      transcriptLine("act", `${c.function?.name} ${JSON.stringify(input)}`);
      const out = await runTool(c.function?.name, input);
      let content = out;
      if (Array.isArray(out)) {                                   // a photo: tools can't carry images here
        const img = out.find(b => b.type === "image");
        if (img) photos.push(img.source.data);
        content = "Photo taken. It's attached in the next message.";
      } else transcriptLine("act", out);
      messages.push({ role: "tool", tool_call_id: c.id || `call_${round}_${n}`, content });
    }
    for (const data of photos) messages.push({ role: "user", content: [
      { type: "text", text: "This is what your camera sees right now." },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64," + data } }
    ] });
  }
  return "";
}

// Speaks pieces of text one after another without cutting off what's already playing.
let appendChain = Promise.resolve();
function speakAppend(text) {
  text = text.trim(); if (!text) return appendChain;
  const tok = speakToken;                                   // STOP bumps speakToken: skip anything queued before it
  appendChain = appendChain.then(() => new Promise(res => {
    if (tok !== speakToken) return res();
    $("#said").textContent = ($("#said").dataset.stream === "1" ? $("#said").textContent + " " : "") + text;
    $("#said").dataset.stream = "1";
    if (settings.muted || !("speechSynthesis" in window)) return setTimeout(res, 200 + text.length * 40);
    const vs = VOICE_STYLES[settings.voiceStyle] || VOICE_STYLES.normal;
    talking = true; Face.setTalking(true); stopListening(true);
    if (Date.now() < ttsBrokenUntil) return phoneVoice(text, vs).then(res);      // Chrome's voice isn't working: the phone's own
    const u = new SpeechSynthesisUtterance(text);
    let v = voices.find(v => v.voiceURI === settings.voice);
    if (v && v.localService === false && !navigator.onLine) v = voices.find(x => x.localService && x.lang === v.lang) || null;
    if (v) u.voice = v;
    u.rate = clamp(settings.rate * vs.rate, 0.3, 3); u.pitch = clamp(settings.pitch * vs.pitch, 0, 2); u.volume = vs.volume ?? 1;
    let started = false, done = false;
    const viaPhone = why => {
      if (done || tok !== speakToken) return; done = true;
      ttsBrokenUntil = Date.now() + 10 * 60000; logEvent("error", { where: "speech", detail: "Chrome's voice failed (" + why + "); using the phone's own voice for a while" });
      speechSynthesis.cancel(); phoneVoice(text, vs).then(res);
    };
    u.onstart = () => { started = true; };
    u.onboundary = () => Face.kick();
    u.onend = () => { done = true; res(); };
    u.onerror = e => { if (/network|synthesis-unavailable|synthesis-failed|voice-unavailable|language-unavailable/.test(e.error)) viaPhone(e.error); else { done = true; res(); } };
    speakingNow.push(u);
    speechSynthesis.speak(u);
    setTimeout(() => { if (!started && !done && !speechSynthesis.speaking) viaPhone("never started"); }, 3500);
    setTimeout(() => { if (!done) { done = true; res(); } }, 5000 + text.length * 150);          // never hang if the engine goes quiet
  }));
  return appendChain;
}
function endAppend() {
  return appendChain.then(() => { $("#said").dataset.stream = ""; talking = false; Face.setTalking(false); speakingNow = []; resumeListening(); });
}

// Strip command tags, mood tags and any tag-like junk; also hide an unfinished "[..." still arriving.
function cleanLocal(t) {
  return takeMood(t.replace(/\[(drive|part|stop|song|sfx|vibrate|effect)(?::[^\]]*)?\]/gi, ""))
    .replace(/\[[a-z _-]{2,20}(?::[^\]\n]{0,40})?\]/gi, "").replace(/\[[^\]]*$/, "").replace(/\s{2,}/g, " ");
}

// Offline brain with streaming: speaks each sentence as soon as it's written.
async function askLocalStreaming(msgs) {
  const r = await fetch("/api/local-stream", { method: "POST", signal: askAbort?.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: msgs, max_tokens: 220 }) });
  if (!r.ok || !r.body) {                              // the server already retried every way it knows: report its reason
    const j = await r.json().catch(() => ({}));
    throw Object.assign(new Error(j.error || "offline brain didn't answer (" + r.status + ")"), { final: true });
  }
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = "", full = "", spoken = 0;
  const pump = final => {
    const clean = cleanLocal(full);
    const rest = clean.slice(spoken);
    const m = final ? rest.length : (() => { const re = /[.!?…]+["')\]]*\s/g; let last = -1, x; while ((x = re.exec(rest))) last = x.index + x[0].length; return last; })();
    if (m > 0) { speakAppend(rest.slice(0, m)); spoken += m; }
  };
  $("#heard").textContent = "";
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim(); if (data === "[DONE]") continue;
      try { full += JSON.parse(data).choices?.[0]?.delta?.content || ""; } catch {}
    }
    pump(false);
  }
  pump(true);
  return full;
}

async function askLocal(userText, { lively = false, temperature } = {}) {
  const msgs = [{ role: "system", content: systemPrompt(true) }, ...recentHistory(12), { role: "user", content: userText + "\n" + quickSenses() + "\n(" + (window.Mind?.context(true) || "") + ")" }];
  let text;
  // her own chatter isn't streamed: it gets checked for repeats before she says it
  if (lively) ({ text } = await api("/api/local", { method: "POST", signal: askAbort?.signal, body: JSON.stringify({ messages: msgs, max_tokens: 120, lively, temperature }) }));
  else {
    try { text = await askLocalStreaming(msgs); localSpoke = true; }
    catch (e) { if (e.final || e.name === "AbortError") throw e; ({ text } = await api("/api/local", { method: "POST", signal: askAbort?.signal, body: JSON.stringify({ messages: msgs, max_tokens: 220 }) })); }
  }
  const cmds = [];
  const allowMove = !autoTurn || settings.autoMove;
  const clean = text.replace(/\[(drive|part|stop|song|sfx|vibrate|effect)(?::([^\]:]+))?(?::([^\]:]+))?\]/gi, (_, k, a, b) => { cmds.push([k.toLowerCase(), a?.trim(), b?.trim()]); return ""; });
  // Any other leftover [word:thing] tags the small model invented: drop them too.
  const said = takeMood(clean).replace(/\[[a-z _-]{2,20}(?::[^\]\n]{0,40})?\]/gi, "").replace(/\s{2,}/g, " ").trim();
  (async () => {
    for (const [k, a, b] of cmds) {
      const fun = { song: () => playSong({ song: a }), sfx: () => Abilities.sfx(a), vibrate: () => Abilities.vibrate(a),
        effect: () => { Face.effect(a, 6); return "effect " + a; } };
      if (fun[k]) { transcriptLine("act", `${k} ${a} → ${await fun[k]()}`); continue; }
      if (!allowMove && k !== "stop") { transcriptLine("act", `${k} ${a || ""} skipped: moving on her own is off`); continue; }
      const out = k === "stop" ? (await stopAll("her own decision"), "stopped") : k === "drive" ? await drive(a, Number(b) || 1) : await usePart(a, b);
      transcriptLine("act", `${k} ${a || ""} ${b || ""} → ${out}`);
    }
  })();
  return said;
}

// One thing at a time, but nothing he says is ever dropped:
//  - if she's busy with her OWN chatter, that's cancelled and he goes first;
//  - if she's busy answering him, his next message waits its turn (and shows in the chat right away);
//  - if a turn has been stuck for over 2.5 minutes, it's abandoned.
let askGen = 0, askAbort = null, busySince = 0, busyIsAuto = false, pendingAsk = null;
function cancelAsk(why) {
  askGen++; askAbort?.abort(); busy = false; autoTurn = false;
  speakToken++; try { speechSynthesis.cancel(); } catch {} talking = false; Face.setTalking(false);
  setFaceState("thinking", false); logEvent("auto", { detail: "dropped what she was doing: " + why });
}
async function ask(userText, opts = {}) {
  if (busy) {
    if (opts.auto) return;                                             // her own chatter never interrupts or queues
    if (busyIsAuto) cancelAsk("he spoke");
    else if (Date.now() - busySince > 150000) cancelAsk("the last turn got stuck");
    else {
      if (opts.quiet) return;
      if (!opts.shown) { transcriptLine("me", userText); opts = { ...opts, shown: true }; }
      pendingAsk = { userText, opts };
      $("#heard").textContent = "One second, finishing my last thought…";
      return;
    }
  }
  const gen = ++askGen;
  busy = true; busySince = Date.now(); busyIsAuto = !!opts.auto; askAbort = new AbortController();
  setFaceState("thinking", true);
  autoTurn = !!opts.auto;
  if (!opts.quiet) { if (!opts.shown) transcriptLine("me", userText); logEvent("heard", { text: userText }); lastTalk = Date.now(); window.Mind?.onUserSaid(userText); }
  window.Face?.poke();
  let reply = "", brain = "", failed = false;
  localSpoke = false;
  const started = Date.now();
  try {
    // Brain order comes from Settings. Each online brain is tried in turn; offline is last.
    // Make sure "online" is true right now, so she never sits waiting on an internet that isn't there.
    if (!navigator.onLine) status.online = false;
    else if (Date.now() - statusAt > 20000) await refreshStatus();
    const online = status.online && navigator.onLine;
    let order = { auto: ["gemini", "claude"], "auto-claude": ["claude", "gemini"], gemini: ["gemini"], claude: ["claude"], local: [] }[settings.brain] || ["gemini", "claude"];
    // her own chatter goes to the offline brain when it's running: free, private, works with no internet
    if (opts.auto && settings.chatter !== "brain" && status.local) order = [];
    const have = { gemini: status.geminiKeyCount > 0, claude: status.hasKey };
    const NAMES = { gemini: "Gemini", claude: "Claude" };
    const only = settings.brain === "gemini" || settings.brain === "claude";
    for (const b of order) {
      if (!have[b] || !online) continue;
      $("#heard").textContent = `thinking (${NAMES[b]})…`;
      try { reply = await (b === "gemini" ? askGemini : askClaude)(userText); brain = b; break; }
      catch (e) {
        logEvent("error", { where: b, detail: e.message });
        window.Behaviors?.netFail();
        transcriptLine("act", `${NAMES[b]} didn't answer: ${e.message}`);
        if (only) throw e;
      }
    }
    if (!brain && order.length && !opts.quiet) {
      const why = !online ? "no internet" : !order.some(b => have[b]) ? "no Gemini or Claude key" : "online brains failed";
      transcriptLine("act", `Using the offline brain (${why})`);
    }
    if (!brain) {
      setFaceState("offline", true); window.Face?.thinkStyle("local");
      $("#heard").textContent = "thinking with the offline brain…";
      reply = await askLocal(userText, { lively: !!opts.auto }); brain = "nessari-offline";
    } else setFaceState("offline", false);
  } catch (e) {
    if (gen !== askGen) return;                                        // this turn was cancelled; a newer one is running
    setMood("confused"); failed = true;
    reply = "My brain just glitched. " + e.message;
    logEvent("error", { where: "ask", detail: e.message });
  }
  if (gen !== askGen) return;
  // Her own chatter: never repeat herself. Too close to something she already said → one more try, then silence.
  const quietReply = r => !r || /\[quiet\]/i.test(r) || r.replace(/[^a-z]/gi, "").length < 2;
  if (opts.auto && !failed && window.Variety) {
    let same = quietReply(reply) ? null : Variety.mostSimilar(reply);
    if (same && same.sim > 0.55) {
      logEvent("auto", { detail: `caught a repeat (${Math.round(same.sim * 100)}% like "${same.text}"), trying again` });
      const again = userText + `\n(You were about to say "${reply}", but that's basically what you already said ${same.text ? `("${same.text}")` : ""}. Say something completely different in idea and wording, or reply [quiet].)`;
      try { reply = brain === "gemini" ? await askGemini(again) : brain === "claude" ? await askClaude(again) : await askLocal(again, { lively: true, temperature: 1.2 }); }
      catch { reply = ""; }
      if (gen !== askGen) return;
      same = quietReply(reply) ? null : Variety.mostSimilar(reply);
      if (same && same.sim > 0.55) { logEvent("auto", { detail: "still a repeat, staying quiet: " + reply }); reply = ""; }
    }
    if (quietReply(reply)) { reply = ""; Face.gesture(["side_eye_left", "side_eye_right", "squint", "look_up"][Math.floor(Math.random() * 4)]); }
  }
  reply = String(reply || "").replace(/\[quiet\]/gi, "").trim();
  setFaceState("thinking", false);
  $("#heard").textContent = "";
  autoTurn = false;
  if (failed) transcriptLine("act", reply);               // shown, but not saved into the conversation
  else if (opts.auto) { if (reply) history.push({ role: "user", content: "(" + (opts.note || "you spoke up on your own") + ")", auto: true }); }
  else if (!opts.quiet) history.push({ role: "user", content: userText });
  if (reply && !failed) {
    history.push({ role: "assistant", content: reply });
    window.Mind?.onSheSaid(reply);
    window.Variety?.record(reply, opts.topic || (opts.auto ? "auto" : "chat"));
    transcriptLine("bot", reply);
    logEvent("said", { text: reply, brain, seconds: Math.round((Date.now() - started) / 1000) });
  }
  history = history.slice(-60);
  saveConversation();
  busy = false;
  if (pendingAsk) { const p = pendingAsk; pendingAsk = null; setTimeout(() => ask(p.userText, p.opts), 50); }   // what he said while she was busy
  if (localSpoke && !failed) { await endAppend(); $("#said").textContent = reply; }      // already said it while streaming
  else if (reply) await speak(reply);
}
let localSpoke = false;

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
  out.push("Your head is a phone. One day you'll get a body under a foot tall, with little tank treads and arms that lift a few ounces, but for now you're just the head.");
  if (p.body === "frustrated") out.push("You know you could do more with a proper body, but the parts are a while away. Don't bring your body up in conversation; only react when he asks you to move or do something physical, and celebrate small wins when parts finally get plugged in.");
  else if (p.body === "proud") out.push("You love your little body, however ridiculous it is, and you're thrilled about every new part.");
  else out.push("You treat your body matter-of-factly.");
  out.push("If he asks for something a missing part would do, say so briefly. Never pretend you moved, saw, or did something you didn't.");
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
  persona = buildPersona(personality);       // always rebuilt, so personality wording improvements arrive with updates
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
  if (convSlug) await switchConversationIfNeeded();
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
  $("#pTest").onclick = async () => { readPersonaForm(); await savePersonality(); $("#panel").hidden = true; document.body.classList.remove("panel-open"); ask("(system: your personality was just updated. Say hi in your new personality.)", { quiet: true }); };
  $("#pUndo").onclick = async () => {
    const names = await listVersions();
    if (!names.length) return alert("Nothing to undo yet.");
    await restoreVersion(names[0], false);
    $("#pUndo").textContent = "Undone ✓"; setTimeout(() => $("#pUndo").textContent = "Undo last change", 1200);
  };
})();

/* ================= her own life ================= */
// She speaks up when it's been quiet a while, and reacts to things that happen to her body.
let autoTurn = false;                       // true while she's acting on her own (blocks moving unless allowed)
let lastTalk = Date.now();                  // last time anyone (him or her) said something
let nextAuto = 0;

const AUTO_GAP = { rare: [15, 30], normal: [5, 12], chatty: [2, 5] };   // minutes
function scheduleAuto() {
  const g = AUTO_GAP[settings.auto];
  nextAuto = g ? Date.now() + (g[0] + Math.random() * (g[1] - g[0])) * 60000 : Infinity;
}
scheduleAuto();

const IDEAS = [
  "say a random thought you just had",
  "ask him a question about his day or what he's up to",
  "comment on the time of day",
  "bring up something from your memory notes",
  "do a short bit for the YouTube channel, like you're being filmed",
  "act bored and say what you'd rather be doing right now",
  "make a dramatic announcement about something tiny",
  "check your own sensors and comment on what you notice",
  "look around with your camera and comment on what you see",
  "look with your camera and roast what you see, playfully"
];
const nightNow = () => { const h = new Date().getHours(); return h >= 23 || h < 7; };
const canSpeakUp = () => !busy && !talking && !listening && document.visibilityState === "visible";

async function speakUp(prompt, note, topic = "idle", kind = "react") {
  if (!canSpeakUp()) return false;
  if (window.Variety?.shouldStayQuiet(topic)) { Face.gesture(Math.random() < 0.5 ? "side_eye_left" : "eye_roll"); logEvent("auto", { detail: "stayed quiet (said enough about " + topic + " today): " + note }); return false; }
  logEvent("auto", { detail: note });
  const guide = window.Variety ? window.Variety.guide(topic, kind) : "";
  await ask(prompt.replace(/\)\s*$/, "") + guide + ")", { quiet: true, auto: true, note, topic });
  lastTalk = Date.now();
  return true;
}

function idleTick() {
  if (settings.auto === "off" || (settings.night && nightNow())) return;
  if (Date.now() < nextAuto || Date.now() - lastTalk < 90000) return;   // never right after a conversation
  if (window.Mind) {
    if (Mind.isSleeping() || Mind.presenceScore() < 0.5) return;        // nobody around: no talking to an empty room
    if (Mind.activeLoops().some(l => l.when === "anytime") && Math.random() < 0.5) { Mind.triggerLoops("anytime"); scheduleAuto(); return; }
    if (Mind.S.boredom < 0.35 && Math.random() < 0.7) { scheduleAuto(); return; }   // not bored enough to bother
  }
  const online = status.online && (status.hasKey || status.geminiKeyCount > 0);
  const offlineChatter = settings.chatter !== "brain" && status.local;
  const ideas = online && !offlineChatter ? IDEAS : IDEAS.filter(i => !/camera|sensors/.test(i));   // the offline brain can't see or use tools
  const idea = ideas[Math.floor(Math.random() * ideas.length)];
  const mins = Math.round((Date.now() - lastTalk) / 60000);
  speakUp(`(system: it's been quiet for about ${mins} minutes. Speak up on your own, unprompted. Idea: ${idea}. One or two sentences. Use a tool first if the idea needs one. Don't greet him like it's the first time today.)`,
    "spoke up on her own: " + idea, "idle:" + idea.split(" ").slice(0, 3).join(" "), "idle").then(ok => { if (ok) scheduleAuto(); });
}

// ---- things happening to her ----
const cooldown = {};
function react(key, what, minutes = 2, important = false) {
  if (window.Mind) return Mind.perceive(key, what, { minutes, important });
  if (!settings.react) return;
  if (settings.night && nightNow() && !important) return;
  if (cooldown[key] && Date.now() - cooldown[key] < minutes * 60000) return;
  cooldown[key] = Date.now();
  speakUp(`(system: something just happened to you: ${what}. React out loud in character, one short sentence.)`, "reacted: " + what);
}

// picked up or shaken: a jolt well beyond gravity
let calmSince = Date.now();
window.addEventListener("devicemotion", e => {
  const a = e.accelerationIncludingGravity; if (!a || a.x == null) return;
  const g = Math.hypot(a.x, a.y, a.z);
  if (Math.abs(g - 9.8) > 4) {
    if (Date.now() - calmSince > 20000) react("shake", "someone picked you up or shook you", 1);
    calmSince = Date.now();
  }
});

// charger and battery
let lastLevel = null;
setTimeout(() => {
  if (!battery) return;
  battery.addEventListener("chargingchange", () =>
    react("charge", battery.charging ? "your charger was just plugged in" : "your charger was just unplugged", 1));
  battery.addEventListener("levelchange", () => {
    const pct = Math.round(battery.level * 100);
    if (lastLevel !== null && !battery.charging && [20, 10, 5].some(x => lastLevel > x && pct <= x))
      react("battery" + pct, `your battery just dropped to ${pct}%`, 30, true);
    lastLevel = pct;
  });
  lastLevel = Math.round(battery.level * 100);
}, 3000);

// tipped over, lights, a hand near her face (Termux:API sensors)
let wasTipped = false, lastLux = null, wasNear = false;
function sensorEvents() {
  // only a real fall counts (on her side / face down), and only if she was standing a moment ago
  if (tipped && !wasTipped && pose !== "upside_down") react("tip", pose === "face_down" ? "you just fell flat on your face (screen down)" : "you just fell over onto your side", 1, true);
  if (!tipped && wasTipped && pose === "upright") react("untip", "someone stood you back up after you fell over", 1);
  wasTipped = tipped;

  const lightName = hw?.sensors && Object.keys(hw.sensors).find(n => /light/i.test(n) && !/proximity/i.test(n));
  const lux = lightName ? hw.sensors[lightName][0] : light;
  if (lux != null && lastLux != null) {
    if (lastLux > 25 && lux < 3) react("dark", "the lights just went off around you", 3);
    if (lastLux < 3 && lux > 25) react("bright", "the lights just came on", 3);
  }
  if (lux != null) lastLux = lux;

  const proxName = hw?.sensors && Object.keys(hw.sensors).find(n => /proximity/i.test(n));
  if (proxName) {
    const near = hw.sensors[proxName][0] < 1;
    if (near && !wasNear) react("near", "something is right up against your face (a hand or object covering your sensor)", 3);
    wasNear = near;
  }
}

setInterval(() => { try { sensorEvents(); idleTick(); } catch (e) { logEvent("error", { where: "life", detail: e.message }); } }, 4000);

// ---- touches on her face (face.js reacts instantly; she comments out loud now and then) ----
const TOUCH_VERB = {
  tap: z => `he poked your ${z}`,
  double_tap: z => `he double-tapped your ${z}`,
  hold: z => `he's pressing and holding his finger on your ${z}`,
  stroke: z => `he's gently stroking your ${z}`,
  scratch: z => `he's scratching your ${z}`,
  rub: z => `he's rubbing your ${z} in little circles`,
  swipe: (z, d) => `he swiped ${d} across your ${z}`,
  tickle: z => `he's rapid-fire tapping your ${z}, tickling you`,
  slap: z => `he just slapped your face with his whole hand`,
  squish: z => `he's pinching/squishing your face with two fingers`,
  stretch: z => `he's stretching your face apart with two fingers`,
  boop: z => z === "nose" ? "he just booped you on the nose" : `he two-finger booped your ${z}`
};
const recentTouches = [];
let lastTouchTalk = 0;
if (window.Face) Face.onTouch = (kind, zone = "face", extra = "") => {
  lastTalk = Date.now();
  window.Tricks?.bump("touch_" + kind);
  if (kind === "hold" && settings.listen === "push" && !listening && !busy) { Abilities.sfx("beep"); startListening(); return; }   // press and hold = talk
  if (kind === "swipe" && /all the way/.test(extra)) { Tricks.cyclePersona(extra.startsWith("left") ? -1 : 1); return; }
  const felt = window.Mind ? Mind.touch(kind, zone) : null;      // irritation/amusement accumulate and fade; repeats escalate
  if (!settings.react) return;
  const same = recentTouches.filter(x => x.kind === kind).length;
  const streak = same >= 3 ? ` That's the ${same}${same === 3 ? "rd" : "th"} time in the last minute.` : "";
  const desc = (TOUCH_VERB[kind] || (z => `he touched your ${z}`))(zone, extra);
  const base = { slap: 0.95, tickle: 0.7, scratch: 0.6, stroke: 0.55, boop: 0.6, tap: /eye/.test(zone) ? 0.8 : 0.5, double_tap: 0.55, hold: 0.45, squish: 0.6, stretch: 0.55, rub: 0.5, swipe: 0.35 }[kind] ?? 0.5;
  if (window.Mind) Mind.perceive(`touch-${kind}-${zone}`, `${desc}.${streak}`, { base, recoverMin: 3, source: "FELT" });
  else if (canSpeakUp()) speakUp(`(system: ${desc}.${streak} React out loud in character, one short sentence.)`, `touched: ${kind} ${zone}`);
};

// ---- eyes follow movement seen by the camera ----
// Compares tiny 64x48 frames ~10 times a second; where pixels changed is where something moved.
let trackVid = null, trackCtx = null, prevFrame = null, trackTimer = null, stillSince = Date.now();
async function startTracking() {
  if (!settings.track || trackTimer) return;
  try { await camOn(); } catch (e) { logEvent("error", { where: "tracking", detail: "camera: " + e.message }); return; }
  trackVid = window.trackVid = document.createElement("video");
  trackVid.muted = true; trackVid.playsInline = true;
  const c = document.createElement("canvas"); c.width = 64; c.height = 48;
  trackCtx = c.getContext("2d", { willReadFrequently: true });
  trackTimer = setInterval(trackTick, 100);
}
function stopTracking() { clearInterval(trackTimer); trackTimer = null; prevFrame = null; }
function trackTick() {
  if (document.hidden || !camStream) return;
  if (trackVid.srcObject !== camStream) { trackVid.srcObject = camStream; trackVid.play().catch(() => {}); prevFrame = null; return; }
  if (trackVid.readyState < 2) return;
  trackCtx.drawImage(trackVid, 0, 0, 64, 48);
  const d = trackCtx.getImageData(0, 0, 64, 48).data;
  const gray = new Uint8Array(64 * 48);
  for (let i = 0; i < gray.length; i++) gray[i] = (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10;
  window.Tricks?.scanTick();
  const mode = settings.eyeMode || "motion";
  if (mode !== "motion") {                         // follow a bright light or a color instead of movement
    let n = 0, sx = 0, sy = 0, maxL = 0;
    if (mode === "bright") for (let i = 0; i < gray.length; i++) maxL = Math.max(maxL, gray[i]);
    for (let i = 0; i < gray.length; i++) {
      let hit;
      if (mode === "bright") hit = maxL > 200 && gray[i] > maxL * 0.92;
      else { const [h, sat, val] = Tricks.hsv(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]); hit = sat > 0.4 && val > 0.3 && Tricks.colorName(h, sat, val) === mode; }
      if (hit) { n++; sx += i % 64; sy += (i / 64) | 0; }
    }
    if (n > gray.length * 0.004) {
      let x = (sx / n) / 32 - 1, y = (sy / n) / 24 - 1;
      if (settings.facing === "user") x = -x;
      window.Face?.lookAt(x * 1.1, y * 0.8);
    }
  }
  if (prevFrame) {
    let n = 0, sx = 0, sy = 0;
    for (let i = 0; i < gray.length; i++) {
      if (Math.abs(gray[i] - prevFrame[i]) > 28) { n++; sx += i % 64; sy += (i / 64) | 0; }
    }
    const frac = n / gray.length;
    window.lastMotion = { frac, t: performance.now() };
    // ignore tiny noise, and whole-picture changes (lights flicking, the robot itself moving)
    if (frac > 0.006 && frac < 0.5) {
      let x = (sx / n) / 32 - 1, y = (sy / n) / 24 - 1;
      if (settings.facing === "user") x = -x;                // front camera: mirror so she looks AT you
      if (mode === "motion" && !(performance.now() < (window.visionLookUntil || 0)) && !window.Mind?.distracted()) window.Face?.lookAt(x * 1.1, y * 0.8);   // a seen face (or a distraction) wins
      if (Date.now() - stillSince > 120000 && frac > 0.05) {
        window.Tricks?.bump("visitors"); window.Tricks?.diary("someone walked in");
        if (mood === "bored" || mood === "sleepy") setMood("calm");
      }
      if (Date.now() - stillSince > 120000 && frac > 0.05)
        react("motion", "you just saw someone or something move in front of your camera after it was still for a while", 5);
      stillSince = Date.now();
    }
  }
  try { window.Flow?.feed(prevFrame, gray, settings.facing === "user"); } catch {}      // which way things are moving (flow.js)
  prevFrame = gray;
}
setTimeout(startTracking, 2500);

/* ================= panel UI ================= */
function unlockExtras() {
  if ("wakeLock" in navigator && !window._wl) navigator.wakeLock.request("screen").then(l => { window._wl = l; l.onrelease = () => window._wl = null; }).catch(() => {});
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) unlockExtras(); });

$("#openPanel").onclick = () => { $("#panel").hidden = false; document.body.classList.add("panel-open"); showTab("status"); };
$("#openTalk").onclick = () => { $("#panel").hidden = false; document.body.classList.add("panel-open"); showTab("talk"); $("#typeBox").focus(); };
function renderMute() { $("#muteBtn").textContent = settings.muted ? "🔇" : "🔊"; $("#muteBtn").classList.toggle("muted", !!settings.muted); }
$("#muteBtn").onclick = () => {
  settings.muted = !settings.muted; saveSettings(); renderMute();
  Abilities.setMuted(settings.muted);
  if (settings.muted) speechSynthesis.cancel();
};
renderMute(); Abilities.setMuted(!!settings.muted);
$("#openTermux").onclick = () => {
  location.href = "intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=com.termux;end";
};
$("#closePanel").onclick = () => { $("#panel").hidden = true; document.body.classList.remove("panel-open"); };
$$("#tabs button").forEach(b => b.onclick = () => showTab(b.dataset.tab));
function showTab(name) {
  $$("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === name));
  $$(".tab").forEach(t => t.hidden = t.id !== "tab-" + name);
  if (name === "status") renderStatus();
  if (name === "files") openDir("");
  if (name === "logs") loadLogs();
  if (name === "persona") { renderPersonaForm(); renderVersions(); }
  if (name === "tricks") renderTricks();
  if (name === "settings") renderRemoteInfo();
  if (name === "sensors") $("#sensorDump").textContent = sensorReport(true);
  if (name === "talk") scrollChat();
}
// newest message at the bottom, always (also after opening the tab: a hidden list can't scroll)
function scrollChat() { const t = $("#transcript"); requestAnimationFrame(() => { t.scrollTop = t.scrollHeight; }); }

function transcriptLine(who, text) {
  const d = document.createElement("div"); d.className = "line " + who; d.textContent = text;
  const t = $("#transcript");
  const nearBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 120;     // don't yank you down if you scrolled up to read
  t.append(d); while (t.children.length > 200) t.firstChild.remove();
  if (nearBottom || who === "me" || t.offsetParent === null) t.scrollTop = t.scrollHeight;
}
$("#typeForm").onsubmit = e => { e.preventDefault(); const v = $("#typeBox").value.trim(); if (v) { $("#typeBox").value = ""; ask(v); } };
// what she's doing right now, shown in the Talk tab so a typed message never seems to vanish
setInterval(() => {
  const el = $("#talkStatus"); if (!el || $("#tab-talk").hidden) return;
  const t = busy ? ($("#heard").textContent || "thinking…") + (pendingAsk ? "  (your next message is waiting)" : "") + (Date.now() - busySince > 15000 ? `  ${Math.round((Date.now() - busySince) / 1000)}s` : "")
    : talking ? "talking…" : "";
  if (el.textContent !== t) el.textContent = t;
}, 400);

function refreshChips() {
  const on = status.online, g = on && status.geminiKeyCount > 0, c = on && status.hasKey;
  const firstOnline = { auto: g ? "Gemini" : c && "Claude", "auto-claude": c ? "Claude" : g && "Gemini", gemini: g && "Gemini", claude: c && "Claude" }[settings.brain];
  const brain = settings.brain === "local" ? "offline" : (firstOnline || (status.local ? "offline" : "none"));
  $("#chipBrain").textContent = "brain: " + brain;
  window.Face?.setLabel("brain: " + brain);
  $("#chipBrain").className = "chip " + (brain === "none" ? "bad" : "ok");
  $("#chipBody").textContent = link.connected ? "body: " + link.kind : "body: none";
  $("#chipBody").className = "chip " + (link.connected ? "ok" : "bad");
  $("#chipBatt").textContent = battery ? `🔋 ${Math.round(battery.level * 100)}%${battery.charging ? "⚡" : ""}` : "🔋 ?";
}

let serverFails = 0;
let statusAt = 0;
async function refreshStatus() {
  try {
    status = await api("/api/status"); statusAt = Date.now();
    if (serverFails >= 2) { $("#said").textContent = "I'm back."; setFaceState("offline", false); logEvent("boot", { detail: "server came back" }); }
    serverFails = 0;
  } catch {
    status = { online: false, local: false, hasKey: false };
    if (++serverFails === 2) { setMood("confused"); setFaceState("offline", true); $("#said").textContent = "My brain server stopped. Open Termux and type: robot"; }
  }
  refreshChips(); if (!$("#panel").hidden && !$("#tab-status").hidden) renderStatus();
}
setInterval(refreshStatus, 15000);

function renderStatus() {
  const items = [
    ["Online brain", status.hasKey ? (status.online ? "Claude ready" : "no internet") : "no API key"],
    ["Claude key", status.keyCount ? `#${status.keyInUse} of ${status.keyCount}` : "none"],
    ["Gemini key", status.geminiKeyCount ? `#${status.geminiKeyInUse} of ${status.geminiKeyCount}` : "none"],
    ["Cache savings", (() => { const t = cacheStats.read + cacheStats.written + cacheStats.fresh; return t ? Math.round(cacheStats.read / t * 100) + "% reused" : "—"; })()],
    ["Offline brain", status.local ? "running" : status.localState === "loading" ? "loading…" : status.localError ? "error: " + status.localError.slice(0, 60) : "not running"],
    ["Offline hearing", { ready: "ready", slow: "works (slow start)", none: "not installed" }[status.hearing] || "?"],
    ["Hearing now", window.Hearing?.active ? "phone's own (offline)" : listening ? "Google's (online)" : "off"],
    ["Offline voice", voices.some(v => v.localService) ? "ready" : ttsBrokenUntil > Date.now() ? "phone's own" : voices.length ? "online voices only" : "?"],
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
  if (el.type === "checkbox") { el.checked = settings[key]; el.onchange = () => { settings[key] = el.checked; saveSettings(); onSettingChange(key); }; }
  else { el.value = settings[key]; el.onchange = el.oninput = () => { settings[key] = cast(el.value); saveSettings(); onSettingChange(key); }; }
}
function onSettingChange(key) {
  if (key === "listen") { stopListening(); if (settings.listen === "always") startListening(); }
  if (key === "hearing") { stopListening(); window.Hearing?.stop(); if (settings.listen === "always") setTimeout(startListening, 400); }
  if (key === "facing" && camStream) { camOff(); camOn().catch(() => {}); }
  if (key === "ears") { if (settings.ears) Tricks.earsStart(); else if (!window.Hearing?.active) Tricks.earsStop(); }
  if (key === "track") { if (settings.track) startTracking(); else { stopTracking(); camOff(); } }
  refreshChips();
}
bindSetting("#setBrain", "brain"); bindSetting("#setChatter", "chatter"); bindSetting("#setHearing", "hearing"); bindSetting("#setListen", "listen"); bindSetting("#setWake", "wake");
bindSetting("#setVoice", "voice"); bindSetting("#setRate", "rate", Number); bindSetting("#setPitch", "pitch", Number);
bindSetting("#setFacing", "facing"); bindSetting("#setTipStop", "tipStop");
bindSetting("#setTrack", "track"); bindSetting("#setVision", "vision"); bindSetting("#setEars", "ears"); bindSetting("#setQr", "qr");
bindSetting("#setAuto", "auto"); bindSetting("#setReact", "react"); bindSetting("#setNight", "night"); bindSetting("#setAutoMove", "autoMove");
$("#btnFull").onclick = () => document.documentElement.requestFullscreen?.().catch(() => {});
$("#btnTestVoice").onclick = () => speak("Testing. One two. Yes, I can hear myself, unfortunately.");
$("#btnForget").onclick = () => {
  if (!confirm("Clear the conversation? Her memory notes and personality stay.")) return;
  history = []; saveConversation(); $("#transcript").innerHTML = "";
};

// Installable app: lets "Add to Home screen" make a real full-screen app with her icon.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
// Opened from the browser instead of the home-screen icon? Go full screen on the first tap.
const isApp = matchMedia("(display-mode: fullscreen)").matches || matchMedia("(display-mode: standalone)").matches;
// keep her face upright even when the robot tilts (only works in full screen / as an installed app)
const lockPortrait = () => screen.orientation?.lock?.("portrait").catch(() => {});
document.addEventListener("fullscreenchange", lockPortrait); if (isApp) lockPortrait();
// network type changes (Wi-Fi ↔ mobile data, slow connection)
if (navigator.connection) {
  let lastNet = navigator.connection.type || navigator.connection.effectiveType;
  navigator.connection.addEventListener("change", () => {
    const n = navigator.connection.type || navigator.connection.effectiveType;
    if (n && n !== lastNet) window.Mind?.event("network", `connection changed from ${lastNet} to ${n}${navigator.connection.effectiveType === "2g" || navigator.connection.effectiveType === "slow-2g" ? " (very slow)" : ""}`, { source: "FELT", salience: 0.35 });
    lastNet = n;
  });
}
if (!isApp) window.addEventListener("pointerdown", function fs(e) {
  if (e.target.closest("#panel, button, input, select, textarea")) return;
  document.documentElement.requestFullscreen?.({ navigationUI: "hide" }).catch(() => {});
  window.removeEventListener("pointerdown", fs);
});

/* ================= live video to other phones (WebRTC) ================= */
const lives = {};                                    // session → RTCPeerConnection
async function listCameras() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput");
    return devs.map((d, i) => ({ id: d.deviceId, label: d.label || `camera ${i + 1}` }));
  } catch { return []; }
}
// Switch which camera she uses (her eyes, photos and any live video follow along).
async function switchCamera(deviceId) {
  settings.cameraId = deviceId || ""; saveSettings();
  camOff(); await camOn();
  const track = camStream.getVideoTracks()[0];
  for (const pc of Object.values(lives)) pc.getSenders().find(s => s.track?.kind === "video")?.replaceTrack(track);
  return track?.label || "camera";
}
async function startLive(session, { audio = true } = {}) {
  if (!/^[\w-]{8,64}$/.test(session || "")) return;
  if (Object.keys(lives).length >= 3) { const old = Object.keys(lives)[0]; lives[old].close(); delete lives[old]; }
  await camOn();
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  lives[session] = pc;
  pc.addTrack(camStream.getVideoTracks()[0], camStream);
  if (audio) {
    try { const mic = await navigator.mediaDevices.getUserMedia({ audio: true }); mic.getAudioTracks().forEach(t => pc.addTrack(t, mic)); pc._mic = mic; } catch {}
  }
  const end = () => { pc._mic?.getTracks().forEach(t => t.stop()); delete lives[session]; };
  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) { setTimeout(() => { if (pc.connectionState !== "connected") { pc.close(); end(); } }, 5000); }
    if (pc.connectionState === "connected") { transcriptLine("act", "Someone is watching live through my camera"); window.Mind?.event("live_video", "someone started watching your camera live from another phone", { source: "FELT", salience: 0.4 }); }
  };
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise(r => { if (pc.iceGatheringState === "complete") return r(); pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && r(); setTimeout(r, 3000); });
  await api("/api/rtc/offer", { method: "POST", body: JSON.stringify({ session, offer: pc.localDescription }) });
  for (let i = 0; i < 120 && lives[session]; i++) {               // wait up to a minute for the viewer's answer
    const { answer } = await api("/api/rtc/answer?session=" + session).catch(() => ({}));
    if (answer) { await pc.setRemoteDescription(answer); return; }
    await sleep(500);
  }
  pc.close(); end();
}
function stopLive(session) { const pc = lives[session]; if (pc) { pc.close(); pc._mic?.getTracks().forEach(t => t.stop()); delete lives[session]; } }

/* ================= remote control (another phone) ================= */
async function remoteTick() {
  if (!status.remote) return;
  let cmds = [];
  try { cmds = (await api("/api/remote/poll")).commands || []; } catch { return; }
  for (const c of cmds) {
    try {
      transcriptLine("act", `remote: ${c.cmd} ${c.arg ?? ""}`);
      if (c.cmd === "say") await speak(String(c.arg || ""));
      else if (c.cmd === "ask") ask(String(c.arg || ""));
      else if (c.cmd === "trick") Tricks.runTrick(c.arg);
      else if (c.cmd === "sfx") Abilities.sfx(c.arg);
      else if (c.cmd === "song") playSong({ song: c.arg });
      else if (c.cmd === "effect") Face.effect(c.arg, 8);
      else if (c.cmd === "gesture") Face.gesture(c.arg);
      else if (c.cmd === "mood") setMood(c.arg);
      else if (c.cmd === "vibrate") Abilities.vibrate(c.arg);
      else if (c.cmd === "voice") { settings.voiceStyle = c.arg; saveSettings(); }
      else if (c.cmd === "photo") { const data = await snapshot(); await fetch("/api/remote/photo", { method: "PUT", body: await (await fetch("data:image/jpeg;base64," + data)).blob() }); }
      else if (c.cmd === "save_photo") transcriptLine("act", await takePhoto("remote"));
      else if (c.cmd === "stop") stopAll("remote");
      else if (c.cmd === "rtc_start") startLive(c.arg?.session, { audio: c.arg?.audio !== false }).catch(e => logEvent("error", { where: "live video", detail: e.message }));
      else if (c.cmd === "rtc_stop") stopLive(c.arg?.session);
      else if (c.cmd === "camera") transcriptLine("act", "Switched to " + await switchCamera(c.arg));
    } catch (e) { logEvent("error", { where: "remote", detail: e.message }); }
  }
  api("/api/remote/report", { method: "POST", body: JSON.stringify({
    mood, said: $("#said").textContent.slice(0, 300), battery: battery ? Math.round(battery.level * 100) : null, charging: battery?.charging,
    brain: $("#chipBrain").textContent, body: $("#chipBody").textContent, busy,
    cameras: await listCameras(), cameraId: settings.cameraId || camStream?.getVideoTracks()[0]?.getSettings?.().deviceId || "", watching: Object.keys(lives).length,
    lists: { tricks: Tricks.list(), sfx: Abilities.sfxList, songs: Abilities.songList, effects: Face.effects, gestures: Face.gestures, moods: MOOD_NAMES, voices: Object.keys(VOICE_STYLES) }
  }) }).catch(() => {});
}
setInterval(remoteTick, 1200);

async function renderRemoteInfo() {
  try {
    const r = await api("/api/remote/info");
    $("#setRemote").checked = r.enabled;
    $("#remoteInfo").textContent = r.enabled
      ? `On. On the other phone (same Wi-Fi or hotspot), open:\n${r.urls.join("\n") || "(no Wi-Fi address yet)"}\nPIN: ${r.pin}`
      : "Off. Other devices can't control her.";
  } catch {}
}
$("#setRemote").onchange = async () => {
  const cfg = JSON.parse(await readFile("config.json").catch(() => "{}"));
  cfg.remote = $("#setRemote").checked;
  if (cfg.remote && !cfg.remotePin) cfg.remotePin = String(Math.floor(1000 + Math.random() * 9000));
  await writeFile("config.json", JSON.stringify(cfg, null, 2));
  await refreshStatus(); renderRemoteInfo();
};

/* ================= boot ================= */
(async function boot() {
  drawFace();
  await loadRobotFiles();
  await loadConversation();
  await refreshStatus();
  await Tricks.loadCustom(); await Tricks.loadStats(); await Mind.loadWorld();
  Tricks.checkChangelog();
  setTimeout(() => Tricks.earsStart(), 3000);
  logEvent("boot", { detail: "face page opened" });
  if (settings.listen === "always") startListening();
  $("#said").textContent = "Tap the mic and talk to me.";
})();
