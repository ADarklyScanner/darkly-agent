# Shared by robot-tune and robot-brain-build: time one way of running the offline brain.
#   time_brain PROGRAM MODEL THREADS [BATCH_THREADS] [extra llama-server options...]
# Prints "READ WRITE" in tokens a second ("0 0" if that run didn't work). Uses port 8089 so it never touches her live brain.
TIME_PORT=8089
TIME_CHILD=""
time_brain() {
  local prog="$1" model="$2" t="$3" tb="$4"; shift 4 2>/dev/null || shift $#
  local logf="$HOME/robot/data/logs/tune.log" opts=(-m "$model" --host 127.0.0.1 --port $TIME_PORT -t "$t" -c 2048 --parallel 1 "$@")
  [ -n "$tb" ] && [ "$tb" != "$t" ] && opts+=(--threads-batch "$tb")
  "$prog" --help 2>&1 | grep -q -- "--poll <" && opts+=(--poll 0)
  "$prog" "${opts[@]}" > "$logf" 2>&1 &
  TIME_CHILD=$!
  local up=0 i
  for i in $(seq 1 120); do
    kill -0 "$TIME_CHILD" 2>/dev/null || break
    [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:$TIME_PORT/health 2>/dev/null)" = 200 ] && { up=1; break; }
    sleep 1
  done
  local out="" rw="0 0"
  if [ "$up" = 1 ]; then
    local text="The quick brown robot rolls across the kitchen floor, looks at the cat, and wonders what to say next. "
    text="$text$text$text$text$text$text"
    out=$(curl -s -m 300 http://127.0.0.1:$TIME_PORT/v1/chat/completions -H 'content-type: application/json' \
      -d "{\"messages\":[{\"role\":\"user\",\"content\":\"Note $RANDOM$RANDOM. $text Count from one to twenty in words.\"}],\"max_tokens\":24,\"temperature\":0.5}")
    rw=$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t=JSON.parse(s).timings;console.log(t.prompt_per_second.toFixed(1)+" "+t.predicted_per_second.toFixed(1))}catch{console.log("0 0")}})' 2>/dev/null)
    [ -n "$rw" ] || rw="0 0"
  fi
  kill "$TIME_CHILD" 2>/dev/null; wait "$TIME_CHILD" 2>/dev/null; TIME_CHILD=""
  echo "$rw"
}
# faster A B: is number A more than 5% bigger than B?
faster() { node -e "process.exit(+process.argv[1] > +process.argv[2] * 1.05 ? 0 : 1)" "$1" "$2"; }
# Seconds for a typical turn (read 100 tokens, write 40) at "READ WRITE" speeds; 99999 if the run failed.
turn_secs() { node -e "const r=+process.argv[1],w=+process.argv[2];console.log(r>0&&w>0?(100/r+40/w).toFixed(1):99999)" "$1" "$2"; }
# The offline brain program in use: the one robot-brain-build chose, else the installed one.
brain_program() {
  local p; p="$(cat "$HOME/robot/data/.brain-program" 2>/dev/null)"
  [ -n "$p" ] && [ -x "$p" ] && { echo "$p"; return; }
  p="$(command -v llama-server || true)"
  [ -z "$p" ] && [ -x "$HOME/llama.cpp/build/bin/llama-server" ] && p="$HOME/llama.cpp/build/bin/llama-server"
  echo "$p"
}
# Pause her live brain (her server won't restart it while data/.tuning exists) / bring it back.
pause_brain() {
  local D="$HOME/robot/data" f P
  touch "$D/.tuning"
  pkill -f "robot/brain-loop.sh" 2>/dev/null
  for f in "$D/.brain-loop-pid" "$D/.brain-pid"; do P="$(cat "$f" 2>/dev/null)"; [ -n "$P" ] && kill "$P" 2>/dev/null; rm -f "$f"; done
  pkill -f "llama-server .*--port 8080" 2>/dev/null
  sleep 2
}
resume_brain() {
  [ -n "$TIME_CHILD" ] && kill "$TIME_CHILD" 2>/dev/null
  pkill -f "llama-server .*--port $TIME_PORT" 2>/dev/null
  rm -f "$HOME/robot/data/.tuning"
  bash "$HOME/robot/brain.sh" >/dev/null 2>&1
}
