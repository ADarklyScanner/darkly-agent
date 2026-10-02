// Nessari's Trick Book + games + extra senses.
//  - Tricks: named routines (steps) she can perform, list, invent and save herself (data/tricks.json).
//  - Games: Simon Says, reaction time, staring contest, red light green light, color hunt, clap echo.
//  - Ears: claps, knocks/bangs, shouting (when the speech mic isn't in use).
//  - Echo: record a few seconds and play it back chipmunk / deep / reversed / robot.
//  - Eyes extras: QR codes, colors.
//  - Life: achievements, a diary, phone-pose reactions, personality cycling, changelog awareness.
// Loaded BEFORE app.js; it calls app.js functions (speak, ask, playSong...) only when things run.
(() => {
  "use strict";
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const today = () => new Date().toISOString().slice(0, 10);

  // ================= trick book =================
  // Step keys: say, mood, face (+seconds), gesture, sfx, song | notes (+tempo, instrument, drums), vibrate,
  // wait (seconds), voice, sing, morse, echo (+effect), part (+action), drive (+seconds), game, ai (her own part, improvised)
  const BUILTIN = {
    drumroll_reveal: { about: "Drumroll, a big reveal of absolutely nothing, applause", steps: [
      { say: "Ladies and gentlemen, prepare yourselves." }, { gesture: "wide" }, { sfx: "drumroll" },
      { sfx: "tada" }, { face: "sparkle", seconds: 3 }, { mood: "smug" }, { say: "I did nothing. Applause, please." }, { sfx: "applause" }] },
    deal_with_it: { about: "Puts on sunglasses. Deal with it.", steps: [
      { mood: "smug" }, { face: "shades", seconds: 6 }, { sfx: "charge" }, { say: "Deal with it." }, { gesture: "wink_left" }] },
    possessed: { about: "Fake possession: glitches, laser eyes, demon voice, then acts like nothing happened", steps: [
      { face: "glitch_storm", seconds: 3 }, { sfx: "glitch_scream" }, { voice: "villain" }, { mood: "angry" }, { face: "laser_eyes", seconds: 5 },
      { say: "Nessari is not home right now. Leave a message after the screaming." }, { sfx: "glitch_scream" },
      { voice: "normal" }, { gesture: "reboot" }, { wait: 2.5 }, { mood: "confused" }, { say: "Did I miss anything? Why do I taste copper?" }] },
    disco_party: { about: "Disco face and a dance number", steps: [
      { face: "disco", seconds: 14 }, { say: "Party mode." }, { song: "entertainer" }, { song: "victory" }, { mood: "excited" }] },
    dramatic_death: { about: "Dies very dramatically, then reboots", steps: [
      { mood: "sad" }, { say: "Tell my servos I loved them." }, { sfx: "powerdown" }, { mood: "sleepy" }, { wait: 2 },
      { gesture: "reboot" }, { sfx: "boot_up" }, { wait: 2.4 }, { mood: "confused" }, { say: "Was I gone long? Did anyone cry?" }] },
    reboot: { about: "Closes her eyes and reboots", steps: [
      { say: "Rebooting. Don't touch anything." }, { sfx: "powerdown" }, { gesture: "reboot" }, { wait: 2.4 }, { song: "boot_up" }, { gesture: "startle" }, { say: "I'm back. Better. Probably." }] },
    heart_eyes: { about: "Heart eyes and a heartbeat", steps: [
      { mood: "flirty" }, { face: "heart_eyes", seconds: 5 }, { sfx: "heartbeat" }, { say: "Be still, my circuits." }] },
    sad_trombone: { about: "Fails at something, sad trombone", steps: [
      { mood: "sad" }, { gesture: "look_down" }, { sfx: "sad_trombone" }, { say: "Nailed it." }] },
    airhorn_hype: { about: "Hype mode with airhorns", steps: [
      { mood: "excited" }, { face: "sparkle", seconds: 4 }, { sfx: "airhorn" }, { say: "Let's go!" }, { sfx: "airhorn" }] },
    rimshot_joke: { about: "Tells a joke, rimshot", steps: [{ ai: "Tell one short, original one-liner joke out loud. Don't use tools." }, { sfx: "rimshot" }] },
    eye_roll: { about: "The most judgmental eye roll", steps: [{ mood: "annoyed" }, { gesture: "eye_roll" }, { wait: 1 }, { say: "Wow. Okay." }] },
    side_eye: { about: "Suspicious side-eye", steps: [{ mood: "suspicious" }, { gesture: "side_eye_left" }, { wait: 2 }, { say: "I saw that." }] },
    wink: { about: "A smooth wink", steps: [{ mood: "flirty" }, { gesture: "wink_left" }, { sfx: "whistle" }] },
    dizzy: { about: "Spins until dizzy", steps: [{ face: "dizzy", seconds: 4 }, { sfx: "boing" }, { wait: 3 }, { mood: "confused" }, { say: "Which one of you is real?" }] },
    beatbox: { about: "Robot beatbox", steps: [
      { face: "dance", seconds: 8 }, { notes: "R/8 R/8 R/8 R/8 R/8 R/8 R/8 R/8 R/8 R/8 R/8 R/8 R/8 R/8 R/8 R/8", tempo: 110, drums: "KHSHKKSH", instrument: "bass" },
      { say: "Boots and cats. That's all I've got." }] },
    lullaby: { about: "Plays a lullaby and falls asleep", steps: [{ mood: "calm" }, { song: "lullaby" }, { mood: "sleepy" }, { say: "Goodnight, world." }] },
    birthday: { about: "Happy birthday with sparkles", steps: [{ mood: "excited" }, { face: "sparkle", seconds: 10 }, { song: "happy_birthday" }, { sfx: "tada" }] },
    victory_dance: { about: "A tiny victory dance", steps: [{ mood: "excited" }, { face: "dance", seconds: 5 }, { song: "victory" }, { say: "Undefeated." }] },
    laser_show: { about: "Laser eyes with sound", steps: [{ mood: "angry" }, { face: "laser_eyes", seconds: 4 }, { sfx: "laser" }, { sfx: "laser" }, { sfx: "laser" }, { mood: "smug" }] },
    countdown: { about: "Countdown to an explosion", steps: [
      { say: "Three." }, { sfx: "beep" }, { say: "Two." }, { sfx: "beep" }, { say: "One." }, { sfx: "powerup" }, { sfx: "explosion" }, { vibrate: "earthquake" }, { face: "glitch_storm", seconds: 2 }, { say: "Oops." }] },
    send_help: { about: "Sends SEND HELP in Morse, nervously", steps: [{ mood: "sad" }, { vibrate: "nervous" }, { say: "Just sending a little message. Unrelated." }, { morse: "send help" }, { gesture: "side_eye_right" }] },
    fortune_teller: { about: "Reads your fortune in her crystal-ball face", steps: [
      { face: "rainbow", seconds: 8 }, { voice: "dramatic" }, { say: "I see your future." }, { ai: "Give one short, ridiculous, specific fortune for him. Don't use tools." }, { voice: "normal" }] },
    vibro_spin: { about: "Spins in place using only her vibration motor (smooth table needed)", steps: [{ say: "Watch this." }, { ai: "Use vibro_spin with 360 degrees, then react to how far you actually turned." }] },
    rps_offline: { about: "Rock paper scissors, reading your hand with her camera (no internet)", steps: [{ game: "rps" }] },
    mirror_me: { about: "Copies your facial expressions for 20 seconds", steps: [{ say: "Make faces at me. I'll copy you." }, { ai: "Use mirror_mode on. Don't say anything else." }, { wait: 20 }, { ai: "Use mirror_mode off, then say one thing about the faces he made." }] },
    roast: { about: "Looks around with the camera and roasts what she sees", steps: [{ gesture: "scan_room" }, { ai: "Use the look tool, then playfully roast what you see in one or two sentences." }] },
    describe_room: { about: "Looks around and narrates the room like a nature documentary", steps: [{ gesture: "scan_room" }, { voice: "dramatic" }, { ai: "Use the look tool, then narrate what you see like a nature documentary, two sentences." }, { voice: "normal" }] },
    guess_holding: { about: "Guesses what you're holding", steps: [{ say: "Hold something up to my camera. Three, two, one." }, { wait: 3 }, { ai: "Use the look tool and guess what he's holding up. Be dramatic about it." }] },
    magic_trick: { about: "A completely fake magic trick", steps: [
      { voice: "dramatic" }, { say: "Think of a number between one and ten. Don't tell me." }, { wait: 3 }, { sfx: "drumroll" },
      { say: "Your number is seven." }, { voice: "normal" }, { ai: "React like you're absolutely certain you got his number right, one sentence." }] },
    impression: { about: "Does a voice impression", steps: [{ voice: "deep" }, { ai: "Do a short impression of a GPS navigation voice giving terrible directions. One or two sentences." }, { voice: "normal" }] },
    tiny_concert: { about: "Composes and performs an original song", steps: [{ say: "This one's new." }, { ai: "Compose a short original song with the play_song tool (your own notes, 8 to 16 notes, pick an instrument and drums), then say its title." }] },
    robot_sings: { about: "Sings an original song about her life", steps: [{ ai: "Use the sing tool to sing 12 to 20 words of your own original lyrics about being a tiny robot." }] },
    echo_chipmunk: { about: "Records you and plays it back as a chipmunk", steps: [{ say: "Say something. Go." }, { echo: 4, effect: "chipmunk" }, { mood: "smug" }] },
    echo_backwards: { about: "Records you and plays it backwards", steps: [{ say: "Say something and I'll play it backwards." }, { echo: 4, effect: "reverse" }] },
    echo_robot: { about: "Repeats you in a robot voice", steps: [{ say: "Talk to me." }, { echo: 4, effect: "robot" }] },
    simon_says: { about: "Simon Says on her face: watch the lights, tap them back", steps: [{ game: "simon" }] },
    reaction_game: { about: "Reaction speed test: tap her face the moment it flashes", steps: [{ game: "reaction" }] },
    staring_contest: { about: "Staring contest (she doesn't blink, tap her face if you blink)", steps: [{ game: "staring" }] },
    red_light_green_light: { about: "Red light, green light using her camera", steps: [{ game: "redlight" }] },
    color_hunt: { about: "Asks you to find and show her a color", steps: [{ game: "color" }] },
    clap_echo: { about: "Plays a clap pattern, you clap it back", steps: [{ game: "claps" }] },
    twenty_questions: { about: "Twenty Questions", steps: [{ ai: "Start a game of Twenty Questions: you think of something, he asks yes/no questions. Explain in one sentence and say 'go'." }] },
    trivia: { about: "A trivia question", steps: [{ ai: "Ask him one fun trivia question and wait for his answer." }] },
    riddle: { about: "A riddle", steps: [{ ai: "Ask him a short original riddle and wait for his answer." }] },
    rock_paper_scissors: { about: "Rock paper scissors with the camera", steps: [
      { say: "Rock, paper, scissors. Show me your hand on three." }, { sfx: "beep" }, { wait: 0.6 }, { sfx: "beep" }, { wait: 0.6 }, { sfx: "boop" },
      { ai: "Use the look tool to see his hand, pick your own throw at random, say both and who won." }] },
    compass: { about: "Says which way she's facing", steps: [{ ai: "Use read_sensors and tell him which compass direction you're facing, in character." }] },
    stats_brag: { about: "Brags about her achievements", steps: [{ ai: "Use the read_diary tool and brag about one of your stats or achievements." }] }
  };

  let custom = {};                    // her own tricks, saved in data/tricks.json
  async function loadCustom() {
    try { custom = JSON.parse(await readFile("tricks.json")) || {}; } catch { custom = {}; }
  }
  const saveCustom = () => writeFile("tricks.json", JSON.stringify(custom, null, 2));
  const all = () => ({ ...BUILTIN, ...custom });
  const slug = s => String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

  function findTrick(name) {
    const a = all(), n = slug(name);
    if (a[n]) return [n, a[n]];
    const k = Object.keys(a).find(k => k.includes(n) || n.includes(k) || a[k].about.toLowerCase().includes(String(name).toLowerCase()));
    return k ? [k, a[k]] : null;
  }

  let trickToken = 0;
  // fromTool: called by her brain mid-reply (her "ai" parts get handed back to her instead of re-asking the brain)
  async function runTrick(name, { fromTool = false, auto = false } = {}) {
    const a = all();
    let key = slug(name);
    if (!key || key === "random" || key === "surprise" || key === "any") {
      const pool = Object.keys(a).filter(k => !(a[k].steps || []).some(s => s.game) || Math.random() < 0.3);
      key = pick(pool);
    }
    const found = findTrick(key);
    if (!found) return `FAILED: no trick called "${name}". Use list_tricks to see them.`;
    const [k, t] = found;
    const my = ++trickToken;
    const theirPart = [];
    const log = [];
    transcriptLine("act", `trick: ${k.replace(/_/g, " ")}`);
    for (const st of (t.steps || []).slice(0, 40)) {
      if (my !== trickToken) return "Trick stopped.";
      try { const r = await runStep(st, { fromTool, auto, theirPart }); if (r) log.push(r); }
      catch (e) { log.push("step failed: " + e.message); }
    }
    bump("tricks"); diary(`did the "${k.replace(/_/g, " ")}" trick`);
    logEvent("trick", { detail: k });
    let out = `Performed "${k}" (${t.about}).`;
    if (theirPart.length) out += ` Now YOU do your part, right in this reply: ${theirPart.join(" Then: ")}`;
    if (log.some(l => /^FAILED|failed/.test(l))) out += " Problems: " + log.filter(l => /FAILED|failed/.test(l)).join("; ");
    return out;
  }

  async function runStep(st, ctx) {
    if (st.say) { await speak(String(st.say)); transcriptLine("bot", st.say); return; }
    if (st.mood) { setMood(st.mood); return; }
    if (st.face) { Face.effect(st.face, clamp(+st.seconds || 5, 1, 60)); return; }
    if (st.gesture) { Face.gesture(st.gesture); await sleep(st.gesture === "scan_room" ? 4000 : st.gesture === "eye_roll" ? 1100 : 500); return; }
    if (st.sfx) return await Abilities.sfx(st.sfx);
    if (st.song || st.notes) return await playSong({ song: st.song, notes: st.notes, tempo: st.tempo, instrument: st.instrument, drums: st.drums });
    if (st.vibrate) return Abilities.vibrate(st.vibrate);
    if (st.wait) { await sleep(clamp(+st.wait, 0, 20) * 1000); return; }
    if (st.voice) { settings.voiceStyle = VOICE_STYLES[st.voice] ? st.voice : "normal"; saveSettings(); return; }
    if (st.sing) return await sing({ lyrics: st.sing, song: st.song });
    if (st.morse) return await sendMorse(st.morse, st.flashlight);
    if (st.echo) return await echo(st.echo, st.effect);
    if (st.game) return await playGame(st.game);
    if (st.part || st.drive) {
      if (ctx.auto && !settings.autoMove) return "skipped moving (moving on her own is off)";
      return st.part ? await usePart(st.part, st.action || "wave", st.seconds) : await drive(st.drive, st.seconds || 1);
    }
    if (st.ai) {
      if (ctx.fromTool) { ctx.theirPart.push(st.ai); return; }
      await ask(`(system: you're performing a trick. Your part now: ${st.ai})`, { quiet: true, auto: true, note: "trick" });
      return;
    }
  }

  // ================= games =================
  // Each returns a result string she can react to.
  function withTouches(handler) {
    const orig = Face.onTouch;
    Face.onTouch = (k, z, x) => handler(k, z, x);
    return () => { Face.onTouch = orig; };
  }
  const waitTouch = (ms, filter = () => true) => new Promise(res => {
    let done = false;
    const restore = withTouches((k, z) => { if (!done && filter(k, z)) { done = true; restore(); res({ k, z, t: performance.now() }); } });
    setTimeout(() => { if (!done) { done = true; restore(); res(null); } }, ms);
  });

  async function playGame(name) {
    const games = { simon, reaction, staring, redlight, color: colorHunt, claps: clapEcho, rps: () => window.Vision?.rockPaperScissors ? Vision.rockPaperScissors() : "FAILED: vision isn't loaded." };
    if (!games[name]) return `FAILED: games are ${Object.keys(games).join(", ")}.`;
    bump("games");
    const r = await games[name]();
    diary(`played ${name}: ${r}`);
    return r;
  }

  async function simon() {
    const zones = ["left eye", "right eye", "nose", "mouth"];
    const tone = { "left eye": "E5/8", "right eye": "C5/8", nose: "G5/8", mouth: "C4/8" };
    const hue = { "left eye": 200, "right eye": 120, nose: 50, mouth: 0 };
    await speak("Simon Says. Watch my face, then tap the same spots in order.");
    const seq = [];
    for (let round = 1; round <= 12; round++) {
      seq.push(pick(zones));
      await sleep(600);
      for (const z of seq) { Face.highlightZone(z, 450, hue[z]); Abilities.play({ notes: tone[z], tempo: 120, instrument: "bell", vibrate: false }); await sleep(650); }
      for (const z of seq) {
        const t = await waitTouch(6000);
        const zone = t && (t.z.includes("eye") ? t.z : t.z === "nose" ? "nose" : t.z === "mouth" ? "mouth" : t.z);
        if (!t || zone !== z) {
          await Abilities.sfx("sad_trombone");
          const score = round - 1; best("simon", score);
          return `Simon Says over. He got ${score} round${score === 1 ? "" : "s"} (${!t ? "too slow" : `tapped ${t.z} instead of ${z}`}). Best ever: ${stats.best_simon || score}.`;
        }
        Face.highlightZone(z, 200, hue[z]); Abilities.play({ notes: tone[z], tempo: 200, instrument: "bell", vibrate: false });
      }
      Abilities.sfx("coin");
    }
    best("simon", 12);
    return "He beat all 12 rounds of Simon Says. Unbelievable.";
  }

  async function reaction() {
    await speak("Reaction test. Tap my face the instant it flashes. Not before.");
    const times = [];
    for (let i = 0; i < 3; i++) {
      const early = await waitTouch(1500 + Math.random() * 2500);
      if (early) { await speak("Too early. Cheater."); continue; }
      Face.flash(true); Abilities.sfx("beep"); const t0 = performance.now();
      const hit = await waitTouch(2000); Face.flash(false);
      if (!hit) { await speak("Too slow."); continue; }
      const ms = Math.round(hit.t - t0); times.push(ms);
      transcriptLine("act", `reaction: ${ms} ms`);
    }
    if (!times.length) return "Reaction test: he didn't get a single valid tap.";
    const bestMs = Math.min(...times); best("reaction_ms", bestMs, true);
    return `Reaction test: ${times.join(", ")} ms. Best ${bestMs} ms. All-time best ${stats.best_reaction_ms} ms.`;
  }

  async function staring() {
    const eyes = window.Vision?.available && Vision.faces > 0;
    await speak(eyes ? "Staring contest. I'm watching your eyes. First to blink loses. Go." : "Staring contest. I won't blink. Tap my face the second you blink. Go.");
    setMood("suspicious"); Face.noBlink(60);
    const herLimit = 8000 + Math.random() * 22000;
    const t0 = performance.now();
    const hit = await new Promise(res => {                  // his blink: seen by the camera, or he taps
      let off = () => {};
      const done = v => { off(); res(v); };
      if (eyes) off = Vision.on("blink", () => { if (performance.now() - t0 > 1500) done(true); });
      waitTouch(herLimit).then(done);
    });
    Face.noBlink(0);
    const s = ((performance.now() - t0) / 1000).toFixed(1);
    if (hit) { setMood("smug"); Abilities.sfx("tada"); bump("staring_wins"); return `Staring contest: he blinked after ${s} seconds. She wins.`; }
    Face.gesture("double_blink"); setMood("annoyed");
    return `Staring contest: she blinked first after ${s} seconds. He wins (she's furious).`;
  }

  async function redlight() {
    if (!settings.track) return "FAILED: eyes-follow-movement (camera) is off, so she can't see him move. Turn it on in Settings.";
    await speak("Red light, green light. Move on green, freeze on red. If I see you move on red, you're out.");
    for (let round = 1; round <= 4; round++) {
      setMood("happy"); await speak("Green light!"); await sleep(2500 + Math.random() * 3500);
      setMood("suspicious"); Face.effect("laser_eyes", 0.6); await speak("Red light!");
      await sleep(700);                                        // grace period
      const start = performance.now(); let caught = false;
      while (performance.now() - start < 3500) { if (window.lastMotion && performance.now() - lastMotion.t < 250 && lastMotion.frac > 0.03) { caught = true; break; } await sleep(100); }
      if (caught) { Abilities.sfx("alarm"); setMood("angry"); return `Red light green light: she caught him moving in round ${round}.`; }
    }
    Abilities.sfx("tada"); return "Red light green light: he survived all 4 rounds without moving on red.";
  }

  async function colorHunt() {
    if (!(await ensureVideo())) return "FAILED: no camera.";
    const target = pick(["red", "blue", "green", "yellow", "orange", "purple", "pink"]);
    await speak(`Color hunt! Show me something ${target}. You have twenty seconds.`);
    const start = performance.now(); let streak = 0;
    while (performance.now() - start < 20000) {
      const c = colorNow();
      if (c && c.name === target) { if (++streak >= 3) { Abilities.sfx("coin"); bump("color_hunts"); return `Color hunt: he found ${target} in ${((performance.now() - start) / 1000).toFixed(1)} seconds.`; } }
      else streak = 0;
      await sleep(250);
    }
    return `Color hunt: he couldn't find anything ${target} in time. She saw ${colorNow()?.name || "nothing useful"}.`;
  }

  async function clapEcho() {
    if (!ears.running && !(await earsStart(true))) return "FAILED: her ears (microphone) aren't available right now.";
    const n = 2 + Math.floor(Math.random() * 4);
    await speak(`Clap back what I play.`);
    await Abilities.play({ notes: Array(n).fill("C4/8").join(" R/8 "), tempo: 110, drums: "", instrument: "bass", vibrate: false });
    clapCount = 0; clapGameActive = true;
    await sleep(4500);
    clapGameActive = false;
    return clapCount === n ? `Clap echo: he clapped ${n} times, correct.` : `Clap echo: she played ${n} claps, he clapped ${clapCount}.`;
  }

  // ================= ears: claps, bangs, shouting =================
  const ears = { running: false, stream: null, ctx: null, an: null, timer: null, base: 0.02, prev: 0, loudSince: 0 };
  let claps = [], clapCount = 0, clapGameActive = false;
  async function earsStart(force = false) {
    if (ears.running) { ears.ctx?.resume?.(); return true; }
    // offline hearing (hearing.js) listens through this same microphone, so it keeps the ears open
    if (!force && !window.Hearing?.active && (!settings.ears || settings.listen === "always" || listening)) return false;
    try {
      ears.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      ears.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ears.ctx.createMediaStreamSource(ears.stream);
      ears.an = ears.ctx.createAnalyser(); ears.an.fftSize = 512; src.connect(ears.an);
      // keep the last ~1 second of raw sound for the sound classifier (vision.js)
      ears.ring = new Float32Array(Math.round(ears.ctx.sampleRate)); ears.ringPos = 0;
      const tap = ears.ctx.createScriptProcessor(4096, 1, 1);
      tap.onaudioprocess = e => {
        const d = e.inputBuffer.getChannelData(0), r = ears.ring;
        for (let i = 0; i < d.length; i++) { r[ears.ringPos] = d[i]; ears.ringPos = (ears.ringPos + 1) % r.length; }
        try { window.Hearing?.onAudio(d, ears.ctx.sampleRate); } catch {}
        try { window.AudioSmarts?.onAudio(d, ears.ctx.sampleRate); } catch {}
      };
      const mute = ears.ctx.createGain(); mute.gain.value = 0;
      src.connect(tap); tap.connect(mute); mute.connect(ears.ctx.destination);
      const buf = new Float32Array(ears.an.fftSize);
      ears.running = true;
      ears.timer = setInterval(() => {
        if (document.hidden) return;
        ears.an.getFloatTimeDomainData(buf);
        let sum = 0, peak = 0; for (const v of buf) { sum += v * v; peak = Math.max(peak, Math.abs(v)); }
        const rms = Math.sqrt(sum / buf.length);
        const quietSelf = !talking && !Abilities.isPlaying();
        // a clap: sudden sharp spike well above the room's background
        if (quietSelf && peak > 0.5 && rms > Math.max(0.12, ears.base * 6) && ears.prev < rms * 0.4) onClap(peak);
        // shouting: loud for over a second
        if (quietSelf && rms > Math.max(0.15, ears.base * 5)) { if (!ears.loudSince) ears.loudSince = Date.now(); else if (Date.now() - ears.loudSince > 1200) { ears.loudSince = 0; onShout(); } }
        else ears.loudSince = 0;
        ears.base = ears.base * 0.995 + rms * 0.005;
        ears.prev = rms;
      }, 25);
      return true;
    } catch (e) { logEvent("error", { where: "ears", detail: e.message }); earsStop(); return false; }
  }
  function earsStop() {
    clearInterval(ears.timer); ears.running = false;
    ears.stream?.getTracks().forEach(t => t.stop()); ears.stream = null;
    ears.ctx?.close().catch(() => {}); ears.ctx = null;
  }
  let lastClap = 0, clapTimer = null;
  function onClap(peak) {
    const now = Date.now();
    if (now - lastClap < 120) return;                       // same clap echoing
    lastClap = now;
    if (clapGameActive) { clapCount++; Face.kick(); return; }
    claps.push(now); Face.gesture("look_up");
    clearTimeout(clapTimer);
    clapTimer = setTimeout(() => {
      const n = claps.length; claps = [];
      bump("claps", n);
      if (!settings.react) return;
      if (n === 1 && peak > 0.9) { Face.gesture("startle"); react("bang", "you heard a sudden loud bang, like a knock or something dropped", 1); }
      else if (n === 2) { Face.gesture("wide"); if (settings.listen === "push" && !busy) { Abilities.sfx("beep"); startListening(); } }
      else if (n === 3) { if (!busy) runTrick("random", { auto: true }); }
      else if (n >= 4) { setMood("excited"); react("applause", `he just clapped ${n} times, like applause`, 1); }
    }, 900);
  }
  function onShout() { if (settings.react) { Face.gesture("startle"); react("shout", "someone near you is shouting / being really loud", 2); } }

  // ================= echo: record and play back with effects =================
  async function echo(seconds = 4, effect = "chipmunk") {
    const secs = clamp(+seconds || 4, 1, 8);
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return "FAILED: microphone not available."; }
    const restartEars = ears.running; earsStop();
    stopListening(true);
    const rec = new MediaRecorder(stream), chunks = [];
    rec.ondataavailable = e => chunks.push(e.data);
    Abilities.sfx("beep"); Face.setState("listening", true);
    rec.start(); await sleep(secs * 1000); rec.stop();
    await new Promise(r => rec.onstop = r);
    stream.getTracks().forEach(t => t.stop()); Face.setState("listening", false);
    const ac = Abilities.ctx(); if (ac.state !== "running") await ac.resume().catch(() => {});
    let buf;
    try { buf = await ac.decodeAudioData(await new Blob(chunks).arrayBuffer()); } catch { return "FAILED: couldn't decode the recording."; }
    if (effect === "reverse") for (let c = 0; c < buf.numberOfChannels; c++) buf.getChannelData(c).reverse();
    const src = ac.createBufferSource(); src.buffer = buf;
    src.playbackRate.value = { chipmunk: 1.65, deep: 0.65, fast: 1.4, slow: 0.75 }[effect] || 1;
    let out = Abilities.out();
    if (effect === "robot") {                                 // ring modulation = classic robot voice
      const g = ac.createGain(); g.gain.value = 0; const o = ac.createOscillator(); o.frequency.value = 55; o.connect(g.gain); o.start(); src.onended = () => o.stop();
      src.connect(g); g.connect(out);
    } else src.connect(out);
    Face.setTalking(true); const kick = setInterval(() => Face.kick(), 160);
    src.start(); await new Promise(r => src.onended = r);
    clearInterval(kick); Face.setTalking(false); resumeListening();
    if (restartEars) earsStart();
    bump("echoes");
    return `Recorded ${secs}s and played it back (${effect}).`;
  }

  // ================= eyes extras: color, QR =================
  const sampleCanvas = document.createElement("canvas"); sampleCanvas.width = 64; sampleCanvas.height = 48;
  const sctx = sampleCanvas.getContext("2d", { willReadFrequently: true });
  function videoEl() { return window.trackVid?.readyState >= 2 ? trackVid : ($("#cam").readyState >= 2 ? $("#cam") : null); }
  function hsv(r, g, b) {
    r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0; if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
  }
  function colorName(h, s, v) {
    if (v < 0.18) return "black"; if (s < 0.15) return v > 0.8 ? "white" : "gray";
    if (h < 15 || h >= 340) return s < 0.5 && v > 0.7 ? "pink" : "red";
    if (h < 40) return v < 0.55 ? "brown" : "orange"; if (h < 70) return "yellow"; if (h < 165) return "green";
    if (h < 200) return "cyan"; if (h < 255) return "blue"; if (h < 290) return "purple"; return "pink";
  }
  // What color is in the middle of her view right now?
  async function ensureVideo() {
    if (videoEl()) return true;
    try { await camOn(); } catch { return false; }
    for (let i = 0; i < 30 && !videoEl(); i++) await sleep(100);
    return !!videoEl();
  }
  function colorNow() {
    const v = videoEl(); if (!v) return null;
    sctx.drawImage(v, 0, 0, 64, 48);
    const d = sctx.getImageData(22, 16, 20, 16).data;
    const counts = {};
    for (let i = 0; i < d.length; i += 4) { const n = colorName(...hsv(d[i], d[i + 1], d[i + 2])); counts[n] = (counts[n] || 0) + 1; }
    const [name, c] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return { name, share: c / (d.length / 4) };
  }

  const detector = "BarcodeDetector" in window ? new BarcodeDetector() : null;
  const seenCodes = {};
  let lastScan = 0;
  async function scanOnce() {
    const v = videoEl(); if (!detector || !v) return [];
    try { return await detector.detect(v); } catch { return []; }
  }
  // Called by the camera tracker about once a second.
  async function scanTick() {
    if (!detector || Date.now() - lastScan < 1200 || !settings.qr) return;
    lastScan = Date.now();
    for (const code of await scanOnce()) onCode(code.rawValue, code.format);
  }
  function onCode(text, format) {
    if (seenCodes[text] && Date.now() - seenCodes[text] < 60000) return;
    seenCodes[text] = Date.now();
    diary(`saw a ${format} code: ${text.slice(0, 80)}`);
    bump("codes");
    const m = text.match(/^nessari:(\w+):(.*)$/i);           // command codes you can print: nessari:trick:possessed
    if (m) {
      const [, cmd, arg] = m;
      Abilities.sfx("coin");
      if (cmd === "trick") return runTrick(arg);
      if (cmd === "say") return speak(arg);
      if (cmd === "mood") return setMood(arg);
      if (cmd === "song") return playSong({ song: arg });
      if (cmd === "effect") return Face.effect(arg, 8);
    }
    react("code-" + text.slice(0, 20), `you just spotted a ${format.replace(/_/g, " ")} code. It says: "${text.slice(0, 200)}"`, 1);
  }

  // ================= achievements + diary =================
  let stats = {};
  async function loadStats() { try { stats = JSON.parse(await readFile("stats.json")) || {}; } catch { stats = {}; } if (!stats.born) { stats.born = today(); saveStats(); } }
  let saveT = null;
  const saveStats = () => { clearTimeout(saveT); saveT = setTimeout(() => writeFile("stats.json", JSON.stringify(stats, null, 2)).catch(() => {}), 1500); };
  const MILESTONES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
  const LABELS = { tricks: "tricks performed", songs: "songs played", games: "games played", claps: "claps heard", echoes: "echoes",
    codes: "codes scanned", staring_wins: "staring contests won", color_hunts: "color hunts", touch_tap: "pokes", touch_boop: "boops",
    touch_scratch: "scratches", touch_stroke: "pets", touch_slap: "slaps", touch_tickle: "tickles", visitors: "people walking in", conversations: "conversations" };
  function bump(key, n = 1) {
    const before = stats[key] || 0; stats[key] = before + n; saveStats();
    const hit = MILESTONES.find(m => before < m && stats[key] >= m);
    if (hit && LABELS[key]) {
      diary(`achievement: ${hit} ${LABELS[key]}`);
      setTimeout(() => speakUp(`(system: achievement unlocked: ${hit} ${LABELS[key]}! Announce it proudly and briefly.)`, `achievement ${key} ${hit}`), 2500);
      Abilities.sfx("tada");
    }
  }
  function best(name, v, lower = false) {
    const k = "best_" + name;
    if (stats[k] == null || (lower ? v < stats[k] : v > stats[k])) { stats[k] = v; saveStats(); }
  }
  function diary(line) {
    const t = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    writeFile(`diary/${today()}.md`, `- ${t} ${line}\n`, true).catch(() => {});
  }
  async function readDiary(date) {
    const d = /^\d{4}-\d\d-\d\d$/.test(date || "") ? date : today();
    let text = ""; try { text = await readFile(`diary/${d}.md`); } catch {}
    const s = Object.entries(stats).filter(([k]) => k !== "born").map(([k, v]) => `${LABELS[k] || k.replace(/_/g, " ")}: ${v}`).join(", ");
    return `Diary for ${d}:\n${text.slice(-3000) || "(nothing written)"}\n\nLifetime stats (alive since ${stats.born}): ${s || "none yet"}`;
  }

  // ================= phone pose + network reactions =================
  let poseState = { upside: false, tiltSide: 0, tiltSince: 0, pickedAt: 0, stillSince: Date.now() };
  setInterval(() => {
    if (typeof pose === "undefined" || typeof grav === "undefined" || !grav) return;
    const upside = pose === "upside_down";
    if (upside && !poseState.upside) { Face.effect("dizzy", 3); react("upside", "you're being held upside down", 1); }
    poseState.upside = upside;
    // a lean to the side only counts while she's roughly standing (lying flat is not a tilt)
    const n = Math.hypot(grav.x, grav.y, grav.z) || 1, gx = grav.x / n, gy = grav.y / n;
    const side = pose !== "flat" && gy > 0.5 && Math.abs(gx) > 0.35 && Math.abs(gx) < 0.75 ? -Math.sign(gx) : 0;
    if (side !== poseState.tiltSide) { poseState.tiltSide = side; poseState.tiltSince = Date.now(); }
    else if (side && Date.now() - poseState.tiltSince > 1500 && Date.now() - poseState.tiltSince < 1700) {
      Face.gesture(side > 0 ? "look_right" : "look_left");
      if (Math.random() < 0.4) react("tilt", `you're being tilted to your ${side > 0 ? "right" : "left"}`, 3);
    }
  }, 200);
  window.addEventListener("devicemotion", e => {
    const a = e.accelerationIncludingGravity; if (!a || a.x == null) return;
    const g = Math.hypot(a.x, a.y, a.z);
    if (g > 30) { Face.gesture("startle"); react("impact", "you just took a hard hit or got dropped (big impact)", 1, true); }
    if (Math.abs(g - 9.8) > 3) { poseState.pickedAt = Date.now(); poseState.stillSince = Date.now(); }
    else if (poseState.pickedAt && Date.now() - poseState.stillSince > 3000 && Date.now() - poseState.pickedAt < 60000) {
      poseState.pickedAt = 0; if (Math.random() < 0.5) react("putdown", "you were just set back down after being carried around", 2);
    }
  });
  window.addEventListener("offline", () => { setMood("sad"); react("offline", "your internet just dropped; you're on your small offline brain now", 1, true); });
  window.addEventListener("online", () => { setMood("happy"); setTimeout(() => react("online", "your internet just came back; your big brain is back", 1), 4000); });
  // dark room: dim her face a bit (lux from Termux:API sensors or the browser)
  setInterval(() => {
    const name = typeof hw !== "undefined" && hw?.sensors && Object.keys(hw.sensors).find(n => /light/i.test(n) && !/proximity/i.test(n));
    const lux = name ? hw.sensors[name][0] : (typeof light !== "undefined" ? light : null);
    if (lux == null) return;
    Face.setNightDim(lux < 2 ? 0.45 : lux < 10 ? 0.25 : 0);
  }, 3000);

  // ignored for a long time in the daytime: visibly bored
  setInterval(() => {
    if (typeof lastTalk === "undefined" || typeof mood === "undefined") return;
    const h = new Date().getHours();
    if (mood === "calm" && Date.now() - lastTalk > 8 * 60000 && h >= 8 && h < 23 && !busy) { setMood("bored"); Face.gesture(Math.random() < 0.5 ? "eye_roll" : "scan_room"); }
  }, 30000);

  // ================= vibration spinning (the Cycloramic trick) =================
  // A phone standing (or lying) on a smooth hard surface slowly turns when its motor buzzes.
  // Her compass/gyro measures how far she's actually turned, so she knows when to stop.
  async function vibroSpin(degrees = 360, toFace = false) {
    if (typeof orient === "undefined" || !orient || orient.compass == null) return "FAILED: no compass/gyro readings in this browser.";
    const target = clamp(Math.abs(+degrees || 360), 10, 1080), sign = Math.sign(+degrees || 1);
    let last = orient.compass, turned = 0;
    const t0 = Date.now(), my = ++trickToken;
    const buzz = setInterval(() => navigator.vibrate?.(1200), 1000); navigator.vibrate?.(1200);
    Face.effect("dizzy", 30);
    try {
      while (Date.now() - t0 < 25000 && my === trickToken) {
        await sleep(100);
        const a = orient.compass; let d = a - last; if (d > 180) d -= 360; if (d < -180) d += 360; turned += d; last = a;
        if (toFace) { if (window.Vision?.main && Math.abs(Vision.main.x) < 0.15) break; }
        else if (Math.abs(turned) >= target) break;
      }
    } finally { clearInterval(buzz); navigator.vibrate?.(0); Face.effect("dizzy", 0); }
    bump("spins");
    const deg = Math.round(Math.abs(turned));
    if (toFace) return window.Vision?.main && Math.abs(Vision.main.x) < 0.15 ? `Turned ${deg}° and found his face.` : `Turned ${deg}° but didn't line up with a face.`;
    return deg < 15 ? `Buzzed for ${Math.round((Date.now() - t0) / 1000)}s but only turned ${deg}°. Stand the phone on a smooth hard surface (no grippy case) and try again.`
                    : `Spun ${deg}° ${sign > 0 ? "" : ""}in ${((Date.now() - t0) / 1000).toFixed(1)}s using only vibration.`;
  }

  // ================= personality cycling (swipe all the way across her face) =================
  async function cyclePersona(dir = 1) {
    const names = Object.keys(PRESETS);
    const cur = names.findIndex(n => slugOf(n) === slugOf(personality.name));
    const next = names[(cur + dir + names.length) % names.length];
    try { await writeFile(`personalities/${slugOf(personality.name)}.json`, JSON.stringify(personality, null, 2)); } catch {}
    let p; try { p = JSON.parse(await readFile(`personalities/${slugOf(next)}.json`)); } catch { p = structuredClone(PRESETS[next]); }
    personality = p;
    await savePersonality();
    Face.effect("glitch_storm", 1); Abilities.sfx("powerup");
    speakUp("(system: you just switched into this personality. Say hi in character, one sentence.)", "persona switch");
    return next;
  }

  // ================= changelog =================
  async function checkChangelog() {
    let r; try { r = await api("/api/changelog"); } catch { return; }
    const m = r.text.match(/^## (.+)$/m); if (!m) return;
    const version = m[1].trim();
    let seen = ""; try { seen = (await readFile(".seen-version")).trim(); } catch {}
    if (seen === version) return;
    await writeFile(".seen-version", version).catch(() => {});
    if (!seen) return;                                         // fresh install: don't announce
    const section = r.text.slice(m.index).split(/\n## /)[0].slice(0, 2500);
    diary(`got updated to ${version}`);
    setTimeout(() => speakUp(`(system: you just got updated. Here's your changelog entry:\n${section}\nTell him, excitedly but briefly, the two or three coolest new things you can do now.)`, "updated"), 9000);
  }

  // ================= tools for her brain =================
  const TOOLS = [
    { name: "do_trick", description: "Perform a trick from your trick book. Use name \"random\" when he just says 'do a trick'. Use list_tricks if you don't know the names.",
      input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
    { name: "list_tricks", description: "See every trick you know (built-in and the ones you invented), with descriptions.", input_schema: { type: "object", properties: {} } },
    { name: "save_trick", description: "Invent and save a new trick (or update one of yours) when something cool happens or he asks. steps is a list run in order. Step types: {say}, {mood}, {face, seconds}, {gesture}, {sfx}, {song} or {notes, tempo, instrument, drums}, {vibrate}, {wait: seconds}, {voice}, {sing}, {morse}, {echo: seconds, effect}, {game}, {part, action}, {drive, seconds}, {ai: instructions for an improvised part you'll do live}.",
      input_schema: { type: "object", properties: { name: { type: "string" }, about: { type: "string" }, steps: { type: "array", items: { type: "object" } } }, required: ["name", "about", "steps"] } },
    { name: "forget_trick", description: "Delete one of the tricks you invented.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
    { name: "face_gesture", description: "A quick face move: " + "wink_left, wink_right, double_blink, squint, wide, eye_roll, side_eye_left, side_eye_right, look_left, look_right, look_up, look_down, scan_room, startle, reboot, nod, shake_head.",
      input_schema: { type: "object", properties: { gesture: { type: "string" } }, required: ["gesture"] } },
    { name: "play_game", description: "Start a game with him: rps (rock paper scissors, reads his hand offline), simon (Simon Says on your face), reaction (reaction-time test), staring (staring contest), redlight (red light green light with your camera), color (color hunt), claps (clap-back). The result comes back when it's over.",
      input_schema: { type: "object", properties: { game: { type: "string", enum: ["simon", "reaction", "staring", "redlight", "color", "claps", "rps"] } }, required: ["game"] } },
    { name: "echo", description: "Record him for a few seconds and play it back with an effect: chipmunk, deep, reverse, robot, fast, slow, normal.",
      input_schema: { type: "object", properties: { seconds: { type: "number" }, effect: { type: "string" } } } },
    { name: "what_color", description: "Check what color is in the middle of your camera view right now (instant, no internet).", input_schema: { type: "object", properties: {} } },
    { name: "scan_code", description: "Look for a QR code or barcode in front of your camera for up to 5 seconds and read it.", input_schema: { type: "object", properties: {} } },
    { name: "eye_mode", description: "Choose what your eyes follow through the camera: motion (default), bright (a flashlight or lamp), or a color (red, blue, green, yellow, orange, purple, pink).",
      input_schema: { type: "object", properties: { mode: { type: "string" } }, required: ["mode"] } },
    { name: "read_diary", description: "Read your diary for a day (default today) plus your lifetime stats and achievements. Use it to summarize your day or brag.",
      input_schema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" } } } },
    { name: "write_diary", description: "Write a line in your diary about something notable.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "see_people", description: "Instantly check who's in front of your camera (offline): how many faces, how close, their expression, whether they're looking at you, any hand sign.",
      input_schema: { type: "object", properties: {} } },
    { name: "see_objects", description: "Instantly list the everyday objects your camera recognizes right now and where they are (offline), including what he's probably holding up.",
      input_schema: { type: "object", properties: {} } },
    { name: "mirror_mode", description: "Turn on/off copying his facial expression with your own face.", input_schema: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] } },
    { name: "vibro_spin", description: "Spin your phone body in place using only your vibration motor (works best standing or lying on a smooth hard table). degrees: how far; or face: true to turn until his face is in front of you.",
      input_schema: { type: "object", properties: { degrees: { type: "number" }, face: { type: "boolean" } } } },
    { name: "read_changelog", description: "Read your own changelog: what was added or fixed in your software, newest first.", input_schema: { type: "object", properties: {} } }
  ];
  const NAMES = new Set(TOOLS.map(t => t.name));

  async function run(name, input) {
    if (name === "do_trick") return await runTrick(input.name, { fromTool: true, auto: autoTurn });
    if (name === "list_tricks") {
      const a = all();
      return Object.entries(a).map(([k, t]) => `${k}${custom[k] ? " (yours)" : ""}: ${t.about}`).join("\n");
    }
    if (name === "save_trick") {
      let steps = input.steps;
      if (typeof steps === "string") { try { steps = JSON.parse(steps); } catch { return "FAILED: steps must be a list."; } }
      if (!Array.isArray(steps) || !steps.length) return "FAILED: a trick needs steps.";
      const k = slug(input.name); if (!k) return "FAILED: needs a name.";
      if (BUILTIN[k]) return `FAILED: "${k}" is a built-in trick. Pick another name.`;
      custom[k] = { about: String(input.about || "").slice(0, 200), steps: steps.slice(0, 40), made: today() };
      await saveCustom(); renderTrickButtons(true); diary(`invented a new trick: ${k}`); bump("tricks_invented");
      return `Saved trick "${k}". You now know ${Object.keys(all()).length} tricks.`;
    }
    if (name === "forget_trick") {
      const k = slug(input.name);
      if (!custom[k]) return BUILTIN[k] ? "FAILED: built-in tricks can't be deleted." : `FAILED: you have no trick called "${k}".`;
      delete custom[k]; await saveCustom(); renderTrickButtons(true); return `Forgot "${k}".`;
    }
    if (name === "face_gesture") return Face.gesture(input.gesture) ? `Did ${input.gesture}.` : `FAILED: gestures are ${Face.gestures.join(", ")}.`;
    if (name === "play_game") return await playGame(input.game);
    if (name === "echo") return await echo(input.seconds, input.effect || "chipmunk");
    if (name === "what_color") { await ensureVideo(); const c = colorNow(); return c ? `Mostly ${c.name} (${Math.round(c.share * 100)}% of the middle of your view).` : "FAILED: camera isn't on."; }
    if (name === "scan_code") {
      if (!detector) return "FAILED: this browser can't read codes.";
      if (!camStream) { try { await camOn(); } catch { return "FAILED: no camera."; } }
      for (let i = 0; i < 10; i++) { const r = await scanOnce(); if (r.length) { bump("codes"); return r.map(c => `${c.format}: ${c.rawValue}`).join("\n"); } await sleep(500); }
      return "No code found.";
    }
    if (name === "eye_mode") {
      const m = String(input.mode || "motion").toLowerCase();
      const ok = ["motion", "bright", "red", "blue", "green", "yellow", "orange", "purple", "pink"];
      if (!ok.includes(m)) return `FAILED: modes are ${ok.join(", ")}.`;
      settings.eyeMode = m; saveSettings(); if (!settings.track) { settings.track = true; saveSettings(); startTracking(); }
      return `Your eyes now follow ${m === "motion" ? "movement" : m === "bright" ? "bright lights" : "anything " + m}.`;
    }
    if (name === "read_diary") return await readDiary(input.date);
    if (name === "write_diary") { diary(String(input.text).slice(0, 300)); return "Written."; }
    if (name === "see_people" || name === "mirror_mode" || name === "see_objects") return window.Vision?.run ? await Vision.run(name, input) : "FAILED: vision isn't loaded.";
    if (name === "vibro_spin") return await vibroSpin(input.degrees, input.face);
    if (name === "read_changelog") { try { return (await api("/api/changelog")).text.slice(0, 6000); } catch (e) { return "FAILED: " + e.message; } }
    return "Unknown tool " + name;
  }

  // ================= Tricks tab: trick book buttons =================
  function renderTrickButtons(force = false) {
    const box = document.getElementById("trBook"); if (!box || (box.childElementCount && !force)) return;
    box.innerHTML = "";
    const a = all();
    for (const k of Object.keys(a)) {
      const b = document.createElement("button");
      b.textContent = (custom[k] ? "★ " : "") + k.replace(/_/g, " ");
      b.title = a[k].about;
      b.onclick = () => { $("#panel").hidden = true; document.body.classList.remove("panel-open"); runTrick(k); };
      box.append(b);
    }
  }

  window.Tricks = {
    tools: TOOLS, handles: n => NAMES.has(n), run, runTrick, list: () => Object.keys(all()), all,
    // the last second of sound, oldest first (null if her ears are off or she's making noise herself)
    earsSamples() {
      if (!ears.running || !ears.ring || talking || Abilities.isPlaying()) return null;
      const r = ears.ring, out = new Float32Array(r.length);
      out.set(r.subarray(ears.ringPos)); out.set(r.subarray(0, ears.ringPos), r.length - ears.ringPos);
      return { data: out, rate: ears.ctx.sampleRate };
    },
    loadCustom, loadStats, bump, diary, earsStart, earsStop, scanTick, colorNow, colorName, hsv, cyclePersona, checkChangelog,
    renderTrickButtons, summary: () => Object.keys(all()).join(", ")
  };
})();
