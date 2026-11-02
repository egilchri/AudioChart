# An airport's ground for Bird's-eye (v1111): OpenStreetMap's aeroways → www/data/airports/<id>.json
#   python3 build_airport.py osm.json <id> "<name>" [magnetic variation, ° east]
# osm.json: Overpass `way/node["aeroway"]` + `way["man_made"~"tower|pier"]` + `way["railway"="monorail"]` in the
# airport's box, `out geom tags` (send a User-Agent). Coordinates rounded to ~0.1 m. OSM data © OpenStreetMap
# contributors (ODbL).
import json, math, sys
src, aid, name = sys.argv[1:4]; VAR = float(sys.argv[4]) if len(sys.argv) > 4 else 13.5
els = json.load(open(src))['elements']
R = lambda v: round(v, 6)
pts = lambda e: [[R(g['lon']), R(g['lat'])] for g in e.get('geometry', [])]
def m(a, b):   # metres between [lon, lat]s
    k = math.cos(math.radians(a[1])); return math.hypot((b[0] - a[0]) * 111320 * k, (b[1] - a[1]) * 111120)
def brg(a, b):
    k = math.cos(math.radians(a[1])); return math.degrees(math.atan2((b[0] - a[0]) * k, b[1] - a[1])) % 360
out = {'id': aid, 'name': name, 'credit': 'Airport © OpenStreetMap contributors', 'runways': [], 'stopways': [], 'taxiways': [], 'aprons': [],
       'jetBridges': [], 'holds': [], 'lightPiers': [], 'otherPiers': [], 'airtrain': [], 'helipads': [], 'tower': None, 'windsocks': []}
# runways: each one's pieces merged into her two ends; the end whose number she's called by first (10L of 10L/28R)
# is the one she takes off from heading that way (her number ×10, magnetic)
rw = {}
for e in els:
    t = e.get('tags', {})
    if t.get('aeroway') == 'runway': rw.setdefault(t.get('ref', '?'), {'w': float(t.get('width', 45)), 'p': []})['p'] += pts(e)
for ref, r in rw.items():
    P = r['p']; a, b = max(((p, q) for p in P for q in P), key=lambda pq: m(*pq))
    n1 = int(''.join(c for c in ref.split('/')[0] if c.isdigit()))
    head = (n1 * 10 + VAR) % 360
    if abs(((brg(a, b) - head) + 180) % 360 - 180) > 90: a, b = b, a
    names = [s.lstrip('0') or '0' for s in ref.split('/')]
    out['runways'].append({'ref': ref, 'ends': [a, b], 'names': names, 'width': r['w'], 'length': round(m(a, b))})
for e in els:
    t = e.get('tags', {}); a = t.get('aeroway'); P = pts(e)
    closed = len(P) > 2 and P[0] == P[-1]
    if a == 'stopway' and len(P) >= 2: out['stopways'].append({'pts': P, 'width': float(t.get('width', 45))})
    elif a in ('taxiway', 'taxilane') and len(P) >= 2: out['taxiways'].append({'pts': P, 'width': float(t.get('width', 23 if a == 'taxiway' else 15)), 'ref': t.get('ref', '')})
    elif a == 'apron' and closed: out['aprons'].append(P)
    elif a == 'jet_bridge' and len(P) >= 2: out['jetBridges'].append(P)
    elif a == 'holding_position' and len(P) >= 2 and e['type'] == 'way': out['holds'].append(P)
    elif a == 'helipad' and closed: out['helipads'].append(P)
    elif a == 'windsock' and e['type'] == 'node': out['windsocks'].append([R(e['lon']), R(e['lat'])])
    elif a == 'tower' and closed and t.get('height'):
        c = [sum(p[0] for p in P[:-1]) / (len(P) - 1), sum(p[1] for p in P[:-1]) / (len(P) - 1)]
        out['tower'] = {'at': [R(c[0]), R(c[1])], 'height': float(t['height']), 'name': t.get('name', ''), 'r': round(max(m(c, p) for p in P), 1)}
    elif t.get('man_made') == 'pier' and len(P) >= 2:
        (out['lightPiers'] if 'light' in t.get('name', '').lower() else out['otherPiers']).append({'pts': P, 'name': t.get('name', ''), 'closed': closed})
    elif t.get('railway') == 'monorail' and len(P) >= 2: out['airtrain'].append({'pts': P, 'layer': int(t.get('layer', '0') or 0)})
json.dump(out, open(f'../../www/data/airports/{aid}.json', 'w'), separators=(',', ':'))
print({k: (len(v) if isinstance(v, list) else v) for k, v in out.items() if k not in ('credit',)})
for r in out['runways']: print(r['ref'], r['names'], r['length'], 'm', 'heading', round(brg(*r['ends'])))
