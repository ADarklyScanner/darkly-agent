// More things she can do, built on her on-phone senses:
//  - tools for the online brains (count fingers, learn a gesture, name a marker tag, read text, read notifications,
//    which note is that, hum it back, remember this place...)
//  - games that need real eyes or ears (scavenger hunt, what's missing, pose Simon Says, finger math, follow my finger,
//    balance, guess the sound, match my note)
//  - "offline skills": the small offline brain can't call tools, so plain requests ("how many fingers", "play
//    scavenger hunt", "where's my charger") are recognized here, done for real, and the result handed to it to say.
//  - NFC tags as triggers, and opt-in automatic photos.
(() => {
  "use strict";
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const now = () => performance.now();
  const V = () => window.Vision;
  const E = window.Extras = {};

  // =============================== tools ===============================
  const obj = (properties = {}, required = []) => ({ type: "object", properties, required });
  E.tools = [
    { name: "count_fingers", description: "Instantly check his hand in front of your camera (offline): how many fingers he's holding up, any hand sign (ok, rock on, finger gun...), and which way he's pointing.", input_schema: obj() },
    { name: "learn_gesture", description: "Learn a hand gesture he's holding up right now and give it a name. Optionally link it to one of your tricks so the gesture starts that trick. He must hold the gesture still in front of your camera while you call this.",
      input_schema: obj({ name: { type: "string" }, trick: { type: "string", description: "optional trick name to run when you see this gesture" } }, ["name"]) },
    { name: "forget_gesture", description: "Forget a hand gesture he taught you.", input_schema: obj({ name: { type: "string" } }, ["name"]) },
    { name: "see_tags", description: "List the printed marker tags (little black-and-white squares) in view right now, where they are and roughly how far, plus every tag you have a name for. Offline and instant.", input_schema: obj() },
    { name: "name_tag", description: "Give a marker tag a name (what it's stuck on: charger, toolbox, kitchen door...). With no id, names the single tag currently in view. Optionally link a trick to run when you see it.",
      input_schema: obj({ name: { type: "string" }, id: { type: "number" }, trick: { type: "string" } }, ["name"]) },
    { name: "forget_tag", description: "Forget a marker tag's name (by name or number).", input_schema: obj({ tag: { type: "string" } }, ["tag"]) },
    { name: "read_text", description: "Read printed text in front of your camera with the phone's own text reader (offline, no internet): labels, signs, pages, model numbers. Returns the text it found. For handwriting or tricky text, use look instead if you're online.", input_schema: obj() },
    { name: "read_notifications", description: "Read the notifications currently showing on the phone you live in (which app, title, text). Only when he asks.", input_schema: obj() },
    { name: "listen_pitch", description: "Listen for a couple of seconds and tell which musical note he's singing, humming, whistling or playing, and whether it's in tune.", input_schema: obj({ seconds: { type: "number" } }) },
    { name: "hum_back", description: "Listen to him hum, sing or whistle a tune for a few seconds, then play the same tune back on your synthesizer.", input_schema: obj({ seconds: { type: "number" }, instrument: { type: "string" } }) },
    { name: "remember_face", description: "Learn the face of the person in front of your camera so you recognize them from now on (stored only on this phone). Use when he introduces someone or himself: 'this is Sam', 'remember my face'. They should face you for a few seconds.",
      input_schema: obj({ name: { type: "string" }, notes: { type: "string", description: "optional: one line about who they are" } }, ["name"]) },
    { name: "who_is_here", description: "Check who is in front of your camera right now: names of people you know by face, and whether there are strangers. Offline.", input_schema: obj() },
    { name: "forget_face", description: "Forget someone's face (delete their face print).", input_schema: obj({ name: { type: "string" } }, ["name"]) },
    { name: "list_people", description: "List everyone you know by face, how often you've seen them and when last.", input_schema: obj() },
    { name: "note_about_person", description: "Add a short note about a person you know by face (who they are, what they like, how to greet them).", input_schema: obj({ name: { type: "string" }, note: { type: "string" } }, ["name", "note"]) },
    { name: "phone_routines", description: "List the phone tasks you've learned to do from memory (these work with no internet and no AI).", input_schema: obj() },
    { name: "forget_phone_routine", description: "Forget a learned phone routine, so next time you work the task out afresh.", input_schema: obj({ goal: { type: "string" } }, ["goal"]) },
    { name: "self_check", description: "Run a check of every part of you (brains, hearing, voice, camera, vision, sensors, battery, temperature, memory, storage) and get the results. Use for 'are you okay', 'systems check', or when something seems wrong with you.", input_schema: obj() },
    { name: "calibrate_ears", description: "Teach yourself which way is up for sound direction: he claps once right above the top edge of the phone and you note which microphone heard it first. Also reports whether the phone gives you two microphones at all.", input_schema: obj() },
    { name: "name_room", description: "He tells you what room this is ('this is the kitchen'). You remember how it looks, recognize it later, and remember which room things were in.", input_schema: obj({ name: { type: "string" } }, ["name"]) },
    { name: "which_room", description: "Which room are you in, going by how it looks?", input_schema: obj() },
    { name: "learn_thing", description: "He's holding up a particular object and telling you its name ('this is Frank', 'this is my good screwdriver'). Remember what it looks like so you recognize that exact thing later. He must hold it in the middle of your view.", input_schema: obj({ name: { type: "string" } }, ["name"]) },
    { name: "remember_place", description: "Remember where you are right now under a name (home, workshop, mom's house), using the phone's location. Later you'll know when you're there again.", input_schema: obj({ name: { type: "string" } }, ["name"]) },
    { name: "screen", description: "Turn your screen dark (pure black; you keep seeing, hearing and talking, it just saves the display and the battery) or bring your face back. Use when he says 'go dark', 'screen off', 'lights out', 'screen on', 'show your face'.", input_schema: obj({ state: { type: "string", enum: ["dark", "on"] } }, ["state"]) },
    { name: "where_am_i", description: "Check the phone's location and tell which remembered place you're at or near (or that it's somewhere new).", input_schema: obj() }
  ];
  const NAMES = new Set(E.tools.map(t => t.name));
  E.handles = n => NAMES.has(n);
  E.run = async (name, input = {}) => {
    if (name === "name_room" || name === "which_room" || name === "learn_thing") return V()?.run ? await V().run(name, input) : "FAILED: vision isn't loaded.";
    if (name === "count_fingers" || name === "learn_gesture" || name === "forget_gesture") return V()?.run ? await V().run(name, input) : "FAILED: vision isn't loaded.";
    if (name === "remember_face") return window.People ? await People.remember(input.name, input.notes) : "FAILED: not loaded.";
    if (name === "who_is_here") return window.People ? await People.who() : "FAILED: not loaded.";
    if (name === "forget_face") return window.People ? await People.forget(input.name) : "FAILED: not loaded.";
    if (name === "list_people") return window.People ? await People.list() : "FAILED: not loaded.";
    if (name === "note_about_person") return window.People ? await People.note(input.name, input.note) : "FAILED: not loaded.";
    if (name === "phone_routines") { try { const r = (await api("/api/phone/routines")).routines; return r.length ? "Phone tasks you can do from memory: " + r.map(x => `"${x.goal}" (${x.steps} steps, done ${x.runs} more times since learning)`).join("; ") + "." : "You haven't learned any phone routines yet. You learn one each time you finish a phone task successfully."; } catch (err) { return "FAILED: " + err.message; } }
    if (name === "forget_phone_routine") { try { return (await api("/api/phone/routines?goal=" + encodeURIComponent(input.goal || ""), { method: "DELETE" })).forgotten ? "Forgotten." : "No routine matched that."; } catch (err) { return "FAILED: " + err.message; } }
    if (name === "calibrate_ears") return await calibrateEars();
    if (name === "screen") return window.Dark ? Dark.set(input.state) : "FAILED: not loaded.";
    if (name === "self_check") return window.selfCheck ? await selfCheck() : "FAILED: not loaded.";
    if (name === "see_tags") return window.Tags?.available ? Tags.describe() : "FAILED: the tag reader didn't load.";
    if (name === "name_tag") return window.Tags ? await Tags.name(input.name, input.id, input.trick) : "FAILED: the tag reader didn't load.";
    if (name === "forget_tag") return window.Tags ? await Tags.forget(input.tag) : "FAILED: the tag reader didn't load.";
    if (name === "read_text") return await readText();
    if (name === "read_notifications") return await readNotifications();
    if (name === "listen_pitch") return window.AudioSmarts ? await AudioSmarts.listenPitch(input.seconds || 3) : "FAILED: not loaded.";
    if (name === "hum_back") return window.AudioSmarts ? await AudioSmarts.humBack(input.seconds || 6, input.instrument || "flute") : "FAILED: not loaded.";
    if (name === "remember_place") return await rememberPlace(input.name);
    if (name === "where_am_i") return await whereAmI();
    return "Unknown tool " + name;
  };

  // ---- reading text offline (tesseract on the phone, through her server) ----
  async function readText() {
    try { await camOn(); } catch { return "FAILED: no camera."; }
    const v = $("#cam"); for (let i = 0; i < 20 && !v.videoWidth; i++) await sleep(100);
    if (!v.videoWidth) return "FAILED: camera gave no picture.";
    const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext("2d").drawImage(v, 0, 0);
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.92));
    try {
      const r = await fetch("/api/ocr", { method: "POST", headers: { "content-type": "image/jpeg" }, body: blob });
      const j = await r.json(); if (!r.ok) return "FAILED: " + (j.error || r.status);
      const text = (j.text || "").trim();
      if (text.replace(/[^a-z0-9]/gi, "").length < 3) return "You couldn't make out any text. He should hold it closer, flatter and in better light.";
      window.Mind?.event("read", `you read: "${text.slice(0, 120)}"`, { source: "SAW", salience: 0.5 });
      return `The text you can read (offline reader, may have small mistakes):\n${text.slice(0, 1500)}`;
    } catch (e) { return "FAILED: " + e.message; }
  }
  E.readText = readText;

  async function readNotifications() {
    try {
      const r = await api("/api/hw/extra?what=notifications");
      const list = Array.isArray(r.result) ? r.result : [];
      const mine = list.filter(n => !/^com\.termux/.test(n.packageName || "") && (n.title || n.content)).slice(0, 8);
      if (!mine.length) return "No notifications on the phone right now.";
      return "Notifications on the phone:\n" + mine.map(n => `- ${String(n.packageName || "").split(".").pop()}: ${n.title || ""}${n.content ? " — " + String(n.content).slice(0, 160) : ""}`).join("\n");
    } catch (e) { return "FAILED: " + e.message + " (To allow it: Android Settings > Notifications > Device & app notifications (Notification access) > Termux:API > Allow.)"; }
  }

  // ---- which microphone is the top one? ----
  async function calibrateEars() {
    const A = window.AudioSmarts; if (!A) return "FAILED: not loaded.";
    if (!(await window.Tricks?.earsStart?.(true))) return "FAILED: your ears (microphone) aren't available right now.";
    if (A.stereo.ok === false) return "The phone only gives you one microphone here, so you can't tell where sounds come from. Nothing to calibrate.";
    await speak("Clap once, right above my head, close to the top edge of the phone.");
    const t0 = performance.now(); let hit = null;
    while (performance.now() - t0 < 8000 && !hit) { if (A.stereo.last && A.stereo.last.t > t0) hit = A.stereo.last; await sleep(100); }
    if (!hit) return A.stereo.ok === true ? "You didn't catch a clear clap from one end. He should clap sharply, a hand's width above the top of the phone." : "You couldn't tell yet whether the phone has two usable microphones. Try again after a few louder sounds.";
    if (hit.top < 0) { settings.micTopFirst = settings.micTopFirst === false ? true : false; saveSettings(); return "Calibrated: you had top and bottom swapped, and it's fixed now. Sounds from above will make you look up."; }
    return "Calibrated: you already had it right. Sounds from above make you look up, from below make you look down.";
  }

  // ---- places ----
  let places = null;
  const loadPlaces = async () => { if (!places) { try { places = JSON.parse(await readFile("places.json")); } catch { places = []; } } return places; };
  const metres = (a, b) => { const R = 6371000, r = x => x * Math.PI / 180, dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
  async function here() { const r = await api("/api/hw/extra?what=location"); const l = r.result; if (!l || l.latitude == null) throw new Error("the phone didn't give a location (is Location on?)"); return { lat: l.latitude, lon: l.longitude, acc: l.accuracy || 100 }; }
  async function rememberPlace(name) {
    name = String(name || "").trim().slice(0, 40); if (!name) return "FAILED: give the place a name.";
    try { const p = await here(); await loadPlaces(); places = places.filter(x => x.name.toLowerCase() !== name.toLowerCase()); places.push({ name, ...p, t: Date.now() });
      await writeFile("places.json", JSON.stringify(places, null, 1)); return `Remembered this spot as "${name}" (accurate to about ${Math.round(p.acc)} m).`; }
    catch (e) { return "FAILED: " + e.message; }
  }
  async function whereAmI() {
    try { const p = await here(); await loadPlaces();
      if (!places.length) return "You have a location but no remembered places yet. He can tell you 'remember this place as home'.";
      const near = places.map(x => ({ ...x, d: metres(p, x) })).sort((a, b) => a.d - b.d)[0];
      return near.d < Math.max(150, p.acc * 1.5) ? `You're at "${near.name}".` : `You're not at a place you know. The nearest is "${near.name}", about ${near.d > 2000 ? (near.d / 1000).toFixed(1) + " km" : Math.round(near.d / 10) * 10 + " m"} away.`; }
    catch (e) { return "FAILED: " + e.message; }
  }

  // =============================== games ===============================
  const ask3 = async (prompt, ms, test) => { await speak(prompt); const t0 = now(); while (now() - t0 < ms) { const r = test(); if (r) return { ok: true, t: (now() - t0) / 1000, r }; await sleep(150); } return { ok: false }; };
  const needEyes = () => !V()?.available ? "FAILED: her vision engine isn't running (robot-vision-download)." : !settings.track ? "FAILED: her camera eyes are off (Settings > Eyes follow movement)." : null;
  const hold = (test, ms = 500) => { let since = 0; return () => { if (test()) { if (!since) since = now(); return now() - since > ms; } since = 0; return false; }; };

  const FINDABLE = ["cup", "bottle", "book", "cell phone", "remote", "spoon", "fork", "banana", "apple", "orange", "scissors", "keyboard", "mouse", "teddy bear", "backpack", "clock", "toothbrush", "bowl", "laptop", "knife"];
  async function scavenger() {
    const err = needEyes(); if (err) return err;
    V().gameBusy = true; let score = 0; const log = [];
    try {
      await speak("Scavenger hunt. I name it, you show it to me. Three rounds.");
      for (let round = 1; round <= 3; round++) {
        const color = round === 2 && window.Tricks?.colorNow;                       // the middle round is a color
        const target = color ? pick(["red", "blue", "green", "yellow", "orange", "purple", "pink"]) : pick(FINDABLE.filter(f => !log.some(l => l.startsWith(f))));
        const r = await ask3(color ? `Round two. Bring me something ${target}.` : `Round ${round}. Show me a ${target}.`, 25000,
          hold(() => color ? Tricks.colorNow()?.name === target : V().objectsVisible().includes(target), 600));
        if (r.ok) { score++; Abilities.sfx("coin"); Face.gesture("wide"); log.push(`${target}: found in ${r.t.toFixed(0)}s`); } else { Abilities.sfx("sad_trombone"); log.push(`${target}: not found (she saw ${V().objectsVisible().join(", ") || "nothing she recognized"})`); await sleep(2500); }
      }
    } finally { V().gameBusy = false; }
    window.Tricks?.bump?.("scavenger_finds", score);
    return `Scavenger hunt: he found ${score} of 3. ${log.join("; ")}.`;
  }

  async function missing() {
    const err = needEyes(); if (err) return err;
    await speak("What's missing. Put a few things where I can see them.");
    let before = []; const t0 = now();
    while (now() - t0 < 15000) { before = V().objectsVisible(); if (before.length >= 3) break; await sleep(400); }
    if (before.length < 2) return `What's missing: she could only recognize ${before.length ? before.join(", ") : "nothing"}. It needs at least two things she knows (cup, bottle, book, phone, remote, scissors, fruit...).`;
    await sleep(1500); before = [...new Set([...before, ...V().objectsVisible()])];
    await speak("Got it. I'm closing my eyes. Take one away.");
    Face.prim?.squint(0, 0, 6500); await sleep(6500);
    await speak("Opening."); await sleep(2500);
    const after = V().objectsVisible();
    const gone = before.filter(o => !after.includes(o)), added = after.filter(o => !before.includes(o));
    window.Tricks?.bump?.("missing_games");
    return `What's missing: before she saw ${before.join(", ")}. Now she sees ${after.join(", ") || "nothing"}. Her answer: ${gone.length ? "the " + gone.join(" and the ") + (gone.length > 1 ? " are" : " is") + " gone" : "nothing looks missing"}${added.length ? `, and there's a new ${added.join(", ")}` : ""}.`;
  }

  // Simon Says with his whole body: only do it if she says "Simon says".
  const POSES = [["put both hands up", () => V().posture === "both hands up"], ["raise one hand", () => V().posture === "one hand raised"], ["crouch down", () => V().posture === "crouching down"],
    ["give me a thumbs up", () => V().gesture === "Thumb_Up"], ["show me an open hand", () => V().gesture === "Open_Palm" || V().fingers === 5], ["make a fist", () => V().gesture === "Closed_Fist"],
    ["show me three fingers", () => V().fingers === 3], ["smile", () => V().expression === "smiling"]];
  async function poses() {
    const err = needEyes(); if (err) return err;
    V().gameBusy = true; let round = 0;
    try {
      await speak("Simon Says, with your body. Only do it if Simon says.");
      const pool = POSES;
      for (round = 1; round <= 7; round++) {
        const [what, test] = pick(pool), simon = Math.random() < 0.7, heldTest = hold(test, 400);
        const r = await ask3((simon ? "Simon says " : "") + what + ".", simon ? 7000 : 4000, heldTest);
        if (simon && !r.ok) { Abilities.sfx("sad_trombone"); return `Pose Simon Says: out in round ${round}. She said "Simon says ${what}" and didn't see him do it.`; }
        if (!simon && r.ok) { Abilities.sfx("alarm"); Face.gesture("squint"); return `Pose Simon Says: out in round ${round}. She never said "Simon says" and he did "${what}" anyway.`; }
        Abilities.sfx("coin");
      }
    } finally { V().gameBusy = false; }
    window.Tricks?.bump?.("pose_simon_wins");
    return "Pose Simon Says: he survived all 7 rounds.";
  }

  async function fingerMath() {
    const err = needEyes(); if (err) return err;
    V().gameBusy = true; let score = 0; const log = [];
    try {
      await speak("Finger math. Answer with your fingers, both hands if you need them.");
      for (let i = 0; i < 4; i++) {
        const a = 1 + Math.floor(Math.random() * 5), b = Math.floor(Math.random() * 5), minus = Math.random() < 0.3 && a > b, ans = minus ? a - b : a + b;
        const r = await ask3(`${a} ${minus ? "minus" : "plus"} ${b}.`, 9000, hold(() => V().fingers === ans, 700));
        if (r.ok) { score++; Abilities.sfx("coin"); } else { Abilities.sfx("boop"); }
        log.push(`${a}${minus ? "-" : "+"}${b}=${ans}: ${r.ok ? "right" : `he showed ${V().fingers ?? "no hand"}`}`);
      }
    } finally { V().gameBusy = false; }
    window.Tricks?.bump?.("finger_math_right", score);
    return `Finger math: ${score} of 4 right. ${log.join("; ")}.`;
  }

  async function followFinger() {
    const err = needEyes(); if (err) return err;
    await speak("Hold up one finger and move it around. I'll follow it.");
    let tracked = 0; const t0 = now(), dirs = new Set();
    while (now() - t0 < 14000) { if (V().pointing) { tracked += 150; dirs.add(V().pointing.x < -0.3 ? "left" : V().pointing.x > 0.3 ? "right" : V().pointing.y < -0.2 ? "up" : "middle"); } await sleep(150); }
    return tracked < 1500 ? "Follow my finger: she never got a clear look at one raised finger." : `Follow my finger: her eyes stayed on his fingertip for ${(tracked / 1000).toFixed(0)} of 14 seconds (it went ${[...dirs].join(", ")}).`;
  }

  async function balance() {
    if (typeof orient === "undefined" || !orient || orient.tiltSide == null) return "FAILED: no tilt sensor reading (the phone hasn't reported its orientation yet).";
    await speak("Balance game. Pick me up and hold me perfectly still and level. Ten seconds. Go.");
    await sleep(800);
    const base = { fb: orient.tiltFrontBack, s: orient.tiltSide }; let good = 0, worst = 0; const t0 = now();
    while (now() - t0 < 10000) {
      const off = Math.hypot(orient.tiltFrontBack - base.fb, orient.tiltSide - base.s); worst = Math.max(worst, off);
      if (off < 4) good += 100; else if (off > 12) { Face.gesture(orient.tiltSide - base.s > 0 ? "look_right" : "look_left"); Face.prim?.tremble(0.6, 200); }
      Face.lookAt((orient.tiltSide - base.s) / 20, (orient.tiltFrontBack - base.fb) / 20, 200);
      await sleep(100);
    }
    const pct = Math.round(good / 100); Abilities.sfx(pct >= 80 ? "tada" : "boing"); window.Tricks?.bump?.("balance_games");
    return `Balance game: he kept her level ${pct}% of the time. Worst wobble: ${worst.toFixed(0)} degrees.`;
  }

  async function soundGuess() {
    if (!V()?.hearing) return "FAILED: her sound recognizer isn't running (robot-vision-download).";
    await window.Tricks?.earsStart?.(true);
    await speak("Make a sound. Any sound. I'll guess what it is. Three tries.");
    const guesses = [];
    for (let i = 0; i < 3; i++) {
      Abilities.sfx("beep"); await sleep(600); const heard = {}; const t0 = now();
      while (now() - t0 < 4000) { for (const s of V().sounds || []) if (!/^(speech|silence|inside|outside)/i.test(s)) heard[s] = (heard[s] || 0) + 1; await sleep(500); }
      const top = Object.entries(heard).sort((a, b) => b[1] - a[1])[0];
      guesses.push(top ? top[0].toLowerCase() : "nothing she could name");
      await speak(top ? `I think that was ${top[0].toLowerCase()}.` : "I couldn't tell what that was.");
    }
    return `Guess the sound: her three guesses were ${guesses.join("; ")}. Ask him how many she got right.`;
  }

  async function matchNote() {
    const A = window.AudioSmarts; if (!A) return "FAILED: not loaded.";
    if (!(await window.Tricks?.earsStart?.(true))) return "FAILED: her ears (microphone) aren't available right now.";
    await speak("Match my note. I play it, you sing it back. Any octave.");
    const log = []; let score = 0;
    for (let i = 0; i < 3; i++) {
      const note = pick(["C4", "D4", "E4", "F4", "G4", "A4"]);
      await Abilities.play({ notes: note + "/1", tempo: 100, instrument: "flute", drums: "", vibrate: false }); await sleep(500);
      const seen = []; const t0 = now();
      while (now() - t0 < 4500) { if (A.pitch) seen.push(A.pitch.midi); await sleep(60); if (seen.length > 14) break; }
      if (seen.length < 4) { log.push(`${note}: no clear note from him`); await speak("I didn't hear a note."); continue; }
      seen.sort((a, b) => a - b); const med = seen[seen.length >> 1];
      const target = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9 }[note[0]];
      let diff = ((med - target) % 12 + 12) % 12; if (diff > 6) diff -= 12;                 // semitones off, ignoring the octave
      const good = Math.abs(diff) < 0.6; if (good) { score++; Abilities.sfx("coin"); } else Abilities.sfx("boop");
      log.push(`${note}: he sang ${A.noteName(med)} (${good ? "close enough" : `${Math.abs(diff).toFixed(1)} semitones ${diff > 0 ? "sharp" : "flat"}`})`);
    }
    window.Tricks?.bump?.("notes_matched", score);
    return `Match my note: ${score} of 3. ${log.join("; ")}.`;
  }

  E.games = { scavenger, missing, poses, finger_math: fingerMath, follow_finger: followFinger, balance, sound_guess: soundGuess, match_note: matchNote };
  E.gameHelp = "scavenger (scavenger hunt: he shows you objects you name), missing (what's missing: he removes an object while your eyes are closed), poses (Simon Says with his body), finger_math (sums answered with fingers), follow_finger, balance (he holds you level), sound_guess (you guess sounds he makes), match_note (he sings back notes you play)";
  for (const [k, fn] of Object.entries(E.games)) window.Tricks?.registerGame?.(k, fn);

  // =============================== offline skills ===============================
  // The offline brain can't call tools. So ordinary requests are matched here and carried out for real;
  // askLocal() then tells the offline brain what just happened so it can say it in character.
  const GAME_WORDS = [[/rock.?paper|\brps\b/, "rps"], [/simon says.*(body|pose)|pose/, "poses"], [/simon/, "simon"], [/reaction/, "reaction"], [/staring/, "staring"], [/red light/, "redlight"],
    [/colou?r hunt/, "color"], [/clap/, "claps"], [/scavenger/, "scavenger"], [/missing|disappear/, "missing"], [/finger math|math/, "finger_math"], [/follow my finger/, "follow_finger"],
    [/balanc/, "balance"], [/guess (the|that|my) sound|sound game/, "sound_guess"], [/match (my|the) note|note game|sing/, "match_note"]];
  const INTENTS = [
    [/\b(?:let'?s |wanna |want to |can we )?play\b(.*)/i, m => { const g = GAME_WORDS.find(([re]) => re.test(m[1].toLowerCase())); return g ? ["play_game", { game: g[1] }] : /\bgame\b/.test(m[1]) ? ["play_game", { game: pick(["simon", "reaction", "staring", "scavenger", "finger_math", "poses"]) }] : null; }],
    [/\b(?:do|show me|perform)\b.*\btrick\b/i, m => { const names = window.Tricks?.list?.() || []; const t = m[0].toLowerCase(); const hit = names.find(n => t.includes(n.replace(/_/g, " "))); return ["do_trick", { name: hit || "random" }]; }],
    [/(?:remember|learn) my face(?: as| ?,? i'?m| ?,? my name is)? ?(.*)/i, m => ["remember_face", { name: m[1].replace(/[.!?]+$/, "").trim() || "him" }]],
    [/^(?:this is|meet) (?!a |an |the |my (?!friend|wife|husband|son|daughter|mom|dad|brother|sister))(?:my \w+,? )?([A-Z][\w'-]+(?: [A-Z][\w'-]+)?)[.!]*$/, m => V()?.faces > 0 && !V()?.hand ? ["remember_face", { name: m[1] }] : null],   // a face in view and nothing held up: it's a person
    [/who am i\b|do you (?:know|recognize|remember) (?:me|who i am|this (?:person|guy))|who(?:'s| is) (?:this|that|here)\b/i, () => ["who_is_here", {}]],
    [/forget (\w+)'?s? face/i, m => ["forget_face", { name: m[1] }]],
    [/who do you know|list (?:the )?people/i, () => ["list_people", {}]],
    [/calibrate (?:your )?ears/i, () => ["calibrate_ears", {}]],
    [/\b(?:go dark|screen off|lights out|(?:turn|switch) (?:off )?(?:your|the) (?:screen|face|display)(?: off)?\b(?!.* on\b)|hide your face|black ?out)/i, () => ["screen", { state: "dark" }]],
    [/\b(?:screen on|(?:turn|switch) (?:your|the) (?:screen|face|display) (?:back )?on|show (?:me )?your face|lights on|face on)\b/i, () => ["screen", { state: "on" }]],
    [/systems? check|self.?(?:check|test)|diagnostic|are you (?:ok|okay|working|broken)|what(?:'s| is) wrong with you/i, () => ["self_check", {}]],
    [/^(?:use|on) (?:the|your|my) phone,? (?:to )?(.+)/i, m => ["use_phone", { goal: m[1].replace(/[.!]+$/, "") }]],
    [/what phone (?:tasks|routines)|phone routines/i, () => ["phone_routines", {}]],
    [/^(?:this is|you'?re in|we'?re in|this room is) (?:the |my |our )?(kitchen|bedroom|living room|bathroom|garage|workshop|office|hallway|basement|dining room|shop|den|porch|car|truck|[a-z]+ room)[.!]*$/i, m => ["name_room", { name: m[1] }]],
    [/what room|which room|where are you right now/i, () => ["which_room", {}]],
    // "this is my good screwdriver" / "this is Frank" while something is held up: learn what that thing looks like
    [/^(?:this is|this thing is|call this|this one is) ((?:called |named )|(?:my |the |a |an ))?(.{2,40}?)[.!]*$/i, m => {
      const name = m[2].trim(), proper = /^[A-Z]/.test(name);
      const head = name.split(/\s+/).pop();                    // "a good idea" is not a thing she can look at
      if (!(m[1] || proper) || /^(joke|test|problem|waste|mess|disaster|shame|lot|bit|mistake|nightmare|dream|idea|way|one|thing|kind|part|end|point|reason|question|time|day|life|fun)$/i.test(head)) return null;
      return V()?.hand || V()?.objectsVisible?.().length ? ["learn_thing", { name }] : null; }],
    [/how many fingers|count my fingers/i, () => ["count_fingers", {}]],
    [/what (?:am i|i'?m) holding|what(?:'s| is) (?:this|that)\b|what (?:objects|things) (?:do|can) you see/i, () => ["see_objects", {}]],
    [/what (?:do|can) you see|who(?:'s| is) (?:there|here)|can you see me|how many (?:people|faces)|am i smiling|look at me/i, () => ["see_people", {}]],
    [/what colou?r/i, () => ["what_color", {}]],
    [/read (?:this|that|it|the \w+)|what does (?:this|that|it) say/i, () => ["read_text", {}]],
    [/(?:read|check|any|what are) (?:my |the |new )*(?:notifications|messages)/i, () => ["read_notifications", {}]],
    [/what note|which note|am i in tune/i, () => ["listen_pitch", {}]],
    [/hum (?:it|this|that) back|play (?:it|this|that|my tune) back|listen to (?:this|my) (?:tune|melody|song)/i, () => ["hum_back", {}]],
    [/(?:what|which) tags?|see (?:a |any |the )?tags?/i, () => ["see_tags", {}]],
    [/this (?:tag|marker) is (?:the |my |a )?(.+)/i, m => ["name_tag", { name: m[1].replace(/[.!?]+$/, "") }]],
    [/(?:learn|remember) this (?:gesture|sign|hand)(?: (?:as|called|is))? ?(.*)/i, m => ["learn_gesture", { name: m[1].replace(/[.!?]+$/, "") || "my gesture" }]],
    [/where(?:'s| is| are| did i (?:put|leave))\s+(?:my |the |that )?(.+?)[?.!]*$/i, m => ["recall", { thing: m[1] }]],
    [/\bi (?:put|left|am putting|'m putting)\s+(?:my |the )?(.+?)\s+((?:on|in|at|under|by|next to|behind|inside)\b.+?)[.!]*$/i, m => ["note_where", { thing: m[1], where: m[2], how: "told" }]],
    [/remember this place as (.+)/i, m => ["remember_place", { name: m[1].replace(/[.!?]+$/, "") }]],
    [/where are (?:we|you)\b|what place is this/i, () => ["where_am_i", {}]],
    [/^(?:please )?remember (?:that )?(.+)/i, m => ["remember", { note: m[1] }]],
    [/(?:set|start) (?:a )?timer (?:for )?(\d+) ?(second|minute|hour)/i, m => ["set_timer", { seconds: +m[1] * ({ second: 1, minute: 60, hour: 3600 }[m[2].toLowerCase()]), label: "timer" }]],
    [/take (?:a |my )?(?:photo|picture|selfie)/i, () => ["take_photo", { label: "asked" }]],
    [/(?:play|sing) (?:the song |a song |some music|me )?(.*)/i, m => { const songs = window.Abilities?.songList || []; const t = m[1].toLowerCase().replace(/[^a-z ]/g, ""); const hit = songs.find(s => t && (t.includes(s.replace(/_/g, " ")) || s.replace(/_/g, " ").includes(t.trim()))); return ["play_song", { song: hit || pick(songs) }]; }],
    [/how was your day|what did you do today|read (?:your|the) diary/i, () => ["read_diary", {}]],
    [/(?:copy|mirror) (?:my face|me|my expression)/i, () => ["mirror_mode", { on: true }]],
    [/stop (?:copying|mirroring)/i, () => ["mirror_mode", { on: false }]],
    [/follow (?:the |my )?(light|flashlight)/i, () => ["eye_mode", { mode: "bright" }]],
    [/follow (?:the |anything )?(red|blue|green|yellow|orange|purple|pink)/i, m => ["eye_mode", { mode: m[1].toLowerCase() }]],
    [/what(?:'s| is) new|change ?log|what changed in you/i, () => ["read_changelog", {}]],
    [/open (?:the |my )?([\w ]{2,30}?)(?: app)?[.!]*$/i, m => ["open_app", { app: m[1].trim() }]]
  ];
  E.offlineIntent = text => {
    const t = String(text || "").split("\n")[0].trim(); if (!t || t.startsWith("(")) return null;      // system notes aren't requests
    for (const [re, make] of INTENTS) { const m = t.match(re); if (m) { try { const r = make(m); if (r) return { tool: r[0], input: r[1] }; } catch {} } }
    return null;
  };
  E.intentCount = INTENTS.length;

  // =============================== NFC tags ===============================
  // Tap a programmable NFC sticker to the back of the phone. Text like "nessari:trick:possessed" runs a command
  // (same format as her QR codes); anything else she just reads and reacts to.
  E.nfc = { on: false, error: "" };
  E.startNfc = async () => {
    if (!("NDEFReader" in window) || E.nfc.on) return E.nfc.on;
    try {
      const reader = new NDEFReader(); await reader.scan(); E.nfc.on = true;
      reader.onreading = ev => {
        for (const rec of ev.message.records) {
          let text = ""; try { text = rec.recordType === "text" || rec.recordType === "url" ? new TextDecoder(rec.encoding || "utf-8").decode(rec.data) : ""; } catch {}
          if (!text) continue;
          window.Abilities?.sfx("coin");
          if (window.Tricks?.onCode) Tricks.onCode(text, "nfc_tag"); else if (typeof react === "function") react("nfc", `an NFC tag was tapped against you. It says: "${text.slice(0, 200)}"`, 1);
        }
      };
    } catch (e) { E.nfc.error = e.message; }
    return E.nfc.on;
  };

  // =============================== automatic photos (off unless he turns it on) ===============================
  let lastAuto = 0;
  E.autoPhoto = why => {
    if (typeof settings === "undefined" || !settings.autoPhoto || Date.now() - lastAuto < 10 * 60000 || typeof takePhoto !== "function") return;
    lastAuto = Date.now(); takePhoto("auto " + why).then(r => typeof logEvent === "function" && logEvent("auto", { detail: "auto photo (" + why + "): " + r })).catch(() => {});
  };
  const hookAuto = () => { const v = V(); if (!v?.on || v._auto) return; v._auto = true;
    v.on("arrive", () => setTimeout(() => E.autoPhoto("someone arrived"), 1500)); v.on("sign", s => { if (/rock_on|custom/.test(s.sign)) E.autoPhoto("a hand sign"); }); };
  setTimeout(hookAuto, 4000); setTimeout(hookAuto, 16000);
})();
