#!/usr/bin/env bash
#
# Build the DETERMINISTIC DEMO debug APK that the Android e2e suite installs and drives.
#
#   1. Vite build with the demo seam ON (VITE_DEMO=1) and the automation-debug overlay forced OFF
#      (VITE_DEBUG_AUTOMATION=0) — the overlay intercepts pointer events and would block taps, and the
#      checked-in app/.env currently sets it to 1. Shell-provided VITE_* vars win over .env in Vite,
#      so we override it here without editing app/.env.
#   2. `cap sync android` to copy the web build into the Android project.
#   3. Gradle `assembleDebug` to produce android/app/build/outputs/apk/debug/app-debug.apk.
#
# The resulting APK is what e2e-android/wdio.conf.ts points `appium:app` at.
set -euo pipefail

# Resolve the app/ directory (this script lives in app/scripts/).
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

export VITE_DEMO=1
export VITE_DEBUG_AUTOMATION=0

echo "[android:demo:build] vite build (VITE_DEMO=1, VITE_DEBUG_AUTOMATION=0)…"
npm run build

echo "[android:demo:build] cap sync android…"
npx cap sync android

echo "[android:demo:build] gradle assembleDebug…"
( cd android && ./gradlew assembleDebug )

APK="$APP_DIR/android/app/build/outputs/apk/debug/app-debug.apk"
if [[ -f "$APK" ]]; then
  echo "[android:demo:build] OK → $APK"
else
  echo "[android:demo:build] ERROR: expected APK not found at $APK" >&2
  exit 1
fi
