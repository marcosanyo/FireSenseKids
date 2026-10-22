#!/usr/bin/env bash
# End-to-end deploy (plan Phase 2/3): Lambda bundles → terraform apply → static export with the
# real endpoints → S3 + CloudFront → TV assets into the APK → debug APK.
# Runs every tool in Docker (node:22, hashicorp/terraform, amazon/aws-cli, Android SDK), so the
# host only needs Docker. AWS credentials are read from .env (AWS_ACCESS_KEY_ID/SECRET).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
: "${AWS_REGION:=us-east-1}"
[[ -f .env ]] || { echo "error: .env with AWS credentials is required" >&2; exit 1; }

node_run() { docker run --rm -i -v "$ROOT":/app -v firesense-nm:/app/node_modules -v firesense-npm-cache:/root/.npm -w /app -e NEXT_TELEMETRY_DISABLED=1 "$@"; }
tf() { docker run --rm -i --env-file .env -e AWS_REGION="$AWS_REGION" -v "$ROOT":/repo -w /repo/infra/terraform hashicorp/terraform:1.9 "$@"; }
aws_cli() { docker run --rm -i --env-file .env -e AWS_REGION="$AWS_REGION" -v "$ROOT":/repo -w /repo amazon/aws-cli "$@"; }

echo "==> 1/7 install + test + bundle Lambdas"
node_run node:22 bash -lc "npm ci --no-audit --no-fund >/dev/null && npx vitest run tests && node infra/lambda/build.mjs"

echo "==> 2/7 terraform apply"
tf init -input=false >/dev/null
tf apply -input=false ${TF_AUTO_APPROVE:+-auto-approve}

WS_URL=$(tf output -raw websocket_url)
API_URL=$(tf output -raw http_api_url)
WEB_ORIGIN=$(tf output -raw cloudfront_url)
BUCKET=$(tf output -raw web_bucket)
DIST=$(tf output -raw cloudfront_distribution_id)
echo "    WS=$WS_URL API=$API_URL WEB=$WEB_ORIGIN"

echo "==> 3/7 static export with real endpoints"
node_run -e NEXT_PUBLIC_WS_URL="$WS_URL" -e NEXT_PUBLIC_API_URL="$API_URL" -e NEXT_PUBLIC_WEB_ORIGIN="$WEB_ORIGIN" node:22 bash -lc "npm run build"

echo "==> 4/7 upload the static export to S3 + invalidate CloudFront"
# /tv and the sample video are served too, so the TV screen can be tried in a desktop browser
# (README "Try it in 5 minutes"). The APK still bundles its own copy (step 5).
# media/ holds the preset videos (scripts/upload-media.sh) and models/ the RTMO pose models
# (scripts/upload-models.sh); neither is part of the Next.js export.
aws_cli s3 sync out/ "s3://$BUCKET/" --delete --exclude "media/*" --exclude "models/*"
aws_cli cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" >/dev/null

echo "==> 5/7 bundle /tv into the APK"
bash scripts/package-tv-assets.sh

echo "==> 6/7 build the Fire TV APK"
bash scripts/build-apk.sh

echo "==> 7/7 install the APK on connected devices (emulator / Fire TV)"
# A TV left on the previous APK keeps sending the old message format, and the new Lambdas reject it
# (e.g. HTTP 400 "invalid daily summary" after T2). So a skipped or failed install is repeated at the end.
APK_WARNING=""
if [[ "${SKIP_INSTALL:-}" == "1" ]]; then
  echo "    skipped (SKIP_INSTALL=1)"
  APK_WARNING="APK NOT INSTALLED (SKIP_INSTALL=1)."
elif ! bash scripts/install-apk.sh; then
  APK_WARNING="APK NOT INSTALLED (no device, or install failed)."
fi

cat <<MSG

Deployed.
  TV in a browser:       $WEB_ORIGIN/tv/        (try it without a Fire TV)
  Phone (camera/parent): $WEB_ORIGIN/camera/   (normally opened from the TV's QR code)
  Example player:        $WEB_ORIGIN/examples/plain-video-player/
  WebSocket relay:       $WS_URL
  HTTP API:              $API_URL
  APK:                   firetv-app/app/build/outputs/apk/debug/app-debug.apk
Reinstall on devices:   make install-apk   (real Fire TV: FIRETV_IP=<ip> make install-apk)
MSG
if [[ -n "$APK_WARNING" ]]; then
  cat >&2 <<MSG

!!! $APK_WARNING
!!! Devices still run the previous TV build, which may not match the Lambdas just deployed.
!!! Run 'make install-apk' once the emulator / Fire TV is up (real Fire TV: FIRETV_IP=<ip> make install-apk).
MSG
fi
