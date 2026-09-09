# Pill

A small always-on-top capsule for your Mac. Click it, ask anything, get an answer (code included) streamed into a panel you can resize. It can take a screenshot of what you're looking at, keep a running transcript of your mic and whatever your Mac is playing (the other side of a call), and it stays out of screen shares and recordings.

Everything runs on your machine except the calls to the model provider you configure. Bring your own key. No server, no telemetry.

## Run it

Needs Node 18+.

```bash
cd pill
npm install
npm start
```

First launch opens settings. Pick a provider, paste the key, hit Save. Anthropic is the default: paste a Claude key and it uses `claude-sonnet-5` (fast) and `claude-opus-5` (smart). If you also want listening, add an OpenAI key underneath — transcription always goes through OpenAI because Anthropic has no speech-to-text. Then click **Grant mic + screen** and allow both. macOS ties the Screen Recording grant to the app binary, so **quit Pill (⌃⌥X) and start it again** after granting; screenshots come back empty until you do.

To build a proper `Pill.app`:

```bash
npm run pack   # dist/mac-arm64/Pill.app
```

The app is ad-hoc signed (no Apple developer cert). First open: right-click → Open. If macOS says it's damaged: `xattr -cr dist/mac-arm64/Pill.app`. Every rebuild is a "new app" to macOS, so you'll re-grant permissions after each `pack`.

## Using it

| Do this | Result |
|---|---|
| Click the pill | Expands into the panel. Esc collapses it. |
| Type, Enter | Asks. Shift+Enter for a new line. |
| Attach screenshot (toggle under the input) | Every question carries a fresh screenshot of the display the pill is on. The pill hides itself for ~140 ms so it's never in its own screenshot. |
| Mic button | Starts listening: your mic is the **me** channel, system audio (Zoom, Meet, YouTube…) is the **them** channel. The bars in the pill are the live level. |
| Answer what was asked | Reads the transcript, answers the last thing *them* asked, in words you can say. |
| Solve what's on screen | Screenshot → full solution with code and complexity. |
| What should I say? / Recap | Transcript-only actions. |
| Smart model toggle | Uses the smart model for that question instead of the fast one. |
| S / M / L | Preset panel sizes. You can also drag any edge; Pill remembers the custom size. |
| Eye | Toggles hidden-from-screen-share. Mint means hidden. |
| + | New chat. ⌘K does the same. |

Drag the pill by its capsule. It floats over fullscreen apps and follows you across Spaces. There's no dock icon; quit from settings or with ⌃⌥X.

### Global shortcuts (work from any app)

| Keys | Action |
|---|---|
| ⌃⌥Space | Show / hide |
| ⌃⌥↩ | Expand / collapse |
| ⌃⌥A | Open with screenshot attached, cursor in the input |
| ⌃⌥S | Solve what's on screen, right now |
| ⌃⌥L | Start / stop listening |
| ⌃⌥I | Toggle hidden from screen share |
| ⌃⌥ arrows | Nudge the pill 40 px |
| ⌃⌥X | Quit |

Control+Option combos were picked because almost no Mac app binds them, so Pill doesn't steal Save As / Send / Log Out. Change them in `main.js` → `registerShortcuts`. Settings → Shortcuts shows which ones another app already owns.

## The invisibility, honestly

Pill sets `setContentProtection(true)` on its window. On macOS that is `NSWindow.sharingType = .none`, on Windows `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`. It's the same flag Zoom uses to keep its own toolbar out of your share. Cluely does exactly this; there is no GPU trick.

What that buys you on a Mac today:

- **Google Meet / Teams / anything in Chrome, Slack huddles, Discord, QuickTime (legacy capture):** hidden.
- **Zoom:** hidden *if* Zoom → Settings → Share Screen → Advanced → Screen capture mode is set to **Advanced capture with window filtering**. The "without window filtering" mode grabs the raw display and will show Pill.
- **macOS 15+ apps using ScreenCaptureKit (newer Zoom builds, OBS, native `screencapture`):** the flag is ignored by Apple's design. There is no public API that beats this. The reliable move is to **share a single window instead of the whole screen**: Pill is its own window, so it's simply not in the stream. A second monitor works the same way.
- A phone pointed at your screen sees everything, obviously.

Test it yourself before you rely on it: start a call with a second account and share.

## Providers

**Anthropic (default).** Native Messages API: streaming, screenshots as base64 image blocks, `output_config.effort` mapped from the Effort setting (`lowest` and `low` both send `low`, which is what you want for a live overlay). Effort is only sent to models that accept it, so `claude-haiku-4-5` works too. Model IDs as of Sept 2026: `claude-haiku-4-5` ($1/$5 per MTok), `claude-sonnet-5` ($2/$10), `claude-opus-5` ($5/$25), `claude-fable-5-1` ($10/$50). Check the [models page](https://platform.claude.com/docs/en/about-claude/models/overview) when they move.

**OpenAI / OpenAI-compatible.** `/chat/completions` with SSE streaming. Defaults `gpt-5.6-luna` / `gpt-5.6-terra`.

**Local model instead.** Switch provider to OpenAI-compatible and point Base URL at Ollama:

```bash
ollama pull qwen2.5-coder:14b      # or any model that fits the M4 Air
ollama pull qwen2.5vl:7b           # if you want it to read screenshots
```

Settings → Base URL `http://localhost:11434/v1`, Fast model `qwen2.5vl:7b` (vision) or `qwen2.5-coder:14b` (text only). The key is ignored. Transcription still needs OpenAI (Ollama has no speech-to-text); turn **Transcribe audio** off if you want zero cloud calls.

## What it costs

A screenshot at 1600 px wide is roughly 1–2k input tokens, so a question with a screenshot on `claude-sonnet-5` is about half a cent; on `gpt-5.6-luna` a tenth of that. Transcription is `gpt-4o-mini-transcribe`; silent chunks are dropped before upload, so an hour of a normal call is cents, not pounds. Change models in settings, and check the [OpenAI model page](https://developers.openai.com/api/docs/models) if names have moved on.

## How it's built

```
main.js          window, invisibility flag, screenshots (desktopCapturer), system-audio loopback,
                 streaming chat, transcript, global shortcuts
lib/provider.js  fetch to Anthropic /v1/messages, OpenAI /chat/completions (both SSE) and /audio/transcriptions, no SDK
lib/prompts.js   system prompt, quick actions, transcript windowing
lib/config.js    ~/Library/Application Support/Pill/config.json
renderer/        plain HTML/CSS/JS, marked + DOMPurify + highlight.js, no bundler
renderer/audio.js  mic + loopback → 6-second webm/opus clips → main → transcription
```

Key pieces if you want to hack on it:

- **System audio on macOS** needs two Chromium features enabled before `app` is ready: `MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride`. Main answers the renderer's `getDisplayMedia` with `{ video: screen, audio: 'loopback' }`; the renderer throws the video track away.
- **Screenshots** hide the window for a beat before capture, because on macOS 15 ScreenCaptureKit would otherwise capture the pill itself.
- **History** keeps the last ~14 turns; images are stripped from older turns so you don't pay for them again.
- `npm run smoke` launches the app, walks pill → panel → settings, and drops PNGs in `smoke-out/`. Handy after UI changes.

## Troubleshooting

- **Screenshot comes back empty / "grant Screen Recording":** System Settings → Privacy & Security → Screen Recording → enable Pill (or Electron when running `npm start`). Quit and reopen.
- **Listening starts but nothing appears:** check the key isn't a restricted project key without audio access (403), and that Screen Recording is granted (system audio rides on it). Mic-only still works without it.
- **"bypass the system private window picker" alert:** macOS 15 shows this monthly for apps that capture without the picker. Allow for one month.
- **Cmd+V doesn't paste:** it should; Pill installs a hidden Edit menu for exactly this. If it doesn't, file it.
- **Other people are attributed to "me":** your speakers are leaking into the mic. Use headphones.

## Notes on use

This is a personal tool. Using a hidden assistant in a proctored exam, an interview, or a recorded meeting can break that platform's rules and, in some places, consent law. That's on you.
