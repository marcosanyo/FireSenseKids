"""Compare person/pose models on the same frames: which ones find the child?

  MediaPipe Pose full (what the phone runs) and heavy, MediaPipe EfficientDet-Lite2 (person boxes only),
  and Ultralytics YOLO11 n/s/m pose (COCO keypoints, trained on people of all ages and seen from any side).

Offline comparison only: Ultralytics YOLO is AGPL-3.0, so it is used here as a yardstick and is not shipped
in the app (MIT). Build: docker build -t firesense-pose-cmp -f Dockerfile.compare .
Usage (inside the firesense-pose-cmp image): python eval_models.py images/shots/crops/*.png
Writes images/shots/out/<model>_<name>.jpg with the detections drawn, and prints one line per model and frame.
"""
import sys, os, cv2, numpy as np
import mediapipe as mp
from mediapipe.tasks.python import vision, BaseOptions
from ultralytics import YOLO

os.makedirs('images/shots/out', exist_ok=True)

def mp_pose(path):
    lm = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=path), running_mode=vision.RunningMode.IMAGE,
        num_poses=3, min_pose_detection_confidence=0.5, min_pose_presence_confidence=0.5))
    def run(rgb):
        r = lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)))
        H, W = rgb.shape[:2]
        out = []
        for l in r.pose_landmarks:
            xs = [p.x * W for p in l]; ys = [p.y * H for p in l]
            out.append(((min(xs), min(ys), max(xs), max(ys)), None))
        return out
    return run

def mp_det(path):
    od = vision.ObjectDetector.create_from_options(vision.ObjectDetectorOptions(
        base_options=BaseOptions(model_asset_path=path), running_mode=vision.RunningMode.IMAGE,
        score_threshold=0.3, category_allowlist=['person']))
    def run(rgb):
        r = od.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)))
        return [((d.bounding_box.origin_x, d.bounding_box.origin_y, d.bounding_box.origin_x + d.bounding_box.width,
                  d.bounding_box.origin_y + d.bounding_box.height), d.categories[0].score) for d in r.detections]
    return run

def yolo(path, imgsz):
    m = YOLO(path)
    def run(rgb):
        r = m.predict(rgb[:, :, ::-1], imgsz=imgsz, conf=0.25, verbose=False)[0]
        out = []
        for b, c in zip(r.boxes.xyxy.tolist(), r.boxes.conf.tolist()):
            out.append((tuple(b), c))
        return out
    return run

MODELS = {
    'mp_full': mp_pose('/models/pose_landmarker_full.task'),
    'mp_heavy': mp_pose('/m/pose_landmarker_heavy.task'),
    'effdet2': mp_det('/m/efficientdet_lite2.tflite'),
    'yolo11n_640': yolo('/m/yolo11n-pose.pt', 640),
    'yolo11s_640': yolo('/m/yolo11s-pose.pt', 640),
    'yolo11m_640': yolo('/m/yolo11m-pose.pt', 640),
}

for f in sys.argv[1:]:
    name = os.path.splitext(os.path.basename(f))[0]
    bgr = cv2.imread(f); rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB); H, W = rgb.shape[:2]
    for key, run in MODELS.items():
        dets = run(rgb)
        vis = bgr.copy()
        desc = []
        for (x0, y0, x1, y1), c in dets:
            cv2.rectangle(vis, (int(x0), int(y0)), (int(x1), int(y1)), (0, 255, 255), 2)
            desc.append(f'h={(y1 - y0) / H:.2f}@({(x0 + x1) / 2 / W:.2f},{y1 / H:.2f})' + (f' c={c:.2f}' if c is not None else ''))
        cv2.imwrite(f'images/shots/out/{key}_{name}.jpg', vis)
        print(f'{name:8s} {key:12s} {len(dets)} people: ' + '; '.join(desc))
