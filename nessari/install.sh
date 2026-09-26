#!/data/data/com.termux/files/usr/bin/bash
# Nessari offline setup. Run with no argument for the fast 3B brain,
# or "big" to also get the smarter 8B brain and switch to it.
set -e
RAW="https://raw.githubusercontent.com/ADarklyScanner/darkly-agent/main/nessari"
SMALL_URL="https://huggingface.co/QuantFactory/Llama-3.2-3B-Instruct-abliterated-GGUF/resolve/main/Llama-3.2-3B-Instruct-abliterated.Q4_0.gguf"
SMALL="$HOME/models/Llama-3.2-3B-Instruct-abliterated.Q4_0.gguf"
BIG_URL="https://huggingface.co/QuantFactory/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-abliterated.Q4_0.gguf"
BIG="$HOME/models/Meta-Llama-3.1-8B-Instruct-abliterated.Q4_0.gguf"

mkdir -p "$HOME/chatbot" "$HOME/models"

get() { # url file label
  if [ -f "$2" ]; then echo "   already have $3"; return; fi
  echo "   downloading $3 (use Wi-Fi; if it stops, run the same line again to resume)..."
  curl -fL -C - "$1" -o "$2.part" && mv "$2.part" "$2"
}

echo "1/3 Updating Nessari's screen (old one backed up)..."
[ -f "$HOME/chatbot/index.html" ] && cp "$HOME/chatbot/index.html" "$HOME/chatbot/index.backup.html"
curl -fsSL "$RAW/index.html" -o "$HOME/chatbot/index.html.new" && mv "$HOME/chatbot/index.html.new" "$HOME/chatbot/index.html"

echo "2/3 Getting her brain..."
get "$SMALL_URL" "$SMALL" "fast brain (3B, about 1.9 GB)"
if [ "$1" = "big" ]; then
  get "$BIG_URL" "$BIG" "smart brain (8B, about 4.7 GB)"
  echo big > "$HOME/.nessari_brain"
fi

echo "3/3 Making the start command..."
cat > "$HOME/nessari.sh" <<'EOS'
#!/data/data/com.termux/files/usr/bin/bash
# nessari        -> start with the last brain you picked
# nessari big    -> switch to the smart 8B brain
# nessari small  -> switch to the fast 3B brain
SMALL="$HOME/models/Llama-3.2-3B-Instruct-abliterated.Q4_0.gguf"
BIG="$HOME/models/Meta-Llama-3.1-8B-Instruct-abliterated.Q4_0.gguf"
OLD="$HOME/models/Llama-3.2-3B-Instruct-Q4_0.gguf"
case "$1" in big|small) echo "$1" > "$HOME/.nessari_brain";; esac
CHOICE=$(cat "$HOME/.nessari_brain" 2>/dev/null || echo small)
if [ "$CHOICE" = big ] && [ -f "$BIG" ]; then M="$BIG"; NAME="smart 8B"
elif [ -f "$SMALL" ]; then M="$SMALL"; NAME="fast 3B"
else M="$OLD"; NAME="old 3B"; fi
[ "$CHOICE" = big ] && [ ! -f "$BIG" ] && echo "Smart brain isn't downloaded yet - using the fast one."
termux-wake-lock 2>/dev/null || true
pkill -x llama-server 2>/dev/null || true
sleep 1
echo "Nessari is starting with her $NAME brain. Open http://127.0.0.1:8080 in Chrome. Keep Termux open."
exec "$HOME/llama.cpp/build/bin/llama-server" -m "$M" --path "$HOME/chatbot" --host 127.0.0.1 --port 8080 -c 4096 -t 6
EOS
chmod +x "$HOME/nessari.sh"
grep -q "alias nessari=" "$HOME/.bashrc" 2>/dev/null || echo 'alias nessari="$HOME/nessari.sh"' >> "$HOME/.bashrc"

echo "Done. Starting Nessari..."
exec "$HOME/nessari.sh"
