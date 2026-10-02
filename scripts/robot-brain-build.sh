#!/data/data/com.termux/files/usr/bin/bash
# Builds the offline brain program (llama.cpp) on this phone, for this phone's own processor, then times it
# against the ready-made one from Termux and keeps whichever is faster.
# Why: the ready-made program has to run on every phone, so it can't use the newer processor instructions
# (dot-product and matrix-multiply) that make reading much faster on a chip like this one. A build made here can.
# Needs internet and about 20-30 minutes. Plug her in. Nothing changes unless the new build is really faster.
#   robot-brain-build            build (if needed), compare, keep the faster, then tune threads
#   robot-brain-build --rebuild  build again from scratch
set -o pipefail
DIR="$HOME/robot"; D="$DIR/data"; SRC="$HOME/llama.cpp"; OUT="$SRC/build-native/bin/llama-server"
PIN=2923cf2862ad0afa159444cf07fec7600d755fe1      # the llama.cpp version her server was tested against
. "$DIR/brain-time.sh"
mkdir -p "$D/logs"
MODEL="$(cat "$D/.brain-model" 2>/dev/null)"
[ -f "$MODEL" ] || MODEL="$(find "$HOME/models" -maxdepth 2 -name '*.gguf' -size +50M 2>/dev/null | grep -v -i 'mmproj\|lora\|adapter' | head -1)"
[ -f "$MODEL" ] || { echo "No offline brain model found in ~/models."; exit 1; }
command -v termux-wake-lock >/dev/null && termux-wake-lock

# ---------- what this processor can do ----------
FEAT="$(grep -m1 -i '^Features' /proc/cpuinfo 2>/dev/null)"
ARCH=""
case " $FEAT " in *" asimddp "*) ARCH="armv8.2-a+dotprod";; esac
[ -n "$ARCH" ] && case " $FEAT " in *" i8mm "*) ARCH="$ARCH+i8mm";; esac
[ -n "$ARCH" ] && case " $FEAT " in *" asimdhp "*) ARCH="$ARCH+fp16";; esac
echo "== Building the offline brain for this phone =="
echo "Processor extras found: ${ARCH:-none detected (the build will work them out itself)}"

# ---------- build ----------
[ "$1" = "--rebuild" ] && rm -rf "$SRC/build-native"
if [ -x "$OUT" ]; then
  echo "Already built: $OUT"
else
  echo "Downloading and building. This is the long part (20-30 minutes); the phone will get warm."
  if command -v pkg >/dev/null; then pkg install -y git cmake clang make >/dev/null 2>&1 || pkg install -y git cmake clang make; fi
  if [ ! -d "$SRC/.git" ]; then
    rm -rf "$SRC"; git init -q "$SRC" && git -C "$SRC" remote add origin https://github.com/ggml-org/llama.cpp
  fi
  ( cd "$SRC" && { git fetch -q --depth 1 origin "$PIN" && git checkout -q FETCH_HEAD || { echo "(couldn't get the tested version; using the newest)"; git fetch -q --depth 1 origin master && git checkout -q FETCH_HEAD; }; } ) \
    || { echo "Couldn't download llama.cpp. Is the internet on?"; exit 1; }
  FLAGS=(-DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_OPENMP=OFF -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF
         -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF)
  [ -n "$ARCH" ] && FLAGS+=(-DGGML_NATIVE=OFF "-DGGML_CPU_ARM_ARCH=$ARCH") || FLAGS+=(-DGGML_NATIVE=ON)
  ( cd "$SRC" && cmake -S . -B build-native "${FLAGS[@]}" > "$D/logs/brain-build.log" 2>&1 \
      && cmake --build build-native --target llama-server -j 4 >> "$D/logs/brain-build.log" 2>&1 ) \
    || { echo "The build failed. Nothing was changed. Send me this:"; tail -15 "$D/logs/brain-build.log"; exit 1; }
  [ -x "$OUT" ] || { echo "The build finished but the program isn't there. Nothing was changed."; tail -5 "$D/logs/brain-build.log"; exit 1; }
  echo "Built."
fi

# ---------- compare with the ready-made one, same model, same threads ----------
STOCK="$(command -v llama-server || true)"
T=4; TB=""
[ -f "$D/.brain-threads" ] && read -r T TB _ < "$D/.brain-threads"
trap 'resume_brain; exit 1' INT TERM
pause_brain
echo "== Timing both (about a minute each) =="
NEW=$(time_brain "$OUT" "$MODEL" "$T" "$TB")
echo "  built here:  reads ${NEW% *}, writes ${NEW#* } tokens a second"
if [ -n "$STOCK" ]; then
  sleep 3
  OLD=$(time_brain "$STOCK" "$MODEL" "$T" "$TB")
  echo "  ready-made:  reads ${OLD% *}, writes ${OLD#* } tokens a second"
else OLD="0 0"; fi
SN=$(turn_secs $NEW); SO=$(turn_secs $OLD)
if [ "$NEW" = "0 0" ]; then
  echo "The new build didn't run, so nothing was changed. Send me this:"; tail -8 "$D/logs/tune.log" | cut -c1-200
  rm -f "$D/.brain-program"; resume_brain; exit 1
elif faster "$SO" "$SN"; then                        # the old one takes more than 5% longer for a typical turn
  echo "$OUT" > "$D/.brain-program"; rm -f "$D/.brain-speed.json"
  if [ "$OLD" = "0 0" ]; then echo "The build made here works and the ready-made one did not run, so she will use the new one from now on."
  else echo "The build made here is faster (a typical answer: ${SN}s instead of ${SO}s). She will use it from now on."; fi
  echo "{\"t\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"kind\":\"brain\",\"detail\":\"own build chosen ($ARCH): reads ${NEW% *}/s writes ${NEW#* }/s, ready-made reads ${OLD% *}/s writes ${OLD#* }/s\"}" >> "$D/logs/robot-log.jsonl"
  resume_brain
  echo "== Now finding the best thread count for the new build =="
  bash "$DIR/robot-tune.sh" --here
else
  rm -f "$D/.brain-program"
  echo "The new build isn't faster on this phone (${SN}s against ${SO}s for a typical answer), so she keeps the ready-made one."
  echo "{\"t\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"kind\":\"brain\",\"detail\":\"own build NOT faster ($ARCH): reads ${NEW% *}/s writes ${NEW#* }/s, ready-made reads ${OLD% *}/s writes ${OLD#* }/s\"}" >> "$D/logs/robot-log.jsonl"
  resume_brain
fi
exit 0
