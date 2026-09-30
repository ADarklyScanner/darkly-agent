#!/data/data/com.termux/files/usr/bin/bash
# Undo robot-dedicate: turn every app back on and restore normal settings.
LIST="$HOME/robot/data/.disabled-packages"
adb devices 2>/dev/null | grep -q "device$" || { echo "Turn on Wireless debugging and run: adb connect localhost:<port>"; exit 1; }
A() { adb shell "$@" 2>/dev/null; }
if [ -f "$LIST" ]; then
  while read -r p; do [ -n "$p" ] && A pm enable "$p" >/dev/null && echo "  on: $p"; done < "$LIST"
  rm -f "$LIST"
fi
A settings put global stay_on_while_plugged_in 0
A settings put global window_animation_scale 1
A settings put global transition_animation_scale 1
A settings put global animator_duration_scale 1
A device_config set_sync_disabled_for_tests none
A settings put global settings_enable_monitor_phantom_procs true
echo "Phone is back to normal."
