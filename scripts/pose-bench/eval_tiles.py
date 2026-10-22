import cv2, numpy as np, math
import mediapipe as mp
from mediapipe.tasks.python import vision, BaseOptions
lm=vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(base_options=BaseOptions(model_asset_path='/models/pose_landmarker_full.task'), running_mode=vision.RunningMode.IMAGE, num_poses=2, min_pose_detection_confidence=0.7, min_pose_presence_confidence=0.7))  # as on the phone
# The TV and the floor in front of it: the generated scenes put them in the upper middle of the frame.
# On the phone this box comes from the TV-marker calibration (computeZoomRoi).
AREA={n:(0.2,0.05,0.85,0.6) for n in ('far_adult_sofa','far_child_close','far_child_sit','far_child_stand')}
def centers(lo,hi,t):
    span=hi-lo
    if span<=t: return [(lo+hi)/2]
    n=math.ceil((span-t)/(t*0.6))+1
    return [lo+t/2+(span-t)*i/(n-1) for i in range(n)]
for src in (1280,1920):
  for n,(x0,y0,x1,y1) in AREA.items():
    im=cv2.resize(cv2.imread(f'images/far/{n}.png'),(src,int(src/1.5)),interpolation=cv2.INTER_AREA); H,W=im.shape[:2]; t=0.25
    hits=[]; tiles=0
    for cy in centers(y0,y1,t):
      for cx in centers(x0,x1,t):
        tiles+=1
        x=int(min(1-t,max(0,cx-t/2))*W); y=int(min(1-t,max(0,cy-t/2))*H)
        crop=cv2.resize(im[y:y+int(t*H),x:x+int(t*W)],(640,427),interpolation=cv2.INTER_AREA if t*W>640 else cv2.INTER_LINEAR)
        r=lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB,data=np.ascontiguousarray(cv2.cvtColor(crop,cv2.COLOR_BGR2RGB))))
        for l in r.pose_landmarks:
            hits.append((round(cx,2),round(cy,2),round(x/W+ t*np.mean([p.x for p in l]),2),round(y/H+t*np.mean([p.y for p in l]),2)))
    full=lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB,data=np.ascontiguousarray(cv2.cvtColor(im,cv2.COLOR_BGR2RGB)))).pose_landmarks
    print(src,n,f'full frame: {len(full)} people | tiles={tiles}','people found at (frame x,y):',sorted({(h[2],h[3]) for h in hits}))
