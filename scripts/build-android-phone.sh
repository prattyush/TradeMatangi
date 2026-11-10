#!/usr/bin/env bash
# Build the Android phone app (debug APK) from the repository root:
#   bash scripts/build-android-phone.sh [--release]
# Needs JDK 21, Node 22+, and the Android SDK (default ~/Android/Sdk). See mobile/README.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
# Keep Gradle's caches on the Linux filesystem (the repository may be on /mnt/d).
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.gradle}"

if [ ! -d "$ANDROID_HOME/platforms/android-36" ]; then
  echo "Android SDK platform 36 not found in $ANDROID_HOME (see mobile/README.md)" >&2
  exit 1
fi

cd "$REPO_ROOT/mobile"
[ -d node_modules ] || npm install --no-bin-links --no-audit --no-fund
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run
node node_modules/vite/bin/vite.js build
node node_modules/@capacitor/cli/bin/capacitor sync android
echo "sdk.dir=$ANDROID_HOME" > android/local.properties

cd android
VERSION_CODE="${VERSION_CODE:-$(date +%s)}"
if [ "${1:-}" = "--release" ]; then
  ./gradlew --no-daemon assembleRelease -PversionCode="$VERSION_CODE"
  echo "Release APK: $REPO_ROOT/mobile/android/app/build/outputs/apk/release/"
else
  ./gradlew --no-daemon assembleDebug -PversionCode="$VERSION_CODE"
  echo "Debug APK: $REPO_ROOT/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
fi
