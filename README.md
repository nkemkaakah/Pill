# Pill

A private, Cluely-style AI overlay for macOS. A small draggable capsule that
answers questions about your screen and your calls, records meetings, builds a
speaker-labelled transcript **locally on the Neural Engine**, learns who's who
by voice, and writes Granola-style notes.

## Run it

    npm install
    npm start            # dev loop (renderer edits: reopen; main/lib edits: restart)
    npm run pack         # build dist/mac-arm64/Pill.app for daily use

First launch: add an Anthropic key in Settings for answers. **Transcription needs
no key at all** — it runs on this Mac. Grant mic, screen recording and system
audio recording when prompted; the screen permission needs a quit + reopen to
stick, and every re-pack counts as a new app to macOS.

## Audio, and why it works this way

Two channels, captured differently:

- **`me`** — the microphone, via `getUserMedia` in the renderer.
- **`them`** — everything the Mac is playing, via a **Core Audio process tap**
  (the `audiotee` sidecar, MIT). Taps sit at the HAL, below the window server,
  so they also catch call apps that render audio from a windowless helper
  process, which ScreenCaptureKit cannot see.

This used to be `getDisplayMedia({audio:'loopback'})`, which Electron supports
**on Windows only**. On macOS the audio track never existed, the error was
swallowed, and `them.wav` was a 44-byte header for every meeting ever recorded.
If you see that file at 44 bytes again, the tap is not running — the app now
says so in a banner instead of failing quietly.

Echo cancellation stays **on** for the mic: it stops the far end (coming out of
your speakers) being picked up and transcribed a second time as you. It does not
affect the tap, which sits below VoiceProcessingIO.

## The local engine (one-time setup)

    bash scripts/build-sidecar.sh

This builds [FluidAudio](https://github.com/FluidInference/FluidAudio)
(Apache-2.0) into `sidecar/fluidaudiocli`, and applies Pill's own patch from
`sidecar-patch/` — a `parakeet-stream` subcommand that reads PCM on stdin and
emits NDJSON, which upstream has no equivalent for (`parakeet-eou` reads a whole
file and prints once, so live use would mean re-spawning per utterance).

It powers both paths:

- **Live**, while you record: one streaming process per channel, partials
  greyed in place, finals written as they close.
- **After you stop**: a batch pass with the larger `v2` English model plus
  diarization, which is more accurate than the live pass and is where speaker
  names come from.

Models download from HuggingFace on first use (one-off, a few hundred MB). No
audio leaves the Mac on either path.

## Cloud transcript (optional, off by default)

Paste a Deepgram key in Settings and the Transcript tab grows a **Cloud re-analyse**
button. It re-transcribes the session's audio with Nova-3, which adds punctuation and
capitalisation the local models do not produce:

    local   so um basically you can't outwitch someone someone that on anoth
    cloud   So, basically, you can't out switch someone's system that's on another project.

It replaces only the words. Speaker names still come from the local engine, because
Deepgram returns speaker *labels* but no voice embeddings, and the cross-meeting roster
is built from embeddings. Never runs automatically, asks before spending, and bills per
second of audio per channel — roughly $0.52 for a one-hour two-person call.

## Speakers

After a refined recording, the Transcript tab shows a chip per detected voice.
Click a chip (or any name in the transcript) and type the person's name — every
line updates, and the voiceprint is saved. Next meeting, that person is named
automatically, and each re-identification sharpens their print. Correcting a
name updates it everywhere. Voiceprints live in `speakers.json` in the app's
data folder; your own mic channel is never sent through speaker ID at all.

## Everything else

- **Rec button** on the capsule (⌃⌥R): live transcript, saved to disk
  line-by-line as it arrives. A line lands once the speaker pauses — either
  end-of-utterance fires, or the words stop changing for `sttStableMs`.
- **Notes tab**: Granola-style meeting notes from the smart model, plus every
  past session — searchable, renameable, deletable, with speaker names shown.
- **Quick actions**: answer what was just asked, solve what's on screen, what
  should I say, recap — using transcript + screenshot as context.
- **Shortcuts**: fully customisable in Settings — click one, press the new
  combo. Conflicts with other apps are flagged in red.
- **Drag anywhere** on the capsule text to move the pill; open with the chevron
  or ⌃⌥↩.
- **Invisibility** (⌃⌥I): hidden from Chrome/Meet screen sharing via content
  protection. macOS 15 ScreenCaptureKit apps can still capture it — sharing a
  single window or second display always works.

## Layout

    main.js              window, screenshots, capture + live STT, chat,
                         sessions, shortcuts, refinement pipeline
    preload.js           the only bridge renderer <-> main
    lib/systemaudio.js   Core Audio tap (audiotee) + stall/silence watchdogs
    lib/provider.js      Anthropic + OpenAI-compatible streaming, no SDKs
    lib/prompts.js       system prompt, quick actions, notes prompt
    lib/config.js        settings in userData/config.json
    lib/sessions.js      transcripts (.jsonl), notes (.md), audio (.wav)
    lib/wav.js           streaming WAV writer + resampler
    lib/align.js         words->speakers alignment, voiceprints, matching
    lib/speakers.js      the saved voice roster (speakers.json)
    lib/sidecar.js       fluidaudiocli: batch calls + StreamingSidecar (live)
    lib/deepgram.js      optional cloud transcript pass (words only)
    lib/refine.js        the post-recording pipeline
    sidecar-patch/       Pill's parakeet-stream command, applied at build time
    renderer/            plain HTML/CSS/JS, no bundler
    scripts/             build-sidecar.sh, tests, mocks, smoke test

## Tests

    npm test                        # all three suites
    node scripts/test-lib.js        # wav writer, resampler, alignment, matching, roster
    node scripts/test-pipeline.js   # full refine flow against a mock engine
    node scripts/test-audio.js      # tap + streaming engine, incl. every silent-failure mode
    npm run smoke                   # boots the UI headless, walks every view, screenshots

## Debugging

`fluidaudiocli` logs to OSLog only — in a release build a spawned child sees
**nothing**, not even `--help` output. If the local engine misbehaves:

    log stream --predicate 'subsystem == "com.fluidinference"'

`parakeet-stream` is the exception: it writes diagnostics to stderr on purpose,
which is why its failures reach the UI. `PILL_DEBUG_PCM=1 npm start` logs how
many audio bytes reach each channel and whether its recogniser is ready.
