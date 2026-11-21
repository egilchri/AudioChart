# A region's cliffs (v1191, asked of New York: "are you depicting the Palisades?"): OpenStreetMap's natural=cliff
# lines, for bay3d.js to steepen the ground along them and show their faces as rock (terrain3d.js cliffDem). USGS's
# 10 m elevation smooths the Palisades' 50-100 m wall of diabase into a 30-35 degree wooded slope.
#
#   python3 build_cliffs.py <region id> west,south,east,north
#
# writes ../../www/data/cliffs/<region id>.json: { credit, lines: [[[lon, lat], ...], ...] }
import json, math, os, sys, time, urllib.parse, urllib.request
rid, bbox = sys.argv[1:3]
W, S, E, N = map(float, bbox.split(','))
UA = {'User-Agent': 'AudioChart cliffs build (github.com/egilchri/AudioChart)'}
q = f'[out:json][timeout:120];way["natural"="cliff"]({S},{W},{N},{E});out geom tags;'
for k in range(4):
    try:
        J = json.loads(urllib.request.urlopen(urllib.request.Request('https://overpass-api.de/api/interpreter',
            urllib.parse.urlencode({'data': q}).encode(), UA), timeout=180).read()); break
    except Exception as e:
        print('retry', k + 1, e); time.sleep(20 * (k + 1))
else: raise SystemExit('Overpass failed')
lines = []
for e in J['elements']:
    g = [(round(p['lon'], 6), round(p['lat'], 6)) for p in e.get('geometry', [])]
    L = sum(math.hypot((a[0] - b[0]) * 111320 * math.cos(math.radians(a[1])), (a[1] - b[1]) * 111120) for a, b in zip(g, g[1:]))
    if len(g) >= 2 and L >= 25: lines.append(g)   # (a few metres of ledge isn't a cliff the 10 m ground can show)
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'www', 'data', 'cliffs', rid + '.json')
os.makedirs(os.path.dirname(out), exist_ok=True)
json.dump({'credit': 'Cliffs © OpenStreetMap contributors (ODbL)', 'lines': lines}, open(out, 'w'), separators=(',', ':'))
print(len(lines), 'cliffs,', round(sum(len(l) for l in lines)), 'points ->', out)
