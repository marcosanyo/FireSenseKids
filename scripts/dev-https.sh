#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# FireSense Kids — Local HTTPS Dev Bridge (Secure Context Helper)
# ==============================================================================
# Solves W3C Secure Context restriction on mobile browsers where
# navigator.mediaDevices.getUserMedia() is blocked over plain http://192.168.x.x
#
# Usage:
#   ./scripts/dev-https.sh [--tunnel | --mkcert | --help]
# ==============================================================================

PORT="${PORT:-3000}"
MODE="${1:---tunnel}"

echo "========================================================"
echo " 🔒 FireSense Kids — Local HTTPS Tunnel for Mobile CV"
echo " Target Local Server: http://localhost:${PORT}"
echo "========================================================"

if [[ "$MODE" == "--help" || "$MODE" == "-h" ]]; then
  echo "Options:"
  echo "  --tunnel  (Default) Uses Cloudflare Tunnel (cloudflared) for instant trusted HTTPS."
  echo "  --mkcert  Uses local mkcert + local-ssl-proxy for LAN-only TLS certificate."
  exit 0
fi

if [[ "$MODE" == "--tunnel" ]]; then
  if ! command -v cloudflared &>/dev/null; then
    echo "⚠️  'cloudflared' command not found."
    echo "    Installing via Homebrew on macOS (brew install cloudflared) or fallback..."
    if command -v brew &>/dev/null; then
      brew install cloudflared || true
    fi
  fi

  if command -v cloudflared &>/dev/null; then
    echo "🚀 Launching zero-config Cloudflare Quick Tunnel to http://localhost:${PORT}..."
    echo "👉 Look for the assigned https://*.trycloudflare.com URL below."
    echo "👉 Open that URL on your phone (/camera) to grant camera permissions."
    echo "========================================================"
    exec cloudflared tunnel --url "http://localhost:${PORT}"
  else
    echo "❌ cloudflared is not installed. You can install it via: brew install cloudflared"
    echo "   Or use ngrok: ngrok http ${PORT}"
    exit 1
  fi
fi

if [[ "$MODE" == "--mkcert" ]]; then
  echo "🛠️ Setting up local mkcert certificate..."
  if ! command -v mkcert &>/dev/null; then
    echo "❌ mkcert is required for LAN TLS. Install via: brew install mkcert"
    exit 1
  fi
  mkcert -install
  mkcert localhost 127.0.0.1 ::1 "$(ipconfig getifaddr en0 2>/dev/null || echo '')"
  echo "✅ Certificates created. Starting proxy on port 3443 -> ${PORT}..."
  npx local-ssl-proxy --source 3443 --target "${PORT}" --cert localhost.pem --key localhost-key.pem
fi
