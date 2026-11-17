# A region's station platforms, as OpenStreetMap draws them, for Bird's-eye's stations (v1152):
#   python3 build_platforms.py osm.json <id>   → www/data/rail/<id>-platforms.json
# osm.json: Overpass, in the region's box:
#   ( nwr["public_transport"="platform"]; nwr["railway"="platform"]; ); out geom tags;
# Kept: rail, subway, light rail and tram platforms (ways; a multipolygon's outer rings), not bus stops. Each is
# { g: [[lon, lat], ...], c: 1 if an outline (closed), lv: its level (or layer), n: its name }; coordinates to ~0.1 m.
# Loaded only when a train stops at a station in Bird's-eye; the train's own track is then fitted to the platforms
# beside it (which side, how wide, how long, the other tracks between) in subway3d.js.
# OSM data © OpenStreetMap contributors (ODbL).
import json, sys
src, rid = sys.argv[1:3]
els = json.load(open(src))['elements']
def rail(t):
    if t.get('railway') in ('platform', 'platform_edge'): return True
    if any(t.get(k) == 'yes' for k in ('train', 'subway', 'light_rail', 'tram', 'monorail')): return True
    return False
def lv(t):
    for k in ('level', 'layer'):
        try: return float(str(t.get(k)).split(';')[0])
        except (TypeError, ValueError): pass
    return None
out = []
for e in els:
    t = e.get('tags', {})
    if not rail(t) or t.get('highway') == 'bus_stop' or (t.get('bus') == 'yes' and t.get('railway') != 'platform'): continue
    rings = [e.get('geometry') or []] if e['type'] == 'way' else [m.get('geometry') or [] for m in e.get('members', []) if m.get('role') in ('outer', '') and m.get('type') == 'way']
    for g in rings:
        P = [[round(p['lon'], 6), round(p['lat'], 6)] for p in g]
        if len(P) < 2: continue
        o = {'g': P, 'c': 1 if len(P) > 3 and P[0] == P[-1] else 0}
        if lv(t) is not None: o['lv'] = lv(t)
        if t.get('name'): o['n'] = t['name']
        out.append(o)
json.dump({'id': rid, 'credit': 'Platforms © OpenStreetMap contributors', 'plats': out}, open(f'../../www/data/rail/{rid}-platforms.json', 'w'), separators=(',', ':'))
print(len(out), 'platforms')
