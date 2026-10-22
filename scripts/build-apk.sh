#!/usr/bin/env bash
# Builds the Fire TV APK in the Android SDK image (amd64: aapt2 has no arm64 Linux build).
# The debug keystore is persisted in a Docker volume so reinstalls keep the same signature.
set -euo pipefail
cd "$(dirname "$0")/../firetv-app"
docker run --rm --platform linux/amd64 \
  -v "$PWD":/p -w /p \
  -v firesense-gradle-amd64:/root/.gradle \
  -v firesense-android-keystore:/root/.android \
  ghcr.io/cirruslabs/android-sdk:35 \
  bash -lc "./gradlew --no-daemon -q ${GRADLE_TASK:-assembleDebug}"
ls -la app/build/outputs/apk/*/
