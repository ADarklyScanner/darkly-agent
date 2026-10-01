# Darkly Robot: Nessari in a tank body

The S22 is her head and brain. Claude is her main brain when there's internet, and the
local Nessari model takes over when there isn't. The face is the home screen.
Tap **Panel** for status, talk, body, sensors, files, logs and settings. The red **STOP**
button is always on screen.

## Install on a fresh phone

1. Install **F-Droid**, then from F-Droid install **Termux**, **Termux:API** (every sensor, flashlight,
   vibration, Wi-Fi, location) and **Termux:Boot** (starts her when the phone turns on). Open each one once.
2. Open Termux and run `termux-setup-storage`, then tap **Allow**.
3. Paste this (needs internet once):

```
pkg install -y git && git clone -b robot --depth 1 https://github.com/ADarklyScanner/darkly-agent ~/darkly-robot && bash ~/darkly-robot/install.sh
```

No internet? If you copied `darkly-robot.zip` onto the phone instead:

```
pkg install -y unzip && unzip -o "$(find ~/storage/shared -iname 'darkly-robot*.zip' | head -1)" -d ~ && bash ~/darkly-robot/install.sh
```

Then run `robot`. The first time, Chrome asks for microphone and camera. Say yes.

Offline brain: put `Llama-3.2-3B-Instruct-abliterated.Q4_0.gguf` (or any .gguf) in the phone's Download folder
or in `~/models`. She finds it by herself.

To have her face pop up on its own after a restart, either run `robot-dedicate` (it does this for you) or go to
Settings > Apps > Termux > **Appear on top** > Allow.

Your Claude key is saved in `~/.robot-key`. To change it, run `nano ~/.robot-key`.

**Backup keys:** put one key per line in `~/.robot-key`. Line 1 is the main key. If a key runs out of credit,
gets rate-limited, or stops working, she switches to the next one by herself. Lines starting with `#` are labels:

```
# robot
sk-ant-api03-...
# backup
sk-ant-api03-...
```

**Cost:** she uses prompt caching. Her personality, tools and older chat are stored by Claude for a few
minutes, and re-reading them costs about a tenth of the normal price. The Status tab shows how much is being reused.

## Give the whole phone to her

`robot-dedicate` sets up the phone to run only the robot:
- turns off about 60 apps she doesn't need (Facebook, Bixby, Samsung extras, Netflix, YouTube, and so on) so their RAM, CPU and battery go to her
- stops Android's "phantom process killer" from shutting down her offline brain
- keeps Termux and Chrome from being put to sleep
- keeps the screen on while she's charging and turns off animations

It uses Wireless debugging, run from Termux on the phone itself. It walks you through a
one-time pairing and doesn't need a computer or root.
Nothing is uninstalled. `robot-undedicate` turns everything back on.

After dedicating, restart with `robot-stop && robot`. `robot` measures free RAM and loads the
**biggest .gguf model in `~/models` that fits**, leaving about 1.4 GB for the face and voice. With
most apps off, the S22's 8 GB can usually hold an 8B Q4 model, which means her Nessari LoRA base can
fit instead of only a 3B model. To force a specific model, add `"localModel": "~/models/name.gguf"`
to `data/config.json`.

## Make the face the home screen

1. In Chrome, open `http://127.0.0.1:3000`, then choose ⋮ > **Add to Home screen** > **Install**.
2. Settings > Display > Screen timeout: longest (`robot-dedicate` keeps it on while charging).
3. To lock the phone to her face, use Settings > Security > Other security settings > **Pin windows**.
4. In the Panel's Settings tab, tap **Full screen**.

## Personality builder

Panel > **Personality**. Pick a preset (Nessari, Plain robot, Grumpy old robot, Hyper puppy-bot) or build your own:
name, who she is, who she's inspired by, trait sliders (sarcasm, warmth, chaos, bluntness, confidence,
curiosity, drama, swearing, reply length), how she feels about her body, how she treats you, catchphrases,
likes, dislikes, and free-form notes. The bottom of the tab shows exactly what she'll be told.

You can also just tell her: "be more sarcastic", "stop swearing", "your name is Bolt now". She changes it herself.

Versions work like your Personality Builder folders:
- **Current:** `data/personality.json`
- **Archive:** `data/personality-archive/`. Every save, yours or hers, keeps the old version here.
- **Rollback:** the **Undo last change** button, or **Restore** on any older version.

The same personality drives both brains (Claude and offline). `persona.md` is generated from the builder,
so put custom text in the builder's "Anything else" box instead of editing that file.

## Her senses

- **Camera:** she looks when she wants to, or when you ask. Claude sees the picture.
- **Every hardware sensor**, through Termux:API: accelerometer, gyroscope, magnetometer, light, proximity, pressure, hall sensor, step counter and anything else the phone reports. Also battery temperature, RAM, storage and CPU heat.
- **Tip-over detection:** if she falls over, the motors stop automatically.
- **Phone abilities:** flashlight, vibration, location, Wi-Fi scan and cell info.
- **Hearing:** tap the mic, or turn on always-listening with an optional wake word. She stops listening while she talks.

## The body board (ESP32-S3)

Firmware: `firmware/darkly_body/darkly_body.ino`
- Arduino IDE, board **ESP32S3 Dev Module**, **USB CDC On Boot: Enabled**, ESP32 core 3.x
- Library: **ESP32Servo**
- The firmware compiles in principle but hasn't been flashed on real hardware yet. Test it with the wheels off the ground first.

| Port | What | ESP32-S3 pins |
|---|---|---|
| M1 | DC motor (left track by default) | PWM 5, IN 6/7 |
| M2 | DC motor (right track by default) | PWM 15, IN 16/17 |
| M3 | DC motor (spare: crane, spinner, anything) | PWM 8, IN 9/10 |
| S1–S4 | Servos (S1 left arm, S2 right arm) | 11, 12, 13, 14 |
| D1 | On/off output (LED, buzzer, relay) | 21 |
| STBY | TB6612FNG standby, shared by both driver chips | 4 |

Power: two 18650 cells feed the motor drivers (VM), and a 5 V ≥3 A buck converter feeds the servos
and ESP32. **Connect all grounds together.** Don't power servos from the ESP32's 3.3 V pin.

Linking to the phone:
- **USB-C:** use a hub with PD pass-through (charger in, ESP32 on a USB port). Panel > Body > Connect USB. Chrome on Android has limited USB serial support, so if it doesn't show the board, use Bluetooth.
- **Bluetooth:** Panel > Body > Connect Bluetooth > "Darkly Body".

If nothing arrives from the phone for 1.5 seconds, the board stops every motor on its own.

## Adding random parts

Plug a motor into any free port and **tell her** what it is:

> "Motor three is a little crane. Forward lifts the hook, backward lowers it."

She saves it to `data/body.json` herself and can use it right away. You can also mark parts
installed or missing on the Body tab, or edit `body.json` in Files.

Part types:
- `dc_motor`: actions look like `{"up":{"dir":1,"speed":0.6}}`
- `servo`: an action is an angle (`90`) or a move sequence (`[[160,300],[40,300]]`)
- `switch`: `{"on":1,"off":0}`

## Files

Everything that belongs to her is in `~/robot/data`:
- `persona.md`: her personality
- `memory.md`: what she's remembered
- `body.json`: her parts
- `config.json`: model settings
- `logs/`: everything she heard, said and did
