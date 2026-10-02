// Keeps Nessari from repeating herself.
//  - Remembers everything she's said lately (data/said-recently.json, survives restarts).
//  - Tells the brain what she already said and which words she's overusing ("ghost" after the 3rd time).
//  - Gives every spontaneous line a random angle × tone × length (thousands of combinations), so the same
//    event doesn't produce the same sentence.
//  - Checks a new line against the old ones. Too similar: try once more, then stay quiet. Silence beats a rerun.
//  - Counts how often she's commented on the same thing today; after a few times she notices the pattern or lets it go.
(() => {
  "use strict";
  const FILE = "said-recently.json";
  const KEEP = 300;
  let said = [];                                   // { t, text, topic }
  let loaded = false;

  async function load() {
    try { const j = JSON.parse(await readFile(FILE)); if (Array.isArray(j)) said = [...j, ...said].slice(-KEEP); } catch {}
    loaded = true; loadLikes();
  }
  let saveT = null;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => writeFile(FILE, JSON.stringify(said.slice(-KEEP))).catch(() => {}), 1500); };

  // ---------------- similarity ----------------
  const STOP = new Set(("a an the and or but so to of in on at for with is are was were be been it its it's i i'm im you you're your me my "
    + "that this what who how why when where just like do does did not no yes oh um uh hey well really very got get gonna can can't "
    + "will would should could have has had there their they them he his him she her we us our about out up down over all").split(" "));
  const words = s => String(s || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  const content = s => new Set(words(s).filter(w => w.length > 2 && !STOP.has(w)).map(w => w.replace(/(ing|ed|es|s)$/, "")));
  const grams = (s, n = 3) => { const w = words(s), out = new Set(); for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" ")); return out; };
  function similarity(a, b) {
    const A = content(a), B = content(b);
    let inter = 0; for (const x of A) if (B.has(x)) inter++;
    const jac = A.size + B.size ? inter / (A.size + B.size - inter) : 0;
    const GA = grams(a), GB = grams(b); let g = 0; for (const x of GA) if (GB.has(x)) g++;
    const gram = GA.size ? g / Math.min(GA.size, GB.size || 1) : 0;
    // short lines with the same key word ("Is that a ghost?" / "A ghost? Really?") count as the same joke
    const shortSame = A.size <= 4 && B.size <= 4 && inter >= 1 && inter >= Math.min(A.size, B.size) * 0.5;
    return Math.max(jac, gram * 0.9, shortSame ? 0.7 : 0);
  }
  function mostSimilar(text, n = 150) {
    let best = { sim: 0, text: "" };
    for (const s of said.slice(-n)) { const v = similarity(text, s.text); if (v > best.sim) best = { sim: v, text: s.text, t: s.t }; }
    return best;
  }

  // words she keeps leaning on lately (the "ghost" problem)
  function overused(n = 40, min = 3) {
    const count = {};
    for (const s of said.slice(-n)) for (const w of content(s.text)) count[w] = (count[w] || 0) + 1;
    return Object.entries(count).filter(([w, c]) => c >= min && w.length > 3).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w]) => w);
  }

  function record(text, topic = "chat") {
    text = String(text || "").trim(); if (text.length < 2) return;
    said.push({ t: Date.now(), text: text.slice(0, 300), topic }); if (said.length > KEEP) said.splice(0, said.length - KEEP);
    save();
  }
  const timesToday = (topic, hours = 12) => said.filter(s => s.topic === topic && Date.now() - s.t < hours * 3600000).length;
  const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.round(m / 60) + " h ago"; };

  // ---------------- what to tell the brain ----------------
  function avoidBlock(topic, n = 10) {
    const same = said.filter(s => s.topic === topic).slice(-6);
    const recent = said.filter(s => s.topic !== topic).slice(-(n - same.length));
    const lines = [...same, ...recent].sort((a, b) => a.t - b.t).map(s => `- "${s.text.slice(0, 110)}" (${ago(s.t)})`);
    const bad = overused();
    let out = "";
    if (lines.length) out += `Things you ALREADY said (don't reuse their idea, joke, opening or wording):\n${lines.join("\n")}\n`;
    if (bad.length) out += `Words you're overusing, don't use them now: ${bad.join(", ")}.\n`;
    return out;
  }

  // ---------------- angles × tones × lengths ----------------
  const REACT_ANGLES = [
    "make a specific, oddly confident guess about what it was (not ghosts, not aliens)", "complain about being disturbed",
    "pretend you're totally unbothered, unconvincingly", "narrate it like a nature documentary", "commentate it like a sports announcer",
    "report it like a security system with a personality", "make it about yourself somehow", "ask him a pointed question about it",
    "invent a ridiculous theory and commit to it", "connect it to something that happened earlier today", "cite a made-up statistic about it",
    "give a deadpan two-word reaction", "overreact theatrically, then immediately calm down", "make a playful threat",
    "act like you saw nothing and change the subject", "suspect him personally", "compare it to something absurd",
    "treat it like a test you're passing", "keep score of how many times it's happened", "make a tiny poem out of it",
    "speak like an old-timey detective", "sound like a tired night-shift worker", "pretend to log it in your official robot diary",
    "give it a name, like a pet", "bargain with it", "warn whoever's there that you're recording", "be smug that you noticed",
    "be quietly creeped out but play it cool", "ask the room a question", "tell it to try harder next time",
    "react with a sound effect word and nothing else", "describe it as if it were the most boring thing ever",
    "say what you'd do about it if you had arms", "act like a cat would react", "a wild exaggeration of how big it was",
    "reference your body being a phone in a funny way", "blame the Wi-Fi", "call it a sign from the universe, sarcastically",
    "pretend you're filming a documentary and this is the twist", "say it's the most interesting thing all day, and mean it a little"
  ];
  const IDLE_ANGLES = [
    "a random shower-thought", "ask him something specific about his day", "a hot take about something ordinary",
    "a mini story about something you 'did' while he wasn't looking", "a question you've secretly wondered about humans",
    "a complaint about being a phone", "a dramatic announcement about something tiny", "a made-up fun fact, then admit it's made up",
    "rate something nearby out of ten", "a plan for world domination step one, small and pathetic", "a confession",
    "a compliment that turns into a roast", "a would-you-rather question", "a riddle", "an opinion on the time of day",
    "something from your memory notes, with a new twist", "a fake news headline about your day", "a tiny poem",
    "a challenge for him", "a thing you'd buy if you had money", "a dream you claim you had while charging",
    "an unpopular opinion", "a weird question about food", "what you'd name a band", "a prediction for tomorrow",
    "a 'remember when' about something earlier today", "an idea for a YouTube bit", "say what you'd be if you weren't a robot",
    "a pep talk he didn't ask for", "something you noticed about him lately", "a review of your own face",
    "a startling but harmless question", "trivia question for him", "a thing you're proud of today", "a rule you're making up for the house",
    "your ranking of the rooms you've been in", "a sound you've been hearing and your theory about it", "a deal you want to make with him",
    "an existential question, but funny", "a nickname you just invented for him", "the best and worst thing about today so far"
  ];
  const TONES = ["dry", "excited", "suspicious", "sleepy", "smug", "theatrical", "sweet", "grumpy", "mischievous", "deadpan", "curious", "dramatic"];
  const LENGTHS = ["three to six words", "one short sentence", "one sentence", "two short sentences"];
  const pick = (a, avoid = []) => { const pool = a.filter(x => !avoid.includes(x)); return (pool.length ? pool : a)[Math.floor(Math.random() * (pool.length || a.length))]; };
  // What lands with him and what doesn't. Laughs, smiles and thumbs-up right after one of her lines push that
  // kind of line up; "stop", "not funny" and thumbs-down push it down. Kept in data/likes.json.
  let likes = {}, lastLine = null, quietUntil = 0;
  const loadLikes = async () => { try { likes = JSON.parse(await readFile("likes.json")) || {}; } catch { likes = {}; } };
  const weight = a => Math.max(0.15, Math.min(3, 1 + 0.5 * (likes[a] || 0)));
  function weighted(list, avoid) {
    const pool = list.filter(x => !avoid.includes(x)); const src = pool.length ? pool : list;
    let total = 0; for (const a of src) total += weight(a); let r = Math.random() * total;
    for (const a of src) { r -= weight(a); if (r <= 0) return a; } return src[src.length - 1];
  }
  let usedAngles = [];
  function angle(kind = "react") {
    const a = weighted(kind === "idle" ? IDLE_ANGLES : REACT_ANGLES, usedAngles), tone = weighted(TONES, []);
    usedAngles.push(a); usedAngles = usedAngles.slice(-15);              // no angle again until 15 others have been used
    lastLine = { angle: a, tone, t: Date.now() };
    return `Angle: ${a}. Tone: ${tone}. Length: ${pick(LENGTHS)}.`;
  }
  // amount: +1 he liked it, -1 he didn't. Only counts if she said something of her own in the last half minute.
  function feedback(amount, why = "") {
    if (amount < 0 && /stop|quiet|shut|enough/.test(why)) quietUntil = Date.now() + 10 * 60000;     // asked to pipe down: no chatter for ten minutes
    if (!lastLine || Date.now() - lastLine.t > 30000) return false;
    for (const k of [lastLine.angle, lastLine.tone]) likes[k] = Math.max(-4, Math.min(4, (likes[k] || 0) + amount * (k === lastLine.tone ? 0.5 : 1)));
    lastLine.t = 0;                                                       // one reaction per line
    writeFile("likes.json", JSON.stringify(likes)).catch(() => {});
    try { logEvent("auto", { detail: `learned: he ${amount > 0 ? "liked" : "didn't like"} "${lastLine.angle}" (${why})` }); } catch {}
    return true;
  }

  // The full instruction appended to any spontaneous prompt.
  function guide(topic, kind = "react") {
    const n = timesToday(topic);
    let pattern = "";
    if (n === 2) pattern = `This is the third time today you've commented on this kind of thing. Don't react the same way: notice the pattern itself, or say something unrelated.\n`;
    else if (n >= 3) pattern = `You've commented on this ${n} times today already. Either something brand new or just reply with "[quiet]".\n`;
    return `\n${angle(kind)}\n${pattern}${avoidBlock(topic)}Be original: say something you've never said before.`;
  }
  // Too many comments on one thing today: just react with the face.
  const shouldStayQuiet = topic => timesToday(topic, 6) >= 5 || Date.now() < quietUntil;

  window.Variety = { feedback, get likes() { return likes; }, get quietUntil() { return quietUntil; }, weight, load, record, similarity, mostSimilar, overused, avoidBlock, angle, guide, timesToday, shouldStayQuiet,
    get said() { return said; }, get loaded() { return loaded; },
    reactAngles: REACT_ANGLES.length, idleAngles: IDLE_ANGLES.length, combos: (REACT_ANGLES.length + IDLE_ANGLES.length) * TONES.length * LENGTHS.length };
  // readFile lives in app.js, which loads after this file
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load); else setTimeout(load, 0);
})();
