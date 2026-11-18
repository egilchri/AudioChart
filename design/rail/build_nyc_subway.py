#!/usr/bin/env python3
"""New York's subway, for placing its live trains (v1154): the MTA's static GTFS (gtfs_subway.zip, unpacked) to
www/data/rail/nyc-subway.json, which the Birdseye relay (relay/ais/core.mjs trimNyct) fetches once and keeps.

The MTA's live feeds say only which station a train is stopped at or bound for, and when she's due at each stop
ahead; no position. So each route pattern's path (shapes.txt) and its stops along it (one trip's stop_times) are
kept here, and the relay puts her between her last stop and her next by the time she's due.

  python3 design/rail/build_nyc_subway.py <unpacked gtfs dir> www/data/rail/nyc-subway.json

Output: {"stops": {"127": [lon, lat, "Times Sq-42 St"], ...},
         "shapes": {"1..N03R": {"r": "1", "p": [[lon, lat], ...], "s": [["101", metres along], ...]}, ...}}
Paths are simplified to within 4 m (Douglas-Peucker), coordinates to 6 decimals.
"""
import csv, json, math, os, sys

src, out = sys.argv[1], sys.argv[2]
rd = lambda name: csv.DictReader(open(os.path.join(src, name), newline='', encoding='utf-8-sig'))

def metres(a, b):   # [lon, lat] pairs, small distances
    k = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((b[0] - a[0]) * 111320 * k, (b[1] - a[1]) * 110540)

def simplify(pts, tol=4.0):
    if len(pts) < 3: return pts
    lat0 = pts[0][1]; k = math.cos(math.radians(lat0))
    xy = [((p[0]) * 111320 * k, p[1] * 110540) for p in pts]
    keep = [False] * len(pts); keep[0] = keep[-1] = True; stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop(); (x1, y1), (x2, y2) = xy[i], xy[j]; dx, dy = x2 - x1, y2 - y1; L = math.hypot(dx, dy) or 1e-9
        best, bi = -1, -1
        for m in range(i + 1, j):
            d = abs(dy * (xy[m][0] - x1) - dx * (xy[m][1] - y1)) / L
            if d > best: best, bi = d, m
        if best > tol: keep[bi] = True; stack += [(i, bi), (bi, j)]
    return [p for p, k_ in zip(pts, keep) if k_]

stops, parent = {}, {}
for r in rd('stops.txt'):
    pid = r['parent_station'] or r['stop_id']; parent[r['stop_id']] = pid
    if not r['parent_station']: stops[r['stop_id']] = [round(float(r['stop_lon']), 6), round(float(r['stop_lat']), 6), r['stop_name']]

raw = {}
for r in rd('shapes.txt'): raw.setdefault(r['shape_id'], []).append((int(r['shape_pt_sequence']), float(r['shape_pt_lon']), float(r['shape_pt_lat'])))

# one trip per shape (its route), and the shapes' trips' stop sequences (the longest seen for the shape)
trip_shape, shape_route = {}, {}
for r in rd('trips.txt'):
    s = r['shape_id'] or r['trip_id'].split('_', 2)[-1]
    if s in raw: trip_shape[r['trip_id']] = s; shape_route.setdefault(s, r['route_id'])
seqs, cur, cur_id = {}, [], None
def flush():
    if cur_id in trip_shape:
        s = trip_shape[cur_id]; ids = [parent.get(x, x) for _, x in sorted(cur)]
        if len(ids) > len(seqs.get(s, [])): seqs[s] = ids
for r in rd('stop_times.txt'):
    if r['trip_id'] != cur_id: flush(); cur, cur_id = [], r['trip_id']
    cur.append((int(r['stop_sequence']), r['stop_id']))
flush()

def project(p, pts, cum, i0):
    """p's distance along the path from segment i0 on: (metres along, metres off) of the nearest point"""
    k = math.cos(math.radians(p[1])); best = (1e18, 0.0, i0)
    for i in range(i0, len(pts) - 1):
        ax, ay = pts[i][0] * 111320 * k, pts[i][1] * 110540; bx, by = pts[i + 1][0] * 111320 * k, pts[i + 1][1] * 110540
        px, py = p[0] * 111320 * k, p[1] * 110540; dx, dy = bx - ax, by - ay; L2 = dx * dx + dy * dy or 1e-9
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2)); d = math.hypot(ax + t * dx - px, ay + t * dy - py)
        if d < best[0]: best = (d, cum[i] + t * (cum[i + 1] - cum[i]), i)
    return best

shapes = {}
for sid, pts in raw.items():
    pts = simplify([[round(lon, 6), round(lat, 6)] for _, lon, lat in sorted(pts)])
    cum = [0.0]
    for a, b in zip(pts, pts[1:]): cum.append(cum[-1] + metres(a, b))
    # each stop's distance along the (simplified) path, never behind the previous stop's
    along, i0 = [], 0
    for st in seqs.get(sid, []):
        if st not in stops: continue
        off, d, i = project(stops[st], pts, cum, i0)
        if off > 400: continue   # (a stop the path doesn't pass: skipped)
        along.append([st, round(d, 1)]); i0 = i
    shapes[sid] = {'r': shape_route.get(sid, sid.split('.')[0]), 'p': pts, 's': along}

json.dump({'stops': stops, 'shapes': shapes}, open(out, 'w'), separators=(',', ':'))
n = sum(len(s['p']) for s in shapes.values())
print(f'{len(stops)} stations, {len(shapes)} paths, {n} points, {os.path.getsize(out) // 1024} KB; '
      f'{sum(1 for s in shapes.values() if len(s["s"]) < 2)} paths with under 2 stops')
