#!/usr/bin/env python3
"""C&J's New York route for Bird's-eye (v1183): www/data/buses/nyc-cj.json.

C&J (ridecj.com) runs non-stop coaches Dover/Portsmouth/Seabrook NH <-> the Port Authority Bus Terminal (Gate 36).
They don't publish their road. Inferred: down I-95 into the Bronx, the Cross Bronx, the George Washington Bridge,
I-95 and NJ 495 down through New Jersey, the Lincoln Tunnel into the terminal. The way Peter Pan's Boston-New York
express is drawn in its own GTFS (2024, data.trilliumtransit.com peterpan-ma-us, shape p_1425294): the terminal's
bus ramps join the tunnel. Change WAYPOINTS if the real one turns out otherwise.

Input: an Overpass answer, roads.json, for
  [out:json];(way[highway~"^(motorway|motorway_link|trunk|trunk_link|primary)$"](40.745,-74.06,41.0,-73.65););out body;>;out skel qt;
Usage: python3 build_cj.py roads.json ../../www/data/buses/nyc-cj.json
"""
import json, sys, math, heapq

# (lon, lat) the route must pass, in order, southbound; northbound is its own search the other way
# (each on a road of its kind: 'I 95' on the interstate itself, 'link' a ramp; the Bronx and Westchester waypoints had
# found Main Street in New Rochelle and the Boston Post Road)
# (only the GWB between: with the parkways barred, the shortest way down is I-95's own; a waypoint in New Rochelle had
# caught the other carriageway, and the route went off and back for it)
SB = [(-73.6705, 40.9985, 'I 95'), (-73.9527, 40.8517, 'I 95'), (-74.0230, 40.7660, 'NJ 495'), (-73.9992, 40.7589, 'NY 495')]
NB = [(-73.9992, 40.7589, 'NY 495'), (-74.0230, 40.7660, 'NJ 495'), (-73.9527, 40.8517, 'I 95'), (-73.6705, 40.9985, 'I 95')]
# the terminal: its ramps from the tunnel's mouth over Dyer Avenue and Ninth Avenue (not among the roads asked for:
# drawn straight), and Gate 36 at its south end
RAMP = [(-73.9962, 40.7580), (-73.9935, 40.7572), (-73.9907, 40.7566)]
# buses kept off New York's parkways (a ban on commercial vehicles; low bridges) and the drives
BANNED = ('Parkway', 'Harlem River Drive', 'FDR Drive', 'Henry Hudson', 'Palisades Interstate')

def dist(a, b):
    return math.hypot((a[0] - b[0]) * 84300, (a[1] - b[1]) * 111200)

def main(src, out):
    J = json.load(open(src)); el = J['elements']
    N = {e['id']: (e['lon'], e['lat']) for e in el if e['type'] == 'node'}
    G = {}; flag = {}; refs = {}
    for w in (e for e in el if e['type'] == 'way'):
        t = w.get('tags', {}); name = t.get('name', '') + ' ' + t.get('ref', '')
        if any(b in name for b in BANNED): continue
        hw = t.get('highway', '')
        ow = t.get('oneway', 'yes' if hw.startswith('motorway') else 'no')
        f = 1 if t.get('tunnel') in ('yes', 'building_passage') else 2 if t.get('bridge') == 'yes' else 0
        cost = 1.0 if hw.startswith('motorway') or hw.startswith('trunk') else 2.5   # (highways first)
        nd = w['nodes']
        for n in nd: refs[n] = refs.get(n, '') + ';' + t.get('ref', '')
        for a, b in zip(nd, nd[1:]):
            if a not in N or b not in N: continue
            d = dist(N[a], N[b]) * cost
            if ow != '-1': G.setdefault(a, []).append((b, d)); flag[(a, b)] = f
            if ow in ('no', '-1'): G.setdefault(b, []).append((a, d)); flag[(b, a)] = f
    nodes = list(G)
    def nearest(p, k=40):
        want = p[2]; cand = [n for n in nodes if want in refs.get(n, '')]
        return sorted(cand, key=lambda n: dist(N[n], p))[:k]
    def path(s, t):
        D = {s: 0}; P = {}; q = [(0, s)]
        while q:
            d, u = heapq.heappop(q)
            if u == t: break
            if d > D[u]: continue
            for v, c in G.get(u, []):
                if d + c < D.get(v, 1e18): D[v] = d + c; P[v] = u; heapq.heappush(q, (d + c, v))
        if t not in D: return None
        r = [t]
        while r[-1] != s: r.append(P[r[-1]])
        return r[::-1], D[t]
    def route(W):
        out = []
        prev = None
        for a, b in zip(W, W[1:]):
            best = None
            for s in ([prev] if prev else nearest(a)):
                for t in nearest(b):
                    r = path(s, t)
                    if r and (best is None or r[1] < best[1]): best = r
                if best: break
            if not best: raise SystemExit(f'no road from {a} to {b}')
            seg = best[0]; out += seg if not out else seg[1:]; prev = seg[-1]
        return out
    res = {}
    for key, W in (('sb', SB), ('nb', NB)):
        r = route(W)
        pts = [[round(N[n][0], 6), round(N[n][1], 6), flag.get((a, n), 0) if i else 0] for i, (a, n) in enumerate(zip([r[0]] + r, r))]
        if key == 'sb': pts += [[x, y, 2] for x, y in RAMP]
        else: pts = [[x, y, 2] for x, y in RAMP[::-1]] + pts
        L = sum(dist(p[:2], q[:2]) for p, q in zip(pts, pts[1:]))
        print(key, len(pts), 'points', round(L / 1000, 1), 'km', 'tunnel pts', sum(p[2] == 1 for p in pts), 'bridge pts', sum(p[2] == 2 for p in pts))
        res[key] = pts
    json.dump({'credit': 'Road © OpenStreetMap contributors', 'route': 'inferred: I-95, the Cross Bronx, the George Washington Bridge, I-95 and NJ 495, the Lincoln Tunnel',
               'sb': res['sb'], 'nb': res['nb']}, open(out, 'w'), separators=(',', ':'))

if __name__ == '__main__':
    main(*sys.argv[1:3])
