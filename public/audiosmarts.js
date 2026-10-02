// What her ears can work out beyond "loud" and "quiet", all on the phone:
//  - Pitch: which note you're singing, humming, whistling or playing (YIN pitch detection).
//  - Melodies: listens to a tune you hum and plays it back on her synth.
//  - Beat: finds the tempo of music in the room so she can dance ON the beat instead of just near it.
// The microphone comes from her "ears" in tricks.js, which hand every block of sound to AudioSmarts.onAudio().
(() => {
  "use strict";
  const now = () => performance.now();
  const A = window.AudioSmarts = { pitch: null, beat: null, track: [], enabled: true };
  const NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const midiOf = f => 69 + 12 * Math.log2(f / 440);
  const nameOf = m => NOTE[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);
  A.noteName = nameOf; A.midiOf = midiOf;

  // ---------------- pitch (YIN) ----------------
  // Returns { hz, clarity } for one window of sound, or null when there's no clear single pitch.
  function yin(buf, rate, fMin = 75, fMax = 1400) {
    const n = buf.length, maxLag = Math.min(Math.floor(rate / fMin), (n >> 1) - 1), minLag = Math.max(2, Math.floor(rate / fMax));
    const w = n - maxLag, d = new Float32Array(maxLag + 1);
    for (let tau = 1; tau <= maxLag; tau++) { let s = 0; for (let i = 0; i < w; i++) { const x = buf[i] - buf[i + tau]; s += x * x; } d[tau] = s; }
    let run = 0; const cm = new Float32Array(maxLag + 1); cm[0] = 1;
    for (let tau = 1; tau <= maxLag; tau++) { run += d[tau]; cm[tau] = run ? d[tau] * tau / run : 1; }
    let tau = -1;
    for (let t = minLag; t <= maxLag; t++) if (cm[t] < 0.15) { while (t + 1 <= maxLag && cm[t + 1] < cm[t]) t++; tau = t; break; }   // first clear dip
    if (tau < 0) return null;
    const a = cm[tau - 1] ?? cm[tau], b = cm[tau], c = cm[tau + 1] ?? cm[tau], den = a - 2 * b + c;
    const better = den ? tau + (a - c) / (2 * den) : tau;                                           // a finer estimate between samples
    return { hz: rate / better, clarity: 1 - b };
  }
  A.yin = yin;

  // ---------------- beat ----------------
  const HOP = 1024;                            // onset detail: ~21 ms at 48 kHz
  let flux = [], lastE = 0, hopBuf = new Float32Array(0), hopSec = HOP / 48000, lastBeatCalc = 0, beatLostAt = 0;
  function onsets(block, rate) {
    hopSec = HOP / rate;
    const joined = new Float32Array(hopBuf.length + block.length); joined.set(hopBuf); joined.set(block, hopBuf.length);
    let off = 0;
    for (; off + HOP <= joined.length; off += HOP) {
      let e = 0; for (let i = off; i < off + HOP; i++) e += joined[i] * joined[i];
      const le = Math.log(1e-7 + e / HOP);
      flux.push({ t: now() - (joined.length - off - HOP) / rate * 1000, v: Math.max(0, le - lastE) }); lastE = le;
    }
    hopBuf = joined.slice(off);
    const keep = Math.ceil(8 / hopSec); if (flux.length > keep) flux.splice(0, flux.length - keep);
  }
  // Tempo from how the onsets repeat. Returns { bpm, conf, t0 } (t0 = when a beat lands) or null.
  function findBeat() {
    const n = flux.length; if (n < Math.ceil(4 / hopSec)) return null;
    const v = flux.map(f => f.v); const mean = v.reduce((a, b) => a + b, 0) / n; for (let i = 0; i < n; i++) v[i] -= mean;
    let zero = 0; for (const x of v) zero += x * x; if (zero < 1e-6) return null;
    const lo = Math.round(60 / 190 / hopSec), hi = Math.round(60 / 60 / hopSec);
    const acf = lag => { let s = 0; for (let i = lag; i < n; i++) s += v[i] * v[i - lag]; return s / (n - lag) * n; };
    let best = 0, bestLag = 0, bestRaw = 0;
    for (let lag = lo; lag <= hi; lag++) {
      const raw = acf(lag), bpm = 60 / (lag * hopSec), pref = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.9, 2));   // people dance to ~90-140
      if (raw * pref > best) { best = raw * pref; bestLag = lag; bestRaw = raw; }
    }
    // every other beat repeats just as well as every beat: if twice as fast fits nearly as well, that's the real tempo
    let period = bestLag;                                              // may be fractional
    const h = bestLag / 2, hr = Math.max(acf(Math.floor(h)), acf(Math.ceil(h)));
    if (h >= lo && hr > bestRaw * 0.55) { period = h; bestRaw = Math.max(hr, bestRaw); }
    if (!bestLag) return null;
    const conf = bestRaw / zero;
    let bestPhase = 0, bp = -1;                                    // where in the cycle the beats actually land
    for (let ph = 0; ph < period; ph++) { let s = 0; for (let x = n - 1 - ph; x >= 0; x -= period) s += v[Math.round(x)]; if (s > bp) { bp = s; bestPhase = ph; } }
    return { bpm: 60 / (period * hopSec), conf, t0: flux[n - 1 - bestPhase].t };
  }
  A.findBeat = findBeat;

  // ---------------- the microphone feed ----------------
  let win = new Float32Array(0);
  A.onAudio = (block, rate) => {
    if (!A.enabled) return;
    const selfNoise = (typeof talking !== "undefined" && talking) || window.Abilities?.isPlaying?.();
    // pitch: the newest 2048 samples
    const joined = new Float32Array(Math.min(4096, win.length + block.length));
    const keepOld = joined.length - block.length; if (keepOld > 0) joined.set(win.subarray(win.length - keepOld)); joined.set(block.subarray(Math.max(0, block.length - joined.length)), Math.max(0, keepOld));
    win = joined;
    if (!selfNoise && win.length >= 2048) {
      const seg = win.subarray(win.length - 2048);
      let e = 0; for (let i = 0; i < seg.length; i++) e += seg[i] * seg[i]; const rms = Math.sqrt(e / seg.length);
      const p = rms > 0.008 ? yin(seg, rate) : null;
      A.pitch = p && p.clarity > 0.8 ? { hz: p.hz, midi: midiOf(p.hz), note: nameOf(midiOf(p.hz)), clarity: p.clarity, rms, t: now() } : null;
      A.track.push({ t: now(), midi: A.pitch ? A.pitch.midi : null, rms }); if (A.track.length > 400) A.track.shift();
    } else A.pitch = null;
    // beat: only worth the effort while there's music about, and never from her own sound
    if (selfNoise) { flux = []; return; }
    onsets(block, rate);
    if (now() - lastBeatCalc > 1000 && (window.Power?.slow || 1) === 1) {
      lastBeatCalc = now();
      const b = A.wantBeat?.() === false ? null : findBeat();
      if (b && b.conf > 0.3) { A.beat = b; beatLostAt = 0; window.Face?.prim?.beat(b.bpm, b.t0); }
      else if (A.beat) { if (!beatLostAt) beatLostAt = now(); else if (now() - beatLostAt > 4000) { A.beat = null; window.Face?.prim?.beat(null); } }
    }
  };
  // she pulses to the beat only while music is actually being heard (vision.js's sound recognizer says so)
  A.wantBeat = () => !window.Vision?.hearing || (window.Vision.sounds || []).some(n => /music|instrument|guitar|piano|drum|singing/i.test(n));
  setInterval(() => {                                              // a small kick of the mouth and body on every beat
    const b = A.beat; if (!b || !window.Face) return;
    const period = 60000 / b.bpm, since = (now() - b.t0) % period;
    if (since < 60 && (typeof settings === "undefined" || settings.react !== false)) Face.kick();
  }, 50);

  // ---------------- where did that sound come from? (needs two real microphones) ----------------
  // Phones have a microphone at each end. A sound nearer the top reaches the top microphone a fraction of a
  // millisecond sooner. GCC-PHAT finds that tiny delay. With the phone upright that tells "above" from "below";
  // lying on its side it tells left from right. If Chrome only hands over one microphone (both channels the same),
  // this quietly reports that direction isn't available.
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = 2 * Math.PI / len * (inverse ? -1 : 1), wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) { let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2, xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
    }
  }
  // Delay of channel b relative to channel a, in samples (positive = the sound reached a first). null if unclear.
  function gccPhat(a, b, maxLag) {
    const n = 1 << Math.ceil(Math.log2(a.length)), ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
    for (let i = 0; i < a.length; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (a.length - 1)); ar[i] = a[i] * w; br[i] = b[i] * w; }
    fft(ar, ai); fft(br, bi);
    for (let k = 0; k < n; k++) { const r = ar[k] * br[k] + ai[k] * bi[k], im = ai[k] * br[k] - ar[k] * bi[k], mag = Math.hypot(r, im) || 1e-12; ar[k] = r / mag; ai[k] = im / mag; }   // keep only the timing, not the loudness
    fft(ar, ai, true);
    let best = -Infinity, lag = 0, sum = 0, cnt = 0;
    for (let l = -maxLag; l <= maxLag; l++) { const v = ar[(l + n) % n]; sum += Math.abs(v); cnt++; if (v > best) { best = v; lag = l; } }
    const sharp = best / (sum / cnt || 1e-9);
    return sharp > 2.2 ? { lag: -lag, sharp } : null;
  }
  A.gccPhat = gccPhat;
  A.stereo = { ok: null, checks: 0, same: 0, last: null };          // ok: true = two real microphones, false = only one
  let prevRms = 0;
  A.onStereo = (L, R, rate) => {
    if (!A.enabled || A.stereo.ok === false) return;
    let e = 0, diff = 0; for (let i = 0; i < L.length; i += 4) { e += L[i] * L[i]; const d = L[i] - R[i]; diff += d * d; }
    const rms = Math.sqrt(e / (L.length / 4));
    if (rms > 0.01 && A.stereo.checks < 40) {                       // are the two channels actually different microphones?
      A.stereo.checks++; if (diff < e * 0.001) A.stereo.same++;
      if (A.stereo.checks === 40) A.stereo.ok = A.stereo.same < 30;
    }
    const onset = rms > 0.03 && rms > prevRms * 1.8; prevRms = prevRms * 0.7 + rms * 0.3;
    if (!onset || A.stereo.ok !== true || (typeof talking !== "undefined" && talking) || window.Abilities?.isPlaying?.()) return;
    const maxLag = Math.ceil(0.17 / 343 * rate);                    // the microphones are at most ~17 cm apart
    const g = gccPhat(L, R, maxLag); if (!g) return;
    const top = (typeof settings !== "undefined" && settings.micTopFirst === false ? -1 : 1) * g.lag / maxLag;   // +1 = from the top end of the phone, -1 = from the bottom
    if (Math.abs(top) < 0.25) return;                                // roughly side-on: no clear direction along the phone
    A.stereo.last = { top: Math.max(-1, Math.min(1, top)), t: now(), rms };
    A.onDirection?.(A.stereo.last);
  };
  A.onDirection = d => {                                             // eyes and ears go toward it
    const P = window.Face?.prim; if (!P) return;
    P.ears(d.top > 0 ? 1 : -0.6, d.top > 0 ? 1 : -0.6, 1400); P.earTwitch();
    if (window.Mind?.glance) Mind.glance(0, -d.top * 0.9, 900, d.top > 0 ? "a sound from above her" : "a sound from below her");
    window.Mind?.event("sound_direction", `a sound came from ${d.top > 0 ? "the top end of the phone (above you, if you're upright)" : "the bottom end of the phone (below you, if you're upright)"}`, { source: "HEARD", conf: 0.6, salience: 0.25 });
  };
  A.directionStatus = () => A.stereo.ok === true ? "two microphones: she can tell which end of the phone a sound came from" : A.stereo.ok === false ? "only one microphone is available to her, so no sound direction" : "not known yet (needs some sound first)";

  // ---------------- tools ----------------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function needEars() { return (await window.Tricks?.earsStart?.(true)) ? null : "FAILED: your ears (microphone) aren't available right now."; }

  // What note is he making? Listens for up to `seconds`, returns the steadiest note.
  A.listenPitch = async (seconds = 3) => {
    const err = await needEars(); if (err) return err;
    const t0 = now(), seen = [];
    while (now() - t0 < seconds * 1000) { if (A.pitch) seen.push(A.pitch.midi); await sleep(60); if (seen.length >= 12 && now() - t0 > 1200) break; }
    if (seen.length < 4) return "No clear note heard. He should hold one steady sound (sing 'aaah', hum, whistle or play a note) near you.";
    seen.sort((a, b) => a - b); const med = seen[seen.length >> 1], cents = Math.round((med - Math.round(med)) * 100);
    const hz = 440 * Math.pow(2, (med - 69) / 12);
    return `He's holding ${nameOf(med)} (${hz.toFixed(0)} Hz), ${Math.abs(cents) < 12 ? "right in tune" : `${Math.abs(cents)} cents ${cents > 0 ? "sharp" : "flat"}`}.`;
  };

  // Turn a stretch of the pitch track into notes: [{ midi|null, ms }]
  function notesFrom(track) {
    const out = []; let cur = null;
    const close = () => { if (cur && cur.ms >= 90) out.push({ midi: cur.midi == null ? null : Math.round(cur.sum / cur.n), ms: cur.ms }); cur = null; };
    for (let i = 1; i < track.length; i++) {
      const f = track[i], dt = Math.min(200, f.t - track[i - 1].t);
      const same = cur && ((f.midi == null) === (cur.midi == null)) && (f.midi == null || Math.abs(f.midi - cur.sum / cur.n) < 0.8);
      if (same) { cur.ms += dt; if (f.midi != null) { cur.sum += f.midi; cur.n++; } }
      else { close(); cur = { midi: f.midi, sum: f.midi || 0, n: f.midi == null ? 0 : 1, ms: dt }; }
    }
    close();
    while (out.length && out[0].midi == null) out.shift();
    while (out.length && out[out.length - 1].midi == null) out.pop();
    return out.filter(n => n.midi != null || n.ms > 160);              // tiny gaps between notes aren't rests
  }
  A.notesFrom = notesFrom;
  function toNotation(notes, tempo = 120) {
    const beat = 60000 / tempo, lens = [[16, 0.25], [8, 0.5], [4, 1], [2, 2], [1, 4]];
    const med = notes.filter(n => n.midi != null).map(n => n.midi).sort((a, b) => a - b); const shift = med.length && med[med.length >> 1] < 57 ? 12 : 0;   // low hums up an octave: a phone speaker can't play them
    return notes.slice(0, 48).map(n => {
      const beats = n.ms / beat; let best = lens[0]; for (const l of lens) if (Math.abs(Math.log(beats / l[1])) < Math.abs(Math.log(beats / best[1]))) best = l;
      return (n.midi == null ? "R" : nameOf(n.midi + shift)) + "/" + best[0];
    }).join(" ");
  }
  A.toNotation = toNotation;

  // Listen to him hum/sing/whistle a tune, then play it back.
  A.humBack = async (seconds = 6, instrument = "flute") => {
    const err = await needEars(); if (err) return err;
    seconds = Math.max(2, Math.min(15, seconds || 6));
    window.Face?.setState("listening", true); window.Abilities?.sfx("beep"); await sleep(350);
    const start = now(); let lastVoiced = 0;
    while (now() - start < seconds * 1000) { if (A.pitch) lastVoiced = now(); if (lastVoiced && now() - lastVoiced > 1500 && now() - start > 2500) break; await sleep(80); }
    window.Face?.setState("listening", false);
    const notes = notesFrom(A.track.filter(f => f.t >= start));
    if (notes.filter(n => n.midi != null).length < 2) return "You didn't catch a tune. He should hum or whistle clearly, a few notes, close to you.";
    const notation = toNotation(notes);
    await window.Abilities.play({ notes: notation, tempo: 120, instrument, drums: "", onNote: () => window.Face?.kick() });
    window.Tricks?.bump?.("hum_backs");
    return `You listened and played his tune back: ${notation}`;
  };

  A.status = () => A.pitch ? `hearing a ${A.pitch.note}` : A.beat ? `music at about ${Math.round(A.beat.bpm)} beats per minute` : "no clear note or beat";
})();
