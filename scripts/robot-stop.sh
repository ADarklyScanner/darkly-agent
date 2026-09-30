#!/data/data/com.termux/files/usr/bin/bash
pkill -f "node.*robot/server.js" && echo "Server stopped."
pkill -f llama-server && echo "Offline brain stopped."
termux-wake-unlock 2>/dev/null || true
