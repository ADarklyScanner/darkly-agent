// Marker tags: small printed squares (ArUco markers) she recognizes instantly and reliably, with no AI involved.
// Stick one on the charger, the toolbox, a doorway. She knows which tag it is, roughly where it is in her view
// and roughly how far. Later, with a body, these are landmarks and docking targets.
// Detection is js-aruco2 (MIT), in lib/aruco. Print the tags from /tags.html.
(() => {
  "use strict";
  const T = window.Tags = { seen: {}, names: {}, enabled: true, available: !!window.AR };
  const FILE = "tags.json";
  const SIZE_CM = 5;                         // the printed black square is assumed to be 5 cm wide (set tagSizeCm in Settings data to change)
  let detector = null, canvas = null, ctx = null, loaded = false;
  const now = () => performance.now();

  async function load() {
    if (loaded) return; loaded = true;
    try { T.names = JSON.parse(await readFile(FILE)) || {}; } catch { T.names = {}; }
  }
  const save = () => writeFile(FILE, JSON.stringify(T.names, null, 1)).catch(() => {});
  const label = id => T.names[id]?.name ? `the "${T.names[id].name}" tag` : `tag number ${id} (no name yet)`;

  // Find tags in a video frame or image. Returns [{ id, x, y, size, cm, side }] (x,y in -1..1 of the picture; hers).
  T.detect = src => {
    if (!window.AR) return [];
    if (!detector) {
      detector = new AR.Detector({ dictionaryName: "ARUCO_MIP_36h12", maxHammingDistance: 4 });
      // The library's own detect() throws away the smaller of two nearby squares. A tag's white paper border is itself
      // a square right around the black one, so small or distant tags got discarded. Keep both and decode both.
      detector.detect = function (image) {
        CV.grayscale(image, this.grey); CV.adaptiveThreshold(this.grey, this.thres, 2, 7);
        this.contours = CV.findContours(this.thres, this.binary);
        this.candidates = this.findCandidates(this.contours, image.width * 0.01, 0.05, 10);
        this.candidates = this.clockwiseCorners(this.candidates);
        this.candidates = this.notTooNear(this.candidates, 2);
        const seen = new Set();
        return this.findMarkers(this.grey, this.candidates, 49).filter(m => !seen.has(m.id) && seen.add(m.id));
      };
    }
    const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height; if (!sw) return [];
    const w = Math.min(sw, 800), h = Math.round(sh * w / sw);          // more pixels = tags readable from further away
    if (!canvas) { canvas = document.createElement("canvas"); ctx = canvas.getContext("2d", { willReadFrequently: true }); }
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.drawImage(src, 0, 0, w, h);
    let markers = []; try { markers = detector.detect(ctx.getImageData(0, 0, w, h)); } catch { return []; }
    return markers.map(m => {
      const cx = m.corners.reduce((a, c) => a + c.x, 0) / 4, cy = m.corners.reduce((a, c) => a + c.y, 0) / 4;
      const side = (Math.hypot(m.corners[0].x - m.corners[1].x, m.corners[0].y - m.corners[1].y) + Math.hypot(m.corners[1].x - m.corners[2].x, m.corners[1].y - m.corners[2].y)) / 2;
      // distance from apparent size, assuming a typical phone camera (about 70 degrees wide). Rough, but it's a number.
      const focal = w / (2 * Math.tan(35 * Math.PI / 180));
      const cm = (T.sizeCm || SIZE_CM) * focal / Math.max(1, side);
      return { id: m.id, x: cx / w * 2 - 1, y: cy / h * 2 - 1, size: side / w, cm: Math.round(cm) };
    });
  };
  const whereOf = t => `${t.x < -0.33 ? "on your left" : t.x > 0.33 ? "on your right" : "straight ahead"}, about ${t.cm < 100 ? Math.round(t.cm / 5) * 5 + " cm" : (t.cm / 100).toFixed(1) + " m"} away`;

  // Called about twice a second by the camera tracker.
  let lastScan = 0;
  T.tick = video => {
    if (!T.enabled || !window.AR || now() - lastScan < 700 * (window.Power?.slow || 1) || !video || video.readyState < 2) return;
    if (typeof settings !== "undefined" && settings.tags === false) return;
    lastScan = now(); load();
    const found = T.detect(video);
    const here = new Set();
    for (const t of found) {
      here.add(t.id);
      const s = T.seen[t.id] ||= { hits: 0, first: now(), announced: -1e9 };
      s.hits++; s.last = now(); s.at = t; s.where = whereOf(t);
      if (s.hits === 2 && now() - s.announced > 60000) {                 // seen twice in a row: it's really there
        s.announced = now(); onSeen(t, s);
      }
    }
    for (const [id, s] of Object.entries(T.seen)) if (!here.has(+id) && now() - s.last > 3000) s.hits = 0;
  };
  function onSeen(t, s) {
    const named = T.names[t.id];
    window.Mind?.event("tag", `you see ${label(t.id)} ${s.where}`, { source: "SAW", conf: 0.98, salience: named ? 0.35 : 0.5 });
    if (named) {
      window.Mind?.run?.("note_where", { thing: named.name, where: `${s.where} (by its tag)`, how: "saw" })?.catch?.(() => {});
      // hungry and there's the charger: she lights up
      if (/charger|dock|charging/i.test(named.name) && typeof battery !== "undefined" && battery && !battery.charging && battery.level < 0.3) {
        window.Face?.prim?.pupils(1.5, 2000); window.Face?.gesture("wide");
        if (typeof react === "function") react("charger-seen", `you can see your charger ${s.where} and your battery is low`, 10);
      }
      if (named.trick && window.Tricks?.runTrick) Tricks.runTrick(named.trick);
    } else if (typeof react === "function") react("tag-" + t.id, `you spotted a marker tag you don't have a name for (number ${t.id}) ${s.where}. You could ask what it marks.`, 30);
  }

  T.visible = () => Object.entries(T.seen).filter(([, s]) => s.hits > 0 && now() - s.last < 2500).map(([id, s]) => ({ id: +id, name: T.names[id]?.name || null, where: s.where }));
  T.describe = () => {
    const v = T.visible();
    const known = Object.entries(T.names).map(([id, n]) => `${id} = ${n.name}`).join(", ");
    return (v.length ? "Tags in view: " + v.map(t => `${t.name ? `"${t.name}"` : "unnamed"} (number ${t.id}) ${t.where}`).join("; ") + "." : "No marker tags in view right now.")
      + (known ? ` Tags you know: ${known}.` : " You haven't named any tags yet.");
  };
  T.name = async (name, id, trick) => {
    await load();
    if (id == null || id === "") { const v = T.visible(); if (v.length !== 1) return v.length ? "FAILED: more than one tag is in view. Say which number." : "FAILED: you don't see a tag right now. He should hold it in front of your camera."; id = v[0].id; }
    id = Number(id); if (!(id >= 0 && id < 250)) return "FAILED: tag numbers go from 0 to 249.";
    name = String(name || "").trim().slice(0, 40); if (!name) return "FAILED: give it a name.";
    T.names[id] = { name, trick: trick || null, t: Date.now() }; save();
    return `Tag number ${id} is now "${name}"${trick ? ` and starts the trick "${trick}"` : ""}. Whenever you see it you'll know that's where the ${name} is.`;
  };
  T.forget = async idOrName => { await load(); const k = Object.keys(T.names).find(id => id === String(idOrName) || T.names[id].name.toLowerCase() === String(idOrName).toLowerCase());
    if (!k) return "You don't have a tag by that name or number."; delete T.names[k]; save(); return "Forgotten."; };
  T.svg = id => new AR.Dictionary("ARUCO_MIP_36h12").generateSVG(id);
  setTimeout(() => load().catch(() => {}), 3000);
})();
