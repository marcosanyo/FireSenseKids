"""Score the watch camera's pose models on the generated scenes (gen_nb.py): people found vs. who is there.

Models as on the phone: MediaPipe Pose Full (confidence 0.7, up to 3 people, full frame; the phone's zoomed
second pass is not included) and RTMO-s/m/l (person score 0.5, as lib/firesense/rtmo.ts).
A person counts when at least 3 of shoulders/hips are visible (score >= 0.5) and the torso is at least 4 % (MediaPipe)
or 3 % (RTMO) of the frame height (lib/firesense/person-filter.ts, lib/firesense/rtmo.ts); "feet" when an ankle is visible too (needed for distance).
Writes images/nb_out/<model>_<scene>.jpg (skeleton with face) and a sheet per model.

Usage (firesense-pose-rtm image, models in /models (MediaPipe) and /r (RTMO zips' end2end.onnx)):
  python eval_nb.py
"""
import glob, json, os, sys, time
import cv2, numpy as np
import mediapipe as mp
from mediapipe.tasks.python import vision, BaseOptions
from rtmlib import RTMO

IMG = (sys.argv[1] if len(sys.argv) > 1 else "images/nb").rstrip("/")  # e.g. images/nb3 for the far set
TAG = os.path.basename(IMG)
OUT = f"images/{TAG}_out"
os.makedirs(OUT, exist_ok=True)
truth = json.load(open(f"{IMG}/truth.json"))["scenes"]

# COCO-17 indices
SH, HIP, ANK = (5, 6), (11, 12), (15, 16)
BONES = [(5, 6), (5, 11), (6, 12), (11, 12), (5, 7), (7, 9), (6, 8), (8, 10), (11, 13), (13, 15), (12, 14), (14, 16), (0, 1), (1, 3), (0, 2), (2, 4)]
# MediaPipe 33 → COCO 17
MP2COCO = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]

mp_lm = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
    base_options=BaseOptions(model_asset_path="/models/pose_landmarker_full.task"), running_mode=vision.RunningMode.IMAGE,
    num_poses=3, min_pose_detection_confidence=0.7, min_pose_presence_confidence=0.7))


def run_mp(bgr):
    H, W = bgr.shape[:2]
    r = mp_lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))))
    out = []
    for l in r.pose_landmarks:
        k = np.array([[l[i].x * W, l[i].y * H] for i in MP2COCO])
        s = np.array([l[i].visibility for i in MP2COCO])
        out.append((k, s))
    return out


def run_mp_zoom(bgr):
    """MediaPipe as the watch camera runs it far from the TV: the full frame plus a scan in
    overlapping 4x tiles. The app scans only the watch zone it knows from the calibration; here the whole frame is
    scanned, which can only find more (and can add false detections)."""
    H, W = bgr.shape[:2]
    found = list(run_mp(bgr))
    t = 0.25
    step = t * 0.6
    n = int(np.ceil((1 - t) / step)) + 1
    for iy in range(n):
        for ix in range(n):
            x0 = int(min(1 - t, ix * step) * W)
            y0 = int(min(1 - t, iy * step) * H)
            w, h = int(t * W), int(t * H)
            crop = cv2.resize(bgr[y0:y0 + h, x0:x0 + w], (640, 427), interpolation=cv2.INTER_LINEAR)
            for k, s in run_mp(crop):
                found.append((k * np.array([w / 640, h / 427]) + np.array([x0, y0]), s))
    out = []  # drop the same person found twice (centers within 4 % of the frame width)
    for k, s in found:
        c = k[[5, 6, 11, 12]].mean(0)
        if all(np.linalg.norm(c - k2[[5, 6, 11, 12]].mean(0)) > 0.04 * W for k2, _ in out):
            out.append((k, s))
    return out


RTMO_ZIP = {"s": "rtmo-s", "m": "rtmo-m", "l": "rtmo-l"}
rtmo = {k: RTMO(f"/r/{v}/end2end.onnx", model_input_size=(640, 640), score_thr=0.5, backend="onnxruntime") for k, v in RTMO_ZIP.items()}


def run_rtmo(size):
    def f(bgr):
        k, s = rtmo[size](bgr)
        return [(kk, ss) for kk, ss in zip(k, s) if ss.max() > 0]
    return f


MODELS = {"mediapipe_full": run_mp, "mediapipe_zoom": run_mp_zoom, "rtmo_s": run_rtmo("s"), "rtmo_m": run_rtmo("m"), "rtmo_l": run_rtmo("l")}


def counts(people, H, min_torso):
    n, feet, heights = 0, 0, []
    for k, s in people:
        torso_pts = [i for i in SH + HIP if s[i] >= 0.5]
        if len(torso_pts) < 3:
            continue
        sh = k[[i for i in SH if s[i] >= 0.5]].mean(0) if any(s[i] >= 0.5 for i in SH) else None
        hp = k[[i for i in HIP if s[i] >= 0.5]].mean(0) if any(s[i] >= 0.5 for i in HIP) else None
        if sh is None or hp is None or np.linalg.norm(sh - hp) / H < min_torso:
            continue
        n += 1
        feet += int(max(s[i] for i in ANK) >= 0.5)
        ys = k[s >= 0.5][:, 1]
        heights.append(float(ys.max() - ys.min()) / H)  # head-to-lowest-visible-point, share of the frame height
    return n, feet, heights


rows = {}
for f in sorted(glob.glob(f"{IMG}/*.png")):
    name = os.path.splitext(os.path.basename(f))[0]
    bgr = cv2.imread(f)
    H = bgr.shape[0]
    t = truth[name]
    want = t["children"] + t["adults"]
    rows[name] = {"want": want}
    for key, run in MODELS.items():
        t0 = time.perf_counter()
        people = run(bgr)
        ms = (time.perf_counter() - t0) * 1000
        n, feet, heights = counts(people, H, 0.03 if key.startswith("rtmo") else 0.04)  # as in the app (RTMO_MIN_TORSO_FRACTION)
        rows[name][key] = (n, feet, ms)
        rows[name].setdefault("heights", []).extend(heights)
        vis = bgr.copy()
        for k, s in people:
            for a, b in BONES:
                if s[a] >= 0.5 and s[b] >= 0.5:
                    cv2.line(vis, tuple(int(v) for v in k[a]), tuple(int(v) for v in k[b]), (0, 140, 255), 3)
            for i in range(5):  # face
                if s[i] >= 0.5:
                    cv2.circle(vis, tuple(int(v) for v in k[i]), 5, (0, 140, 255), -1)
        cv2.putText(vis, f"{key} {n}/{want}", (10, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 255, 255), 3)
        cv2.imwrite(f"{OUT}/{key}_{name}.jpg", vis)

print(f"{'scene':20s} want " + " ".join(f"{k:>16s}" for k in MODELS))
tot = {k: [0, 0, 0, 0.0] for k in MODELS}
for name, r in rows.items():
    cells = []
    for k in MODELS:
        n, feet, ms = r[k]
        tot[k][0] += min(n, r["want"])
        tot[k][1] += max(0, n - r["want"])
        tot[k][2] += min(feet, r["want"])
        tot[k][3] += ms
        cells.append(f"{n}/{r['want']} feet{feet} {ms:5.0f}ms")
    print(f"{name:20s} {r['want']:4d} " + " ".join(f"{c:>16s}" for c in cells))
want_total = sum(r["want"] for r in rows.values())
print("found / extra / with feet / mean ms (CPU in Docker):")
for k, (found, extra, feet, ms) in tot.items():
    print(f"  {k:15s} {found}/{want_total} found, {extra} extra, {feet}/{want_total} with feet, {ms / len(rows):.0f} ms")

for key in MODELS:
    tiles = []
    for name in rows:
        im = cv2.resize(cv2.imread(f"{OUT}/{key}_{name}.jpg"), (400, 300))
        cv2.putText(im, name, (6, 290), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 0), 2)
        tiles.append(im)
    while len(tiles) % 4:
        tiles.append(np.zeros_like(tiles[0]))
    cv2.imwrite(f"images/{TAG}_sheet_{key}.jpg", np.vstack([np.hstack(tiles[i:i + 4]) for i in range(0, len(tiles), 4)]), [cv2.IMWRITE_JPEG_QUALITY, 80])

# Found rate by how large the people are in the frame (the largest skeleton any model drew in that scene).
bins = [(0.0, 0.08, "under 8 %"), (0.08, 0.15, "8-15 %"), (0.15, 0.25, "15-25 %"), (0.25, 1.01, "25 % and over")]
print("\nfound / expected people by size (share of the frame height of the largest skeleton in the scene; scenes where no model found anyone are 'none'):")
for lo, hi, label in bins + [(-1, -1, "none")]:
    names = [n for n, r in rows.items() if (max(r.get("heights", [0])) if r.get("heights") else -1) >= lo and (max(r["heights"]) if r.get("heights") else -1) < hi] if lo >= 0 else [n for n, r in rows.items() if not r.get("heights")]
    if not names:
        continue
    want = sum(rows[n]["want"] for n in names)
    print(f"  {label:14s} {len(names):2d} scenes, {want:2d} people: " + ", ".join(f"{k} {sum(min(rows[n][k][0], rows[n]['want']) for n in names)}" for k in MODELS))
