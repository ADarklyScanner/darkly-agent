// Knowing people. She recognizes faces you've introduced to her ("this is Johnny"), on the phone, with no internet:
// greets by name, knows when she last saw someone, and can tell a familiar face from a stranger.
// Uses face-api.js (MIT, in lib/faceapi): a small face detector plus a 128-number "face print".
// Face prints are stored only on this phone (data/people.json) and only for people you introduce.
// Strangers are only counted while she's running (never saved).
(() => {
  "use strict";
  const P = window.People = { ready: false, error: "", here: [], people: [], strangers: [], enabled: true };
  const FILE = "people.json", MATCH = 0.5, MAYBE = 0.58;       // face-print distance: under 0.5 = same person; 0.5-0.58 = "might be"
  const now = () => Date.now();
  let loading = null, canvas = null;

  async function loadLib() {
    if (P.ready) return true;
    loading ||= (async () => {
      try {
        if (!window.faceapi) await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "lib/faceapi/face-api.min.js"; s.onload = res; s.onerror = () => rej(new Error("couldn't load the face recognizer")); document.head.append(s); });
        const W = "lib/faceapi/weights";
        await Promise.all([faceapi.nets.tinyFaceDetector.loadFromUri(W), faceapi.nets.faceLandmark68TinyNet.loadFromUri(W), faceapi.nets.faceRecognitionNet.loadFromUri(W)]);
        P.ready = true;
      } catch (e) { P.error = e.message; }
      return P.ready;
    })();
    return loading;
  }
  async function loadPeople() {
    if (P._loaded) return; P._loaded = true;
    try { const j = JSON.parse(await readFile(FILE)); if (Array.isArray(j)) P.people = j; } catch {}
  }
  const save = () => writeFile(FILE, JSON.stringify(P.people)).catch(() => {});
  const dist = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); };
  const ago = t => { const m = Math.round((now() - t) / 60000); return m < 2 ? "moments ago" : m < 90 ? m + " minutes ago" : m < 2880 ? Math.round(m / 60) + " hours ago" : Math.round(m / 1440) + " days ago"; };

  // Every face in a picture/video frame: [{ x, y, size, print, name, sure, d }]  (x,y in -1..1 of the picture).
  // If `boxes` is given (where her vision engine already found faces, as 0..1 fractions), each face is looked at
  // in its own close-up, which is quicker and more reliable than searching the whole picture again.
  const tiny = size => new faceapi.TinyFaceDetectorOptions({ inputSize: size, scoreThreshold: 0.35 });
  function match(print) {
    let best = null, bd = 9;
    for (const p of P.people) for (const pr of p.prints) { const d = dist(print, pr); if (d < bd) { bd = d; best = p; } }
    return { d: +bd.toFixed(3), name: best && bd < MAYBE ? best.name : null, sure: bd < MATCH };
  }
  P.scan = async (src, boxes) => {
    if (!(await loadLib())) return [];
    const sw = src.videoWidth || src.naturalWidth || src.width, sh = src.videoHeight || src.naturalHeight || src.height; if (!sw) return [];
    await loadPeople();
    canvas ||= document.createElement("canvas");
    const out = [];
    if (boxes?.length) {
      for (const b of boxes.slice(0, 3)) {
        const bw = (b.x1 - b.x0) * sw, bh = (b.y1 - b.y0) * sh, side = Math.max(bw, bh) * 2.1;       // the face plus room around it
        const cx = (b.x0 + b.x1) / 2 * sw, cy = (b.y0 + b.y1) / 2 * sh;
        canvas.width = canvas.height = 256; const g = canvas.getContext("2d"); g.fillStyle = "#777"; g.fillRect(0, 0, 256, 256);
        g.drawImage(src, cx - side / 2, cy - side / 2, side, side, 0, 0, 256, 256);
        const f = await faceapi.detectSingleFace(canvas, tiny(224)).withFaceLandmarks(true).withFaceDescriptor();
        if (f) out.push({ x: (b.x0 + b.x1) - 1, y: (b.y0 + b.y1) - 1, size: b.x1 - b.x0, print: Array.from(f.descriptor), ...match(Array.from(f.descriptor)) });
      }
      return out.sort((a, b) => b.size - a.size);
    }
    const w = Math.min(sw, 640), h = Math.round(sh * w / sw);
    canvas.width = w; canvas.height = h; canvas.getContext("2d").drawImage(src, 0, 0, w, h);
    const found = await faceapi.detectAllFaces(canvas, tiny(416)).withFaceLandmarks(true).withFaceDescriptors();
    return found.map(f => { const b = f.detection.box, print = Array.from(f.descriptor);
      return { x: (b.x + b.width / 2) / w * 2 - 1, y: (b.y + b.height / 2) / h * 2 - 1, size: b.width / w, print, ...match(print) }; }).sort((a, b) => b.size - a.size);
  };

  // ---------------- looking at who's there, every few seconds ----------------
  let lastScan = 0, busy = false, streak = {}, lastGreeted = {};
  P.tick = async video => {
    if (!P.enabled || busy || !video || video.readyState < 2) return;
    if (typeof settings !== "undefined" && settings.faces === false) return;
    await loadPeople(); if (!P.people.length) return;               // nobody introduced yet: nothing to recognize, so don't spend the effort
    const V = window.Vision; if (V?.available && !V.faces) { if (P.here.length && now() - lastScan > 6000) P.here = []; return; }   // nobody there: don't bother
    const known = P.here.length && P.here.every(h => h.name && h.sure && (streak[h.name] || 0) >= 2);   // confirmed on two looks
    if (now() - lastScan < (known ? 12000 : 3000) * (window.Power?.slow || 1)) return;       // once she knows who it is, check less often
    lastScan = now(); busy = true;
    try {
      const faces = await P.scan(video, window.Vision?.faceBoxes);
      const names = new Set();
      for (const f of faces) {
        if (f.name && f.sure) {
          names.add(f.name); streak[f.name] = (streak[f.name] || 0) + 1;
          if (streak[f.name] === 2) onRecognized(f);                // twice in a row: it's really them
        } else if (!f.name) noteStranger(f);
      }
      for (const n of Object.keys(streak)) if (!names.has(n)) streak[n] = 0;
      P.here = faces.map(f => ({ name: f.name, sure: f.sure, x: f.x, y: f.y, size: f.size, stranger: f.stranger }));
    } catch (e) { P.error = e.message; }
    busy = false;
  };
  function onRecognized(f) {
    const p = P.people.find(x => x.name === f.name); if (!p) return;
    const away = p.lastSeen ? now() - p.lastSeen : Infinity;
    if (away > 5 * 60000) { p.seen = (p.seen || 0) + 1; }
    const first = !lastGreeted[p.name] || away > 20 * 60000;
    const since = p.lastSeen ? ago(p.lastSeen) : "never before";
    p.lastSeen = now(); save();
    window.Mind?.event("person", `you recognize ${p.name} (you last saw them ${since})`, { source: "SAW", conf: 0.9, salience: first ? 0.6 : 0.2 });
    if (first) {
      lastGreeted[p.name] = now();
      window.Face?.prim?.pupils(1.3, 1200);
      const fam = p.seen > 20 ? "someone you see all the time" : p.seen > 5 ? "a familiar face" : "someone you've only met a few times";
      if (typeof react === "function") react("person-" + p.name, `${p.name} just came into view: ${fam}. You last saw them ${since}.${p.notes ? " What you know about them: " + p.notes : ""} Greet them by name if it's been a while; don't make a fuss if it hasn't.`, 30);
    }
  }
  function noteStranger(f) {                                         // only while she's running; nothing is saved
    let s = P.strangers.find(x => dist(x.print, f.print) < MATCH);
    if (!s) { s = { print: f.print, count: 0, first: now(), last: 0 }; P.strangers.push(s); P.strangers = P.strangers.slice(-12); }
    if (now() - s.last > 5 * 60000) s.count++;
    s.last = now(); f.stranger = s.count;
  }

  // ---------------- tools ----------------
  const video = async () => { try { await camOn(); } catch { return null; } const v = window.trackVid && trackVid.readyState >= 2 ? trackVid : $("#cam"); for (let i = 0; i < 20 && !v.videoWidth; i++) await sleep(100); return v.videoWidth ? v : null; };
  P.remember = async (name, notes) => {
    name = String(name || "").trim().replace(/[.!?]+$/, "").slice(0, 30); if (!name) return "FAILED: who is it? Give a name.";
    if (!(await loadLib())) return "FAILED: the face recognizer didn't load (" + P.error + ").";
    const v = await video(); if (!v) return "FAILED: no camera picture.";
    await loadPeople();
    const prints = []; let tries = 0;
    while (prints.length < 5 && tries++ < 12) {                      // several looks, so one odd frame doesn't define them
      const f = (await P.scan(v, window.Vision?.faceBoxes))[0];
      if (f && f.size > 0.08 && !prints.some(p => dist(p, f.print) < 0.12)) prints.push(f.print);
      else if (f && f.size > 0.08 && prints.length && tries > 8) prints.push(f.print);
      await sleep(350);
    }
    if (!prints.length) return "FAILED: you don't see a face clearly. They should face you, in decent light, fairly close.";
    const other = P.people.find(p => p.name.toLowerCase() !== name.toLowerCase() && p.prints.some(a => prints.some(b => dist(a, b) < 0.42)));
    let p = P.people.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (p) { p.prints = [...p.prints, ...prints].slice(-12); if (notes) p.notes = String(notes).slice(0, 300); }
    else { p = { name, prints, notes: notes ? String(notes).slice(0, 300) : "", firstSeen: now(), lastSeen: now(), seen: 1 }; P.people.push(p); }
    P.people = P.people.slice(-40); save(); lastGreeted[name] = now();
    return `You'll recognize ${name} from now on (${prints.length} looks at their face saved, on this phone only).${other ? ` Careful: this face also looks a lot like ${other.name}, who you already know.` : ""}`;
  };
  P.who = async () => {
    if (!(await loadLib())) return "FAILED: the face recognizer didn't load (" + P.error + ").";
    const v = await video(); if (!v) return "FAILED: no camera picture.";
    const faces = await P.scan(v, window.Vision?.faceBoxes); await loadPeople();
    if (!faces.length) return "You don't see a face right now.";
    for (const f of faces) if (!f.name) noteStranger(f);
    const side = f => f.x < -0.33 ? "on your left" : f.x > 0.33 ? "on your right" : "in front of you";
    return faces.map(f => {
      if (f.name && f.sure) { const p = P.people.find(x => x.name === f.name); return `${f.name} is ${side(f)} (you've seen them on ${p.seen || 1} occasions${p.notes ? "; " + p.notes : ""})`; }
      if (f.name) return `someone ${side(f)} who might be ${f.name}, but you're not sure`;
      return `someone you don't know ${side(f)}${f.stranger > 1 ? ` (you've noticed this stranger ${f.stranger} times today)` : ""}`;
    }).join(". ") + "." + (P.people.length ? "" : " You haven't been introduced to anyone yet (he can say 'this is ...' or 'remember my face as ...').");
  };
  P.forget = async name => { await loadPeople(); const n = P.people.length; P.people = P.people.filter(p => p.name.toLowerCase() !== String(name || "").toLowerCase().trim()); save();
    return n !== P.people.length ? `Forgotten: you no longer know ${name}'s face.` : `You don't know anyone called ${name}.`; };
  P.list = async () => { await loadPeople(); return P.people.length ? "People you know by face: " + P.people.map(p => `${p.name} (seen ${p.seen || 1} times, last ${ago(p.lastSeen)}${p.notes ? "; " + p.notes : ""})`).join("; ") + "." : "You don't know anyone's face yet."; };
  P.note = async (name, note) => { await loadPeople(); const p = P.people.find(x => x.name.toLowerCase() === String(name || "").toLowerCase().trim()); if (!p) return `You don't know anyone called ${name}.`;
    p.notes = ((p.notes ? p.notes + " " : "") + String(note || "")).slice(-300); save(); return `Noted about ${p.name}.`; };
  // one line for the brain: who she's with right now
  P.context = () => {
    const names = P.here.filter(h => h.name && h.sure).map(h => h.name), unknown = P.here.filter(h => !h.name).length;
    return names.length || unknown ? `With you: ${[...names, unknown ? `${unknown} ${unknown > 1 ? "people" : "person"} you don't know` : ""].filter(Boolean).join(", ")}` : "";
  };
  setTimeout(() => { loadPeople().then(() => { if (P.people.length) loadLib(); }); }, 6000);   // only loads the recognizer if there's someone to recognize
})();
