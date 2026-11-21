# A building area's streets (v1193, asked riding an M5 bus: "recursively improve the various views of the bus. Like how
# the roads look"): OpenStreetMap's roads in the area's box, for bay3d.js to lay on the ground as asphalt, with their
# sidewalks and markings (streets3d.js). Bridges and tunnels are left out (the ground can't carry them), as are
# parking aisles, driveways, footways and paths.
#
#   python3 build_streets.py <building tile id> ...      (ids from ../../www/data/buildings/index.json)
#
# writes ../../www/data/streets/<id>.json:
#   { credit, ways: [{ p: [[lon, lat], ...], w: roadway width m, l: lanes, o: 1 if one-way, c: class, j: [[index of a
#     point that's a junction with another street, the widest other street's roadway width there], ...], n: name }] }
# A junction is where streets of different names meet (a street split in pieces along its length, and the driveways and
# service roads off it, aren't: no crosswalk mid-block).
import json, math, os, sys, time, urllib.parse, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
IDX = json.load(open(os.path.join(HERE, '..', '..', 'www', 'data', 'buildings', 'index.json')))
UA = {'User-Agent': 'AudioChart streets build (github.com/egilchri/AudioChart)'}
ROADS = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|busway|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|service'
# a class's lanes when OSM doesn't say, and whether it has parking along both kerbs (a city street's)
DEF = {'motorway': (3, 0), 'trunk': (3, 0), 'primary': (4, 1), 'secondary': (3, 1), 'tertiary': (2, 1), 'unclassified': (2, 1),
       'residential': (1, 1), 'living_street': (1, 0), 'busway': (2, 0), 'service': (1, 0)}

def fetch(q, tries=5):
    for k in range(tries):
        try:
            return json.loads(urllib.request.urlopen(urllib.request.Request('https://overpass-api.de/api/interpreter',
                urllib.parse.urlencode({'data': q}).encode(), UA), timeout=240).read())
        except Exception as e:
            print('  retry', k + 1, e); time.sleep(20 * (k + 1))
    raise SystemExit('Overpass failed')

for tid in sys.argv[1:]:
    t = next(x for x in IDX if x['file'] == tid + '.json'); W, S, E, N = t['bbox']
    M = 0.002   # (a little past the box: the junctions at its edge; each road kept whole, drawn by whichever area has its middle)
    J = fetch(f'[out:json][timeout:200];way["highway"~"^({ROADS})$"]({S - M},{W - M},{N + M},{E + M});out geom;')
    ways = [e for e in J['elements'] if e['type'] == 'way' and e.get('geometry')]
    def width(g):
        hw = g['highway'].replace('_link', ''); lanes0, park = DEF.get(hw, (1, 0))
        try: lanes = max(1, min(8, int(str(g.get('lanes', '')).split(';')[0])))
        except ValueError: lanes = lanes0
        oneway = g.get('oneway') in ('yes', '1', '-1') or hw in ('motorway',) or g.get('junction') == 'roundabout'
        if not oneway and 'lanes' not in g and hw in ('primary', 'secondary'): lanes = max(lanes, 4 if hw == 'primary' else 2)
        try: w = float(str(g.get('width', '')).replace('m', '').strip())
        except ValueError: w = 0
        if not (4 <= w <= 40): w = lanes * 3.2 + (4.6 if park else 0.8) + (0 if oneway or lanes < 2 else 0.4)
        if hw == 'service': w = min(w, 5.5)
        return w, lanes, oneway
    at = {}   # node -> {street key: its width}
    for e in ways:
        if e['tags']['highway'] == 'service': continue
        key = e['tags'].get('name') or e['tags'].get('ref') or e['id']
        for nd in e.get('nodes', []): d = at.setdefault(nd, {}); d[key] = max(d.get(key, 0), width(e['tags'])[0])
    out = []
    for e in ways:
        g, tg = e['tags'], e['geometry']
        hw = g['highway'].replace('_link', '')
        if g.get('bridge') not in (None, 'no') or g.get('tunnel') not in (None, 'no') or g.get('covered') == 'yes': continue
        if g.get('layer', '0') not in ('0', '') and not g.get('layer', '0').startswith('-0'): continue
        if hw == 'service' and (g.get('service') in ('parking_aisle', 'driveway', 'drive-through') or g.get('access') == 'private'): continue
        if g.get('area') == 'yes': continue
        mx = sum(p['lon'] for p in tg) / len(tg); my = sum(p['lat'] for p in tg) / len(tg)
        if not (W <= mx < E and S <= my < N): continue   # (its middle in this area: drawn once)
        w, lanes, oneway = width(g)
        nodes, key = e.get('nodes', []), g.get('name') or g.get('ref') or e['id']
        jx = []
        for i, nd in enumerate(nodes):
            other = [v for k, v in at.get(nd, {}).items() if k != key]
            if other: jx.append([i, round(max(other), 1)])
        rec = {'p': [[round(p['lon'], 6), round(p['lat'], 6)] for p in tg], 'w': round(w, 1), 'l': lanes, 'c': hw[:3]}
        if oneway: rec['o'] = 1
        if jx: rec['j'] = jx
        if g.get('name'): rec['n'] = g['name']
        out.append(rec)
    dst = os.path.join(HERE, '..', '..', 'www', 'data', 'streets', tid + '.json'); os.makedirs(os.path.dirname(dst), exist_ok=True)
    json.dump({'credit': 'Streets © OpenStreetMap contributors (ODbL)', 'ways': out}, open(dst, 'w'), separators=(',', ':'))
    print(tid, len(out), 'roads', round(os.path.getsize(dst) / 1024), 'KB'); time.sleep(5)
