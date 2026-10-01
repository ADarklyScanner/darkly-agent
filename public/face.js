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
  const fxOn = n => fx.name === n && nowMs() < fx.until;
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
    hexHue = -999;
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
  function glow(on, blur = 0.08) { ctx.shadowColor = on ? col(5, 0.9) : "transparent"; ctx.shadowBlur = on ? U * blur : 0; }
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
    if (t > look.next) {
      look.tx = rand(-0.5, 0.5); look.ty = rand(-0.35, 0.35);
      if (Math.random() < 0.3) { look.tx = 0; look.ty = 0; }
      look.next = t + rand(0.8, 3.5);
    }
    let tx = look.tx, ty = look.ty;
    const following = ext && nowMs() < ext.until;
    if (following) { tx = ext.x; ty = ext.y; }
    else if (st._thinking) { tx = 0.55 + 0.1 * Math.sin(t * 1.3); ty = -0.6; }
    if (st.talking && !following) { tx *= 0.3; ty *= 0.3; }
    if (!following) { tx += tiltIn.x * 0.6; ty += tiltIn.y * 0.4; }
    const lk = 1 - Math.exp(-dt * 12);
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
      const T = 130, v = blink.t < T ? blink.t / T : blink.t < 2 * T ? 1 - (blink.t - T) / T : 0;
      blink.L = blink.wink ? 0 : v; blink.R = v;
      if (blink.t >= 2 * T) {
        if (blink.double) { blink.double = false; blink.t = 0; }
        else { blink.phase = 0; blink.t = 0; blink.next = rand(2200, 6000); blink.L = blink.R = 0; }
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
  function background(t) {
    const g = ctx.createRadialGradient(CX, CY, U * 0.2, CX, CY, Math.max(W, H) * 0.8);
    g.addColorStop(0, `hsla(${cur.hue},60%,${12 * cur.dim}%,1)`);
    g.addColorStop(1, "#05020a");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    if (Math.abs(((cur.hue - hexHue + 540) % 360) - 180) > 8 || !hexLayer) buildHex(Math.round(cur.hue));
    ctx.save(); ctx.globalAlpha = (0.05 + 0.025 * Math.sin(t * 0.7)) * cur.dim;
    ctx.drawImage(hexLayer, 0, 0, W, H); ctx.restore();

    // circuit traces with light pulses running toward her face
    ctx.save(); ctx.lineWidth = 1;
    for (const tr of traces) {
      ctx.strokeStyle = col(-10, 0.12 * cur.dim);
      ctx.beginPath(); tr.pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
      const [ex, ey] = tr.pts[tr.pts.length - 1];
      ctx.fillStyle = col(0, 0.25 * cur.dim); ctx.beginPath(); ctx.arc(ex, ey, 2, 0, TAU); ctx.fill();
      const [px, py] = pointOnTrace(tr, tr.p);
      ctx.fillStyle = col(20, 0.7 * cur.dim); glow(true, 0.05);
      ctx.beginPath(); ctx.arc(px, py, 1.6, 0, TAU); ctx.fill(); glow(false);
    }
    ctx.restore();

    for (const p of particles) {
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
    const bx = Math.min(1.12 * U, W / 2 / 1.02 - 10), top = -0.82 * U, bot = 0.78 * U, L = 0.16 * U;
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
    // side meters
    for (const s of [-1, 1]) {
      for (let i = 0; i < 8; i++) {
        const on = (Math.sin(t * 3 + i * 0.8 + s) + 1) / 2 > 0.45 + 0.05 * i;
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
    const open = cur.open * (1 - bl) * (st._thinking ? 0.9 : 1);
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
    const px = crossed ? -side * r * 0.4 : look.x * r * 0.38, py = crossed ? r * 0.05 : look.y * r * 0.32;
    const ig = ctx.createRadialGradient(px, py, r * 0.05, px, py, r * 1.05);
    ig.addColorStop(0, col(25, 1)); ig.addColorStop(0.45, col(0, 0.95)); ig.addColorStop(0.85, col(-30, 0.9)); ig.addColorStop(1, "rgba(0,0,0,1)");
    ctx.fillStyle = ig; ctx.beginPath(); ctx.arc(px * 0.6, py * 0.6, r * 0.95, 0, TAU); ctx.fill();
    // iris spokes
    ctx.save(); ctx.translate(px, py); ctx.rotate(t * 0.25 * cur.spin * side);
    ctx.strokeStyle = col(30, 0.22); ctx.lineWidth = 1;
    const pr = r * (0.2 + cur.pupil * 0.3) * (1 + 0.15 * st.listening);
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
    const low = clamp(cur.low + bl * 0.15, 0, 1);
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

  function mouth(t) {
    const N = 30, w = 0.66 * U * cur.mouthW, my = 0.45 * U;
    const cy = f => my + cur.mouth * 0.11 * U * (1 - f * f) + cur.skew * 0.05 * U * f + cur.question * 0.018 * U * Math.sin(f * 6 + t * 3);
    // faint baseline
    ctx.strokeStyle = col(0, 0.25 * cur.dim); ctx.lineWidth = 1;
    ctx.beginPath(); for (let i = 0; i <= 40; i++) { const f = i / 20 - 1; ctx.lineTo(f * w / 2, cy(f)); } ctx.stroke();
    // equalizer bars, drawn as one shape so the glow is cheap
    ctx.beginPath();
    const bw = (w / N) * 0.55;
    for (let i = 0; i < N; i++) {
      const f = i / (N - 1) * 2 - 1, x = f * w / 2;
      let h = U * 0.014 + U * 0.006 * (1 + Math.sin(t * 2 + i * 0.5));
      h += amp * (0.3 + 0.7 * noise(i, t)) * (1 - 0.6 * f * f) * 0.17 * U;
      h += st.listening * Math.abs(Math.sin(t * 5 + i * 0.45)) * 0.035 * U;
      ctx.roundRect(x - bw / 2, cy(f) - h / 2, bw, h, bw / 2);
    }
    glow(true, 0.07); ctx.fillStyle = col(12, 0.95 * cur.dim); ctx.fill(); glow(false);
    // end brackets
    ctx.strokeStyle = col(10, 0.5 * cur.dim); ctx.lineWidth = 2;
    for (const s of [-1, 1]) {
      const x = s * (w / 2 + U * 0.05), y = cy(s);
      ctx.beginPath(); ctx.moveTo(x - s * U * 0.02, y - U * 0.05); ctx.lineTo(x, y - U * 0.05); ctx.lineTo(x, y + U * 0.05); ctx.lineTo(x - s * U * 0.02, y + U * 0.05); ctx.stroke();
    }
  }

  function cheeks(t) {
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
      ctx.fillStyle = `rgba(255,200,0,${0.05 * st.offline})`; ctx.fillRect(0, 0, W, H);
      ctx.font = `${Math.round(U * 0.05)}px ui-monospace, monospace`; ctx.textAlign = "center";
      ctx.fillStyle = `rgba(255,210,60,${0.8 * st.offline})`;
      ctx.fillText("OFFLINE BRAIN", CX, CY - 0.95 * U);
    }
    // scan lines + a slow bright band rolling down
    ctx.save(); ctx.globalAlpha = 0.22; ctx.fillStyle = scanPattern; ctx.fillRect(0, 0, W, H); ctx.restore();
    const by = ((t * 0.12) % 1.3) * H - 0.15 * H;
    const g = ctx.createLinearGradient(0, by, 0, by + H * 0.12);
    g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.5, `hsla(${cur.hue},100%,80%,0.05)`); g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g; ctx.fillRect(0, by, W, H * 0.12);
    // vignette
    const v = ctx.createRadialGradient(CX, H / 2, Math.min(W, H) * 0.35, CX, H / 2, Math.max(W, H) * 0.75);
    v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,0.6)");
    ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
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
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const t = now / 1000;
    if (canvas.clientWidth !== Math.round(W) || canvas.clientHeight !== Math.round(H)) resize();
    update(dt, t);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    background(t);
    ctx.save();
    const shk = now < shakeUntil ? U * 0.025 : 0;
    ctx.translate(CX + rand(-shk, shk), CY + Math.sin(t * 0.9) * U * 0.012 - st.thinking * U * 0.02 + rand(-shk, shk));
    if (fxOn("dance") || fxOn("disco")) {
      ctx.translate(Math.sin(t * 4.2) * U * 0.06, -Math.abs(Math.sin(t * 8.4)) * U * 0.06);
      ctx.rotate(Math.sin(t * 4.2) * 0.09);
    }
    if (fxOn("dizzy")) ctx.rotate(Math.sin(t * 3) * 0.12);
    ctx.rotate(tiltIn.x * 0.05 + Math.sin(t * 0.5) * 0.012 + cur.skew * 0.02);
    const breathe = 1 + Math.sin(t * 1.1) * 0.01;
    ctx.scale(breathe, breathe);
    hud(t);
    cheeks(t);
    eye(-1, t); eye(1, t);
    if (fxOn("heart_eyes")) hearts(t);
    if (fxOn("laser_eyes")) lasers(t);
    brows();
    if (fxOn("shades")) shades(t);
    mouth(t);
    extras(t);
    ctx.restore();
    if (highlight && nowMs() < highlight.until) {
      const a = (highlight.until - nowMs()) / highlight.ms;
      ctx.save(); ctx.shadowColor = "#fff"; ctx.shadowBlur = U * 0.15;
      ctx.fillStyle = `hsla(${highlight.hue},100%,70%,${0.65 * a})`;
      ctx.beginPath(); ctx.arc(CX + highlight.x * U, CY + highlight.y * U, U * 0.22, 0, TAU); ctx.fill(); ctx.restore();
    }
    if (nightDim > 0.01) { ctx.fillStyle = `rgba(0,0,0,${nightDim})`; ctx.fillRect(0, 0, W, H); }
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
    const fx = (x - CX) / U, fy = (y - CY) / U, her = fx < 0 ? "right" : "left";
    if (Math.hypot(Math.abs(fx) - 0.42, fy + 0.12) < 0.33) return her + " eye";
    if (fy < -1.15) return "top of your head";
    if (fy < -0.62) return "forehead";
    if (fy < -0.38 && Math.abs(fx) > 0.12 && Math.abs(fx) < 0.75) return her + " eyebrow";
    if (Math.abs(fx) < 0.16 && fy < 0.28) return "nose";
    if (Math.abs(fx) < 0.46 && fy >= 0.28 && fy < 0.62) return "mouth";
    if (Math.abs(fx) < 0.55 && fy >= 0.62 && fy < 1.05) return "chin";
    if (fy >= 1.05) return "neck";
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
    noBlink(seconds) { noBlinkUntil = nowMs() + seconds * 1000; },
    eyeSize(mult) { eyeScale = clamp(eyeScale * mult, 0.65, 1.5); return eyeScale; },
    resetEyes() { eyeScale = 1; },
    // light up a spot on her face (for games): zone names like the touch zones
    highlightZone(zone, ms = 500, hue = 50) {
      const Z = { "left eye": [0.42, -0.12], "right eye": [-0.42, -0.12], nose: [0, 0.08], mouth: [0, 0.45], "left cheek": [0.7, 0.2], "right cheek": [-0.7, 0.2], forehead: [0, -0.85], chin: [0, 0.8] };
      const p = Z[zone]; if (!p) return;
      highlight = { x: p[0], y: p[1], until: nowMs() + ms, ms, hue };
    },
    setNightDim(v) { nightDim = clamp(v, 0, 0.7); },
    effect(name, seconds = 6) { fx = { name, until: nowMs() + Math.min(seconds, 60) * 1000 }; lastActivity = nowMs(); },
    flash(on) { flashOn = !!on; },
    effects: ["disco", "rainbow", "dance", "dizzy", "heart_eyes", "shades", "laser_eyes", "glitch_storm", "sparkle", "strobe"],
    // something outside (the camera tracker) wants her to look at x,y in -1..1 (right / down positive)
    lookAt(x, y, ms = 700) { if (!gest) ext = { x: clamp(x, -1, 1), y: clamp(y, -1, 1), until: nowMs() + ms }; },
    onTouch: null,
    setMood(m) { if (MOODS[m]) { mood = m; lastActivity = performance.now(); } },
    setTalking(on) { st.talking = !!on; lastActivity = performance.now(); },
    kick() { kickV = 1; },
    setState(name, on) { st["_" + name] = !!on; if (on) lastActivity = performance.now(); },
    setLabel(text) { st.label = text || ""; },
    poke() { lastActivity = performance.now(); },
    moods: Object.keys(MOODS)
  };
  resize();
  requestAnimationFrame(frame);
})();
