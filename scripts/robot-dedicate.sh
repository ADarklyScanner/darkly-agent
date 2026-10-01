#!/data/data/com.termux/files/usr/bin/bash
# Give the whole phone to the robot: turn off the apps she doesn't need, stop Android
# from killing her brain, keep the screen on while charging, drop animations.
# Nothing is deleted. Everything is undone with: robot-undedicate
#
# Uses Android's own Wireless debugging, run from inside Termux (no computer, no root).
DIR="$HOME/robot"
LIST="$DIR/data/.disabled-packages"

if ! adb devices 2>/dev/null | grep -q "device$"; then
cat <<'EOF'
One-time pairing (the phone connects to itself):
 1. Settings > About phone > Software information > tap "Build number" 7 times.
 2. Settings > Developer options > turn on "Wireless debugging" (needs Wi-Fi), tap it.
 3. Tap "Pair device with pairing code". Use split screen so Termux stays visible.
EOF
  if adb devices 2>/dev/null | grep -q "offline\|unauthorized"; then adb kill-server >/dev/null 2>&1; fi
  read -rp "Already paired before? Type y to skip pairing, or just press Enter: " SKIP
  if [ "$SKIP" != "y" ]; then
    echo "Keep the pairing-code box OPEN on screen while you type (split screen), or the code stops working."
    read -rp "Pairing port (the number after the colon): " PP
    read -rp "Pairing code (6 digits): " PC
    # This often prints "protocol fault ... Success" even when pairing worked, so carry on either way.
    adb pair "localhost:$PP" "$PC" || echo "(Pairing reported an error. That's often harmless. Trying to connect anyway...)"
  fi
  echo "Now close the pairing box. On the main Wireless debugging screen, look at 'IP address & Port'."
  read -rp "The number after the colon there: " CP
  adb connect "localhost:$CP"
  sleep 1
  if ! adb devices 2>/dev/null | grep -q "device$"; then
    echo
    echo "Not connected. Check Wireless debugging > 'Paired devices':"
    echo " - If something is listed there, run robot-dedicate again, type y to skip pairing, and enter the port."
    echo " - If nothing is listed, run robot-dedicate again and pair with split screen so the code box stays open."
    exit 1
  fi
fi
A() { adb shell "$@" 2>/dev/null; }

echo "== Letting her reconnect to her own phone controls by herself =="
# Termux may switch Wireless debugging on (after a restart) without you going into Settings
A pm grant com.termux android.permission.WRITE_SECURE_SETTINGS && echo "  ok: she can turn Wireless debugging on herself"
# and a fixed local port that keeps working after Wireless debugging switches off or Wi-Fi drops (until a restart)
adb tcpip 5555 >/dev/null 2>&1; sleep 2; adb connect 127.0.0.1:5555 >/dev/null 2>&1 && echo "  ok: fixed local control port is on"

echo "== Stopping Android from killing her brain =="
A device_config set_sync_disabled_for_tests persistent
A device_config put activity_manager max_phantom_processes 2147483647
A settings put global settings_enable_monitor_phantom_procs false
for p in com.termux com.termux.api com.termux.boot com.android.chrome; do
  A dumpsys deviceidle whitelist +$p >/dev/null
  A cmd appops set $p RUN_ANY_IN_BACKGROUND allow
done
# Lets Termux open her face on screen by itself after the phone boots
A appops set com.termux SYSTEM_ALERT_WINDOW allow

echo "== Screen and speed =="
A settings put global stay_on_while_plugged_in 7          # screen stays on while charging
A settings put global window_animation_scale 0
A settings put global transition_animation_scale 0
A settings put global animator_duration_scale 0

echo "== Turning off apps she doesn't need (frees RAM, CPU and battery) =="
PKGS="
com.facebook.katana com.facebook.appmanager com.facebook.services com.facebook.system
com.samsung.android.bixby.agent com.samsung.android.bixby.wakeup com.samsung.android.bixbyvision.framework
com.samsung.android.visionintelligence com.samsung.android.app.spage com.samsung.android.arzone
com.samsung.android.aremoji com.samsung.android.aremojieditor com.samsung.android.kidsinstaller
com.samsung.android.game.gamehome com.samsung.android.spay com.samsung.android.samsungpass
com.sec.android.app.shealth com.samsung.android.tvplus com.samsung.android.app.tips
com.samsung.android.voc com.samsung.android.app.notes com.samsung.android.email.provider
com.sec.android.app.sbrowser com.sec.android.easyMover com.samsung.android.app.cocktailbarservice
com.samsung.android.mobileservice com.samsung.android.stickercenter com.samsung.android.da.daagent
com.samsung.android.app.sharelive com.samsung.android.smartswitchassistant com.samsung.android.dynamiclock
com.samsung.android.app.watchmanagerstub com.samsung.android.forest com.samsung.android.calendar
com.samsung.android.app.reminder com.samsung.android.oneconnect com.samsung.android.mdx
com.microsoft.skydrive com.microsoft.office.officehubrow com.microsoft.appmanager com.linkedin.android
com.netflix.mediaclient com.netflix.partner.activation com.spotify.music
com.google.android.apps.youtube.music com.google.android.youtube com.google.android.videos
com.google.android.gm com.google.android.apps.maps com.google.android.apps.photos
com.google.android.apps.tachyon com.google.android.apps.docs com.google.android.apps.messaging
com.google.android.apps.subscriptions.red com.google.android.feedback com.google.android.projection.gearhead
"
: > "$LIST.new"
N=0
for p in $PKGS; do
  if A pm list packages -e "$p" | grep -qx "package:$p"; then
    if A pm disable-user --user 0 "$p" | grep -q "disabled"; then echo "$p" >> "$LIST.new"; N=$((N+1)); echo "  off: $p"; fi
  fi
done
cat "$LIST.new" >> "$LIST" 2>/dev/null; sort -u "$LIST" -o "$LIST"; rm -f "$LIST.new"
A am kill-all

FREE=$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo)
echo
echo "Done. Turned off $N apps. Free RAM now: ${FREE} MB."
echo "Chrome, Termux, the phone app, camera, Play services and the launcher were left alone."
echo "Restart her with: robot-stop && robot   (she re-picks the biggest brain that fits)"
