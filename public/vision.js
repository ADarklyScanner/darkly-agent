// Nessari's real eyes: Google's open-source MediaPipe (Apache 2.0), running on the phone with no internet.
//  - Faces: tracks the closest face, counts people, notices arrivals, departures, someone getting very close.
//  - Expressions: smiling, surprised, frowning; blinks; eyes closed; nods (yes) and head shakes (no); looking at her or away.
//  - Hands: thumbs up/down, open palm, fist, victory, pointing up, "I love you", and waving.
// Needs the engine files from `robot-vision-download`. Without them this quietly does nothing.
const V = window.Vision = {
  available: false, error: null, faces: 0, main: null, expression: "neutral", lookingAtMe: false,
  gesture: null, blinks: 0, mirror: false, listeners: {},
  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); return () => { this.listeners[ev] = this.listeners[ev].filter(f => f !== fn); }; },
  emit(ev, data) { for (const fn of this.listeners[ev] || []) { try { fn(data); } catch (e) { console.error(e); } } }
};
const now = () => performance.now();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const BASE = "./vendor/mediapipe/";

// The models run in a background worker (perception-worker.js) so the face never stutters while she looks.
// If workers can't run the engine on this phone, the same code runs on the page instead.
let engine = null, tick = 0, lastVideoTime = -1, inFlight = false;
let slowMs = 0;                                   // how long a frame of perception takes; extras back off when the phone is busy

function workerEngine() {
  return new Promise((resolve, reject) => {
    const w = new Worker("./perception-worker.js", { type: "module" });
    const pending = new Map(); let seq = 0, ready = false;
    const eng = { mode: "worker", have: {}, audio: false, dead: false,
      call(msg, transfer, ms = 4000) {
        const id = ++seq; msg.id = id;
        return new Promise((res, rej) => {
          const t = setTimeout(() => { pending.delete(id); rej(new Error("worker timeout")); }, ms);
          pending.set(id, d => { clearTimeout(t); res(d); });
          w.postMessage(msg, transfer);
        });
      },
      async frame(v, ts, want) {
        const bitmap = await createImageBitmap(v, { resizeWidth: Math.min(480, v.videoWidth || 480), resizeQuality: "low" });
        const d = await this.call({ type: "frame", bitmap, ts, want }, [bitmap]);
        if (d.error) throw new Error(d.error);
        return d;
      },
      async sound(data, rate) { return (await this.call({ type: "audio", data, rate }, [data.buffer], 3000)).cats; },
      async embedTexts(texts) { return (await this.call({ type: "embed-text", texts }, [], 20000)).vecs; },
      async embedImage(v, sx, sy, sw, sh) { const bitmap = await createImageBitmap(v, sx, sy, sw, sh, { resizeWidth: 224, resizeHeight: 224, resizeQuality: "low" });
        return (await this.call({ type: "embed-image", bitmap }, [bitmap], 5000)).vec; }
    };
    const fail = e => { eng.dead = true; w.terminate(); for (const f of pending.values()) f({ error: "worker died" }); pending.clear(); if (!ready) reject(e); else V.emit("engine-died", e); };
    const timer = setTimeout(() => fail(new Error("worker took too long to start")), 60000);
    w.onerror = e => { e.preventDefault?.(); fail(new Error(e.message || "worker error")); };
    w.onmessage = ({ data: d }) => {
      if (d.type === "ready") { ready = true; clearTimeout(timer); eng.have = d.have; resolve(eng); }
      else if (d.type === "audio-ready") eng.audio = true;
      else if (d.type === "error") { if (d.where === "vision") { clearTimeout(timer); fail(new Error(d.error)); } else eng.audioError = d.error; }
      else if (d.id && pending.has(d.id)) { const f = pending.get(d.id); pending.delete(d.id); f(d); }
    };
    w.postMessage({ type: "init" });
  });
}

async function pageEngine() {
  const C = await import("./perception-common.js");
  const t = await C.makeVisionTasks(false);
  const eng = { mode: "page", have: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, !!v])), audio: false,
    async frame(v, ts, want) { const t0 = now(); const res = C.detect(t, v, ts, want, v.videoWidth || 640, v.videoHeight || 480); return { res, ms: now() - t0 }; },
    async sound(data, rate) { return C.classify(eng.audioTask, data, rate); },
    async embedTexts(texts) { eng.textTask ||= await C.makeTextTask(false); return C.embedTexts(eng.textTask, texts); },
    async embedImage(v, sx, sy, sw, sh) { const c = document.createElement("canvas"); c.width = c.height = 224; c.getContext("2d").drawImage(v, sx, sy, sw, sh, 0, 0, 224, 224);
      const e = t.embed?.embed(c).embeddings?.[0]; return e ? Array.from(e.floatEmbedding || e.quantizedEmbedding || []) : null; }
  };
  try { eng.audioTask = await C.makeAudioTask(false); eng.audio = true; } catch {}
  return eng;
}

async function init() {
  if (settings.perceptionWorker !== false && window.Worker && window.createImageBitmap) {
    try { engine = await workerEngine(); }
    catch (e) { logEvent("error", { where: "vision-worker", detail: e.message + " (running vision on the page instead)" }); }
  }
  if (!engine) {
    try { engine = await pageEngine(); }
    catch (e) { V.error = /import|fetch|Failed|404/i.test(e.message) ? "not downloaded (run robot-vision-download)" : e.message; return; }
  }
  V.available = true; V.engine = engine.mode;
  logEvent("vision", { detail: `vision engine ready (${engine.mode === "worker" ? "background worker" : "on the page"})` + (engine.have.hand ? "" : " (no hand gestures)") });
  V.on("engine-died", async e => {                       // the worker crashed mid-run: carry on without it
    logEvent("error", { where: "vision-worker", detail: "worker stopped: " + e.message + "; switching to the page" });
    engine = null; try { engine = await pageEngine(); V.engine = "page"; } catch { V.available = false; }
  });
  setInterval(loop, 110);
  initAudio();
}
const hasTask = k => !!engine?.have?.[k];
// Sentence embeddings for memory-by-meaning. Null when the text model isn't downloaded (callers fall back to plain matching).
const textCache = new Map(); let textBroken = false;
V.embedTexts = async texts => {
  if (!engine?.embedTexts || textBroken) return null;
  const need = texts.filter(t => !textCache.has(t));
  if (need.length) {
    let vecs = null; try { vecs = await engine.embedTexts(need); } catch { vecs = null; }
    if (!vecs || vecs.some(v => !v?.length)) { textBroken = true; setTimeout(() => { textBroken = false; }, 10 * 60000); return null; }
    need.forEach((t, i) => textCache.set(t, vecs[i]));
    while (textCache.size > 600) textCache.delete(textCache.keys().next().value);
  }
  return texts.map(t => textCache.get(t));
};
V.engineInfo = () => engine ? { mode: engine.mode, have: engine.have, hearing: !!engine.audio, frameMs: V.frameMs } : { mode: "none", error: V.error };

function video() { const v = window.trackVid; return v && v.readyState >= 2 ? v : null; }

let loopN = 0;
async function loop() {
  if (!engine || inFlight || !settings.vision || document.hidden) return;
  const slow = window.Power?.slow || 1; if (slow > 1 && loopN++ % slow) return;     // hot or low on battery: look less often
  const v = video(); if (!v || v.currentTime === lastVideoTime) return;
  lastVideoTime = v.currentTime; tick++;
  const busyPhone = slowMs > 70 || slow > 1;              // the phone is struggling or saving energy: run the extras less often
  const want = { face: true, hand: tick % 2 === 0, pose: tick % (busyPhone ? 9 : 3) === 1,
    obj: tick % (busyPhone ? 30 : 12) === 5, embed: tick % 120 === 60 };
  inFlight = true;
  try {
    const { res, ms } = await engine.frame(v, now(), want);
    slowMs = slowMs * 0.9 + ms * 0.1; V.frameMs = Math.round(slowMs);
    if (res.face) onFaces(res.face);
    if (res.hand) onHands(res.hand);
    if (res.pose) onPose(res.pose);
    if (res.obj) onObjects(res.obj);
    if (res.embed) onScene(res.embed);
  } catch (e) { if ((V.frameErrors = (V.frameErrors || 0) + 1) <= 3) console.warn("vision frame:", e.message); V.lastFrameError = e.message; }   // a dropped frame is fine
  finally { inFlight = false; }
}

// ---------------- faces ----------------
const mirrorX = x => (settings.facing === "user" ? -1 : 1) * (x * 2 - 1);
let lastSeen = now() - 60000, faceSince = 0, lastCount = 0, closeAt = 0, eyesClosedSince = 0, blinkArmed = true;
let exprCandidate = "neutral", exprSince = 0, sizeHistory = [], noseHistory = [], nodAt = 0;
function score(cats, name) { return cats?.find(c => c.categoryName === name)?.score || 0; }

function onFaces(r) {
  const faces = r.faceLandmarks || [];
  V.faces = faces.length;
  if (!faces.length) {
    V.main = null; V.lookingAtMe = false; faceSince = 0; V.faceBoxes = [];
    if (lastCount && now() - lastSeen > 8000) { lastCount = 0; V.emit("left"); }   // gone for 8s = left
    return;
  }
  // closest face = biggest
  const boxes = faces.map(lm => {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0; for (const p of lm) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, lm };
  });
  const i = boxes.reduce((b, f, k) => f.w > boxes[b].w ? k : b, 0), m = boxes[i];
  V.faceBoxes = boxes.map(b => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 })).sort((p, q) => (q.x1 - q.x0) - (p.x1 - p.x0));   // for people.js
  const cx = (m.x0 + m.x1) / 2, cy = (m.y0 + m.y1) / 2;
  // a face is worth more than plain movement, and more still if it's looking at her or talking
  V.faceGaze = { x: mirrorX(cx) * 1.15, y: (cy * 2 - 1) * 0.9 };
  Attention.offer("face", { ...V.faceGaze, salience: 0.5 + (V.lookingAtMe ? 0.12 : 0) + (V.mouthMoving ? 0.1 : 0), ttl: 500, label: window.People?.here?.find(h => h.name && h.sure)?.name ? window.People.here.find(h => h.name && h.sure).name + "'s face" : "his face" });

  // arrivals and counts
  if (!faceSince) faceSince = now();
  if (lastCount === 0 && now() - faceSince > 700) {            // a face has been there for a moment
    if (now() - lastSeen > 20000) V.emit("arrive", { count: faces.length });   // ...after nobody for 20s
    lastCount = faces.length;
  } else if (lastCount && faces.length !== lastCount && now() - faceSince > 1500) { V.emit("count", { count: faces.length, before: lastCount }); lastCount = faces.length; }
  if (lastCount) lastSeen = now();

  // distance: face width share of the picture
  sizeHistory.push([now(), m.w]); sizeHistory = sizeHistory.filter(([t]) => now() - t < 2500);
  if (m.w > 0.55 && now() - closeAt > 60000) { closeAt = now(); V.emit("very_close"); }
  if (sizeHistory.length > 8 && m.w > sizeHistory[0][1] * 1.7 && m.w > 0.3 && now() - closeAt > 30000) { closeAt = now(); V.emit("approach"); }

  // looking at her: nose centered between the outer eye corners
  const nose = m.lm[1], le = m.lm[33], re = m.lm[263];
  const yaw = (nose.x - (le.x + re.x) / 2) / Math.max(0.01, Math.abs(re.x - le.x));
  const was = V.lookingAtMe; V.lookingAtMe = Math.abs(yaw) < 0.18;
  if (was && !V.lookingAtMe) V.emit("look_away"); if (!was && V.lookingAtMe) V.emit("look_at");

  // nods and head shakes: back-and-forth of the nose relative to the face box
  noseHistory.push([now(), (nose.x - m.x0) / m.w, (nose.y - m.y0) / m.h]);
  noseHistory = noseHistory.filter(([t]) => now() - t < 1400);
  if (noseHistory.length > 8 && now() - nodAt > 1800) {
    const rev = k => { let n = 0, dir = 0, ref = noseHistory[0][k];
      for (const p of noseHistory) { const d = p[k] - ref; if (Math.abs(d) > 0.035) { const s = Math.sign(d); if (dir && s !== dir) n++; dir = s; ref = p[k]; } } return n; };
    const ny = rev(2), nx = rev(1);
    if (ny >= 2 && ny > nx) { nodAt = now(); noseHistory = []; V.emit("nod"); }
    else if (nx >= 2 && nx > ny) { nodAt = now(); noseHistory = []; V.emit("shake"); }
  }

  // expressions and blinks (closest face only)
  const cats = r.faceBlendshapes?.[i]?.categories;
  V.main = { x: mirrorX(cx), y: cy * 2 - 1, size: m.w, distance: m.w > 0.4 ? "very close" : m.w > 0.2 ? "close" : m.w > 0.1 ? "across the table" : "far away" };
  if (!cats) return;
  const smile = (score(cats, "mouthSmileLeft") + score(cats, "mouthSmileRight")) / 2;
  const frown = (score(cats, "mouthFrownLeft") + score(cats, "mouthFrownRight")) / 2;
  const jaw = score(cats, "jawOpen"), browUp = score(cats, "browInnerUp");
  const blinkL = score(cats, "eyeBlinkLeft"), blinkR = score(cats, "eyeBlinkRight");
  const e = smile > 0.5 ? "smiling" : jaw > 0.35 && browUp > 0.35 ? "surprised" : frown > 0.3 ? "frowning" : jaw > 0.45 ? "mouth open" : "neutral";
  if (e !== exprCandidate) { exprCandidate = e; exprSince = now(); }
  else if (e !== V.expression && now() - exprSince > 700) { V.expression = e; V.emit("expression", e); }
  V.main.expression = V.expression;
  const closed = blinkL > 0.55 && blinkR > 0.55;
  if (closed && blinkArmed) { blinkArmed = false; V.blinks++; V.emit("blink"); }
  if (!closed && blinkL < 0.35 && blinkR < 0.35) blinkArmed = true;
  if (closed) { if (!eyesClosedSince) eyesClosedSince = now(); else if (now() - eyesClosedSince > 2500) { eyesClosedSince = now() + 600000; V.emit("eyes_closed"); } }
  else eyesClosedSince = 0;
  faceExtras(cats, { blinkL, blinkR, jaw, smile });
}

// Smaller things a face does: winks, blown kisses, raised eyebrows, yawns, puffed cheeks.
// Each must be held for a moment (so a passing twitch doesn't count) and then has a cooldown.
const held = {}, firedAt = {}, jawTrack = [];
function holdFor(key, on, ms, cooldown, fire) {
  if (!on) { held[key] = 0; return; }
  if (!held[key]) held[key] = now();
  else if (now() - held[key] > ms && now() - (firedAt[key] || 0) > cooldown) { firedAt[key] = now(); held[key] = now() + 1e9; fire(); }
}
function faceExtras(cats, { blinkL, blinkR, jaw, smile }) {
  const pucker = score(cats, "mouthPucker"), funnel = score(cats, "mouthFunnel");
  const browsUp = (score(cats, "browOuterUpLeft") + score(cats, "browOuterUpRight")) / 2;
  const puff = score(cats, "cheekPuff");
  const squint = (score(cats, "eyeSquintLeft") + score(cats, "eyeSquintRight")) / 2;
  // which eye is "left" in the model is the person's own left; a wink is one eye shut while the other stays open
  holdFor("winkL", blinkL > 0.6 && blinkR < 0.3, 180, 3000, () => V.emit("wink", { side: "left" }));
  holdFor("winkR", blinkR > 0.6 && blinkL < 0.3, 180, 3000, () => V.emit("wink", { side: "right" }));
  holdFor("kiss", pucker > 0.6 && jaw < 0.25 && smile < 0.3, 450, 6000, () => V.emit("kiss"));
  holdFor("brows", browsUp > 0.6 && jaw < 0.3, 500, 6000, () => V.emit("brows_up"));
  holdFor("yawn", jaw > 0.6 && (blinkL + blinkR > 0.6 || squint > 0.3 || funnel > 0.2), 1300, 20000, () => V.emit("yawn"));
  holdFor("puff", puff > 0.5, 500, 8000, () => V.emit("cheek_puff"));
  // is his mouth moving (talking)? the jaw opening and closing over the last second or so
  jawTrack.push([now(), jaw]); while (jawTrack.length && now() - jawTrack[0][0] > 1200) jawTrack.shift();
  let jmin = 1, jmax = 0, flips = 0, dirJ = 0; for (let k = 1; k < jawTrack.length; k++) { const v = jawTrack[k][1], d = v - jawTrack[k - 1][1]; jmin = Math.min(jmin, v); jmax = Math.max(jmax, v); if (Math.abs(d) > 0.03) { const s = Math.sign(d); if (dirJ && s !== dirJ) flips++; dirJ = s; } }
  V.mouthMoving = jawTrack.length > 4 && jmax - jmin > 0.1 && flips >= 2;
  if (V.mouthMoving) V.mouthMovedAt = now();
  V.faceDetail = { winking: blinkL > 0.6 !== blinkR > 0.6, pucker: pucker > 0.6, browsUp: browsUp > 0.6, jawOpen: jaw > 0.6 };
}

// ---------------- hands ----------------
let gestCandidate = null, gestSince = 0, gestFiredAt = {}, wristHistory = [], waveAt = 0;
// ---- reading the 21 points of each hand ourselves: finger counts, pointing, and signs the stock recognizer doesn't know ----
const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function fingersUp(lm) {                                  // [thumb, index, middle, ring, pinky]
  const w = lm[0], size = d2(w, lm[9]) || 0.1;
  const up = (tip, pip) => d2(lm[tip], w) > d2(lm[pip], w) * 1.12;
  const thumb = d2(lm[4], lm[17]) > d2(lm[3], lm[17]) * 1.06 && d2(lm[4], lm[5]) > size * 0.55;
  return [thumb, up(8, 6), up(12, 10), up(16, 14), up(20, 18)];
}
function signOf(lm, up) {
  const size = d2(lm[0], lm[9]) || 0.1, pinch = d2(lm[4], lm[8]) < size * 0.3;
  const [t, i, m, r, p] = up, n = up.filter(Boolean).length;
  if (pinch && m && r && p) return "ok";
  if (pinch && !m && !r && !p) return "pinch";
  if (i && p && !m && !r) return "rock_on";
  if (t && p && !i && !m && !r) return "call_me";
  if (m && !i && !r && !p) return "middle_finger";
  if (t && i && !m && !r && !p) return "finger_gun";
  if (i && !m && !r && !p && !t) return "one_finger";
  if (i && m && r && !p && !t) return "three";
  if (i && m && r && p && !t) return "four";
  return n === 0 ? "fist" : n === 5 ? "open" : null;
}
// a hand shape as numbers that don't change with where the hand is or how big it looks
function shapeOf(lm) {
  const w = lm[0], size = d2(w, lm[9]) || 0.1, out = [];
  for (const p of lm) out.push((p.x - w.x) / size, (p.y - w.y) / size);
  return out;
}
let customGestures = null;                                 // [{ name, shape, trick }], kept in data/gestures.json
async function loadGestures() { if (customGestures) return customGestures; try { customGestures = JSON.parse(await readFile("gestures.json")); } catch { customGestures = []; } return customGestures; }
function matchCustom(lm) {
  if (!customGestures?.length) return null;
  const s = shapeOf(lm), up = fingersUp(lm).map(Number).join(""); let best = null, bd = 1e9;
  for (const g of customGestures) {
    if (g.up && g.up !== up) continue;                       // different fingers out: not this gesture
    let d = 0; for (let k = 0; k < s.length; k++) d += Math.abs(s[k] - g.shape[k]); d /= s.length; if (d < bd) { bd = d; best = g; }
  }
  return bd < 0.11 ? best : null;
}
let fingerCandidate = -1, fingerSince = 0, pointCandidate = null, pointSince = 0;
function handExtras(r) {
  const hands = r.landmarks || [];
  if (!hands.length) { V.fingers = null; V.sign = null; V.pointing = null; V.hand = null; fingerCandidate = -1; holdFor("sign", false); return; }
  let total = 0; const ups = hands.map(fingersUp); for (const u of ups) total += u.filter(Boolean).length;
  if (total !== fingerCandidate) { fingerCandidate = total; fingerSince = now(); }
  else if (now() - fingerSince > 350 && V.fingers !== total) { V.fingers = total; V.emit("fingers", total); }
  const lm = hands[0], up = ups[0];
  V.hand = { x: mirrorX(lm[9].x), y: lm[9].y * 2 - 1, shape: shapeOf(lm), up: up.map(Number).join("") };
  const custom = matchCustom(lm);
  const sign = custom ? "custom:" + custom.name : signOf(lm, up);
  V.sign = sign;
  if (sign && sign !== "fist" && sign !== "open" && sign !== "one_finger") holdFor("sign:" + sign, true, 450, 5000, () => V.emit("sign", { sign, custom }));
  for (const k of Object.keys(held)) if (k.startsWith("sign:") && k !== "sign:" + sign) held[k] = 0;
  // pointing: only the index finger out. Her eyes follow the fingertip, and she notices which way it points.
  if (sign === "one_finger") {
    const tip = lm[8], base = lm[5], dx = tip.x - base.x, dy = tip.y - base.y, dz = (tip.z || 0) - (base.z || 0);   // picture space = her own left/right
    const len = Math.hypot(dx, dy) || 1e-6, size = d2(lm[0], lm[9]) || 0.1;
    const dir = len < size * 0.45 && dz < -0.02 ? "at you" : Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "to your right" : "to your left") : (dy < 0 ? "up" : "down");
    V.pointing = { dir, x: mirrorX(tip.x), y: tip.y * 2 - 1, vx: dx / len, vy: dy / len };
    Attention.offer("finger", { x: V.pointing.x * 1.15, y: V.pointing.y * 0.95, salience: 0.7, ttl: 500, label: "his fingertip" });   // follow the fingertip
    if (dir !== pointCandidate) { pointCandidate = dir; pointSince = now(); }
    else holdFor("point:" + dir, true, 700, 6000, () => V.emit("point", V.pointing));
  } else { V.pointing = null; pointCandidate = null; for (const k of Object.keys(held)) if (k.startsWith("point:")) held[k] = 0; }
}
function onHands(r) {
  try { handExtras(r); } catch (e) { console.error(e); }
  const g = r.gestures?.[0]?.[0];
  const name = g && g.score > 0.6 && g.categoryName !== "None" ? g.categoryName : null;
  V.gesture = name;
  const wrist = r.landmarks?.[0]?.[0];
  if (wrist && (name === "Open_Palm" || !name)) {
    wristHistory.push([now(), wrist.x]); wristHistory = wristHistory.filter(([t]) => now() - t < 1600);
    let rev = 0, dir = 0, ref = wristHistory[0][1];
    for (const [, x] of wristHistory) { const d = x - ref; if (Math.abs(d) > 0.04) { const s = Math.sign(d); if (dir && s !== dir) rev++; dir = s; ref = x; } }
    if (rev >= 3 && now() - waveAt > 4000) { waveAt = now(); wristHistory = []; V.emit("wave"); return; }
  } else wristHistory = [];
  if (name !== gestCandidate) { gestCandidate = name; gestSince = now(); return; }
  if (name && now() - gestSince > 500 && now() - (gestFiredAt[name] || 0) > 4000) { gestFiredAt[name] = now(); V.emit("gesture", name); }
}

// ---------------- what she does with it ----------------
const MIRROR = { smiling: "happy", surprised: "excited", frowning: "sad", "mouth open": "confused", neutral: "calm" };
const askedRecently = () => { const h = history[history.length - 1]; return h?.role === "assistant" && /\?\s*$/.test(h.content) && Date.now() - lastTalk < 20000; };
const answer = text => { if (!busy) { lastTalk = Date.now(); ask(text); } };

V.on("arrive", ({ count }) => { Tricks.bump("visitors"); window.Hands?.gesture("wave"); Tricks.diary(`saw ${count > 1 ? count + " people" : "someone"} arrive`);
  if (mood === "bored" || mood === "sleepy") setMood("calm"); Face.gesture("wide");
  const generic = () => react("face-arrive", count > 1 ? `${count} faces just appeared in front of your camera` : "a face just appeared in front of your camera (someone came to you)", 3);
  // if she knows people by face, give her a few seconds to work out WHO it is before reacting
  if (window.People?.people?.length) setTimeout(() => { if (!People.here.some(h => h.name && h.sure)) generic(); }, 8000); else generic(); });
V.on("left", () => { Face.gesture("look_down"); if (Date.now() - lastTalk < 60000) react("face-left", "the person you were talking to just walked away from your camera", 3); });
V.on("count", ({ count, before }) => { if (count > before) react("face-count", `you now see ${count} faces in front of you`, 3); });
V.on("very_close", () => { Face.gesture("startle"); react("face-close", "someone put their face REALLY close to your camera", 2); });
V.on("approach", () => Face.gesture("wide"));
V.on("eyes_closed", () => react("eyes-closed", "the person in front of you has had their eyes closed for a few seconds (asleep? praying? ignoring you?)", 5));
V.on("expression", e => {
  if (V.mirror) { setMood(MIRROR[e] || "calm"); return; }
  if (e === "smiling" && Math.random() < 0.25) react("smile", "he's smiling at you", 4);
  if (e === "surprised") react("surprised", "he looks surprised", 3);
  if (e === "frowning" && Math.random() < 0.4) react("frown", "he's frowning", 4);
});
V.on("expression", e => { if (e === "smiling") window.Variety?.feedback(0.5, "he smiled"); });
V.on("sound", s => { if (/laughed/.test(s.what) && s.run === 1) window.Variety?.feedback(1, "he laughed"); });
V.on("nod", () => { Face.gesture("nod"); if (askedRecently()) answer("(he nods yes)"); });
V.on("shake", () => { Face.gesture("shake_head"); if (askedRecently()) answer("(he shakes his head no)"); });
V.on("wave", () => {
  Face.gesture("wide"); Abilities.sfx("chirp");
  if (settings.listen === "push" && !listening && !busy && Date.now() - lastTalk < 120000) { startListening(); return; }   // wave to talk
  react("wave", "he waved at you", 1);
});
V.on("gesture", g => {
  if (rpsWaiting) return;
  const quick = {
    Thumb_Up: () => { window.Variety?.feedback(1, "thumbs up"); setMood("happy"); window.Hands?.gesture("thumbs_up"); if (askedRecently()) answer("(he gives you a thumbs up)"); else if (Math.random() < 0.4) react("thumbup", "he gave you a thumbs up", 2); },
    Thumb_Down: () => { window.Variety?.feedback(-1, "thumbs down"); setMood("sad"); if (askedRecently()) answer("(he gives you a thumbs down)"); else react("thumbdown", "he gave you a thumbs down", 2); },
    Victory: () => { Face.effect("sparkle", 2); window.Hands?.gesture("peace"); if (Math.random() < 0.3) react("peace", "he's flashing a peace sign at you", 3); },
    ILoveYou: () => { Face.effect("heart_eyes", 4); window.Hands?.gesture("blow_kiss"); react("ily", "he's making the 'I love you' hand sign at you", 3); },
    Pointing_Up: () => { Face.gesture("look_up"); window.Hands?.gesture("point_up"); },
    Open_Palm: () => { if (talking) window.shush?.("he held up his hand: stop"); },
    Closed_Fist: () => { if (Math.random() < 0.3) react("fist", "he's holding up a fist at you (fist bump? threat?)", 3); }
  };
  quick[g]?.();
});

// faces doing small things
V.on("wink", ({ side }) => { Face.gesture(side === "left" ? "wink_right" : "wink_left");      // mirror image: wink back with the eye facing his
  react("wink", "he winked at you", 4); });
V.on("kiss", () => { Face.effect("heart_eyes", 2.5); Face.prim?.hold({ blush: 1, mouth: 0.6 }, 2500); react("kiss", "he blew you a kiss (or made a kissy face at you)", 4); });
V.on("brows_up", () => { Face.prim?.hold({ browAsym: 0.8, browY: -0.4 }, 1400); window.Mind?.event("face", "he raised his eyebrows at you", { source: "SAW", salience: 0.25 }); });
V.on("yawn", () => {                                       // yawns are contagious
  window.Mind?.event("face", "he yawned", { source: "SAW", salience: 0.3 });
  setTimeout(() => { if (!talking) { Face.prim?.yawn(2.6); window.Behaviors?.log.push({ t: Date.now(), name: "caught-a-yawn", detail: "" }); } }, 900 + Math.random() * 1200);
  if (window.Mind) Mind.S.arousal = Math.max(0, Mind.S.arousal - 0.1);
  if (Math.random() < 0.3) react("yawn", "he yawned (you caught it and yawned too)", 20);
});
V.on("cheek_puff", () => { Face.prim?.puff(2); Face.prim?.hold({ mouthW: 0.5, open: 0.95 }, 1200); });
// hands doing things the stock recognizer doesn't know
V.on("point", p => {
  window.Mind?.event("pointed", `he pointed ${p.dir}`, { source: "SAW", salience: 0.4 });
  if (p.dir === "at you") { Face.gesture("wide"); react("point-me", "he's pointing right at you", 3); return; }
  // look where he's pointing, not at the finger: eyes lead off in that direction
  const eye = settings.facing === "user" ? -1 : 1;           // her eyes are on a screen facing him: mirrored
  const gx = (p.dir === "to your right" ? 1 : p.dir === "to your left" ? -1 : 0) * eye, gy = p.dir === "up" ? -1 : p.dir === "down" ? 1 : 0;
  if (window.Mind?.glance) Mind.glance(gx, gy, 1600); else Face.lookAt(gx, gy, 1600);
});
V.on("sign", ({ sign, custom }) => {
  if (rpsWaiting || V.gameBusy) return;
  if (custom) {
    window.Mind?.event("gesture", `he made the "${custom.name}" gesture he taught you`, { source: "SAW", salience: 0.5 });
    if (custom.trick && window.Tricks?.runTrick) { Abilities.sfx("coin"); Tricks.runTrick(custom.trick); }
    else react("gesture-" + custom.name, `he made the "${custom.name}" gesture he taught you`, 1);
    return;
  }
  const what = {
    ok: () => { Face.gesture("nod"); if (askedRecently()) answer("(he makes an OK sign: yes, fine)"); },
    rock_on: () => { Face.effect("disco", 3); Abilities.sfx("powerup"); react("rock-on", "he threw up the rock-on horns at you", 4); },
    call_me: () => react("call-me", "he made the 'call me' hand sign at you", 4),
    middle_finger: () => { Face.gesture("startle"); setTimeout(() => setMood("annoyed"), 500); if (window.Mind) Mind.S.irritation = Math.min(1, Mind.S.irritation + 0.25); react("flipped-off", "he just flipped you off (middle finger)", 2); },
    finger_gun: () => { window.Behaviors?.playDead?.(); react("finger-gun", "he shot you with a finger gun (you played dead for a second)", 3); },
    pinch: () => window.Mind?.event("gesture", "he pinched his fingers together (tiny? a little bit?)", { source: "SAW", salience: 0.2 })
  }[sign];
  what?.();
});

// ---------------- games and tools that need real eyes ----------------
let rpsWaiting = false;
async function rockPaperScissors() {
  if (!V.available || !hasTask("hand")) return "FAILED: hand recognition isn't available (run robot-vision-download).";
  await speak("Rock, paper, scissors. Show me your hand on shoot.");
  for (const w of ["Rock.", "Paper.", "Scissors.", "Shoot!"]) { Abilities.sfx(w === "Shoot!" ? "boop" : "beep"); await speak(w); }
  rpsWaiting = true;
  let his = null; const t0 = now();
  while (!his && now() - t0 < 2500) { his = { Closed_Fist: "rock", Open_Palm: "paper", Victory: "scissors" }[V.gesture]; await new Promise(r => setTimeout(r, 80)); }
  rpsWaiting = false;
  const mine = ["rock", "paper", "scissors"][Math.floor(Math.random() * 3)];
  if (!his) return `Rock paper scissors: she threw ${mine}, but couldn't see his hand clearly (hold it up in front of her camera).`;
  const beats = { rock: "scissors", paper: "rock", scissors: "paper" };
  const result = his === mine ? "a tie" : beats[mine] === his ? "she wins" : "he wins";
  Tricks.bump("rps_games");
  return `Rock paper scissors: he threw ${his}, she threw ${mine}. Result: ${result}.`;
}

// ---------------- objects: what's around, where, and for how long ----------------
// Feeds her world model: things she SAW, where in her view, familiarity, and "last seen" when they vanish.
const objSeen = {};                                     // label → { firstAt, lastAt, hits, where, announced }
// Left and right are HERS: the left side of the camera picture is her left, whichever camera is in use.
// (Her eyes are drawn on a screen facing the other way, which is why eye directions are mirrored separately.)
const rawX = x => (settings.facing === "user" ? -1 : 1) * x;        // undo the mirroring used for her eyes
const sideOf = x => rawX(x) < -0.33 ? "on your left" : rawX(x) > 0.33 ? "on your right" : "in front of you";
function onObjects(r) {
  const here = new Set();
  for (const d of r.detections || []) {
    const c = d.categories?.[0]; if (!c) continue;
    const label = c.categoryName; if (label === "person") continue;
    const b = d.box;                                       // 0..1 fractions of the picture
    const x = mirrorX(b.x + b.w / 2), size = b.w;
    here.add(label);
    const o = objSeen[label] ||= { firstAt: now(), lastAt: 0, hits: 0, where: "", announced: false };
    o.hits++; o.lastAt = now(); o.where = `${sideOf(x)}${size > 0.4 ? ", close" : ""}`; o.x = x; o.size = size;
    if (o.hits === 2) {                                     // seen twice in a row: it's really there
      const w0 = window.Mind?.world?.().things?.[label];
      const familiar = (w0?.seen || 0) > 2;
      window.Mind?.event("object_seen", `${label} ${o.where}`, { source: "SAW", conf: c.score, salience: familiar ? 0.25 : 0.5 });
      V.emit("object", { label, x, y: (b.y + b.h / 2) * 2 - 1, size, familiar });
      if (!familiar && !o.announced && window.Mind) {       // something new: curiosity (habituates, so #37 doesn't get question #37)
        o.announced = true; Mind.S.curiosity = Math.min(1, Mind.S.curiosity + 0.15);
        Mind.perceive("object-" + label, `you noticed a ${label} ${o.where} (you don't know this one well yet)`, { base: 0.45, recoverMin: 30 });
      }
    }
    if (o.hits % 10 === 2) window.Mind && Mind.run("note_where", { thing: label, where: `${o.where} of the camera`, how: "saw" }).catch?.(() => {});
  }
  for (const [label, o] of Object.entries(objSeen)) {     // object permanence: gone from view ≠ gone
    if (!here.has(label) && o.hits >= 2 && now() - o.lastAt > 8000 && !o.goneLogged) {
      o.goneLogged = true; window.Mind?.event("object_gone", `${label} left your view (last seen ${o.where}); it's probably still nearby`, { source: "INFERRED", conf: 0.6, salience: 0.4 });
    }
    if (here.has(label)) o.goneLogged = false;
    if (!here.has(label) && now() - o.lastAt > 600000) delete objSeen[label];
  }
}
V.objectsVisible = () => Object.entries(objSeen).filter(([, o]) => now() - o.lastAt < 2500).map(([l]) => l);
function objectsNow() {
  const fresh = Object.entries(objSeen).filter(([, o]) => now() - o.lastAt < 4000);
  if (!fresh.length) return "No objects recognized right now.";
  const held = fresh.filter(([, o]) => o.size > 0.25 && Math.abs(o.x) < 0.5).sort((a, b) => b[1].size - a[1].size)[0];
  return fresh.map(([l, o]) => `${l} ${o.where}`).join(", ") + (held ? `. Biggest and closest (maybe what he's holding): ${held[0]}.` : ".");
}

// ---------------- body pose: crouching, hands up, turned away ----------------
let poseState = { posture: "", since: 0 };
function onPose(r) {
  const lm = r.landmarks?.[0]; if (!lm) { V.posture = null; return; }
  const P = i => lm[i];
  const [nose, ls, rs, lw, rw, lh, rh, lk, rk] = [P(0), P(11), P(12), P(15), P(16), P(23), P(24), P(25), P(26)];
  const shoulderY = (ls.y + rs.y) / 2, hipY = (lh.y + rh.y) / 2, kneeY = (lk.y + rk.y) / 2;
  let posture = "standing";
  if (lw.y < nose.y && rw.y < nose.y) posture = "both hands up";
  else if ((lw.y < nose.y) !== (rw.y < nose.y)) posture = "one hand raised";
  else if (lk.visibility > 0.5 && rk.visibility > 0.5 && kneeY - hipY < (hipY - shoulderY) * 0.45) posture = "crouching down";
  else if (Math.abs(ls.x - rs.x) < 0.05 && ls.visibility > 0.5) posture = "turned sideways";
  if (ls.z > 0.1 && rs.z > 0.1 && nose.visibility < 0.3) posture = "turned away";
  V.posture = posture;
  if (posture !== poseState.posture) { poseState = { posture, since: now(), fired: false }; return; }
  if (!poseState.fired && now() - poseState.since > 900) {
    poseState.fired = true;
    if (posture === "crouching down") { Face.gesture("look_down"); react("pose-crouch", "he crouched down to your level", 3); }
    if (posture === "both hands up") { Face.gesture("wide"); react("pose-handsup", "he's holding both hands up in the air", 3); }
    if (posture === "turned away") window.Mind?.event("pose", "he turned his back to you", { source: "SAW", salience: 0.3 });
  }
}

// ---------------- scene memory: has she been here before? ----------------
let scenes = null;
async function onScene(vec) {
  try {
    if (!scenes) { try { scenes = JSON.parse(await readFile("scenes.json")); } catch { scenes = []; } }
    if (!vec?.length) return;
    const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na * nb) || 1); };
    let best = -1, bi = -1; scenes.forEach((s, i) => { const c = cos(vec, s.v); if (c > best) { best = c; bi = i; } });
    V.sceneVec = vec;
    if (best > 0.82) { scenes[bi].seen++; scenes[bi].t = Date.now(); if (V.place !== bi) { V.place = bi; }
      const was = V.room; V.room = scenes[bi].name || null;
      if (V.room && V.room !== was) window.Mind?.event("place", `you're in the ${V.room}`, { source: "SAW", conf: best, salience: 0.4 }); }
    else {
      scenes.push({ v: vec, seen: 1, t: Date.now(), first: Date.now() }); scenes = scenes.slice(-60);
      if (scenes.length > 1) react("scene-new", "your view changed to a place you don't recognize (you were moved somewhere new, or the room changed a lot)", 5);
      V.place = scenes.length - 1; V.room = null;
    }
    writeFile("scenes.json", JSON.stringify(scenes)).catch(() => {});
  } catch {}
}

// ---------------- hearing: what kind of sound is that? ----------------
const SOUND_EVENTS = [
  [/knock/i, "someone knocked (on a door or table)", 0.75], [/doorbell|ding-dong/i, "a doorbell rang", 0.85],
  [/^dog|bark|bow-wow/i, "a dog barked", 0.6], [/^cat|meow|purr/i, "a cat meowed", 0.6], [/smoke detector|fire alarm|siren|alarm/i, "an alarm or siren is going off", 0.9],
  [/telephone|ringtone/i, "a phone is ringing", 0.6], [/glass|shatter|breaking/i, "something like glass breaking", 0.9],
  [/baby cry|crying|sobbing/i, "someone is crying", 0.8], [/laughter|giggle|chuckle/i, "someone laughed", 0.5], [/sneeze/i, "someone sneezed", 0.8],
  [/cough/i, "someone coughed", 0.35], [/snoring/i, "someone is snoring", 0.5], [/applause|clapping/i, "applause", 0.5],
  [/^door$|sliding door|squeak/i, "a door opened or closed", 0.55], [/slam/i, "a door slammed", 0.7], [/footsteps|^walk/i, "footsteps nearby (someone's walking around)", 0.5],
  [/keys jangling/i, "keys jangling", 0.45], [/television/i, "a TV is on", 0.15], [/typing|computer keyboard/i, "someone is typing", 0.15],
  [/water tap|faucet|sink|toilet flush/i, "water running", 0.2], [/vehicle horn|car alarm/i, "a car horn or alarm outside", 0.45],
  [/whistling/i, "someone is whistling", 0.4], [/finger snapping/i, "someone snapped their fingers", 0.45], [/singing|choir/i, "someone is singing", 0.55], [/^music$|musical instrument|guitar|piano|drum/i, "music is playing", 0.35],
  [/microwave|blender|vacuum|hair dryer/i, "an appliance is running", 0.25], [/thunder/i, "thunder", 0.6], [/explosion|gunshot|bang/i, "a very loud bang", 0.9]
];
async function initAudio() {
  // the worker loads hearing after vision; give it a moment, then fall back to the page if it couldn't
  for (let i = 0; i < 40 && engine?.mode === "worker" && !engine.audio && !engine.audioError; i++) await new Promise(r => setTimeout(r, 500));
  if (!engine?.audio) {
    try { const C = await import("./perception-common.js"); const task = await C.makeAudioTask(false); engine.sound = async (d, r) => C.classify(task, d, r); engine.audio = true; }
    catch { V.hearing = false; return; }
  }
  V.hearing = true;
  let lastSound = "", soundRun = 0, musicSince = 0, soundBusy = false;
  setInterval(async () => {
    if (soundBusy || !engine?.audio || !settings.ears || document.hidden) return;
    const s = Tricks.earsSamples?.(); if (!s) return;
    soundBusy = true;
    let all; try { all = await engine.sound(s.data, s.rate); } catch { return; } finally { soundBusy = false; }
    const cats = (all || []).filter(c => c.score > 0.3);
    V.sounds = cats.map(c => c.categoryName);
    for (const c of cats) {
      const hit = SOUND_EVENTS.find(([re]) => re.test(c.categoryName)); if (!hit) continue;
      const [, what, base] = hit;
      soundRun = what === lastSound ? soundRun + 1 : 1; lastSound = what;
      V.emit("sound", { what, name: c.categoryName, score: c.score, base, run: soundRun });
      if (/TV is on/.test(what)) V.tvOnAt = now();
      if (base < 0.25) { if (soundRun === 1) window.Mind?.event("sound", what, { source: "HEARD", salience: 0.2 }); break; }   // background sounds: noted, not reacted to
      if (/music/.test(what)) { if (!musicSince) musicSince = now(); if (now() - musicSince > 4000 && settings.react) Face.effect("dance", 3); }
      if (/sneezed/.test(what)) Face.gesture("startle");
      if (/laughed/.test(what) && window.Mind) Mind.S.amusement = Math.min(1, Mind.S.amusement + 0.15);
      if (/snoring/.test(what)) window.Mind?.event("sound", "snoring nearby (he's asleep?)", { source: "HEARD", salience: 0.3 });
      else if (soundRun <= 2) react("sound-" + what, what + ` (you heard it: "${c.categoryName}", ${Math.round(c.score * 100)}% sure)`, 2);
      break;
    }
    if (!V.sounds.some(n => /music|instrument|guitar|piano|drum/i.test(n))) musicSince = 0;
  }, 1000);
}

function describe() {
  if (!V.available) return `Vision isn't running: ${V.error || "starting up"}.`;
  if (!settings.track) return "Your camera eyes are off (Settings > Eyes follow movement).";
  if (!V.faces) return `You see no faces right now.${V.gesture ? " A hand is showing: " + V.gesture : ""}`;
  return `You see ${V.faces} face${V.faces > 1 ? "s" : ""}. The closest is ${V.main.distance}, ${rawX(V.main.x) < -0.3 ? "to your left" : rawX(V.main.x) > 0.3 ? "to your right" : "in front of you"}, `
    + `${V.expression}, ${V.lookingAtMe ? "looking right at you" : "looking away"}. `
    + `${V.gesture ? "Hand sign: " + V.gesture + ". " : ""}${V.fingers != null ? V.handsNow() + " " : ""}${V.posture ? "Body: " + V.posture + ". " : ""}Blinks counted so far: ${V.blinks}.`;
}

V.run = async (name, input) => {
  if (name === "see_people") return describe() + (hasTask("obj") ? " Objects: " + objectsNow() : "") + (V.sounds?.length ? ` Hearing: ${V.sounds.join(", ")}.` : "");
  if (name === "see_objects") return hasTask("obj") ? objectsNow() : "FAILED: object recognition isn't downloaded (robot-vision-download).";
  if (name === "mirror_mode") { V.mirror = !!input.on; if (!V.mirror) setMood("calm"); return V.mirror ? "Mirroring his expressions." : "Stopped mirroring."; }
  if (name === "rock_paper_scissors") return await rockPaperScissors();
  if (name === "count_fingers") return V.handsNow();
  if (name === "name_room") return await V.nameRoom(input.name);
  if (name === "which_room") return V.whichRoom();
  if (name === "learn_thing") return await V.learnThing(input.name);
  if (name === "learn_gesture") return await V.learnGesture(input.name, input.trick);
  if (name === "forget_gesture") return await V.forgetGesture(input.name);
};
V.rockPaperScissors = rockPaperScissors;
// Rooms: he tells her what this place is called; she knows it when she sees it again.
V.nameRoom = async name => {
  name = String(name || "").toLowerCase().replace(/^(the|my|our)\s+/, "").replace(/[.!?]+$/, "").trim().slice(0, 30); if (!name) return "FAILED: what's this room called?";
  if (!engine || !hasTask("embed")) return "FAILED: scene memory isn't available (run robot-vision-download).";
  const v = video(); if (!v) return "FAILED: your camera eyes are off.";
  try { const { res } = await engine.frame(v, now(), { embed: true }); if (res.embed) await onScene(res.embed); } catch {}
  if (V.place == null || !scenes?.[V.place]) return "FAILED: you couldn't get a good look at the room. Try again in a moment.";
  scenes[V.place].name = name; V.room = name; await writeFile("scenes.json", JSON.stringify(scenes)).catch(() => {});
  return `Got it: this is the ${name}. You'll know it when you see it again, and you'll remember which room things were in. (Rooms look different from different spots, so he may need to tell you again from another angle.)`;
};
V.whichRoom = () => V.room ? `You're in the ${V.room}.` : (scenes || []).some(s => s.name) ? `You don't recognize this view as a room you know (you know: ${[...new Set(scenes.filter(s => s.name).map(s => s.name))].join(", ")}).` : "You don't know any rooms by name yet. He can tell you 'this is the kitchen'.";
// Things he shows her and names ("this is Frank"): she remembers what they look like.
let shown = null, shownHit = { name: null, n: 0 }, shownAt = 0;
const loadShown = async () => { if (!shown) { try { shown = JSON.parse(await readFile("shown-things.json")); } catch { shown = []; } } return shown; };
const cosv = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na * nb) || 1); };
async function lookAtMiddle() {                            // what the middle of her view looks like, as numbers
  const v = video(); if (!v || !engine?.embedImage) return null;
  const s = Math.min(v.videoWidth, v.videoHeight) * 0.6;
  try { return await engine.embedImage(v, (v.videoWidth - s) / 2, (v.videoHeight - s) / 2, s, s); } catch { return null; }
}
V.learnThing = async name => {
  name = String(name || "").replace(/[.!?]+$/, "").trim().slice(0, 40); if (!name) return "FAILED: what's it called?";
  if (!hasTask("embed")) return "FAILED: this needs the scene-memory model (robot-vision-download).";
  await loadShown(); const vecs = [];
  for (let i = 0; i < 4; i++) { const e = await lookAtMiddle(); if (e?.length) vecs.push(e); await new Promise(r => setTimeout(r, 450)); }   // a few looks as he holds it
  if (!vecs.length) return "FAILED: you couldn't get a look at it. He should hold it in the middle of your view.";
  const old = shown.find(t => t.name.toLowerCase() === name.toLowerCase());
  if (old) old.vecs = [...old.vecs, ...vecs].slice(-10); else shown.push({ name, vecs, t: Date.now() });
  shown = shown.slice(-30); await writeFile("shown-things.json", JSON.stringify(shown)).catch(() => {});
  window.Mind?.run?.("note_where", { thing: name, where: "he was holding it up in front of you", how: "saw" })?.catch?.(() => {});
  return `You'll know "${name}" when you see it again (${vecs.length} looks saved). It works best when it's held up in the middle of your view like now.`;
};
V.whatIsThis = async () => {
  await loadShown(); if (!shown.length) return null;
  const e = await lookAtMiddle(); if (!e?.length) return null;
  const scored = shown.map(t => ({ name: t.name, s: Math.max(...t.vecs.map(v => cosv(e, v))) })).sort((a, b) => b.s - a.s);
  return scored[0].s > 0.7 && (scored.length < 2 || scored[0].s - scored[1].s > 0.04) ? { name: scored[0].name, score: scored[0].s } : null;
};
setInterval(async () => {                                   // now and then, check whether the thing in front of her is one she was shown
  if (!V.available || !settings.vision || document.hidden || !shown?.length || (window.Power?.slow || 1) > 1) return;
  if (!(V.hand || V.objectsVisible().length)) { shownHit = { name: null, n: 0 }; return; }      // only when something's being held up or is in view
  const hit = await V.whatIsThis();
  if (!hit) { shownHit = { name: null, n: 0 }; return; }
  shownHit = hit.name === shownHit.name ? { name: hit.name, n: shownHit.n + 1 } : { name: hit.name, n: 1 };
  if (shownHit.n === 2 && now() - shownAt > 120000) { shownAt = now(); V.known = hit.name; V.emit("known_thing", hit);
    window.Mind?.event("object_seen", `you recognize ${hit.name} (he showed it to you before)`, { source: "SAW", conf: hit.score, salience: 0.45 });
    react("thing-" + hit.name, `you recognize the thing in front of you: it's ${hit.name}, which he showed you before`, 20); }
}, 4000);
setTimeout(() => loadShown().catch(() => {}), 5000);
V.learnGesture = async (name, trick) => {
  if (!V.hand) return "FAILED: you don't see a hand right now. He needs to hold the gesture up in front of your camera.";
  await loadGestures();
  // average the shape over a second so one shaky frame doesn't become the gesture
  const shapes = [], ups = {}; const t0 = now();
  while (now() - t0 < 1200) { if (V.hand) { shapes.push(V.hand.shape); ups[V.hand.up] = (ups[V.hand.up] || 0) + 1; } await new Promise(r => setTimeout(r, 120)); }
  if (shapes.length < 4) return "FAILED: the hand moved out of view. Ask him to hold it still for a second.";
  const shape = shapes[0].map((_, k) => shapes.reduce((a, s) => a + s[k], 0) / shapes.length);
  name = String(name || "").toLowerCase().trim().slice(0, 30); if (!name) return "FAILED: give the gesture a name.";
  customGestures = customGestures.filter(g => g.name !== name); customGestures.push({ name, shape, up: Object.entries(ups).sort((a, b) => b[1] - a[1])[0][0], trick: trick || null });
  customGestures = customGestures.slice(-20);
  await writeFile("gestures.json", JSON.stringify(customGestures));
  return `Learned the "${name}" gesture${trick ? `; it now starts the trick "${trick}"` : ""}. You know ${customGestures.length} of his gestures.`;
};
V.forgetGesture = async name => { await loadGestures(); const n = customGestures.length; customGestures = customGestures.filter(g => g.name !== String(name).toLowerCase().trim());
  await writeFile("gestures.json", JSON.stringify(customGestures)); return n !== customGestures.length ? "Forgotten." : "You don't know a gesture by that name."; };
V.handsNow = () => !V.available ? "Vision isn't running." : V.fingers == null ? "You don't see a hand right now."
  : `He's holding up ${V.fingers} finger${V.fingers === 1 ? "" : "s"}${V.sign ? ` (sign: ${V.sign.replace(/_/g, " ")})` : ""}${V.pointing ? `, pointing ${V.pointing.dir}` : ""}.`;
setTimeout(() => loadGestures().catch(() => {}), 2500);
V.describe = describe;

init();
