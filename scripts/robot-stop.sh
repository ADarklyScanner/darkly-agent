#!/data/data/com.termux/files/usr/bin/bash
touch "$HOME/robot/data/.stopping"          # tells the restart loops not to bring her back
pkill -f "robot/server-loop.sh"
pkill -f "node $HOME/robot/server.js" && echo "Server stopped."
# By saved process number first, then by name: on some Termux versions the program's name isn't what you'd expect.
D="$HOME/robot/data"
pkill -f "robot/brain-loop.sh"
B=0
for f in "$D/.brain-loop-pid" "$D/.brain-pid"; do
  P="$(cat "$f" 2>/dev/null)"
  [ -n "$P" ] && tr '\0' ' ' < "/proc/$P/cmdline" 2>/dev/null | grep -q "brain-loop\|llama" && kill "$P" 2>/dev/null && B=1
  rm -f "$f"
done
pkill -f "llama-server .*--port 8080" && B=1
[ "$B" = 1 ] && echo "Offline brain stopped."
pkill -f "whisper-server .*--port 8081" && echo "Offline hearing stopped."
sleep 1
termux-wake-unlock 2>/dev/null || true
