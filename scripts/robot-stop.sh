#!/data/data/com.termux/files/usr/bin/bash
pkill -f "node $HOME/robot/server.js" && echo "Server stopped."
pkill -x llama-server && echo "Offline brain stopped."
sleep 1
termux-wake-unlock 2>/dev/null || true
