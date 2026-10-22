#!/usr/bin/env bash
# Preset and sample videos for the TV playlist (lib/client/playlists.ts): open-licensed films,
# checked against pinned SHA-256s, transcoded to AV1 (720p at most) + AAC with faststart, and uploaded
# to S3 media/. The web deploy (scripts/deploy.sh) leaves media/ alone. Run once, or after a change here.
#
# Why AV1: on the real Fire TV, frames from the hardware decoder (H.264, VP9 ≥ 360 lines) drawn into
# the page — which the blur needs — show green stripes; AV1 is decoded in software (dav1d) there, with
# no dropped frames at 720p even with the blur on.
#
#   Big Buck Bunny (2008), Caminandes: Llama Drama (2013), Caminandes 2: Gran Dillama (2013),
#   Caminandes 3: Llamigos (2016) — © Blender Foundation, CC BY 3.0. Spring (2019) — © Blender
#   Foundation, CC BY 4.0. To Spring (1936) — public domain (Wikimedia Commons).
#   WING IT! (2023), Coffee Run (2020), The Daily Dweebs (2017) — © Blender Foundation, CC BY 4.0.
#   Gulliver's Travels (1939, Fleischer Studios) — public domain (Wikimedia Commons).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
: "${AWS_REGION:=us-east-1}"
CACHE="$ROOT/.media-cache"
mkdir -p "$CACHE"
tf() { docker run --rm -i --env-file .env -e AWS_REGION="$AWS_REGION" -v "$ROOT":/repo -w /repo/infra/terraform hashicorp/terraform:1.9 "$@"; }
aws_cli() { docker run --rm -i --env-file .env -e AWS_REGION="$AWS_REGION" -v "$ROOT":/repo -w /repo amazon/aws-cli "$@"; }
COMMONS="https://upload.wikimedia.org/wikipedia/commons"

# output | source URL | sha256 of the download | file inside the zip ("-" = the download itself)
SOURCES=(
  "big-buck-bunny-720p-av1.mp4|https://download.blender.org/peach/bigbuckbunny_movies/big_buck_bunny_720p_h264.mov.zip|b0c9ade80b086179feee41514929de583966eec87c703575d97f051f88b33b67|big_buck_bunny_720p_h264.mov"
  "caminandes-2-gran-dillama-720p-av1.mp4|https://download.blender.org/demo/movies/caminandes_gran_dillama.mp4.zip|2e54abfb18dcb0a25d41e7b5d97fd51b226cec58d2fbcad101cf6deecea8c48b|caminandes_gran_dillama.mp4"
  "caminandes-1-llama-drama-720p-av1.mp4|$COMMONS/d/d0/Caminandes-_Llama_Drama_-_Short_Movie.ogv|4535b56f9e429a1b84e327b5fd752e53940ffb25741ddd012f2aee8dcbdfb0cb|-"
  "caminandes-3-llamigos-720p-av1.mp4|$COMMONS/a/ab/Caminandes_3_-_Llamigos_-_Blender_Animated_Short.webm|0fa2c62bc28e5f93ce6fed296efce050b22f0d5d57b568b2c2d4d5345685f1e7|-"
  "spring-720p-av1.mp4|$COMMONS/a/a5/Spring_-_Blender_Open_Movie.webm|d691a199035cc7d295210b286f8f6734893c7d4358d228081af6f0da98a56343|-"
  "wing-it-720p-av1.mp4|$COMMONS/3/38/WING_IT%21_-_Blender_Open_Movie-full_movie.webm|393df1098a0db66e5a6cee3678762e600f085317faaf36e56636bd7a54bcfc51|-"
  "coffee-run-720p-av1.mp4|$COMMONS/3/3f/Coffee_Run_-_Blender_Open_Movie-full_movie.webm|cd58fc73847d22e64fe7c1a3e5fb9de0c427282b11a79f83d121d8acbd9390c4|-"
  "daily-dweebs-720p-av1.mp4|$COMMONS/b/b2/The_Daily_Dweebs_-_Blender_Open_Movie-full_movie.webm|c68845fe300818a36a277afe6043820ccfc5b2306522e17773b8be2a1e8575d3|-"
  "gullivers-travels-1939-720p-av1.mp4|$COMMONS/b/bb/Gulliver%27s_Travels_%281939%29.webm|42c25080fbec2d016062e6f1df1844537d5060167843aeb27598a3176c6e24c2|-"
  "to-spring-1936-480p-av1.mp4|$COMMONS/transcoded/1/1d/To_Spring_%281936%29.webm/To_Spring_%281936%29.webm.480p.vp9.webm|22931016613c12543f64075cdc44cde0ee3dcd4c4ac62fcb84c7d73f917bb8e9|-"
)

for entry in "${SOURCES[@]}"; do
  IFS='|' read -r out url sha inner <<<"$entry"
  dl="$CACHE/$(basename "$url" | sed 's/%28/(/g;s/%29/)/g')"
  if [[ ! -f "$CACHE/$out" ]]; then
    [[ -f "$dl" ]] || curl -fL --retry 3 -A "firesense-kids media mirror" -o "$dl" "$url"
    echo "$sha  $dl" | shasum -a 256 -c - >/dev/null || { echo "error: checksum mismatch for $dl" >&2; exit 1; }
    src="$(basename "$dl")"
    if [[ "$inner" != "-" ]]; then
      unzip -oq "$dl" "$inner" -d "$CACHE"
      src="$inner"
    fi
    # At most 1280×720 (4:3 films too), never upscaled; even dimensions for 4:2:0.
    docker run --rm -v "$CACHE":/m lscr.io/linuxserver/ffmpeg:latest -y -loglevel error -i "/m/$src" \
      -vf "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:v libsvtav1 -preset 8 -crf 34 -g 120 -pix_fmt yuv420p \
      -c:a aac -b:a 128k -ac 2 -movflags +faststart "/m/$out"
    [[ "$inner" != "-" ]] && rm -f "$CACHE/$inner"
  fi
  echo "[upload-media] $out $(du -h "$CACHE/$out" | cut -f1)"
done

if [[ -n "${NO_UPLOAD:-}" ]]; then exit 0; fi
BUCKET=$(tf output -raw web_bucket)
DIST=$(tf output -raw cloudfront_distribution_id)
for entry in "${SOURCES[@]}"; do
  out="${entry%%|*}"
  aws_cli s3 cp "/repo/.media-cache/$out" "s3://$BUCKET/media/$out" --content-type video/mp4 --cache-control "public, max-age=31536000, immutable" --only-show-errors
done
aws_cli cloudfront create-invalidation --distribution-id "$DIST" --paths "/media/*" >/dev/null
echo "[upload-media] done → $(tf output -raw cloudfront_url)/media/"
