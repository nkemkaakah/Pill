#!/usr/bin/env bash
# Build, sign with the stable local identity, and install to /Applications.
#
#   npm run install-app                     rebuild + reinstall, keep existing permissions
#   npm run install-app -- --reset-perms    also wipe this app's permission records first
#
# Permissions carry over between builds because every build is signed with the same
# certificate (see make-signing-cert.sh). --reset-perms is for clearing stale records
# left behind by older ad-hoc-signed builds.
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="Nkemka's Notetaker"
BUNDLE_ID="dev.nkemka.pill"
IDENTITY="${SIGN_IDENTITY:-Nkemka Local Code Signing}"
BUILT="dist/mac-arm64/$APP_NAME.app"
DEST="/Applications/$APP_NAME.app"

# VS Code's terminal exports this; it turns Electron into plain Node and breaks the build.
unset ELECTRON_RUN_AS_NODE

bash scripts/make-signing-cert.sh

# Quit the running copy so the bundle can be replaced.
pkill -f "$APP_NAME.app/Contents/MacOS/" 2>/dev/null && sleep 1 || true

npx electron-builder --mac --arm64 --dir

# Inside-out signing with one identity: helpers, frameworks, then the app itself.
# The designated requirement then names the certificate, not a per-build hash.
codesign --force --deep --sign "$IDENTITY" "$BUILT"
codesign --verify --deep --strict "$BUILT"
echo "Designated requirement: $(codesign -dr - "$BUILT" 2>&1 | grep designated)"

if [[ "${1:-}" == "--reset-perms" ]]; then
  for svc in Microphone ScreenCapture AudioCapture; do
    tccutil reset "$svc" "$BUNDLE_ID" >/dev/null 2>&1 || true
  done
  echo "Cleared stored permissions for $BUNDLE_ID — the app will ask again."
fi

rm -rf "$DEST"
ditto "$BUILT" "$DEST"
# Drop the build copy so Spotlight / Launchpad show only the installed app.
rm -rf "$BUILT"
open "$DEST"
echo "Installed and launched $DEST"
