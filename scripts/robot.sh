#!/data/data/com.termux/files/usr/bin/bash
# Start the robot: offline brain (biggest model that fits in RAM) + server + face.
DIR="$HOME/robot"
LOGS="$DIR/data/logs"
mkdir -p "$LOGS"
termux-wake-lock 2>/dev/null || true

# ---------- offline brain + offline hearing (see brain.sh; the server also restarts them if they stop) ----------
rm -f "$DIR/data/.stopping"
bash "$DIR/brain.sh"

# ---------- phone controls: reconnect quietly in the background (see phone.js) ----------
( adb connect 127.0.0.1:5555 >/dev/null 2>&1 || { settings put global adb_wifi_enabled 1 >/dev/null 2>&1; sleep 5;
    P=$(adb mdns services 2>/dev/null | grep -o '[0-9.]*:[0-9]*' | head -1); [ -n "$P" ] && adb connect "$P" >/dev/null 2>&1 \
    && adb -s "$P" tcpip 5555 >/dev/null 2>&1 && sleep 2 && adb connect 127.0.0.1:5555 >/dev/null 2>&1; } ) &

# ---------- server + face ----------
rm -f "$DIR/data/.stopping"
if pgrep -f "node $DIR/server.js" >/dev/null; then
  echo "Brain server already running."
else
  # runs inside a loop that restarts it if it ever crashes
  nohup bash "$DIR/server-loop.sh" >> "$LOGS/server.log" 2>&1 &
  sleep 2
fi
# Open the face in Chrome specifically. A fresh Galaxy defaults to Samsung Internet,
# which doesn't have the speech and Bluetooth features she needs.
am start -n com.android.chrome/com.google.android.apps.chrome.Main -a android.intent.action.VIEW -d "http://127.0.0.1:3000" >/dev/null 2>&1 \
  || termux-open-url "http://127.0.0.1:3000" 2>/dev/null \
  || am start -a android.intent.action.VIEW -d "http://127.0.0.1:3000" >/dev/null 2>&1
echo "She's up. Face: http://127.0.0.1:3000"
