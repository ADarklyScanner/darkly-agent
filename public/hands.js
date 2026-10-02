// Nessari's hands: two floating gloves she can gesture with. They're not attached to anything (no arms), they
// rest below her chin, drift a little, move while she talks, and do real gestures: wave, thumbs up, point,
// count on her fingers, cover her eyes, stroke her chin while she thinks, shrug, facepalm, high five.
//
// face.js calls Hands.frame() once per drawn frame, after the face, and hands us its drawing tools so the hands
// match the face (same colors, same glow). Everything is in "face units": x is how far out from the middle
// (so one pose works for both hands, mirrored), y is down from the middle of her face.
(() => {
  "use strict";
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const now = () => performance.now();

  // ---- finger shapes: how curled each finger is, 0 = straight, 1 = folded. Order: thumb, index, middle, ring, pinky ----
  const F = {
    open: [0, 0, 0, 0, 0], relaxed: [0.3, 0.3, 0.35, 0.42, 0.5], fist: [1, 1, 1, 1, 1], flat: [0.15, 0, 0, 0, 0],
    point: [1, 0, 1, 1, 1], peace: [1, 0, 0, 1, 1], three: [1, 0, 0, 0, 1], four: [1, 0, 0, 0, 0],
    thumb: [0, 1, 1, 1, 1], rock: [1, 0, 1, 1, 0], gun: [0, 0, 1, 1, 1], ok: [0.72, 0.82, 0, 0, 0], pinch: [0.6, 0.7, 0.9, 1, 1], call: [0, 1, 1, 1, 0]
  };
  const COUNT = [F.fist, F.point, F.peace, F.three, F.four, F.open];
  const REST = { x: 0.5, y: 1.26, rot: -0.28, s: 1.0, a: 0.75, f: F.relaxed, spread: 0.4 };
  const AWAY = { x: 0.5, y: 1.8, rot: -0.28, s: 0.7, a: 0, f: F.relaxed, spread: 0.4 };

  // ---- gestures: a list of moments; each says where a hand goes and what shape it makes. A hand not named rests. ----
  // wob = a wobble on top of the pose: { rot | x | y: size, hz }, or { drum: hz } for tapping fingers.
  const up = (o = {}) => ({ x: 0.64, y: 0.76, rot: 0, s: 1.15, a: 1, f: F.open, spread: 0.6, ...o });
  const G = {
    wave:        { dur: 2.0, frames: [{ at: 0, R: up({ x: 0.72, y: 0.72, spread: 1, wob: { rot: 0.4, hz: 3.1 } }) }] },
    thumbs_up:   { dur: 1.9, frames: [{ at: 0, R: up({ rot: 0.95, s: 1.25, f: F.thumb }) }, { at: 0.25, R: up({ y: 0.7, rot: 0.95, s: 1.3, f: F.thumb }) }] },
    thumbs_down: { dur: 1.9, frames: [{ at: 0, R: up({ rot: 0.95 + Math.PI, s: 1.25, f: F.thumb }) }] },
    point_up:    { dur: 1.8, frames: [{ at: 0, R: up({ y: 0.7, f: F.point }) }] },
    point_left:  { dur: 1.8, frames: [{ at: 0, L: up({ x: 0.7, rot: 1.45, f: F.point }) }] },
    point_right: { dur: 1.8, frames: [{ at: 0, R: up({ x: 0.7, rot: 1.45, f: F.point }) }] },
    peace:       { dur: 2.0, frames: [{ at: 0, R: up({ rot: 0.1, f: F.peace, spread: 1, wob: { rot: 0.08, hz: 2 } }) }] },
    rock_on:     { dur: 2.0, frames: [{ at: 0, R: up({ f: F.rock, spread: 0.9, wob: { rot: 0.22, hz: 4 } }) }] },
    ok:          { dur: 1.8, frames: [{ at: 0, R: up({ f: F.ok, spread: 0.8 }) }] },
    call_me:     { dur: 2.0, frames: [{ at: 0, R: up({ x: 0.72, y: 0.3, rot: 0.9, f: F.call, wob: { rot: 0.1, hz: 3 } }) }] },
    finger_gun:  { dur: 1.8, frames: [{ at: 0, R: up({ rot: -1.2, x: 0.5, f: F.gun }) }, { at: 0.5, R: up({ rot: -1.45, x: 0.5, f: F.gun }) }, { at: 0.65, R: up({ rot: -1.2, x: 0.5, f: F.gun }) }] },
    fist_pump:   { dur: 1.5, frames: [{ at: 0, R: up({ y: 0.85, f: F.fist }) }, { at: 0.25, R: up({ y: 0.55, f: F.fist }) }, { at: 0.5, R: up({ y: 0.82, f: F.fist }) }, { at: 0.75, R: up({ y: 0.55, f: F.fist }) }] },
    fist_shake:  { dur: 1.6, frames: [{ at: 0, R: up({ y: 0.7, f: F.fist, wob: { x: 0.05, hz: 7 } }) }] },
    clap:        { dur: 1.6, frames: [{ at: 0, L: up({ x: 0.2, y: 1.0, rot: -0.55, s: 1.1, spread: 0.1, wob: { x: 0.11, hz: 5 } }), R: up({ x: 0.2, y: 1.0, rot: -0.55, s: 1.1, spread: 0.1, wob: { x: 0.11, hz: 5 } }) }] },
    cover_eyes:  { dur: 2.4, frames: [{ at: 0, L: up({ x: 0.42, y: -0.1, rot: -0.12, s: 1.8, spread: 0.15 }), R: up({ x: 0.42, y: -0.1, rot: -0.12, s: 1.8, spread: 0.15 }) },
                                      { at: 1.5, L: up({ x: 0.42, y: -0.1, rot: -0.12, s: 1.8, spread: 1 }), R: up({ x: 0.42, y: -0.1, rot: -0.12, s: 1.8, spread: 1 }) }] },
    peekaboo:    { dur: 2.6, frames: [{ at: 0, L: up({ x: 0.42, y: -0.1, rot: -0.12, s: 1.8, spread: 0.15 }), R: up({ x: 0.42, y: -0.1, rot: -0.12, s: 1.8, spread: 0.15 }) },
                                      { at: 1.3, L: up({ x: 0.84, y: 0.2, rot: 0.5, s: 1.3, spread: 1, wob: { rot: 0.25, hz: 5 } }), R: up({ x: 0.84, y: 0.2, rot: 0.5, s: 1.3, spread: 1, wob: { rot: 0.25, hz: 5 } }) }] },
    cover_mouth: { dur: 1.9, frames: [{ at: 0, R: up({ x: 0.1, y: 0.47, rot: -1.25, s: 1.5, f: F.flat, spread: 0.1 }) }] },
    cover_ears:  { dur: 2.2, frames: [{ at: 0, L: up({ x: 0.9, y: -0.05, rot: 0.2, s: 1.3, spread: 0.3 }), R: up({ x: 0.9, y: -0.05, rot: 0.2, s: 1.3, spread: 0.3 }) }] },
    chin_stroke: { dur: 2.8, frames: [{ at: 0, R: up({ x: 0.2, y: 0.97, rot: -0.75, s: 1.1, f: [0.1, 0.25, 0.85, 0.95, 1], wob: { y: 0.03, hz: 1.3 } }) }] },
    shrug:       { dur: 1.8, frames: [{ at: 0, L: up({ x: 0.82, y: 0.6, rot: 0.95, spread: 0.6 }), R: up({ x: 0.82, y: 0.6, rot: 0.95, spread: 0.6 }) }, { at: 0.9, L: up({ x: 0.8, y: 0.74, rot: 0.8 }), R: up({ x: 0.8, y: 0.74, rot: 0.8 }) }] },
    facepalm:    { dur: 2.3, frames: [{ at: 0, R: up({ x: 0.1, y: -0.2, rot: -0.35, s: 2.1, spread: 0.35 }) }] },
    jazz_hands:  { dur: 1.7, frames: [{ at: 0, L: up({ x: 0.76, y: 0.68, spread: 1, wob: { rot: 0.3, hz: 6 } }), R: up({ x: 0.76, y: 0.68, spread: 1, wob: { rot: 0.3, hz: 6 } }) }] },
    drum:        { dur: 2.6, frames: [{ at: 0, R: { ...REST, y: 1.2, a: 1, rot: -0.9, wob: { drum: 3.2 } } }] },
    stop:        { dur: 1.7, frames: [{ at: 0, R: up({ x: 0.52, y: 0.72, s: 1.55, spread: 0.2 }) }] },
    salute:      { dur: 1.5, frames: [{ at: 0, R: up({ x: 0.7, y: -0.58, rot: -1.2, f: F.flat, spread: 0 }) }] },
    please:      { dur: 2.2, frames: [{ at: 0, L: up({ x: 0.09, y: 1.02, rot: -0.1, f: F.flat, spread: 0, wob: { y: 0.03, hz: 2 } }), R: up({ x: 0.09, y: 1.02, rot: -0.1, f: F.flat, spread: 0, wob: { y: 0.03, hz: 2 } }) }] },
    high_five:   { dur: 5.0, frames: [{ at: 0, R: up({ x: 0.58, y: 0.72, s: 1.6, spread: 0.5, wob: { y: 0.02, hz: 1.5 } }) }] },
    blow_kiss:   { dur: 1.8, frames: [{ at: 0, R: up({ x: 0.1, y: 0.47, rot: -1.25, s: 1.4, f: F.flat, spread: 0.1 }) }, { at: 0.6, R: up({ x: 0.86, y: 0.42, rot: 0.7, s: 1.25, spread: 0.8 }) }] },
    dance:       { dur: 3.0, frames: [{ at: 0, L: up({ x: 0.78, y: 0.7, f: F.fist, wob: { y: 0.12, hz: 2 } }), R: up({ x: 0.78, y: 0.7, f: F.fist, wob: { y: -0.12, hz: 2 } }) }] }
  };

  const mk = side => ({ side, cur: { ...AWAY, f: [...AWAY.f] }, tgt: { ...AWAY }, wob: null, bounce: 0 });
  const hands = { L: mk(-1), R: mk(1) };        // L = on the screen's left (her right hand), R = on the screen's right
  let shown = true, play = null, held = null, nextFidget = now() + 9000, thinkSince = 0, lastAuto = -1e9, lastMood = "", talkPh = 0, smoothAmp = 0;
  let env = null;

  const H = window.Hands = {
    list: Object.keys(G),
    get shown() { return shown; },
    show(on) { shown = !!on; },
    get busy() { return !!play; },
    get playing() { return play?.name || held || ""; },
    // Play a gesture by name. Returns how long it takes (seconds), or 0 if there's no such gesture.
    gesture(name, { hold = false } = {}) {
      name = String(name || "").toLowerCase().replace(/[\s-]+/g, "_");
      const g = G[name]; if (!g) return 0;
      play = { name, t0: now(), dur: hold ? 1e9 : g.dur, frames: g.frames, i: -1 };
      held = hold ? name : null;
      return g.dur;
    },
    // Hold a gesture until release() (chin-stroking while she thinks, a hand over her mouth while she yawns).
    hold(name) { if (held !== name) H.gesture(name, { hold: true }); },
    release(name) { if (held && (!name || held === name)) { held = null; play = null; } },
    // Show a number on her fingers, 0 to 10.
    count(n) {
      n = clamp(Math.round(Number(n) || 0), 0, 10);
      const R = up({ x: 0.62, y: 0.74, s: 1.2, f: COUNT[Math.min(5, n)], spread: 0.8 });
      const frames = [{ at: 0, R, ...(n > 5 ? { L: up({ x: 0.62, y: 0.74, s: 1.2, f: COUNT[n - 5], spread: 0.8 }), R: up({ x: 0.62, y: 0.74, s: 1.2, f: F.open, spread: 0.8 }) } : {}) }];
      play = { name: "count_" + n, t0: now(), dur: 2.6, frames, i: -1 }; held = null;
      return 2.6;
    },
    // Is that point on the screen on one of her hands? (Named from her side, like the rest of her face.)
    hit(px, py) {
      if (!env) return null;
      for (const h of [hands.R, hands.L]) {
        const c = h.cur; if (c.a < 0.3) continue;
        if (Math.hypot(px - (env.CX + h.side * c.x * env.U), py - (env.CY + c.y * env.U)) < 0.2 * env.U * c.s * 0.95) {
          h.bounce = 1;
          if (play?.name === "high_five") { play = null; setTimeout(() => H.gesture("fist_pump"), 250); try { window.Abilities?.sfx("boop"); } catch {} return (h.side > 0 ? "left" : "right") + " hand (a high five!)"; }
          return (h.side > 0 ? "left" : "right") + " hand";
        }
      }
      return null;
    },
    // A gesture that fits what she's saying, without asking the brain for one: "hi" waves, "I don't know" shrugs.
    fromText(text, { force = false } = {}) {
      const t = String(text || "").toLowerCase(); if (!t || (!force && (play || now() - lastAuto < 9000))) return "";
      const rules = [
        [/\b(hi|hello|hey there|howdy|good (morning|evening|night)|bye|goodbye|see you|welcome back)\b/, "wave"],
        [/\b(i (don'?t|do not) know|no idea|not sure|who knows|beats me|can'?t tell)\b/, "shrug"],
        [/\b(great job|well done|nice (one|work)|good job|nailed it|perfect|you got it|sounds good|deal)\b/, "thumbs_up"],
        [/\b(yay|woo+|hooray|let'?s go|awesome|amazing)\b/, "fist_pump"],
        [/\b(oops|whoops|uh[- ]oh|my bad|sorry)\b/, "cover_mouth"],
        [/\b(ugh|seriously|oh no|facepalm|unbelievable)\b/, "facepalm"],
        [/\b(stop|wait|hold on|hang on)\b/, "stop"],
        [/\b(please|pretty please|i beg)\b/, "please"],
        [/\b(peace|chill|relax)\b/, "peace"],
        [/\b(ta-?da+|behold|presenting)\b/, "jazz_hands"],
        [/\b(hmm+|let me think|thinking)\b/, "chin_stroke"],
        [/\b(mwah|kiss(es)?|love you)\b/, "blow_kiss"],
        [/\b(shh+|quiet|secret)\b/, "cover_mouth"]
      ];
      const num = t.match(/\b(?:that'?s|there (?:are|is)|i count(?:ed)?|you'?re holding up|holding up) (zero|one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\b/);
      if (num) { const w = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].indexOf(num[1]); const n = w >= 0 ? w : +num[1]; if (n <= 10) { lastAuto = now(); H.count(n); return "count_" + n; } }
      for (const [re, g] of rules) if (re.test(t)) { lastAuto = now(); H.gesture(g); return g; }
      return "";
    }
  };

  // ---- one frame: move, then draw ----
  H.frame = (e, t, dt) => {
    env = e;
    const { st, prim, cur: mood, amp } = e;
    smoothAmp = lerp(smoothAmp, amp, 1 - Math.exp(-dt * 5));
    // things she does with her hands without being told
    if (st._thinking) { if (!thinkSince) thinkSince = now(); else if (now() - thinkSince > 3200 && !play && shown) H.hold("chin_stroke"); }
    else { thinkSince = 0; H.release("chin_stroke"); }
    if (prim.yawn > 0.3 && !play && shown) H.hold("cover_mouth"); else if (prim.yawn < 0.1) H.release("cover_mouth");
    if (e.mood !== lastMood) {
      const was = lastMood; lastMood = e.mood;
      if (was && shown && !play && now() - lastAuto > 15000) {
        const g = { excited: "jazz_hands", confused: "shrug", angry: "fist_shake", bored: "drum", flirty: "blow_kiss" }[e.mood];
        if (g && Math.random() < 0.6) { lastAuto = now(); H.gesture(g); }
      }
    }
    // where each hand wants to be right now
    let poseL = null, poseR = null;
    if (play) {
      const el = (now() - play.t0) / 1000;
      if (el > play.dur) play = null;
      else {
        let i = play.i; while (i + 1 < play.frames.length && play.frames[i + 1].at <= el) i++;
        play.i = i;
        const fr = play.frames[Math.max(0, i)]; poseL = fr.L || null; poseR = fr.R || null;
      }
    }
    const idle = !play;
    if (idle && shown && !st.talking && now() > nextFidget) {          // a small fidget now and then
      nextFidget = now() + 9000 + Math.random() * 14000;
      if (e.mood !== "sleepy" && Math.random() < 0.7) { const h = Math.random() < 0.5 ? hands.L : hands.R; h.fidget = now() + 900; }
    }
    talkPh += dt * (st.talking ? 2.4 : 0.6);
    for (const h of [hands.L, hands.R]) {
      const pose = h === hands.L ? poseL : poseR;
      let tgt = pose || (shown ? REST : AWAY), wob = pose?.wob || null;
      if (!pose && shown) {
        tgt = { ...REST };
        const sleepy = clamp(1 - mood.open * 1.3, 0, 0.6), sad = clamp(-mood.mouth, 0, 1) * 0.4;
        tgt.y += sleepy * 0.14 + sad * 0.08; tgt.a = REST.a * (1 - sleepy * 0.7) * mood.dim;
        if (st.talking) {                                              // talking with her hands: they lift and open, taking turns
          const k = clamp(smoothAmp * 1.5, 0, 1), turn = 0.5 + 0.5 * Math.sin(talkPh + (h.side > 0 ? 0 : Math.PI));
          tgt.y -= (0.12 + 0.16 * turn) * k; tgt.x += 0.08 * turn * k; tgt.rot += 0.35 * turn * k; tgt.spread = 0.4 + 0.5 * k;
          tgt.f = REST.f.map(v => v * (1 - 0.7 * k * turn)); tgt.a = Math.max(tgt.a, 0.72 + 0.25 * k);
        }
        if (h.fidget && now() < h.fidget) wob = { drum: 4 };
      }
      const c = h.cur, k = 1 - Math.exp(-dt * (pose ? 12 : 7));
      for (const key of ["x", "y", "rot", "s", "a", "spread"]) c[key] = lerp(c[key], tgt[key], k);
      for (let i = 0; i < 5; i++) c.f[i] = lerp(c.f[i], tgt.f[i], 1 - Math.exp(-dt * 14));
      h.wob = wob; h.bounce *= Math.exp(-dt * 7);
      draw(h, e, t);
    }
  };

  // ---- drawing one hand ----
  // Drawn as the screen-right hand (thumb toward the middle of her face); the other one is the same thing mirrored.
  const FING = [{ x: -0.33, len: 0.72 }, { x: -0.11, len: 0.8 }, { x: 0.11, len: 0.74 }, { x: 0.33, len: 0.58 }];
  function draw(h, e, t) {
    const c = h.cur; if (c.a < 0.02) return;
    const { ctx, U, CX, CY, col, glow } = e, w = h.wob || {};
    const ph = t * TAU, side = h.side;
    const bob = Math.sin(t * 0.8 + side) * 0.012 + Math.sin(t * 0.9) * 0.008;        // floats a little; follows her breathing
    const x = CX + side * (c.x + (w.x ? w.x * Math.sin(ph * w.hz) : 0)) * U;
    const y = CY + (c.y + bob + (w.y ? w.y * Math.sin(ph * w.hz) : 0) - h.bounce * 0.05) * U;
    const s = 0.2 * U * c.s * (1 + h.bounce * 0.12);
    ctx.save();
    ctx.translate(x, y); ctx.scale(side > 0 ? 1 : -1, 1);
    ctx.rotate(c.rot + Math.sin(t * 0.6 + side * 1.3) * 0.04 + (w.rot ? w.rot * Math.sin(ph * w.hz) : 0));
    ctx.globalAlpha = clamp(c.a, 0, 1);
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    const fill = col(-25, 0.42), line = col(10, 0.9), fine = col(28, 0.55), lw = Math.max(1.2, U * 0.011);
    const solid = () => { ctx.fillStyle = "rgba(10,4,18,0.9)"; ctx.fill(); ctx.fillStyle = fill; ctx.fill(); };   // a dark base under the tint, so a hand over her eyes really covers them
    const curl = i => clamp(c.f[i] + (w.drum ? 0.45 * Math.max(0, Math.sin(ph * w.drum - i * 0.9)) : 0), 0, 1);

    // the cuff where a wrist would be, and a fading trail: nothing's attached
    ctx.strokeStyle = col(10, 0.6); ctx.lineWidth = lw;
    ctx.beginPath(); ctx.ellipse(0, 0.6 * s, 0.33 * s, 0.085 * s, 0, 0, TAU); ctx.stroke();
    for (let i = 1; i <= 3; i++) { ctx.fillStyle = col(20, 0.4 - i * 0.11); ctx.beginPath(); ctx.arc(Math.sin(t * 2 + i) * 0.03 * s, (0.72 + i * 0.13) * s, (0.05 - i * 0.01) * s, 0, TAU); ctx.fill(); }

    const thumbFolded = curl(0) > 0.55;
    const thumb = () => {
      const cu = curl(0);
      ctx.save(); ctx.translate(lerp(-0.44, -0.3, cu) * s, lerp(0.14, 0.02, cu) * s); ctx.rotate(lerp(-0.95, 1.25, cu));
      const len = 0.58 * s * (1 - 0.22 * cu), tw = 0.23 * s;
      ctx.fillStyle = fill; ctx.strokeStyle = line; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.roundRect(-tw / 2, -len, tw, len + tw * 0.4, tw / 2); solid(); ctx.stroke();
      ctx.strokeStyle = fine; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-tw * 0.3, -len * 0.5); ctx.lineTo(tw * 0.3, -len * 0.5); ctx.stroke();
      ctx.restore();
    };
    if (!thumbFolded) thumb();

    // fingers (behind the palm's top edge)
    for (let i = 0; i < 4; i++) {
      const f = FING[i], cu = curl(i + 1), len = f.len * s * (1 - 0.72 * cu), fw = 0.19 * s;
      ctx.save(); ctx.translate(f.x * s, -0.4 * s); ctx.rotate((i - 1.5) * 0.14 * c.spread * (1 - cu * 0.7));
      ctx.fillStyle = fill; ctx.strokeStyle = line; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.roundRect(-fw / 2, -len, fw, len + fw * 0.5, fw / 2); solid(); ctx.stroke();
      ctx.strokeStyle = fine; ctx.lineWidth = 1;
      if (cu < 0.6) { for (const q of [0.38, 0.68]) { ctx.beginPath(); ctx.moveTo(-fw * 0.3, -len * q); ctx.lineTo(fw * 0.3, -len * q); ctx.stroke(); } }
      else { ctx.beginPath(); ctx.arc(0, -len * 0.55, fw * 0.3, Math.PI, TAU); ctx.stroke(); }      // a knuckle, when it's folded
      ctx.fillStyle = col(30, 0.75 * (1 - cu * 0.6)); ctx.beginPath(); ctx.arc(0, -len + fw * 0.42, fw * 0.13, 0, TAU); ctx.fill();   // fingertip light
      ctx.restore();
    }

    // palm
    glow(true, 0.05);
    ctx.fillStyle = fill; ctx.strokeStyle = line; ctx.lineWidth = lw * 1.15;
    ctx.beginPath(); ctx.roundRect(-0.47 * s, -0.46 * s, 0.94 * s, 0.98 * s, [0.2 * s, 0.2 * s, 0.32 * s, 0.32 * s]); solid(); ctx.stroke();
    glow(false);
    // the core in her palm glows with her voice, with fine lines out to each finger
    ctx.strokeStyle = col(20, 0.3); ctx.lineWidth = 1;
    for (const f of FING) { ctx.beginPath(); ctx.moveTo(0, 0.06 * s); ctx.lineTo(f.x * s, -0.36 * s); ctx.stroke(); }
    ctx.strokeStyle = fine; ctx.beginPath(); ctx.arc(0, 0.06 * s, 0.17 * s, 0, TAU); ctx.stroke();
    glow(true, 0.05); ctx.fillStyle = col(28, 0.5 + 0.5 * Math.min(1, e.amp * 1.4 + h.bounce));
    ctx.beginPath(); ctx.arc(0, 0.06 * s, (0.07 + 0.05 * Math.min(1, e.amp + h.bounce)) * s, 0, TAU); ctx.fill(); glow(false);

    if (thumbFolded) thumb();
    ctx.restore();
  }
})();
