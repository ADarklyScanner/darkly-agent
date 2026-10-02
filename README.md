# Darkly Robot: Nessari in a tank body

The S22 is her head and brain. She works with no internet at all (on-phone brain, hearing, voice and eyes),
and uses Gemini or Claude as a smarter brain when there is internet. The face is the home screen.
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

Then run `robot`. If anything seems wrong, run `robot-doctor`: it checks everything and says what to fix. The first time, Chrome asks for microphone and camera. Say yes.

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

**Gemini:** put Gemini keys (from aistudio.google.com, they start with `AIza`) in `~/.robot-gemini-key`,
one per line, same as Claude's. By default she tries Gemini first, then Claude, then the offline brain.
Change the order in Settings > Brain. She picks Google's newest stable Flash model herself; to force one,
add `"geminiModel": "name"` to `data/config.json`.

**Cost:** she uses prompt caching. Her personality, tools and older chat are stored by Claude for a few
minutes, and re-reading them costs about a tenth of the normal price. The Status tab shows how much is being reused.

## Working with no internet

Everything she needs runs on the phone:
- **Brain:** llama.cpp with a .gguf model in `~/models`. Her server starts it when needed, trims the conversation to fit
  the model's window, and falls back to a smaller model if a big one keeps getting killed for memory.
- **Hearing:** whisper.cpp, installed by `robot-hearing-setup` (run once, with internet). In Settings › Hearing, "Auto"
  uses Google's recognizer when online and the phone's own when offline.
- **Voice:** Chrome's voice when it works offline, otherwise the phone's own text-to-speech (through Termux:API).
- **Eyes and sound recognition:** MediaPipe, installed by `robot-vision-download`.

`robot-doctor` has a "Without internet" section that tests each of these and says whether she's ready.
Only Gemini, Claude and looking at photos with them need the internet.

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

## Things she can do

Just ask her, or use Panel > **Tricks** to trigger anything yourself for videos.

- **Music:** a built-in synthesizer with instruments (chip, saw, flute, bell, organ, bass) and drums. She knows public-domain
  songs (Twinkle, Ode to Joy, Happy Birthday, The Entertainer, Für Elise, Jingle Bells, Saints...) and some of her own,
  and she can compose new ones. Her face dances and the phone vibrates to the beat.
- **Singing:** she sings her own lyrics word by word on a melody, robot style.
- **Sound effects:** drumroll, rimshot, airhorn, laser, sad trombone, boing, coin, explosion, applause, fart and more.
- **Vibration:** heartbeat, purr, SOS, laugh, knock (shave and a haircut), earthquake, or any custom pattern.
- **Face effects:** disco, rainbow, dance, dizzy, heart eyes, sunglasses ("deal with it"), laser eyes, glitch storm, sparkle.
- **Morse code:** beeps, vibration and screen flashes, and the real flashlight if you ask.
- **Timers**, **voice styles** (chipmunk, villain, whisper, dramatic...), screen **brightness**, speaker **volume**, **notifications**.
- **Body buzzer:** put a piezo buzzer on D1, tell her "D1 is a buzzer", and she can play songs through her body too.

Android only allows sound and vibration after the first tap on the page, so tap her face once after she starts.

## Tricks, games and the rest

- **Trick Book:** 64 built-in tricks, plus any she invents and saves herself (marked ★ on the Tricks tab).
  Say "do a trick" for a random one, or name one ("do the possessed thing", "fortune teller"). Ask "what tricks do you know?"
- **Games:** Simon Says, reaction test, staring contest, red light green light, color hunt, clap-back, Twenty Questions, trivia, riddles, rock paper scissors,
  scavenger hunt, what's missing, Simon Says with your body, finger math, follow my finger, balance, guess the sound, match my note.
- **Claps:** clap twice and she listens; clap three times for a random trick.
- **Camera:** photos, videos and voice memos are saved to the phone's gallery (Pictures, Movies and Recordings › Nessari).
  She reads QR codes; print `nessari:trick:possessed` as a QR code and showing it to her starts that trick.
- **Notes and memory:** "make a note…", "what's on my shopping list?", "forget that my cat is named Pixel".
- **Diary and achievements:** she keeps a daily diary in `data/diary` and announces milestones.
- **Changelog:** `CHANGELOG.md`. After an update she reads it and tells you what's new.
- **Remote control:** Settings > Remote control. Open the address it shows on another phone on the same Wi-Fi and enter the PIN.
  **Watch live** shows her camera with sound; tap any camera button (front, back, wide...) to switch while watching.
- **Mute:** the speaker button under Panel.

## She can use the phone

Ask her to do things on the phone ("open YouTube and search for cat videos", "turn the brightness down in settings",
"check my email"). She reads the screen, taps, types and scrolls, then comes back to her face with a summary.
It uses Wireless debugging (set up once with `robot-dedicate`), not root. After that she keeps her own connection:
you don't need to leave Wireless debugging open, and after a restart she switches it back on herself. A notification with a STOP button shows while she
works. She won't buy, pay, send, post or delete anything unless that's what you asked for.

## Real eyes (offline vision)

`robot-vision-download` fetches Google's open-source MediaPipe engine and two small models (about 40 MB, once).
After that, with no internet, she tracks your face, reads smiles, surprise, frowns and blinks, takes nods and head
shakes as yes and no, and recognizes hand signs (thumbs up/down, open palm, fist, peace, "I love you", pointing up,
waving). It runs in a background worker so her face stays smooth. Turn it off in Settings if the phone gets hot.

**Living face:** `behaviors.js` combines small face pieces (gaze, blinks, per-eye squints, pupils, chewing,
swallowing, trembling) into reactions: chewing while charging, startles that fade with repeats, glaring when
shaken, squinting at lights, glancing away during long sentences, natural eye contact, peeking with one eye while asleep.

**"Error in termuxApiReceiver" popups:** Settings > Apps > Termux:API: allow all its permissions, set Battery to
Unrestricted, and allow "Modify system settings". Termux and Termux:API must both come from F-Droid.

**Vibration spin:** stand her on a smooth, hard table, ideally without a grippy case, and ask her to spin. She buzzes
her vibration motor and uses her gyro to stop at the right angle. How well it works depends on the surface and case.

## Hands, tags, music and reading

- **Hands:** she counts fingers, follows your fingertip, looks where you point, and knows OK, rock-on, finger gun, "call me" and pinch.
  Teach her your own: hold a gesture up and say "learn this gesture as peace out".
- **Marker tags:** Settings › "print a sheet of tags". Print at 100%, stick them on things, show her one and say "this tag is the charger".
  She recognizes tags instantly, with where they are and roughly how far (a 5 cm tag reads from about 75 cm). Uses js-aruco2 (MIT, in `public/lib/aruco`).
- **Music:** "what note is this?", "hum it back" (she plays your tune on her synth), and she dances on the beat of music in the room.
- **Reading:** "read this" reads printed text with no internet (needs `pkg install tesseract`, which the installer does).
- **Offline skills:** with no internet she still carries out plain requests (games, tricks, counting fingers, finding things, timers, photos);
  see `public/extras.js` for the list of phrases.

## Not repeating herself

She keeps a list of what she's said lately and gets shown it (plus words she's overusing) before she speaks up
on her own. Each spontaneous line gets a random angle, tone and length. A line too close to an old one gets one
retry, then she stays quiet. Her own chatter uses the offline brain when it's running (Settings › "Her own chatter").

## Touching her face

Her face knows where you touch (eyes, eyebrows, forehead, top of head, nose, cheeks, mouth, chin, sides) and how:
tap, double tap, press and hold, stroke, scratch, rub in circles, swipe, tickle (4 quick taps), boop (two-finger tap
or a tap on the nose), squish (pinch), stretch (spread), slap (whole hand). Each one gets an instant face reaction,
and she comments out loud now and then. Scratching her chin makes her purr.

## Make the face the home screen

1. In Chrome, open `http://127.0.0.1:3000`, then choose ⋮ > **Add to Home screen** > **Install**. She gets her own icon and opens full screen, with no browser bar.
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
