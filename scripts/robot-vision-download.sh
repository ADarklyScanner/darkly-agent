#!/data/data/com.termux/files/usr/bin/bash
# Downloads Google's open-source MediaPipe vision engine (Apache 2.0) and two models, once.
# After this, face tracking, expressions and hand gestures run on the phone with no internet.
V="1.0.1"
DEST="$HOME/robot/public/vendor/mediapipe"
mkdir -p "$DEST/wasm"
get() { [ -s "$2" ] && return 0; echo "  downloading $(basename "$2")..."; curl -fsSL --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2"; }
CDN="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@$V"
echo "== Vision engine (about 55 MB, one time) =="
get "$CDN/vision_bundle.mjs" "$DEST/vision_bundle.mjs" || exit 1
for f in vision_wasm_internal vision_wasm_nosimd_internal vision_wasm_module_internal; do
  get "$CDN/wasm/$f.js" "$DEST/wasm/$f.js"; get "$CDN/wasm/$f.wasm" "$DEST/wasm/$f.wasm"
done
M="https://storage.googleapis.com/mediapipe-models"
get "$M/face_landmarker/face_landmarker/float16/latest/face_landmarker.task" "$DEST/face_landmarker.task"
get "$M/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task" "$DEST/gesture_recognizer.task"
get "$M/object_detector/efficientdet_lite0/float16/latest/efficientdet_lite0.tflite" "$DEST/efficientdet_lite0.tflite"
get "$M/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task" "$DEST/pose_landmarker_lite.task"
get "$M/image_embedder/mobilenet_v3_small/float32/latest/mobilenet_v3_small.tflite" "$DEST/mobilenet_v3_small.tflite" \
  || get "$M/image_embedder/mobilenet_v3_small/float32/1/mobilenet_v3_small.tflite" "$DEST/mobilenet_v3_small.tflite"

echo "== Hearing engine (sounds like knocks, dogs, alarms, music; about 20 MB) =="
A="$HOME/robot/public/vendor/mediapipe-audio"; mkdir -p "$A/wasm"
ACDN="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@$V"
get "$ACDN/audio_bundle.mjs" "$A/audio_bundle.mjs"
for f in audio_wasm_internal audio_wasm_nosimd_internal audio_wasm_module_internal; do
  get "$ACDN/wasm/$f.js" "$A/wasm/$f.js"; get "$ACDN/wasm/$f.wasm" "$A/wasm/$f.wasm"
done
get "$M/audio_classifier/yamnet/float32/latest/yamnet.tflite" "$A/yamnet.tflite"
echo "== Memory by meaning (finds notes that mean the same thing in different words; about 10 MB) =="
T="$HOME/robot/public/vendor/mediapipe-text"; mkdir -p "$T/wasm"
TCDN="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-text@$V"
get "$TCDN/text_bundle.mjs" "$T/text_bundle.mjs"
for f in text_wasm_internal text_wasm_nosimd_internal text_wasm_module_internal; do
  get "$TCDN/wasm/$f.js" "$T/wasm/$f.js"; get "$TCDN/wasm/$f.wasm" "$T/wasm/$f.wasm"
done
get "$M/text_embedder/universal_sentence_encoder/float32/latest/universal_sentence_encoder.tflite" "$T/universal_sentence_encoder.tflite" \
  || get "$M/text_embedder/universal_sentence_encoder/float32/1/universal_sentence_encoder.tflite" "$T/universal_sentence_encoder.tflite"
ls "$DEST/vision_bundle.mjs" "$DEST/face_landmarker.task" "$DEST/gesture_recognizer.task" >/dev/null 2>&1 \
  && echo "Vision ready. Reload her face (or run robot-stop; robot)." \
  || echo "Some vision files didn't download. Run robot-vision-download again when the internet is on."
