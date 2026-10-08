"""Build one demo's 3D scene data: python3 -I build_demo.py <curated-id> <prefix>
Near tiles (10 m DEM + NAIP photo) within NEAR_M of the route; far 30 m DEM + photo out to the horizon."""
import json, math, sys, os, subprocess, re, gzip, base64, urllib.request, urllib.parse
import numpy as np
RID, PFX = sys.argv[1], sys.argv[2]
OUT = 'sim2'; TMP = 'demo_tmp'; os.makedirs(TMP, exist_ok=True)
REPO = '/Users/edgargilchrist/tools/AudioChart/www/data'
cur = {r['id']: r for r in json.load(open(REPO + '/curated_routes.json'))}[RID]
route = [[round(p['lon'] if isinstance(p, dict) else p[0], 5), round(p['lat'] if isinstance(p, dict) else p[1], 5)] for p in cur['points']]
LAT0 = 44.12; MX = 111320 * math.cos(math.radians(LAT0)); MY = 111120
def seg_dist_m(px, py, ax, ay, bx, by):
    ax, ay, bx, by, px, py = ax * MX, ay * MY, bx * MX, by * MY, px * MX, py * MY
    dx, dy = bx - ax, by - ay; L = dx * dx + dy * dy
    t = 0 if L == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)
def rect_dist_m(w, s, e, n):
    # distance from route to the rectangle: sample the rectangle densely
    best = 1e18
    for i in range(9):
        for j in range(9):
            x, y = w + (e - w) * i / 8, s + (n - s) * j / 8
            for k in range(1, len(route)):
                best = min(best, seg_dist_m(x, y, *route[k - 1], *route[k]))
    return best
NEAR_M = 2500; TW, TH = 0.07, 0.045
lons = [p[0] for p in route]; lats = [p[1] for p in route]
gw = math.floor((min(lons) - 0.04) / TW) * TW; gs = math.floor((min(lats) - 0.03) / TH) * TH
tiles = []
x = gw
while x < max(lons) + 0.04:
    y = gs
    while y < max(lats) + 0.03:
        w, s, e, n = round(x, 4), round(y, 4), round(x + TW, 4), round(y + TH, 4)
        if rect_dist_m(w, s, e, n) < NEAR_M: tiles.append((w, s, e, n))
        y += TH
    x += TW
print(len(tiles), 'near tiles', flush=True)
B = 'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation'
def vrt(name, res, cells):
    p = f'{TMP}/{name}.vrt'
    if not os.path.exists(p):
        subprocess.run(['gdalbuildvrt', '-q', p] + [f'/vsicurl/{B}/{res}/TIFF/current/{c}/USGS_{res}_{c}.tif' for c in cells], check=True)
    return p
def cells_for(w, s, e, n):
    return sorted({f'n{la}w{lo:03d}' for la in range(math.floor(s) + 1, math.floor(n) + 2) for lo in range(math.ceil(-e), math.ceil(-w) + 1)})
def info(p):
    t = subprocess.run(['gdalinfo', p], capture_output=True, text=True).stdout
    w, h = map(int, re.search(r'Size is (\d+), (\d+)', t).groups())
    ox, oy = map(float, re.search(r'Origin = \(([-\d.]+),([-\d.]+)\)', t).groups())
    px = float(re.search(r'Pixel Size = \(([-\d.]+),', t).group(1))
    return w, h, ox, oy, px
def dem(vrtp, w, s, e, n, name):
    tif, binp = f'{TMP}/{name}.tif', f'{TMP}/{name}.bin'
    subprocess.run(['gdal_translate', '-q', '-projwin', str(w), str(n), str(e), str(s), vrtp, tif], check=True)
    subprocess.run(['gdal_translate', '-q', '-of', 'ENVI', '-ot', 'Float32', tif, binp], check=True)
    W, H, ox, oy, px = info(tif)
    a = np.fromfile(binp, dtype=np.float32).reshape(H, W); a[a < -1000] = 0
    q = np.where(a <= 0.4, -30, np.clip(np.round(a * 10), -30, 32000)).astype(np.int16)
    fn = f'{name}.b64.txt'
    open(f'{OUT}/{fn}', 'w').write(base64.b64encode(gzip.compress(q.tobytes(), 9)).decode())
    return dict(file=fn, w=W, h=H, west=ox, north=oy, dx=px, dy=px)
SVC = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage'
def photo(w, s, e, n, name, maxpx=4000):
    res = max(e - w, n - s) / maxpx
    q = dict(bbox=f'{w},{s},{e},{n}', bboxSR=4326, imageSR=4326, size=f'{round((e - w) / res)},{round((n - s) / res)}', format='jpg', compressionQuality=82)
    meta = json.load(urllib.request.urlopen(SVC + '?' + urllib.parse.urlencode({**q, 'f': 'json'}), timeout=180))
    fn = f'{name}.jpg'
    urllib.request.urlretrieve(SVC + '?' + urllib.parse.urlencode({**q, 'f': 'image'}), f'{OUT}/{fn}')
    ex = meta['extent']
    return dict(file=fn, west=ex['xmin'], east=ex['xmax'], south=ex['ymin'], north=ex['ymax'], w=meta['width'], h=meta['height'])
near_vrt = vrt('near13', '13', cells_for(min(t[0] for t in tiles), min(t[1] for t in tiles), max(t[2] for t in tiles), max(t[3] for t in tiles)))
patches = []
M = 0.0002  # ~2 cells of overlap so neighbouring tiles meet
for i, (w, s, e, n) in enumerate(tiles):
    d = dem(near_vrt, w - M, s - M, e + M, n + M, f'{PFX}_d{i:02d}')
    ph = photo(w, s, e, n, f'{PFX}_p{i:02d}')
    patches.append(dict(name=f'{PFX}{i}', dem=d, tiles=[ph]))
    print('tile', i, w, s, d['w'], d['h'], ph['w'], ph['h'], flush=True)
FW, FS, FE, FN = min(lons) - 0.2, min(lats) - 0.15, max(lons) + 0.2, max(lats) + 0.15
far_vrt = vrt('far1', '1', cells_for(FW, FS, FE, FN))
far = dict(dem=dem(far_vrt, FW, FS, FE, FN, f'{PFX}_far'), tiles=[photo(FW, FS, FE, FN, f'{PFX}_far')])
print('far', far['dem']['w'], far['dem']['h'], flush=True)
nav, places = [], []
inb = lambda c: FW <= c[0] <= FE and FS <= c[1] <= FN
for f in json.load(open(REPO + '/regions/penobscot-bay/navaid.geojson'))['features']:
    p, c = f['properties'], f['geometry']['coordinates']
    if inb(c) and p['objtype'] in ('BOYLAT', 'BCNLAT', 'BOYSAW', 'BOYSPP', 'BOYCAR', 'BOYISD', 'LIGHTS'):
        nav.append({'t': p['objtype'], 'n': p.get('name'), 'c': p.get('colour'), 's': p.get('shape'), 'ch': p.get('characteristic'), 'x': round(c[0], 5), 'y': round(c[1], 5)})
for f in json.load(open(REPO + '/regions/penobscot-bay/named_places.geojson'))['features']:
    p, g = f['properties'], f['geometry']
    if g['type'] == 'Point' and inb(g['coordinates']) and p['objtype'] in ('LNDARE', 'LNDRGN', 'LIGHTS', 'BUAARE'):
        places.append({'t': p['objtype'], 'n': p['name'], 'x': round(g['coordinates'][0], 5), 'y': round(g['coordinates'][1], 5)})
scene = dict(patches=patches, far=far, breakwater=[[-69.08197, 44.11540], [-69.07751, 44.10410]], route=route, routeName=cur['name'], nav=nav, places=places)
json.dump(scene, open(f'{OUT}/scene_{PFX}.json', 'w'), separators=(',', ':'))
print('done', len(nav), 'nav', len(places), 'places')
