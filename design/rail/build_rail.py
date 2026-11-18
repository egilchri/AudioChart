# A bay's railway tracks for Bird's-eye's live trains (v1116): OpenStreetMap → www/data/rail/<id>.json
#   python3 build_rail.py osm.json <id> [--elev]   (--elev: the raised pieces' layers, for New York's els: v1155)
# osm.json: Overpass `way["railway"="rail"](s,w,n,e); out geom tags;` (send a User-Agent); Boston's (v1138) with
# `~"^(rail|subway|light_rail)$"` for the T. Kept: the main lines,
# branches, and their sidings, crossovers and yards (the platform tracks at 4th & King are main); left out:
# industrial, military and tourist lines and spurs. Simplified to ~2 m, coordinates to ~0.1 m. bridge, tunnel: the
# lines' indexes that are (v1125).
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
lines, bridge, tunnel, elev = [], [], [], []
for e in els:
    t = e.get('tags', {})
    if not keep(t): continue
    P = [[round(g['lon'], 6), round(g['lat'], 6)] for g in e.get('geometry', [])]
    if len(P) < 2: continue
    # (v1125) which are bridges (their decks drawn across between their ends, not on the water under them) and which
    # tunnels (not drawn; a train in one runs between its portals, under the ground)
    if t.get('bridge') and t.get('bridge') != 'no': bridge.append(len(lines))
    # (v1155) New York's elevated lines: a raised piece's layer (1 = an el over the street, 2 and 3 higher), so a chain
    # of them stands at an el's height on its steel, not run straight between its ends at the ground (track3d.js)
    if t.get('bridge') and t.get('bridge') != 'no':
        try: L = int(float(str(t.get('layer', '0')).split(';')[0]))
        except ValueError: L = 0
        if L >= 1: elev.append([len(lines), min(L, 4)])
    if t.get('tunnel') in ('yes', 'covered'): tunnel.append(len(lines))
    lines.append(rdp(P, 2.0, P[0][1]))
out = {'id': rid, 'credit': 'Rail © OpenStreetMap contributors', 'lines': lines, 'bridge': bridge, 'tunnel': tunnel}
if '--elev' in sys.argv: out['elev'] = elev   # (v1155: New York's, with --elev; the others' files as they were)
json.dump(out, open(f'../../www/data/rail/{rid}.json', 'w'), separators=(',', ':'))
print(len(lines), 'lines', sum(len(l) for l in lines), 'points')
