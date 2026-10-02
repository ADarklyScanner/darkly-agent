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
  let veil = null;
  D.go = (why = "asked") => {
    if (D.on) return "Your screen is already dark.";
    if (!veil) {
      veil = document.createElement("div");
      veil.id = "veil";
      veil.style.cssText = "position:fixed;inset:0;background:#000;z-index:2147483000;touch-action:none;display:none";
      veil.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); D.wake("touched"); });
      document.body.appendChild(veil);
    }
    veil.style.display = "block";
    D.on = true; D.since = Date.now();
    window.Face?.pause?.(true);                               // no point drawing a face nobody can see
    try { logEvent("auto", { detail: "went dark (" + why + "); still seeing, hearing and talking" }); } catch {}
    return "Your screen is dark now (pure black). You can still see, hear and talk. A touch or \"screen on\" brings your face back.";
  };
  D.wake = (why = "asked") => {
    if (!D.on) return "Your face is already showing.";
    veil.style.display = "none";
    D.on = false;
    window.Face?.pause?.(false); window.Face?.poke?.();
    try { logEvent("auto", { detail: "face back on (" + why + ")" }); } catch {}
    return "Your face is showing again.";
  };
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
    startCard(); snapSoon(400);
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
  let audio = null;
  async function startCard() {
    if (S().lockCard === false) return stopCard();
    if (!("mediaSession" in navigator)) { D.cardError = "this browser has no lock screen cards"; return; }
    if (!audio) { audio = new Audio(silentWav()); audio.loop = true; audio.addEventListener("pause", () => { if (!document.hidden && S().lockCard !== false) setTimeout(() => audio?.play().catch(() => {}), 1500); }); }
    try { await audio.play(); D.card = true; D.cardError = ""; setActions(); updateCard(true); }
    catch (e) { D.card = false; D.cardError = e.name === "NotAllowedError" ? "waiting for a first touch" : e.message; }
  }
  function stopCard() {
    if (audio) { try { audio.pause(); } catch {} audio = null; }
    D.card = false;
    try { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = "none"; } catch {}
  }
  D.startCard = startCard; D.stopCard = stopCard;
  window.addEventListener("pointerdown", () => { if (!D.card) startCard(); }, { capture: true });   // sound may only start after a touch

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
