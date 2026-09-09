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
if [[ -d "$SRC/.git" ]]; then
  git -C "$SRC" pull --ff-only
else
  git clone --depth 1 https://github.com/FluidInference/FluidAudio.git "$SRC"
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
