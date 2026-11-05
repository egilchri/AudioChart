# A bay's railway tracks for Bird's-eye's live trains (v1116): OpenStreetMap → www/data/rail/<id>.json
#   python3 build_rail.py osm.json <id>
# osm.json: Overpass `way["railway"="rail"](s,w,n,e); out geom tags;` (send a User-Agent). Kept: the main lines,
# branches, and their sidings, crossovers and yards (the platform tracks at 4th & King are main); left out:
# industrial, military and tourist lines and spurs. Simplified to ~2 m, coordinates to ~0.1 m.
# OSM data © OpenStreetMap contributors (ODbL).
import json, math, sys
src, rid = sys.argv[1:3]
els = json.load(open(src))['elements']
def keep(t):
    u, s = t.get('usage'), t.get('service')
    if u in ('industrial', 'military', 'tourism', 'test'): return False
    if s == 'spur': return False
    return u in ('main', 'branch', None)
def xy(p, lat0): return ((p[0]) * 111320 * math.cos(math.radians(lat0)), p[1] * 111120)
def rdp(P, eps, lat0):
    if len(P) < 3: return P
    A, B = xy(P[0], lat0), xy(P[-1], lat0); dx, dy = B[0] - A[0], B[1] - A[1]; L = math.hypot(dx, dy) or 1e-9
    i, dm = 0, 0
    for k in range(1, len(P) - 1):
        X = xy(P[k], lat0); d = abs(dx * (A[1] - X[1]) - dy * (A[0] - X[0])) / L
        if d > dm: i, dm = k, d
    if dm <= eps: return [P[0], P[-1]]
    return rdp(P[:i + 1], eps, lat0)[:-1] + rdp(P[i:], eps, lat0)
lines = []
for e in els:
    if not keep(e.get('tags', {})): continue
    P = [[round(g['lon'], 6), round(g['lat'], 6)] for g in e.get('geometry', [])]
    if len(P) >= 2: lines.append(rdp(P, 2.0, P[0][1]))
json.dump({'id': rid, 'credit': 'Rail © OpenStreetMap contributors', 'lines': lines}, open(f'../../www/data/rail/{rid}.json', 'w'), separators=(',', ':'))
print(len(lines), 'lines', sum(len(l) for l in lines), 'points')
