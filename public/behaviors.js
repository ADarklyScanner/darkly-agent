// Nessari's small embodied face behaviors. These aren't canned animations: each module combines the
// face primitives (Face.prim: gaze, blink, squint, pupils, freeze, saccades, wander, chew, swallow,
// tremble, puff, hold) in response to what she senses, so a few rules produce thousands of different moments.
//
// Modules: boot · inner-state tone (alert, concentrating, listening, bored, sleepy) · boredom fidgets ·
// charging ("politely chewing", swallowing, burp at 100%) · hunger at low battery · startle and recovery
// (with habituation and sensitization) · being shaken · falling · touch blinks · listening nods ·
// hearing her name · speaking (phrase blinks, glancing away on long sentences, emphasis, sarcasm) ·
// thinking styles · network trouble · social gaze (gaze aversion, smiling eyes, watching where you left,
// greeting by absence length) · light changes · curiosity about objects · peeking while asleep.
(() => {
  "use strict";
  const now = () => performance.now();
  const rand = (a, b) => a + Math.random() * (b - a);
  const chance = p => Math.random() < p;
  const P = () => Face.prim;
  const S = () => window.Mind?.S || {};
  const busyFace = () => typeof talking !== "undefined" && talking;
  const asleep = () => !!window.Mind?.isSleeping?.();
  const timers = new Set();
  const after = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); try { fn(); } catch (e) { console.error(e); } }, ms); timers.add(t); return t; };
  const cool = {}; const ready = (k, ms) => { if (now() - (cool[k] || -1e9) < ms) return false; cool[k] = now(); return true; };

  const B = window.Behaviors = { log: [], enabled: true };
  function did(name, detail = "") { B.log.push({ t: Date.now(), name, detail }); if (B.log.length > 60) B.log.shift(); }
  // Look somewhere and keep the camera tracker from immediately pulling her eyes back.
  function look(x, y, ms = 900, opts = {}) {
    if (window.Mind?.glance) Mind.glance(x, y, ms); else Face.lookAt(x, y, ms);
    if (opts.snap || opts.overshoot) P().gaze(x, y, { ms, ...opts });
  }

  // ---------------- boot: flutter awake, slowly open ----------------
  function boot() {
    P().squint(0.02, 0.02, 700); did("boot");
    after(750, () => P().blink({ ms: 70 })); after(980, () => P().blink({ ms: 70 })); after(1200, () => P().squint(0.5, 0.5, 600));
    after(1850, () => P().blink({ ms: 160 }));
  }

  // ---------------- inner state → how the eyes move ----------------
  let lastSleep = false, lookingSince = 0, lastFace = null, faceGoneAt = 0;
  function tone() {
    if (!B.enabled || !window.Face?.prim) return;
    const s = S(), st = P().state();
    const sleeping = asleep();
    if (sleeping) { P().saccades(0.3, 0.3); P().wander(0.3, 0.3); }
    else if (st.thinking) { P().saccades(0.4, 0.6); P().wander(1, 1); }                         // concentrating: steadier eyes
    else if (st.listening) { P().saccades(0.5, 0.7); P().wander(0.3, 1); }                         // listening: settle, stop idling
    else if ((s.alertness || 0) > 0.6 || (s.arousal || 0) > 0.65) { P().saccades(1.6, 1.8); P().wander(1, 1.3); }   // alert: quick darting eyes
    else if ((s.boredom || 0) > 0.6) { P().saccades(0.6, 0.5); P().wander(0.7, 0.35); }          // bored: slow drifting gaze
    else if (lowBattery()) { P().saccades(0.5, 0.4); P().wander(0.5, 0.4); }
    else { P().saccades(1, 1); P().wander(1, 1); }

    // waking: slow, heavy-lidded open
    if (lastSleep && !sleeping) { P().blink({ ms: 450 }); after(900, () => P().squint(0.55, 0.55, 1400)); did("slow-wake"); }
    if (!lastSleep && sleeping) { P().blink({ ms: 600 }); did("long-blink-to-sleep"); }
    lastSleep = sleeping;

    if (sleeping) { peekWhileAsleep(); return; }
    if (!busyFace() && !st.thinking && !st.listening) fidget(s);
    socialTick();
    presenceDim();
  }

  // ---------------- boredom fidgets (one at a time, never repeated back to back) ----------------
  let lastFidget = "";
  function fidget(s) {
    const bored = s.boredom || 0;
    if (bored < 0.45 || !ready("fidget", 9000 + (1 - bored) * 20000)) return;
    const options = [
      ["ceiling", () => look(rand(-0.3, 0.3), -0.95, 2200)],
      ["floor", () => look(rand(-0.4, 0.4), 0.95, 1800)],
      ["one-eye-droop", () => chance(0.5) ? P().squint(0.55, 1, 4000) : P().squint(1, 0.55, 4000)],
      ["both-droop", () => P().squint(0.7, 0.7, 5000)],
      ["pupil-play", () => { P().pupils(1.5, 700); after(800, () => P().pupils(0.6, 600)); after(1500, () => P().pupils(1, 300)); }],
      ["slow-blink", () => P().blink({ ms: 380 })],
      ["inspect-around", () => { look(-0.8, 0.2, 900); after(1100, () => look(0.7, -0.3, 900)); after(2200, () => look(0, 0, 400)); }]
    ];
    if (bored > 0.8 && ready("eyeroll", 600000)) options.push(["eye-roll", () => Face.gesture("eye_roll")]);
    const pool = options.filter(([n]) => n !== lastFidget);
    const [name, fn] = pool[Math.floor(Math.random() * pool.length)];
    lastFidget = name; fn(); did("bored:" + name);
  }

  // ---------------- charging: politely chewing ----------------
  let battery = null, plugTimes = [], swallowTimer = null, fullDone = false, hungryTimer = null;
  const lowBattery = () => battery && !battery.charging && battery.level <= 0.15;
  function chewRate() { const lv = battery?.level ?? 0.5; return (2.6 - 1.6 * lv) * (asleep() ? 0.5 : 1); }  // emptier = hungrier = faster
  function startCharging() {
    fullDone = battery.level >= 0.995;
    look(0, 1, 1100, { snap: true });                       // look toward the cable
    P().pupils(1.3, 1200); did("charging:look-at-cable");
    if (fullDone) return;
    after(900, () => { P().chew(true, chewRate() * 1.3); did("charging:chew-start"); });   // eager at first
    after(6000, () => P().chew(true, chewRate()));
    scheduleSwallow();
  }
  function scheduleSwallow() {
    clearTimeout(swallowTimer);
    swallowTimer = after(rand(7000, 14000), () => {
      if (!battery?.charging || fullDone) return;
      if (!busyFace()) {
        P().swallow(); did("charging:swallow");
        if (chance(0.4)) after(850, () => { P().blink({ ms: 320 }); P().hold({ low: 0.35, mouth: 0.5 }, 900); });   // satisfied
      }
      P().chew(true, chewRate());
      scheduleSwallow();
    });
  }
  function fullyCharged() {
    if (fullDone) return; fullDone = true;
    P().chew(false); P().swallow();
    after(700, () => { P().puff(2); P().hold({ mouth: 0.3, browY: -0.4 }, 500); did("charging:burp"); });
    after(1400, () => { P().blink({ ms: 340 }); P().hold({ open: 0.5, low: 0.4, mouth: 0.75, blush: 0.4 }, 2600); did("charging:full"); });
  }
  function unplugged() {
    P().chew(false); clearTimeout(swallowTimer);
    plugTimes = plugTimes.filter(t => now() - t < 30000);
    if (plugTimes.length >= 3) { P().squint(0.6, 0.6, 2000); P().hold({ browA: 0.7, browY: 0.4, mouth: -0.4 }, 2000); did("charging:fiddled-annoyed"); }
    else { P().squint(1.15, 1.15, 500); P().pupils(0.7, 600); did("charging:unplug-surprise"); }
  }
  function hunger() {
    clearTimeout(hungryTimer);
    if (!lowBattery()) return;
    hungryTimer = after(rand(40000, 90000) * Math.max(0.4, battery.level / 0.15), () => {
      if (lowBattery() && !busyFace() && !asleep()) {
        look(0, 0.9, 900); P().hold({ mouth: 0.15, browA: -0.4 }, 900); did("hungry-glance");
        if (battery.level <= 0.1) after(1200, () => P().blink({ ms: 420 }));          // sleepy half-blink
      }
      hunger();
    });
  }
  navigator.getBattery?.().then(b => {
    battery = b;
    b.addEventListener("chargingchange", () => { plugTimes.push(now()); if (b.charging) startCharging(); else { unplugged(); hunger(); } });
    P().level(b.level);                                     // her battery shows on the left side meter
    b.addEventListener("levelchange", () => { P().level(b.level); if (b.charging && b.level >= 0.995) fullyCharged(); if (b.charging) P().chew(!fullDone, chewRate()); hunger(); });
    if (b.charging && b.level < 0.995) after(2500, startCharging);
    hunger();
  }).catch(() => {});

  // ---------------- startle and recovery ----------------
  let startles = [], sensitizedUntil = 0, lastLoud = 0;
  function startle(strength = 0.8, dir = null, loudness = 0) {
    startles = startles.filter(t => now() - t < 90000);
    let k = strength * Math.pow(0.55, startles.length);                     // repeated harmless bangs matter less
    if (loudness && lastLoud && loudness > lastLoud * 1.5) k = Math.max(k, strength);   // ...unless it's suddenly much louder
    if (now() < sensitizedUntil) k = Math.min(1, k * 1.3);                   // still on edge from the last one
    if (loudness) lastLoud = loudness;
    startles.push(now());
    if (k < 0.15) { P().blink({ ms: 90 }); did("startle:habituated"); return; }
    const [x, y] = dir || [chance(0.5) ? -0.85 : 0.85, -0.15];
    P().freeze(140 + 160 * k);                                              // a brief frozen moment
    P().squint(1.1 + 0.1 * k, 1.1 + 0.1 * k, 450); P().pupils(1 - 0.35 * k, 900);
    after(60, () => P().blink({ ms: 60 }));                                  // hard blink
    after(200, () => look(x, y, 1500 + 1500 * k, { snap: true, overshoot: true }));   // eyes snap toward it
    if (k > 0.5) P().tremble(k, 350);
    after(700, () => P().blink({ ms: 90 }));                                 // faster blinking for a bit
    after(1600, () => P().blink({ ms: 100 }));
    if (k > 0.6) after(1900, () => { look(-x * 0.6, y, 700); after(800, () => look(x, y, 1200)); });   // check around, then back to the source
    after(3500, () => P().pupils(1, 1500));                                  // gradually relax
    sensitizedUntil = now() + 10000;
    did("startle", k.toFixed(2));
  }

  // ---------------- shaken, dropped, picked up ----------------
  let shakes = [];
  function shaken() {
    shakes = shakes.filter(t => now() - t < 60000); shakes.push(now());
    [0, 160, 320, 480].forEach(ms => after(ms, () => P().blink({ ms: 55 })));   // rapid blinks
    P().tremble(0.8, 500);
    const n = shakes.length;
    if (n === 2) after(700, () => { look(0, 0, 2500); P().squint(0.6, 0.6, 2500); P().hold({ browA: 0.6, browY: 0.3, mouth: -0.3 }, 2500); });   // deliberate? glare
    if (n >= 3) after(700, () => { look(0, 0, 3500); P().squint(0.45, 0.45, 3500); P().hold({ hue: 5, browA: 1, browY: 0.6, mouth: -0.8, vents: 1 }, 3500); });
    did("shaken", String(n));
  }
  function fell() {
    P().squint(0.02, 0.02, 450); did("fell");
    after(500, () => { P().squint(1.2, 1.2, 800); P().pupils(1.3, 1200); });
    after(1400, () => Face.gesture("scan_room"));
  }

  // ---------------- free fall: eyes shut on the way down, wide open after ----------------
  let fallSince = 0, falling = false;
  window.addEventListener("devicemotion", e => {
    const a = e.accelerationIncludingGravity; if (!a || a.x == null || !B.enabled) return;
    const g = Math.hypot(a.x, a.y, a.z);
    if (g < 2.5) {                                           // nearly weightless = falling (or thrown)
      if (!fallSince) fallSince = now();
      else if (!falling && now() - fallSince > 110) { falling = true; onFalling(); }
    } else {
      if (falling) { falling = false; const hard = g > 22; after(60, () => landed(hard)); }
      fallSince = 0;
    }
  });
  function onFalling() {
    P().squint(0.02, 0.02, 1500); P().hold({ browA: -0.8, browY: -0.7, mouth: -1, mouthW: 0.6 }, 1500); P().tremble(1, 1200);
    window.Abilities?.sfx?.("whistle"); did("falling");
  }
  function landed(hard) {
    P().squint(1.2, 1.2, 800); P().pupils(1.4, 1500); did("landed", hard ? "hard" : "caught");
    after(900, () => Face.gesture("scan_room"));
    if (!hard && typeof react === "function") react("caught", "you were in free fall for a moment (dropped or tossed) and then caught", 2);
  }

  // ---------------- playing dead (finger gun) ----------------
  B.playDead = () => {
    if (!ready("dead", 8000)) return;
    P().hold({ open: 0.9, browY: -0.9, mouth: -0.6 }, 350); P().tremble(1, 500); did("play-dead");
    after(350, () => { P().squint(0.02, 0.02, 2600); P().hold({ mouth: -0.4, tilt: -0.5, browA: -0.6, skew: 0.8 }, 2600); window.Abilities?.sfx?.("powerdown"); });
    after(3000, () => P().squint(0.02, 0.7, 1100));            // one eye opens first: is he still looking?
    after(4200, () => { P().blink({ ms: 120 }); Face.gesture("wink_left"); });
  };

  // ---------------- nobody around: dim the screen; come back: wake it ----------------
  let lastPresence = now(), dimmed = false;
  function presenceDim() {
    const here = (window.Mind?.presenceScore?.() ?? 1) >= 0.5 || busyFace() || (window.lastMotion && now() - lastMotion.t < 3000 && lastMotion.frac > 0.02);
    if (here) lastPresence = now();
    const want = !here && now() - lastPresence > 5 * 60000;
    if (want !== dimmed) { dimmed = want; Face.setIdleDim?.(want ? 0.55 : 0); did(want ? "dim:nobody-here" : "undim:someone-here"); }
  }

  // ---------------- light ----------------
  function lightsOn() {
    P().blink({ ms: 70 }); after(150, () => P().squint(0.25, chance(0.4) ? 0.6 : 0.3, 700));
    after(900, () => P().squint(0.6, 0.6, 1500)); P().pupils(0.6, 4000); did("lights-on-squint");
  }
  function lightsOff() { P().pupils(1.55, 15000); P().squint(1.08, 1.08, 4000); did("dark-wide-pupils"); }

  // ---------------- touch ----------------
  let boops = [], boopSide = 1;
  B.onTouch = (kind, zone, rep = 0) => {
    if (!B.enabled) return;
    if (kind === "boop" || kind === "tap" || kind === "double_tap") {
      boops = boops.filter(t => now() - t < 6000); boops.push(now());
      if (boops.length >= 3) { boopSide = -boopSide; P().blink({ ms: 110, side: boopSide > 0 ? "left" : "right" }); did("touch:alternate-blink"); }
      else { P().blink({ ms: 80 }); did("touch:blink"); }
    }
    if (kind === "tickle") P().squint(0.3, 0.3, 1200);
    if (kind === "hold" && /eye/.test(zone)) P().squint(/^right/.test(zone) ? 0.1 : 1, /^left/.test(zone) ? 0.1 : 1, 1500);
  };

  // ---------------- listening ----------------
  let nodAt = 0;
  B.onUserSpeaking = partial => {
    if (!B.enabled) return;
    const name = (typeof personality !== "undefined" && personality?.name || "Nessari").toLowerCase();
    if (partial && partial.toLowerCase().includes(name) && ready("name-snap", 6000)) heardName();
    if (now() - nodAt > rand(4000, 8000)) { nodAt = now(); P().blink({ ms: 100 }); did("listen:ack-blink"); }
  };
  function heardName() {
    P().squint(1.2, 1.2, 900); P().pupils(1.3, 1200); look(0, 0, 1500, { snap: true });
    if (!window.Vision?.faces) after(600, () => Face.gesture("scan_room"));     // called from off-camera: look for him
    did("heard-name");
  }

  // ---------------- speaking ----------------
  const SARCASM = /\b(obviously|sure,|oh great|wow,|clearly|of course you|what a surprise|shocking|congratulations)\b/i;
  B.onSentence = (text, i, n) => {
    if (!B.enabled || !text) return;
    if (i > 0 && chance(0.6)) after(rand(0, 200), () => P().blink({ ms: 100 }));            // blink at phrase boundaries
    if (SARCASM.test(text)) { P().squint(0.6, 0.75, 1600); if (chance(0.5)) after(300, () => look(chance(0.5) ? -0.9 : 0.9, 0.1, 900)); did("speak:sarcasm"); }
    else if (/!\s*$/.test(text)) { P().squint(1.12, 1.12, 700); P().pupils(1.15, 700); did("speak:emphasis"); }
    else if (/\?\s*$/.test(text)) P().hold({ browAsym: 0.45 }, 900);
    if (text.length > 110) { after(rand(900, 1800), () => look(chance(0.5) ? -0.45 : 0.45, -0.25, 900)); did("speak:glance-away"); }   // look away on long explanations
    if (i === n - 1 && n > 1 && /\.\s*$/.test(text)) after(Math.min(6000, text.length * 55), () => { if (!busyFace()) Face.gesture("nod"); });   // confident finish
  };

  // ---------------- thinking and network ----------------
  B.netFail = () => {
    if (!ready("netfail", 15000)) return;
    P().squint(0.7, 0.7, 1800); P().hold({ browA: 0.6, browY: 0.3, mouth: -0.35 }, 1800);
    after(400, () => look(chance(0.5) ? -0.9 : 0.9, 0.1, 900)); did("network-annoyed");
  };
  window.addEventListener("online", () => { P().blink({ ms: 260 }); P().hold({ browA: -0.3, mouth: 0.4 }, 1200); did("network-relief"); });

  // ---------------- social gaze ----------------
  let lastLeftAt = 0, lookAwayDue = 0;
  function socialTick() {
    const V = window.Vision; if (!V?.available) return;
    if (V.main) lastFace = { x: V.main.x, y: V.main.y };
    // mutual gaze is held for a while, then naturally broken for a moment
    if (V.lookingAtMe && !busyFace()) {
      if (!lookingSince) { lookingSince = now(); lookAwayDue = rand(6000, 11000); }
      else if (now() - lookingSince > lookAwayDue) {
        look(chance(0.5) ? -0.55 : 0.55, rand(-0.2, 0.3), 650); lookingSince = now() + 650; lookAwayDue = rand(6000, 11000); did("social:gaze-aversion");
      }
    } else lookingSince = 0;
  }
  function hookVision() {
    const V = window.Vision; if (!V?.on || V._behaviors) return; V._behaviors = true;
    V.on("left", () => { lastLeftAt = now(); if (lastFace) { look(lastFace.x * 1.2, lastFace.y, 2500); did("social:watch-where-left"); } });
    V.on("arrive", () => {
      const away = lastLeftAt ? now() - lastLeftAt : Infinity;
      if (away < 120000) { P().blink({ ms: 100 }); did("social:small-ack"); }                  // just stepped out: carry on
      else if (away > 1800000) { P().pupils(1.4, 1500); after(200, () => Face.gesture("double_blink")); did("social:big-greeting"); }
    });
    V.on("expression", e => { if (e === "smiling" && !V.mirror) { P().hold({ low: 0.35, browY: -0.25 }, 1500); did("social:smiling-eyes"); } });
    V.on("approach", () => { P().squint(0.8, 0.8, 500); after(500, () => P().blink({ ms: 90 })); did("social:anticipate-touch"); });
    V.on("object", o => {                                                    // curiosity: inspect new things, glance at familiar ones
      if (busyFace() || asleep()) return;
      if (o.familiar) { if (chance(0.3)) { look(o.x, o.y, 350); did("curious:glance"); } return; }
      look(o.x, o.y, 1300, { snap: true }); P().pupils(1.3, 1300); did("curious:inspect " + o.label);
      if (window.Vision.main) { after(1400, () => look(Vision.main.x, Vision.main.y, 700)); after(2200, () => look(o.x, o.y, 800)); }   // object → you → object
    });
    V.on("sound", s => { if (s.run === 1 && s.base >= 0.5 && /bang|glass|alarm|knock|doorbell/.test(s.what)) startle(s.base, null); });
  }

  // ---------------- asleep: peek with one eye, then drift back off ----------------
  let lastMotionSeen = 0;
  function peekWhileAsleep() {
    const m = window.lastMotion;
    if (!m || m.t === lastMotionSeen || now() - m.t > 1500 || m.frac < 0.02) return;
    lastMotionSeen = m.t;
    if (!ready("peek", 45000)) return;
    const left = chance(0.5);
    P().hold({ open: 0.9 }, 1800); P().squint(left ? 1 : 0.05, left ? 0.05 : 1, 1800); did("asleep:one-eye-peek");
  }

  // ---------------- everything the mind perceives passes through here ----------------
  B.onPerceive = (key, sal = 0.5) => {
    if (!B.enabled) return;
    if (key === "bang") startle(Math.max(0.5, sal), null, sal);
    else if (key === "shout") startle(0.5 * sal);
    else if (key === "shake") shaken();
    else if (key === "tip" || key === "impact") fell();
    else if (key === "bright") lightsOn();
    else if (key === "dark") lightsOff();
    else if (key === "face-close") startle(0.4);
  };

  B.primitives = ["gaze", "blink", "squint", "pupils", "freeze", "saccades", "wander", "chew", "swallow", "tremble", "puff", "hold"];
  B.startle = startle; B.shaken = shaken; B.fell = fell; B.heardName = heardName; B.fullyCharged = fullyCharged;
  // pretend charging (a trick, and for testing): level 0..1
  B.startCharging = (level = 0.4) => { battery = { level, charging: true, real: battery?.real || battery }; startCharging(); };
  B.stopAll = () => { timers.forEach(clearTimeout); timers.clear(); P().chew(false); };
  B.describe = () => B.log.slice(-12).map(l => l.name + (l.detail ? ` (${l.detail})` : "")).join(", ") || "nothing yet";

  const start = () => { if (!window.Face?.prim) return setTimeout(start, 200); boot(); setInterval(tone, 300); hookVision(); setTimeout(hookVision, 3000); setTimeout(hookVision, 15000); };
  start();
})();
