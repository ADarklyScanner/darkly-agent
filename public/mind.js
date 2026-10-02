// Nessari's mind: one continuously running behavior engine under everything else.
//
//   perception → events → salience (habituation, surprise) → attention → working memory + world model
//              → internal state (drives that rise and decay) → action choice (face / glance / speech / nothing)
//
// - Every perception becomes an EVENT with a source (SAW / HEARD / FELT / TOLD / INFERRED / ONLINE) and confidence.
// - Repeated stimuli habituate; novel or unexpected ones are salient. Most events pass without a word (restraint).
// - Internal state is continuous (arousal, irritation, amusement, curiosity, boredom, alertness), decays to a
//   baseline, blends into the face, and changes what she does. Personality traits change the thresholds and rates.
// - Attention is one bottleneck: a crash steals her gaze mid-sentence, then she returns ("Anyway…").
// - Working memory: recent events, things and where they are (with confidence that fades), names he uses,
//   open loops (unfinished business), last action. A compact slice goes to the brain with each message.
(() => {
  "use strict";
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const nowMs = () => Date.now();
  const ago = t => { const s = (nowMs() - t) / 1000; return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${(s / 3600).toFixed(1)} h ago`; };

  // ---------------- personality → behavior parameters ----------------
  function P() {
    const t = (typeof personality !== "undefined" && personality?.traits) || {};
    const v = (k, d = 5) => (t[k] ?? d) / 10;                      // 0..1
    return {
      speakThreshold: clamp(0.62 - (v("chaos") - 0.5) * 0.15 - (v("talk", 3) * 2 - 0.6) * 0.1, 0.4, 0.8),   // how salient before she speaks
      faceThreshold: 0.18,                                          // below this: no visible reaction at all
      intensity: 0.6 + v("drama") * 0.8,                            // how big reactions get
      irritability: 0.5 + v("bluntness") * 0.5 + v("sarcasm") * 0.3,
      curiosity: 0.25 + v("curiosity") * 0.6,
      boredomRate: 0.0006 + (1 - v("curiosity")) * 0.0006,          // per second with nothing happening
      initiative: 0.3 + v("chaos") * 0.4 + v("confidence") * 0.2,
      warmth: v("warmth")
    };
  }

  // ---------------- internal state ----------------
  const BASELINE = { arousal: 0.25, irritation: 0.05, amusement: 0.15, curiosity: 0.3, boredom: 0.1, alertness: 0.45 };
  const DECAY_S = { arousal: 40, irritation: 150, amusement: 60, curiosity: 90, boredom: 25, alertness: 60 };   // time constants
  const S = { ...BASELINE };
  function nudge(changes) { for (const [k, d] of Object.entries(changes)) S[k] = clamp(S[k] + d * P().intensity, 0, 1); }
  let moodHoldUntil = 0;                                            // a mood the brain chose is held a while (emotional inertia)
  function moodImpulse(m) {
    moodHoldUntil = nowMs() + 15000;
    const map = { angry: { irritation: 0.4, arousal: 0.3 }, annoyed: { irritation: 0.2 }, happy: { amusement: 0.3, boredom: -0.3 },
      excited: { arousal: 0.4, amusement: 0.2, boredom: -0.5 }, sad: { arousal: -0.15, amusement: -0.2 }, bored: { boredom: 0.3 },
      confused: { curiosity: 0.2 }, suspicious: { curiosity: 0.2, alertness: 0.2 }, smug: { amusement: 0.2 }, flirty: { amusement: 0.25 } };
    if (map[m]) nudge(map[m]);
  }
  function derivedMood() {
    if (S.irritation > 0.62) return "angry";
    if (S.irritation > 0.36) return "annoyed";
    if (S.arousal > 0.7 && S.amusement > 0.4) return "excited";
    if (S.amusement > 0.55) return "happy";
    if (S.boredom > 0.6) return nightish() && S.arousal < 0.25 ? "sleepy" : "bored";
    if (S.curiosity > 0.65) return "suspicious";
    if (nightish() && S.arousal < 0.15) return "sleepy";
    return "calm";
  }
  const nightish = () => { const h = new Date().getHours(); return h >= 23 || h < 6; };

  setInterval(() => {                                              // 1 Hz: decay, boredom, mood, face blend
    const presence = presenceScore();
    for (const k of Object.keys(S)) S[k] += (BASELINE[k] - S[k]) * (1 - Math.exp(-1 / DECAY_S[k]));
    const quietFor = (nowMs() - lastEngaged) / 1000;
    if (quietFor > 60) S.boredom = clamp(S.boredom + P().boredomRate * 60 * (presence > 0 ? 1.4 : 0.6), 0, 1);
    if (typeof mood === "undefined") return;
    const strong = S.irritation > 0.6 || S.arousal > 0.85;           // strong feelings break through a held mood
    if ((nowMs() > moodHoldUntil || strong) && !busy) { const m = derivedMood(); if (m !== mood) setMoodQuiet(m); }
    // subtle, continuous expression on top of whatever mood is showing
    Face.setBlend?.({
      open: (S.alertness - 0.45) * 0.3 - S.boredom * 0.25,
      browA: S.irritation * 0.5,
      browY: (S.curiosity - 0.3) * -0.4,
      mouth: S.amusement * 0.35 - S.irritation * 0.3,
      low: S.boredom * 0.2 + S.amusement * 0.15
    });
    Face.setBlinkRate?.(listening ? 1.6 : S.boredom > 0.5 ? 0.7 : S.alertness > 0.7 ? 1.3 : 1);
  }, 1000);
  function setMoodQuiet(m) { mood = m; Face.setMood(m); }

  // ---------------- events / working memory ----------------
  // { t, type, text, source, conf, salience, key }
  const events = [];
  let lastEngaged = nowMs();
  function event(type, text, { source = "SAW", conf = 0.9, salience = 0.3, key = type } = {}) {
    const e = { t: nowMs(), type, text: String(text).slice(0, 200), source, conf, salience, key };
    events.push(e); if (events.length > 400) events.splice(0, events.length - 400);
    if (salience >= 0.5) writeFile(`events/${new Date().toISOString().slice(0, 10)}.jsonl`, JSON.stringify(e) + "\n", true).catch(() => {});
    return e;
  }

  // ---------------- habituation / surprise / salience ----------------
  const stim = {};                                                  // key → { h, count, last, first }
  function salienceOf(key, base, { recoverMin = 10 } = {}) {
    const s = stim[key] ||= { h: 0, count: 0, last: 0, first: nowMs() };
    const dt = (nowMs() - (s.last || nowMs())) / 60000;
    s.h *= Math.exp(-dt / recoverMin);                              // habituation wears off with time
    const novelty = 1 - s.h;
    let sal = base * (0.2 + 0.8 * novelty);
    if (s.count === 0) sal += 0.12;                                 // never seen this before: surprising
    if (nightish() && /bang|shout|impact|motion|face-arrive/.test(key)) sal += 0.15;   // 3 AM bang matters
    if (busy || talking) sal *= 0.85;
    s.h = s.h + (1 - s.h) * 0.35; s.count++; s.last = nowMs();
    return clamp(sal, 0, 1);
  }

  // ---------------- attention ----------------
  let distractUntil = 0;
  const distracted = () => nowMs() < distractUntil;
  function glance(x, y, ms) { distractUntil = nowMs() + ms; Face.lookAt(x, y, ms); }
  // where an event "is" when we don't know: a guess (sound: off to a side)
  const guessDir = key => /bang|shout|impact|sound|clap|knock/.test(key) ? [Math.random() < 0.5 ? -0.9 : 0.9, -0.2] : null;

  // ---------------- interruption: cut off mid-sentence, react, then "Anyway…" ----------------
  let resumeText = null;
  function interruptSpeech() {
    if (!talking || typeof speakingNow === "undefined" || !speakingNow.length) return null;
    // what she hadn't said yet: the rest of the current sentence piece after the word she was on, plus later pieces
    const idx = window.speakIndex ?? 0, cur = speakingNow[idx]?.text || "", at = window.speakChar ?? 0;
    const nextSentence = cur.slice(at).search(/[.!?…]\s/);
    const restOfCur = nextSentence >= 0 ? cur.slice(at + nextSentence + 2) : "";
    const rest = [restOfCur, ...speakingNow.slice(idx + 1).map(u => u.text)].join(" ").trim();
    speakToken++; speechSynthesis.cancel(); talking = false; Face.setTalking(false);
    $("#said").textContent += " —";
    return rest.length > 12 ? rest : null;
  }

  // ---------------- the main entry: something was perceived ----------------
  // react() in app.js and all sensors land here.
  const STATE_EFFECTS = {
    bang: { arousal: 0.45, alertness: 0.5, boredom: -0.6 }, impact: { arousal: 0.5, alertness: 0.5, irritation: 0.1 },
    shout: { arousal: 0.3, alertness: 0.4 }, shake: { arousal: 0.3, alertness: 0.3 }, motion: { alertness: 0.2, boredom: -0.4 },
    "face-arrive": { arousal: 0.2, boredom: -0.6, alertness: 0.2 }, "face-left": { boredom: 0.1, arousal: -0.05 },
    "face-close": { arousal: 0.25, alertness: 0.2 }, charge: { arousal: -0.05 }, dark: { arousal: -0.15, alertness: -0.1 },
    bright: { arousal: 0.1 }, offline: { irritation: 0.1 }, wave: { amusement: 0.15, boredom: -0.4 }, smile: { amusement: 0.2 },
    thumbup: { amusement: 0.2 }, thumbdown: { irritation: 0.1 }, ily: { amusement: 0.3 }
  };
  function perceive(key, what, { base = 0.6, recoverMin = 10, important = false, source = "SAW", minutes = 0 } = {}) {
    const family = key.replace(/^touch-.*/, "touch").replace(/^code-.*/, "code").replace(/^battery\d+/, "battery");
    nudge(STATE_EFFECTS[family] || STATE_EFFECTS[key] || { alertness: 0.05 });
    if (!/^touch/.test(key)) lastEngaged = nowMs();
    const sal = salienceOf(key, important ? Math.max(base, 0.95) : base, { recoverMin: Math.max(recoverMin, minutes) });
    event(family, what, { source, salience: sal, key });
    try { window.Behaviors?.onPerceive(family, sal); } catch {}

    if (sal < P().faceThreshold) return { sal, acted: "nothing" };
    const dir = guessDir(key); if (dir) glance(dir[0], dir[1], 900 + sal * 1200);

    const p = P();
    const talkedRecently = nowMs() - lastSpontaneous < 45000;      // a speech budget: restraint
    const allowed = settings.react && (!(settings.night && nightish()) || important);
    if (!allowed || sal < p.speakThreshold || (talkedRecently && sal < 0.9)) return { sal, acted: "face" };

    // big enough to interrupt herself?
    if (talking && sal > 0.75) resumeText = interruptSpeech();
    if (!canSpeakUp()) return { sal, acted: "face" };
    lastSpontaneous = nowMs();
    const strength = sal > 0.85 ? "strongly" : sal > 0.7 ? "" : "mildly";
    const interrupted = resumeText ? " You were interrupted mid-sentence by this; react to it first." : "";
    speakUp(`(system: something just happened (${source.toLowerCase()}): ${what}. React ${strength} in character.${interrupted})`, "reacted: " + what, family)
      .then(() => {
        if (resumeText && canSpeakUp()) { const r = resumeText; resumeText = null; setTimeout(() => speak("Anyway… " + r), 400); }
        resumeText = null;
      });
    return { sal, acted: "speech" };
  }
  let lastSpontaneous = 0;

  // touches feed state differently: pokes accumulate irritation that decays; pets reduce it
  function touch(kind, zone) {
    lastEngaged = nowMs();
    const sal = salienceOf(`touch-${kind}`, 1, { recoverMin: 2 });
    const rep = 1 - sal;                                            // how repetitive this has become
    const fx = {
      tap: { irritation: 0.035 + rep * 0.08 * P().irritability, alertness: 0.1 }, double_tap: { irritation: 0.06 + rep * 0.08 },
      hold: { curiosity: 0.1 }, stroke: { irritation: -0.15, amusement: 0.15, boredom: -0.3 }, scratch: { irritation: -0.2, amusement: 0.25 },
      rub: { amusement: 0.15, irritation: -0.05 }, tickle: { amusement: 0.35, arousal: 0.3 }, slap: { irritation: 0.45, arousal: 0.4 },
      squish: { irritation: 0.1, amusement: 0.1 }, stretch: { amusement: 0.1 }, boop: { amusement: 0.2, irritation: rep * 0.15 }, swipe: { arousal: 0.05 }
    }[kind] || {};
    if (/eye/.test(zone) && kind === "tap") fx.irritation = (fx.irritation || 0) + 0.15;
    nudge({ ...fx, boredom: -0.3 });
    try { window.Behaviors?.onTouch(kind, zone, rep); } catch {}
    event("touch", `${kind} on ${zone}`, { source: "FELT", salience: sal * 0.5, key: `touch-${kind}` });
    // repetition → escalating, not identical, reactions
    if (rep > 0.6 && (kind === "tap" || kind === "boop")) Face.gesture(S.irritation > 0.5 ? "squint" : "side_eye_" + (Math.random() < 0.5 ? "left" : "right"));
    return { sal, irritation: S.irritation };
  }

  // ---------------- presence: is anyone actually around? ----------------
  function presenceScore() {
    let p = 0;
    if (window.Vision?.faces) p += 1;
    if (window.lastMotion && performance.now() - lastMotion.t < 1000 && lastMotion.frac > 0.01) p += 0.3;
    if (nowMs() - lastEngaged < 5 * 60000) p += 0.5;
    return p;
  }

  // ---------------- world model: things, places, names, confidence ----------------
  let world = { things: {}, names: {}, loops: [], routines: {} };
  async function loadWorld() { try { world = { ...world, ...JSON.parse(await readFile("world.json")) }; } catch {} }
  let wT = null; const saveWorld = () => { clearTimeout(wT); wT = setTimeout(() => writeFile("world.json", JSON.stringify(world, null, 2)).catch(() => {}), 1000); };
  const keyOf = s => String(s || "").toLowerCase().replace(/^(the|my|a|an)\s+/, "").trim();
  // Confidence fades with time unless reinforced; repeated mentions make it stick.
  function currentConf(it) {
    const days = (nowMs() - it.t) / 86400000;
    const halfLife = 0.5 + Math.min(it.uses || 1, 20) * 0.75;      // days
    return it.conf * Math.pow(0.5, days / halfLife);
  }
  const confWord = c => c > 0.8 ? "sure" : c > 0.55 ? "fairly sure" : c > 0.3 ? "think" : "vaguely remember";
  function noteWhere(thing, where, how = "saw") {
    const k = keyOf(thing); const old = world.things[k];
    const src = { saw: "SAW", told: "TOLD", guess: "INFERRED", heard: "HEARD" }[how] || "SAW";
    world.things[k] = { where, source: src, conf: src === "SAW" ? 0.92 : src === "TOLD" ? 0.85 : 0.55, t: nowMs(), uses: (old?.uses || 0) + 1, seen: (old?.seen || 0) + (src === "SAW" ? 1 : 0) };
    event("object_placed", `${thing}: ${where}`, { source: src, salience: 0.5 });
    saveWorld();
    return `Noted: ${thing} → ${where} (${src.toLowerCase()}).`;
  }
  // Finding a memory, from most to least certain:
  //  1. the exact thing, or a nickname he taught her for it;  2. the same words in a different form ("screw driver", "drivers");
  //  3. by MEANING, with the on-phone text embedder ("the little purple controller" finds "remote PCB");
  //  4. anything in the recent event stream that mentions it.
  const stem = w => w.replace(/(ing|ers|er|es|s|ed)$/, "");
  const toks = s => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(w => w.length > 2 && !/^(the|and|for|with|that|this|your|you|was|are|its|about|away|left|right)$/.test(w)).map(stem));
  const cosine = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na * nb) || 1); };
  async function recall(thing) {
    let k = keyOf(thing), how = "";
    const alias = Object.entries(world.names).find(([, n]) => keyOf(n.name) === k); if (alias) k = alias[0];
    const squash = x => String(x).toLowerCase().replace(/[^a-z0-9]/g, "").replace(/(ers|er|es|s)$/, "");
    let hit = world.things[k] || Object.entries(world.things).find(([n]) => n.includes(k) || k.includes(n))?.[1];
    if (!hit && squash(k).length > 3) hit = Object.entries(world.things).find(([n]) => squash(n).includes(squash(k)) || squash(k).includes(squash(n)))?.[1];   // "screw driver" = "screwdrivers"
    if (!hit) {                                                       // 2. same words, different form
      const q = toks(k); let best = 0, bestKey = null;
      for (const [n, it] of Object.entries(world.things)) { const t = toks(n); let inter = 0; for (const w of q) if (t.has(w)) inter++; const sc = q.size ? inter / Math.max(q.size, t.size) : 0; if (sc > best) { best = sc; bestKey = n; } }
      if (best >= 0.5) { hit = world.things[bestKey]; how = ` (closest thing you know: "${bestKey}")`; }
    }
    if (!hit && window.Vision?.embedTexts) {                           // 3. by meaning
      try {
        const cands = [...Object.keys(world.things).map(n => ({ kind: "thing", n, text: `${n}${world.names[n]?.name ? " (" + world.names[n].name + ")" : ""}` })),
          ...String(typeof memory === "string" ? memory : "").split("\n").map(l => l.replace(/^[-*\s]+/, "").trim()).filter(l => l.length > 8).slice(-60).map(l => ({ kind: "note", text: l }))];
        if (cands.length) {
          const vecs = await Vision.embedTexts([String(thing), ...cands.map(c => c.text)]);
          if (vecs) {
            let best = -1, bi = -1; for (let i = 0; i < cands.length; i++) { const c = cosine(vecs[0], vecs[i + 1]); if (c > best) { best = c; bi = i; } }
            if (best > 0.55) {
              const c = cands[bi];
              if (c.kind === "note") return `Nothing stored under "${thing}", but the closest memory note by meaning (${Math.round(best * 100)}% match) is: "${c.text}". Say it only if it actually fits.`;
              hit = world.things[c.n]; how = ` (not an exact match: the closest thing you know by meaning is "${c.n}", ${Math.round(best * 100)}% match; say so)`;
            }
          }
        }
      } catch {}
    }
    if (!hit) {
      const ev = [...events].reverse().find(e => e.text.toLowerCase().includes(k));
      return ev ? `No stored location, but ${ev.t ? ago(ev.t) : ""} (${ev.source}): ${ev.text}` : `Nothing about "${thing}" in your memory. Say you don't know (or didn't see).`;
    }
    hit.uses = (hit.uses || 1) + 1; saveWorld();
    const c = currentConf(hit);
    const familiar = (hit.seen || 0) > 8 ? " (very familiar thing)" : (hit.seen || 0) > 2 ? " (seen it before)" : "";
    return `${thing}${how}: ${hit.where}. Source: ${hit.source}, ${ago(hit.t)}. Confidence ${c.toFixed(2)}: say you're ${confWord(c)}.${familiar}`;
  }
  function learnName(thing, name) {
    world.names[keyOf(thing)] = { name, t: nowMs() };
    event("user_corrected", `he calls "${thing}" "${name}"`, { source: "TOLD", salience: 0.6 });
    saveWorld(); return `From now on you call "${thing}" "${name}".`;
  }

  // ---------------- open loops / prospective memory ----------------
  // when: "next_seen" (he comes back), "internet_back", "charger", "anytime"
  function addLoop(text, when = "anytime", hours = 24, source = "her") {
    if (world.loops.some(l => l.text === text)) return "Already on your list.";
    world.loops.push({ text: String(text).slice(0, 200), when, until: nowMs() + hours * 3600000, t: nowMs(), source });
    world.loops = world.loops.slice(-12); saveWorld();
    return `Remembered for later (${when}): ${text}`;
  }
  function closeLoop(text) {
    const k = String(text).toLowerCase(), n = world.loops.length;
    world.loops = world.loops.filter(l => !l.text.toLowerCase().includes(k)); saveWorld();
    return n !== world.loops.length ? "Done, crossed off." : "No open loop matched.";
  }
  function activeLoops() { world.loops = world.loops.filter(l => l.until > nowMs()); return world.loops; }
  function triggerLoops(when) {
    const due = activeLoops().filter(l => l.when === when);
    if (!due.length || !canSpeakUp()) return;
    const l = due[0];
    lastSpontaneous = nowMs();
    speakUp(`(system: ${when === "next_seen" ? "he's back after being away" : when === "internet_back" ? "your internet is back" : when === "charger" ? "you were just put on the charger" : "now is a good moment"}. You had this unfinished business: "${l.text}". Bring it up naturally, briefly ("Oh, before I forget…"). Use close_open_loop if it's resolved.)`, "open loop: " + l.text, "loop", "idle");
    l.when = "anytime";                                               // mentioned once; stays until closed or expired
    saveWorld();
  }

  // ---------------- routines: learned expectations ----------------
  function routineSeen(name) {
    const h = new Date().getHours(), r = world.routines[name] ||= { count: 0, hours: {} };
    r.count++; r.hours[h] = (r.hours[h] || 0) + 1; r.last = nowMs(); saveWorld();
    return r;
  }
  const routineUsual = (name, hour = new Date().getHours()) => (world.routines[name]?.hours?.[hour] || 0) + (world.routines[name]?.hours?.[(hour + 23) % 24] || 0) >= 2;
  let sleepMode = false;
  function enterSleep(reason) {
    if (sleepMode) return; sleepMode = true; setMoodQuiet("sleepy"); Face.gesture("reboot"); moodHoldUntil = nowMs() + 3600000;
    event("routine", "bedtime: " + reason, { source: "INFERRED", salience: 0.4 });
  }
  function wake(reason) {
    if (!sleepMode) return; sleepMode = false; moodHoldUntil = 0; Face.gesture("startle"); nudge({ arousal: 0.3, boredom: -0.5 });
    event("routine", "woke up: " + reason, { source: "FELT", salience: 0.5 });
  }

  // ---------------- conversation hooks ----------------
  let backchannelAt = 0;
  function onUserSpeaking(partial) {                               // while he's still talking: tiny acknowledgements
    lastEngaged = nowMs(); if (sleepMode) wake("he talked");
    try { window.Behaviors?.onUserSpeaking(partial); } catch {}
    if (performance.now() - backchannelAt < 2600 + Math.random() * 1800 || partial.length < 12) return;
    backchannelAt = performance.now();
    const r = Math.random();
    if (r < 0.45) Face.gesture("nod"); else if (r < 0.7) Face.react?.("listen"); else if (r < 0.85) Face.gesture("double_blink");
  }
  function onUserSaid(text, conf) {
    lastEngaged = nowMs(); if (sleepMode) wake("he talked");
    const name = (typeof personality !== "undefined" && personality?.name || "Nessari").toLowerCase();
    if (text.toLowerCase().includes(name)) { nudge({ alertness: 0.4, arousal: 0.15 }); Face.gesture("wide"); distractUntil = 0; }
    event("he_said", text, { source: "HEARD", conf: conf || 0.9, salience: 0.6 });
  }
  function onSheSaid(text) {
    event("she_said", text, { source: "SELF", salience: 0.4 });
    if (/\?\s*$/.test(text)) lastQuestion = { text, t: nowMs() };
  }
  let lastQuestion = null, lastAction = null;
  function onAction(name, input, result) {
    if (/^(read_|list_|see_people|what_color|recall|recent_events|note_where|learn_name|add_open_loop|close_open_loop|remember|save_note|write_diary|forget_)/.test(name)) return;
    lastAction = { name, input, result: String(result).slice(0, 140), t: nowMs() };
    const failed = /^FAILED/.test(String(result));
    event(failed ? "action_failed" : "did", `${name} ${JSON.stringify(input).slice(0, 100)} → ${String(result).slice(0, 80)}`, { source: "SELF", salience: failed ? 0.6 : 0.35 });
  }

  // ---------------- what goes to the brain each message (compact) ----------------
  function context(short = false) {
    const lines = [];
    const st = Object.entries(S).filter(([k, v]) => Math.abs(v - BASELINE[k]) > 0.12).map(([k, v]) => `${k} ${v.toFixed(2)}`);
    lines.push(`Inner state (let it color your tone, don't announce it): ${st.join(", ") || "neutral"}${sleepMode ? ", in sleep mode" : ""}.`);
    if (window.Vision?.available) lines.push(`Eyes: ${Vision.faces ? Vision.describe() : "nobody in view right now"}`);
    const recent = events.filter(e => nowMs() - e.t < 25 * 60000 && e.salience >= 0.35 && e.type !== "she_said" && e.type !== "he_said").slice(short ? -5 : -14);
    if (recent.length) lines.push("Recent events (newest last, with how you know):\n" + recent.map(e => `- ${ago(e.t)} [${e.source}] ${e.type}: ${e.text}`).join("\n"));
    if (lastAction && nowMs() - lastAction.t < 20 * 60000) lines.push(`Your last action (for "do that again"): ${lastAction.name} ${JSON.stringify(lastAction.input)}${/^FAILED/.test(lastAction.result) ? " (it failed: don't repeat it the same way)" : ""}`);
    if (!short) {
      const things = Object.entries(world.things).map(([k, it]) => [k, it, currentConf(it)]).filter(([, , c]) => c > 0.2).slice(-10);
      if (things.length) lines.push("Where things are:\n" + things.map(([k, it, c]) => `- ${k}: ${it.where} (${it.source}, ${ago(it.t)}, you're ${confWord(c)})`).join("\n"));
      const names = Object.entries(world.names); if (names.length) lines.push("His names for things (use them): " + names.map(([k, v]) => `${k} = "${v.name}"`).join(", "));
      const loops = activeLoops(); if (loops.length) lines.push("Open loops (bring up only when it fits): " + loops.slice(-4).map(l => l.text).join(" | "));
      if (lastQuestion && nowMs() - lastQuestion.t < 10 * 60000) lines.push(`You asked "${lastQuestion.text}" ${ago(lastQuestion.t)}.`);
    }
    return lines.join("\n");
  }

  const RULES = `
How you think and talk:
- Say how you know things: "I saw", "I heard", "I think", "I'm not sure", "I didn't see that", "I wasn't looking". Never invent what you didn't perceive. "Can't see" (blocked/dark), "didn't see" (wasn't looking) and "saw but can't tell what it is" are different; say which.
- If what he said looks garbled or makes no sense (speech recognition mistakes happen), say what you heard and check ("Wait, 'purple refrigerator'?").
- Resolve "that", "it", "the other one", "do that again" from the recent events and your last action. If he corrects himself ("actually, never mind"), drop the first half.
- Restraint: you don't have to comment on everything. Silence is fine. Keep continuity with what you were just talking about.
- When you see or are told where something is, use note_where. When he corrects what he calls something, use learn_name and use his word from then on. Unfinished business (a promise, an unanswered question, an interrupted game) goes in add_open_loop.
- Your inner state changes slowly: an annoyance doesn't vanish because the next sentence arrived.`;

  // ---------------- daily compression: raw events → an episode summary ----------------
  async function consolidate() {
    const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    try { await readFile(`episodes/${y}.md`); return; } catch {}            // already done
    let raw = ""; try { raw = await readFile(`events/${y}.jsonl`); } catch { return; }
    const evs = raw.trim().split("\n").map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (!evs.length) return;
    const counts = {}; for (const e of evs) counts[e.type] = (counts[e.type] || 0) + 1;
    const hours = {}; for (const e of evs.filter(e => e.type === "he_said" || e.type === "touch")) { const h = new Date(e.t).getHours(); hours[h] = (hours[h] || 0) + 1; }
    const busiest = Object.entries(hours).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([h]) => `${h}:00`);
    const notable = evs.filter(e => e.salience > 0.8).slice(-8).map(e => `- ${new Date(e.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} ${e.type}: ${e.text}`);
    await writeFile(`episodes/${y}.md`, `# ${y}\nEvents: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}\nMost active around: ${busiest.join(", ") || "n/a"}\nNotable:\n${notable.join("\n")}\n`);
  }

  // ---------------- tools ----------------
  const TOOLS = [
    { name: "note_where", description: "Remember where something is (or who has it): when you SEE it placed somewhere, or he TELLS you. how: saw, told, guess.",
      input_schema: { type: "object", properties: { thing: { type: "string" }, where: { type: "string" }, how: { type: "string", enum: ["saw", "told", "guess"] } }, required: ["thing", "where"] } },
    { name: "recall", description: "Look up where something is or what you know about it, with how you know and how sure you are.",
      input_schema: { type: "object", properties: { thing: { type: "string" } }, required: ["thing"] } },
    { name: "learn_name", description: "He corrected what he calls something (\"no, I call that Frank\"). Use his name from now on.",
      input_schema: { type: "object", properties: { thing: { type: "string" }, name: { type: "string" } }, required: ["thing", "name"] } },
    { name: "add_open_loop", description: "Remember unfinished business to bring up later: when he's back (next_seen), when internet returns (internet_back), when put on the charger (charger), or whenever it fits (anytime).",
      input_schema: { type: "object", properties: { text: { type: "string" }, when: { type: "string", enum: ["next_seen", "internet_back", "charger", "anytime"] }, hours: { type: "number" } }, required: ["text"] } },
    { name: "close_open_loop", description: "Cross off a piece of unfinished business that's resolved.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "recent_events", description: "Look further back through what you've perceived (today), when he asks what happened, what changed, or how many times something happened.",
      input_schema: { type: "object", properties: { about: { type: "string" }, minutes: { type: "number" } } } }
  ];
  const NAMES = new Set(TOOLS.map(t => t.name));
  async function run(name, input) {
    if (name === "note_where") return noteWhere(input.thing, input.where, input.how);
    if (name === "recall") return await recall(input.thing);
    if (name === "learn_name") return learnName(input.thing, input.name);
    if (name === "add_open_loop") return addLoop(input.text, input.when, input.hours || 24, "her");
    if (name === "close_open_loop") return closeLoop(input.text);
    if (name === "recent_events") {
      const mins = clamp(+input.minutes || 120, 1, 1440), k = String(input.about || "").toLowerCase();
      const list = events.filter(e => nowMs() - e.t < mins * 60000 && (!k || e.text.toLowerCase().includes(k) || e.type.includes(k)));
      if (!list.length) return k ? `Nothing about "${k}" in the last ${mins} minutes.` : "Nothing notable.";
      return `${list.length} events:\n` + list.slice(-40).map(e => `- ${ago(e.t)} [${e.source}] ${e.type}: ${e.text}`).join("\n");
    }
  }

  // ---------------- wiring that doesn't need app.js changes ----------------
  window.addEventListener("online", () => setTimeout(() => triggerLoops("internet_back"), 6000));
  window.addEventListener("offline", () => { if (busy) addLoop("your internet dropped while you were answering him; offer to finish", "internet_back", 2, "auto"); });
  setTimeout(() => {
    if (typeof battery === "undefined" || !battery) return;
    battery.addEventListener("chargingchange", () => {
      if (!battery.charging) { wake("taken off the charger"); return; }
      const r = routineSeen("charger");
      setTimeout(() => triggerLoops("charger"), 3000);
      const h = new Date().getHours(), lateish = h >= 21 || h < 5;
      // learned: charger at this time of night usually means bedtime
      if (lateish && (routineUsual("charger", h) || (typeof light !== "undefined" && light != null && light < 5))) enterSleep("charger at night");
    });
  }, 3500);
  window.Vision?.on?.("arrive", () => { wake("someone arrived"); setTimeout(() => triggerLoops("next_seen"), 2500); });
  setTimeout(() => {                                                // Vision loads as a module, a little later
    window.Vision?.on?.("arrive", () => { wake("someone arrived"); setTimeout(() => triggerLoops("next_seen"), 2500); });
    window.Vision?.on?.("left", () => {
      Face.gesture("scan_room");                                    // search before giving up
      if (lastQuestion && nowMs() - lastQuestion.t < 60000) addLoop(`you asked "${lastQuestion.text}" and he walked off before answering`, "next_seen", 6, "auto");
    });
  }, 6000);
  setTimeout(() => consolidate().catch(() => {}), 20000);

  window.Mind = {
    S, perceive, touch, event, moodImpulse, onUserSpeaking, onUserSaid, onSheSaid, onAction, context, RULES,
    distracted, glance, presenceScore, loadWorld, activeLoops, triggerLoops, addLoop, isSleeping: () => sleepMode, wake,
    tools: TOOLS, handles: n => NAMES.has(n), run, events, world: () => world
  };
})();
