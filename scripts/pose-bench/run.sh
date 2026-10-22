#!/usr/bin/env bash
# Offline check: at what size does MediaPipe Pose (the same .task file as the phone) stop finding a
# person, and do 4× tiles around the TV find a small child? No phone or emulator needed.
# Images are generated (GPT Image, OPENAI_API_KEY in .env) into scripts/pose-bench/images/ (not committed).
set -euo pipefail
cd "$(dirname "$0")"
python3 gen_near.py
python3 gen_far.py
docker build -q -t firesense-pose-bench . >/dev/null
RUN=(docker run --rm -v "$PWD":/w -v "$PWD/../../public/mediapipe/models":/models:ro -w /w firesense-pose-bench python)
"${RUN[@]}" eval_size.py 2>&1 | sed -n '/SUMMARY/,$p'
"${RUN[@]}" eval_tiles.py 2>&1 | grep tiles
