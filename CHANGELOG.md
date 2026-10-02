# Nessari changelog

Newest first. She reads this herself after an update.

## 2026-10-02 · v0.19 · Screen off, and a card on the lock screen
Tested here in a simulated browser. How Chrome on your phone behaves with the screen really off is the part I can't see from here.
- Go dark: say "go dark", "screen off" or "lights out" (or she can do it herself as a tool). Her page stays up but shows pure black, which on this kind of screen means the pixels are off. Everything keeps running: camera, eyes, ears, voice, brain. Touch the screen or say "screen on" and her face is back. This is the way to have the screen off and lose nothing.
- The power button: with the screen really off, Chrome takes her camera away. What keeps going is sound. She switches to the phone's own hearing and keeps listening; because she can't see who's talking, she only answers when she hears her name (spelled however the hearing spells it), or within 45 seconds of her own last answer so a conversation can continue. This needs the microphone to be open already when the screen goes off: it is in tap-to-talk mode and with Hearing set to the phone's own. In always-listening mode with Google's recognizer, Android may refuse to hand the microphone over in the dark.
- Lock screen: a web page can't draw over Android's lock screen, so her full moving face isn't possible there. What she has instead is a media card, the kind a music player shows: a picture of her face in her current mood, her name and state, the last thing she said, and three buttons. Pause mutes her and play unmutes her; next makes her say something; previous makes her repeat her last line. A silent sound loop keeps the card and her page alive in the background, which also means other apps' music pauses while her page is open (Settings has a switch).
- Settings: "Keeps listening when the screen is off" and "Shows on the lock screen", both on by default. The Status tab has a Screen row.

## 2026-10-02 · v0.18.3 · A brain program built for this phone
Your tuning run showed thread count barely matters (9.5 to 10.8 tokens a second reading, whatever the number), so the limit is somewhere else. My best guess is the program itself: the ready-made llama.cpp from Termux has to run on every phone, so it likely can't use the newer processor instructions your chip has. That's a guess until it's measured, so the new command measures it.
- New command: robot-brain-build. It builds llama.cpp on the phone for the phone's own processor (the same version her server was tested against here), then times it against the ready-made one with your model. She switches only if the new one is really faster; otherwise nothing changes. If it wins, thread tuning runs again for it. About 20-30 minutes, once, with internet; plug her in.
- robot-tune: a run that fails now says so instead of printing "reads 0".
- The check-up's "program" line was printing a log line instead of anything useful. It now says which brain program she's using.

## 2026-10-02 · v0.18.2 · Shorter waits for offline answers
Your check-up showed the offline brain answering, but reading only 10 tokens a second. At that speed, every 40 characters she hands it costs about a second before it can start answering. Tested here against the real llama.cpp program with a stand-in model; your phone's numbers are the ones that count.
- She no longer makes the brain re-read the conversation. Earlier turns are sent word for word as the brain saw and wrote them, so it recognizes them and reads only your new message. The window of turns it's sent moves in big steps instead of sliding every turn (sliding forced a full re-read each time).
- What rides along with each message (what she sees, recent events, her state) is cut to the essentials when the brain is slow: about 240 characters on your phone, down from several hundred.
- Her own spontaneous lines get a shorter prompt on a slow brain, and they no longer wipe the brain's memory of your conversation.
- Writing was being slowed by one of my own settings: for every token, the brain was sorting its whole 128,000-word vocabulary. Fixed; nothing about her variety changes. On the test machine that step went from 15 ms to 4 ms per token.
- New command: robot-tune. It tries different numbers of processor threads, times each one on your phone, saves the fastest and restarts the brain with it. About three minutes, once. Phones mix fast and slow cores, so the best number has to be measured.
- The check-up's own test question no longer leaves the brain "cold": her notes are read again right after.
- Camera and microphone: if she restarts while you're in Termux, Chrome refuses them ("Permission denied" in the log) because her page isn't on the screen. She now tries again as soon as the page is back in front.

## 2026-10-02 · v0.18.1 · Why her offline brain never answered, fixed
Your check-up finally showed the real reason, and this time I rebuilt the same brain program here (llama.cpp, current version) and tested against it instead of a stand-in. I still can't run your 3B model or your phone, so speed on the S22 is the one thing left to see.
- The actual error: I was sending the brain a setting ("dry_penalty_last_n: -1") that the current llama.cpp refuses, so it turned down every request with "400 Field 'dry_penalty_last_n'...". I reproduced that exact message here and fixed it. If a future version refuses some other setting, she now drops that setting and asks again by herself instead of failing.
- Behind that was a second problem: "no answer (took too long)". She was handing the brain up to about 3,000 tokens of notes and chat to read before every answer, and a phone reads slowly. Now she measures how fast this phone's brain reads and writes, and sizes what she sends so reading takes about half a minute at most. Slower phone, shorter notes.
- The brain now handles one conversation at a time and keeps what it has already read. While nothing is happening she has it read her standing notes (who she is, her memory, the rules) ahead of time, so when you speak it only reads what you said. In the test here a follow-up message needed 18 new tokens read instead of about 1,850.
- If it's ever too slow anyway, she halves what she sends and goes straight to the shortest possible request, instead of waiting three minutes twice more.
- The check-up said "Offline brain isn't running" while it was running. It looked for the program by name, which isn't reliable on your Termux. It now asks the brain directly, shows its answer, and prints how fast it reads and writes. Starting and stopping use saved process numbers, so a second copy can't be started on top of the first (that's where the misleading "no offline brain model could run" line came from).
- Status tab shows the brain's speed.

## 2026-10-02 · v0.18 · She knows people, and has one mind for attention
All of this runs on the phone with no internet. Face recognition was tested here on real photos; the rest with simulated cameras and sounds.
- Knowing people: introduce someone ("this is Sam", or "remember my face as Johnny") and she recognizes them from then on. She greets by name, knows when she last saw them, and tells a familiar face from a stranger. You can add notes about a person. Face prints are stored only on this phone, only for people you introduce; strangers are only counted while she's running. On a set of real photos she got 12 of 12 right with no stranger mistaken for someone she knew. Turn it off in Settings.
- One attention system: faces, fingertips, movement, lights, bangs and new objects used to tug her eyes separately. Now they all compete in one place by importance. The thing she's looking at keeps a little loyalty, staring wears off so other things can win, new targets get a quick jump (with a blink on big jumps) and the same target gets smooth following. Her brain is told what she's attending to.
- Was that said to her? In always-listening mode, if she can see people and nobody was facing her or moving their lips, she's told it may not have been meant for her (a TV, another conversation) and can stay quiet.
- Looking after herself: when the phone is hot or the battery is low she slows her eyes and ears down, says so once, and speeds back up after. She estimates how long her battery will last. If Android takes her camera or microphone away she takes it back. "Systems check" (or "are you okay") runs a spoken check of every part of her.
- Peekaboo: cover her camera and uncover it.
- Shush: tap her mouth, or hold up an open hand, and she stops talking.
- Phone routines: when she finishes a phone task, she remembers how, by what she tapped rather than where. Ask for the same thing again and she does it from memory with no AI, which also works with no internet. If the screen has changed she works it out afresh. She also notices when a tap did nothing and tries something else.
- Ears: she has two small ears now. They perk at sounds, go up while she listens, droop when she's sleepy and flick when she's bored. If the phone gives her both of its microphones she can tell which end of the phone a sound came from and looks that way; "calibrate your ears" teaches her which end is up. Self check tells you whether your phone gives her two microphones.
- New sounds she knows: doors, slams, footsteps, keys, a TV, typing, running water, car horns. Background ones are noted, not commented on.
- Rooms: "this is the kitchen". She recognizes the room when she sees it again, and things she learns about get the room attached ("the kettle: by the sink, in the kitchen").
- Things you show her: hold something up and say "this is Frank" or "this is my good screwdriver". She remembers what that exact thing looks like.
- Learning what you like: a laugh, a smile, a thumbs-up or "good one" right after one of her own lines makes that kind of line more likely. "Not funny", a thumbs-down or "stop" makes it less likely. "Be quiet" or "stop talking" silences her own chatter for ten minutes.
- Face: head tilts when curious, leans in to a whisper, pulls back from something rushing at her, goes slightly cross-eyed when your face is very close, stretches after waking. A quiet "hmm" if an answer is taking a while. Late at night in a quiet room she keeps her voice down.
- Still not done, and why: depth, mapping and navigation, the arm, and neural voices need the body or builds I can't check from here. "Things you show her" and rooms rely on a model I could only test the plumbing for.

## 2026-10-02 · v0.17 · A big batch from your lists
Everything here runs on the phone with no internet. I tested it with simulated cameras and sounds; your real hands, face and voice are the real test.
- Offline skills: the offline brain used to be able to talk and nothing else. Now plain requests are recognized and really carried out even with no internet: "play scavenger hunt", "do a trick", "how many fingers", "what am I holding", "where's my screwdriver", "I put the keys on the table", "read this", "set a timer for 5 minutes", "take a picture", "play jingle bells", "copy my face", about 28 kinds in all. She does it, then tells you the result in her own words.
- Hands: counts fingers (both hands, 0 to 10), follows your fingertip with her eyes, looks where you point, and knows new signs: OK, rock-on, finger gun (she plays dead), "call me", pinch, and the middle finger (she takes it personally). You can teach her your own gestures ("learn this gesture as peace out") and link one to a trick.
- Faces: winks back, blushes at a blown kiss, raises an eyebrow back, and catches your yawns.
- Ears: tells you which note you're singing or whistling and whether it's in tune, hums a tune back on her synth, finds the tempo of music and dances on the beat, hears finger snaps. Whisper to her (offline hearing) and she whispers back. A small speech detector now screens every clip so bangs and music aren't turned into made-up words.
- Motion: knows which way something crossed her view and looks ahead of it, notices when she's being turned, flinches when something rushes at her face, and in free fall shuts her eyes, then looks around after landing.
- Marker tags: printable squares she recognizes instantly (Settings › "print a sheet of tags"). Show her one and say "this tag is the charger". She knows where it is and roughly how far, remembers where she last saw it, and gets excited when she's low on battery and spots the charger tag. A 5 cm tag reads from about 75 cm.
- Reads printed text offline (labels, signs, model numbers) with the phone's own text reader. Reads the phone's notifications aloud when you ask. NFC stickers can trigger tricks (Settings). Remembers places by name using location.
- Memory finds things more like a person does: by nickname, by different word forms ("screw driver" finds "screwdrivers"), and, if the small language model is downloaded, by meaning.
- 8 new games: scavenger hunt, what's missing, Simon Says with your body, finger math, follow my finger, balance, guess the sound, match my note. 17 new tricks (64 total), including big yawn, play dead, eat a snack, name that note, hum it back, read this.
- Her face dims when nobody's been around for 5 minutes and wakes when someone returns. Her battery level shows on the left side meter. Low battery makes her ask for the charger and keep answers short. She knows morning from late night.
- Left and right are now hers. Before, with the front camera, "on your left" was mirrored.
- Opt-in: she can take a photo by herself when something interesting happens (off by default, saved only to the gallery).
- Not done yet, and why: recognizing specific people by face or voice, depth estimation and a custom "Nessari" wake-word model all need models I can't check from here. Anything about driving waits for the body.
- To get the new pieces, run robot-update with internet on (it installs the text reader and downloads the memory model).

## 2026-10-02 · v0.16.2 · Typed messages never vanish
- Fixed: typing a message and pressing Send made it disappear with no answer. If she was busy (often with her own chatter waiting on the offline brain), the message was thrown away. Now what you say always wins: her own chatter is cancelled on the spot, including on the offline brain itself, so it's free for you. If she's busy answering you, your next message shows in the chat and is answered next. A turn stuck for over 2.5 minutes is abandoned.
- The Talk tab shows what she's doing ("thinking with the offline brain… 20s", "your next message is waiting").

## 2026-10-02 · v0.16.1 · Offline brain start fix
- Fixed: the offline brain refused to start ("too big for the free memory right now") even with a small 3B model. Android reports less free memory than it can actually hand over, and I was trusting that number. Now no model is ruled out: she tries the ones that look like they fit first, then the rest, and only gives up on a model if it really gets killed.
- robot-doctor: no longer says the brain server is down when it's up (it was writing to a folder Termux doesn't have), key numbers print correctly, and the phone-voice check is more patient.

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
