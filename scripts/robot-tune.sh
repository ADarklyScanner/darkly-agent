#!/data/data/com.termux/files/usr/bin/bash
# Finds how many processor threads make THIS phone's offline brain fastest, and saves the answer.
# Phones have a mix of fast and slow cores, so the best number can't be guessed; this tries several and times each.
# Takes about three minutes. Her offline brain is paused while it runs and comes back by itself.
#   robot-tune          test now (best done with her page on the screen: that's how she's really used)
#   robot-tune --here   don't wait for you to switch to her page
DIR="$HOME/robot"; D="$DIR/data"; PORT=8089
LLAMA="$(command -v llama-server || true)"
[ -z "$LLAMA" ] && [ -x "$HOME/llama.cpp/build/bin/llama-server" ] && LLAMA="$HOME/llama.cpp/build/bin/llama-server"
[ -z "$LLAMA" ] && { echo "No offline brain program found (pkg install llama-cpp)."; exit 1; }
MODEL="$(cat "$D/.brain-model" 2>/dev/null)"
[ -f "$MODEL" ] || MODEL="$(find "$HOME/models" -maxdepth 2 -name '*.gguf' -size +50M 2>/dev/null | grep -v -i 'mmproj\|lora\|adapter' | head -1)"
[ -f "$MODEL" ] || { echo "No offline brain model found in ~/models."; exit 1; }
CORES=$(nproc 2>/dev/null || echo 8)
LIST=""; for t in 4 2 3 5 6 8; do [ "$t" -le "$CORES" ] && LIST="$LIST $t"; done
echo "== Tuning the offline brain: $(basename "$MODEL"), $CORES cores =="
if [ "$1" != "--here" ]; then
  echo "Switch to her page now and leave it on the screen. The test starts in 12 seconds and takes about 3 minutes."
  echo "She'll say when it's done; then come back here for the result."
  sleep 12
fi

touch "$D/.tuning"                                   # tells her server not to restart the brain meanwhile
CHILD=""
finish() {
  [ -n "$CHILD" ] && kill "$CHILD" 2>/dev/null
  rm -f "$D/.tuning"
  bash "$DIR/brain.sh" >/dev/null 2>&1
}
trap 'finish; exit 1' INT TERM
# stop the running brain so it doesn't compete
pkill -f "robot/brain-loop.sh" 2>/dev/null
for f in "$D/.brain-loop-pid" "$D/.brain-pid"; do P="$(cat "$f" 2>/dev/null)"; [ -n "$P" ] && kill "$P" 2>/dev/null; rm -f "$f"; done
pkill -f "llama-server .*--port 8080" 2>/dev/null
sleep 2

TEXT="The quick brown robot rolls across the kitchen floor, looks at the cat, and wonders what to say next. "
TEXT="$TEXT$TEXT$TEXT$TEXT$TEXT$TEXT"
BEST_T=4; BEST_TB=4; BEST_R=0; BEST_W=0; BASE_R=0; BASE_W=0
RESULTS=""
for T in $LIST; do
  "$LLAMA" -m "$MODEL" --host 127.0.0.1 --port $PORT -t "$T" -c 2048 --parallel 1 > "$D/logs/tune.log" 2>&1 &
  CHILD=$!
  UP=0
  for i in $(seq 1 90); do
    kill -0 "$CHILD" 2>/dev/null || break
    [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/health 2>/dev/null)" = 200 ] && { UP=1; break; }
    sleep 1
  done
  if [ "$UP" != 1 ]; then echo "  $T threads: the brain didn't start (see ~/robot/data/logs/tune.log)"; kill "$CHILD" 2>/dev/null; wait "$CHILD" 2>/dev/null; CHILD=""; continue; fi
  OUT=$(curl -s -m 240 http://127.0.0.1:$PORT/v1/chat/completions -H 'content-type: application/json' \
    -d "{\"messages\":[{\"role\":\"user\",\"content\":\"Note $RANDOM$RANDOM. $TEXT Count from one to twenty in words.\"}],\"max_tokens\":24,\"temperature\":0.5}")
  kill "$CHILD" 2>/dev/null; wait "$CHILD" 2>/dev/null; CHILD=""
  RW=$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t=JSON.parse(s).timings;console.log(t.prompt_per_second.toFixed(1)+" "+t.predicted_per_second.toFixed(1))}catch{console.log("0 0")}})' 2>/dev/null)
  R=${RW% *}; W=${RW#* }
  echo "  $T threads: reads $R, writes $W tokens a second"
  RESULTS="$RESULTS $T:$R/$W"
  [ "$T" = 4 ] && { BASE_R=$R; BASE_W=$W; }
  # reading and writing can each have their own best number
  if node -e "process.exit(+process.argv[1] > +process.argv[2] * 1.05 ? 0 : 1)" "$R" "$BEST_R"; then BEST_R=$R; BEST_TB=$T; fi
  if node -e "process.exit(+process.argv[1] > +process.argv[2] * 1.05 ? 0 : 1)" "$W" "$BEST_W"; then BEST_W=$W; BEST_T=$T; fi
  sleep 3                                            # a breather, so heat from one run doesn't hurt the next
done

if [ "$BEST_R" = 0 ]; then
  echo "No test finished, so nothing was changed."
else
  echo "$BEST_T $BEST_TB $(basename "$MODEL")" > "$D/.brain-threads"
  rm -f "$D/.brain-speed.json"                       # measured again with the new setting
  echo "Fastest: $BEST_TB threads for reading ($BEST_R a second), $BEST_T for writing ($BEST_W a second)."
  echo "Before (4 threads): reads $BASE_R, writes $BASE_W. Saved; her brain is restarting with it."
  echo "{\"t\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"kind\":\"brain\",\"detail\":\"tuned: $BEST_TB threads to read ($BEST_R/s), $BEST_T to write ($BEST_W/s); tried$RESULTS\"}" >> "$D/logs/robot-log.jsonl"
fi
finish
[ "$1" != "--here" ] && curl -s -m 20 -o /dev/null http://127.0.0.1:3000/api/say -H 'content-type: application/json' -d '{"text":"Brain tuning is done."}' 2>/dev/null
exit 0
