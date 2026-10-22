import cv2, numpy as np, glob, json, os
import mediapipe as mp
from mediapipe.tasks.python import vision, BaseOptions
SCALES=[0.5,0.4,0.33,0.27,0.22,0.18]
def mk(d,p):
    return vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path='/models/pose_landmarker_full.task'),
        running_mode=vision.RunningMode.IMAGE, num_poses=3,
        min_pose_detection_confidence=d, min_pose_presence_confidence=p, min_tracking_confidence=0.6))
cfg={'d7p7':mk(.7,.7),'d5p7':mk(.5,.7),'d5p5':mk(.5,.5)}
def scene(path,W,H):
    im=cv2.imread(path); h,w=im.shape[:2]; cw=int(h*4/3); x0=(w-cw)//2
    return cv2.resize(im[:,x0:x0+cw],(W,H),interpolation=cv2.INTER_AREA)
def at_scale(base,s):
    H,W=base.shape[:2]
    bg=cv2.GaussianBlur(base,(0,0),25*W/640)
    sw,sh=int(W*s),int(H*s); small=cv2.resize(base,(sw,sh),interpolation=cv2.INTER_AREA)
    out=bg.copy(); x=(W-sw)//2; y=H-sh-int((H-sh)*0.35)
    out[y:y+sh,x:x+sw]=small; return out,(x,y,sw,sh)
def det(lm,img):
    r=lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB,data=np.ascontiguousarray(cv2.cvtColor(img,cv2.COLOR_BGR2RGB))))
    return len(r.pose_landmarks)
def crop2x(img,box,zoom):
    H,W=img.shape[:2]; cw,ch=int(W/zoom),int(H/zoom)
    bx,by,bw,bh=box; cx=bx+bw//2; cy=by+bh//2
    x=min(max(0,cx-cw//2),W-cw); y=min(max(0,cy-ch//2),H-ch)
    return img[y:y+ch,x:x+cw]
tot={}
for p in sorted(glob.glob('images/near/*.png')):
    name=os.path.splitext(p)[0]
    b640=scene(p,640,480); b1280=scene(p,1280,960)
    for s in SCALES:
        i640,box=at_scale(b640,s); i1280,box2=at_scale(b1280,s)
        r={'img':name,'s':s}
        for k,lm in cfg.items():
            r[k]=det(lm,i640)
            r[k+'_z2_640']=det(lm,crop2x(i640,box,2))
            r[k+'_z2_1280']=det(lm,crop2x(i1280,box2,2))
            r[k+'_z3_1280']=det(lm,crop2x(i1280,box2,3))
        for k,v in r.items():
            if k not in('img','s'): tot.setdefault((k,s),0); tot[(k,s)]+=v>0
        print(json.dumps(r),flush=True)
print('SUMMARY detected images (of 8) by config x scale', SCALES)
for k in sorted({k for k,_ in tot}):
    print(f"{k:16s}", [tot[(k,s)] for s in SCALES])
