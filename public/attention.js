// One attention system. Everything that wants her eyes (a face, a moving thing, a fingertip, a bang, a new object,
// a light) makes an OFFER with how important it is. A single arbiter picks the winner, so things compete instead of
// each part of her yanking her eyes around separately.
//  - the current target gets a little loyalty, so she doesn't flicker between two similar things
//  - attention wears off: the longer she stares at one thing, the easier it is for something else to win
//  - a new target is a quick jump (with a blink on big jumps, like people do); the same target is smooth following
//  - she knows what she's looking at ("Attention: his fingertip"), and that goes to her brain too
(() => {
  "use strict";
  const A = window.Attention = { current: null, log: [], enabled: true, switches: 0 };
  const offers = new Map();                 // id → { x, y, sal, until, label }
  const worn = {};                          // id → seconds of staring that haven't worn off yet
  const now = () => performance.now();
  let last = now(), gaze = { x: 0, y: 0 };

  // x,y: where on her face-screen to look (-1..1). salience 0..1. ttl: how long the offer stands without being renewed.
  A.offer = (id, { x, y, salience = 0.5, ttl = 400, label = id } = {}) => {
    if (x == null || y == null || Number.isNaN(x) || Number.isNaN(y)) return;
    offers.set(id, { id, x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)), sal: salience, until: now() + ttl, label });
  };
  A.drop = id => offers.delete(id);
  A.strength = id => { const o = offers.get(id); return o ? o.sal * (1 - 0.4 * Math.min(1, (worn[id] || 0) / 14)) + (A.current?.id === id ? 0.12 : 0) : 0; };

  function tick() {
    const t = now(), dt = Math.min(0.2, (t - last) / 1000); last = t;
    for (const [id, o] of offers) if (o.until < t) offers.delete(id);
    for (const id of Object.keys(worn)) { if (A.current?.id !== id) { worn[id] -= dt * 0.6; if (worn[id] <= 0) delete worn[id]; } }
    if (!A.enabled || !window.Face?.prim || Face.touching?.()) return;
    let win = null, best = 0;
    for (const id of offers.keys()) { const s = A.strength(id); if (s > best) { best = s; win = offers.get(id); } }
    if (!win) { if (A.current) { A.current = null; } return; }                 // nothing wants her eyes: the face idles on its own
    if (A.current?.id !== win.id) {
      const jump = Math.hypot(win.x - gaze.x, win.y - gaze.y);
      Face.prim.gaze(win.x, win.y, { ms: 350, snap: true, overshoot: jump > 0.6 });
      if (jump > 0.9) Face.prim.blink({ ms: 90 });                               // people blink on big gaze shifts
      A.switches++; A.log.push({ t: Date.now(), to: win.id, label: win.label, jump: +jump.toFixed(2) }); if (A.log.length > 40) A.log.shift();
      A.current = { id: win.id, label: win.label, since: t };
    } else Face.lookAt(win.x, win.y, 350);                                        // smooth following
    gaze = { x: win.x, y: win.y };
    worn[win.id] = (worn[win.id] || 0) + dt;
  }
  setInterval(tick, 60);
  A.tick = tick;
  A.describe = () => A.current ? `Attention: on ${A.current.label} (for ${Math.round((now() - A.current.since) / 1000)}s)` : "";
})();
