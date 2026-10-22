import os, json, base64, urllib.request, concurrent.futures as cf
env = dict(l.strip().split('=',1) for l in open(os.path.join(os.path.dirname(__file__), '../../.env')) if '=' in l and not l.startswith('#'))
KEY = env['OPENAI_API_KEY'].strip('"')
BASE = ("Candid, realistic smartphone photo with a wide-angle lens, 4:3, taken from a phone on a high shelf about 1.7 m above the floor "
        "in the far corner of a small, cluttered Japanese apartment living room, looking down diagonally across the room toward a TV on a low TV stand "
        "about 4.5 meters away. A dining table with clutter is in the foreground. No text, no watermark. ")
SCENES = {
 "far_child_stand": "A 3-year-old child stands on the floor about 1 meter in front of the TV, watching it, seen from behind at an angle; the child looks small in the photo.",
 "far_child_sit": "A 4-year-old child sits on the floor about 1 meter in front of the TV, watching it; the child looks small in the photo.",
 "far_adult_sofa": "An adult sits on a black sofa to the side of the TV, and a 2-year-old toddler stands next to the TV; both look small in the photo.",
 "far_child_close": "A 3-year-old child stands right in front of the TV, almost touching the screen; the child looks small in the photo.",
}
def gen(name):
    os.makedirs(os.path.join(os.path.dirname(__file__), 'images/far'), exist_ok=True); os.chdir(os.path.join(os.path.dirname(__file__), 'images'))
    if os.path.exists(f'far/{name}.png'): return name+' cached'
    body = json.dumps({"model":"gpt-image-2.5-sunburst","prompt":BASE+SCENES[name],"size":"1536x1024","n":1}).encode()
    req = urllib.request.Request("https://api.openai.com/v1/images/generations", body, {"Authorization":"Bearer "+KEY,"Content-Type":"application/json"})
    try: r = json.load(urllib.request.urlopen(req, timeout=300))
    except urllib.error.HTTPError as e: return name+' ERR '+e.read().decode()[:300]
    open(f'far/{name}.png','wb').write(base64.b64decode(r['data'][0]['b64_json'])); return name+' ok'
with cf.ThreadPoolExecutor(4) as ex:
    for r in ex.map(gen, SCENES): print(r, flush=True)
