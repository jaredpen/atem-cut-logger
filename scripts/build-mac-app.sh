#!/bin/bash
# Builds "ATEM Cut Logger.app" on this Mac and puts it in Applications.
set -e
cd "$(dirname "$0")/.."

echo ""
echo "=== ATEM Cut Logger: building the Mac app ==="
echo ""

if ! command -v npm >/dev/null 2>&1; then
  # Finder-launched shells sometimes miss the Node path
  export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js isn't installed. Get the LTS installer from https://nodejs.org, install it, then run this again."
  read -n 1 -s -r -p "Press any key to close…"
  exit 1
fi

echo "1/3  Installing parts (first time takes a minute)…"
npm install --no-audit --no-fund

echo "2/3  Building the app…"
npx electron-builder --mac dir

APP=$(ls -d dist/mac*/"ATEM Cut Logger.app" 2>/dev/null | head -n 1)
if [ -z "$APP" ]; then
  echo "Build finished but the app wasn't found in ./dist — see the messages above."
  read -n 1 -s -r -p "Press any key to close…"
  exit 1
fi

# Ad-hoc sign so macOS (especially Apple Silicon) will run the locally built app.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "(codesign skipped)"

echo "3/3  Copying to Applications…"
DEST="/Applications"
if [ ! -w "$DEST" ]; then
  DEST="$HOME/Applications"
  mkdir -p "$DEST"
fi
rm -rf "$DEST/ATEM Cut Logger.app"
ditto "$APP" "$DEST/ATEM Cut Logger.app"

echo ""
echo "Done!  ATEM Cut Logger is in $DEST."
echo "Open it from Launchpad / Applications, and drag it to the Dock to keep it handy."
echo ""
open "$DEST/ATEM Cut Logger.app"
