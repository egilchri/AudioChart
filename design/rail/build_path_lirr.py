#!/usr/bin/env python3
"""PATH and the LIRR, for placing their live trains (v1160): their static GTFS to two small files the Birdseye relay
(relay/ais/core.mjs trimPath, trimLirr) fetches once and keeps.

  python3 design/rail/build_path_lirr.py <path gtfs dir> <lirr gtfs dir> www/data/rail

www/data/rail/path.json: PATH's feed (ridepath.json) gives only each station's next trains, in seconds, by line colour
and the station they're bound for. So each line's way to each end (its shape, its stations along it and the scheduled
run to each from the one before) is kept here, keyed "<colour>:<code of where she's bound>":
  {"stops": {"NWK": [lon, lat, "Newark"], ...}, "lines": {"D93A30:WTC": {"name": "Newark - World Trade Center",
   "p": [[lon, lat], ...], "s": [["NWK", metres along, seconds from the stop before], ...]}, ...}}
www/data/rail/lirr.json: the LIRR's feed has each train's place but not her branch: her trip's branch and where
she's bound, and the stations' names:
  {"routes": {"1": ["Babylon Branch", "00985F"], ...}, "trips": {"GO203_26_809": ["1", "Babylon"], ...}, "stops": {"349": "Penn Station"}}
"""
import csv, json, math, os, sys
from collections import Counter

pdir, ldir, out = sys.argv[1:4]
rd = lambda d, n: csv.DictReader(open(os.path.join(d, n), newline='', encoding='utf-8-sig'))

def metres(a, b):
    k = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((b[0] - a[0]) * 111320 * k, (b[1] - a[1]) * 110540)

def simplify(pts, tol=4.0):
    if len(pts) < 3: return pts
    k = math.cos(math.radians(pts[0][1])); xy = [(p[0] * 111320 * k, p[1] * 110540) for p in pts]
    keep = [False] * len(pts); keep[0] = keep[-1] = True; st = [(0, len(pts) - 1)]
    while st:
        i, j = st.pop(); (x1, y1), (x2, y2) = xy[i], xy[j]; dx, dy = x2 - x1, y2 - y1; L = math.hypot(dx, dy) or 1e-9; best, bi = -1, -1
        for m in range(i + 1, j):
            d = abs(dy * (xy[m][0] - x1) - dx * (xy[m][1] - y1)) / L
            if d > best: best, bi = d, m
        if best > tol: keep[bi] = True; st += [(i, bi), (bi, j)]
    return [p for p, f in zip(pts, keep) if f]

def project(p, pts, cum, i0):
    k = math.cos(math.radians(p[1])); best = (1e18, 0.0, i0)
    for i in range(i0, len(pts) - 1):
        ax, ay = pts[i][0] * 111320 * k, pts[i][1] * 110540; bx, by = pts[i + 1][0] * 111320 * k, pts[i + 1][1] * 110540
        px, py = p[0] * 111320 * k, p[1] * 110540; dx, dy = bx - ax, by - ay; L2 = dx * dx + dy * dy or 1e-9
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2)); d = math.hypot(ax + t * dx - px, ay + t * dy - py)
        if d < best[0]: best = (d, cum[i] + t * (cum[i + 1] - cum[i]), i)
    return best

secs = lambda t: (lambda h, m, s: h * 3600 + m * 60 + s)(*map(int, t.split(':')))

# ── PATH ──
CODE = {'Newark': 'NWK', 'Harrison': 'HAR', 'Journal Square': 'JSQ', 'Grove Street': 'GRV', 'Exchange Place': 'EXP',
        'World Trade Center': 'WTC', 'Newport': 'NEW', 'Hoboken': 'HOB', 'Christopher Street': 'CHR', '9th Street': '09S',
        '14th Street': '14S', '23rd Street': '23S', '33rd Street': '33S'}
stops, parent = {}, {}
for r in rd(pdir, 'stops.txt'):
    pid = r['parent_station'] or r['stop_id']; parent[r['stop_id']] = pid
    if not r['parent_station'] and r['stop_name'] in CODE: stops[pid] = (CODE[r['stop_name']], float(r['stop_lon']), float(r['stop_lat']), r['stop_name'])
routes = {r['route_id']: (r['route_color'].upper(), r['route_long_name']) for r in rd(pdir, 'routes.txt')}
shapes = {}
for r in rd(pdir, 'shapes.txt'): shapes.setdefault(r['shape_id'], []).append((int(r['shape_pt_sequence']), float(r['shape_pt_lon']), float(r['shape_pt_lat'])))
trips = {r['trip_id']: r for r in rd(pdir, 'trips.txt')}
seq = {}
for r in rd(pdir, 'stop_times.txt'): seq.setdefault(r['trip_id'], []).append((int(r['stop_sequence']), parent.get(r['stop_id'], r['stop_id']), r['arrival_time'] or r['departure_time']))
# per line and end: the commonest stop pattern among its trips (its run times the median of theirs)
pat = {}
for tid, st in seq.items():
    t = trips.get(tid); rt = t and routes.get(t['route_id'])
    if not rt or not t['shape_id'] in shapes: continue
    st.sort(); codes = tuple(stops[s][0] for _, s, _ in st if s in stops)
    if len(codes) < 2: continue
    key = f'{rt[0]}:{codes[-1]}'; times = [secs(a) for _, s, a in st if s in stops]
    pat.setdefault(key, {}).setdefault((codes, t['shape_id']), []).append([b - a for a, b in zip(times, times[1:])])
lines = {}
for key, opts in pat.items():
    (codes, sid), runs = max(opts.items(), key=lambda kv: len(kv[1]))
    med = [sorted(r[i] for r in runs)[len(runs) // 2] for i in range(len(codes) - 1)]
    pts = simplify([[round(lo, 6), round(la, 6)] for _, lo, la in sorted(shapes[sid])])
    cum = [0.0]
    for a, b in zip(pts, pts[1:]): cum.append(cum[-1] + metres(a, b))
    byc = {v[0]: v for v in stops.values()}; s_out, i0 = [], 0
    for i, c in enumerate(codes):
        off, d, i0 = project([byc[c][1], byc[c][2]], pts, cum, i0)
        s_out.append([c, round(d, 1), med[i - 1] if i else 0])
    color = key.split(':')[0]; name = next((n for col, n in routes.values() if col == color), '')
    lines[key] = {'name': name, 'p': pts, 's': s_out}
json.dump({'stops': {c: [round(lo, 6), round(la, 6), n] for c, lo, la, n in stops.values()}, 'lines': lines},
          open(os.path.join(out, 'path.json'), 'w'), separators=(',', ':'))
print('PATH:', len(lines), 'lines and ends:', ', '.join(f"{k} ({len(v['s'])} stops)" for k, v in sorted(lines.items())))

# ── LIRR ──
lr = {r['route_id']: [r['route_long_name'], r['route_color'].upper()] for r in rd(ldir, 'routes.txt')}
lt = {r['trip_id']: [r['route_id'], r['trip_headsign']] for r in rd(ldir, 'trips.txt')}
ls = {r['stop_id']: r['stop_name'] for r in rd(ldir, 'stops.txt')}
json.dump({'routes': lr, 'trips': lt, 'stops': ls}, open(os.path.join(out, 'lirr.json'), 'w'), separators=(',', ':'))
print('LIRR:', len(lr), 'branches,', len(lt), 'trips,', len(ls), 'stations;', os.path.getsize(os.path.join(out, 'lirr.json')) // 1024, 'KB')
