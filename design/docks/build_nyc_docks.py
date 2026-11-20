#!/usr/bin/env python3
"""New York's ferry docks for Bird's-eye (v1187): www/data/docks/new-york-harbor.json.

Asked: "now draw the ferry docks in New York" (after "Don't the ferries have docks to go to?": a live ferry stopped at
her landing had lain with her bow up the bank, the landing not drawn). From OpenStreetMap: the piers and floating
landings (man_made=pier, floating=yes) within 80 m of a ferry terminal (amenity=ferry_terminal), less those a building
tile already draws (www/data/buildings/*.json piers); and where a terminal has none, a landing float of its own, 30 by
9 m, at the end of the ferry route nearest it, lying across the boats' way in.

Input: an Overpass answer, docks.json, for
  [out:json];(nwr[amenity=ferry_terminal](40.47,-74.28,40.93,-73.68);way[route=ferry](...);way[man_made=pier](...);
  way[floating=yes](...););out body;>;out skel qt;
Usage: python3 build_nyc_docks.py docks.json ../../www/data/buildings ../../www/data/docks/new-york-harbor.json
"""
import json, sys, math, glob, os

def xy(lon, lat):   # metres, near enough here
    return lon * 84300, lat * 111200

def dist(a, b):
    (ax, ay), (bx, by) = xy(*a), xy(*b); return math.hypot(ax - bx, ay - by)

def seg_dist(p, a, b):
    (px, py), (ax, ay), (bx, by) = xy(*p), xy(*a), xy(*b)
    dx, dy = bx - ax, by - ay; L2 = dx * dx + dy * dy or 1e-9
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L2))
    return math.hypot(ax + dx * t - px, ay + dy * t - py)

def near_line(p, P):
    return min(seg_dist(p, a, b) for a, b in zip(P, P[1:])) if len(P) > 1 else dist(p, P[0])

def main(src, tiles, out):
    el = json.load(open(src))['elements']
    N = {e['id']: (e['lon'], e['lat']) for e in el if e['type'] == 'node' and 'lon' in e}
    ways = [e for e in el if e['type'] == 'way']
    geom = lambda w: [N[n] for n in w['nodes'] if n in N]
    terms = []
    for e in el:
        t = e.get('tags', {})
        if t.get('amenity') != 'ferry_terminal': continue
        if e['type'] == 'node': terms.append((t.get('name', ''), (e['lon'], e['lat'])))
        elif e['type'] == 'way':
            G = geom(e)
            if G: terms.append((t.get('name', ''), (sum(p[0] for p in G) / len(G), sum(p[1] for p in G) / len(G))))
    routes = [geom(w) for w in ways if w.get('tags', {}).get('route') == 'ferry']
    # the piers the building tiles already draw (their middles)
    have = []
    for f in glob.glob(os.path.join(tiles, '*.json')):
        try: T = json.load(open(f))
        except Exception: continue
        if not isinstance(T, dict): continue
        for pr in T.get('piers', []) or []:
            P = pr['p']; have.append((P, (sum(p[0] for p in P) / len(P), sum(p[1] for p in P) / len(P))))
    piers, used = [], set()
    for w in ways:
        t = w.get('tags', {})
        if not (t.get('man_made') == 'pier' or t.get('floating') == 'yes'): continue
        G = geom(w)
        if len(G) < 2: continue
        L = sum(dist(a, b) for a, b in zip(G, G[1:]))
        if L < 10: continue
        near = [n for n, p in terms if near_line(p, G) < 80]
        if not near: continue
        mid = (sum(p[0] for p in G) / len(G), sum(p[1] for p in G) / len(G))
        if any(dist(mid, m) < 8 or (len(P) > 1 and near_line(mid, P) < 3) for P, m in have): continue   # (a tile draws it)
        area = G[0] == G[-1] and len(G) > 3
        floating = t.get('floating') == 'yes'
        piers.append({'p': [[round(a, 7), round(b, 7)] for a, b in G], 'kind': 'pier', 'area': area, 'w': float(t.get('width', 4 if floating else 3)) if str(t.get('width', '')).replace('.', '', 1).isdigit() else (4 if floating else 3),
                      'd': 1.0 if floating else 1.8, 'name': near[0]})
        used.update(near)
    # a terminal with no dock: a float at the nearest ferry route's end, across the way in
    made = 0
    for name, p in terms:
        if name in used or any(dist(p, m) < 60 for P, m in have): continue
        best = None
        for R in routes:
            for end, nxt in ((R[0], R[1] if len(R) > 1 else None), (R[-1], R[-2] if len(R) > 1 else None)):
                if nxt is None: continue
                d = dist(p, end)
                if d < 250 and (best is None or d < best[0]): best = (d, end, nxt)
        if not best: continue
        _, end, nxt = best
        (ex, ey), (nx, ny) = xy(*end), xy(*nxt); ux, uy = nx - ex, ny - ey; Lu = math.hypot(ux, uy) or 1; ux, uy = ux / Lu, uy / Lu
        cx, cy = ex + ux * 6, ey + uy * 6   # (its middle a few metres out along the way in)
        vx, vy = -uy, ux                     # (along the float: across the way in)
        corners = [(cx + vx * 15 + ux * 4.5 * s1, cy + vy * 15 + uy * 4.5 * s1) for s1 in (-1, 1)] + [(cx - vx * 15 + ux * 4.5 * s1, cy - vy * 15 + uy * 4.5 * s1) for s1 in (1, -1)]
        poly = [[round(x / 84300, 7), round(y / 111200, 7)] for x, y in corners]; poly.append(poly[0])
        piers.append({'p': poly, 'kind': 'pier', 'area': True, 'w': 9, 'd': 1.0, 'name': name or 'Ferry landing', 'made': True}); made += 1
    print(len(terms), 'terminals;', len(piers) - made, 'piers from OSM;', made, 'floats made;', len(used), 'terminals with an OSM dock')
    json.dump({'credit': 'Ferry docks © OpenStreetMap contributors', 'piers': piers}, open(out, 'w'), separators=(',', ':'))

if __name__ == '__main__':
    main(*sys.argv[1:4])
