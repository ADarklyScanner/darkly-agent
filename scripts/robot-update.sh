#!/data/data/com.termux/files/usr/bin/bash
# Get the newest robot code from GitHub and restart her. Keeps her memory, body, personality and chat.
SRC="$HOME/darkly-robot"
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch --depth 1 origin robot && git -C "$SRC" reset --hard origin/robot
else
  rm -rf "$SRC" && git clone -b robot --depth 1 https://github.com/ADarklyScanner/darkly-agent "$SRC"
fi || { echo "Couldn't reach GitHub. Is the internet on?"; exit 1; }
bash "$SRC/install.sh" --quick && robot-stop; robot
