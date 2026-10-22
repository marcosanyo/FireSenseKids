"""Apache-2.0 alternatives to MediaPipe Pose (OpenMMLab via rtmlib, ONNX): do they find the child, with ankles?

  rtmo_s       one-stage multi-person pose (RTMO-s, 640)
  rtmo_m       RTMO-m
  yolox+rtmpose  person detector YOLOX + top-down RTMPose (rtmlib "Body", mode lightweight / balanced)

Build: docker build -t firesense-pose-rtm -f Dockerfile.rtm . (after Dockerfile.compare)
Usage (firesense-pose-rtm image): python eval_rtm.py images/shots/crops/*.png
Prints per frame: person box height (fraction of the frame), center x, and the ankle / hip / shoulder scores.
"""
import sys, os, cv2, numpy as np
from rtmlib import RTMO, Body

S = 'https://download.openmmlab.com/mmpose/v1/projects/rtmo/onnx_sdk/'
MODELS = {
    'rtmo_s': RTMO(S + 'rtmo-s_8xb32-600e_body7-640x640-dac2bf74_20231211.zip', model_input_size=(640, 640), backend='onnxruntime'),
    'rtmo_m': RTMO(S + 'rtmo-m_16xb16-600e_body7-640x640-39e78cc4_20231211.zip', model_input_size=(640, 640), backend='onnxruntime'),
    'yolox+rtmpose_light': Body(mode='lightweight', backend='onnxruntime'),
    'yolox+rtmpose_bal': Body(mode='balanced', backend='onnxruntime'),
}
os.makedirs('images/shots/out', exist_ok=True)
# COCO-17: 5/6 shoulders, 11/12 hips, 15/16 ankles
for f in sys.argv[1:]:
    name = os.path.splitext(os.path.basename(f))[0]
    img = cv2.imread(f); H, W = img.shape[:2]
    for key, m in MODELS.items():
        kpts, scores = m(img)
        desc = []
        vis = img.copy()
        for k, s in zip(kpts, scores):
            if np.mean(s) < 0.3:
                continue
            ys, xs = k[:, 1], k[:, 0]
            for (x, y), c in zip(k, s):
                if c > 0.3:
                    cv2.circle(vis, (int(x), int(y)), 3, (0, 255, 255), -1)
            desc.append(f'h={(ys.max() - ys.min()) / H:.2f}@x={xs.mean() / W:.2f} sh={min(s[5], s[6]):.2f} hip={min(s[11], s[12]):.2f} ank={max(s[15], s[16]):.2f}')
        cv2.imwrite(f'images/shots/out/{key}_{name}.jpg', vis)
        print(f'{name} {key:20s} {len(desc)}: ' + '; '.join(desc))
