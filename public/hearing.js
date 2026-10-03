// Offline hearing. Chrome's built-in speech recognition sends your voice to Google, so with no internet she's deaf.
// This listens with the phone's own microphone instead: it waits for speech, records until you stop,
// and has whisper.cpp on the phone (see robot-hearing-setup) turn it into words. No internet involved.
//
// The microphone is shared with her "ears" (claps, bangs, sound recognition) in tricks.js, which hands
// every block of sound to Hearing.onAudio().
(() => {
  "use strict";
  const now = () => performance.now();
  const H = window.Hearing = { active: false, state: "idle", lastError: "", heardCount: 0, forcedUntil: 0 };

  // Should she use offline hearing right now?
  H.available = () => typeof status !== "undefined" && (status.hearing === "ready" || status.hearing === "slow");
  H.useOffline = () => {
    const want = (typeof settings !== "undefined" && settings.hearing) || "auto";
    if (!H.available()) return false;
    // screen off: Google's recognizer stops with the screen, the phone's own keeps going
    if (document.hidden && (typeof settings === "undefined" || settings.offListen !== false)) return true;
    if (want === "online") return false;
    if (want === "offline") return true;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    return !SR || !navigator.onLine || !status.online || now() < H.forcedUntil;     // auto: offline whenever the internet isn't there
  };
  // Chrome's recognizer just failed for lack of network: stay on offline hearing for a while.
  H.preferOffline = (minutes = 5) => { H.forcedUntil = now() + minutes * 60000; };

  // ---- voice activity detection ----
  let floor = 0.006;                      // the room's background level, learned as it goes
  let pre = [], rec = null, speechBlocks = 0, silentBlocks = 0, startedAt = 0, quietSince = 0, rate = 48000, idleSince = 0, busySending = false;
  const PRE_BLOCKS = 4;                   // keep a little sound from just before speech started
  let recLevels = [];
  function reset() { rec = null; speechBlocks = 0; silentBlocks = 0; recLevels = []; }

  H.onAudio = (block, sampleRate) => {
    if (!H.active || busySending) return;
    rate = sampleRate;
    // don't listen to herself, or to her own music and sound effects
    if ((typeof talking !== "undefined" && talking) || window.Abilities?.isPlaying?.()) { reset(); pre = []; quietSince = now(); return; }
    if (now() - quietSince < 350) return;                          // the echo right after she stops
    let sum = 0; for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
    const rms = Math.sqrt(sum / block.length);
    const blockMs = block.length / sampleRate * 1000;
    const loud = rms > Math.max(0.008, floor * 3.2);
    if (!rec) {
      if (!loud) floor = floor * 0.95 + rms * 0.05;                // only learn the background from quiet moments
      pre.push(new Float32Array(block)); if (pre.length > PRE_BLOCKS) pre.shift();
      speechBlocks = loud ? speechBlocks + 1 : 0;
      if (speechBlocks * blockMs >= 150) {                         // someone started talking
        rec = [...pre]; pre = []; silentBlocks = 0; startedAt = now(); H.state = "hearing";
        try { listening = true; setFaceState("listening", true); $("#heard").textContent = "…"; } catch {}   // "listening" also stops her talking over you
        window.Mind?.onUserSpeaking?.("");
      } else if (H.oneShot && now() - idleSince > 9000) H.stop();   // tapped the mic, said nothing
      return;
    }
    rec.push(new Float32Array(block)); if (loud) recLevels.push(rms);
    silentBlocks = loud ? 0 : silentBlocks + 1;
    const long = now() - startedAt > 15000;
    if (silentBlocks * blockMs >= 850 || long) {
      const blocks = rec, spoken = (blocks.length - silentBlocks - PRE_BLOCKS) * blockMs;
      // how loudly he spoke: a whisper gets a whisper back; a noisy room is worth knowing about
      const lv = [...recLevels].sort((a, b) => a - b), level = lv.length ? lv[lv.length >> 1] : 0;
      H.lastLevel = { level, floor, quiet: level > 0 && level < 0.025 && floor < 0.006, noisy: floor > 0.03 };
      reset();
      if (spoken < 280) { H.state = "listening"; try { listening = false; setFaceState("listening", !!H.oneShot); } catch {} return; }   // a click or a cough, not words
      send(blocks, sampleRate);
    }
  };

  // ---- to 16 kHz mono WAV ----
  function toWav(blocks, inRate) {
    let n = 0; for (const b of blocks) n += b.length;
    const all = new Float32Array(n); let o = 0; for (const b of blocks) { all.set(b, o); o += b.length; }
    const ratio = inRate / 16000, outN = Math.floor(n / ratio), pcm = new Int16Array(outN);
    let peak = 0.01; for (let i = 0; i < n; i++) { const a = Math.abs(all[i]); if (a > peak) peak = a; }
    const gain = Math.min(8, 0.9 / peak);                           // quiet voices get turned up
    for (let i = 0; i < outN; i++) {                                // average each stretch of input (a simple low-pass)
      const a = Math.floor(i * ratio), b = Math.min(n, Math.floor((i + 1) * ratio)); let s = 0;
      for (let k = a; k < b; k++) s += all[k];
      pcm[i] = Math.max(-32767, Math.min(32767, (s / Math.max(1, b - a)) * gain * 32767));
    }
    const buf = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(buf);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, pcm.length * 2, true);
    new Int16Array(buf, 44).set(pcm);
    return buf;
  }
  H.toWav = toWav;

  async function send(blocks, inRate) {
    busySending = true; H.state = "working";
    try { $("#heard").textContent = "(working out what you said…)"; } catch {}
    let text = "";
    try {
      const r = await fetch("/api/hear", { method: "POST", headers: { "content-type": "audio/wav" }, body: toWav(blocks, inRate) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "hearing failed (" + r.status + ")");
      text = (j.text || "").trim(); H.lastMs = j.ms;
    } catch (e) { H.lastError = e.message; try { logEvent("error", { where: "offline hearing", detail: e.message }); $("#heard").textContent = "(couldn't work out what you said: " + e.message + ")"; } catch {} }
    busySending = false; H.state = H.active ? "listening" : "idle"; idleSince = now();
    try { listening = false; setFaceState("listening", false); $("#heard").textContent = text; } catch {}
    if (!text) { if (H.oneShot) H.stop(); return; }
    H.heardCount++; H.lastError = ""; try { hearState.lastHeardAt = Date.now(); } catch {}
    if (H.oneShot) H.stop();
    try { onHeard(text, 0.9, H.lastLevel || {}); } catch (e) { console.error(e); }
  }

  // ---- start / stop ----
  H.start = async ({ oneShot = false } = {}) => {
    H.oneShot = oneShot; H.active = true; H.state = "listening"; idleSince = now(); reset(); pre = [];
    const ok = await window.Tricks?.earsStart?.(true);              // opens the microphone (shared with her ears)
    if (!ok) {
      H.active = false; H.state = "idle"; H.lastError = "couldn't open the microphone";
      try { logEvent("error", { where: "offline hearing", detail: H.lastError }); $("#heard").textContent = "(can't listen: the microphone didn't open. In Chrome: the icon left of the address > Permissions > Microphone > Allow)"; } catch {}
      return false;
    }
    try { setFaceState("listening", oneShot); $("#micBtn").classList.add("live"); } catch {}
    return true;
  };
  // keep the microphone open while she's supposed to be listening (other things borrow and return it)
  setInterval(() => {
    if (!H.active || (typeof recording !== "undefined" && recording)) return;
    window.Tricks?.earsStart?.(true);                              // (also with the screen off: it resumes the sound engine if Chrome paused it)
  }, 4000);
  H.stop = () => {
    H.active = false; H.state = "idle"; reset();
    try { listening = false; setFaceState("listening", false); $("#micBtn").classList.remove("live"); } catch {}
  };
})();
