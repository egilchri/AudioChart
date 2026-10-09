# Carvers Harbor buildings for helm3d: OSM footprints + USGS 3DEP lidar heights + NAIP roof colours.
import json, math, sys, hashlib
import numpy as np
from PIL import Image
osm_p, pts_p, naip_p, out_p = sys.argv[1:5]
import os
W,S_,E,N = map(float, os.environ.get('BBOX', '-68.85,44.035,-68.82,44.06').split(','))   # town bbox: west,south,east,north
R = 6378137.0
def merc(lon, lat): return (np.radians(lon)*R, np.log(np.tan(np.pi/4+np.radians(lat)/2))*R)
P = np.load(pts_p)                   # x y z class return nret (web mercator)
k = 1/math.cos(math.radians((S_ + N) / 2)) # mercator metres per true metre here
CELL = 4.0*k
gx = np.floor(P[:,0]/CELL).astype(np.int64); gy = np.floor(P[:,1]/CELL).astype(np.int64)
order = np.lexsort((gy, gx)); gx, gy, P = gx[order], gy[order], P[order]
keys = gx*1000003 + gy
uk, start = np.unique(keys, return_index=True); end = np.append(start[1:], len(keys))
cell = dict(zip(uk.tolist(), zip(start.tolist(), end.tolist())))
def pts_in_box(x0, y0, x1, y1):
    out = []
    for cx in range(int(math.floor(x0/CELL)), int(math.floor(x1/CELL))+1):
        for cy in range(int(math.floor(y0/CELL)), int(math.floor(y1/CELL))+1):
            r = cell.get(cx*1000003+cy)
            if r: out.append(P[r[0]:r[1]])
    return np.concatenate(out) if out else np.zeros((0,6))
def inside(px, py, poly):
    c = np.zeros(len(px), bool); n = len(poly)
    for i in range(n):
        x1,y1 = poly[i-1]; x2,y2 = poly[i]
        m = (y1 > py) != (y2 > py)
        with np.errstate(divide='ignore', invalid='ignore'):
            xi = (x2-x1)*(py-y1)/(y2-y1)+x1
        c ^= m & (px < xi)
    return c
water = P[P[:,3]==9][:,2]; WATER_Z = float(np.median(water))
img = np.asarray(Image.open(naip_p).convert('RGB')); IH, IW = img.shape[:2]
def obb(xy):  # min-area rectangle in local metres: (area, ux, uy, len, wid)
    best = None
    for i in range(len(xy)):
        v = xy[(i+1)%len(xy)]-xy[i]; L = math.hypot(*v)
        if L < 1e-6: continue
        u = v/L; w = np.array([-u[1], u[0]]); a = xy@u; c = xy@w
        A = (a.max()-a.min())*(c.max()-c.min())
        if best is None or A < best[0]: best = (A, u, a.max()-a.min(), c.max()-c.min())
    return best
lat0 = (S_ + N) / 2; mx_lon = 111320*math.cos(math.radians(lat0)); my_lat = 110540
def local(ll): return np.array([[(lo-W)*mx_lon, (la-S_)*my_lat] for lo,la in ll])
PALETTE = [((236,234,226),45),((150,146,138),22),((228,214,160),8),((196,204,208),8),((140,52,40),7),((150,166,140),5),((206,190,160),5)]
def wall_colour(seed):
    t = int(hashlib.md5(str(seed).encode()).hexdigest()[:8],16) % 100
    for c,wgt in PALETTE:
        if t < wgt: return c
        t -= wgt
    return PALETTE[0][0]
els = json.load(open(osm_p))['elements']
# Optional gap fill from Microsoft's ML building footprints (ODbL, same licence as OSM): one
# quadkey file (.csv.gz of GeoJSON lines) given as MS=<path>. A Microsoft footprint is used only
# where no OSM building covers its centre or sits within 8 m of it (Camden: OSM had 541 of ~2300).
if os.environ.get('MS'):
    import gzip
    osm_polys = []
    for e in els:
        if 'building' in e.get('tags', {}) and e.get('geometry'):
            g = e['geometry']; osm_polys.append(([(p['lon'], p['lat']) for p in g], sum(p['lon'] for p in g) / len(g), sum(p['lat'] for p in g) / len(g)))
    def covered(lo, la):
        for ring, cx, cy in osm_polys:
            if abs(cx - lo) * mx_lon < 8 and abs(cy - la) * my_lat < 8: return True
            if abs(cx - lo) * mx_lon > 300 or abs(cy - la) * my_lat > 300: continue
            if inside(np.array([lo]), np.array([la]), ring)[0]: return True
        return False
    added = 0
    for i, line in enumerate(gzip.open(os.environ['MS'], 'rt')):
        f = json.loads(line); ring = f['geometry']['coordinates'][0]
        lo = sum(p[0] for p in ring) / len(ring); la = sum(p[1] for p in ring) / len(ring)
        if not (W <= lo <= E and S_ <= la <= N) or covered(lo, la): continue
        els.append({'type': 'way', 'id': f'ms{i}', 'tags': {'building': 'yes'}, 'geometry': [{'lon': p[0], 'lat': p[1]} for p in ring]}); added += 1
    print('Microsoft footprints added:', added)
B, PIERS, stats = [], [], {'measured':0,'default':0}
for e in els:
    tags = e.get('tags', {}); g = e.get('geometry')
    if not g: continue
    ll = [(p['lon'], p['lat']) for p in g]
    if 'building' in tags:
        if ll[0] == ll[-1]: ll = ll[:-1]
        if len(ll) < 3: continue
        mx, my = merc(np.array([p[0] for p in ll]), np.array([p[1] for p in ll]))
        poly = list(zip(mx, my)); pad = 8*k
        Q = pts_in_box(mx.min()-pad, my.min()-pad, mx.max()+pad, my.max()+pad)
        ins = inside(Q[:,0], Q[:,1], poly) if len(Q) else np.zeros(0,bool)
        gr = Q[(~ins) & (Q[:,3]==2)][:,2] if len(Q) else np.zeros(0)
        ground = float(np.percentile(gr, 30)) if len(gr) >= 3 else None
        roof = Q[ins & (Q[:,3]!=2) & (Q[:,3]!=9)][:,2] if len(Q) else np.zeros(0)
        xy = local(ll); A = 0.5*abs(np.dot(xy[:,0],np.roll(xy[:,1],1))-np.dot(xy[:,1],np.roll(xy[:,0],1)))
        ob = obb(xy); rect = A/ob[0] if ob and ob[0] > 0 else 0
        wid = min(ob[2], ob[3]) if ob else 8
        base = ground if ground is not None else 2.5
        rel = roof - base if len(roof) else np.zeros(0)
        rel = rel[(rel > 1.5) & (rel < 30)]
        if len(rel) >= 4:
            ridge = float(np.percentile(rel, 92)); eave = float(np.percentile(rel, 12))
            ridge = min(ridge, eave + math.tan(math.radians(50))*wid/2)   # trees over the roof
            eave = max(2.4, min(eave, ridge)); stats['measured'] += 1
        else:
            eave = 4.6 if A > 60 else 2.6; ridge = eave + (2.6 if A > 60 else 1.3); stats['default'] += 1
        shape = 'gable' if rect > 0.85 and ridge - eave > 0.8 and len(ll) <= 8 else 'flat'
        if shape == 'flat': eave = max(eave, min(ridge, eave + 1.0))
        # roof colour: NAIP pixels inside the footprint
        cols = ((np.array([p[0] for p in ll]) - W)/(E-W)*IW).astype(int).clip(0, IW-1)
        rows = ((N - np.array([p[1] for p in ll]))/(N-S_)*IH).astype(int).clip(0, IH-1)
        sub = img[rows.min():rows.max()+1, cols.min():cols.max()+1].reshape(-1,3)
        rc = [int(v) for v in np.median(sub, 0)] if len(sub) else [110,110,110]
        b = {'p': [[round(lo,7), round(la,7)] for lo,la in ll], 'e': round(eave,1), 'r': round(ridge,1), 's': shape,
             'rc': rc, 'wc': list(wall_colour(e['id']))}
        if ground is not None: b['g'] = round(ground, 2)
        if tags.get('name'): b['n'] = tags['name']
        if ob and shape == 'gable': b['ax'] = [round(float(ob[1][0]),4), round(float(ob[1][1]),4)] if ob[2] >= ob[3] else [round(float(-ob[1][1]),4), round(float(ob[1][0]),4)]
        B.append(b)
    elif tags.get('man_made') in ('pier', 'breakwater'):
        mx, my = merc(np.array([p[0] for p in ll]), np.array([p[1] for p in ll])); pad = 4*k
        Q = pts_in_box(mx.min()-pad, my.min()-pad, mx.max()+pad, my.max()+pad)
        deck = None
        if len(Q):
            # points on the structure: within ~2 m of its line (or inside it, for an area)
            d = np.full(len(Q), 1e9)
            for i in range(len(mx)-1):
                ax, ay, bx, by = mx[i], my[i], mx[i+1], my[i+1]; vx, vy = bx-ax, by-ay; L2 = vx*vx+vy*vy or 1e-9
                t = np.clip(((Q[:,0]-ax)*vx+(Q[:,1]-ay)*vy)/L2, 0, 1)
                d = np.minimum(d, np.hypot(Q[:,0]-(ax+t*vx), Q[:,1]-(ay+t*vy)))
            on = Q[(d < 2*k) & (Q[:,3]!=9)][:,2]
            if len(on) >= 3: deck = float(np.percentile(on, 60))
        closed = ll[0] == ll[-1] and len(ll) >= 4
        w = float(tags.get('width', '0').split()[0] or 0) if tags.get('width','').replace('.','',1).split(' ')[0].isdigit() else 0
        PIERS.append({'p': [[round(lo,7), round(la,7)] for lo,la in ll], 'kind': tags['man_made'], 'area': closed,
                      'w': w or (6 if tags['man_made']=='breakwater' else 3), 'd': round(deck if deck is not None else (1.5 if tags['man_made']=='breakwater' else 3.0), 2),
                      **({'n': tags['name']} if tags.get('name') else {})})
json.dump({'name': os.environ.get('TOWN', 'Carvers Harbor, Vinalhaven'), 'bbox': [W,S_,E,N],
  'credit': 'Buildings © OpenStreetMap contributors' + (' and Microsoft (ODbL)' if os.environ.get('MS') else ' (ODbL)') + '; heights from USGS 3DEP lidar (ME MidCoast 2021); roof colours from USDA NAIP',
  'datum': 'metres; g (ground) and d (deck) are NAVD88 elevations from the lidar; e/r (eave/ridge) are above g',
  'buildings': B, 'piers': PIERS}, open(out_p, 'w'), separators=(',', ':'))
print(len(B), 'buildings', stats, len(PIERS), 'piers; water z', round(WATER_Z,2))
e_=np.array([b['e'] for b in B]); r_=np.array([b['r'] for b in B]); g_=np.array([b.get('g',np.nan) for b in B])
print('eave med', np.median(e_), 'ridge med', np.median(r_), 'p95 ridge', np.percentile(r_,95), 'gable', sum(b['s']=='gable' for b in B), 'ground rel water med', np.nanmedian(g_))
print('decks', [p['d'] for p in PIERS])
for b in B:
    if b.get('n') in ('Union Church of Vinalhaven','Vinalhaven Fishermans Co-op','Vinalhaven Public Library','Tidewater Motel','Vinalhaven Town Office'): print(b['n'], b['e'], b['r'], b['s'], b.get('g'), b['rc'])
