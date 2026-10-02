#!/data/data/com.termux/files/usr/bin/bash
# Finds how many processor threads make THIS phone's offline brain fastest, and saves the answer.
# Phones have a mix of fast and slow cores, so the best number can't be guessed; this tries several and times each.
# Takes about three minutes. Her offline brain is paused while it runs and comes back by itself.
#   robot-tune          test now (best done with her page on the screen: that's how she's really used)
#   robot-tune --here   don't wait for you to switch to her page
DIR="$HOME/robot"; D="$DIR/data"
. "$DIR/brain-time.sh"
LLAMA="$(brain_program)"
[ -z "$LLAMA" ] && { echo "No offline brain program found (pkg install llama-cpp)."; exit 1; }
MODEL="$(cat "$D/.brain-model" 2>/dev/null)"
[ -f "$MODEL" ] || MODEL="$(find "$HOME/models" -maxdepth 2 -name '*.gguf' -size +50M 2>/dev/null | grep -v -i 'mmproj\|lora\|adapter' | head -1)"
[ -f "$MODEL" ] || { echo "No offline brain model found in ~/models."; exit 1; }
CORES=$(nproc --all 2>/dev/null || nproc 2>/dev/null || echo 8)
LIST=""; for t in 4 2 3 5 6 8; do [ "$t" -le "$CORES" ] && LIST="$LIST $t"; done
echo "== Tuning the offline brain: $(basename "$MODEL"), $CORES cores =="
if [ "$1" != "--here" ]; then
  echo "Switch to her page now and leave it on the screen. The test starts in 12 seconds and takes about 3 minutes."
  echo "She'll say when it's done; then come back here for the result."
  sleep 12
fi
trap 'resume_brain; exit 1' INT TERM
pause_brain

BEST_T=4; BEST_TB=4; BEST_R=0; BEST_W=0; BASE_R=0; BASE_W=0; RESULTS=""
for T in $LIST; do
  RW=$(time_brain "$LLAMA" "$MODEL" "$T" "")
  R=${RW% *}; W=${RW#* }
  if [ "$RW" = "0 0" ]; then echo "  $T threads: that run didn't finish (skipped)"; sleep 3; continue; fi
  echo "  $T threads: reads $R, writes $W tokens a second"
  RESULTS="$RESULTS $T:$R/$W"
  [ "$T" = 4 ] && { BASE_R=$R; BASE_W=$W; }
  # reading and writing can each have their own best number
  faster "$R" "$BEST_R" && { BEST_R=$R; BEST_TB=$T; }
  faster "$W" "$BEST_W" && { BEST_W=$W; BEST_T=$T; }
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
resume_brain
[ "$1" != "--here" ] && curl -s -m 20 -o /dev/null http://127.0.0.1:3000/api/say -H 'content-type: application/json' -d '{"text":"Brain tuning is done."}' 2>/dev/null
exit 0
