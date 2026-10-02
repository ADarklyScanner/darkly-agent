#!/data/data/com.termux/files/usr/bin/bash
# robot-doctor: checks every part of Nessari and says in plain words what's wrong and how to fix it.
# Keys are never printed in full.
G="\e[32m"; R="\e[31m"; Y="\e[33m"; N="\e[0m"
ok()   { echo -e "${G}✔${N} $1"; }
bad()  { echo -e "${R}✘ $1${N}"; [ -n "$2" ] && echo -e "   → $2"; PROBLEMS=$((PROBLEMS+1)); }
warn() { echo -e "${Y}! $1${N}"; [ -n "$2" ] && echo -e "   → $2"; }
mask() { local k="$1"; echo "${k:0:14}…${k: -4}"; }
PROBLEMS=0
DIR="$HOME/robot"
echo "== Nessari check-up =="

# --- install ---
[ -d "$DIR" ] && ok "Installed in ~/robot" || bad "Not installed" "Run the install command again."
command -v node >/dev/null && ok "Node $(node -v)" || bad "Node is missing" "pkg install nodejs-lts"

# --- server ---
if curl -s -m 5 -o /dev/null http://127.0.0.1:3000/api/status 2>/dev/null; then
  ok "Brain server is running"
else
  bad "Brain server isn't running" "Type: robot"
fi

# --- can she work with NO internet? brain, ears, voice ---
echo "-- Without internet --"
OFFLINE_OK=1
if pgrep -x llama-server >/dev/null; then
  H=$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/health)
  if [ "$H" = 200 ]; then
    # a real question, straight to the offline brain and through her server (the same path she uses)
    T0=$(date +%s)
    OUT=$(curl -s -m 120 http://127.0.0.1:3000/api/local -H 'content-type: application/json' \
      -d '{"messages":[{"role":"system","content":"You are a robot. Answer in five words or fewer."},{"role":"user","content":"Say hello."}],"max_tokens":24}')
    T=$(( $(date +%s) - T0 ))
    if echo "$OUT" | grep -q '"text":"[^"]'; then ok "Offline brain answers (${T}s): $(echo "$OUT" | sed 's/.*"text":"\([^"]*\)".*/\1/' | cut -c1-60)"
    else OFFLINE_OK=0; bad "Offline brain is running but won't answer: $(echo "$OUT" | cut -c1-200)" "Send me that line. Meanwhile: robot-stop; robot"; fi
    [ -f "$DIR/data/.brain-model" ] && echo "   model: $(basename "$(cat "$DIR/data/.brain-model")")"
  else OFFLINE_OK=0; warn "Offline brain is still loading the model" "Give it a minute and run robot-doctor again. If it never gets ready: robot-stop; robot"; fi
else
  OFFLINE_OK=0
  if command -v llama-server >/dev/null || [ -x "$HOME/llama.cpp/build/bin/llama-server" ]; then
    MODELS=$(find "$HOME/models" "$HOME/storage/shared/Download" -maxdepth 2 -name '*.gguf' 2>/dev/null | grep -vi lora | head -5)
    [ -z "$MODELS" ] && bad "No offline brain model found" "Put a .gguf file (like Llama-3.2-3B-Instruct-abliterated.Q4_0.gguf) in Download, then: robot-stop; robot" \
                     || bad "Offline brain isn't running" "robot-stop; robot   (the reason is at the end of ~/robot/data/logs/llama.log; if it keeps dying, the phone is short on memory: run robot-dedicate)"
    [ -f "$DIR/data/logs/llama.log" ] && tail -3 "$DIR/data/logs/llama.log" | sed 's/^/     /' | cut -c1-200
  else bad "Offline brain program not installed" "pkg install llama-cpp"; fi
fi
if curl -s -m 3 -o /dev/null http://127.0.0.1:8081/health; then ok "Offline hearing is running (she understands speech with no internet)"
elif { command -v whisper-server >/dev/null || [ -x "$HOME/whisper.cpp/build/bin/whisper-server" ]; } && ls "$HOME"/models/ggml-*.bin >/dev/null 2>&1; then
  warn "Offline hearing is installed but not running" "robot-stop; robot"
else OFFLINE_OK=0; bad "No offline hearing: without internet she can't hear you (typing still works)" "With internet on, run once: robot-hearing-setup"; fi
if [ -n "$(timeout 20 termux-tts-engines 2>/dev/null | tr -d '[:space:][]')" ]; then ok "Phone's own voice is available (backup when Chrome's voice needs internet)"
else warn "Couldn't check the phone's own voice" "Needs Termux:API. Also: Settings > General management > Text-to-speech: make sure the voice data is downloaded."; fi
[ "$OFFLINE_OK" = 1 ] && echo -e "${G}   She can work with no internet.${N}" || echo -e "${R}   She can NOT fully work without internet yet (see ✘ above).${N}"
FREE=$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo)
[ "$FREE" -gt 2500 ] && ok "Free memory: ${FREE} MB" || warn "Free memory is low: ${FREE} MB" "robot-dedicate turns off apps she doesn't need."

# --- Termux add-ons ---
if timeout 6 termux-battery-status >/dev/null 2>&1; then ok "Termux:API works (sensors, flashlight, vibration)"
else bad "Termux:API isn't answering" "Install Termux:API from F-Droid, open it once, and run: pkg install termux-api"; fi
if command -v adb >/dev/null && adb devices 2>/dev/null | grep -q "device$"; then
  SRC_T=$(adb shell pm list packages -i com.termux 2>/dev/null | grep "package:com.termux " | sed 's/.*installer=//')
  SRC_A=$(adb shell pm list packages -i com.termux.api 2>/dev/null | grep "package:com.termux.api " | sed 's/.*installer=//')
  if [ -n "$SRC_T" ] && [ -n "$SRC_A" ] && [ "$SRC_T" != "$SRC_A" ]; then
    bad "Termux ($SRC_T) and Termux:API ($SRC_A) came from different stores" "That causes 'Error in termuxApiReceiver' popups. Uninstall Termux:API and reinstall it from the same place as Termux (F-Droid)."
  fi
fi
echo "   (If 'Error in termuxApiReceiver' pops up: Settings > Apps > Termux:API > Permissions: allow everything it asks for,"
echo "    Battery > Unrestricted, and 'Modify system settings' > Allow. Termux and Termux:API must both come from F-Droid.)"
[ -f "$HOME/.termux/boot/start-robot" ] && ok "Starts on boot (needs the Termux:Boot app opened once)" \
  || warn "Not set to start on boot" "Run robot-update to recreate it, and install Termux:Boot from F-Droid."
if [ -w "$HOME/storage/shared" ]; then ok "Can save photos and videos to the gallery"
else bad "No storage permission" "Run termux-setup-storage and tap Allow."; fi

V="$DIR/public/vendor/mediapipe"
if [ -s "$V/vision_bundle.mjs" ] && [ -s "$V/face_landmarker.task" ] && [ -s "$V/gesture_recognizer.task" ]; then ok "Vision engine installed (faces, expressions, hand gestures)"
else warn "Vision engine not downloaded" "With internet on: robot-vision-download"; fi

command -v tesseract >/dev/null && ok "Offline text reader installed (she can read labels and signs with no internet)" \
  || warn "Offline text reader not installed" "pkg install tesseract"
[ -s "$DIR/public/vendor/mediapipe-text/universal_sentence_encoder.tflite" ] && ok "Memory-by-meaning model installed" \
  || warn "Memory-by-meaning model not downloaded (she still finds memories by their words)" "With internet on: robot-vision-download"
if adb devices 2>/dev/null | grep -q "device$"; then ok "Phone controls connected (she can open apps and tap)"
elif adb mdns services 2>/dev/null | grep -q adb-tls-connect; then warn "Phone controls paired but not connected" "She connects by herself when needed; or run robot-dedicate"
else warn "Phone controls not set up (needed for 'use the phone' tasks)" "Turn on Wireless debugging and run robot-dedicate once to pair."; fi

# --- keys ---
echo "-- Online brains --"
CLAUDE=$(grep -E '^sk-ant-' "$HOME/.robot-key" 2>/dev/null)
if [ -z "$CLAUDE" ]; then warn "No Claude key" "nano ~/.robot-key and paste it (starts with sk-ant-)"; fi
KN=0; for K in $CLAUDE; do KN=$((KN+1))
  OUT=$(curl -s -m 20 https://api.anthropic.com/v1/messages -H "x-api-key: $K" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
    -d '{"model":"claude-haiku-4-5-20251001","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}')
  if echo "$OUT" | grep -q '"text"'; then ok "Claude key #$KN $(mask "$K") works"
  elif echo "$OUT" | grep -qi 'credit'; then bad "Claude key #$KN $(mask "$K"): no credit" "Use a key from the Console organization that has credit, or add credit."
  elif echo "$OUT" | grep -qi 'authentication\|invalid x-api-key'; then bad "Claude key #$KN $(mask "$K"): invalid" "Make a new key in the Console and replace it in ~/.robot-key"
  elif [ -z "$OUT" ]; then warn "Claude key #$KN: no answer" "Is the internet on?"
  else warn "Claude key #$KN: $(echo "$OUT" | head -c 160)"; fi
done
GEM=$(grep -E '^[A-Za-z0-9_-]{30,}$' "$HOME/.robot-gemini-key" 2>/dev/null)
KN=0; for K in $GEM; do KN=$((KN+1))
  CODE=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "https://generativelanguage.googleapis.com/v1beta/models?key=$K")
  case "$CODE" in
    200) ok "Gemini key #$KN $(mask "$K") works";;
    400|401|403) bad "Gemini key #$KN $(mask "$K") is invalid" "Make a new one at aistudio.google.com";;
    000) warn "Gemini key #$KN: no answer" "Is the internet on?";;
    *) warn "Gemini key #$KN: answered $CODE";;
  esac
done
[ -z "$GEM" ] && echo "  (no Gemini key; optional)"

# --- recent errors ---
LOG="$DIR/data/logs/robot-log.jsonl"
if [ -f "$LOG" ]; then
  ERRS=$(tail -300 "$LOG" | grep '"kind":"error"' | tail -3)
  [ -n "$ERRS" ] && { echo "-- Last errors she logged --"; echo "$ERRS" | sed 's/^/  /' | cut -c1-220; }
fi

echo
[ "$PROBLEMS" -eq 0 ] && echo -e "${G}All good.${N}" || echo -e "${R}$PROBLEMS problem(s) above.${N} Fix the first one first; the rest are often caused by it."
