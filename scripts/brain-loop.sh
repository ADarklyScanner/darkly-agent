#!/data/data/com.termux/files/usr/bin/bash
# Runs the offline brain and keeps it running.
# Picks the biggest model that fits in free RAM. If a model keeps dying right after it starts
# (usually Android killing it for using too much memory), it moves down to the next smaller one.
DIR="$HOME/robot"
LLAMA="$(command -v llama-server || true)"
[ -z "$LLAMA" ] && [ -x "$HOME/llama.cpp/build/bin/llama-server" ] && LLAMA="$HOME/llama.cpp/build/bin/llama-server"
[ -z "$LLAMA" ] && { echo "$(date) no llama-server program found (pkg install llama-cpp)"; exit 1; }

cfg() { grep -o "\"$1\"[^,}]*" "$DIR/data/config.json" 2>/dev/null | sed 's/.*: *"\(.*\)"/\1/'; }

# A brain file sitting in Download loads and runs slowly (Android's shared storage is slow). Move it in once.
for f in "$HOME"/storage/shared/Download/*.gguf; do
  [ -f "$f" ] || continue
  case "$f" in *mmproj*|*lora*|*LoRA*|*adapter*) continue;; esac
  echo "Moving $(basename "$f") into Termux so it runs fast (one time)..."
  mv "$f" "$HOME/models/" 2>/dev/null
done

# Candidates: the one named in config.json first, then every .gguf, biggest first.
candidates() {
  local named; named="$(cfg localModel)"; named="${named/#\~/$HOME}"
  [ -f "$named" ] && echo "$named"
  find "$HOME/models" "$HOME/llama.cpp/models" -maxdepth 2 -name '*.gguf' -size +50M 2>/dev/null \
    | grep -v -i 'mmproj\|lora\|adapter' | while read -r f; do echo "$(stat -c %s "$f") $f"; done | sort -rn | cut -d' ' -f2-
}

LORA="$(cfg localLora)"; LORA="${LORA/#\~/$HOME}"
TRIED=0
# Order to try them in: the ones that look like they fit (biggest first), then the rest (smallest first).
# "Free memory" on Android is an underestimate (it gives memory back from idle apps when asked), so nothing is
# ruled out: a model that really doesn't fit gets killed quickly and the loop moves on to the next one.
ordered() {
  local free_kb named; free_kb=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
  named="$(cfg localModel)"; named="${named/#\~/$HOME}"
  local fits=() rest=()
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ "$f" = "$named" ] || [ "$(stat -c %s "$f")" -le $(( free_kb * 1024 - 600*1024*1024 )) ]; then fits+=("$f"); else rest+=("$f"); fi
  done < <(candidates | awk '!seen[$0]++')
  printf '%s\n' "${fits[@]}"
  for (( i=${#rest[@]}-1; i>=0; i-- )); do printf '%s\n' "${rest[$i]}"; done
}
while IFS= read -r MODEL; do
  [ -n "$MODEL" ] || continue
  [ -f "$DIR/data/.stopping" ] && exit 0
  TRIED=$((TRIED+1))
  EXTRA=()
  # The personality adapter only works with the base model it was trained on: use it with the first (biggest) model only.
  if [ -n "$LORA" ] && [ -f "$LORA" ] && [ "$TRIED" = 1 ]; then EXTRA=(--lora "$LORA"); fi
  QUICK=0
  while true; do
    echo "$(date) starting offline brain: $(basename "$MODEL")"
    echo "$MODEL" > "$DIR/data/.brain-model"
    START=$(date +%s)
    "$LLAMA" -m "$MODEL" "${EXTRA[@]}" --host 127.0.0.1 --port 8080 -t 4 -c 4096
    CODE=$?
    [ -f "$DIR/data/.stopping" ] && exit 0
    RAN=$(( $(date +%s) - START ))
    echo "$(date) offline brain stopped after ${RAN}s (code $CODE)"
    if [ "$RAN" -lt 120 ]; then QUICK=$((QUICK+1)); else QUICK=0; fi
    if [ "$QUICK" -ge 2 ] && [ "${#EXTRA[@]}" -gt 0 ]; then
      echo "$(date) it won't start with the personality adapter (wrong base model?); trying without it"; EXTRA=(); QUICK=0; continue
    fi
    if [ "$QUICK" -ge 2 ]; then echo "$(date) $(basename "$MODEL") keeps dying right away; trying a smaller model"; break; fi
    sleep 5
  done
done < <(ordered)
echo "$(date) no offline brain model could run. Put a .gguf in ~/models (a 3B Q4 model fits on any phone)."
