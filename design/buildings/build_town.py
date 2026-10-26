# One town, end to end (v1028): OSM footprints from Overpass, the NAIP image, the lidar from the EPT, then
# build_buildings.py. The steps the README lists, in one go, for a batch of towns (SF Bay, Piscataqua, New York):
#
#   python build_town.py <id> "<display name>" west,south,east,north <EPT project> [MAXH] [PALETTE] [DEPTH]
#
# writes ../../www/data/buildings/<id>.json; scratch files go in $WORK (default ./work/<id>). Add the town to
# index.json yourself. Run it with the venv's python (laspy[lazrs] numpy pillow).
import json, os, subprocess, sys, time, urllib.parse, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
tid, name, bbox, ept = sys.argv[1:5]
maxh = sys.argv[5] if len(sys.argv) > 5 else '30'
palette = sys.argv[6] if len(sys.argv) > 6 else 'maine'
depth = sys.argv[7] if len(sys.argv) > 7 else '9'
W, S, E, N = map(float, bbox.split(','))
work = os.environ.get('WORK') or os.path.join(HERE, 'work', tid); os.makedirs(work, exist_ok=True)
env = {**os.environ, 'BBOX': bbox, 'TOWN': name, 'EPT': ept, 'MAXH': maxh, 'PALETTE': palette}
UA = {'User-Agent': 'AudioChart building build (github.com/egilchri/AudioChart)'}

def fetch(url, data=None, tries=4):
    for k in range(tries):
        try: return urllib.request.urlopen(urllib.request.Request(url, data=data, headers=UA), timeout=240).read()
        except Exception as e:
            print('  retry', k + 1, e); time.sleep(20 * (k + 1))
    raise SystemExit('failed: ' + url)

osm = os.path.join(work, 'osm.json')
if not os.path.exists(osm):
    q = (f'[out:json][timeout:180];(way["building"]({S},{W},{N},{E});relation["building"]["type"="multipolygon"]({S},{W},{N},{E});'
         f'way["man_made"~"pier|breakwater"]({S},{W},{N},{E}););out geom tags;')
    srv = os.environ.get('OVERPASS_URL', 'https://overpass-api.de/api/interpreter')
    J = json.loads(fetch(srv, urllib.parse.urlencode({'data': q}).encode()))
    # a multipolygon building (how most of a city's big ones are mapped): each closed outer ring as a way of its own,
    # with the relation's tags (courtyards are left roofed over)
    els = [e for e in J['elements'] if e['type'] == 'way']
    for r in (e for e in J['elements'] if e['type'] == 'relation'):
        for k, m in enumerate(m for m in r.get('members', []) if m.get('role') == 'outer' and m.get('geometry')):
            if len(m['geometry']) >= 4 and m['geometry'][0] == m['geometry'][-1]:
                els.append({'type': 'way', 'id': f"r{r['id']}_{k}", 'tags': r.get('tags', {}), 'geometry': m['geometry']})
    json.dump({'elements': els}, open(osm, 'w'))
print('osm', len(json.load(open(osm))['elements']), 'ways')

naip = os.path.join(work, 'naip.jpg')
if not os.path.exists(naip):
    import math
    asp = (E - W) * math.cos(math.radians((S + N) / 2)) / (N - S)
    w, h = (4000, max(200, round(4000 / asp))) if asp >= 1 else (max(200, round(4000 * asp)), 4000)
    u = ('https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?' +
         urllib.parse.urlencode({'bbox': bbox, 'bboxSR': 4326, 'imageSR': 4326, 'size': f'{w},{h}', 'format': 'jpg', 'compressionQuality': 85, 'f': 'image'}))
    open(naip, 'wb').write(fetch(u))

eptj = os.path.join(work, 'ept.json')
if not os.path.exists(eptj): open(eptj, 'wb').write(fetch(f'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/{ept}/ept.json'))
nodes, pts = os.path.join(work, 'nodes.json'), os.path.join(work, 'pts.npy')
run = lambda *a: subprocess.run([sys.executable, *a], env=env, cwd=HERE, check=True)
if not os.path.exists(nodes): run('ept_hier.py', eptj, nodes)
if not os.path.exists(pts): run('ept_fetch.py', nodes, pts, depth)
run('build_buildings.py', osm, pts, naip, os.path.join(HERE, '..', '..', 'www', 'data', 'buildings', tid + '.json'))
