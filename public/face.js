// Nessari's face. Drawn fresh every frame on a canvas; everything eases between moods.
// app.js talks to it through window.Face:
//   Face.setMood(name)        calm happy excited smug annoyed angry sad sleepy confused flirty
//   Face.setTalking(bool)     mouth equalizer on/off
//   Face.kick()               a spoken word just started (mouth pulse)
//   Face.setState(name, on)   listening | thinking | offline
//   Face.setLabel(text)       small HUD label (which brain is up)
//   Face.poke()               activity: wakes her if she dozed off
(() => {
  "use strict";
  const canvas = document.getElementById("face");
  const ctx = canvas.getContext("2d");
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const lerpHue = (a, b, t) => { const d = ((b - a + 540) % 360) - 180; return (a + d * t + 360) % 360; };

  // ---------- moods: every number eases toward its target ----------
  const BASE = { hue: 285, sat: 90, light: 62, open: 0.85, low: 0.1, tilt: 0, pupil: 0.42, browY: 0, browA: 0, browAsym: 0,
    mouth: 0.25, mouthW: 0.9, skew: 0, blush: 0, vents: 0, glitch: 0.02, zzz: 0, sparkle: 0, tear: 0, spin: 1, dim: 1, question: 0 };
  const MOODS = {
    calm: {},
    happy:    { hue: 320, open: 0.72, low: 0.4, pupil: 0.48, browY: -0.35, mouth: 0.85, blush: 0.8, sparkle: 0.5, spin: 1.4 },
    excited:  { hue: 45, sat: 100, open: 1, low: 0.05, pupil: 0.62, browY: -0.75, mouth: 1, sparkle: 1, spin: 3 },
    smug:     { hue: 285, open: 0.5, low: 0.32, browAsym: 0.75, mouth: 0.45, skew: 0.6, spin: 0.7 },
    annoyed:  { hue: 20, open: 0.48, low: 0.22, tilt: 0.45, browY: 0.35, browA: 0.55, mouth: -0.25, vents: 0.35, spin: 0.8 },
    angry:    { hue: 2, sat: 100, light: 58, open: 0.62, low: 0.15, tilt: 0.85, pupil: 0.28, browY: 0.6, browA: 1, mouth: -0.75, vents: 1, glitch: 0.14, spin: 2.2 },
    sad:      { hue: 215, open: 0.72, low: 0.1, tilt: -0.6, pupil: 0.52, browY: -0.1, browA: -0.85, mouth: -0.6, tear: 1, spin: 0.4, dim: 0.85 },
    sleepy:   { hue: 255, light: 55, open: 0.12, low: 0.14, pupil: 0.35, browY: 0.25, mouth: 0.02, zzz: 1, spin: 0.15, dim: 0.55 },
    confused: { hue: 170, open: 0.85, browAsym: -0.8, mouth: -0.12, skew: -0.7, glitch: 0.45, question: 1, spin: 0.5 },
    bored:    { hue: 240, sat: 45, open: 0.45, low: 0.25, tilt: -0.1, pupil: 0.4, browY: 0.2, mouth: -0.05, skew: 0.5, spin: 0.25, dim: 0.8 },
    suspicious: { hue: 95, open: 0.35, low: 0.35, tilt: 0.3, pupil: 0.3, browY: 0.35, browA: 0.4, browAsym: 0.5, mouth: -0.15, skew: -0.4, spin: 0.6 },
    flirty:   { hue: 330, open: 0.58, low: 0.32, browY: -0.3, browAsym: 0.3, mouth: 0.6, skew: 0.35, blush: 1, sparkle: 0.35, spin: 1 }
  };
  let mood = "calm";
  const cur = { ...BASE };
  const st = { talking: false, listening: 0, thinking: 0, offline: 0, label: "" };
  let amp = 0, kickV = 0, lastActivity = performance.now();
  // short reactions layered over the mood (flinch, squint...), something to look at, shake, touch ripples
  let trans = null;                         // { until, props }
  let ext = null;                           // { x, y, until } where something outside wants her to look
  let shakeUntil = 0, ripples = [];
  // show effects: disco, rainbow, dance, dizzy, heart_eyes, shades, laser_eyes, glitch_storm, sparkle, strobe
  let fx = { name: null, until: 0 }, flashOn = false;
  let eyeScale = 1, noBlinkUntil = 0, highlight = null, nightDim = 0, gestureTimers = [];
  let blend = {}, blinkRate = 1, sacc = { x: 0, y: 0, next: 0 }, idleDim = 0, idleDimNow = 0;
  const fxOn = n => fx.name === n && nowMs() < fx.until;
  // ---------- facial primitives: small building blocks that behaviors.js combines into thousands of reactions ----------
  // L / R = the eye on the screen's left / right (her right / left eye).
  const prim = {
    sqL: 1, sqR: 1, sqTL: 1, sqTR: 1, sqUntil: 0,      // per-eye openness multipliers (asymmetric squints, one eye open)
    pupil: 1, pupilT: 1, pupilUntil: 0,                // pupil size multiplier
    saccAmp: 1, saccRate: 1, wander: 1, eyeSpeed: 1,   // idle eye darts and drift
    freezeUntil: 0, snapUntil: 0,                      // gaze locked / eyes jump fast
    chew: 0, chewOn: false, chewRate: 1.6, chewPh: 0, swallowT: -1,
    tremble: 0, trembleUntil: 0, puffs: [],
    blinkMs: 130, thinkKind: "online", thinkSince: 0, ahaUntil: 0,
    yawnT: -1, yawnDur: 2.4, yawn: 0,                  // a yawn: eyes squeeze shut while the mouth opens wide
    beat: null, level: null,                           // music beat { bpm, t0 } for dancing in time; battery level 0..1 for the side meters
    tilt: 0, tiltT: 0, tiltUntil: 0,                   // whole-head tilt (curious, confused)
    lean: 0, leanT: 0, leanUntil: 0,                   // leaning in (+) or pulling back (-)
    conv: 0, convT: 0,                                 // eyes converging on something very close
    earL: 0, earR: 0, earTL: 0, earTR: 0, earUntil: 0, earTw: 0   // her two little ears: angle (-1 down .. 1 perked up) and a twitch
  };
  const nowMs = () => performance.now();

  // ---------- eyes: where they look, blinking ----------
  const look = { x: 0, y: 0, tx: 0, ty: 0, next: 0 };
  const tiltIn = { x: 0, y: 0 };
  window.addEventListener("deviceorientation", e => {
    if (e.gamma == null) return;
    tiltIn.x = clamp(e.gamma / 40, -1, 1);
    tiltIn.y = clamp(((e.beta ?? 80) - 75) / 40, -1, 1);
  });
  const blink = { L: 0, R: 0, t: 0, phase: 0, next: 2000, wink: false, double: false };

  // ---------- sizes ----------
  let W = 0, H = 0, DPR = 1, U = 100, CX = 0, CY = 0;
  let hexLayer = null, hexHue = -999, scanPattern = null;
  let traces = [], particles = [], zs = [], sparks = [], tears = [];

  function resize() {
    const r = canvas.getBoundingClientRect();
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    U = Math.min(W * 0.47, H * 0.28);
    CX = W / 2; CY = H * 0.4;
    hexHue = -999; bgHue = -999; fgLayer = null;
    buildScan(); buildTraces(); buildParticles();
  }

  function buildHex(hue) {
    hexLayer = document.createElement("canvas");
    hexLayer.width = canvas.width; hexLayer.height = canvas.height;
    const g = hexLayer.getContext("2d");
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    const s = U * 0.11, h = s * Math.sqrt(3);
    g.strokeStyle = `hsl(${hue},80%,60%)`; g.lineWidth = 0.7;
    for (let row = -1, y = 0; y < H + h; row++, y = row * h / 2) {
      for (let x = (row % 2 ? s * 1.5 : 0); x < W + s * 3; x += s * 3) {
        g.beginPath();
        for (let k = 0; k < 6; k++) { const a = TAU * k / 6; g.lineTo(x + s * Math.cos(a), y + s * Math.sin(a)); }
        g.closePath(); g.stroke();
      }
    }
    hexHue = hue;
  }
  function buildScan() {
    const p = document.createElement("canvas"); p.width = 1; p.height = 3;
    const g = p.getContext("2d"); g.fillStyle = "rgba(0,0,0,0.55)"; g.fillRect(0, 2, 1, 1);
    scanPattern = ctx.createPattern(p, "repeat");
  }
  function buildTraces() {
    traces = [];
    const n = 16;
    for (let i = 0; i < n; i++) {
      const side = i % 4;
      let x = side === 0 ? 0 : side === 1 ? W : rand(0, W);
      let y = side === 2 ? 0 : side === 3 ? H : rand(0, H);
      const pts = [[x, y]];
      for (let k = 0; k < 6; k++) {
        const horiz = (k + i) % 2 === 0;
        const dx = (CX - x), dy = (CY - y);
        const step = rand(0.12, 0.3) * U;
        if (horiz) x += Math.sign(dx || 1) * Math.min(Math.abs(dx), step);
        else y += Math.sign(dy || 1) * Math.min(Math.abs(dy), step);
        if (Math.hypot((x - CX) / 1.3, y - CY) < U * 1.35) break;
        pts.push([x, y]);
      }
      if (pts.length < 2) continue;
      let len = 0; for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      traces.push({ pts, len, p: Math.random(), speed: rand(0.08, 0.25) });
    }
  }
  function buildParticles() {
    particles = Array.from({ length: 40 }, () => ({ x: rand(0, W), y: rand(0, H), v: rand(6, 22), r: rand(0.5, 1.8), ph: rand(0, TAU) }));
  }
  window.addEventListener("resize", resize);

  // ---------- helpers ----------
  const col = (dl = 0, a = 1, dh = 0) => `hsla(${(cur.hue + dh + 360) % 360},${cur.sat}%,${clamp(cur.light + dl, 0, 100)}%,${a})`;
  // A glow is a blur pass, and blur passes are the expensive part of a frame. While her brain is working
  // (lowPower) only the big ones stay: the rims of her eyes and her voice.
  let lowPower = false, fpsCap = 30;
  function glow(on, blur = 0.08) { if (on && lowPower && blur < 0.065) on = false; ctx.shadowColor = on ? col(5, 0.9) : "transparent"; ctx.shadowBlur = on ? U * blur : 0; }
  function noise(i, t) { return Math.abs(Math.sin(t * 9 + i * 1.7) * 0.5 + Math.sin(t * 13.3 + i * 0.6) * 0.3 + Math.sin(t * 5.1 + i * 2.9) * 0.2); }
  function pointOnTrace(tr, p) {
    let d = p * tr.len;
    for (let k = 1; k < tr.pts.length; k++) {
      const [x1, y1] = tr.pts[k - 1], [x2, y2] = tr.pts[k], s = Math.hypot(x2 - x1, y2 - y1);
      if (d <= s) return [x1 + (x2 - x1) * d / s, y1 + (y2 - y1) * d / s];
      d -= s;
    }
    return tr.pts[tr.pts.length - 1];
  }

  // ---------- update ----------
  function update(dt, t) {
    const idle = (performance.now() - lastActivity) / 1000;
    const dozing = mood === "calm" && !st.talking && !st.listening && !st.thinking && idle > 180;
    const target = { ...BASE, ...MOODS[dozing ? "sleepy" : mood] };
    for (const [k, v] of Object.entries(blend)) if (k in target) target[k] += v;      // the mind's continuous state, layered on
    if (st._thinking && prim.thinkSince) {                       // waiting ages for an answer: growing impatience
      const waited = (nowMs() - prim.thinkSince) / 1000;
      if (waited > 8) { const im = Math.min(1, (waited - 8) / 20); target.browA += im * 0.6; target.tilt += im * 0.4; target.open -= im * 0.15; }
      if (prim.thinkKind === "local") target.open -= 0.12;
    }
    if (nowMs() < prim.ahaUntil) { target.open = 1; target.low = 0; target.browY -= 0.5; target.pupil = 0.55; }   // "aha": the answer arrived
    if (trans && nowMs() < trans.until) Object.assign(target, trans.props); else trans = null;
    const k = 1 - Math.exp(-dt * (trans ? 14 : 5));
    for (const key of Object.keys(BASE)) {
      cur[key] = key === "hue" ? lerpHue(cur.hue, target.hue, k) : lerp(cur[key], target[key], k);
    }
    if (fxOn("disco")) cur.hue = (t * 160) % 360;
    if (fxOn("rainbow")) cur.hue = (t * 45) % 360;
    if (fxOn("glitch_storm")) cur.glitch = 3;
    if (fxOn("sparkle")) cur.sparkle = 1.5;
    if (fxOn("dizzy")) ext = { x: Math.cos(t * 7) * 0.85, y: Math.sin(t * 7) * 0.6, until: nowMs() + 120 };
    st.listening = lerp(st.listening, st._listening ? 1 : 0, k);
    st.thinking = lerp(st.thinking, st._thinking ? 1 : 0, k);
    st.offline = lerp(st.offline, st._offline ? 1 : 0, k);

    // mouth loudness
    kickV *= Math.exp(-dt * 6);
    const ampT = st.talking ? 0.55 + 0.45 * kickV + 0.15 * Math.sin(t * 17) : 0;
    amp = lerp(amp, ampT, 1 - Math.exp(-dt * (st.talking ? 14 : 6)));

    // where the eyes look: little darts around, up and to the side while thinking, tilt adds parallax
    const frozen = nowMs() < prim.freezeUntil;
    if (t > look.next && !frozen) {
      look.tx = rand(-0.5, 0.5) * prim.wander; look.ty = rand(-0.35, 0.35) * prim.wander;
      if (Math.random() < 0.3) { look.tx = 0; look.ty = 0; }
      look.next = t + rand(0.8, 3.5) / Math.max(0.2, prim.wander < 1 ? 0.5 + prim.wander / 2 : prim.wander);
    }
    let tx = look.tx, ty = look.ty;
    const following = ext && nowMs() < ext.until;
    if (following) { tx = ext.x; ty = ext.y; }
    else if (st._thinking) {
      // a different "thinking" look for each kind of thinking
      const k = prim.thinkKind;
      if (k === "local") { tx = -0.5 + 0.08 * Math.sin(t * 1.1); ty = -0.55; }               // inward: up and to the other side
      else if (k === "visual") { tx = Math.sin(t * 2.2) * 0.8; ty = 0.1; }                   // scanning back and forth
      else if (k === "memory") { tx = -0.6 + 0.15 * Math.sin(t * 0.7); ty = 0.35; }          // down-and-aside, recalling
      else { tx = 0.55 + 0.1 * Math.sin(t * 1.3); ty = -0.6; }                                // online lookup: up and away
    }
    // while thinking she mostly keeps looking at you, glancing away up-and-aside every couple of seconds
    if (st._thinking && following && (t % 2.7) < 0.75) { tx = (Math.floor(t / 2.7) % 2 ? 0.6 : -0.6); ty = -0.55; }
    // microsaccades: tiny involuntary corrections, so a fixed gaze never looks frozen
    if (t > sacc.next && !frozen) { sacc.x = rand(-0.05, 0.05) * prim.saccAmp; sacc.y = rand(-0.04, 0.04) * prim.saccAmp; sacc.next = t + rand(0.35, 1.4) / Math.max(0.2, prim.saccRate); }
    if (!frozen) { tx += sacc.x; ty += sacc.y; } else { tx = look.x; ty = look.y; }
    if (st.talking && !following) { tx *= 0.3; ty *= 0.3; }
    if (!following) { tx += tiltIn.x * 0.6; ty += tiltIn.y * 0.4; }
    const lk = frozen ? 0 : 1 - Math.exp(-dt * (nowMs() < prim.snapUntil ? 30 : 12 * prim.eyeSpeed));

    // squints, pupils, chewing, swallowing, trembling ease toward their targets
    const pk = 1 - Math.exp(-dt * 10);
    if (nowMs() > prim.sqUntil) { prim.sqTL = 1; prim.sqTR = 1; }
    prim.sqL = lerp(prim.sqL, prim.sqTL, pk); prim.sqR = lerp(prim.sqR, prim.sqTR, pk);
    if (nowMs() > prim.pupilUntil) prim.pupilT = 1;
    prim.pupil = lerp(prim.pupil, prim.pupilT, pk);
    const chewing = prim.chewOn && !st.talking && prim.swallowT < 0;
    prim.chew = lerp(prim.chew, chewing ? 1 : 0, 1 - Math.exp(-dt * 4));
    if (chewing) prim.chewPh += dt * prim.chewRate * TAU;
    if (prim.swallowT >= 0) { prim.swallowT += dt; if (prim.swallowT > 0.8) prim.swallowT = -1; }
    if (nowMs() > prim.trembleUntil) prim.tremble = 0;
    if (nowMs() > prim.tiltUntil) prim.tiltT = 0;
    if (nowMs() > prim.leanUntil) prim.leanT = 0;
    if (nowMs() > prim.earUntil) { prim.earTL = 0; prim.earTR = 0; }
    prim.tilt = lerp(prim.tilt, prim.tiltT, 1 - Math.exp(-dt * 6)); prim.lean = lerp(prim.lean, prim.leanT, 1 - Math.exp(-dt * 8));
    prim.conv = lerp(prim.conv, prim.convT, pk); prim.earL = lerp(prim.earL, prim.earTL, 1 - Math.exp(-dt * 14)); prim.earR = lerp(prim.earR, prim.earTR, 1 - Math.exp(-dt * 14));
    prim.earTw *= Math.exp(-dt * 7);
    if (prim.yawnT >= 0) { prim.yawnT += dt; prim.yawn = Math.sin(Math.PI * Math.min(1, prim.yawnT / prim.yawnDur)) ** 0.7; if (prim.yawnT > prim.yawnDur) { prim.yawnT = -1; prim.yawn = 0; } }
    prim.puffs = prim.puffs.filter(p => (p.life += dt) < 1.4);
    look.x = lerp(look.x, clamp(tx, -1, 1), lk); look.y = lerp(look.y, clamp(ty, -1, 1), lk);

    // blinking (sometimes double, flirty sometimes winks)
    blink.t += dt * 1000;
    if (nowMs() < noBlinkUntil) { blink.phase = 0; blink.L = blink.R = 0; blink.t = 0; }
    else if (blink.phase === 0 && blink.t > blink.next) {
      blink.phase = 1; blink.t = 0;
      blink.wink = mood === "flirty" && Math.random() < 0.35;
      blink.double = !blink.wink && Math.random() < 0.2;
    }
    if (blink.phase) {
      const T = prim.blinkMs, v = blink.t < T ? blink.t / T : blink.t < 2 * T ? 1 - (blink.t - T) / T : 0;
      blink.L = blink.wink ? 0 : v; blink.R = v;
      if (blink.t >= 2 * T) {
        if (blink.double) { blink.double = false; blink.t = 0; }
        else { blink.phase = 0; blink.t = 0; prim.blinkMs = 130; blink.next = (Math.random() < 0.15 ? rand(500, 1200) : rand(2200, 6500)) * blinkRate; blink.L = blink.R = 0; }
      }
    }

    // floating bits
    for (const p of particles) {
      p.y -= p.v * dt * (0.5 + cur.spin * 0.4);
      if (p.y < -5) { p.y = H + 5; p.x = rand(0, W); }
    }
    for (const tr of traces) tr.p = (tr.p + tr.speed * dt * (0.6 + cur.spin * 0.4)) % 1;
    if (cur.zzz > 0.5 && Math.random() < dt * 0.8) zs.push({ x: 0.55 * U, y: -0.55 * U, life: 0, s: rand(0.7, 1.1) });
    zs = zs.filter(z => (z.life += dt) < 3.2);
    if (cur.sparkle > 0.2 && Math.random() < dt * 4 * cur.sparkle) sparks.push({ x: rand(-1, 1) * U, y: rand(-0.7, 0.2) * U, life: 0, s: rand(0.5, 1) });
    sparks = sparks.filter(s => (s.life += dt) < 0.9);
    if (cur.tear > 0.5 && Math.random() < dt * 0.3) tears.push({ side: Math.random() < 0.5 ? -1 : 1, life: 0 });
    tears = tears.filter(d => (d.life += dt) < 2.4);
  }

  // ---------- draw pieces ----------
  // Everything that doesn't move is painted once into two off-screen pictures and then stamped on each frame:
  // the backdrop (glow, hexagons, circuit traces) under her face, and the scan lines and dark corners over it.
  // Painting them fresh every frame was most of the cost of drawing her, and that cost comes out of her brain's share of the processor.
  let bgLayer = null, bgHue = -999, bgDim = -9, fgLayer = null;
  function buildBackdrop() {
    if (!bgLayer || bgLayer.width !== canvas.width || bgLayer.height !== canvas.height) { bgLayer = document.createElement("canvas"); bgLayer.width = canvas.width; bgLayer.height = canvas.height; }
    const g = bgLayer.getContext("2d"); g.setTransform(DPR, 0, 0, DPR, 0, 0);
    const gr = g.createRadialGradient(CX, CY, U * 0.2, CX, CY, Math.max(W, H) * 0.8);
    gr.addColorStop(0, `hsla(${cur.hue},60%,${12 * cur.dim}%,1)`); gr.addColorStop(1, "#05020a");
    g.globalAlpha = 1; g.fillStyle = gr; g.fillRect(0, 0, W, H);
    if (Math.abs(((cur.hue - hexHue + 540) % 360) - 180) > 8 || !hexLayer) buildHex(Math.round(cur.hue));
    g.globalAlpha = 0.06 * cur.dim; g.drawImage(hexLayer, 0, 0, W, H); g.globalAlpha = 1;
    g.lineWidth = 1;
    for (const tr of traces) {
      g.strokeStyle = col(-10, 0.12 * cur.dim);
      g.beginPath(); tr.pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke();
      const [ex, ey] = tr.pts[tr.pts.length - 1];
      g.fillStyle = col(0, 0.25 * cur.dim); g.beginPath(); g.arc(ex, ey, 2, 0, TAU); g.fill();
    }
    bgHue = cur.hue; bgDim = cur.dim;
  }
  function buildForeground() {
    fgLayer = document.createElement("canvas"); fgLayer.width = canvas.width; fgLayer.height = canvas.height;
    const g = fgLayer.getContext("2d"); g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.globalAlpha = 0.22; g.fillStyle = scanPattern; g.fillRect(0, 0, W, H); g.globalAlpha = 1;
    const v = g.createRadialGradient(CX, H / 2, Math.min(W, H) * 0.35, CX, H / 2, Math.max(W, H) * 0.75);
    v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,0.6)");
    g.fillStyle = v; g.fillRect(0, 0, W, H);
  }
  function background(t) {
    if (!bgLayer || bgLayer.width !== canvas.width || Math.abs(((cur.hue - bgHue + 540) % 360) - 180) > 5 || Math.abs(cur.dim - bgDim) > 0.05) buildBackdrop();
    ctx.drawImage(bgLayer, 0, 0, W, H);
    // light pulses running along the traces toward her face (a soft halo drawn as a second, fainter dot: no blur needed)
    for (const tr of traces) {
      const [px, py] = pointOnTrace(tr, tr.p);
      ctx.fillStyle = col(20, 0.16 * cur.dim); ctx.beginPath(); ctx.arc(px, py, 4.5, 0, TAU); ctx.fill();
      ctx.fillStyle = col(20, 0.7 * cur.dim); ctx.beginPath(); ctx.arc(px, py, 1.6, 0, TAU); ctx.fill();
    }
    if (!lowPower) for (const p of particles) {
      ctx.fillStyle = col(20, (0.25 + 0.25 * Math.sin(t * 2 + p.ph)) * cur.dim);
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
    }
  }

  function hud(t) {
    // big slow rings behind her head
    ctx.save(); ctx.lineWidth = 1;
    ctx.strokeStyle = col(0, 0.09 * cur.dim);
    ctx.setLineDash([U * 0.04, U * 0.07]); ctx.lineDashOffset = -t * 6 * cur.spin;
    ctx.beginPath(); ctx.arc(0, -0.02 * U, 1.32 * U, 0, TAU); ctx.stroke();
    ctx.setLineDash([2, U * 0.05]); ctx.lineDashOffset = t * 10;
    ctx.beginPath(); ctx.arc(0, -0.02 * U, 1.45 * U, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    // two arc sweeps
    ctx.strokeStyle = col(10, 0.22 * cur.dim); ctx.lineWidth = 2;
    const a = t * 0.4 * cur.spin;
    ctx.beginPath(); ctx.arc(0, -0.02 * U, 1.32 * U, a, a + 0.6); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, -0.02 * U, 1.32 * U, a + Math.PI, a + Math.PI + 0.35); ctx.stroke();

    // corner brackets
    const bx = Math.min(1.12 * U, W / 2 / 1.02 - 10), top = -0.82 * U, bot = 1.03 * U, L = 0.16 * U;
    ctx.strokeStyle = col(10, 0.45 * cur.dim); ctx.lineWidth = 2;
    for (const [x, y, sx, sy] of [[-bx, top, 1, 1], [bx, top, -1, 1], [-bx, bot, 1, -1], [bx, bot, -1, -1]]) {
      ctx.beginPath(); ctx.moveTo(x, y + sy * L); ctx.lineTo(x, y); ctx.lineTo(x + sx * L, y); ctx.stroke();
    }
    // readouts
    ctx.font = `${Math.round(U * 0.05)}px ui-monospace, monospace`;
    ctx.fillStyle = col(15, 0.5 * cur.dim);
    ctx.textAlign = "left"; ctx.fillText(`NSR-01 // ${mood.toUpperCase()}`, -bx + 6, top + U * 0.09);
    ctx.textAlign = "right";
    const hex = (Math.floor(t * 7) * 2654435761 >>> 0).toString(16).slice(-6).toUpperCase();
    ctx.fillText(`0x${hex}`, bx - 6, bot - U * 0.04);
    if (st.label) { ctx.textAlign = "right"; ctx.fillText(st.label.toUpperCase(), bx - 6, top + U * 0.09); }
    // side ears: a housing around each meter, tied to the temple and cheekbone, with sound rings when she's listening
    for (const s of [-1, 1]) {
      const xe = s * (bx - U * 0.0475), hw2 = U * 0.043, y0 = -0.35 * U, y1 = 0.285 * U;
      ctx.strokeStyle = col(10, 0.5 * cur.dim); ctx.lineWidth = U * 0.008; ctx.fillStyle = "rgba(7,3,13,0.55)";
      ctx.beginPath(); ctx.roundRect(xe - hw2, y0, hw2 * 2, y1 - y0, hw2); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = col(5, 0.25 * cur.dim); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(xe - s * hw2, -0.3 * U); ctx.lineTo(s * 0.8 * U, -0.44 * U); ctx.moveTo(xe - s * hw2, 0.22 * U); ctx.lineTo(s * 0.77 * U, 0.2 * U); ctx.stroke();
      const hear = Math.max(st.listening, prim.earTw);
      if (hear > 0.03) for (let i = 0; i < 2; i++) {
        const ph = (t * 1.3 + i * 0.5) % 1;
        ctx.strokeStyle = `hsla(190,100%,65%,${(1 - ph) * 0.6 * hear})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(xe + s * hw2, -0.03 * U, U * (0.03 + ph * 0.07), s > 0 ? -1.1 : Math.PI - 1.1, s > 0 ? 1.1 : Math.PI + 1.1); ctx.stroke();
      }
    }
    // side meters
    for (const s of [-1, 1]) {
      for (let i = 0; i < 8; i++) {
        // left meter: her battery, filled from the bottom (flickers when low). right meter: idle activity.
        const on = s < 0 && prim.level != null ? (7 - i) < Math.max(1, Math.round(prim.level * 8)) && !(prim.level < 0.15 && Math.sin(t * 6) > 0)
          : (Math.sin(t * 3 + i * 0.8 + s) + 1) / 2 > 0.45 + 0.05 * i;
        ctx.fillStyle = col(10, (on ? 0.5 : 0.12) * cur.dim);
        ctx.fillRect(s * (bx - U * 0.03) - (s > 0 ? U * 0.035 : 0), -0.3 * U + i * U * 0.07, U * 0.035, U * 0.04);
      }
    }
    ctx.restore();
  }

  function eye(side, t) {
    const ex = side * 0.42 * U, ey = -0.12 * U, r = 0.25 * U * eyeScale;
    const inner = -side;                         // direction toward the middle of the face
    let bl = side < 0 ? blink.L : blink.R;
    if (eyeShut.side === side && nowMs() < eyeShut.until) bl = 1;
    const swallowing = prim.swallowT >= 0 && prim.swallowT < 0.45;
    const open = cur.open * (1 - bl) * (st._thinking ? 0.9 : 1) * (side < 0 ? prim.sqL : prim.sqR) * (swallowing ? 0.55 : 1) * (1 - prim.yawn * 0.9);
    ctx.save(); ctx.translate(ex, ey);

    // rotating outer rings and ticks
    ctx.lineWidth = U * 0.012; ctx.strokeStyle = col(0, 0.55 * cur.dim);
    ctx.setLineDash([U * 0.07, U * 0.045]); ctx.lineDashOffset = -t * 18 * cur.spin * side;
    ctx.beginPath(); ctx.arc(0, 0, r * 1.28, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    ctx.save(); ctx.rotate(-t * 0.15 * cur.spin * side);
    for (let i = 0; i < 40; i++) {
      const a = TAU * i / 40, long = i % 5 === 0;
      ctx.strokeStyle = col(10, (long ? 0.5 : 0.22) * cur.dim); ctx.lineWidth = long ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * r * 1.4, Math.sin(a) * r * 1.4);
      ctx.lineTo(Math.cos(a) * r * (long ? 1.52 : 1.46), Math.sin(a) * r * (long ? 1.52 : 1.46)); ctx.stroke();
    }
    ctx.restore();
    glow(true, 0.06); ctx.strokeStyle = col(10, 0.8 * cur.dim); ctx.lineWidth = U * 0.02;
    const sa = t * 0.9 * cur.spin * side;
    ctx.beginPath(); ctx.arc(0, 0, r * 1.15, sa, sa + 1.0); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, r * 1.15, sa + Math.PI, sa + Math.PI + 0.5); ctx.stroke();
    glow(false);

    // eyeball
    ctx.save(); ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.clip();
    ctx.fillStyle = "#06020b"; ctx.fillRect(-r, -r, 2 * r, 2 * r);
    const crossed = nowMs() < crossUntil;
    const px = crossed ? -side * r * 0.4 : look.x * r * 0.38 - side * prim.conv * r * 0.22, py = crossed ? r * 0.05 : look.y * r * 0.32;
    const ig = ctx.createRadialGradient(px, py, r * 0.05, px, py, r * 1.05);
    ig.addColorStop(0, col(25, 1)); ig.addColorStop(0.45, col(0, 0.95)); ig.addColorStop(0.85, col(-30, 0.9)); ig.addColorStop(1, "rgba(0,0,0,1)");
    ctx.fillStyle = ig; ctx.beginPath(); ctx.arc(px * 0.6, py * 0.6, r * 0.95, 0, TAU); ctx.fill();
    // iris spokes
    ctx.save(); ctx.translate(px, py); ctx.rotate(t * 0.25 * cur.spin * side);
    ctx.strokeStyle = col(30, 0.22); ctx.lineWidth = 1;
    const pr = r * (0.2 + cur.pupil * 0.3) * (1 + 0.15 * st.listening) * prim.pupil;
    for (let i = 0; i < 28; i++) {
      const a = TAU * i / 28;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * pr * 1.1, Math.sin(a) * pr * 1.1);
      ctx.lineTo(Math.cos(a) * r * (0.62 + 0.08 * (i % 3)), Math.sin(a) * r * (0.62 + 0.08 * (i % 3))); ctx.stroke();
    }
    ctx.strokeStyle = col(35, 0.35); ctx.beginPath(); ctx.arc(0, 0, r * 0.72, 0, TAU); ctx.stroke();
    // pupil
    ctx.fillStyle = "#040006"; ctx.beginPath(); ctx.arc(0, 0, pr, 0, TAU); ctx.fill();
    ctx.strokeStyle = col(30, 0.9); ctx.lineWidth = 1.5; ctx.stroke();
    ctx.strokeStyle = col(20, 0.35); ctx.beginPath(); ctx.arc(0, 0, pr * 0.55, 0, TAU); ctx.stroke();
    ctx.restore();
    // glints
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath(); ctx.arc(-r * 0.32 + look.x * r * 0.08, -r * 0.38 + look.y * r * 0.06, r * 0.11, 0, TAU); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.beginPath(); ctx.arc(r * 0.22 + look.x * r * 0.08, r * 0.28, r * 0.05, 0, TAU); ctx.fill();

    // eyelids (they shape the expression)
    const lidFill = "#07030d";
    const topC = -r + (1 - open) * 2 * r * 0.95;
    const yTop = x => topC + cur.tilt * (x * inner / r) * 0.38 * r - 0.22 * r * (1 - (x / r) ** 2) * open;
    ctx.fillStyle = lidFill; ctx.beginPath(); ctx.moveTo(-r * 1.1, -r * 1.1); ctx.lineTo(r * 1.1, -r * 1.1);
    for (let x = r * 1.1; x >= -r * 1.1; x -= r / 12) ctx.lineTo(x, yTop(x));
    ctx.closePath(); ctx.fill();
    const low = clamp(cur.low + bl * 0.15 + prim.chew * 0.07 * (0.5 + 0.5 * Math.sin(prim.chewPh)), 0, 1);
    const botC = r - low * 2 * r * 0.55;
    const yBot = x => botC - 0.4 * r * low * (1 - (x / r) ** 2);
    ctx.beginPath(); ctx.moveTo(-r * 1.1, r * 1.1); ctx.lineTo(r * 1.1, r * 1.1);
    for (let x = r * 1.1; x >= -r * 1.1; x -= r / 12) ctx.lineTo(x, yBot(x));
    ctx.closePath(); ctx.fill();
    // glowing lid edges
    glow(true, 0.05); ctx.strokeStyle = col(15, 0.95 * cur.dim); ctx.lineWidth = U * 0.018;
    ctx.beginPath(); for (let x = -r; x <= r; x += r / 12) ctx.lineTo(x, yTop(x)); ctx.stroke();
    if (low > 0.05) { ctx.beginPath(); for (let x = -r; x <= r; x += r / 12) ctx.lineTo(x, yBot(x)); ctx.stroke(); }
    glow(false);
    ctx.restore();

    // rim
    glow(true, 0.07); ctx.strokeStyle = col(10, 0.9 * cur.dim); ctx.lineWidth = U * 0.016;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke(); glow(false);

    // listening: soft ripples around each eye
    if (st.listening > 0.02) {
      for (let i = 0; i < 2; i++) {
        const ph = (t * 0.8 + i * 0.5) % 1;
        ctx.strokeStyle = `hsla(190,100%,65%,${(1 - ph) * 0.5 * st.listening})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, r * (1.3 + ph * 0.6), 0, TAU); ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Two small ears on top of her head. They perk up, droop, turn toward sounds and twitch.
  function ears(t) {
    for (const side of [-1, 1]) {
      const a = side < 0 ? prim.earL : prim.earR, tw = prim.earTw * Math.sin(t * 38) * 0.12;
      const sleepy = clamp(1 - cur.open * 1.3, 0, 0.6);                    // ears droop when her eyes do
      ctx.save(); ctx.translate(side * 0.78 * U, -0.66 * U);
      ctx.rotate(side * (0.55 - a * 0.5 + sleepy * 0.8) + tw * side);
      const len = U * (0.2 + 0.05 * Math.max(0, a)), w = U * 0.075;
      glow(true, 0.05); ctx.strokeStyle = col(10, 0.85 * cur.dim); ctx.fillStyle = col(-25, 0.35 * cur.dim); ctx.lineWidth = U * 0.014; ctx.lineJoin = "round";
      ctx.beginPath(); ctx.moveTo(-w, 0); ctx.quadraticCurveTo(-w * 0.6, -len * 0.7, 0, -len); ctx.quadraticCurveTo(w * 0.6, -len * 0.7, w, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = col(30, 0.5 * cur.dim); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, -len * 0.15); ctx.lineTo(0, -len * 0.75); ctx.stroke();
      glow(false); ctx.restore();
    }
  }

  function brows() {
    for (const side of [-1, 1]) {
      const inner = -side;
      const bx = side * 0.42 * U, by = -0.12 * U - 0.25 * U * 1.62 + cur.browY * 0.1 * U - cur.browAsym * side * 0.07 * U;
      const half = 0.21 * U;
      const ix = bx + inner * half, ox = bx - inner * half;
      const iy = by + cur.browA * 0.075 * U, oy = by - cur.browA * 0.035 * U;
      glow(true, 0.06); ctx.strokeStyle = col(10, 0.95 * cur.dim); ctx.lineWidth = U * 0.045; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(ox, oy); ctx.quadraticCurveTo(bx, Math.min(iy, oy) - 0.05 * U, ix, iy); ctx.stroke();
      ctx.lineWidth = U * 0.012; ctx.strokeStyle = col(35, 0.6 * cur.dim);
      ctx.beginPath(); ctx.moveTo(ox + inner * 0.03 * U, oy - 0.03 * U); ctx.quadraticCurveTo(bx, Math.min(iy, oy) - 0.09 * U, ix - inner * 0.05 * U, iy - 0.035 * U); ctx.stroke();
      glow(false);
    }
  }

  // Her mouth: two lips that part when she talks, corners that lift into a smile, teeth, a tongue when it's wide
  // open, and her voice (the dancing bars) living inside. The shape wanders between wide, tall and small-round
  // while she talks, so it isn't the same flap for every word. mouthGeo() is shared with the jaw and chin.
  let mg = { w: 1, my: 0, open: 0, round: 0, chewOpen: 0 };
  function mouthGeo(t) {
    const chewOpen = prim.chew * Math.max(0, Math.sin(prim.chewPh));
    const loud = Math.min(1, amp * 1.6);
    const round = st.talking ? clamp((noise(3, t * 0.33) - 0.42) * 2.4, 0, 1) : 0;       // "oo"
    const wide = st.talking ? clamp((noise(7, t * 0.27) - 0.5) * 2.2, 0, 1) : 0;         // "ee"
    const w = 0.66 * U * cur.mouthW * (1 - prim.chew * 0.25) * (1 - prim.yawn * 0.4) * (1 - 0.3 * round * loud) * (1 + 0.08 * wide * loud);
    const my = 0.45 * U + chewOpen * 0.025 * U;
    const open = clamp(amp * (0.8 + 0.4 * round - 0.35 * wide) + prim.yawn * 1.9 + chewOpen * 0.35 + st.listening * 0.05, 0, 2.2) * (prim.swallowT >= 0 ? 0.4 : 1);
    return { w, my, open, round, chewOpen };
  }
  function mouth(t) {
    const { w, my, open, round, chewOpen } = mg;
    const hw = w / 2, oh = open * 0.15 * U;
    const cy = f => my + cur.mouth * 0.11 * U * (1 - f * f) + cur.skew * 0.05 * U * f + cur.question * 0.018 * U * Math.sin(f * 6 + t * 3);
    const prof = f => Math.pow(Math.max(0, 1 - f * f), 0.75 - 0.3 * round);
    const yU = f => cy(f) - oh * 0.3 * prof(f), yL = f => cy(f) + oh * 0.7 * prof(f);            // the inner edges of the lips
    const lipU = U * 0.024, lipL = U * 0.034;
    const oU = f => yU(f) - lipU * (Math.sqrt(Math.max(0, 1 - f * f)) - 0.42 * Math.exp(-((f / 0.17) ** 2)));   // outer upper lip, with a cupid's bow
    const oL = f => yL(f) + lipL * Math.pow(Math.max(0, 1 - f * f), 0.6);
    const S = 28, pts = fn => { for (let i = 0; i <= S; i++) { const f = i / S * 2 - 1; ctx.lineTo(f * hw, fn(f)); } };
    const rpts = fn => { for (let i = S; i >= 0; i--) { const f = i / S * 2 - 1; ctx.lineTo(f * hw, fn(f)); } };

    // philtrum: the two faint lines from her nose to her upper lip
    ctx.strokeStyle = col(5, 0.2 * cur.dim); ctx.lineWidth = 1;
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(s * 0.022 * U, 0.215 * U); ctx.lineTo(s * 0.03 * U, oU(0) - U * 0.008); ctx.stroke(); }

    // inside of the mouth
    ctx.save();
    ctx.beginPath(); pts(yU); rpts(yL); ctx.closePath();
    ctx.fillStyle = "#06020b"; ctx.fill(); ctx.clip();
    if (oh > U * 0.02) {
      const depth = clamp(oh / (U * 0.12), 0, 1);
      // tongue
      if (oh > U * 0.06) {
        ctx.fillStyle = col(-2, 0.42 * depth * cur.dim, 25);
        ctx.beginPath(); ctx.ellipse(Math.sin(t * 2.3) * hw * 0.05, yL(0) + oh * 0.05, hw * (0.5 - 0.12 * round), oh * 0.42, 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = col(-20, 0.35 * depth); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, yL(0) - oh * 0.3); ctx.lineTo(0, yL(0)); ctx.stroke();
      }
      // upper teeth: little plates
      const th = Math.min(U * 0.034, oh * 0.4), n = 8, tw = hw * 1.24 / n;
      ctx.fillStyle = col(38, 0.8 * depth * cur.dim, 10);
      for (let i = 0; i < n; i++) { const f = ((i + 0.5) / n * 2 - 1) * 0.62; ctx.beginPath(); ctx.roundRect(f * hw - tw * 0.42, yU(f) - 1, tw * 0.84, th * (1 - 0.35 * f * f), tw * 0.2); ctx.fill(); }
      if (prim.yawn > 0.25 || oh > U * 0.13) {                                              // lower teeth show when it's really wide
        const lt = Math.min(U * 0.02, oh * 0.18);
        ctx.fillStyle = col(30, 0.55 * depth * cur.dim, 10);
        for (let i = 0; i < n; i++) { const f = ((i + 0.5) / n * 2 - 1) * 0.5; ctx.beginPath(); ctx.roundRect(f * hw - tw * 0.36, yL(f) - lt, tw * 0.72, lt + 1, tw * 0.2); ctx.fill(); }
      }
    }
    ctx.restore();

    // her voice: bars along the seam of the lips, growing into the opening as she speaks
    ctx.beginPath();
    const N = 30, bw = (w / N) * 0.5;
    for (let i = 0; i < N; i++) {
      const f = i / (N - 1) * 2 - 1, x = f * hw * 0.94, room = (yL(f) - yU(f));
      let h = U * 0.011 + U * 0.005 * (1 + Math.sin(t * 2 + i * 0.5));
      h += Math.min(room * 0.8, amp * (0.3 + 0.7 * noise(i, t)) * (1 - 0.6 * f * f) * 0.15 * U);
      h += st.listening * Math.abs(Math.sin(t * 5 + i * 0.45)) * 0.03 * U;
      const mid = (yU(f) + yL(f)) / 2 + room * 0.12;
      ctx.roundRect(x - bw / 2, mid - h / 2, bw, h, bw / 2);
    }
    glow(true, 0.07); ctx.fillStyle = col(14, (oh > U * 0.02 ? 0.8 : 0.95) * cur.dim); ctx.fill(); glow(false);

    // lips
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.fillStyle = col(-18, 0.5 * cur.dim);
    ctx.beginPath(); pts(oU); rpts(yU); ctx.closePath(); ctx.fill();
    ctx.beginPath(); pts(yL); rpts(oL); ctx.closePath(); ctx.fill();
    glow(true, 0.05); ctx.strokeStyle = col(12, 0.9 * cur.dim); ctx.lineWidth = U * 0.011;
    ctx.beginPath(); pts(oU); ctx.stroke();
    ctx.beginPath(); pts(oL); ctx.stroke();
    glow(false);
    ctx.strokeStyle = col(25, 0.55 * cur.dim); ctx.lineWidth = 1;
    ctx.beginPath(); pts(yU); ctx.stroke(); ctx.beginPath(); pts(yL); ctx.stroke();
    // a highlight on the lower lip
    ctx.strokeStyle = col(40, 0.35 * cur.dim); ctx.lineWidth = U * 0.006;
    ctx.beginPath(); for (let i = 0; i <= 10; i++) { const f = (i / 10 * 2 - 1) * 0.4; ctx.lineTo(f * hw, yL(f) + lipL * 0.55); } ctx.stroke();

    // the corners: small nodes, and dimples when she's really smiling
    for (const s of [-1, 1]) {
      const x = s * hw, y = cy(s);
      ctx.fillStyle = "#07030d"; ctx.strokeStyle = col(15, 0.85 * cur.dim); ctx.lineWidth = U * 0.008;
      ctx.beginPath(); ctx.arc(x + s * U * 0.012, y, U * 0.016, 0, TAU); ctx.fill(); ctx.stroke();
      const sm = clamp((cur.mouth - 0.4) / 0.6, 0, 1), fr = clamp((-cur.mouth - 0.3) / 0.7, 0, 1);
      if (sm > 0.02) { ctx.strokeStyle = col(15, 0.6 * sm * cur.dim); ctx.lineWidth = U * 0.008; ctx.beginPath(); ctx.arc(x + s * U * 0.03, y - U * 0.01, U * 0.055, s > 0 ? -0.9 : Math.PI - 0.9, s > 0 ? 0.9 : Math.PI + 0.9); ctx.stroke(); }
      if (fr > 0.02) { ctx.strokeStyle = col(5, 0.45 * fr * cur.dim); ctx.lineWidth = U * 0.007; ctx.beginPath(); ctx.moveTo(x + s * U * 0.03, y + U * 0.01); ctx.lineTo(x + s * U * 0.055, y + U * 0.07); ctx.stroke(); }
    }

    // swallow: a little "gulp" of light slides down from the mouth
    if (prim.swallowT >= 0) {
      const p = prim.swallowT / 0.8;
      ctx.fillStyle = col(25, (1 - p) * 0.9); glow(true, 0.05);
      ctx.beginPath(); ctx.arc(0, my + U * (0.08 + p * 0.3), U * 0.025 * (1 - p * 0.5), 0, TAU); ctx.fill(); glow(false);
    }
    // burps and puffs
    for (const pf of prim.puffs) {
      const p = pf.life / 1.4;
      ctx.strokeStyle = col(30, (1 - p) * 0.7); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(pf.x * U + Math.sin(p * 8) * U * 0.02, my - U * 0.05 - p * U * 0.4, U * (0.03 + p * 0.05) * pf.s, 0, TAU); ctx.stroke();
    }
  }

  // The rest of her head: a jawline that drops when her mouth opens, a chin node that pulses with her voice,
  // cheekbone, jaw and temple nodes, a band across the forehead with a sensor in the middle, and a nose.
  function structure(t) {
    const jaw = mg.open * 0.05 * U, smile = clamp(cur.mouth, -1, 1), a = cur.dim;
    const Tn = [0.8 * U, -0.44 * U], Cn = [0.77 * U, (0.2 - smile * 0.035) * U], Jn = [0.55 * U, 0.68 * U + jaw * 0.6], CHy = 0.9 * U + jaw;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    // jawline and forehead band
    ctx.strokeStyle = col(5, 0.34 * a); ctx.lineWidth = U * 0.009;
    for (const s of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(s * Tn[0], Tn[1]);
      ctx.quadraticCurveTo(s * 0.87 * U, -0.1 * U, s * Cn[0], Cn[1]);
      ctx.quadraticCurveTo(s * 0.75 * U, 0.52 * U + jaw * 0.3, s * Jn[0], Jn[1]);
      ctx.quadraticCurveTo(s * 0.3 * U, CHy + 0.03 * U, s * 0.075 * U, CHy);
      ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(-Tn[0], Tn[1]); ctx.quadraticCurveTo(0, -1.06 * U, Tn[0], Tn[1]); ctx.stroke();
    // fine lines tying things together: cheekbone to the corner of the mouth, jaw to chin
    ctx.strokeStyle = col(5, 0.14 * a); ctx.lineWidth = 1;
    for (const s of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(s * Cn[0], Cn[1]); ctx.lineTo(s * (mg.w / 2 + U * 0.03), mg.my + cur.skew * 0.05 * U * s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(s * Jn[0], Jn[1]); ctx.lineTo(s * 0.06 * U, CHy - 0.03 * U); ctx.stroke();
      // smile lines from the nose to the mouth, only when she's beaming
      const sm = clamp((smile - 0.35) / 0.65, 0, 1);
      if (sm > 0.02) { ctx.strokeStyle = col(8, 0.3 * sm * a); ctx.beginPath(); ctx.moveTo(s * 0.11 * U, 0.2 * U); ctx.quadraticCurveTo(s * 0.3 * U, 0.3 * U, s * (mg.w / 2 + U * 0.07), mg.my - 0.03 * U); ctx.stroke(); ctx.strokeStyle = col(5, 0.14 * a); }
    }
    // nodes
    const node = (x, y, r) => { ctx.fillStyle = "#07030d"; ctx.strokeStyle = col(15, 0.75 * a); ctx.lineWidth = U * 0.008; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); ctx.stroke(); };
    for (const s of [-1, 1]) { node(s * Tn[0], Tn[1], U * 0.016); node(s * Cn[0], Cn[1], U * 0.02); node(s * Jn[0], Jn[1], U * 0.016); }
    // forehead sensor: a diamond that lights up while she's thinking
    const fy = -0.75 * U, fr = U * 0.036, think = st.thinking;
    ctx.fillStyle = "#07030d"; ctx.strokeStyle = col(15, 0.75 * a); ctx.lineWidth = U * 0.008;
    ctx.beginPath(); ctx.moveTo(0, fy - fr); ctx.lineTo(fr * 0.8, fy); ctx.lineTo(0, fy + fr); ctx.lineTo(-fr * 0.8, fy); ctx.closePath(); ctx.fill(); ctx.stroke();
    glow(true, 0.05); ctx.fillStyle = col(30, (0.35 + 0.6 * think * (0.6 + 0.4 * Math.sin(t * 9)) + 0.15 * Math.sin(t * 1.7)) * a);
    ctx.beginPath(); ctx.arc(0, fy, fr * (0.3 + 0.12 * think), 0, TAU); ctx.fill(); glow(false);
    // chin node: a hexagon with a core that pulses with her voice
    const cr = U * 0.05;
    ctx.strokeStyle = col(5, 0.3 * a); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, CHy - cr); ctx.lineTo(0, mg.my + mg.open * 0.105 * U + U * 0.05); ctx.stroke();
    ctx.fillStyle = "#07030d"; ctx.strokeStyle = col(15, 0.85 * a); ctx.lineWidth = U * 0.01;
    ctx.beginPath(); for (let i = 0; i < 6; i++) { const an = TAU * i / 6 + Math.PI / 6; ctx.lineTo(Math.cos(an) * cr, CHy + Math.sin(an) * cr); } ctx.closePath(); ctx.fill();
    glow(true, 0.05); ctx.stroke();
    ctx.fillStyle = col(28, (0.45 + 0.55 * Math.min(1, amp * 1.4)) * a);
    ctx.beginPath(); ctx.arc(0, CHy, cr * (0.28 + 0.3 * Math.min(1, amp)), 0, TAU); ctx.fill(); glow(false);
    for (const s of [-1, 1]) { ctx.strokeStyle = col(15, 0.5 * a); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(s * cr * 1.25, CHy); ctx.lineTo(s * cr * 1.7, CHy); ctx.stroke(); }
    // nose: bridge, tip and nostrils (it glows when it's booped)
    const boop = nowMs() < crossUntil ? 1 : 0;
    ctx.strokeStyle = col(10 + 25 * boop, (0.42 + 0.5 * boop) * a); ctx.lineWidth = U * 0.008;
    if (boop) glow(true, 0.06);
    for (const s of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(s * 0.045 * U, -0.03 * U); ctx.quadraticCurveTo(s * 0.03 * U, 0.1 * U, s * 0.068 * U, 0.165 * U);
      ctx.quadraticCurveTo(s * 0.075 * U, 0.2 * U, s * 0.04 * U, 0.198 * U); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(-0.028 * U, 0.2 * U); ctx.quadraticCurveTo(0, 0.222 * U, 0.028 * U, 0.2 * U); ctx.stroke();
    glow(false);
  }

  function cheeks(t) {
    if (prim.chew > 0.03) {
      for (const s of [-1, 1]) {
        const puff = prim.chew * (0.5 + 0.5 * Math.sin(prim.chewPh + 0.6 + (s > 0 ? 0.3 : 0)));
        ctx.strokeStyle = col(15, 0.45 * puff * cur.dim); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(s * 0.5 * U, 0.42 * U, U * (0.07 + 0.03 * puff), s > 0 ? -0.9 : Math.PI - 0.9 + 0.9 * 0, s > 0 ? 0.9 : Math.PI + 0.9); ctx.stroke();
      }
    }
    if (cur.blush > 0.02) {
      for (const s of [-1, 1]) {
        const x = s * 0.5 * U, y = 0.2 * U;
        const g = ctx.createRadialGradient(x, y, 0, x, y, U * 0.16);
        g.addColorStop(0, `hsla(340,100%,65%,${0.38 * cur.blush})`); g.addColorStop(1, "hsla(340,100%,65%,0)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y, U * 0.17, U * 0.09, 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = `hsla(340,100%,75%,${0.7 * cur.blush})`; ctx.lineWidth = 2;
        for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.moveTo(x + i * U * 0.045 - U * 0.012, y + U * 0.025); ctx.lineTo(x + i * U * 0.045 + U * 0.012, y - U * 0.025); ctx.stroke(); }
      }
    }
    if (cur.vents > 0.02) {
      for (const s of [-1, 1]) {
        const a = cur.vents * (0.55 + 0.45 * Math.sin(t * 9 + s));
        ctx.save(); ctx.translate(s * 0.86 * U, 0.12 * U); ctx.rotate(s * -0.35);
        ctx.shadowColor = "rgba(255,40,40,0.9)"; ctx.shadowBlur = U * 0.06;
        ctx.fillStyle = `rgba(255,60,50,${a})`;
        for (let i = 0; i < 3; i++) ctx.fillRect(-U * 0.06, i * U * 0.05 - U * 0.05, U * 0.12, U * 0.022);
        ctx.restore();
      }
    }
  }

  function extras(t) {
    // sleepy Zs
    ctx.font = `bold ${Math.round(U * 0.12)}px ui-monospace, monospace`; ctx.textAlign = "center";
    for (const z of zs) {
      const p = z.life / 3.2;
      ctx.fillStyle = col(25, (1 - p) * 0.9);
      ctx.save(); ctx.translate(z.x + p * U * 0.5 + Math.sin(p * 9) * U * 0.05, z.y - p * U * 0.7); ctx.scale(z.s * (0.6 + p), z.s * (0.6 + p));
      ctx.fillText("z", 0, 0); ctx.restore();
    }
    // confused question marks
    if (cur.question > 0.05) {
      ctx.font = `bold ${Math.round(U * 0.2)}px system-ui, sans-serif`;
      ctx.fillStyle = col(20, 0.8 * cur.question);
      ctx.fillText("?", 0.92 * U, -0.58 * U + Math.sin(t * 2.2) * U * 0.04);
      ctx.font = `bold ${Math.round(U * 0.12)}px system-ui, sans-serif`;
      ctx.fillText("?", 1.08 * U, -0.75 * U + Math.sin(t * 2.2 + 1) * U * 0.04);
    }
    // sparkles
    for (const s of sparks) {
      const p = s.life / 0.9, a = Math.sin(p * Math.PI), sz = U * 0.05 * s.s * a;
      ctx.fillStyle = `rgba(255,255,255,${a * 0.9})`; ctx.beginPath();
      ctx.moveTo(s.x, s.y - sz); ctx.quadraticCurveTo(s.x, s.y, s.x + sz, s.y); ctx.quadraticCurveTo(s.x, s.y, s.x, s.y + sz);
      ctx.quadraticCurveTo(s.x, s.y, s.x - sz, s.y); ctx.quadraticCurveTo(s.x, s.y, s.x, s.y - sz); ctx.fill();
    }
    // tears
    for (const d of tears) {
      const p = d.life / 2.4, x = d.side * 0.42 * U + -d.side * 0.12 * U, y = 0.1 * U + p * p * U * 0.55;
      ctx.fillStyle = `hsla(200,100%,75%,${(1 - p) * 0.85})`;
      ctx.beginPath(); ctx.moveTo(x, y - U * 0.05); ctx.quadraticCurveTo(x + U * 0.03, y, x, y + U * 0.025); ctx.quadraticCurveTo(x - U * 0.03, y, x, y - U * 0.05); ctx.fill();
    }
    // thinking: dots orbiting over her head
    if (st.thinking > 0.02) {
      for (let i = 0; i < 3; i++) {
        const a = t * 3 + i * TAU / 3;
        ctx.fillStyle = col(30, 0.9 * st.thinking);
        ctx.beginPath(); ctx.arc(Math.cos(a) * U * 0.22, -0.95 * U + Math.sin(a) * U * 0.06, U * 0.025 * (1 + 0.3 * Math.sin(a)), 0, TAU); ctx.fill();
      }
    }
  }

  function touchRipples(dt) {
    ripples = ripples.filter(r => (r.life += dt) < 0.6);
    for (const r of ripples) {
      const p = r.life / 0.6;
      ctx.strokeStyle = col(25, (1 - p) * 0.8); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(r.x, r.y, 8 + p * U * 0.25, 0, TAU); ctx.stroke();
    }
  }

  function overlays(t) {
    if (st.offline > 0.02) {
      if (!lowPower) { ctx.fillStyle = `rgba(255,200,0,${0.05 * st.offline})`; ctx.fillRect(0, 0, W, H); }
      ctx.font = `${Math.round(U * 0.05)}px ui-monospace, monospace`; ctx.textAlign = "center";
      ctx.fillStyle = `rgba(255,210,60,${0.8 * st.offline})`;
      ctx.fillText("OFFLINE BRAIN", CX, CY - 0.95 * U);
    }
    // a slow bright band rolling down
    if (!lowPower) {
      const by = ((t * 0.12) % 1.3) * H - 0.15 * H;
      const g = ctx.createLinearGradient(0, by, 0, by + H * 0.12);
      g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.5, `hsla(${cur.hue},100%,80%,0.05)`); g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g; ctx.fillRect(0, by, W, H * 0.12);
    }
    // scan lines and dark corners (painted once, stamped each frame)
    if (!fgLayer || fgLayer.width !== canvas.width || fgLayer.height !== canvas.height) buildForeground();
    ctx.drawImage(fgLayer, 0, 0, W, H);
  }

  let glitchUntil = 0;
  function glitch(t) {
    if (t > glitchUntil && Math.random() < cur.glitch * 0.03) glitchUntil = t + rand(0.06, 0.18);
    if (t > glitchUntil) return;
    const n = 3 + Math.floor(Math.random() * 4);
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = 0; i < n; i++) {
      const y = Math.floor(rand(0, canvas.height)), h = Math.floor(rand(4, 30) * DPR), dx = Math.floor(rand(-1, 1) * U * 0.08 * DPR);
      ctx.drawImage(canvas, 0, y, canvas.width, h, dx, y, canvas.width, h);
    }
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = `hsla(${(cur.hue + 180) % 360},100%,50%,0.06)`; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  // ---------- frame loop ----------
  // what hands.js needs from here to draw her hands in the same style, in the same place
  const handEnv = { ctx, col, glow, cur, st, prim, get U() { return U; }, get CX() { return CX; }, get CY() { return CY; }, get W() { return W; }, get H() { return H; },
    get amp() { return amp; }, get mood() { return mood; }, get mouth() { return mg; }, get look() { return look; } };
  let last = performance.now();
  let paused = false;                                   // her screen is dark (dark.js): keep time, draw nothing
  function frame(now) {
    if (paused) { last = now; setTimeout(() => requestAnimationFrame(frame), 500); return; }
    // Phones refresh the screen up to 120 times a second; her face doesn't need that, and every frame she draws
    // is processor time her brain doesn't get. 30 a second normally, 20 while her brain is working.
    if (now - last < 1000 / (lowPower ? Math.min(20, fpsCap) : fpsCap) - 4) { requestAnimationFrame(frame); return; }
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    const t = now / 1000;
    if (canvas.clientWidth !== Math.round(W) || canvas.clientHeight !== Math.round(H)) resize();
    update(dt, t);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    background(t);
    ctx.save();
    const shk = (now < shakeUntil ? U * 0.025 : 0) + prim.tremble * U * 0.008;
    ctx.translate(CX + rand(-shk, shk), CY + Math.sin(t * 0.9) * U * 0.012 - st.thinking * U * 0.02 + rand(-shk, shk));
    if (fxOn("dance") || fxOn("disco")) {
      const ph = prim.beat ? Math.PI * ((nowMs() - prim.beat.t0) / (60000 / prim.beat.bpm)) : t * 4.2;   // on the beat when she can hear one
      ctx.translate(Math.sin(ph) * U * 0.06, -Math.abs(Math.sin(prim.beat ? ph : t * 8.4)) * U * 0.06);
      ctx.rotate(Math.sin(ph) * 0.09);
    }
    if (fxOn("dizzy")) ctx.rotate(Math.sin(t * 3) * 0.12);
    ctx.rotate(tiltIn.x * 0.05 + Math.sin(t * 0.5) * 0.012 + cur.skew * 0.02 + prim.tilt);
    const breathe = (1 + Math.sin(t * 1.1) * 0.01) * (1 + prim.lean * 0.09);
    ctx.scale(breathe, breathe);
    mg = mouthGeo(t);
    hud(t);
    structure(t);
    ears(t);
    cheeks(t);
    eye(-1, t); eye(1, t);
    if (fxOn("heart_eyes")) hearts(t);
    if (fxOn("laser_eyes")) lasers(t);
    brows();
    if (fxOn("shades")) shades(t);
    mouth(t);
    extras(t);
    ctx.restore();
    try { window.Hands?.frame(handEnv, t, dt); } catch (e) { if (!frame.warned) { frame.warned = true; console.error(e); } }   // her floating hands (hands.js)
    if (highlight && nowMs() < highlight.until) {
      const a = (highlight.until - nowMs()) / highlight.ms;
      ctx.save(); ctx.shadowColor = "#fff"; ctx.shadowBlur = U * 0.15;
      ctx.fillStyle = `hsla(${highlight.hue},100%,70%,${0.65 * a})`;
      ctx.beginPath(); ctx.arc(CX + highlight.x * U, CY + highlight.y * U, U * 0.22, 0, TAU); ctx.fill(); ctx.restore();
    }
    idleDimNow += ((idleDim - idleDimNow) * Math.min(1, dt * 1.5));                       // fades in and out gently
    const dimAll = Math.max(nightDim, idleDimNow);
    if (dimAll > 0.01) { ctx.fillStyle = `rgba(0,0,0,${dimAll})`; ctx.fillRect(0, 0, W, H); }
    if (flashOn) { ctx.fillStyle = "rgba(255,255,255,0.55)"; ctx.fillRect(0, 0, W, H); }
    if (fxOn("strobe") && Math.floor(t * 3) % 2) { ctx.fillStyle = col(30, 0.3); ctx.fillRect(0, 0, W, H); }
    touchRipples(dt);
    overlays(t);
    glitch(t);
    requestAnimationFrame(frame);
  }

  // ---------- effect drawings ----------
  function heart(x, y, s) {
    ctx.beginPath(); ctx.moveTo(x, y + s * 0.35);
    ctx.bezierCurveTo(x - s * 1.1, y - s * 0.4, x - s * 0.45, y - s * 1.15, x, y - s * 0.45);
    ctx.bezierCurveTo(x + s * 0.45, y - s * 1.15, x + s * 1.1, y - s * 0.4, x, y + s * 0.35); ctx.fill();
  }
  function hearts(t) {
    const s = U * 0.22 * (1 + 0.12 * Math.sin(t * 9));
    ctx.save(); ctx.shadowColor = "rgba(255,40,120,1)"; ctx.shadowBlur = U * 0.1; ctx.fillStyle = "#ff3d8b";
    for (const side of [-1, 1]) heart(side * 0.42 * U, -0.12 * U + s * 0.25, s);
    ctx.restore();
  }
  function lasers(t) {
    ctx.save(); ctx.lineCap = "round";
    for (const side of [-1, 1]) {
      const x0 = side * 0.42 * U, y0 = -0.12 * U, x1 = side * 1.6 * U + Math.sin(t * 3) * U * 0.6, y1 = 2.4 * U;
      ctx.shadowColor = "red"; ctx.shadowBlur = U * 0.12;
      ctx.strokeStyle = `rgba(255,30,30,${0.6 + 0.4 * Math.random()})`; ctx.lineWidth = U * 0.05;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.strokeStyle = "rgba(255,230,230,0.9)"; ctx.lineWidth = U * 0.015; ctx.stroke();
    }
    ctx.restore();
  }
  function shades(t) {
    ctx.save(); const y = -0.15 * U;
    ctx.fillStyle = "#050505"; ctx.strokeStyle = "#222"; ctx.lineWidth = 3;
    for (const side of [-1, 1]) {
      ctx.beginPath(); ctx.roundRect(side * 0.42 * U - 0.3 * U, y - 0.16 * U, 0.6 * U, 0.3 * U, [U * 0.03, U * 0.03, U * 0.14, U * 0.14]);
      ctx.fill(); ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(side * 0.42 * U - 0.2 * U, y - 0.1 * U); ctx.lineTo(side * 0.42 * U - 0.08 * U, y + 0.04 * U); ctx.stroke();
      ctx.strokeStyle = "#222"; ctx.lineWidth = 3;
    }
    ctx.fillStyle = "#050505"; ctx.fillRect(-0.13 * U, y - 0.13 * U, 0.26 * U, 0.05 * U);
    ctx.font = `bold ${Math.round(U * 0.07)}px ui-monospace, monospace`; ctx.textAlign = "center";
    ctx.fillStyle = col(30, 0.8); ctx.fillText("DEAL WITH IT", 0, 0.78 * U);
    ctx.restore();
  }

  // ---------- touches on her face: WHERE (zone) and HOW (gesture) ----------
  // Instant face reactions per gesture. Props are mood numbers held for `ms`.
  const REACT = {
    tap:        { ms: 450,  props: { open: 1, low: 0, pupil: 0.3, browY: -0.8, mouth: -0.1 } },
    double_tap: { ms: 600,  props: { open: 1, low: 0, pupil: 0.25, browY: -1, mouth: -0.3, question: 0.6 }, shake: 150 },
    eye:        { ms: 900,  props: { open: 0.05, low: 0.5, browY: 0.7, browA: 0.9, mouth: -0.7, vents: 0.6 }, shake: 250, vib: [120] },
    listen:     { ms: 700,  props: { browY: -0.35, open: 0.95 } },
    hold:       { ms: 1200, props: { open: 0.95, pupil: 0.6, browY: -0.3, browAsym: 0.6, mouth: 0.1, question: 0.5 } },
    stroke:     { ms: 1600, props: { open: 0.35, low: 0.55, browY: -0.4, browA: -0.2, mouth: 0.8, blush: 1, spin: 0.6 } },
    scratch:    { ms: 1800, props: { open: 0.15, low: 0.7, browY: -0.6, browA: -0.4, mouth: 1, blush: 1, sparkle: 0.6 }, vib: "purr" },
    rub:        { ms: 1800, props: { open: 0.4, low: 0.5, browY: -0.3, mouth: 0.6, blush: 0.7, spin: 2 } },
    tickle:     { ms: 1500, props: { open: 0.3, low: 0.6, browY: -0.7, mouth: 1, blush: 0.8, sparkle: 1 }, shake: 900, vib: "laugh" },
    slap:       { ms: 1300, props: { hue: 0, open: 0.55, tilt: 1, low: 0.1, browY: 0.7, browA: 1, mouth: -0.9, vents: 1, glitch: 0.6 }, shake: 600, vib: [250] },
    squish:     { ms: 1200, props: { open: 0.15, low: 0.4, browY: 0.4, browAsym: -0.4, mouth: -0.2, mouthW: 0.6, question: 0.4 }, shake: 200 },
    stretch:    { ms: 1000, props: { open: 1, low: 0, pupil: 0.2, browY: -1, mouth: -0.4, mouthW: 1.25 } },
    boop:       { ms: 1100, props: { open: 0.9, browY: -0.6, mouth: 0.5, blush: 0.5 }, cross: true },
    swipe:      { ms: 500,  props: { open: 1, browY: -0.4, mouth: -0.2 } },
    eye_close:  { ms: 1500, props: { browA: 0.4, mouth: -0.3 } },
    chin:       { ms: 2000, props: { open: 0.1, low: 0.75, browY: -0.6, mouth: 1, blush: 1, sparkle: 0.8, tilt: -0.3 }, vib: "purr" },
    head_pat:   { ms: 1700, props: { open: 0.2, low: 0.65, browY: -0.5, mouth: 0.9, blush: 0.9 } },
    knock:      { ms: 700,  props: { open: 1, browY: -0.9, browAsym: 0.5, mouth: -0.2, question: 1 } }
  };
  let crossUntil = 0, eyeShut = { side: 0, until: 0 };
  function react(kind) {
    const r = REACT[kind]; if (!r) return;
    trans = { until: nowMs() + r.ms, props: r.props };
    if (r.shake) shakeUntil = nowMs() + r.shake;
    if (r.cross) crossUntil = nowMs() + r.ms;
    if (r.vib && window.Abilities) Abilities.vibrate(r.vib);
    if (kind === "eye") { blink.L = blink.R = 1; }
    lastActivity = nowMs();
  }
  function lookAtScreen(x, y, ms = 1500) {
    ext = { x: clamp((x - CX) / (U * 0.9), -1, 1), y: clamp((y - CY) / (U * 0.9), -1, 1), until: nowMs() + ms };
  }

  // Zones are named from HER point of view: the eye on your left is her right eye.
  function zoneAt(x, y) {
    const hz = window.Hands?.hit?.(x, y); if (hz) return hz;
    const fx = (x - CX) / U, fy = (y - CY) / U, her = fx < 0 ? "right" : "left";
    if (Math.hypot(Math.abs(fx) - 0.42, fy + 0.12) < 0.33) return her + " eye";
    if (fy < -1.15) return "top of your head";
    if (fy < -0.62) return "forehead";
    if (fy < -0.38 && Math.abs(fx) > 0.12 && Math.abs(fx) < 0.75) return her + " eyebrow";
    if (Math.abs(fx) < 0.16 && fy < 0.28) return "nose";
    if (Math.abs(fx) < 0.46 && fy >= 0.28 && fy < 0.62) return "mouth";
    if (Math.abs(fx) < 0.55 && fy >= 0.62 && fy < 1.08) return "chin";
    if (fy >= 1.08) return "neck";
    if (Math.abs(fx) > 0.95) return "side of your head (" + her + ")";
    return her + " cheek";
  }

  const ptrs = new Map();                   // active fingers
  let gest = null, taps = [];
  canvas.addEventListener("pointerdown", e => {
    canvas.setPointerCapture?.(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    ripples.push({ x: e.clientX, y: e.clientY, life: 0 });
    lookAtScreen(e.clientX, e.clientY);
    if (!gest) {
      gest = { t: nowMs(), x: e.clientX, y: e.clientY, path: [[e.clientX, e.clientY, nowMs()]], dist: 0, maxP: 1, big: false,
        rev: 0, lastDx: 0, lastDy: 0, ang: 0, lastA: null, minX: e.clientX, maxX: e.clientX, minY: e.clientY, maxY: e.clientY,
        pinch0: null, pinch1: null, live: null };
      gest.timer = setTimeout(() => {
        if (gest && gest.maxP === 1 && gest.dist < 25) { gest.held = true; react("hold"); Face.onTouch?.("hold", zoneAt(gest.x, gest.y)); }
      }, 650);
    }
    gest.maxP = Math.max(gest.maxP, ptrs.size);
    if ((e.width || 0) > 70 || (e.height || 0) > 70) gest.big = true;      // a whole palm
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; gest.pinch0 = Math.hypot(a.x - b.x, a.y - b.y); }
  });
  canvas.addEventListener("pointermove", e => {
    const p = ptrs.get(e.pointerId); if (!p || !gest) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size >= 2) { const [a, b] = [...ptrs.values()]; gest.pinch1 = Math.hypot(a.x - b.x, a.y - b.y); return; }
    gest.dist += Math.hypot(dx, dy);
    gest.path.push([e.clientX, e.clientY, nowMs()]);
    gest.minX = Math.min(gest.minX, e.clientX); gest.maxX = Math.max(gest.maxX, e.clientX);
    gest.minY = Math.min(gest.minY, e.clientY); gest.maxY = Math.max(gest.maxY, e.clientY);
    // direction reversals (scratching is lots of quick back-and-forth)
    const big = Math.abs(dx) > Math.abs(dy);
    if (big && Math.abs(dx) > 3) { if (gest.lastDx && Math.sign(dx) !== Math.sign(gest.lastDx)) gest.rev++; gest.lastDx = dx; }
    if (!big && Math.abs(dy) > 3) { if (gest.lastDy && Math.sign(dy) !== Math.sign(gest.lastDy)) gest.rev++; gest.lastDy = dy; }
    // how far it went around in a circle (rubbing)
    const cx = (gest.minX + gest.maxX) / 2, cy = (gest.minY + gest.maxY) / 2, a = Math.atan2(e.clientY - cy, e.clientX - cx);
    if (gest.lastA != null) { let d = a - gest.lastA; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; gest.ang += d; }
    gest.lastA = a;
    lookAtScreen(e.clientX, e.clientY, 800);
    // live feedback while the finger is still moving
    const live = Math.abs(gest.ang) > Math.PI * 1.6 ? "rub" : gest.rev >= 5 ? "scratch" : gest.dist > 90 ? "stroke" : null;
    if (live && gest.live !== live) { gest.live = live; react(zoneAt(gest.x, gest.y) === "chin" && live === "scratch" ? "chin" : live); }
    if (gest.live && trans) trans.until = nowMs() + 500;
  });
  const end = e => {
    ptrs.delete(e.pointerId);
    if (!gest || ptrs.size > 0) return;      // wait until every finger is up
    clearTimeout(gest.timer);
    const g2 = gest; gest = null;
    if (g2.held) return;
    const dur = nowMs() - g2.t, zone = zoneAt(g2.x, g2.y);
    const [lx, ly] = g2.path[g2.path.length - 1];
    const net = Math.hypot(lx - g2.x, ly - g2.y), boxW = g2.maxX - g2.minX, boxH = g2.maxY - g2.minY;
    let kind, extra = "";

    if (g2.maxP >= 3 || g2.big) kind = "slap";
    else if (g2.maxP === 2) {
      const ratio = g2.pinch0 && g2.pinch1 ? g2.pinch1 / g2.pinch0 : 1;
      kind = ratio < 0.75 ? "squish" : ratio > 1.35 ? "stretch" : "boop";
    }
    else if (g2.dist < 22) {
      // taps only chain when they're quick (under ~0.4s apart) and in the same spot
      const t = nowMs(), prev = taps[taps.length - 1];
      if (prev && (t - prev.t > 400 || Math.hypot(prev.x - g2.x, prev.y - g2.y) > 90)) taps = [];
      taps.push({ t, x: g2.x, y: g2.y });
      if (taps.length >= 4) { taps = []; kind = "tickle"; }
      else if (taps.length >= 2 && Math.hypot(taps[taps.length - 2].x - g2.x, taps[taps.length - 2].y - g2.y) < 60 && t - taps[taps.length - 2].t < 380) kind = "double_tap";
      else kind = "tap";
    }
    else if (Math.abs(g2.ang) > Math.PI * 1.6) kind = "rub";
    else if (g2.rev >= 4 && Math.max(boxW, boxH) < U * 0.6) kind = "scratch";
    else if (net / g2.dist > 0.75 && net / Math.max(dur, 1) > 0.7) {
      kind = "swipe";
      extra = Math.abs(lx - g2.x) > Math.abs(ly - g2.y) ? (lx > g2.x ? "right" : "left") : (ly > g2.y ? "down" : "up");
      if ((extra === "left" || extra === "right") && Math.abs(lx - g2.x) > W * 0.6) extra += " (all the way across)";
    }
    else kind = "stroke";
    if (kind !== "tap" && kind !== "double_tap") taps = [];

    // the visual reaction depends on where, too
    let visual = kind;
    if (kind === "tap" && /eye$/.test(zone)) visual = "eye";
    if (kind === "tap" && zone === "nose") { visual = "boop"; kind = "boop"; window.Abilities?.sfx("boop"); }
    if (kind === "tap" && /forehead|top of/.test(zone)) visual = "knock";
    if (kind === "swipe" && /eye$/.test(zone) && extra === "down") { visual = "eye_close"; eyeShut = { side: zone.startsWith("right") ? -1 : 1, until: nowMs() + 1500 }; }
    if (kind === "swipe") ext = { x: { left: -1, right: 1 }[extra] || 0, y: { up: -1, down: 1 }[extra] || 0, until: nowMs() + 700 };
    if ((kind === "scratch" || kind === "stroke") && zone === "chin") visual = "chin";
    if ((kind === "stroke" || kind === "rub") && /top of|forehead/.test(zone)) visual = "head_pat";
    if (kind === "slap") window.Abilities?.sfx("rimshot");
    if (kind === "squish") Face.eyeSize(0.87);
    if (kind === "stretch") Face.eyeSize(1.15);
    react(visual);
    Face.onTouch?.(kind, zone, extra);
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  window.Face = {
    react,
    // little face moves: wink_left wink_right double_blink squint wide eye_roll side_eye_left side_eye_right
    // look_left look_right look_up look_down scan_room startle reboot nod shake_head
    gesture(name) {
      gestureTimers.forEach(clearTimeout); gestureTimers = [];
      const at = (ms, fn) => gestureTimers.push(setTimeout(fn, ms));
      const gaze = (x, y, ms = 900) => { ext = { x, y, until: nowMs() + ms }; };
      const hold = (props, ms) => { trans = { until: nowMs() + ms, props }; };
      lastActivity = nowMs();
      switch (name) {
        case "wink_left": eyeShut = { side: 1, until: nowMs() + 450 }; hold({ mouth: 0.6, skew: 0.5, browAsym: -0.4 }, 900); break;
        case "wink_right": eyeShut = { side: -1, until: nowMs() + 450 }; hold({ mouth: 0.6, skew: -0.5, browAsym: 0.4 }, 900); break;
        case "double_blink": blink.phase = 1; blink.t = 0; blink.double = true; blink.wink = false; break;
        case "squint": hold({ open: 0.25, low: 0.45, browY: 0.3, browA: 0.3 }, 1600); break;
        case "wide": hold({ open: 1, low: 0, pupil: 0.22, browY: -1 }, 1300); break;
        case "eye_roll": hold({ open: 0.6, low: 0.1, browY: -0.2, mouth: -0.1 }, 1500);
          [[-0.9, -0.2], [-0.6, -0.9], [0, -1], [0.6, -0.9], [0.9, -0.2], [0, 0]].forEach(([x, y], i) => at(i * 170, () => gaze(x, y, 400))); break;
        case "side_eye_left": gaze(-1, 0.1, 2500); hold({ open: 0.42, low: 0.32, browAsym: 0.6, mouth: -0.1, skew: -0.4 }, 2500); break;
        case "side_eye_right": gaze(1, 0.1, 2500); hold({ open: 0.42, low: 0.32, browAsym: -0.6, mouth: -0.1, skew: 0.4 }, 2500); break;
        case "look_left": gaze(-1, 0, 1500); break;
        case "look_right": gaze(1, 0, 1500); break;
        case "look_up": gaze(0, -1, 1500); break;
        case "look_down": gaze(0, 1, 1500); break;
        case "scan_room": for (let i = 0; i <= 20; i++) at(i * 200, () => gaze(-1 + (i / 10 <= 1 ? i / 10 : 2 - i / 10) * 2, -0.1, 300)); break;
        case "startle": hold({ open: 1, low: 0, pupil: 0.18, browY: -1, mouth: -0.5 }, 900); shakeUntil = nowMs() + 400; break;
        case "reboot": hold({ open: 0, low: 0.5, dim: 0.3, glitch: 0.8 }, 2200); at(2300, () => hold({ open: 1, pupil: 0.2, browY: -0.8 }, 700)); break;
        case "nod": [0.5, -0.3, 0.5, -0.3, 0].forEach((y, i) => at(i * 160, () => gaze(0, y, 250))); break;
        case "shake_head": [-0.7, 0.7, -0.7, 0.7, 0].forEach((x, i) => at(i * 150, () => gaze(x, 0, 250))); break;
        default: return false;
      }
      return true;
    },
    gestures: ["wink_left", "wink_right", "double_blink", "squint", "wide", "eye_roll", "side_eye_left", "side_eye_right",
      "look_left", "look_right", "look_up", "look_down", "scan_room", "startle", "reboot", "nod", "shake_head"],
    setBlend(b) { blend = b || {}; },
    setBlinkRate(r) { blinkRate = clamp(r, 0.4, 2.5); },
    noBlink(seconds) { noBlinkUntil = nowMs() + seconds * 1000; },
    eyeSize(mult) { eyeScale = clamp(eyeScale * mult, 0.65, 1.5); return eyeScale; },
    resetEyes() { eyeScale = 1; },
    // light up a spot on her face (for games): zone names like the touch zones
    highlightZone(zone, ms = 500, hue = 50) {
      const Z = { "left eye": [0.42, -0.12], "right eye": [-0.42, -0.12], nose: [0, 0.08], mouth: [0, 0.45], "left cheek": [0.7, 0.2], "right cheek": [-0.7, 0.2], forehead: [0, -0.85], chin: [0, 0.9] };
      const p = Z[zone]; if (!p) return;
      highlight = { x: p[0], y: p[1], until: nowMs() + ms, ms, hue };
    },
    pause(on) { paused = !!on; },
    // Her brain is working (offline): draw fewer frames and skip the small glows, so the brain gets the processor.
    lowPower(on) { lowPower = !!on; },
    fps(n) { if (n) fpsCap = clamp(+n || 30, 10, 120); return fpsCap; },
    get drawing() { return { fps: lowPower ? Math.min(20, fpsCap) : fpsCap, lowPower, paused }; },
    // A picture of her face exactly as it's drawn right now (JPEG, base64), for her own brain to look at.
    picture(max = 900) {
      const k = Math.min(1, max / Math.max(canvas.width, canvas.height));
      const c = document.createElement("canvas"); c.width = Math.round(canvas.width * k); c.height = Math.round(canvas.height * k);
      const g = c.getContext("2d"); g.fillStyle = "#000"; g.fillRect(0, 0, c.width, c.height); g.drawImage(canvas, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.8).split(",")[1];
    },
    // The same thing in words, for the offline brain (which can't look at pictures).
    describe() {
      const hueName = h => ["red", "orange", "yellow", "lime green", "green", "teal", "cyan", "sky blue", "blue", "violet", "purple", "magenta pink", "red"][Math.round(((h % 360) + 360) % 360 / 30)];
      const open = cur.open, m = cur.mouth, parts = [];
      parts.push(`glowing ${hueName(cur.hue)} lines on a dark screen, showing the mood "${mood}"`);
      parts.push(`two big round eyes with rings around them, ${open < 0.2 ? "almost shut" : open < 0.5 ? "half-lidded" : open > 0.92 ? "wide open" : "open"}, looking ${Math.abs(look.x) < 0.2 && Math.abs(look.y) < 0.2 ? "straight ahead" : `${look.y < -0.2 ? "up" : look.y > 0.2 ? "down" : ""}${look.x < -0.2 ? " to the viewer's left" : look.x > 0.2 ? " to the viewer's right" : ""}`.trim()}`);
      parts.push(`eyebrows ${cur.browA > 0.4 ? "angled down in a scowl" : cur.browA < -0.4 ? "tilted up in worry" : cur.browY < -0.3 ? "raised" : cur.browY > 0.3 ? "lowered" : "level"}`);
      parts.push(`a mouth with two lips, ${mg.open > 0.5 ? "wide open with teeth showing" : mg.open > 0.12 ? "open" : "closed"}, ${m > 0.5 ? "in a big smile" : m > 0.15 ? "in a small smile" : m < -0.5 ? "in a deep frown" : m < -0.15 ? "turned down" : "flat"}`);
      parts.push("a small nose, a jawline with little nodes at the temples, cheekbones and jaw, a hexagon node on the chin, a diamond sensor on the forehead, two pointed ears on top and a meter in a capsule on each side of your head");
      if (cur.blush > 0.3) parts.push("blushing cheeks");
      if (cur.tear > 0.5) parts.push("tears");
      if (cur.zzz > 0.5) parts.push("little Z's floating up");
      const Hd = window.Hands;
      if (Hd) parts.push(!Hd.shown ? "your hands are put away" : Hd.playing ? `your two floating hands are doing "${Hd.playing.replace(/_/g, " ")}"` : "your two floating hands rest below your chin");
      return parts.join("; ") + ".";
    },
    setNightDim(v) { nightDim = clamp(v, 0, 0.7); },
    setIdleDim(v) { idleDim = clamp(v, 0, 0.8); },                  // nobody around: dim the screen (saves battery and the display)
    effect(name, seconds = 6) { fx = { name, until: nowMs() + Math.min(seconds, 60) * 1000 }; lastActivity = nowMs(); },
    flash(on) { flashOn = !!on; },
    effects: ["disco", "rainbow", "dance", "dizzy", "heart_eyes", "shades", "laser_eyes", "glitch_storm", "sparkle", "strobe"],
    // something outside (the camera tracker) wants her to look at x,y in -1..1 (right / down positive)
    lookAt(x, y, ms = 700) { if (!gest) ext = { x: clamp(x, -1, 1), y: clamp(y, -1, 1), until: nowMs() + ms }; },
    onTouch: null,
    touching: () => !!gest,                                   // a finger is on her face right now
    setMood(m) { if (MOODS[m]) { mood = m; lastActivity = performance.now(); } },
    setTalking(on) { st.talking = !!on; lastActivity = performance.now(); },
    kick() { kickV = 1; },
    setState(name, on) {
      if (name === "thinking") {
        if (on && !st._thinking) prim.thinkSince = nowMs();
        if (!on && st._thinking) { if (nowMs() - prim.thinkSince > 600) prim.ahaUntil = nowMs() + 380; prim.thinkSince = 0; prim.thinkKind = "online"; }
      }
      st["_" + name] = !!on; if (on) lastActivity = performance.now();
    },
    thinkStyle(kind) { prim.thinkKind = kind; },
    // primitives for behaviors.js (see the list at the top of that file)
    prim: {
      gaze(x, y, { ms = 900, snap = false, overshoot = false } = {}) {
        x = clamp(x, -1, 1); y = clamp(y, -1, 1);
        if (snap) prim.snapUntil = nowMs() + 250;
        if (overshoot) {                                           // land a little past the target, then correct
          ext = { x: clamp(x * 1.18 + Math.sign(x) * 0.05, -1, 1), y: clamp(y * 1.18, -1, 1), until: nowMs() + 110 };
          setTimeout(() => { ext = { x, y, until: nowMs() + ms }; }, 110);
        } else ext = { x, y, until: nowMs() + ms };
      },
      blink({ ms = 130, double = false, side = null } = {}) {
        prim.blinkMs = ms; blink.phase = 1; blink.t = 0; blink.double = double; blink.wink = false;
        if (side) { eyeShut = { side: side === "left" ? -1 : 1, until: nowMs() + ms * 2 }; blink.phase = 0; }
      },
      squint(l = 1, r = 1, ms = 1200) { prim.sqTL = clamp(l, 0, 1.2); prim.sqTR = clamp(r, 0, 1.2); prim.sqUntil = nowMs() + ms; },
      pupils(mult = 1, ms = 1500) { prim.pupilT = clamp(mult, 0.4, 1.8); prim.pupilUntil = nowMs() + ms; },
      freeze(ms = 300) { prim.freezeUntil = nowMs() + ms; },
      saccades(amp = 1, rate = 1) { prim.saccAmp = amp; prim.saccRate = rate; },
      wander(scale = 1, speed = 1) { prim.wander = scale; prim.eyeSpeed = speed; },
      chew(on, rate = 1.6) { prim.chewOn = !!on; prim.chewRate = rate; },
      swallow() { prim.swallowT = 0; },
      tremble(amount = 1, ms = 600) { prim.tremble = amount; prim.trembleUntil = nowMs() + ms; },
      yawn(seconds = 2.4) { prim.yawnDur = seconds; prim.yawnT = 0; },
      tilt(amount = 0.12, ms = 1500) { prim.tiltT = clamp(amount, -0.35, 0.35); prim.tiltUntil = nowMs() + ms; },          // radians; + = clockwise
      lean(amount = 1, ms = 1500) { prim.leanT = clamp(amount, -1.5, 1.5); prim.leanUntil = nowMs() + ms; },               // + toward you, - away
      converge(amount = 0) { prim.convT = clamp(amount, 0, 1); },
      ears(l = 0, r = 0, ms = 1500) { prim.earTL = clamp(l, -1, 1); prim.earTR = clamp(r, -1, 1); prim.earUntil = nowMs() + ms; },   // -1 drooped .. 1 perked
      earTwitch() { prim.earTw = 1; },
      beat(bpm, t0) { prim.beat = bpm ? { bpm, t0: t0 ?? nowMs() } : null; },
      level(v) { prim.level = v == null ? null : clamp(v, 0, 1); },
      puff(n = 1) { for (let i = 0; i < n; i++) prim.puffs.push({ life: -i * 0.15, x: rand(-0.1, 0.1), s: rand(0.7, 1.3) }); },
      hold(props, ms) { trans = { until: nowMs() + ms, props }; },
      shakeFace(ms = 300) { shakeUntil = nowMs() + ms; },
      state() { return { ...prim, puffs: prim.puffs.length, look: { x: look.x, y: look.y }, talking: st.talking, listening: !!st._listening, thinking: !!st._thinking, mood }; }
    },
    setLabel(text) { st.label = text || ""; },
    poke() { lastActivity = performance.now(); },
    moods: Object.keys(MOODS)
  };
  resize();
  requestAnimationFrame(frame);
})();
