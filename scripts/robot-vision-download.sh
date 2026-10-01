#!/data/data/com.termux/files/usr/bin/bash
# Downloads Google's open-source MediaPipe vision engine (Apache 2.0) and two models, once.
# After this, face tracking, expressions and hand gestures run on the phone with no internet.
V="1.0.1"
DEST="$HOME/robot/public/vendor/mediapipe"
mkdir -p "$DEST/wasm"
get() { [ -s "$2" ] && return 0; echo "  downloading $(basename "$2")..."; curl -fsSL --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2"; }
CDN="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@$V"
echo "== Vision engine (about 40 MB, one time) =="
get "$CDN/vision_bundle.mjs" "$DEST/vision_bundle.mjs" || exit 1
for f in vision_wasm_internal vision_wasm_nosimd_internal vision_wasm_module_internal; do
  get "$CDN/wasm/$f.js" "$DEST/wasm/$f.js"; get "$CDN/wasm/$f.wasm" "$DEST/wasm/$f.wasm"
done
M="https://storage.googleapis.com/mediapipe-models"
get "$M/face_landmarker/face_landmarker/float16/latest/face_landmarker.task" "$DEST/face_landmarker.task"
get "$M/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task" "$DEST/gesture_recognizer.task"
ls "$DEST/vision_bundle.mjs" "$DEST/face_landmarker.task" "$DEST/gesture_recognizer.task" >/dev/null 2>&1 \
  && echo "Vision ready. Reload her face (or run robot-stop; robot)." \
  || echo "Some vision files didn't download. Run robot-vision-download again when the internet is on."
