#!/usr/bin/env bash
# Build a double-clickable macOS launcher that runs the local checkout with
# the Electron binary from node_modules. This is for this machine only and is
# NOT a distributable app: it depends on this directory and node_modules.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/Claude Notify Local.app"
TMP="$(mktemp /tmp/claude-notify-launcher.XXXXXX.applescript)"

if [[ ! -x "$ROOT/node_modules/.bin/electron" ]]; then
  echo "error: node_modules/.bin/electron not found; run pnpm install first" >&2
  exit 1
fi
if [[ ! -f "$ROOT/build/icon.icns" ]]; then
  echo "error: build/icon.icns not found" >&2
  exit 1
fi

cat > "$TMP" <<APPLESCRIPT
on run
  set projectDir to "$ROOT"
  do shell script "cd " & quoted form of projectDir & " && nohup /usr/bin/env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . > /tmp/claude-notify-local.log 2>&1 &"
end run
APPLESCRIPT

rm -rf "$APP"
osacompile -o "$APP" "$TMP"
rm -f "$TMP"

cp "$ROOT/build/icon.icns" "$APP/Contents/Resources/applet.icns"
/usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string applet.icns" "$APP/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleName 'Claude Notify Local'" "$APP/Contents/Info.plist" 2>/dev/null || true
touch "$APP"

echo "created: $APP"
echo "double-click it, or run: open \"$APP\""
