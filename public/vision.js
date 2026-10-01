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

let faceTask = null, handTask = null, tick = 0, lastVideoTime = -1;
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
    if (faceTask) onFaces(faceTask.detectForVideo(v, ts));
    if (handTask && tick++ % 2 === 0) onHands(handTask.detectForVideo(v, ts + 1));
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
  Face.lookAt(mirrorX(cx) * 1.15, (cy * 2 - 1) * 0.9, 400);

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

function describe() {
  if (!V.available) return `Vision isn't running: ${V.error || "starting up"}.`;
  if (!settings.track) return "Your camera eyes are off (Settings > Eyes follow movement).";
  if (!V.faces) return `You see no faces right now.${V.gesture ? " A hand is showing: " + V.gesture : ""}`;
  return `You see ${V.faces} face${V.faces > 1 ? "s" : ""}. The closest is ${V.main.distance}, ${V.main.x < -0.3 ? "to your left" : V.main.x > 0.3 ? "to your right" : "in front of you"}, `
    + `${V.expression}, ${V.lookingAtMe ? "looking right at you" : "looking away"}. `
    + `${V.gesture ? "Hand sign: " + V.gesture + ". " : ""}Blinks counted so far: ${V.blinks}.`;
}

V.run = async (name, input) => {
  if (name === "see_people") return describe();
  if (name === "mirror_mode") { V.mirror = !!input.on; if (!V.mirror) setMood("calm"); return V.mirror ? "Mirroring his expressions." : "Stopped mirroring."; }
  if (name === "rock_paper_scissors") return await rockPaperScissors();
};
V.rockPaperScissors = rockPaperScissors;
V.describe = describe;

init();
