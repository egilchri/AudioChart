# A tile's footprints made lighter, for the big rowhouse tiles (v1066: Brooklyn's ran 10 MB): to 6 decimals (about
# 10 cm), and corners that are no corner (within 0.4 m of the line from one neighbour to the next) dropped.
#   python round_coords.py <tile.json> ...
import json, math, sys
TOL = 0.4

def simplify(ring, lat):
    k = 111320 * math.cos(math.radians(lat)); M = 111320
    pts = list(ring)
    changed = True
    while changed and len(pts) > 3:
        changed = False
        for i in range(len(pts)):
            a, b, c = pts[i - 1], pts[i], pts[(i + 1) % len(pts)]
            ax, ay, bx, by, cx, cy = a[0] * k, a[1] * M, b[0] * k, b[1] * M, c[0] * k, c[1] * M
            L = math.hypot(cx - ax, cy - ay)
            d = math.hypot(bx - ax, by - ay) if L == 0 else abs((cx - ax) * (ay - by) - (ax - bx) * (cy - ay)) / L
            if d < TOL:
                del pts[i]; changed = True; break
    return pts

for f in sys.argv[1:]:
    J = json.load(open(f)); n0 = n1 = 0
    lat = (J['bbox'][1] + J['bbox'][3]) / 2
    for b in J['buildings']:
        n0 += len(b['p'])
        b['p'] = [[round(x, 6), round(y, 6)] for x, y in simplify(b['p'], lat)]
        n1 += len(b['p'])
    for p in J.get('piers', []): p['p'] = [[round(x, 6), round(y, 6)] for x, y in p['p']]
    json.dump(J, open(f, 'w'), separators=(',', ':'))
    print(f, len(J['buildings']), 'corners', n0, '->', n1)
