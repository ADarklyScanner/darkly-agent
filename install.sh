#!/data/data/com.termux/files/usr/bin/bash
# Darkly Robot installer for Termux. Safe to re-run (keeps her memory, body and settings).
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/robot"
BIN="$PREFIX/bin"

echo "== Installing packages =="
pkg update -y >/dev/null 2>&1 || true
pkg install -y nodejs-lts termux-api android-tools >/dev/null 2>&1 || pkg install -y nodejs termux-api android-tools
command -v llama-server >/dev/null 2>&1 || [ -x "$HOME/llama.cpp/build/bin/llama-server" ] || pkg install -y llama-cpp || true

echo "== Copying robot to $DEST =="
mkdir -p "$DEST"
cp -r "$SRC/server.js" "$SRC/package.json" "$SRC/public" "$SRC/firmware" "$SRC/README.md" "$DEST/"
mkdir -p "$DEST/data/logs" "$HOME/models"
for f in config.json body.json persona.md memory.md; do
  [ -f "$DEST/data/$f" ] || cp "$SRC/data/$f" "$DEST/data/$f"     # never overwrite her existing files
done
cp "$SRC/scripts/"*.sh "$DEST/"
chmod +x "$DEST/"*.sh

ln -sf "$DEST/robot.sh" "$BIN/robot"
ln -sf "$DEST/robot-stop.sh" "$BIN/robot-stop"
ln -sf "$DEST/robot-dedicate.sh" "$BIN/robot-dedicate"
ln -sf "$DEST/robot-undedicate.sh" "$BIN/robot-undedicate"

# Start automatically when the phone boots (needs the Termux:Boot app)
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/start-robot" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
sleep 8
robot
EOF
chmod +x "$HOME/.termux/boot/start-robot"

if [ ! -s "$HOME/.robot-key" ]; then
  echo
  echo "Paste your Claude API key (starts with sk-ant-), then press Enter."
  echo "Leave it blank to skip; she'll run on her offline brain until you add one."
  read -r KEY || true
  if [ -n "$KEY" ]; then printf '%s' "$KEY" > "$HOME/.robot-key"; chmod 600 "$HOME/.robot-key"; echo "Key saved."; fi
fi

echo
echo "Done. Commands:"
echo "  robot             start her (brain + face)"
echo "  robot-stop        shut her down"
echo "  robot-dedicate    give the whole phone to the robot (turns off other apps)"
echo "  robot-undedicate  undo that"
echo
echo "Put offline brain models (.gguf) in ~/models. She picks the biggest one that fits in free RAM."
