// Shared by the perception worker (normal case) and the main page (fallback if workers fail).
// Builds the MediaPipe tasks and turns their results into plain data that can cross to the page.
export const BASE = new URL("./vendor/mediapipe/", import.meta.url).href;
export const ABASE = new URL("./vendor/mediapipe-audio/", import.meta.url).href;
export const TBASE = new URL("./vendor/mediapipe-text/", import.meta.url).href;

// Sentences as numbers, so memories can be found by meaning rather than exact words (MediaPipe Text Embedder).
export async function makeTextTask(useModule) {
  const tm = await import(TBASE + "text_bundle.mjs");
  const files = await tm.FilesetResolver.forTextTasks(TBASE + "wasm", useModule);
  return tm.TextEmbedder.createFromOptions(files, { baseOptions: { modelAssetPath: TBASE + "universal_sentence_encoder.tflite" } });
}
export function embedTexts(task, texts) {
  return texts.map(t => { const e = task.embed(String(t).slice(0, 300)).embeddings?.[0]; return Array.from(e?.floatEmbedding || e?.quantizedEmbedding || []); });
}

export async function makeVisionTasks(useModule) {
  const mp = await import(BASE + "vision_bundle.mjs");
  const files = await mp.FilesetResolver.forVisionTasks(BASE + "wasm", useModule);
  const make = async (Cls, model, opts) => {
    for (const delegate of ["GPU", "CPU"]) {
      try { return await Cls.createFromOptions(files, { baseOptions: { modelAssetPath: BASE + model, delegate }, runningMode: "VIDEO", ...opts }); }
      catch (e) { if (delegate === "CPU") throw e; }
    }
  };
  const t = {};
  t.face = await make(mp.FaceLandmarker, "face_landmarker.task", { numFaces: 4, outputFaceBlendshapes: true });
  t.hand = await make(mp.GestureRecognizer, "gesture_recognizer.task", { numHands: 2 }).catch(() => null);
  t.obj = await make(mp.ObjectDetector, "efficientdet_lite0.tflite", { scoreThreshold: 0.45, maxResults: 8 }).catch(() => null);
  t.pose = await make(mp.PoseLandmarker, "pose_landmarker_lite.task", { numPoses: 1 }).catch(() => null);
  try { t.embed = await mp.ImageEmbedder.createFromOptions(files, { baseOptions: { modelAssetPath: BASE + "mobilenet_v3_small.tflite" }, runningMode: "IMAGE", quantize: true }); } catch { t.embed = null; }
  return t;
}

export async function makeAudioTask(useModule) {
  const am = await import(ABASE + "audio_bundle.mjs");
  const files = await am.FilesetResolver.forAudioTasks(ABASE + "wasm", useModule);
  return am.AudioClassifier.createFromOptions(files, { baseOptions: { modelAssetPath: ABASE + "yamnet.tflite" }, maxResults: 4, scoreThreshold: 0.25 });
}

const pt = p => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility });
const cats = c => (c || []).map(k => ({ categoryName: k.categoryName, score: k.score }));

// Run whichever tasks were asked for on one frame. Everything returned is plain, clonable data.
// w,h = the frame size, so object boxes come back as 0..1 fractions whatever the frame size was.
export function detect(t, src, ts, want, w, h) {
  const out = {};
  if (want.face && t.face) {
    const r = t.face.detectForVideo(src, ts);
    out.face = { faceLandmarks: (r.faceLandmarks || []).map(lm => lm.map(pt)),
      faceBlendshapes: (r.faceBlendshapes || []).map(b => ({ categories: cats(b.categories) })) };
  }
  if (want.hand && t.hand) {
    const r = t.hand.recognizeForVideo ? t.hand.recognizeForVideo(src, ts + 1) : t.hand.detectForVideo(src, ts + 1);
    out.hand = { gestures: (r.gestures || []).map(cats), landmarks: (r.landmarks || []).map(l => l.map(pt)) };
  }
  if (want.pose && t.pose) {
    const r = t.pose.detectForVideo(src, ts + 2);
    out.pose = { landmarks: (r.landmarks || []).map(l => l.map(pt)) };
    try { r.close?.(); } catch {}
  }
  if (want.obj && t.obj) {
    const r = t.obj.detectForVideo(src, ts + 3);
    out.obj = { detections: (r.detections || []).map(d => ({ categories: cats(d.categories),
      box: { x: d.boundingBox.originX / w, y: d.boundingBox.originY / h, w: d.boundingBox.width / w, h: d.boundingBox.height / h } })) };
  }
  if (want.embed && t.embed) {
    const e = t.embed.embed(src).embeddings?.[0];
    if (e) out.embed = Array.from(e.floatEmbedding || e.quantizedEmbedding || []);
  }
  return out;
}

export function classify(task, data, rate) {
  const res = task.classify(data, rate);
  return cats(res?.[0]?.classifications?.[0]?.categories);
}
