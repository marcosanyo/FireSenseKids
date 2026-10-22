"""Hidden feet and sitting: does each pose model see the person, and does it say the feet are hidden?

Scenes from gen_nb.py --paired (images/nb2): the same person stands, stands with the legs hidden behind a box,
sits on the floor, sits on the floor behind a table, or sits on a chair, in the same room and camera.
For each model the main person (largest torso) is found, and its knee/ankle scores are compared with the truth
(feet visible or hidden). The app treats a foot point as seen at a score of 0.4 or more
(lib/firesense/floor-calibration.ts extractGroundContactPoint), and RTMO's heels take min(ankle, knee).

Writes images/nb2/keypoints.json (normalized COCO-17 of the main person per model; tests/hidden-sitting.test.ts
runs the app's own estimator on it) and images/nb2_out/<model>__<scene>.jpg.

Usage (firesense-pose-rtm image, same mounts as eval_nb.py):  python eval_hidden.py
"""
import json, os
import cv2, numpy as np
import mediapipe as mp
from mediapipe.tasks.python import vision, BaseOptions
from rtmlib import RTMO

IMG, OUT = "images/nb2", "images/nb2_out"
os.makedirs(OUT, exist_ok=True)
truth = json.load(open(f"{IMG}/truth.json"))["scenes"]
SH, HIP, KNEE, ANK = (5, 6), (11, 12), (13, 14), (15, 16)
BONES = [(5, 6), (5, 11), (6, 12), (11, 12), (5, 7), (7, 9), (6, 8), (8, 10), (11, 13), (13, 15), (12, 14), (14, 16), (0, 1), (1, 3), (0, 2), (2, 4)]
MP2COCO = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
SEEN = 0.4
# Scenes whose picture does not show what was asked for (checked by eye); listed, not scored.
EXCLUDE = {"adultC__sit_floor_hidden": "the legs are in view beside the table"}

mp_lm = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
    base_options=BaseOptions(model_asset_path="/models/pose_landmarker_full.task"), running_mode=vision.RunningMode.IMAGE,
    num_poses=3, min_pose_detection_confidence=0.7, min_pose_presence_confidence=0.7))


def run_mp(bgr):
    H, W = bgr.shape[:2]
    r = mp_lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))))
    return [(np.array([[l[i].x * W, l[i].y * H] for i in MP2COCO]), np.array([l[i].visibility for i in MP2COCO])) for l in r.pose_landmarks]


def rtmo(size):
    m = RTMO(f"/r/rtmo-{size}/end2end.onnx", model_input_size=(640, 640), score_thr=0.5, backend="onnxruntime")
    def run(bgr):
        k, s = m(bgr)
        return [(kk, ss) for kk, ss in zip(k, s) if ss.max() > 0]
    return run


MODELS = {"mediapipe_full": run_mp, "rtmo_s": rtmo("s"), "rtmo_m": rtmo("m"), "rtmo_l": rtmo("l")}


def main_person(people, H):
    best, size = None, 0.0
    for k, s in people:
        pts = [i for i in SH + HIP if s[i] >= 0.5]
        if len(pts) < 3:
            continue
        sh = k[[i for i in SH if s[i] >= 0.5]].mean(0)
        hp = k[[i for i in HIP if s[i] >= 0.5]].mean(0)
        t = float(np.linalg.norm(sh - hp)) / H
        if t >= 0.04 and t > size:
            best, size = (k, s), t
    return best


keypoints, rows = {}, {}
for name in truth:
    bgr = cv2.imread(f"{IMG}/{name}.png")
    H, W = bgr.shape[:2]
    keypoints[name] = {}
    rows[name] = {}
    for key, run in MODELS.items():
        p = main_person(run(bgr), H)
        if p is None:
            rows[name][key] = None
            continue
        k, s = p
        keypoints[name][key] = {"xy": [[float(x) / W, float(y) / H] for x, y in k], "s": [float(v) for v in s]}
        rows[name][key] = (float(max(s[i] for i in HIP)), float(max(s[i] for i in KNEE)), float(max(s[i] for i in ANK)))
        vis = bgr.copy()
        for a, b in BONES:
            if s[a] >= 0.5 and s[b] >= 0.5:
                cv2.line(vis, tuple(int(v) for v in k[a]), tuple(int(v) for v in k[b]), (0, 140, 255), 3)
        for i in range(5):
            if s[i] >= 0.5:
                cv2.circle(vis, tuple(int(v) for v in k[i]), 5, (0, 140, 255), -1)
        cv2.imwrite(f"{OUT}/{key}__{name}.jpg", vis)
json.dump(keypoints, open(f"{IMG}/keypoints.json", "w"))

print(f"{'scene':26s} feet  " + "  ".join(f"{k:>18s}" for k in MODELS) + "      (hip / knee / ankle scores; '-' = person not found)")
score = {k: [0, 0, 0] for k in MODELS}  # found, correct feet call, scenes
for name, t in truth.items():
    if name in EXCLUDE:
        print(f"{name:26s} (not scored: {EXCLUDE[name]})")
        continue
    cells = []
    for k in MODELS:
        r = rows[name][k]
        score[k][2] += 1
        if r is None:
            cells.append("-")
            continue
        score[k][0] += 1
        seen = r[2] >= SEEN
        score[k][1] += int(seen == t["feet_visible"])
        cells.append(f"{r[0]:.2f}/{r[1]:.2f}/{r[2]:.2f}{'' if seen == t['feet_visible'] else ' ✗'}")
    print(f"{name:26s} {'seen' if t['feet_visible'] else 'HIDE'}  " + "  ".join(f"{c:>18s}" for c in cells))
print("\nperson found / feet visible-or-hidden called correctly (of the scenes where the person was found):")
for k, (found, ok, n) in score.items():
    print(f"  {k:15s} found {found}/{n}, feet call correct {ok}/{found}")
