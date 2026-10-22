#!/usr/bin/env bash
# Installs (or reinstalls) the Fire TV APK on every connected adb device and launches it.
#
#   scripts/install-apk.sh              # all devices listed by `adb devices`
#   FIRETV_IP=192.168.1.20 scripts/install-apk.sh   # adb connect <ip>:5555 first (real Fire TV)
#
# - Waits for boot to complete (an emulator that was just started is fine).
# - On a signature mismatch (APK built with a different debug key) it uninstalls, then installs.
#   This deletes the app's data on that device (pairing is redone by scanning the QR again).
# - On emulators, disables adb-install verification, which otherwise can hang `pm install`.
set -euo pipefail
cd "$(dirname "$0")/.."

APK=firetv-app/app/build/outputs/apk/debug/app-debug.apk
PKG=com.firesense.kids.tv
ACTIVITY=com.firesense.kids.MainActivity

ADB=$(command -v adb || true)
[[ -z "$ADB" && -x "$HOME/Library/Android/sdk/platform-tools/adb" ]] && ADB="$HOME/Library/Android/sdk/platform-tools/adb"
[[ -n "$ADB" ]] || { echo "error: adb not found (install Android platform-tools)" >&2; exit 1; }
[[ -f "$APK" ]] || { echo "error: $APK not found. Run 'make apk' or 'make deploy' first." >&2; exit 1; }

if [[ -n "${FIRETV_IP:-}" ]]; then
  "$ADB" connect "${FIRETV_IP}:5555"
fi

DEVICES=$("$ADB" devices | awk 'NR>1 && $2=="device" {print $1}')
if [[ -z "$DEVICES" ]]; then
  echo "error: no adb device. Start the emulator (emulator -avd FireTV_1080p) or set FIRETV_IP." >&2
  exit 1
fi

install_on() {
  local serial=$1
  local adb=("$ADB" -s "$serial")
  echo "==> $serial"
  "${adb[@]}" wait-for-device
  for _ in $(seq 1 90); do
    [[ "$("${adb[@]}" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]] && break
    sleep 2
  done

  if [[ "$("${adb[@]}" shell getprop ro.kernel.qemu 2>/dev/null | tr -d '\r')" == "1" ]]; then
    "${adb[@]}" shell settings put global verifier_verify_adb_installs 0
    "${adb[@]}" shell settings put global package_verifier_enable 0
  fi

  "${adb[@]}" push "$APK" /data/local/tmp/firesense.apk >/dev/null
  local out
  out=$("${adb[@]}" shell pm install -r -t /data/local/tmp/firesense.apk 2>&1 | tr -d '\r')
  if [[ "$out" == *INSTALL_FAILED_UPDATE_INCOMPATIBLE* ]]; then
    echo "    signature differs from the installed build → uninstall and install"
    "${adb[@]}" uninstall "$PKG" >/dev/null
    out=$("${adb[@]}" shell pm install -t /data/local/tmp/firesense.apk 2>&1 | tr -d '\r')
  fi
  "${adb[@]}" shell rm -f /data/local/tmp/firesense.apk
  if [[ "$out" != *Success* ]]; then
    echo "error: install failed on $serial: $out" >&2
    return 1
  fi

  "${adb[@]}" shell am force-stop "$PKG"
  "${adb[@]}" shell am start -n "$PKG/$ACTIVITY" >/dev/null
  echo "    installed and launched $PKG"
}

status=0
for d in $DEVICES; do install_on "$d" || status=1; done
exit $status
