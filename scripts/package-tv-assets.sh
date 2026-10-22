#!/usr/bin/env bash
# Copies the Next.js static export needed by the TV screen into the APK assets.
# Only /tv, its JS/CSS chunks, and the video are bundled (no MediaPipe, no phone pages).
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=out
DEST=firetv-app/app/src/main/assets/web
if [[ ! -f "$OUT/tv/index.html" ]]; then
  echo "error: $OUT/tv/index.html not found. Run 'npm run build' with NEXT_PUBLIC_* set first." >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$OUT/tv" "$DEST/tv"
cp -R "$OUT/_next" "$DEST/_next"
cp -R "$OUT/videos" "$DEST/videos"
cp "$OUT/404.html" "$DEST/404.html"
echo "[package-tv-assets] $(du -sh "$DEST" | cut -f1) → $DEST"
