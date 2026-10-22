"""Two-stage check: YOLO11n-pose finds people, then MediaPipe Pose (the phone's model) runs on a crop around
each box. Does MediaPipe then return landmarks (feet, shoulders, hips, world landmarks) for the child?

Usage (firesense-pose-cmp image): python eval_hybrid.py images/shots/crops/*.png
"""
import sys, os, cv2, numpy as np
import mediapipe as mp
from mediapipe.tasks.python import vision, BaseOptions
from ultralytics import YOLO

det = YOLO('/m/yolo11n-pose.pt')
lm = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
    base_options=BaseOptions(model_asset_path='/models/pose_landmarker_full.task'), running_mode=vision.RunningMode.IMAGE,
    num_poses=1, min_pose_detection_confidence=0.7, min_pose_presence_confidence=0.7))  # as on the phone

for f in sys.argv[1:]:
    name = os.path.splitext(os.path.basename(f))[0]
    bgr = cv2.imread(f); H, W = bgr.shape[:2]
    r = det.predict(bgr, imgsz=640, conf=0.5, verbose=False)[0]
    for (x0, y0, x1, y1), c in zip(r.boxes.xyxy.tolist(), r.boxes.conf.tolist()):
        # Square crop around the box with 30% margin, like the phone's follow crop.
        cx, cy, s = (x0 + x1) / 2, (y0 + y1) / 2, max(x1 - x0, y1 - y0) * 1.3
        a, b = int(max(0, cx - s / 2)), int(max(0, cy - s / 2))
        crop = bgr[b:int(min(H, cy + s / 2)), a:int(min(W, cx + s / 2))]
        crop = cv2.resize(crop, (512, int(512 * crop.shape[0] / crop.shape[1])), interpolation=cv2.INTER_LINEAR)
        res = lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))))
        if not res.pose_landmarks:
            print(f'{name} box h={(y1 - y0) / H:.2f} at x={(x0 + x1) / 2 / W:.2f} c={c:.2f} -> MediaPipe on crop: none')
            continue
        l = res.pose_landmarks[0]
        vis = lambda i: l[i].visibility
        print(f'{name} box h={(y1 - y0) / H:.2f} at x={(x0 + x1) / 2 / W:.2f} c={c:.2f} -> MediaPipe on crop: landmarks, '
              f'world={bool(res.pose_world_landmarks)}, shoulders {vis(11):.2f}/{vis(12):.2f} hips {vis(23):.2f}/{vis(24):.2f} '
              f'ankles {vis(27):.2f}/{vis(28):.2f}')
