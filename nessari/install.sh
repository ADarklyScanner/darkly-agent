#!/data/data/com.termux/files/usr/bin/bash
# Nessari offline setup: new chat screen, no-restrictions brain, start script.
set -e
RAW="https://raw.githubusercontent.com/ADarklyScanner/darkly-agent/main/nessari"
MODEL_URL="https://huggingface.co/QuantFactory/Llama-3.2-3B-Instruct-abliterated-GGUF/resolve/main/Llama-3.2-3B-Instruct-abliterated.Q4_0.gguf"
MODEL="$HOME/models/Llama-3.2-3B-Instruct-abliterated.Q4_0.gguf"

mkdir -p "$HOME/chatbot" "$HOME/models"

echo "1/3 Updating Nessari's screen (old one backed up)..."
[ -f "$HOME/chatbot/index.html" ] && cp "$HOME/chatbot/index.html" "$HOME/chatbot/index.backup.html"
curl -fsSL "$RAW/index.html" -o "$HOME/chatbot/index.html.new" && mv "$HOME/chatbot/index.html.new" "$HOME/chatbot/index.html"

echo "2/3 Downloading her new brain (about 1.9 GB - use Wi-Fi, can resume if it stops)..."
curl -fL -C - "$MODEL_URL" -o "$MODEL.part" && mv "$MODEL.part" "$MODEL"

echo "3/3 Making the start command..."
cat > "$HOME/nessari.sh" <<'EOS'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock 2>/dev/null || true
pkill -f llama-server 2>/dev/null || true
M="$HOME/models/Llama-3.2-3B-Instruct-abliterated.Q4_0.gguf"
[ -f "$M" ] || M="$HOME/models/Llama-3.2-3B-Instruct-Q4_0.gguf"
echo "Nessari is starting. Open http://127.0.0.1:8080 in Chrome. Keep Termux open."
exec "$HOME/llama.cpp/build/bin/llama-server" -m "$M" --path "$HOME/chatbot" --host 127.0.0.1 --port 8080 -c 4096 -t 6
EOS
chmod +x "$HOME/nessari.sh"
grep -q "alias nessari=" "$HOME/.bashrc" 2>/dev/null || echo 'alias nessari="$HOME/nessari.sh"' >> "$HOME/.bashrc"

echo "Done. Starting Nessari..."
exec "$HOME/nessari.sh"
