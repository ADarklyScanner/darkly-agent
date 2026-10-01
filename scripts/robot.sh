#!/data/data/com.termux/files/usr/bin/bash
# Start the robot: offline brain (biggest model that fits in RAM) + server + face.
DIR="$HOME/robot"
LOGS="$DIR/data/logs"
mkdir -p "$LOGS"
termux-wake-lock 2>/dev/null || true

# ---------- offline brain ----------
LLAMA="$(command -v llama-server || true)"
[ -z "$LLAMA" ] && [ -x "$HOME/llama.cpp/build/bin/llama-server" ] && LLAMA="$HOME/llama.cpp/build/bin/llama-server"

# A model named in data/config.json ("localModel") wins; otherwise pick the biggest .gguf that fits.
MODEL="$(grep -o '"localModel"[^,}]*' "$DIR/data/config.json" 2>/dev/null | sed 's/.*: *"\(.*\)"/\1/')"
MODEL="${MODEL/#\~/$HOME}"
if [ -z "$MODEL" ] || [ ! -f "$MODEL" ]; then
  FREE_KB=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
  BUDGET=$(( FREE_KB * 1024 - 1400*1024*1024 ))     # keep ~1.4 GB for the face, voice and Android
  MODEL=""; BEST=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in *mmproj*|*lora*|*LoRA*|*adapter*) continue;; esac
    S=$(stat -c %s "$f")
    if [ "$S" -le "$BUDGET" ] && [ "$S" -gt "$BEST" ]; then BEST=$S; MODEL="$f"; fi
  done < <(find "$HOME/models" "$HOME/llama.cpp/models" "$HOME/storage/shared/Download" -maxdepth 2 -name '*.gguf' 2>/dev/null)
fi

# A brain file sitting in Download loads and runs slowly (Android's shared storage is slow).
# Move it into Termux's own storage once.
case "$MODEL" in
  "$HOME"/storage/*|/storage/*|/sdcard/*)
    echo "Moving $(basename "$MODEL") into Termux so it runs fast (one time, about a minute)..."
    mkdir -p "$HOME/models"
    if mv "$MODEL" "$HOME/models/"; then MODEL="$HOME/models/$(basename "$MODEL")"; fi ;;
esac

if pgrep -x llama-server >/dev/null; then
  echo "Offline brain already running."
elif [ -n "$LLAMA" ] && [ -n "$MODEL" ]; then
  # Personality adapter (LoRA) named in data/config.json as "localLora". Only works with the base model it was trained on.
  LORA="$(grep -o '"localLora"[^,}]*' "$DIR/data/config.json" 2>/dev/null | sed 's/.*: *"\(.*\)"/\1/')"
  LORA="${LORA/#\~/$HOME}"
  EXTRA=()
  if [ -n "$LORA" ] && [ -f "$LORA" ]; then EXTRA=(--lora "$LORA"); echo "Personality: $(basename "$LORA")"; fi
  echo "Offline brain: $(basename "$MODEL")"
  # S22: 4 fast cores. Whole context kept in RAM.
  nohup "$LLAMA" -m "$MODEL" "${EXTRA[@]}" --host 127.0.0.1 --port 8080 -t 4 -c 4096 \
    > "$LOGS/llama.log" 2>&1 &
else
  echo "No offline brain (need llama-server and a .gguf in ~/models). Claude-only for now."
fi

# ---------- server + face ----------
if pgrep -f "node $DIR/server.js" >/dev/null; then
  echo "Brain server already running."
else
  nohup node "$DIR/server.js" > "$LOGS/server.log" 2>&1 &
  sleep 2
fi
# Open the face in Chrome specifically. A fresh Galaxy defaults to Samsung Internet,
# which doesn't have the speech and Bluetooth features she needs.
am start -n com.android.chrome/com.google.android.apps.chrome.Main -a android.intent.action.VIEW -d "http://127.0.0.1:3000" >/dev/null 2>&1 \
  || termux-open-url "http://127.0.0.1:3000" 2>/dev/null \
  || am start -a android.intent.action.VIEW -d "http://127.0.0.1:3000" >/dev/null 2>&1
echo "She's up. Face: http://127.0.0.1:3000"
