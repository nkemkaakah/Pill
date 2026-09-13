#!/usr/bin/env bash
# One-time setup for Pill's local transcription + speaker engine.
# Builds the stock FluidAudio CLI (Apache-2.0) and drops the binary where Pill
# looks for it. Run this on your Mac from the pill folder:
#
#   bash scripts/build-sidecar.sh
#
# Needs Xcode command line tools (xcode-select --install). Takes a few minutes.
# The first recording you refine will additionally download the CoreML models
# from HuggingFace (one-off, a few hundred MB).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This engine is macOS-only (it runs on the Apple Neural Engine)." >&2
  exit 1
fi
command -v swift > /dev/null || { echo "Swift not found — run: xcode-select --install" >&2; exit 1; }

SRC=".sidecar-src"
CLI="$SRC/Sources/FluidAudioCLI/FluidAudioCLI.swift"
STREAM_DIR="$SRC/Sources/FluidAudioCLI/Commands/ASR/Parakeet/Streaming"

if [[ -d "$SRC/.git" ]]; then
  # Pill patches the vendored CLI (see below), so revert the one upstream file we
  # touch before pulling — otherwise --ff-only refuses and the patch silently rots.
  git -C "$SRC" checkout -- Sources/FluidAudioCLI/FluidAudioCLI.swift 2> /dev/null || true
  git -C "$SRC" pull --ff-only
else
  git clone --depth 1 https://github.com/FluidInference/FluidAudio.git "$SRC"
fi

# --- Pill's patch -----------------------------------------------------------
# Upstream's `parakeet-eou` reads a whole file and prints once, so live use would
# mean re-spawning per utterance and paying model load every time. `parakeet-stream`
# adds a stdin->NDJSON streaming mode on top of the same StreamingEouAsrManager.
# The source of truth is sidecar-patch/, which is version-controlled with Pill.
echo "Applying Pill's parakeet-stream patch…"
mkdir -p "$STREAM_DIR"
cp sidecar-patch/ParakeetStreamCommand.swift "$STREAM_DIR/ParakeetStreamCommand.swift"

if ! grep -q '"parakeet-stream"' "$CLI"; then
  python3 - "$CLI" <<'PY'
import sys
path = sys.argv[1]
src = open(path).read()
anchor = '        case "parakeet-eou":\n            await ParakeetEouCommand.main(Array(arguments.dropFirst(2)))\n'
if anchor not in src:
    sys.exit("build-sidecar: could not find the parakeet-eou case to patch after; upstream layout changed.")
src = src.replace(anchor, anchor + '        case "parakeet-stream":\n            await ParakeetStreamCommand.main(Array(arguments.dropFirst(2)))\n', 1)
open(path, 'w').write(src)
print("  registered parakeet-stream")
PY
else
  echo "  parakeet-stream already registered"
fi

echo "Building fluidaudiocli (release)…"
(cd "$SRC" && swift build -c release --product fluidaudiocli)

mkdir -p sidecar
BIN="$(cd "$SRC" && swift build -c release --product fluidaudiocli --show-bin-path)/fluidaudiocli"
cp "$BIN" sidecar/fluidaudiocli
chmod +x sidecar/fluidaudiocli

echo
echo "Done: sidecar/fluidaudiocli"
echo "  - 'npm start' and 'npm run pack' both pick it up automatically."
echo "  - Sanity check (downloads models on first run):"
echo "      ./sidecar/fluidaudiocli transcribe some-recording.wav --word-timestamps --output-json /tmp/t.json"
