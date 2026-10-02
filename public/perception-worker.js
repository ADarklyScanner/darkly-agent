// Nessari's perception, off the main page: camera frames and sound clips come in, plain results go out.
// The face animation and touch keep running smoothly while the models work here.
import { makeVisionTasks, makeAudioTask, makeTextTask, embedTexts, detect, classify } from "./perception-common.js";

let tasks = null, audio = null, text = null, textFailed = false;
self.onmessage = async ({ data: m }) => {
  if (m.type === "init") {
    try {
      tasks = await makeVisionTasks(true);              // true = the module build of the engine, which works inside workers
      const have = Object.fromEntries(Object.entries(tasks).map(([k, v]) => [k, !!v]));
      self.postMessage({ type: "ready", have });
    } catch (e) { self.postMessage({ type: "error", where: "vision", error: String(e?.message || e) }); return; }
    try { audio = await makeAudioTask(true); self.postMessage({ type: "audio-ready" }); }
    catch (e) { self.postMessage({ type: "error", where: "audio", error: String(e?.message || e) }); }
    return;
  }
  if (m.type === "frame") {
    const t0 = performance.now();
    let res = {}, error = null;
    try { res = detect(tasks, m.bitmap, m.ts, m.want, m.bitmap.width, m.bitmap.height); }
    catch (e) { error = String(e?.message || e); }
    finally { m.bitmap.close?.(); }
    self.postMessage({ type: "result", id: m.id, res, error, ms: performance.now() - t0 });
    return;
  }
  if (m.type === "embed-text") {                        // loaded the first time it's needed
    let vecs = null, error = null;
    try { if (!text && !textFailed) text = await makeTextTask(true); if (text) vecs = embedTexts(text, m.texts); }
    catch (e) { textFailed = true; error = String(e?.message || e); }
    self.postMessage({ type: "text", id: m.id, vecs, error });
    return;
  }
  if (m.type === "audio") {
    let cats = null; try { if (audio) cats = classify(audio, m.data, m.rate); } catch {}
    self.postMessage({ type: "audio", id: m.id, cats });
  }
};
