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

let faceTask = null, handTask = null, objTask = null, poseTask = null, embedTask = null, audioTask = null, tick = 0, lastVideoTime = -1;
let slowMs = 0;                                   // how long a frame of perception takes; extras back off when the phone is busy
async function init() {
  let mp;
  try { mp = await import(BASE + "vision_bundle.mjs"); }
  catch { V.error = "not downloaded (run robot-vision-download)"; return; }
  try {
    const files = await mp.FilesetResolver.forVisionTasks(BASE + "wasm");
    const make = async (Cls, model, opts) => {
      for (const delegate of ["GPU", "CPU"]) {
        try { return await Cls.createFromOptions(files, { baseOptions: { modelAssetPath: BASE + model, delegate }, runningMode: "VIDEO", ...opts }); }
        catch (e) { if (delegate === "CPU") throw e; }
      }
    };
    faceTask = await make(mp.FaceLandmarker, "face_landmarker.task", { numFaces: 4, outputFaceBlendshapes: true });
    handTask = await make(mp.GestureRecognizer, "gesture_recognizer.task", { numHands: 2 }).catch(() => null);
    objTask = await make(mp.ObjectDetector, "efficientdet_lite0.tflite", { scoreThreshold: 0.45, maxResults: 8 }).catch(() => null);
    poseTask = await make(mp.PoseLandmarker, "pose_landmarker_lite.task", { numPoses: 1 }).catch(() => null);
    try { embedTask = await mp.ImageEmbedder.createFromOptions(files, { baseOptions: { modelAssetPath: BASE + "mobilenet_v3_small.tflite" }, runningMode: "IMAGE", quantize: true }); } catch {}
    initAudio();
    V.available = true;
    logEvent("vision", { detail: "vision engine ready" + (handTask ? "" : " (no hand gestures)") });
    setInterval(loop, 110);
  } catch (e) { V.error = e.message; logEvent("error", { where: "vision", detail: e.message }); }
}

function video() { const v = window.trackVid; return v && v.readyState >= 2 ? v : null; }

function loop() {
  if (!settings.vision || document.hidden) return;
  const v = video(); if (!v || v.currentTime === lastVideoTime) return;
  lastVideoTime = v.currentTime;
  const ts = now();
  try {
    const t0 = now(); tick++;
    if (faceTask) onFaces(faceTask.detectForVideo(v, ts));
    if (handTask && tick % 2 === 0) onHands(handTask.detectForVideo(v, ts + 1));
    const busyPhone = slowMs > 70;                          // the phone is struggling: run the extras less often
    if (poseTask && tick % (busyPhone ? 9 : 3) === 1) onPose(poseTask.detectForVideo(v, ts + 2));
    if (objTask && tick % (busyPhone ? 30 : 12) === 5) onObjects(objTask.detectForVideo(v, ts + 3));
    if (embedTask && tick % 120 === 60) onScene(v);
    slowMs = slowMs * 0.9 + (now() - t0) * 0.1;
  } catch (e) { /* a dropped frame is fine */ }
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
    V.main = null; V.lookingAtMe = false; faceSince = 0;
    if (lastCount && now() - lastSeen > 8000) { lastCount = 0; V.emit("left"); }   // gone for 8s = left
    return;
  }
  // closest face = biggest
  const boxes = faces.map(lm => {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0; for (const p of lm) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, lm };
  });
  const i = boxes.reduce((b, f, k) => f.w > boxes[b].w ? k : b, 0), m = boxes[i];
  const cx = (m.x0 + m.x1) / 2, cy = (m.y0 + m.y1) / 2;
  window.visionLookUntil = now() + 400;                    // face beats plain motion for where her eyes go
  if (!window.Mind?.distracted()) Face.lookAt(mirrorX(cx) * 1.15, (cy * 2 - 1) * 0.9, 400);   // unless something stole her attention

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
}

// ---------------- hands ----------------
let gestCandidate = null, gestSince = 0, gestFiredAt = {}, wristHistory = [], waveAt = 0;
function onHands(r) {
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

V.on("arrive", ({ count }) => { Tricks.bump("visitors"); Tricks.diary(`saw ${count > 1 ? count + " people" : "someone"} arrive`);
  if (mood === "bored" || mood === "sleepy") setMood("calm"); Face.gesture("wide");
  react("face-arrive", count > 1 ? `${count} faces just appeared in front of your camera` : "a face just appeared in front of your camera (someone came to you)", 3); });
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
    Thumb_Up: () => { setMood("happy"); if (askedRecently()) answer("(he gives you a thumbs up)"); else if (Math.random() < 0.4) react("thumbup", "he gave you a thumbs up", 2); },
    Thumb_Down: () => { setMood("sad"); if (askedRecently()) answer("(he gives you a thumbs down)"); else react("thumbdown", "he gave you a thumbs down", 2); },
    Victory: () => { Face.effect("sparkle", 2); if (Math.random() < 0.3) react("peace", "he's flashing a peace sign at you", 3); },
    ILoveYou: () => { Face.effect("heart_eyes", 4); react("ily", "he's making the 'I love you' hand sign at you", 3); },
    Pointing_Up: () => Face.gesture("look_up"),
    Closed_Fist: () => { if (Math.random() < 0.3) react("fist", "he's holding up a fist at you (fist bump? threat?)", 3); }
  };
  quick[g]?.();
});

// ---------------- games and tools that need real eyes ----------------
let rpsWaiting = false;
async function rockPaperScissors() {
  if (!V.available || !handTask) return "FAILED: hand recognition isn't available (run robot-vision-download).";
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
const sideOf = x => x < -0.33 ? "on your left" : x > 0.33 ? "on your right" : "in front of you";
function onObjects(r) {
  const here = new Set();
  for (const d of r.detections || []) {
    const c = d.categories?.[0]; if (!c) continue;
    const label = c.categoryName; if (label === "person") continue;
    const b = d.boundingBox, w = video()?.videoWidth || 640;
    const x = mirrorX((b.originX + b.width / 2) / w), size = b.width / w;
    here.add(label);
    const o = objSeen[label] ||= { firstAt: now(), lastAt: 0, hits: 0, where: "", announced: false };
    o.hits++; o.lastAt = now(); o.where = `${sideOf(x)}${size > 0.4 ? ", close" : ""}`; o.x = x; o.size = size;
    if (o.hits === 2) {                                     // seen twice in a row: it's really there
      const w0 = window.Mind?.world?.().things?.[label];
      const familiar = (w0?.seen || 0) > 2;
      window.Mind?.event("object_seen", `${label} ${o.where}`, { source: "SAW", conf: c.score, salience: familiar ? 0.25 : 0.5 });
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
async function onScene(v) {
  try {
    if (!scenes) { try { scenes = JSON.parse(await readFile("scenes.json")); } catch { scenes = []; } }
    const e = embedTask.embed(v).embeddings?.[0]; if (!e) return;
    const vec = Array.from(e.floatEmbedding || e.quantizedEmbedding || []);
    if (!vec.length) return;
    const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na * nb) || 1); };
    let best = -1, bi = -1; scenes.forEach((s, i) => { const c = cos(vec, s.v); if (c > best) { best = c; bi = i; } });
    if (best > 0.82) { scenes[bi].seen++; scenes[bi].t = Date.now(); if (V.place !== bi) { V.place = bi; } }
    else {
      scenes.push({ v: vec, seen: 1, t: Date.now(), first: Date.now() }); scenes = scenes.slice(-60);
      if (scenes.length > 1) react("scene-new", "your view changed to a place you don't recognize (you were moved somewhere new, or the room changed a lot)", 5);
      V.place = scenes.length - 1;
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
  [/whistling/i, "someone is whistling", 0.4], [/singing|choir/i, "someone is singing", 0.55], [/^music$|musical instrument|guitar|piano|drum/i, "music is playing", 0.35],
  [/microwave|blender|vacuum|hair dryer/i, "an appliance is running", 0.25], [/thunder/i, "thunder", 0.6], [/explosion|gunshot|bang/i, "a very loud bang", 0.9]
];
async function initAudio() {
  try {
    const am = await import("./vendor/mediapipe-audio/audio_bundle.mjs");
    const files = await am.FilesetResolver.forAudioTasks("./vendor/mediapipe-audio/wasm");
    audioTask = await am.AudioClassifier.createFromOptions(files, { baseOptions: { modelAssetPath: "./vendor/mediapipe-audio/yamnet.tflite" }, maxResults: 4, scoreThreshold: 0.25 });
    V.hearing = true;
    let lastSound = "", soundRun = 0, musicSince = 0;
    setInterval(() => {
      if (!settings.ears || document.hidden) return;
      const s = Tricks.earsSamples?.(); if (!s) return;
      let res; try { res = audioTask.classify(s.data, s.rate); } catch { return; }
      const cats = (res?.[0]?.classifications?.[0]?.categories || []).filter(c => c.score > 0.3);
      V.sounds = cats.map(c => c.categoryName);
      for (const c of cats) {
        const hit = SOUND_EVENTS.find(([re]) => re.test(c.categoryName)); if (!hit) continue;
        const [, what, base] = hit;
        soundRun = what === lastSound ? soundRun + 1 : 1; lastSound = what;
        if (/music/.test(what)) { if (!musicSince) musicSince = now(); if (now() - musicSince > 4000 && settings.react) Face.effect("dance", 3); }
        if (/sneezed/.test(what)) Face.gesture("startle");
        if (/laughed/.test(what) && window.Mind) Mind.S.amusement = Math.min(1, Mind.S.amusement + 0.15);
        if (/snoring/.test(what)) window.Mind?.event("sound", "snoring nearby (he's asleep?)", { source: "HEARD", salience: 0.3 });
        else if (soundRun <= 2) react("sound-" + what, what + ` (you heard it: "${c.categoryName}", ${Math.round(c.score * 100)}% sure)`, 2);
        break;
      }
      if (!V.sounds.some(n => /music|instrument|guitar|piano|drum/i.test(n))) musicSince = 0;
    }, 1000);
  } catch { V.hearing = false; }
}

function describe() {
  if (!V.available) return `Vision isn't running: ${V.error || "starting up"}.`;
  if (!settings.track) return "Your camera eyes are off (Settings > Eyes follow movement).";
  if (!V.faces) return `You see no faces right now.${V.gesture ? " A hand is showing: " + V.gesture : ""}`;
  return `You see ${V.faces} face${V.faces > 1 ? "s" : ""}. The closest is ${V.main.distance}, ${V.main.x < -0.3 ? "to your left" : V.main.x > 0.3 ? "to your right" : "in front of you"}, `
    + `${V.expression}, ${V.lookingAtMe ? "looking right at you" : "looking away"}. `
    + `${V.gesture ? "Hand sign: " + V.gesture + ". " : ""}${V.posture ? "Body: " + V.posture + ". " : ""}Blinks counted so far: ${V.blinks}.`;
}

V.run = async (name, input) => {
  if (name === "see_people") return describe() + (objTask ? " Objects: " + objectsNow() : "") + (V.sounds?.length ? ` Hearing: ${V.sounds.join(", ")}.` : "");
  if (name === "see_objects") return objTask ? objectsNow() : "FAILED: object recognition isn't downloaded (robot-vision-download).";
  if (name === "mirror_mode") { V.mirror = !!input.on; if (!V.mirror) setMood("calm"); return V.mirror ? "Mirroring his expressions." : "Stopped mirroring."; }
  if (name === "rock_paper_scissors") return await rockPaperScissors();
};
V.rockPaperScissors = rockPaperScissors;
V.describe = describe;

init();
