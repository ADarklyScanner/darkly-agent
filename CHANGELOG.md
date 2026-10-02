# Nessari changelog

Newest first. She reads this herself after an update.

## 2026-10-02 · v0.16 · Actually works with no internet
- Offline hearing: she used to listen through Chrome's speech recognition, which sends your voice to Google, so with no internet she was deaf and nothing reached her brain. Now she has her own on-phone recognizer (whisper.cpp, open source) and switches to it by herself when there's no internet. Install it once with robot-hearing-setup (robot-update does this for you). Settings › Hearing lets you keep it on the phone's own recognizer all the time (private).
- Offline brain fixed ("My brain just glitched. Local brain error"): the on-phone model has a small window for text and refused anything bigger. Her server now measures that window and trims old chat and long notes to fit, waits if the model is still loading, and retries in simpler forms if the model still refuses. If it fails anyway she tells you the real reason instead of a generic error.
- The offline brain looks after itself: if it isn't running when she needs it, her server starts it. If a big model keeps getting killed for memory, she drops to the next smaller one. If the personality adapter doesn't fit the model, she starts without it rather than not at all.
- Offline voice: if Chrome's voice needs the internet or stays silent, she speaks with the phone's own text-to-speech instead.
- No more waiting on a dead connection: she checks the internet is really there before trying Gemini or Claude, and a failed call marks her offline straight away.
- robot-doctor has a "Without internet" section: it asks the offline brain a real question, checks hearing and voice, and says plainly whether she can work offline.
- Status tab shows offline brain, offline hearing, which hearing is in use, and offline voice.

## 2026-10-01 · v0.15 · She stops repeating herself
- She remembers everything she's said lately (data/said-recently.json, kept across restarts). Before saying something on her own she's shown what she already said and which words she's overusing (no more "is that a ghost?" for the twelfth time).
- Every spontaneous line gets a random angle, tone and length: about 3,900 combinations (guesses, complaints, nature-documentary narration, made-up statistics, playful threats, tiny poems, sports commentary...). An angle isn't reused until 15 others have been.
- Repeat catcher: if a line comes out too close to something she's said before, she tries once more; if it's still a rerun she stays quiet and gives a look instead. Silence beats a rerun.
- Same thing over and over: on the third comment about the same kind of event she notices the pattern instead; after five in a few hours she just reacts with her face.
- Her own chatter (reactions, speaking up when bored) now uses the offline brain whenever it's running: free, private, works without internet. Questions you ask still go to Gemini/Claude first. Change it in Settings › "Her own chatter".
- Offline brain variety: a new random seed every time, a penalty for repeating recent words, and DRY (stops repeated phrases). Spontaneous lines run hotter than answers to your questions.

## 2026-10-01 · v0.14 · Live video, smoother eyes, a living face
- Phone controls stay connected: after the first setup she switches to a fixed local port, so you don't have to keep Wireless debugging open. After a restart she turns Wireless debugging back on by herself and reconnects. Run robot-dedicate once more to give her that permission.
- Live video: the remote page has "Watch live" with sound, and a button for every camera the phone has (front, back, wide, zoom). Switch cameras while watching. Up to 3 people at once, same Wi-Fi.
- Her vision and hearing now run in a background worker, separate from her face, so the face and touch stay smooth while she looks and listens. If a phone can't do that, they quietly run the old way.
- Face behaviors built from small pieces (gaze, blink, squint each eye, pupils, freeze, eye darting, drifting, chewing, swallowing, trembling, puffs) and combined by what she senses:
  - Charging: she looks down at the cable and politely chews. She chews faster when nearly empty and slower as she fills up, swallows now and then, burps at 100% and looks full. Fiddling with the cable annoys her. When her battery is low she glances down hungrily, with sleepy half-blinks.
  - Startles: she freezes, hard-blinks, snaps her eyes to the source (overshooting a bit), checks around, then relaxes slowly. Repeats matter less, a much louder one renews the reaction, and right after one she's jumpy.
  - Shaking: rapid blinks, then a glare, then real anger if you keep doing it. Falling: eyes shut, then wide, then she looks around.
  - Lights: lights coming on make her squint; in the dark her pupils widen.
  - Moods: alert means quick darting eyes, concentrating means steady ones. Listening makes her settle, and her eyes slowly drift when she's bored. Boredom fidgets include looking at the ceiling or floor, one eye drooping, playing with her pupils, and the odd eye-roll, never the same one twice in a row.
  - Talking: blinks between phrases, glances away during long explanations, eyes narrow on sarcasm, widen on exclamations, and she nods when she's done.
  - Thinking: a different look for an online answer, the offline brain, looking at something, and remembering. She gets impatient if it takes ages, does an "aha" when the answer lands, and looks annoyed when the internet fails.
  - People: she holds eye contact, then breaks it naturally. Your smile reaches her eyes. She keeps looking where you left. A quick nod if you were gone a minute, a big hello if it's been hours.
  - Objects: she inspects new objects (object, then you, then the object again) and gives familiar ones only a glance.
  - Asleep: something moving makes her peek with one eye, then she dozes off again. She wakes with heavy lids.
- Fixed "Error in termuxApiReceiver" popups: she now reads only the sensors she uses, one read at a time, and backs off if reads fail. If a phone ability needs an Android permission, she says which one.
- The chat opens on your newest messages and stays scrolled to the bottom (unless you've scrolled up to read).

## 2026-10-01 · v0.13 · Hands on the phone, more senses
- She can drive the phone she lives on: open apps, read the screen, tap, scroll, type and press buttons, step by step until the job's done, then come back to her face and tell you what happened. Ask her things like "open YouTube and find cat videos" or "turn on dark mode". Uses Wireless debugging (paired by robot-dedicate), not root, and reconnects by itself when the port changes.
- Guardrails: only when you ask, max 25 steps / 4 minutes, STOP (or the STOP button in the notification) cancels, and she refuses to tap anything that buys, pays, sends, posts or deletes unless your request asked for it.
- Hears what kind of sound it is (offline, Google's YAMNet): knocks, doorbells, dogs, cats, alarms and sirens, phones ringing, glass breaking, crying, laughter, sneezes, coughs, snoring, applause, singing, music (she dances to it), thunder, bangs. Repeated sounds fade like everything else.
- Sees everyday objects (offline): cups, bottles, phones, books, scissors, remotes, keyboards, pets... She remembers where she saw them, gets curious about new ones (not about every single one), and knows something that left her view is probably still nearby. "What am I holding?" works without internet.
- Body pose: notices you crouching down to her level, hands up, turning away.
- Scene memory: recognizes places she's been, and notices when she's somewhere new.
- Perception backs off automatically when the phone is busy, so her face stays smooth.
- Keeps her face portrait when the robot tilts (full screen / installed app), and notices network changes (Wi-Fi ↔ mobile data, slow connection).
- robot-doctor checks the phone controls. Run robot-vision-download again to get the new models.

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
