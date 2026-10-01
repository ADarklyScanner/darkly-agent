# Nessari changelog

Newest first. She reads this herself after an update.

## 2026-10-01 · v0.12 · A mind underneath
- Behavior engine (mind.js) under everything: perception → events → salience → attention → working memory → inner state → action.
- Restraint: most things she notices don't get a comment. Each event gets a salience score; only salient ones become speech, smaller ones only a face reaction, small ones nothing. A speech budget stops her chattering.
- Habituation: the first bang gets a strong reaction, the fifth barely a glance. Things she's never seen before, and loud things at night, stand out more.
- Inner state instead of switch-flipping moods: arousal, irritation, amusement, curiosity, boredom and alertness rise with events and fade at their own pace, blending subtly into her face. Repeated poking builds irritation (annoyed, then angry); scratches and pets calm it. Strong feelings break through.
- Attention: a sudden event steals her gaze; if it's big enough she stops mid-sentence, reacts, then picks up with "Anyway…".
- Working memory: a running stream of recent events with how she knows them (saw, heard, felt, told, inferred) goes along with each message, so "do that again", "where did I put the screwdriver" and "that's the third time" work.
- World model: where things are, with confidence that fades unless reinforced ("I'm sure" vs "I think" vs "I vaguely remember"); names you use for things; open loops she brings up later (when you come back, when internet returns, when she's on the charger).
- Says how she knows things and checks garbled speech instead of guessing.
- Backchannels while you talk (nods, eyebrows, blinks). While thinking she keeps looking at you but glances away now and then. Tiny eye movements and uneven blinking so she never looks frozen. Searches the room when you leave her view.
- Only speaks up on her own when someone's actually around and she's bored, or has unfinished business.
- Learns a bedtime routine: on the charger late at night (in the dark, or at the usual time) she goes to sleep; she wakes when you talk, touch her or come into view.
- Your personality settings now change behavior too: how much it takes to make her talk, how big her reactions are, how fast she gets irritated or bored.
- Daily compression: raw events become a short episode summary per day.
- Fixed: lying flat on a table no longer counts as tipped over or tilted. She now reads the direction of gravity: upright, flat (resting), face down, upside down, on her side.

## 2026-10-01 · v0.11 · Real eyes
- Vision engine: Google's open-source MediaPipe (Apache 2.0) runs on the phone with no internet. Download it once with robot-vision-download (the installer tries automatically).
- Her eyes follow your actual face, not just movement. She counts people, notices someone arriving, leaving, getting really close, looking at her or away, and eyes closed for a while.
- Reads expressions: smiling, surprised, frowning. Mirror mode copies your face with hers.
- Nod or shake your head to answer her questions yes or no.
- Hand signs: thumbs up/down (also answers her questions), peace sign, "I love you" sign (heart eyes), fist, pointing up. Wave at her to make her listen.
- Offline rock paper scissors that reads your actual hand. Staring contest now watches your real blinks.
- Vibration spin: she spins in place using only her vibration motor (the Cycloramic trick), measuring the turn with her gyro. She can also spin until she's facing you.
- New tricks: vibro spin, rock paper scissors (offline), mirror me.
- robot-doctor checks the vision engine.

## 2026-10-01 · v0.10 · Sturdier
- Offline brain talks while it thinks: each sentence is spoken as soon as it's written, instead of waiting for the whole reply.
- New robot-doctor command: checks the server, offline brain, memory, Termux:API, storage, boot setup and tests every Claude and Gemini key, then says what to fix.
- Her server and offline brain restart themselves if they crash.
- If her server stops, her face says so and tells you to type "robot"; she says "I'm back" when it returns.
- STOP also cuts off speech that's still queued.
- She no longer brings up her missing body all the time. The parts are a while away; she only mentions it when asked to do something physical.

## 2026-10-01 · v0.9 · The big trick update
- Trick Book: 44 built-in tricks (possessed, deal with it, dramatic death, magic trick, fortune teller, roast, beatbox, countdown and more). She can list them, do one at random, and invent and save her own tricks.
- Games: Simon Says on her face, reaction-time test, staring contest, red light green light with the camera, color hunt, clap-back.
- Ears: hears claps (2 claps = she listens, 3 claps = random trick), bangs and shouting.
- Echo: records you and plays it back as a chipmunk, deep, backwards or robot voice.
- Face moves: wink, double blink, squint, wide eyes, eye roll, side-eye, look around, scan the room, startle, reboot, nod, head shake. New moods: bored and suspicious.
- Eyes can follow movement, bright lights or a chosen color. Pinch and spread change her eye size.
- Reads QR codes and barcodes. Printed codes like "nessari:trick:possessed" trigger tricks.
- Photos, videos and voice memos saved to the phone's gallery.
- Notes (save, list, read, delete) and she can read or forget things in her memory.
- Achievements, a daily diary, and stats she can brag about.
- Reacts to being held upside down, tilted, dropped, set down, losing or getting back internet. Dims her face in the dark. Gets bored when ignored.
- Swipe all the way across her face to switch personality. Press and hold her face to talk. Poking her a lot makes her annoyed, then angry.
- Remote control from another phone on the same Wi-Fi, with a PIN.
- Mute button. Speech is more reliable (long replies no longer get cut off).
- She can read this changelog.

## 2026-10-01 · v0.8 · Performer
- Synthesizer with songs, singing, 20 sound effects, vibration patterns, face effects, Morse code, timers, voice styles, brightness, volume and notifications.
- Touch zones and gestures on her face. Installable full-screen app with her own icon. Body board: buzzer and motor soft-start.

## 2026-10-01 · v0.7 · Alive
- Animated face. Speaks up on her own and reacts to things (picked up, charger, lights, battery). Eyes follow movement through the camera. Each personality keeps its own conversation.

## 2026-10-01 · v0.6 · Brains
- Gemini brain first, then Claude, then offline. Backup keys, prompt caching, remembers chats across reloads, personality builder.

## 2026-09-29 · v0.5 · First boot
- Face, voice, Claude and offline brains, body link over USB or Bluetooth, sensors, files, logs, settings, STOP button.
