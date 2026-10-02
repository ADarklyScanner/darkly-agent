// Looking after herself.
//  - Power: when the phone is hot or the battery is low she slows her senses down (and says so once), then speeds back up.
//  - Battery: works out how many hours she has left from how fast it's draining.
//  - Camera covered: notices a hand over her camera (and peekaboo when it comes off).
//  - Self check: a rundown of every part of her, which she can say out loud ("systems check").
//  - Shush: tap her mouth, or hold up an open hand, to make her stop talking.
(() => {
  "use strict";
  const now = () => Date.now();
  const P = window.Power = { level: "normal", slow: 1, runtime: "", why: "" };
  const SLOW = { normal: 1, saver: 2, critical: 4 };

  // ---------------- power level ----------------
  const drain = [];                                    // [time, level] while discharging
  function powerTick() {
    const b = typeof battery !== "undefined" ? battery : null, h = typeof hw !== "undefined" ? hw : null;
    const temp = h?.battery?.temperature ?? null;      // battery temperature is the honest "is the phone hot" number
    const low = b && !b.charging ? b.level : 1;
    let level = "normal", why = "";
    if (temp != null && temp >= 46) { level = "critical"; why = `the phone is very hot (${temp.toFixed(0)}°C)`; }
    else if (low <= 0.08) { level = "critical"; why = "the battery is nearly empty"; }
    else if (temp != null && temp >= 42) { level = "saver"; why = `the phone is getting hot (${temp.toFixed(0)}°C)`; }
    else if (low <= 0.2) { level = "saver"; why = "the battery is getting low"; }
    if (level !== P.level) {
      const worse = SLOW[level] > SLOW[P.level];
      P.level = level; P.slow = SLOW[level]; P.why = why;
      window.Mind?.event("power", worse ? `you slowed your senses down because ${why}` : "you're back to full speed", { source: "FELT", salience: 0.45 });
      if (worse && typeof react === "function") react("power-" + level, `you've slowed your eyes and ears down to save energy because ${why}`, 30);
      if (typeof logEvent === "function") logEvent("auto", { detail: `power level: ${level}${why ? " (" + why + ")" : ""}` });
    }
    // hours left, from the drain over the last half hour or so
    if (b) {
      if (b.charging) { drain.length = 0; P.runtime = ""; }
      else {
        if (!drain.length || drain[drain.length - 1][1] !== b.level) drain.push([now(), b.level]);
        while (drain.length > 2 && now() - drain[0][0] > 45 * 60000) drain.shift();
        const [t0, l0] = drain[0], dt = (now() - t0) / 3600000, used = l0 - b.level;
        P.runtime = dt > 0.15 && used > 0.01 ? (() => { const hrs = b.level / (used / dt); return hrs >= 1.5 ? `about ${Math.round(hrs)} hours of battery left` : `about ${Math.max(5, Math.round(hrs * 60 / 5) * 5)} minutes of battery left`; })() : "";
      }
    }
  }
  setInterval(powerTick, 10000); setTimeout(powerTick, 5000);
  P.tick = powerTick;

  // ---------------- camera covered / peekaboo ----------------
  const C = window.CameraCheck = { covered: false };
  let bright = 0, coveredSince = 0, lastBrightAt = 0, toldCovered = false;
  C.onFrame = gray => {                                 // the 64x48 frame from the camera tracker, ~10 times a second
    let sum = 0; for (let i = 0; i < gray.length; i += 4) sum += gray[i]; const mean = sum / (gray.length / 4);
    let dev = 0; for (let i = 0; i < gray.length; i += 4) dev += Math.abs(gray[i] - mean); dev /= gray.length / 4;
    const dark = mean < 14 && dev < 7;
    if (!dark) {
      if (C.covered) {                                   // uncovered again
        const secs = (now() - coveredSince) / 1000; C.covered = false; toldCovered = false;
        window.Face?.prim?.squint(1.2, 1.2, 700); window.Face?.prim?.pupils(1.4, 900);
        if (secs < 15) { window.Abilities?.sfx?.("boing"); if (typeof react === "function") react("peekaboo", "your view suddenly went black and came back (he covered your camera with his hand, or flicked the lights): peekaboo", 2); }
        else window.Mind?.event("camera", `your camera was covered for ${Math.round(secs)} seconds and can see again`, { source: "SAW", salience: 0.4 });
      }
      bright = bright * 0.9 + mean * 0.1; if (mean > 45) lastBrightAt = now(); coveredSince = 0; return;
    }
    // dark now. Sudden (it was bright a moment ago) = something over the lens; gradual = the room got dark.
    if (!coveredSince) coveredSince = now();
    if (!C.covered && bright > 40 && coveredSince - lastBrightAt < 900 && now() - coveredSince > 700) {      // it went from lit to black in under a second
      C.covered = true; window.Face?.prim?.squint(0.5, 0.5, 1500); window.Face?.prim?.hold({ browAsym: 0.7, mouth: -0.2, question: 0.8 }, 1500);
      window.Mind?.event("camera", "your view suddenly went black (something over your camera, or the lights went out)", { source: "SAW", salience: 0.4 });
    }
    if (C.covered && !toldCovered && now() - coveredSince > 20000) { toldCovered = true; if (typeof react === "function") react("covered", "your view went black suddenly and has stayed black for a while: you can't see anything", 10); }
    if (!C.covered && now() - coveredSince > 4000) bright = bright * 0.98;       // a dark room: forget how bright it used to be
  };

  // ---------------- shush ----------------
  window.shush = why => {
    if (typeof talking === "undefined" || !talking) return false;
    speakToken++; try { speechSynthesis.cancel(); } catch {} fetch("/api/say/stop", { method: "POST" }).catch(() => {});
    talking = false; Face.setTalking(false); speakingNow = []; try { resumeListening(); } catch {}
    Face.prim?.hold({ mouth: -0.2, mouthW: 0.5, browY: 0.2 }, 1200);
    window.Mind?.event("shushed", `he made you stop talking (${why})`, { source: "FELT", salience: 0.5 });
    if (window.Mind) Mind.S.irritation = Math.min(1, Mind.S.irritation + 0.08);
    return true;
  };

  // ---------------- self check ----------------
  window.selfCheck = async () => {
    try { await refreshStatus(); } catch {}
    const s = typeof status !== "undefined" ? status : {}, h = typeof hw !== "undefined" ? hw : null, b = typeof battery !== "undefined" ? battery : null;
    const V = window.Vision, ok = [], bad = [];
    const say = (good, yes, no) => (good ? ok : bad).push(good ? yes : no);
    say(s.local, "offline brain: running", s.localState === "loading" ? "offline brain: still loading its model" : "offline brain: NOT running" + (s.localError ? ` (${s.localError.slice(0, 80)})` : ""));
    say(s.online && (s.hasKey || s.geminiKeyCount > 0), "online brain: reachable", !s.online ? "online brain: no internet (fine, the offline brain covers it)" : "online brain: no key");
    say(s.hearing === "ready" || s.hearing === "slow", "offline hearing: installed", "offline hearing: NOT installed (run robot-hearing-setup)");
    say(typeof voices !== "undefined" && voices.length > 0, `voice: ${typeof voices !== "undefined" && voices.some(v => v.localService) ? "works offline" : "available"}`, "voice: no voices found in the browser (she'll use the phone's own voice)");
    say(!!(typeof camStream !== "undefined" && camStream), "camera: on", "camera: off");
    say(V?.available, `vision: running (${V?.engineInfo?.().mode === "worker" ? "in the background" : "on the page"}${V?.frameMs ? ", " + V.frameMs + " ms a look" : ""})`, "vision: NOT running" + (V?.error ? ` (${V.error})` : ""));
    say(V?.hearing, "sound recognition: running", "sound recognition: not running");
    say(!!window.AR, "marker tags: ready", "marker tags: reader didn't load");
    if (window.AudioSmarts) say(AudioSmarts.stereo.ok !== false, "sound direction: " + AudioSmarts.directionStatus(), "sound direction: " + AudioSmarts.directionStatus());
    say(true, `people known by face: ${window.People?.people?.length || 0}${window.People?.error ? " (recognizer problem: " + window.People.error + ")" : ""}`);
    say(h?.termuxApi, `phone sensors: ${h?.sensorCount || 0} available`, "phone sensors: Termux:API isn't answering");
    if (b) say(b.charging || b.level > 0.2, `battery: ${Math.round(b.level * 100)}%${b.charging ? ", charging" : ""}${P.runtime ? ", " + P.runtime : ""}`, `battery: LOW, ${Math.round(b.level * 100)}%${P.runtime ? ", " + P.runtime : ""}`);
    if (h?.battery?.temperature != null) say(h.battery.temperature < 42, `temperature: ${h.battery.temperature.toFixed(0)}°C`, `temperature: HOT, ${h.battery.temperature.toFixed(0)}°C`);
    if (h?.memory) say(h.memory.freeMB > 600, `memory: ${h.memory.freeMB} MB free`, `memory: only ${h.memory.freeMB} MB free`);
    if (h?.disk) say(h.disk.freeGB > 2, `storage: ${h.disk.freeGB} GB free`, `storage: nearly full, ${h.disk.freeGB} GB free`);
    say(P.level === "normal", "power: full speed", `power: ${P.level} mode (${P.why})`);
    if (C.covered) bad.push("camera: something is covering it");
    return `Self check: ${bad.length ? bad.length + " thing" + (bad.length > 1 ? "s" : "") + " to mention" : "everything's fine"}.\n` + (bad.length ? "Problems:\n- " + bad.join("\n- ") + "\n" : "") + "Working:\n- " + ok.join("\n- ");
  };
})();
