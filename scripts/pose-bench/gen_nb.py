"""Test scenes for the pose models, generated with Nano Banana 2.1 on Vertex AI.

Authentication is the service account JSON in the repository root (hackathon-*.json, git-ignored), mounted
at /sa.json. No API key and no other provider is used. Run in the firesense-vertex image:

  docker build -t firesense-vertex -f Dockerfile.vertex .
  docker run --rm -v "$PWD":/w -w /w -v "$PWD/../../<service-account>.json":/sa.json:ro firesense-vertex python gen_nb.py [--paired]

  (default)  17 single scenes from the watch camera's viewpoint -> images/nb/      (eval_nb.py)
  --far      13 scenes at the distance of the family's own phone frames (the phone across the room, a
             standing child is 10-25 % of the image height)                       -> images/nb3/ (eval_nb.py images/nb3)
  --empty    8 rooms with nobody in them but things that look like people (plush toys, coats on hooks, cushions, a
             dress form, a coat stand): for false detections                       -> images/nb4/ (eval_nb.py images/nb4)
  --paired   rooms where the same child or adult stands, stands with the legs hidden, and sits, with the
             camera and room kept by editing the first image                      -> images/nb2/ (eval_hidden.py)

Images are not committed (generated people, large). truth.json next to them says who is in each scene.
"""
import base64, concurrent.futures as cf, io, json, os, sys, time

import google.auth.transport.requests as gtr
import requests
from google.oauth2 import service_account
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SA = "/sa.json"
MODEL = "gemini-nano-banana-2.1"  # exactly this model; nothing else is tried
PAIRED = "--paired" in sys.argv
FAR = "--far" in sys.argv
EMPTY = "--empty" in sys.argv
OUT = os.path.join(HERE, "images/nb2" if PAIRED else "images/nb3" if FAR else "images/nb4" if EMPTY else "images/nb")

_cred = service_account.Credentials.from_service_account_file(SA, scopes=["https://www.googleapis.com/auth/cloud-platform"])
_project = json.load(open(SA))["project_id"]
URL = f"https://aiplatform.googleapis.com/v1/projects/{_project}/locations/global/publishers/google/models/{MODEL}:generateContent"


def _token() -> str:
    if not _cred.valid:
        _cred.refresh(gtr.Request())
    return _cred.token


def generate(parts: list) -> bytes:
    """One Nano Banana 2.1 call; returns image bytes or raises with the service's message."""
    body = {"contents": [{"role": "user", "parts": parts}], "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "4:3"}}}
    # The same model is retried after a wait when the quota answers 429 (no other model or provider).
    for attempt in range(6):
        r = requests.post(URL, headers={"Authorization": "Bearer " + _token()}, json=body, timeout=300)
        if r.status_code != 429:
            break
        time.sleep(30 * (attempt + 1))
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:400]}")
    for part in r.json().get("candidates", [{}])[0].get("content", {}).get("parts", []):
        if "inlineData" in part:
            return base64.b64decode(part["inlineData"]["data"])
    raise RuntimeError("no image in the response: " + r.text[:400])


def save(name: str, data: bytes) -> None:
    im = Image.open(io.BytesIO(data)).convert("RGB")
    im.save(os.path.join(OUT, f"{name}.png"))
    im.save(os.path.join(OUT, f"{name}.jpg"), quality=95)  # the TS test decodes JPEG


VIEW = (
    "Candid, realistic smartphone photo, wide-angle lens, 4:3 landscape, from a phone standing on a shelf at the side "
    "of a lived-in Japanese apartment living room, about 1.3 m above the floor, looking diagonally down at a 43-inch TV "
    "on a low TV stand and the floor in front of it (light wood floor, a rug, a sofa, some toys). Natural, slightly "
    "imperfect phone-camera quality. No text, no watermark. "
)

# ---- default set: name: (scene, children, adults)
SCENES = {
    "toddler_back": ("A 2-year-old toddler stands about 1 m in front of the TV, watching it, back turned to the camera.", 1, 0),
    "toddler_touch": ("A 2-year-old toddler stands right at the TV, one hand touching the screen.", 1, 0),
    "child5_side": ("A 5-year-old child stands about 1.5 m from the TV, watching it, seen from the side.", 1, 0),
    "child_sit_floor": ("A 4-year-old child sits cross-legged on the floor about 1 m from the TV, watching it.", 1, 0),
    "child_sofa": ("A 4-year-old child sits on the sofa far from the TV, watching it, legs dangling.", 1, 0),
    "child_behind_table": ("A 3-year-old child stands behind a low coffee table about 1.2 m from the TV; the table hides the child's legs and feet.", 1, 0),
    "child_walking": ("A 4-year-old child walks toward the TV, mid-stride, about 1.8 m from it.", 1, 0),
    "child_lying": ("A 5-year-old child lies on the stomach on the rug about 1.2 m from the TV, chin in hands, watching.", 1, 0),
    "two_children": ("Two children, about 3 and 6 years old, stand side by side about 1 m in front of the TV, watching it.", 2, 0),
    "adult_child": ("An adult sits on the sofa looking at a phone, and a 3-year-old child stands about 0.8 m in front of the TV.", 1, 1),
    "adult_stand": ("An adult stands about 1 m in front of the TV, watching it, seen from behind at an angle.", 0, 1),
    "adult_close": ("An adult stands right in front of the TV, about 0.5 m from it, watching it.", 0, 1),
    "hidden_box": ("A 3-year-old child stands about 1 m in front of the TV directly behind a large cardboard box and a pile of cushions that completely hide the child's legs and feet from the camera; only the upper body is visible.", 1, 0),
    "hidden_sofa_back": ("A 4-year-old child stands behind the back of a sofa, between the sofa and the TV, watching the TV; the sofa back completely hides the child's legs and feet from the camera.", 1, 0),
    "hidden_table": ("A 3-year-old child stands right behind a coffee table piled high with laundry and toys, about 1.2 m from the TV; the child's legs and feet are completely hidden behind the table from the camera.", 1, 0),
    "dim_child": ("Evening, only a small lamp is on and the TV glows; a 4-year-old child stands about 1 m in front of the TV.", 1, 0),
    "far_child": ("The phone is in the far corner of the room, about 4 m from the TV; a 3-year-old child stands about 1 m in front of the TV and looks small in the photo.", 1, 0),
}

# ---- far set: like the family's own frames (phone across the room, cluttered table in the foreground)
def _far(meters: float, pct: str) -> str:
    return (
        "Candid, realistic smartphone photo with a wide-angle lens, 4:3, taken from a phone placed high on a shelf in the far "
        "corner of a small, cluttered Japanese apartment living room, about 1.7 m above the floor, looking down diagonally across "
        f"the room toward a TV on a low TV stand about {meters} meters away. A dining table with clutter is in the foreground, "
        "there are curtains, a black leather sofa and toys. Evening indoor light. "
        f"The people are small in the photo: a standing child's whole body is only about {pct} of the image height. No text, no watermark. "
    )


FAR_SCENES = {  # name: (distance label, scene, children, adults)
    "far_stand_child": ("far", "A 4-year-old child stands about 1 m in front of the TV, watching it, seen from behind at an angle, whole body visible.", 1, 0),
    "far_sit_floor_child": ("far", "A 4-year-old child sits cross-legged on the floor about 1 m in front of the TV, watching it.", 1, 0),
    "far_hidden_box_child": ("far", "A 3-year-old child stands about 1 m in front of the TV behind a large cardboard box and cushions that completely hide the child's legs and feet from the camera.", 1, 0),
    "far_sofa_child": ("far", "A 4-year-old child sits on the black leather sofa to the side of the TV, watching it, legs dangling.", 1, 0),
    "far_toddler_tv": ("far", "A 2-year-old toddler stands right at the TV, one hand on the screen.", 1, 0),
    "far_two_kids": ("far", "Two children, about 3 and 6 years old, stand side by side about 1 m in front of the TV, watching it.", 2, 0),
    "far_adult_stand": ("far", "An adult stands about 1 m in front of the TV, watching it, seen from behind at an angle.", 0, 1),
    "far_adult_sofa_child": ("far", "An adult sits on the black leather sofa looking at a phone, and a 2-year-old toddler stands next to the TV.", 1, 1),
    "mid_stand_child": ("mid", "A 4-year-old child stands about 1 m in front of the TV, watching it, seen from the side, whole body visible.", 1, 0),
    "mid_sit_floor_child": ("mid", "A 3-year-old child sits on the floor about 1 m in front of the TV, watching it.", 1, 0),
    "mid_hidden_table_child": ("mid", "A 3-year-old child stands right behind a low coffee table piled with laundry and toys, about 1.2 m from the TV; the table completely hides the child's legs and feet from the camera.", 1, 0),
    "mid_walking_child": ("mid", "A 4-year-old child walks toward the TV, mid-stride, about 1.5 m from it.", 1, 0),
    "mid_adult_child": ("mid", "An adult stands behind the sofa looking at the TV, and a 3-year-old child stands about 0.8 m in front of the TV.", 1, 1),
}
FAR_FRAMING = {"far": (4.5, "10-14 %"), "mid": (3.0, "20-25 %")}


def run_far(name: str) -> str:
    if os.path.exists(os.path.join(OUT, f"{name}.png")):
        return f"{name} cached"
    label, scene, _c, _a = FAR_SCENES[name]
    m, pct = FAR_FRAMING[label]
    try:
        save(name, generate([{"text": _far(m, pct) + scene}]))
    except Exception as e:
        return f"{name} ERR {e}"
    return f"{name} ok"


EMPTY_SCENES = {  # nobody is in these rooms
    "empty_plush": "Nobody is in the room. Several large plush toys (a bear, a rabbit) sit upright on the black leather sofa and on the floor.",
    "empty_coats": "Nobody is in the room. Coats and a school bag hang on a row of wall hooks near the TV, and a long coat hangs on a coat stand.",
    "empty_cushions": "Nobody is in the room. Cushions and a rolled blanket are piled on the sofa, and a big cushion leans against the TV stand.",
    "empty_dress_form": "Nobody is in the room. A tailor's dress form (torso mannequin) in a shirt stands next to the TV.",
    "empty_laundry": "Nobody is in the room. Laundry hangs on a drying rack near the window, a shirt and trousers hanging as if worn.",
    "empty_kid_toys": "Nobody is in the room. A child-size ride-on toy, a stroller and a toy tent stand near the TV, with stuffed animals in them.",
    "empty_chairs": "Nobody is in the room. A highchair and a small child's chair stand at the dining table, with a jacket over the back of each.",
    "empty_dim": "Nobody is in the room. Evening, only the TV glows; a coat on a chair and a floor lamp make odd shapes in the dim light.",
}


def run_empty(name: str) -> str:
    if os.path.exists(os.path.join(OUT, f"{name}.png")):
        return f"{name} cached"
    try:
        save(name, generate([{"text": _far(4.0, "10-14 %") + EMPTY_SCENES[name]}]))
    except Exception as e:
        return f"{name} ERR {e}"
    return f"{name} ok"


# ---- paired set: one base image per room, then edits that keep the room and the camera
ROOMS = {
    "childA": ("A 4-year-old child stands on the floor about 1.2 m in front of the TV, watching it, seen from the side; the whole body, feet included, is visible.", "child"),
    "childB": ("A 3-year-old child stands on the rug about 1 m in front of the TV, back turned to the camera; the whole body, feet included, is visible.", "child"),
    "adultC": ("An adult stands about 1.3 m in front of the TV, watching it, seen from the side; the whole body, feet included, is visible.", "adult"),
}
KEEP = "Edit this photo. Keep the room, the furniture, the TV, the lighting and the camera position and angle exactly as they are, and keep the person at the same spot on the floor. "
EDITS = {  # variant: (instruction, feet visible, posture)
    "stand": (None, True, "stand"),
    "stand_hidden": (KEEP + "Add a low wide cardboard box and some cushions directly in front of the person that completely hide the person's legs and feet from the camera; the person keeps standing. Change nothing else.", False, "stand"),
    "sit_floor": (KEEP + "The same person now sits cross-legged on the floor at that spot, watching the TV, legs and feet visible. Change nothing else.", True, "sit_floor"),
    "sit_floor_hidden": (KEEP + "The same person now sits on the floor at that spot behind a low coffee table that completely hides the person's legs and feet from the camera. Change nothing else.", False, "sit_floor"),
    "sit_chair": (KEEP + "The same person now sits on a chair at that spot (a dining chair, or a small child's chair for a child), watching the TV, with the feet visible. Change nothing else.", True, "sit_chair"),
}


def run_default(name: str) -> str:
    if os.path.exists(os.path.join(OUT, f"{name}.png")):
        return f"{name} cached"
    try:
        save(name, generate([{"text": VIEW + SCENES[name][0]}]))
    except Exception as e:  # shown as-is
        return f"{name} ERR {e}"
    return f"{name} ok"


def run_room(room: str) -> list:
    out = []
    scene, kind = ROOMS[room]
    base_path = os.path.join(OUT, f"{room}__stand.png")
    try:
        if not os.path.exists(base_path):
            save(f"{room}__stand", generate([{"text": VIEW + scene}]))
            out.append(f"{room}__stand ok")
        base = base64.b64encode(open(base_path, "rb").read()).decode()
    except Exception as e:
        return [f"{room}__stand ERR {e}"]
    for variant, (instruction, _feet, _posture) in EDITS.items():
        if instruction is None:
            continue
        name = f"{room}__{variant}"
        if os.path.exists(os.path.join(OUT, f"{name}.png")):
            out.append(f"{name} cached")
            continue
        try:
            save(name, generate([{"text": instruction}, {"inlineData": {"mimeType": "image/png", "data": base}}]))
            out.append(f"{name} ok")
        except Exception as e:
            out.append(f"{name} ERR {e}")
    return out


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    if EMPTY:
        json.dump({"model": MODEL, "scenes": {k: {"children": 0, "adults": 0} for k in EMPTY_SCENES}}, open(os.path.join(OUT, "truth.json"), "w"), indent=1)
        with cf.ThreadPoolExecutor(1) as ex:
            for line in ex.map(run_empty, EMPTY_SCENES):
                print(line, flush=True)
    elif FAR:
        json.dump({"model": MODEL, "scenes": {k: {"children": v[2], "adults": v[3], "distance": v[0]} for k, v in FAR_SCENES.items()}}, open(os.path.join(OUT, "truth.json"), "w"), indent=1)
        with cf.ThreadPoolExecutor(1) as ex:
            for line in ex.map(run_far, FAR_SCENES):
                print(line, flush=True)
    elif PAIRED:
        truth = {}
        for room, (_s, kind) in ROOMS.items():
            for variant, (_i, feet, posture) in EDITS.items():
                truth[f"{room}__{variant}"] = {"room": room, "kind": kind, "variant": variant, "feet_visible": feet, "posture": posture}
        json.dump({"model": MODEL, "scenes": truth}, open(os.path.join(OUT, "truth.json"), "w"), indent=1)
        with cf.ThreadPoolExecutor(1) as ex:  # one at a time: Vertex answers 429 under parallel load
            for lines in ex.map(run_room, ROOMS):
                print("\n".join(lines), flush=True)
    else:
        json.dump({"model": MODEL, "scenes": {k: {"children": v[1], "adults": v[2]} for k, v in SCENES.items()}}, open(os.path.join(OUT, "truth.json"), "w"), indent=1)
        with cf.ThreadPoolExecutor(4) as ex:
            for line in ex.map(run_default, SCENES):
                print(line, flush=True)
