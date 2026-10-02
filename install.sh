#!/data/data/com.termux/files/usr/bin/bash
# Darkly Robot installer for Termux. Safe to re-run (keeps her memory, body and settings).
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/robot"
BIN="$PREFIX/bin"

if [ "$1" != "--quick" ]; then
echo "== Installing packages (a few minutes on a fresh phone) =="
# Never stop to ask about config files, so it can't sit frozen on a hidden question.
export DEBIAN_FRONTEND=noninteractive
KEEP=(-y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
pkg update -y || true
pkg upgrade "${KEEP[@]}" || true
pkg install "${KEEP[@]}" nodejs-lts termux-api android-tools procps \
  || pkg install "${KEEP[@]}" nodejs termux-api android-tools procps
command -v llama-server >/dev/null 2>&1 || [ -x "$HOME/llama.cpp/build/bin/llama-server" ] \
  || pkg install "${KEEP[@]}" llama-cpp \
  || echo "(Couldn't install the offline brain program. Claude still works.)"
fi

# Offline text reader (so "read this" works with no internet). Installed on updates too, only if it's missing.
command -v tesseract >/dev/null 2>&1 || pkg install -y tesseract >/dev/null 2>&1 \
  || echo "(Couldn't install the offline text reader. Everything else still works; try later: pkg install tesseract)"

echo "== Copying robot to $DEST =="
mkdir -p "$DEST"
cp -r "$SRC/server.js" "$SRC/phone.js" "$SRC/package.json" "$SRC/public" "$SRC/firmware" "$SRC/README.md" "$SRC/CHANGELOG.md" "$DEST/"
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
ln -sf "$DEST/robot-update.sh" "$BIN/robot-update"
ln -sf "$DEST/robot-doctor.sh" "$BIN/robot-doctor"
ln -sf "$DEST/robot-vision-download.sh" "$BIN/robot-vision-download"
ln -sf "$DEST/robot-hearing-setup.sh" "$BIN/robot-hearing-setup"
ln -sf "$DEST/robot-tune.sh" "$BIN/robot-tune"

# Vision engine for face tracking and hand gestures (kept between updates; downloads only what's missing)
mkdir -p "$DEST/public/vendor"
bash "$DEST/robot-vision-download.sh" || echo "(Vision download failed; run robot-vision-download later.)"

# Offline hearing (whisper.cpp): so she understands speech with no internet. Skips itself if already installed.
bash "$DEST/robot-hearing-setup.sh" || echo "(Offline hearing isn't installed yet; run robot-hearing-setup later.)"

# Start automatically when the phone boots (needs the Termux:Boot app)
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/start-robot" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
sleep 8
/data/data/com.termux/files/usr/bin/robot
EOF
chmod +x "$HOME/.termux/boot/start-robot"

if [ ! -s "$HOME/.robot-key" ]; then
  echo
  echo "Paste your Claude API key (starts with sk-ant-), then press Enter."
  echo "Leave it blank to skip; she'll run on her offline brain until you add one."
  read -r KEY || true
  if [ -n "$KEY" ]; then
    printf '%s\n' "$KEY" > "$HOME/.robot-key"; chmod 600 "$HOME/.robot-key"; echo "Key saved."
    echo "Backup key (used when the first runs out of credit). Paste one, or just press Enter to skip:"
    read -r KEY2 || true
    if [ -n "$KEY2" ]; then printf '%s\n' "$KEY2" >> "$HOME/.robot-key"; echo "Backup saved."; fi
  fi
fi

if [ ! -s "$HOME/.robot-gemini-key" ]; then
  echo
  echo "Optional: paste a Gemini API key (starts with AIza) to use Gemini first, or press Enter to skip:"
  read -r GKEY || true
  if [ -n "$GKEY" ]; then printf '%s\n' "$GKEY" > "$HOME/.robot-gemini-key"; chmod 600 "$HOME/.robot-gemini-key"; echo "Gemini key saved."; fi
fi

echo
echo "Done. Commands:"
echo "  robot             start her (brain + face)"
echo "  robot-stop        shut her down"
echo "  robot-update      get the newest version from GitHub and restart her"
echo "  robot-doctor      check everything and say what's wrong (including: can she work with no internet?)"
echo "  robot-hearing-setup  install offline hearing (once, needs internet)"
echo "  robot-tune        find the fastest setting for the offline brain on this phone (once, about 3 minutes)"
echo "  robot-dedicate    give the whole phone to the robot (turns off other apps)"
echo "  robot-undedicate  undo that"
echo
echo "Put offline brain models (.gguf) in ~/models. She picks the biggest one that fits in free RAM."
