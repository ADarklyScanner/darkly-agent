#!/data/data/com.termux/files/usr/bin/bash
# Starts her offline brain and her offline hearing, if they aren't already running.
# Safe to run any time. The server runs this by itself when it finds the brain down.
DIR="$HOME/robot"
LOGS="$DIR/data/logs"
mkdir -p "$LOGS" "$HOME/models"
[ -f "$DIR/data/.stopping" ] && [ "$1" != "--force" ] && exit 0
# robot-tune is timing the brain right now and will start it again itself (a leftover marker older than 15 minutes is ignored)
[ -n "$(find "$DIR/data/.tuning" -mmin -15 2>/dev/null)" ] && exit 0

# ---------- offline brain (llama.cpp) ----------
# alive FILE WORD: is the process whose number is saved in FILE still running, and is it really ours (WORD in its command line)?
alive() { local p; p="$(cat "$1" 2>/dev/null)"; [ -n "$p" ] && [ -r "/proc/$p/cmdline" ] && tr '\0' ' ' < "/proc/$p/cmdline" | grep -q "$2"; }
answers() { [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$1/health" 2>/dev/null)" != 000 ]; }
if answers 8080 || alive "$DIR/data/.brain-pid" llama; then
  echo "Offline brain already running."
elif alive "$DIR/data/.brain-loop-pid" brain-loop || pgrep -f "robot/brain-loop.sh" >/dev/null; then
  echo "Offline brain is starting."
else
  nohup bash "$DIR/brain-loop.sh" >> "$LOGS/llama.log" 2>&1 &
  echo "Offline brain starting (loading the model takes a little while)."
fi

# ---------- offline hearing (whisper.cpp) ----------
WSRV="$(command -v whisper-server || true)"
[ -z "$WSRV" ] && [ -x "$HOME/whisper.cpp/build/bin/whisper-server" ] && WSRV="$HOME/whisper.cpp/build/bin/whisper-server"
WMODEL="$(grep -o '"whisperModel"[^,}]*' "$DIR/data/config.json" 2>/dev/null | sed 's/.*: *"\(.*\)"/\1/')"
WMODEL="${WMODEL/#\~/$HOME}"
[ -f "$WMODEL" ] || WMODEL="$(ls -S "$HOME"/models/ggml-*.bin 2>/dev/null | head -1)"
if answers 8081 || pgrep -f "whisper-server .*--port 8081" >/dev/null; then
  echo "Offline hearing already running."
elif [ -n "$WSRV" ] && [ -f "$WMODEL" ]; then
  echo "Offline hearing: $(basename "$WMODEL")"
  # A small speech detector (Silero, comes with whisper.cpp) checks each clip first, so bangs, music and
  # background noise don't get "transcribed" into made-up words.
  VAD="$(ls "$HOME"/models/silero*.bin "$HOME"/whisper.cpp/models/*silero*ggml*.bin 2>/dev/null | head -1)"
  VADARGS=(); [ -f "$VAD" ] && "$WSRV" --help 2>&1 | grep -q -- "--vad " && VADARGS=(--vad -vm "$VAD" -sns)
  nohup bash -c 'for i in 1 2 3 4 5 6 7 8; do "$0" "$@"; [ -f "'"$DIR"'/data/.stopping" ] && break; sleep 5; done' \
    "$WSRV" -m "$WMODEL" --host 127.0.0.1 --port 8081 -t 4 -l en -nt "${VADARGS[@]}" > "$LOGS/whisper.log" 2>&1 &
else
  echo "No offline hearing yet (run: robot-hearing-setup). Without internet she can only be typed to."
fi
