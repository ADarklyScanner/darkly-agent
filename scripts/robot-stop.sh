#!/data/data/com.termux/files/usr/bin/bash
touch "$HOME/robot/data/.stopping"          # tells the restart loops not to bring her back
pkill -f "robot/server-loop.sh"
pkill -f "node $HOME/robot/server.js" && echo "Server stopped."
pkill -f "robot/brain-loop.sh"
pkill -x llama-server && echo "Offline brain stopped."
pkill -x whisper-server && echo "Offline hearing stopped."
sleep 1
termux-wake-unlock 2>/dev/null || true
