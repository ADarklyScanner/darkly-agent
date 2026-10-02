// Nessari with the screen off. Three separate things, because "off" means different things to Android:
//
//  1. GO DARK. Her page stays up but shows pure black (on this kind of screen, black pixels are switched off).
//     Nothing else changes: camera, eyes, ears, voice and brain all keep running. Touch the screen, or say
//     "screen on", and her face is back. This is the one that keeps ALL of her working.
//
//  2. THE POWER BUTTON. With the screen really off, Chrome takes her camera away and stops drawing. What can
//     keep going is sound: her microphone, her offline hearing (whisper on the phone) and her voice. So she keeps
//     listening, but since she can't see who's talking, she only answers when she hears her name (or within a
//     little while of her own last answer, so a conversation can carry on).
//
//  3. THE LOCK SCREEN. A web page can't draw over Android's lock screen. What it can do is show a media card
//     there, like a music player does: her face as the picture, her name and mood, the last thing she said,
//     and three buttons. A silent sound loop keeps that card (and her page) alive in the background.
(() => {
  "use strict";
  const D = window.Dark = { on: false, card: false, cardError: "", shots: {}, lastShot: "" };
  const S = () => (typeof settings !== "undefined" ? settings : {});
  const herName = () => (typeof personality !== "undefined" && personality?.name) || "Nessari";

  // =============================== 1. go dark ===============================
  let veil = null, wokeAt = 0;
  D.go = (why = "asked") => {
    if (D.on) return "Your screen is already dark.";
    if (Date.now() - wokeAt < 1500) return "Your face just came back; not going dark again right away.";
    if (!veil) {
      veil = document.createElement("div");
      veil.id = "veil";
      veil.style.cssText = "position:fixed;inset:0;background:#000;z-index:2147483000;touch-action:none;display:none;align-items:flex-end;justify-content:center";
      // a tiny breathing dot and a hint, so "she's dark" can be told from "the phone is off"
      veil.innerHTML = '<div id="veilHint" style="position:absolute;bottom:14%;left:0;right:0;text-align:center;color:#8a6aa8;font:15px system-ui;transition:opacity 1.5s">touch anywhere to bring her face back</div>'
        + '<div style="position:absolute;bottom:6%;left:50%;width:7px;height:7px;margin-left:-3px;border-radius:50%;background:#7a3fb0;animation:veilDot 4s ease-in-out infinite"></div>'
        + '<style>@keyframes veilDot{0%,100%{opacity:.12}50%{opacity:.45}}</style>';
      // any kind of touch brings her back; whichever of these the phone delivers first
      for (const ev of ["pointerdown", "touchstart", "mousedown", "click"]) veil.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); D.wake("touched"); }, { passive: false });
      document.body.appendChild(veil);
    }
    veil.style.display = "flex"; veil.style.opacity = "1"; veil.style.pointerEvents = "auto";
    const hint = veil.querySelector("#veilHint"); hint.style.opacity = "1"; setTimeout(() => { hint.style.opacity = "0"; }, 5000);
    D.on = true; D.since = Date.now();
    window.Face?.pause?.(true);                               // no point drawing a face nobody can see
    try { logEvent("auto", { detail: "went dark (" + why + "); still seeing, hearing and talking" }); } catch {}
    return "Your screen is dark now (pure black). You can still see, hear and talk. A touch, picking you up, or \"screen on\" brings your face back.";
  };
  D.wake = (why = "asked") => {
    if (!D.on) return "Your face is already showing.";
    D.on = false; wokeAt = Date.now();
    // stay in the way (invisible) for a moment, so the touch that woke her doesn't also press whatever is underneath
    veil.style.opacity = "0";
    setTimeout(() => { if (!D.on) veil.style.display = "none"; }, 450);
    window.Face?.pause?.(false); window.Face?.poke?.();
    if (window.brightnessSet) { window.brightnessSet = false; fetch("/api/hw/extra?what=brightness&value=auto").catch(() => {}); }   // if her brain also turned the backlight down, put it back
    try { logEvent("auto", { detail: "face back on (" + why + ")" }); } catch {}
    return "Your face is showing again.";
  };
  // picking the phone up or giving it a shake wakes her too
  let lastG = null;
  window.addEventListener("devicemotion", e => {
    if (!D.on) { lastG = null; return; }
    const a = e.accelerationIncludingGravity; if (!a || a.x == null) return;
    if (lastG && Date.now() - D.since > 1500 && Math.hypot(a.x - lastG.x, a.y - lastG.y, a.z - lastG.z) > 6) D.wake("picked up");
    lastG = { x: a.x, y: a.y, z: a.z };
  });
  D.set = state => /dark|off|black|hide/i.test(String(state)) ? D.go() : D.wake();

  // =============================== 2. the screen is really off ===============================
  // Did that sound like it was meant for her? Whisper spells her name every which way ("Nasari", "Nessary"),
  // so any word within two letters of it counts.
  const lev = (a, b) => {
    const m = a.length, n = b.length; if (!m || !n) return m + n;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  };
  // spelled the way it sounds: z as s, y as i, doubled letters once ("Nazari", "Nessary" and "Nessari" all become close)
  const sound = w => w.replace(/z/g, "s").replace(/y/g, "i").replace(/ph/g, "f").replace(/ck/g, "k").replace(/(.)\1+/g, "$1");
  D.saysName = text => {
    const words = String(text || "").toLowerCase().replace(/[^a-z' ]+/g, " ").split(/\s+/).filter(Boolean).map(sound);
    const names = [herName(), "robot", (S().wake || "").trim()].filter(Boolean).map(n => n.toLowerCase().replace(/[^a-z ]+/g, "")).map(n => n.includes(" ") ? n : sound(n));
    for (const n of names) {
      if (n.includes(" ")) { if (words.join(" ").includes(n.split(" ").map(sound).join(" "))) return true; continue; }
      // one letter off at most, same first letter; and two short words that run together ("ness ari") count too
      const slack = n.length >= 5 ? 1 : 0;
      const close = w => w[0] === n[0] && Math.abs(w.length - n.length) <= slack && lev(w, n) <= slack;
      if (words.some(close) || words.some((w, i) => i + 1 < words.length && close(sound(w + words[i + 1])))) return true;
    }
    return false;
  };
  // With the screen off: answer only when named, or while a conversation is going (45 s after she last spoke).
  D.forMe = text => D.saysName(text) || Date.now() - (window.lastSpokeAt || 0) < 45000;

  let offHearing = false;                                     // offline hearing was switched on by the screen going off
  function onHidden() {
    D.hiddenSince = Date.now();
    startCard();                                               // the lock screen card (and its silent sound) only exist while she's in the background
    if (S().offListen === false || !window.Hearing?.available?.()) return;
    try { if (typeof rec !== "undefined" && rec && typeof listening !== "undefined" && listening) rec.abort(); } catch {}   // Google's recognizer stops with the screen anyway
    if (!Hearing.active) { offHearing = true; Hearing.start({ oneShot: false }); }
    else if (Hearing.oneShot) { offHearing = true; Hearing.oneShot = false; }
    try { logEvent("auto", { detail: "screen off: listening with the phone's own hearing; she answers to her name" }); } catch {}
  }
  function onVisible() {
    const away = D.hiddenSince ? Math.round((Date.now() - D.hiddenSince) / 1000) : 0; D.hiddenSince = 0;
    if (offHearing) {
      offHearing = false;
      if (S().listen !== "always") Hearing.stop();            // back to how he had it set
      else if (!Hearing.useOffline()) { Hearing.stop(); try { startListening(); } catch {} }
    }
    if (away > 5) try { logEvent("auto", { detail: `screen back on after ${away}s` }); } catch {}
    try { audio?.pause(); } catch {} D.card = false;            // give the audio focus back before anything listens
    if (D.on) D.wake("the screen came back on");               // he just turned the screen on: show him her face
    snapSoon(400);
  }
  document.addEventListener("visibilitychange", () => (document.hidden ? onHidden() : onVisible()));

  // =============================== 3. the lock screen card ===============================
  // A silent sound, looped. While it "plays", Android treats her page like a music player: it isn't put to
  // sleep in the background, and its card shows on the lock screen.
  function silentWav(seconds = 30) {
    const rate = 8000, n = rate * seconds, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + n, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate, true);
    v.setUint16(32, 1, true); v.setUint16(34, 8, true); str(36, "data"); v.setUint32(40, n, true);
    new Uint8Array(buf, 44).fill(128);                         // 8-bit silence
    return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  }
  // IMPORTANT: the silent sound only plays while her page is in the BACKGROUND. On Android, anything that plays
  // sound holds the "audio focus", and Google's speech recognizer needs that focus to listen: with the sound
  // looping in the foreground the two kept taking it from each other, and she stopped hearing (v0.19 to v0.21).
  let audio = null, unlocked = false;
  function ensureAudio() { if (!audio) { audio = new Audio(silentWav()); audio.loop = true; } return audio; }
  // The first touch lets the page play sound later by itself. Done muted, so it takes nothing from the recognizer.
  function unlockAudio() {
    if (unlocked || S().lockCard === false) return;
    const a = ensureAudio(); a.muted = true;
    a.play().then(() => { a.pause(); a.muted = false; unlocked = true; }).catch(() => { a.muted = false; });
  }
  async function startCard() {
    if (S().lockCard === false) return stopCard();
    if (!("mediaSession" in navigator)) { D.cardError = "this browser has no lock screen cards"; return; }
    setActions(); D.cardReady = true;
    if (!document.hidden) { try { audio?.pause(); } catch {} D.card = false; return; }     // on screen: no sound, no card needed
    try { const a = ensureAudio(); a.muted = false; await a.play(); D.card = true; D.cardError = ""; updateCard(true); }
    catch (e) { D.card = false; D.cardError = e.name === "NotAllowedError" ? "Chrome wouldn't start it in the background" : e.message; }
  }
  function stopCard() {
    if (audio) { try { audio.pause(); } catch {} }
    D.card = false;
    try { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = "none"; } catch {}
  }
  D.startCard = startCard; D.stopCard = stopCard;
  window.addEventListener("pointerdown", unlockAudio, { capture: true });

  // The buttons on the card.
  function setActions() {
    const ms = navigator.mediaSession, set = (name, fn) => { try { ms.setActionHandler(name, fn); } catch {} };
    const mute = on => {
      try {
        settings.muted = on; saveSettings(); renderMute();
        if (on) { speechSynthesis.cancel(); fetch("/api/say/stop", { method: "POST" }).catch(() => {}); }
      } catch {}
      updateCard(true);
    };
    set("pause", () => mute(true));                            // ⏸ quiet
    set("play", () => mute(false));                            // ▶ she may talk again
    set("stop", () => mute(true));
    set("nexttrack", () => {                                   // ⏭ "say something"
      try {
        if (typeof busy !== "undefined" && busy) return;
        ask("(system: he pressed your button on the lock screen. Say something to him: one or two sentences, whatever's on your mind.)", { quiet: true, auto: true, note: "he pressed her lock screen button", topic: "lockbutton" });
      } catch {}
    });
    set("previoustrack", () => {                               // ⏮ say that again
      try { const last = [...history].reverse().find(m => m.role === "assistant"); if (last && !(typeof talking !== "undefined" && talking)) speak(last.content); } catch {}
    });
  }

  // A square picture of her face as it is now, kept per mood (the face isn't drawn while the screen is off).
  const shot = document.createElement("canvas"); shot.width = shot.height = 512;
  function snap() {
    if (document.hidden || D.on) return;
    const c = document.getElementById("face"); if (!c || !c.width) return;
    const side = Math.min(c.width, c.height), g = shot.getContext("2d");
    g.fillStyle = "#000"; g.fillRect(0, 0, 512, 512);
    try { g.drawImage(c, (c.width - side) / 2, (c.height - side) / 2, side, side, 0, 0, 512, 512); } catch { return; }
    const m = typeof mood !== "undefined" ? mood : "neutral";
    shot.toBlob(b => {
      if (!b) return;
      if (D.shots[m]) URL.revokeObjectURL(D.shots[m]);
      D.shots[m] = D.lastShot = URL.createObjectURL(b);
      updateCard(true);
    }, "image/png");
  }
  let snapT = 0;
  const snapSoon = (ms = 900) => { clearTimeout(snapT); snapT = setTimeout(snap, ms); };
  D.snap = snap;

  let cardKey = "";
  function updateCard(force = false) {
    if (!D.card || !("mediaSession" in navigator)) return;
    const m = typeof mood !== "undefined" ? mood : "neutral";
    const said = (document.getElementById("said")?.textContent || "").replace(/\s+/g, " ").trim();
    const muted = !!S().muted;
    const state = (typeof busy !== "undefined" && busy) ? "thinking" : (typeof talking !== "undefined" && talking) ? "talking" : (window.Hearing?.state === "hearing" ? "listening" : m);
    const art = D.shots[m] || D.lastShot;
    const key = [said, state, muted, art, herName()].join("|");
    if (!force && key === cardKey) return;
    cardKey = key;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: said ? said.slice(0, 110) : herName(),
        artist: `${herName()} · ${state}${muted ? " · muted" : ""}`,
        album: document.hidden && S().offListen !== false && window.Hearing?.active ? `Say "${herName()}" to talk to her` : "",
        artwork: art ? [{ src: art, sizes: "512x512", type: "image/png" }] : []
      });
      navigator.mediaSession.playbackState = muted ? "paused" : "playing";
    } catch (e) { D.cardError = e.message; }
  }
  D.updateCard = updateCard;
  let lastMood = "";
  setInterval(() => {
    const m = typeof mood !== "undefined" ? mood : "";
    if (m !== lastMood) { lastMood = m; if (!D.shots[m]) snapSoon(); }
    updateCard();
  }, 2000);
  setInterval(() => { if (!D.shots[typeof mood !== "undefined" ? mood : ""]) snap(); }, 15000);
  setTimeout(snap, 6000);

  // for "systems check" and the Status tab
  D.status = () => `${D.on ? "dark (still running)" : document.hidden ? "screen off" : "on"}; lock screen card ${S().lockCard === false ? "off" : D.card ? "showing" : "not started (" + (D.cardError || "touch her once") + ")"}; screen-off listening ${S().offListen === false ? "off" : window.Hearing?.available?.() ? "ready" : "needs robot-hearing-setup"}`;
})();
