// Nessari's performing abilities: synthesizer + songs, sound effects, vibration patterns, Morse code.
// Everything is generated live on the phone (no files, no internet).
// Exposed as window.Abilities for app.js.
(() => {
  "use strict";
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- audio engine ----------
  let ac = null, master = null, noiseBuf = null, unlocked = false, token = 0, soundUntil = 0, muted = false;
  const VOL = () => muted ? 0 : 0.55;
  function audio() {
    if (!ac) {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      const comp = ac.createDynamicsCompressor();
      master = ac.createGain(); master.gain.value = VOL();
      master.connect(comp); comp.connect(ac.destination);
      noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ac.state === "suspended") ac.resume().catch(() => {});
    return ac;
  }
  // Android only allows sound and vibration after the first touch on the page.
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    try { audio(); const b = ac.createBuffer(1, 1, 22050), s = ac.createBufferSource(); s.buffer = b; s.connect(ac.destination); s.start(); } catch {}
    try { speechSynthesis.speak(new SpeechSynthesisUtterance(" ")); } catch {}
    window.dispatchEvent(new Event("abilities-unlocked"));
  }
  for (const ev of ["pointerdown", "keydown", "touchstart"]) window.addEventListener(ev, unlock, { capture: true, passive: true });

  function env(g, t0, a, peak, dur, rel = 0.05) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + a);
    g.gain.setValueAtTime(peak, t0 + Math.max(a, dur - rel));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + rel);
  }
  function osc(type, freq, t0, dur, peak = 0.3, dest = master) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    env(g, t0, 0.008, peak, dur); o.connect(g); g.connect(dest);
    o.start(t0); o.stop(t0 + dur + 0.1);
    return o;
  }
  function noise(t0, dur, peak = 0.3, filterType = "highpass", freq = 1000) {
    const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = noiseBuf; s.loop = true; f.type = filterType; f.frequency.value = freq;
    env(g, t0, 0.003, peak, dur, 0.02); s.connect(f); f.connect(g); g.connect(master);
    s.start(t0); s.stop(t0 + dur + 0.05);
    return { s, f, g };
  }

  // ---------- instruments ----------
  const INSTRUMENTS = {
    chip(f, t0, d, v) { osc("square", f, t0, d * 0.9, 0.12 * v); },
    saw(f, t0, d, v) {
      const lp = ac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2400; lp.connect(master);
      osc("sawtooth", f, t0, d * 0.95, 0.14 * v, lp); osc("sawtooth", f * 1.005, t0, d * 0.95, 0.1 * v, lp);
    },
    flute(f, t0, d, v) {
      const o = osc("sine", f, t0, d * 0.95, 0.3 * v);
      const lfo = ac.createOscillator(), lg = ac.createGain(); lfo.frequency.value = 5.5; lg.gain.value = f * 0.008;
      lfo.connect(lg); lg.connect(o.frequency); lfo.start(t0); lfo.stop(t0 + d + 0.1);
    },
    bell(f, t0, d, v) {
      const len = Math.max(d, 1.2);
      for (const [m, p] of [[1, 0.3], [2.76, 0.12], [5.4, 0.05]]) {
        const o = ac.createOscillator(), g = ac.createGain(); o.type = "sine"; o.frequency.value = f * m;
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(p * v, t0 + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + len); o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + len + 0.05);
      }
    },
    organ(f, t0, d, v) { for (const [m, p] of [[1, 0.16], [2, 0.08], [3, 0.05], [4, 0.03]]) osc("sine", f * m, t0, d * 0.95, p * v); },
    bass(f, t0, d, v) { osc("triangle", f / 2, t0, d * 0.9, 0.35 * v); osc("square", f / 2, t0, Math.min(d, 0.08), 0.05 * v); }
  };
  const DRUMS = {
    K(t0) { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.setValueAtTime(150, t0); o.frequency.exponentialRampToValueAtTime(40, t0 + 0.12);
      g.gain.setValueAtTime(0.9, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.25); o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + 0.3); },
    S(t0) { noise(t0, 0.15, 0.35, "highpass", 1200); osc("triangle", 190, t0, 0.08, 0.2); },
    H(t0) { noise(t0, 0.04, 0.15, "highpass", 7500); },
    C(t0) { noise(t0, 1.0, 0.18, "highpass", 5000); }
  };

  // ---------- notes: "C4/4 E4/8. R/8 C4+E4+G4/2" ----------
  const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function midiOf(n) {
    const m = n.match(/^([A-Ga-g])([#b]?)(-?\d)?$/); if (!m) return null;
    return 12 * ((m[3] != null ? +m[3] : 4) + 1) + SEMI[m[1].toUpperCase()] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
  }
  const freqOf = midi => 440 * Math.pow(2, (midi - 69) / 12);
  function parseNotes(str) {
    const out = [];
    for (const tok of String(str || "").split(/[\s,|]+/).filter(Boolean)) {
      const m = tok.match(/^([^/.]+)(?:\/(\d+))?(\.)?$/); if (!m) continue;
      const dur = m[2] ? +m[2] : 4, beats = (4 / dur) * (m[3] ? 1.5 : 1);
      if (/^[Rr-]$/.test(m[1])) { out.push({ midis: [], beats }); continue; }
      const midis = m[1].split("+").map(midiOf).filter(x => x != null);
      if (midis.length) out.push({ midis, beats });
    }
    return out;
  }

  // ---------- song book (public domain tunes + her own) ----------
  const SONGS = {
    twinkle: { title: "Twinkle Twinkle Little Star", tempo: 110, inst: "bell", drums: "K.H.S.H.",
      notes: "C4 C4 G4 G4 A4 A4 G4/2 F4 F4 E4 E4 D4 D4 C4/2 G4 G4 F4 F4 E4 E4 D4/2 G4 G4 F4 F4 E4 E4 D4/2 C4 C4 G4 G4 A4 A4 G4/2 F4 F4 E4 E4 D4 D4 C4/2" },
    ode_to_joy: { title: "Ode to Joy", tempo: 125, inst: "organ", drums: "K.H.S.H.",
      notes: "E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 E4. D4/8 D4/2 E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 D4. C4/8 C4/2" },
    happy_birthday: { title: "Happy Birthday", tempo: 100, inst: "chip",
      notes: "G4/8. G4/16 A4 G4 C5 B4/2 G4/8. G4/16 A4 G4 D5 C5/2 G4/8. G4/16 G5 E5 C5 B4 A4 F5/8. F5/16 E5 C5 D5 C5/2" },
    entertainer: { title: "The Entertainer", tempo: 85, inst: "chip", drums: "K.H.S.H.",
      notes: "D4/16 D#4/16 E4/16 C5/8 E4/16 C5/8 E4/16 C5/4. R/16 C5/16 D5/16 D#5/16 E5/16 C5/16 D5/16 E5/8 B4/16 D5/8 C5/2" },
    fur_elise: { title: "Für Elise", tempo: 72, inst: "bell",
      notes: "E5/16 D#5/16 E5/16 D#5/16 E5/16 B4/16 D5/16 C5/16 A4/8 R/16 C4/16 E4/16 A4/16 B4/8 R/16 E4/16 G#4/16 B4/16 C5/8 R/16 E4/16 E5/16 D#5/16 E5/16 D#5/16 E5/16 B4/16 D5/16 C5/16 A4/4" },
    jingle_bells: { title: "Jingle Bells", tempo: 150, inst: "bell", drums: "KHSHKHSH",
      notes: "E4 E4 E4/2 E4 E4 E4/2 E4 G4 C4. D4/8 E4/1 F4 F4 F4. F4/8 F4 E4 E4 E4/8 E4/8 E4 D4 D4 E4 D4/2 G4/2" },
    saints: { title: "When the Saints Go Marching In", tempo: 170, inst: "saw", drums: "KHSHKHSH",
      notes: "C4 E4 F4 G4/1 R C4 E4 F4 G4/1 R C4 E4 F4 G4/2 E4/2 C4/2 E4/2 D4/1" },
    mary_lamb: { title: "Mary Had a Little Lamb", tempo: 120, inst: "flute",
      notes: "E4 D4 C4 D4 E4 E4 E4/2 D4 D4 D4/2 E4 G4 G4/2 E4 D4 C4 D4 E4 E4 E4 E4 D4 D4 E4 D4 C4/1" },
    lullaby: { title: "Brahms' Lullaby", tempo: 90, inst: "flute",
      notes: "E4/8 E4/8 G4/4. E4/8 E4/8 G4/2 E4/8 G4/8 C5/4 B4/4. A4/8 A4/4 G4/4 D4/8 E4/8 F4/4 D4/4 D4/8 E4/8 F4/2" },
    shave_and_haircut: { title: "Shave and a Haircut", tempo: 120, inst: "chip", notes: "C5 G4/8 G4/8 A4 G4 R B4 C5" },
    charge: { title: "Charge!", tempo: 140, inst: "saw", notes: "G4/8 C5/8 E5/8 G5/4. E5/8 G5/1" },
    taps: { title: "Taps", tempo: 60, inst: "flute", notes: "G4/8. G4/16 C5/1 G4/8. C5/16 E5/1 G4/8. C5/16 E5/4 G4/8. C5/16 E5/4 G4/8. C5/16 E5/1" },
    // her own
    boot_up: { title: "Boot-up jingle (original)", tempo: 160, inst: "chip", notes: "C4/16 E4/16 G4/16 C5/16 E5/16 G5/16 C6/4" },
    victory: { title: "Tiny victory (original)", tempo: 150, inst: "chip", drums: "K.......", notes: "C5/8 E5/8 G5/8 C6/4 G5/8 C6/2" },
    robot_blues: { title: "Robot blues (original)", tempo: 95, inst: "saw", drums: "K.HSK.HS",
      notes: "C4/8 Eb4/8 F4/8 F#4/8 G4/4 Bb4/8 G4/8 C4/8 Eb4/8 F4/8 F#4/8 G4/2 F4/8 Eb4/8 C4/2" },
    no_arms: { title: "I have no arms (original)", tempo: 70, inst: "organ",
      notes: "A3/4 C4/4 E4/2 D4/4 C4/4 B3/2 A3/4 C4/4 E4/4 A4/4 G#4/1" },
    sad_robot: { title: "Sad robot (original)", tempo: 90, inst: "saw", notes: "G3/4 F#3/4 F3/4 E3/1" }
  };

  // ---------- vibration ----------
  const canVibrate = () => typeof navigator.vibrate === "function";
  const rep = (arr, n) => Array.from({ length: n }, () => arr).flat();
  const VIBES = {
    heartbeat: rep([70, 110, 130, 650], 4),
    purr: rep([18, 22], 60),
    sos: [100, 100, 100, 100, 100, 300, 300, 100, 300, 100, 300, 300, 100, 100, 100, 100, 100],
    drumroll: [...rep([30, 60], 8), ...rep([25, 35], 12), 400],
    buzz: [900],
    tickle: Array.from({ length: 24 }, () => Math.round(15 + Math.random() * 45)),
    earthquake: [1600, 100, 900],
    knock: [90, 210, 60, 60, 60, 120, 90, 210, 90, 560, 90, 210, 90],
    nervous: rep([40, 40, 40, 300], 4),
    laugh: rep([60, 70], 10),
    alarm: rep([400, 200], 4)
  };
  function vibrate(p) {
    if (!canVibrate()) return "Vibration isn't available.";
    const pattern = Array.isArray(p) ? p.map(n => clamp(+n || 0, 0, 3000)).slice(0, 200) : VIBES[p];
    if (!pattern) return `No vibration called "${p}". Try: ${Object.keys(VIBES).join(", ")}.`;
    const ok = navigator.vibrate(pattern);
    return ok ? "Bzzt." : "The phone refused to vibrate (he needs to tap the screen once first).";
  }

  // ---------- playing music ----------
  // opts: { song, notes, tempo, instrument, drums, vibrate, onNote(midi, beatMs), body(midi, ms) }
  async function play(opts = {}) {
    const preset = SONGS[opts.song] || null;
    if (opts.song && !preset && !opts.notes) return { ok: false, text: `No song called "${opts.song}". Songs: ${Object.keys(SONGS).join(", ")}. Or write your own notes.` };
    const notes = parseNotes(opts.notes || preset?.notes);
    if (!notes.length) return { ok: false, text: "Couldn't read any notes. Format: C4/4 E4/8 G4/2 R/4 (note+octave/length, R = rest, C4+E4 = chord)." };
    const tempo = clamp(+opts.tempo || preset?.tempo || 120, 40, 260);
    const inst = INSTRUMENTS[opts.instrument] ? opts.instrument : (preset?.inst || "chip");
    const drums = String(opts.drums ?? preset?.drums ?? "").toUpperCase();
    const beat = 60 / tempo;
    audio();
    if (ac.state !== "running") await ac.resume().catch(() => {});
    if (ac.state !== "running") return { ok: false, text: "My speaker is locked until he taps the screen once." };

    const my = ++token;
    const t0 = ac.currentTime + 0.08;
    let t = t0, total = 0;
    const vib = [];
    const events = [];
    for (const n of notes) {
      const d = n.beats * beat;
      if (total + d > 75) break;                                     // a minute and a bit, max
      for (const midi of n.midis) INSTRUMENTS[inst](freqOf(midi), t, d, n.midis.length > 1 ? 0.7 : 1);
      events.push({ at: (t - t0) * 1000, midi: n.midis[0], ms: d * 1000 });
      const on = n.midis.length ? Math.min(d * 1000 * 0.55, 140) : 0;
      vib.push(Math.round(on), Math.round(d * 1000 - on));
      t += d; total += d;
    }
    if (drums) {
      const step = beat / 2; let i = 0;
      for (let dt = 0; dt < total - 0.01; dt += step, i++) {
        const c = drums[i % drums.length];
        for (const k of c === "X" ? "KH" : c) if (DRUMS[k]) DRUMS[k](t0 + dt);
      }
      DRUMS.C(t0 + total);
    }
    if (opts.vibrate !== false && canVibrate()) {
      // vibrate() starts with "on", so lead with a 1ms buzz when the first note is a rest
      navigator.vibrate(vib[0] === 0 ? [1, ...vib.slice(1)] : vib);
    }
    for (const e of events) setTimeout(() => { if (my === token) { opts.onNote?.(e.midi, e.ms); if (e.midi != null) opts.body?.(e.midi, e.ms); } }, e.at + 80);
    soundUntil = Date.now() + total * 1000 + 600;
    await sleep(total * 1000 + 150);
    return { ok: my === token, text: my === token ? `Played ${preset ? preset.title : "your tune"} (${total.toFixed(1)}s).` : "Stopped." };
  }

  // ---------- sound effects ----------
  const SFX = {
    beep() { osc("sine", 880, ac.currentTime, 0.12, 0.35); return 0.2; },
    boop() { const o = osc("sine", 440, ac.currentTime, 0.18, 0.35); o.frequency.exponentialRampToValueAtTime(300, ac.currentTime + 0.18); return 0.25; },
    chirp() { let t = ac.currentTime; for (let i = 0; i < 9; i++) { const d = 0.04 + Math.random() * 0.08, o = osc("sine", 600 + Math.random() * 2400, t, d, 0.22);
      o.frequency.exponentialRampToValueAtTime(400 + Math.random() * 3000, t + d); t += d + 0.02; } return t - ac.currentTime; },
    laser() { const t = ac.currentTime, o = osc("square", 1600, t, 0.32, 0.18); o.frequency.exponentialRampToValueAtTime(140, t + 0.32); return 0.4; },
    powerup() { const t = ac.currentTime; [262, 330, 392, 523, 659, 784, 1047].forEach((f, i) => osc("square", f, t + i * 0.06, 0.08, 0.12)); return 0.6; },
    powerdown() { const t = ac.currentTime, o = osc("sawtooth", 900, t, 1.0, 0.18); o.frequency.exponentialRampToValueAtTime(60, t + 1); return 1.1; },
    alarm() { const t = ac.currentTime; for (let i = 0; i < 6; i++) osc("square", i % 2 ? 620 : 920, t + i * 0.22, 0.2, 0.12); return 1.4; },
    drumroll() { const t = ac.currentTime; let dt = 0, gap = 0.11; while (dt < 1.6) { DRUMS.S(t + dt); dt += gap; gap = Math.max(0.035, gap * 0.93); } DRUMS.K(t + 1.7); DRUMS.C(t + 1.7); return 2.6; },
    rimshot() { const t = ac.currentTime; DRUMS.S(t); DRUMS.K(t + 0.18); DRUMS.S(t + 0.42); DRUMS.C(t + 0.42); return 1.3; },
    sad_trombone() { play({ song: "sad_robot", vibrate: false }); return 3; },
    airhorn() { const t = ac.currentTime; [[0, 0.35], [0.45, 0.2], [0.7, 1.0]].forEach(([s, d]) => { for (const f of [466, 470, 233]) osc("sawtooth", f, t + s, d, 0.09); }); return 1.8; },
    fart() { const t = ac.currentTime, lp = ac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 380; lp.connect(master);
      const o = osc("sawtooth", 95, t, 0.7, 0.5, lp); for (let i = 0; i < 14; i++) o.frequency.setValueAtTime(70 + Math.random() * 60, t + i * 0.05);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.7); return 0.9; },
    boing() { const t = ac.currentTime, o = osc("sine", 180, t, 0.6, 0.35); o.frequency.exponentialRampToValueAtTime(620, t + 0.12); o.frequency.exponentialRampToValueAtTime(160, t + 0.6);
      const l = ac.createOscillator(), lg = ac.createGain(); l.frequency.value = 18; lg.gain.value = 40; l.connect(lg); lg.connect(o.frequency); l.start(t); l.stop(t + 0.7); return 0.7; },
    coin() { const t = ac.currentTime; osc("square", 988, t, 0.08, 0.13); osc("square", 1319, t + 0.08, 0.35, 0.13); return 0.5; },
    explosion() { const t = ac.currentTime, n = noise(t, 1.6, 0.6, "lowpass", 1200); n.f.frequency.exponentialRampToValueAtTime(80, t + 1.6); DRUMS.K(t); return 1.8; },
    applause() { const t = ac.currentTime; for (let i = 0; i < 120; i++) noise(t + Math.random() * 2.2, 0.02 + Math.random() * 0.03, 0.06 + Math.random() * 0.08, "bandpass", 1500 + Math.random() * 2500); return 2.5; },
    heartbeat() { const t = ac.currentTime; for (let i = 0; i < 3; i++) { DRUMS.K(t + i * 0.9); DRUMS.K(t + i * 0.9 + 0.22); } vibrate("heartbeat"); return 2.8; },
    glitch_scream() { const t = ac.currentTime; for (let i = 0; i < 34; i++) osc(Math.random() < 0.5 ? "square" : "sawtooth", 100 + Math.random() * 2000, t + i * 0.03, 0.03, 0.1); return 1.1; },
    tada() { const t = ac.currentTime; ["C5", "E5", "G5", "C6"].forEach((n, i) => INSTRUMENTS.bell(freqOf(midiOf(n)), t + (i < 2 ? i * 0.1 : 0.2), 1.2, 0.8)); return 1.6; },
    whistle() { const t = ac.currentTime, o = osc("sine", 1200, t, 0.9, 0.25); o.frequency.exponentialRampToValueAtTime(2400, t + 0.3); o.frequency.exponentialRampToValueAtTime(900, t + 0.9); return 1; }
  };
  async function sfx(name) {
    if (!SFX[name]) return `No sound effect called "${name}". Try: ${Object.keys(SFX).join(", ")}.`;
    audio();
    if (ac.state !== "running") await ac.resume().catch(() => {});
    if (ac.state !== "running") return "My speaker is locked until he taps the screen once.";
    const secs = SFX[name]();
    soundUntil = Math.max(soundUntil, Date.now() + secs * 1000 + 500);
    await sleep(secs * 1000);
    return `Played ${name}.`;
  }

  // ---------- Morse code ----------
  const MORSE = { a: ".-", b: "-...", c: "-.-.", d: "-..", e: ".", f: "..-.", g: "--.", h: "....", i: "..", j: ".---", k: "-.-", l: ".-..", m: "--",
    n: "-.", o: "---", p: ".--.", q: "--.-", r: ".-.", s: "...", t: "-", u: "..-", v: "...-", w: ".--", x: "-..-", y: "-.--", z: "--..",
    0: "-----", 1: ".----", 2: "..---", 3: "...--", 4: "....-", 5: ".....", 6: "-....", 7: "--...", 8: "---..", 9: "----." };
  // Returns [on, off, on, off...] in units, plus the dots/dashes text.
  function morseUnits(text) {
    const units = [], words = String(text).toLowerCase().replace(/[^a-z0-9 ]/g, "").trim().split(/\s+/).slice(0, 12);
    let code = [];
    words.forEach((w, wi) => {
      [...w].forEach((ch, ci) => {
        const m = MORSE[ch]; if (!m) return;
        code.push(m);
        [...m].forEach((s, si) => { units.push(s === "." ? 1 : 3, si < m.length - 1 ? 1 : (ci < w.length - 1 ? 3 : 0)); });
      });
      if (wi < words.length - 1) { if (units.length) units[units.length - 1] = 7; code.push("/"); }
    });
    return { units, code: code.join(" ") };
  }
  async function morse(text, { unit = 110, flash } = {}) {
    const { units, code } = morseUnits(text);
    if (!units.length) return "Nothing to send.";
    audio();
    const my = ++token, t0 = ac.currentTime + 0.05;
    let t = 0;
    for (let i = 0; i < units.length; i += 2) {
      osc("sine", 680, t0 + t / 1000, units[i] * unit / 1000, 0.25);
      const at = t, len = units[i] * unit;
      setTimeout(() => my === token && flash?.(true), at);
      setTimeout(() => my === token && flash?.(false), at + len);
      t += (units[i] + (units[i + 1] || 0)) * unit;
    }
    if (canVibrate()) navigator.vibrate(units.map(u => u * unit));
    await sleep(t + 100);
    return `Sent "${text}" in Morse: ${code}`;
  }

  function stop() {
    token++;
    if (canVibrate()) navigator.vibrate(0);
    if (ac) { master.gain.cancelScheduledValues(ac.currentTime); master.gain.setValueAtTime(0, ac.currentTime);
      setTimeout(() => master.gain.setValueAtTime(VOL(), ac.currentTime), 150); }
  }

  window.Abilities = {
    play, sfx, vibrate, morse, morseUnits, stop, unlock, parseNotes, midiOf, freqOf,
    ctx: () => audio(), out: () => { audio(); return master; },
    isPlaying: () => Date.now() < soundUntil,
    setMuted(m) { muted = !!m; if (master) master.gain.setValueAtTime(VOL(), ac.currentTime); },
    isUnlocked: () => unlocked,
    songs: SONGS, songList: Object.keys(SONGS), sfxList: Object.keys(SFX), vibeList: Object.keys(VIBES), instruments: Object.keys(INSTRUMENTS)
  };
})();
