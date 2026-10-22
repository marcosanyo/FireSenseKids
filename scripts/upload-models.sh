#!/usr/bin/env bash
# RTMO pose models (OpenMMLab mmpose, Apache-2.0) for the watch camera's optional RTMO estimator
# (lib/client/pose-estimator.ts). Downloads the official ONNX SDK zips, checks pinned SHA-256s, and uploads
# end2end.onnx to S3 models/ (served by CloudFront from our own origin, never a third-party CDN at runtime).
# They are too large for git (s 40 MB, m 89 MB, l 176 MB). The web deploy (scripts/deploy.sh) leaves models/
# alone. Run once, or after a change here.
#
# Training data note: RTMO's "body7" mix includes datasets with non-commercial terms (e.g. AI Challenger);
# fine for this hackathon demo, to be checked before any commercial use.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
: "${AWS_REGION:=us-east-1}"
CACHE="$ROOT/.model-cache"
mkdir -p "$CACHE"
tf() { docker run --rm -i --env-file .env -e AWS_REGION="$AWS_REGION" -v "$ROOT":/repo -w /repo/infra/terraform hashicorp/terraform:1.9 "$@"; }
aws_cli() { docker run --rm -i --env-file .env -e AWS_REGION="$AWS_REGION" -v "$ROOT":/repo -w /repo amazon/aws-cli "$@"; }
BASE="https://download.openmmlab.com/mmpose/v1/projects/rtmo/onnx_sdk"

# output | zip | sha256 of the zip
SOURCES=(
  "rtmo-s.onnx|rtmo-s_8xb32-600e_body7-640x640-dac2bf74_20231211.zip|3da7ad88b209f9da8be87ba5c325610639af04de3b5c8a96649b98cd9e2848a2"
  "rtmo-m.onnx|rtmo-m_16xb16-600e_body7-640x640-39e78cc4_20231211.zip|6b9d3be1323cc030444f731bbe593ea61f59b9481e23da2f8b60cb4b72136e16"
  "rtmo-l.onnx|rtmo-l_16xb16-600e_body7-640x640-b37118ce_20231211.zip|17b361174d759d974879f9fb46d564ae658d004bfa070e6f1c9ad275d3fd6b87"
)

for entry in "${SOURCES[@]}"; do
  IFS='|' read -r out zip sha <<<"$entry"
  if [[ ! -f "$CACHE/$out" ]]; then
    curl -fsSL "$BASE/$zip" -o "$CACHE/$zip"
    got=$(shasum -a 256 "$CACHE/$zip" | cut -d' ' -f1)
    if [[ "$got" != "$sha" ]]; then echo "error: $zip sha256 $got, expected $sha" >&2; exit 1; fi
    inner=$(unzip -Z1 "$CACHE/$zip" | grep 'end2end\.onnx$')
    unzip -p "$CACHE/$zip" "$inner" > "$CACHE/$out"
    rm "$CACHE/$zip"
  fi
  echo "[upload-models] $out $(du -h "$CACHE/$out" | cut -f1)"
done

if [[ -n "${NO_UPLOAD:-}" ]]; then exit 0; fi
BUCKET=$(tf output -raw web_bucket)
DIST=$(tf output -raw cloudfront_distribution_id)
for entry in "${SOURCES[@]}"; do
  out="${entry%%|*}"
  aws_cli s3 cp "/repo/.model-cache/$out" "s3://$BUCKET/models/$out" --content-type application/octet-stream --cache-control "public, max-age=31536000, immutable" --only-show-errors
done
aws_cli cloudfront create-invalidation --distribution-id "$DIST" --paths "/models/*" >/dev/null
echo "[upload-models] done → $(tf output -raw cloudfront_url)/models/"
