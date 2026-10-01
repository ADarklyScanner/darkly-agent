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
if curl -s -m 3 http://127.0.0.1:3000/api/status >/tmp/robot-status 2>/dev/null; then
  ok "Brain server is running"
else
  bad "Brain server isn't running" "Type: robot"
fi

# --- offline brain ---
if pgrep -x llama-server >/dev/null; then
  if curl -s -m 3 http://127.0.0.1:8080/health | grep -q ok; then ok "Offline brain is running and ready"
  else warn "Offline brain is still loading (or stuck)" "Give it a minute. If it never gets ready: robot-stop; robot"; fi
else
  if command -v llama-server >/dev/null || [ -x "$HOME/llama.cpp/build/bin/llama-server" ]; then
    MODELS=$(find "$HOME/models" "$HOME/storage/shared/Download" -maxdepth 2 -name '*.gguf' 2>/dev/null | grep -vi lora | head -5)
    [ -z "$MODELS" ] && warn "No offline brain model found" "Put a .gguf file (like Llama-3.2-3B-Instruct-abliterated.Q4_0.gguf) in Download, then: robot-stop; robot" \
                     || bad "Offline brain isn't running" "robot-stop; robot   (if it keeps dying, the phone is short on memory: run robot-dedicate)"
  else warn "Offline brain program not installed" "pkg install llama-cpp"; fi
fi
FREE=$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo)
[ "$FREE" -gt 2500 ] && ok "Free memory: ${FREE} MB" || warn "Free memory is low: ${FREE} MB" "robot-dedicate turns off apps she doesn't need."

# --- Termux add-ons ---
if timeout 6 termux-battery-status >/dev/null 2>&1; then ok "Termux:API works (sensors, flashlight, vibration)"
else bad "Termux:API isn't answering" "Install Termux:API from F-Droid, open it once, and run: pkg install termux-api"; fi
[ -f "$HOME/.termux/boot/start-robot" ] && ok "Starts on boot (needs the Termux:Boot app opened once)" \
  || warn "Not set to start on boot" "Run robot-update to recreate it, and install Termux:Boot from F-Droid."
if [ -w "$HOME/storage/shared" ]; then ok "Can save photos and videos to the gallery"
else bad "No storage permission" "Run termux-setup-storage and tap Allow."; fi

V="$DIR/public/vendor/mediapipe"
if [ -s "$V/vision_bundle.mjs" ] && [ -s "$V/face_landmarker.task" ] && [ -s "$V/gesture_recognizer.task" ]; then ok "Vision engine installed (faces, expressions, hand gestures)"
else warn "Vision engine not downloaded" "With internet on: robot-vision-download"; fi

# --- keys ---
echo "-- Online brains --"
CLAUDE=$(grep -E '^sk-ant-' "$HOME/.robot-key" 2>/dev/null)
if [ -z "$CLAUDE" ]; then warn "No Claude key" "nano ~/.robot-key and paste it (starts with sk-ant-)"; fi
N=0; for K in $CLAUDE; do N=$((N+1))
  OUT=$(curl -s -m 20 https://api.anthropic.com/v1/messages -H "x-api-key: $K" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
    -d '{"model":"claude-haiku-4-5-20251001","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}')
  if echo "$OUT" | grep -q '"text"'; then ok "Claude key #$N $(mask "$K") works"
  elif echo "$OUT" | grep -qi 'credit'; then bad "Claude key #$N $(mask "$K"): no credit" "Use a key from the Console organization that has credit, or add credit."
  elif echo "$OUT" | grep -qi 'authentication\|invalid x-api-key'; then bad "Claude key #$N $(mask "$K"): invalid" "Make a new key in the Console and replace it in ~/.robot-key"
  elif [ -z "$OUT" ]; then warn "Claude key #$N: no answer" "Is the internet on?"
  else warn "Claude key #$N: $(echo "$OUT" | head -c 160)"; fi
done
GEM=$(grep -E '^[A-Za-z0-9_-]{30,}$' "$HOME/.robot-gemini-key" 2>/dev/null)
N=0; for K in $GEM; do N=$((N+1))
  CODE=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "https://generativelanguage.googleapis.com/v1beta/models?key=$K")
  case "$CODE" in
    200) ok "Gemini key #$N $(mask "$K") works";;
    400|401|403) bad "Gemini key #$N $(mask "$K") is invalid" "Make a new one at aistudio.google.com";;
    000) warn "Gemini key #$N: no answer" "Is the internet on?";;
    *) warn "Gemini key #$N: answered $CODE";;
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
