# The freeways, for Bird's-eye's traffic (v1128, requested: "put car traffic in each direction on the freeway (101?) If
# it can be correlated with the traffic report, all the better"):
#   python3 build_roads.py osm.json cms.json <id>     (cms.json '-' for a region without Caltrans's signs: Boston, v1146)
# osm.json: Overpass `way["highway"~"^(motorway|motorway_link|trunk|trunk_link)$"](s,w,n,e); out geom tags;` (send a
# User-Agent). cms.json: Caltrans's changeable message signs (https://cwwp2.dot.ca.gov/data/d4/cms/cmsStatusD04.json),
# for where they stand.
# Out: www/data/roads/<id>.json:
#   chains: each carriageway one way along her (the motorways' and trunk roads' ways joined end to end while the
#     route goes on), {ref, lanes, two (a two-way road: her lanes on the right of her line), pts [[lon, lat]...]
#     (simplified to ~2 m), bridges [[s0, s1]...] (metres along her)}
#   signs: each sign's road ahead to each place a sign can give a travel time to ("SFO ARPT 6 MIN"): {id (CM001),
#     dir, lon, lat, d: {place: [metres, [[chain, s0, s1]...] (the freeway stretches on the way)]}}; a sign's
#     minutes over the metres are the traffic's speed on those stretches (traffic3d.js)
# OSM data © OpenStreetMap contributors (ODbL).
import json, math, sys, heapq, re
src, cmsf, rid = sys.argv[1:4]
els = json.load(open(src))['elements']
R = 6371000.0
def dist(a, b):
    la = math.radians((a[1] + b[1]) / 2)
    return math.hypot((b[0] - a[0]) * math.cos(la), b[1] - a[1]) * math.pi / 180 * R
def rdp(P, eps):
    if len(P) < 3: return P
    a, b = P[0], P[-1]; la = math.cos(math.radians(a[1])); i, dm = 0, 0
    ax, ay, bx, by = a[0] * la, a[1], b[0] * la, b[1]
    L = math.hypot(bx - ax, by - ay) or 1e-12
    for k in range(1, len(P) - 1):
        px, py = P[k][0] * la, P[k][1]
        d = abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / L * math.pi / 180 * R
        if d > dm: i, dm = k, d
    if dm <= eps: return [a, b]
    return rdp(P[:i + 1], eps)[:-1] + rdp(P[i:], eps)
def key(p): return (round(p[0] * 1e7), round(p[1] * 1e7))
def refs(t): return [r.strip() for r in (t.get('ref') or '').split(';') if r.strip()]

# directed ways: [pts, tags, main (motorway/trunk), two-way]
W = []
for e in els:
    t = e.get('tags', {}); P = [[g['lon'], g['lat']] for g in e.get('geometry', [])]
    if len(P) < 2: continue
    hw = t.get('highway'); main = hw in ('motorway', 'trunk'); ow = t.get('oneway')
    if ow == '-1': W.append([P[::-1], t, main, False])
    elif ow in ('yes', 'true', '1') or (ow is None and hw in ('motorway', 'motorway_link')): W.append([P, t, main, False])
    else: W.append([P, t, main, True]); W.append([P[::-1], t, main, True])

# the mainline chains: a way goes on into the next where exactly one main way of her route starts at her end, and
# that one has only her coming in
starts, ends = {}, {}
for i, (P, t, m, two) in enumerate(W):
    if not m: continue
    starts.setdefault(key(P[0]), []).append(i); ends.setdefault(key(P[-1]), []).append(i)
def r0(i): return (refs(W[i][1]) or [''])[0]
nxt = {}
for i, (P, t, m, two) in enumerate(W):
    if not m: continue
    c = [j for j in starts.get(key(P[-1]), []) if r0(j) == r0(i) and W[j][3] == two and key(W[j][0][-1]) != key(P[0])]
    if len(c) == 1 and len([k for k in ends.get(key(W[c[0]][0][0]), []) if r0(k) == r0(i)]) == 1: nxt[i] = c[0]
prev = {j: i for i, j in nxt.items()}
chains, where = [], {}   # where: way -> (chain, s offset, cumulative s of her points)
seen = set()
def lanes_of(t, two, main):
    try: n = int(re.match(r'\d+', t.get('lanes', '')).group())
    except Exception: n = None
    if two: return max(1, (n or 2) // 2)
    return n or (3 if t.get('highway') == 'motorway' else 2)
for i in range(len(W)):
    if not W[i][2] or i in seen or i in prev: continue
    seq, j = [], i
    while j is not None and j not in seen: seen.add(j); seq.append(j); j = nxt.get(j)
    chains.append(seq)
for i in range(len(W)):   # (loops: none of them a start)
    if W[i][2] and i not in seen:
        seq, j = [], i
        while j is not None and j not in seen: seen.add(j); seq.append(j); j = nxt.get(j)
        chains.append(seq)
out_chains = []
for ci, seq in enumerate(chains):
    pts, s, bridges, tunnels, lanes = [], 0.0, [], [], []
    for j in seq:
        P, t = W[j][0], W[j][1]
        cum = [s]
        for k in range(1, len(P)): cum.append(cum[-1] + dist(P[k - 1], P[k]))
        where[j] = (ci, cum)
        if t.get('bridge') and t.get('bridge') != 'no': bridges.append([round(cum[0], 1), round(cum[-1], 1)])
        # (v1146, Boston: the Big Dig's I-93 and the Ted Williams under the harbor) her tunnels: no cars drawn in them
        if t.get('tunnel') in ('yes', 'building_passage', 'covered') or t.get('layer', '0').lstrip('-').isdigit() and int(t.get('layer', '0')) <= -1: tunnels.append([round(cum[0], 1), round(cum[-1], 1)])
        lanes.append((cum[-1] - cum[0], lanes_of(t, W[j][3], True)))
        pts += P if not pts else P[1:]
        s = cum[-1]
    ln = max(set(l for _, l in lanes), key=lambda l: sum(d for d, x in lanes if x == l))
    out_chains.append({'ref': r0(seq[0]), 'lanes': ln, 'two': W[seq[0]][3], 'len': round(s, 1),
                       'pts': [[round(a, 6), round(b, 6)] for a, b in rdp(pts, 2.0)], 'bridges': bridges, 'tunnels': tunnels})

# the graph: each point to the next along every directed way
G = {}
for i, (P, t, m, two) in enumerate(W):
    for k in range(1, len(P)):
        G.setdefault(key(P[k - 1]), []).append((key(P[k]), dist(P[k - 1], P[k]), i, k))
pos = {}
for P, t, m, two in W:
    for p in P: pos[key(p)] = p
noderefs = {}
for P, t, m, two in W:
    if not m: continue
    for p in P: noderefs.setdefault(key(p), set()).update(refs(t))

# where the signs' places are: a town's or an airport's freeway (any of hers within the radius, m), or a junction
# (the first of that route's)
PLACES = {
    'BERKELEY': (37.870, -122.295, 2500), 'CAMPBELL': (37.287, -121.950, 2500), 'CARQ BRDG': (38.0596, -122.2263, 1500),
    'CASTRO VY': (37.694, -122.083, 2500), 'CONCORD': (37.976, -122.050, 3000), 'CUPERTINO': (37.3235, -122.032, 2500),
    'DALY CITY': (37.688, -122.470, 2500), 'DUBLIN': (37.7037, -121.9282, 2500), 'FAIRFIELD': (38.249, -122.040, 3500),
    'FREMONT': (37.548, -121.988, 3500), 'HALF MOON': (37.4636, -122.4286, 2500), 'HAYWARD': (37.669, -122.081, 3000),
    'HEALDSBRG': (38.6105, -122.8697, 2500), 'LOS GATOS': (37.2358, -121.9624, 2500), 'MENLO PRK': (37.460, -122.160, 3000),
    'MILPITAS': (37.4323, -121.8996, 3000), 'MTN VIEW': (37.395, -122.080, 3000), 'NOVATO': (38.1074, -122.5697, 2500),
    'OAK ARPT': (37.7350, -122.1980, 2000), 'OAKLAND': (37.8044, -122.2712, 2500), 'PALO ALTO': (37.4419, -122.1430, 3000),
    'PETALUMA': (38.2324, -122.6367, 3000), 'ROHNRT PK': (38.3396, -122.7011, 2500), 'SAN BRUNO': (37.6305, -122.4111, 2500),
    'SAN MATEO': (37.5630, -122.3255, 2500), 'SAN RAMON': (37.7799, -121.978, 3000), 'SEARS PT': (38.1497, -122.4467, 2500),
    'SF DWNTWN': (37.7760, -122.4020, 900), 'SFO ARPT': (37.6290, -122.3960, 1500), 'SJ ARPT': (37.3626, -121.9290, 2500),
    'SJC ARPT': (37.3626, -121.9290, 2500), 'SJ STATE': (37.3352, -121.8811, 2000), 'SM BRIDGE': (37.585, -122.200, 3000),
    'SM-H BRDG': (37.585, -122.200, 3000), 'STA ROSA': (38.4405, -122.7144, 3000), 'VACAVILLE': (38.3566, -121.9877, 3500),
    'VALLEJO': (38.1041, -122.2566, 3000), 'WALNUT CK': (37.9101, -122.0652, 2500), 'WALNUT CR': (37.9101, -122.0652, 2500),
    'WINDSOR': (38.5471, -122.8164, 2500),
}
JUNCTIONS = {'HWY 280': ['I 280'], 'HWY 85': ['CA 85'], 'HWY 84': ['CA 84'], 'RTE 84': ['CA 84'], 'RTE 92': ['CA 92'],
             'HWY 4': ['CA 4'], 'HWY 580': ['I 580'], 'JCT 680': ['I 680'], 'S880/280': ['I 280'], 'S101 / 85': ['CA 85'],
             '680/80/12': ['I 80', 'I 680']}
at_place = {}   # node -> the places she's at
for name, (la, lo, r) in PLACES.items():
    for k, p in pos.items():
        if k in noderefs and abs(p[1] - la) < 0.05 and abs(p[0] - lo) < 0.06 and dist(p, [lo, la]) <= r: at_place.setdefault(k, []).append(name)

cms = json.load(open(cmsf))['data'] if cmsf != '-' else []   # ('-': a region with no Caltrans signs: Boston, v1146)
DIRS = {'North': 0, 'East': 90, 'South': 180, 'West': 270}
mains = [(i, P) for i, (P, t, m, two) in enumerate(W) if m]
def bearing(a, b): return (math.degrees(math.atan2((b[0] - a[0]) * math.cos(math.radians(a[1])), b[1] - a[1])) + 360) % 360
signs = []
for x in cms:
    c = x['cms']; L = c['location']; lo, la = float(L['longitude']), float(L['latitude'])
    route = L['route'].replace('US-', 'US ').replace('I-', 'I ').replace('SR-', 'CA '); want = DIRS.get(L['direction'])
    best, bd = None, 300.0
    for i, P in mains:
        if route not in refs(W[i][1]): continue
        for k in range(1, len(P)):
            d = dist(P[k], [lo, la])
            if d < bd:
                h = bearing(P[k - 1], P[k])
                if want is None or abs((h - want + 540) % 360 - 180) < 80: best, bd = (i, k), d
    if not best: continue
    i, k = best; s0 = key(W[i][0][k])
    # Dijkstra from her, along the way she faces, to 90 km (the signs' places are within ~65)
    D, back, done, found = {s0: 0.0}, {}, set(), {}
    jt = {n: {r for r in rs if r != route} for n, rs in JUNCTIONS.items()}
    q = [(0.0, s0)]
    while q:
        d, u = heapq.heappop(q)
        if u in done: continue
        done.add(u)
        if d > 90000: break
        for n in at_place.get(u, ()):
            if n not in found: found[n] = (d, u)
        nr = noderefs.get(u)
        if nr:
            for n, rs in jt.items():
                if n not in found and nr & rs: found[n] = (d, u)
        for v, w, wi, kk in G.get(u, []):
            nd = d + w
            if nd < D.get(v, 1e18): D[v] = nd; back[v] = (u, wi, kk); heapq.heappush(q, (nd, v))
    dd = {}
    for n, (d, u) in found.items():
        if d < 300: continue
        ranges = []
        while u in back:
            pu, wi, kk = back[u]
            if wi in where:
                ci, cum = where[wi]; a, b = cum[kk - 1], cum[kk]
                if ranges and ranges[-1][0] == ci and abs(ranges[-1][1] - b) < 0.5: ranges[-1][1] = a
                else: ranges.append([ci, a, b])
            u = pu
        dd[n] = [round(d), [[ci, round(a), round(b)] for ci, a, b in ranges[::-1]]]
    signs.append({'id': L['locationName'].split('-')[0], 'dir': L['direction'], 'lon': lo, 'lat': la, 'd': dd})

json.dump({'id': rid, 'credit': 'Freeways © OpenStreetMap contributors' + (', traffic from Caltrans signs' if cms else ''), 'chains': out_chains, 'signs': signs},
          open(f'../../www/data/roads/{rid}.json', 'w'), separators=(',', ':'))
print(len(out_chains), 'chains', sum(len(c['pts']) for c in out_chains), 'points;', len(signs), 'signs placed of', len(cms),
      ';', sum(len(s['d']) for s in signs), 'sign-place roads')
