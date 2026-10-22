import os, sys, json, base64, urllib.request, concurrent.futures as cf
env = dict(l.strip().split('=',1) for l in open(os.path.join(os.path.dirname(__file__), '../../.env')) if '=' in l and not l.startswith('#'))
KEY = env['OPENAI_API_KEY'].strip('"')
BASE = ("Candid, realistic smartphone photo, taken from a phone standing on a low TV stand about 60 cm above the floor, "
        "looking straight into an ordinary Japanese apartment living room with a sofa, a low table, a rug and some toys; "
        "natural indoor lighting, slightly wide-angle lens, no text, no watermark. ")
SCENES = {
 "child4_stand_far": "A 4-year-old child stands on the rug about 3 meters away, full body visible head to feet, facing the camera, arms relaxed.",
 "child4_stand_mid": "A 4-year-old child stands about 2 meters away, full body visible head to feet, facing the camera, looking slightly up.",
 "child3_walk": "A 3-year-old toddler walks toward the camera about 2.5 meters away, full body visible, one foot forward.",
 "child5_sit_floor": "A 5-year-old child sits cross-legged on the floor about 2 meters away, facing the camera, whole body visible.",
 "child6_side": "A 6-year-old child stands about 2.5 meters away, turned three-quarters to the side, full body visible.",
 "child4_kneel": "A 4-year-old child kneels on the rug about 1.5 meters away, leaning forward toward the camera, whole body visible.",
 "two_kids": "Two children, ages 3 and 6, stand side by side about 2.5 meters away, full bodies visible, facing the camera.",
 "adult_stand_far": "An adult woman stands on the rug about 3 meters away, full body visible head to feet, facing the camera.",
}
def gen(name):
    os.makedirs(os.path.join(os.path.dirname(__file__), 'images/near'), exist_ok=True); os.chdir(os.path.join(os.path.dirname(__file__), 'images/near'))
    if os.path.exists(name+'.png'): return name+' cached'
    body = json.dumps({"model":"gpt-image-2.5-sunburst","prompt":BASE+SCENES[name],"size":"1536x1024","n":1}).encode()
    req = urllib.request.Request("https://api.openai.com/v1/images/generations", body, {"Authorization":"Bearer "+KEY,"Content-Type":"application/json"})
    try:
        r = json.load(urllib.request.urlopen(req, timeout=300))
    except urllib.error.HTTPError as e:
        return name+' ERR '+e.read().decode()[:300]
    open(name+'.png','wb').write(base64.b64decode(r['data'][0]['b64_json']))
    return name+' ok'
with cf.ThreadPoolExecutor(8) as ex:
    for r in ex.map(gen, SCENES): print(r, flush=True)
