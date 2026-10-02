// Which way things move. Plain frame-differencing only says "something changed"; this works out direction:
//  - something crossing her view left-to-right or right-to-left (her eyes lead ahead of it),
//  - the whole picture sliding (she's being turned or carried),
//  - the picture rushing outward from the middle (something coming at her face fast: she flinches).
// It's block-matching optical flow on the tiny 64x48 frames the camera tracker already makes, so it costs almost nothing.
(() => {
  "use strict";
  const W = 64, H = 48, B = 8, R = 4;              // 8x8 blocks, search up to 4 pixels each way
  const F = window.Flow = { last: null, enabled: true };

  // Motion of each textured block between two grayscale frames. Returns [{ bx, by, mx, my }].
  function blocks(prev, cur) {
    const out = [];
    for (let by = 0; by + B <= H; by += B) for (let bx = 0; bx + B <= W; bx += B) {
      let mean = 0; for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) mean += cur[(by + y) * W + bx + x]; mean /= B * B;
      let tex = 0; for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) tex += Math.abs(cur[(by + y) * W + bx + x] - mean);
      if (tex < 500) continue;                       // a blank wall tells you nothing about motion
      let best = Infinity, zero = Infinity, mx = 0, my = 0;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const px = bx - dx, py = by - dy; if (px < 0 || py < 0 || px + B > W || py + B > H) continue;
        let sad = 0; for (let y = 0; y < B && sad < best; y++) for (let x = 0; x < B; x++) sad += Math.abs(cur[(by + y) * W + bx + x] - prev[(py + y) * W + px + x]);
        if (dx === 0 && dy === 0) zero = sad;
        if (sad < best) { best = sad; mx = dx; my = dy; }
      }
      if (best > zero * 0.8) { mx = 0; my = 0; }      // not clearly better than "didn't move"
      if (best > tex * 1.5) continue;                 // no good match anywhere: lighting change or noise
      out.push({ bx: bx + B / 2, by: by + B / 2, mx, my });
    }
    return out;
  }
  const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

  // One reading: { global: {x,y}, object: {x,y,cx,cy,n}|null, loom, textured }
  function analyze(prev, cur) {
    const v = blocks(prev, cur); if (v.length < 4) return { global: { x: 0, y: 0 }, object: null, loom: 0, textured: v.length };
    const gx = median(v.map(b => b.mx)), gy = median(v.map(b => b.my));
    const agree = v.filter(b => Math.abs(b.mx - gx) <= 1 && Math.abs(b.my - gy) <= 1).length / v.length;
    const global = agree > 0.6 && (gx || gy) ? { x: gx, y: gy } : { x: 0, y: 0 };
    const movers = v.filter(b => Math.hypot(b.mx - global.x, b.my - global.y) >= 2);
    let object = null;
    if (!global.x && !global.y && movers.length >= 2 && movers.length < v.length * 0.6) {      // (while she's the one moving, everything "moves")
      const n = movers.length; object = { x: 0, y: 0, cx: 0, cy: 0, n };
      for (const b of movers) { object.x += (b.mx - global.x) / n; object.y += (b.my - global.y) / n; object.cx += b.bx / n; object.cy += b.by / n; }
    }
    // looming: do the blocks move away from the middle of the picture?
    let rad = 0, moving = 0;
    for (const b of v) { const rx = b.bx - W / 2, ry = b.by - H / 2, rl = Math.hypot(rx, ry) || 1; if (b.mx || b.my) moving++; rad += (b.mx * rx + b.my * ry) / rl; }
    const loom = moving / v.length > 0.4 ? rad / v.length : 0;
    return { global, object, loom, textured: v.length };
  }
  F.analyze = analyze; F.blocks = blocks;

  // ---------------- what she makes of it, frame after frame ----------------
  let passRun = 0, passDir = 0, shiftRun = 0, shiftDir = 0, loomRun = 0;
  const cool = {}; const ready = (k, ms) => { const t = performance.now(); if (t - (cool[k] || -1e9) < ms) return false; cool[k] = t; return true; };
  F.feed = (prev, cur, mirrored) => {
    if (!F.enabled || !prev) return null;
    const r = analyze(prev, cur), flip = mirrored ? -1 : 1;
    F.last = r;
    // something crossing her view. Left/right in the picture are HER left/right; her drawn eyes are mirrored when
    // the front camera is in use (the screen faces the other way).
    const ox = r.object ? r.object.x : 0, dir = Math.abs(ox) >= 1.5 ? Math.sign(ox) : 0;
    if (dir && dir === passDir) passRun++; else { passRun = dir ? 1 : 0; passDir = dir; }
    if (passRun >= 3 && ready("pass", 8000)) {
      const y = r.object.cy / (H / 2) - 1;
      if (!window.Mind?.distracted?.()) { if (window.Mind?.glance) Mind.glance(dir * flip, y * 0.6, 900); else window.Face?.lookAt(dir * flip, y * 0.6, 900); }   // look where it's heading, not where it was
      F.onEvent?.("pass", dir > 0 ? "from your left to your right" : "from your right to your left");
    }
    // the whole view sliding: she's the one moving. The picture slides right when she turns left.
    const gx = r.global.x, sdir = Math.abs(gx) >= 2 ? Math.sign(gx) : 0;
    if (sdir && sdir === shiftDir) shiftRun++; else { shiftRun = sdir ? 1 : 0; shiftDir = sdir; }
    if (shiftRun >= 4 && ready("shift", 10000)) F.onEvent?.("turned", sdir > 0 ? "to your left" : "to your right");
    if (shiftRun >= 2) window.Attention?.offer("steady", { x: sdir * flip * 0.6, y: 0, salience: 0.6, ttl: 300, label: "keeping her eyes steady while she's turned" });
    // something rushing at her
    loomRun = r.loom > 1.4 ? loomRun + 1 : 0;
    if (loomRun >= 2 && ready("loom", 6000)) F.onEvent?.("loom", "");
    return r;
  };
  F.onEvent = (kind, detail) => {
    if (kind === "pass") window.Mind?.event("motion", `something moved across your view ${detail}`, { source: "SAW", salience: 0.3 });
    if (kind === "turned") window.Mind?.event("moved", `your whole view swung: you're being turned ${detail}`, { source: "SAW", salience: 0.35 });
    if (kind === "loom") {
      window.Face?.prim?.squint(0.25, 0.25, 500); window.Behaviors?.startle?.(0.6, [0, 0]);
      if (typeof react === "function") react("loom", "something came rushing right at your face", 2);
    }
  };
})();
