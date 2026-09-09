# Pill

A private, Cluely-style AI overlay for macOS. A small draggable capsule that
answers questions about your screen and your calls, records meetings, builds a
speaker-labelled transcript **locally on the Neural Engine**, learns who's who
by voice, and writes Granola-style notes.

## Run it

    npm install
    npm start            # dev loop (renderer edits: reopen; main/lib edits: restart)
    npm run pack         # build dist/mac-arm64/Pill.app for daily use

First launch: add an API key in Settings (Anthropic for answers; an OpenAI key
enables live transcription while you record). Grant mic + screen recording when
prompted — the screen permission needs a quit + reopen to stick, and every
re-pack counts as a new app to macOS.

## The local engine (one-time setup)

Recording always saves raw audio (`me.wav` = your mic, `them.wav` = whatever
the Mac plays). With the local engine installed, stopping a recording rebuilds
the transcript on-device — better accuracy than the live pass, with speakers
separated and named:

    bash scripts/build-sidecar.sh

That builds the stock [FluidAudio](https://github.com/FluidInference/FluidAudio)
CLI (Apache-2.0) into `sidecar/fluidaudiocli`; `npm start` and `npm run pack`
both pick it up. The first refinement downloads CoreML models from HuggingFace
(one-off). No audio ever leaves the Mac for this path — it works with no API
key at all.

## Speakers

After a refined recording, the Transcript tab shows a chip per detected voice.
Click a chip (or any name in the transcript) and type the person's name — every
line updates, and the voiceprint is saved. Next meeting, that person is named
automatically, and each re-identification sharpens their print. Correcting a
name updates it everywhere. Voiceprints live in `speakers.json` in the app's
data folder; your own mic channel is never sent through speaker ID at all.

## Everything else

- **Rec button** on the capsule (⌃⌥R): live transcript a few seconds behind,
  saved to disk line-by-line as it arrives.
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

    main.js              window, screenshots, loopback audio, chat, sessions,
                         shortcuts, refinement pipeline
    preload.js           the only bridge renderer <-> main
    lib/provider.js      Anthropic + OpenAI-compatible streaming, no SDKs
    lib/prompts.js       system prompt, quick actions, notes prompt
    lib/config.js        settings in userData/config.json
    lib/sessions.js      transcripts (.jsonl), notes (.md), audio (.wav)
    lib/wav.js           streaming WAV writer + resampler
    lib/align.js         words->speakers alignment, voiceprints, matching
    lib/speakers.js      the saved voice roster (speakers.json)
    lib/sidecar.js       spawns fluidaudiocli, parses its JSON
    lib/refine.js        the post-recording pipeline
    renderer/            plain HTML/CSS/JS, no bundler
    scripts/             build-sidecar.sh, tests, smoke test

## Tests

    node scripts/test-lib.js        # wav writer, resampler, alignment, matching, roster
    node scripts/test-pipeline.js   # full refine flow against a mock engine
    npm run smoke                   # boots the UI headless, walks every view, screenshots
