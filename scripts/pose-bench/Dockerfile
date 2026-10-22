FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libegl1 libgles2 && rm -rf /var/lib/apt/lists/* && pip install --no-cache-dir mediapipe opencv-python-headless numpy
