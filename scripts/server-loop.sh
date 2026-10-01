#!/data/data/com.termux/files/usr/bin/bash
# Keeps her brain server alive: if it ever crashes, it starts again 2 seconds later.
DIR="$HOME/robot"
while true; do
  node "$DIR/server.js"
  echo "$(date) server stopped (code $?), restarting" >> "$DIR/data/logs/server.log"
  [ -f "$DIR/data/.stopping" ] && break
  sleep 2
done
