#!/data/data/com.termux/files/usr/bin/bash
# Offline hearing: installs whisper.cpp (open source, MIT) and a small English model, once. Needs internet this one time.
# After this she understands speech with no internet at all.
set -o pipefail
BIN="$HOME/whisper.cpp/build/bin"
mkdir -p "$HOME/models"
if command -v whisper-server >/dev/null || [ -x "$BIN/whisper-server" ]; then
  echo "Hearing engine already installed."
else
  echo "== Building the hearing engine (about 5-10 minutes, one time) =="
  pkg install -y git cmake clang make >/dev/null 2>&1 || pkg install -y git cmake clang make
  if [ -d "$HOME/whisper.cpp/.git" ]; then git -C "$HOME/whisper.cpp" pull --depth 1 -q || true
  else rm -rf "$HOME/whisper.cpp"; git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$HOME/whisper.cpp" || { echo "Couldn't download it. Is the internet on?"; exit 1; }; fi
  cd "$HOME/whisper.cpp" && cmake -S . -B build -DGGML_NO_OPENMP=ON -DBUILD_SHARED_LIBS=OFF -DCMAKE_BUILD_TYPE=Release >/dev/null \
    && cmake --build build -j4 --target whisper-server whisper-cli \
    || { echo "The build failed. Run robot-hearing-setup again; if it keeps failing, send me the last lines above."; exit 1; }
fi
# Model: base.en is the best balance on a phone. Set "whisperModel" in data/config.json to use another.
if ls "$HOME"/models/ggml-*.bin >/dev/null 2>&1; then
  echo "Hearing model already downloaded: $(ls -S "$HOME"/models/ggml-*.bin | head -1 | xargs basename)"
else
  echo "== Downloading the hearing model (about 60 MB) =="
  HF="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
  get() { curl -fL --retry 3 -o "$HOME/models/$1.part" "$HF/$1" && mv "$HOME/models/$1.part" "$HOME/models/$1"; }
  get ggml-base.en-q5_1.bin || get ggml-base.en.bin || get ggml-tiny.en.bin || { rm -f "$HOME"/models/*.part; echo "Couldn't download the hearing model. Run robot-hearing-setup again when the internet is on."; exit 1; }
fi
echo "Offline hearing is installed. Restart her: robot-stop; robot"
