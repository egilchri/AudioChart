#!/usr/bin/env python3
"""Pack one region's chart data into the compact binary the Wear OS app loads.

    python3 design/watch/build_watch_data.py penobscot-bay

Writes wear/app/src/main/assets/<region>.bin (big-endian, read by
ChartData.java). Coordinates are int32 micro-degrees (~0.1 m).

Layout:
  "ACW1"  int version(1)
  bbox:   int minLon, minLat, maxLon, maxLat          (chart coverage)
  hazards: int n; n x { int lon, int lat, byte kind, byte watlev, utf name }
  land:    polyset
  shoals:  polyset, plus a short depthDm per polygon (DRVAL1, decimetres)
  places:  int n; n x { int lon, int lat, utf name }
polyset: int nPolys; nPolys x { int nRings; nRings x { int nPts; nPts x (int lon, int lat) } }
utf = Java DataInput.readUTF (u16 length + modified UTF-8; plain ASCII here).

Only the shallow areas with a charted least depth under SHOAL_MAX_M are
kept: drying flats and ledges, which are what a small keelboat must avoid.
Shallow areas skipped by the web app's hazard check (no point geometry) are
the same features; the watch checks them as polygons instead.
"""
import json, os, struct, sys

SHOAL_MAX_M = 1.5
KIND = {'underwater rock': 1, 'obstruction': 2, 'wreck': 3}

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def u(v):
    return int(round(v * 1e6))


def utf(s):
    b = s.encode('utf-8')
    return struct.pack('>H', len(b)) + b


def rings_of(geom):
    if geom['type'] == 'Polygon':
        return [geom['coordinates']]
    if geom['type'] == 'MultiPolygon':
        return geom['coordinates']
    return []


def polyset(polys):
    out = [struct.pack('>i', len(polys))]
    for rings in polys:
        out.append(struct.pack('>i', len(rings)))
        for r in rings:
            out.append(struct.pack('>i', len(r)))
            out.append(b''.join(struct.pack('>ii', u(x), u(y)) for x, y in (p[:2] for p in r)))
    return b''.join(out)


def main(region):
    rd = os.path.join(ROOT, 'www', 'data', 'regions', region)
    load = lambda n: json.load(open(os.path.join(rd, n)))

    bounds = load('chart_bounds.geojson')['features'][0]['geometry']['coordinates'][0]
    xs = [p[0] for p in bounds]; ys = [p[1] for p in bounds]

    haz, shoals = [], []
    for f in load('hazards.geojson')['features']:
        p, g = f['properties'], f['geometry']
        if g['type'] == 'Point' and p.get('label') in KIND:
            haz.append((g['coordinates'], KIND[p['label']], p.get('watlev') or 0, p.get('name') or ''))
        elif g['type'] in ('Polygon', 'MultiPolygon') and p.get('valsou') is not None and p['valsou'] < SHOAL_MAX_M:
            for poly in rings_of(g):
                shoals.append((poly, p['valsou']))

    land = []
    for f in load('land.geojson')['features']:
        land.extend(rings_of(f['geometry']))

    places = [(f['geometry']['coordinates'], f['properties']['name'])
              for f in load('named_places.geojson')['features']
              if f['geometry']['type'] == 'Point' and f['properties'].get('name')]

    out = [b'ACW1', struct.pack('>i', 1),
           struct.pack('>iiii', u(min(xs)), u(min(ys)), u(max(xs)), u(max(ys))),
           struct.pack('>i', len(haz))]
    for (x, y), k, w, name in haz:
        out.append(struct.pack('>iibb', u(x), u(y), k, w) + utf(name))
    out.append(polyset(land))
    out.append(polyset([s[0] for s in shoals]))
    out.append(b''.join(struct.pack('>h', max(-32768, round(d * 10))) for _, d in shoals))
    out.append(struct.pack('>i', len(places)))
    for (x, y), name in places:
        out.append(struct.pack('>ii', u(x), u(y)) + utf(name))

    dest = os.path.join(ROOT, 'wear', 'app', 'src', 'main', 'assets', region + '.bin')
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    blob = b''.join(out)
    open(dest, 'wb').write(blob)
    print(f'{dest}: {len(blob)/1e6:.2f} MB — {len(haz)} hazards, {len(land)} land polygons, '
          f'{len(shoals)} shoals (<{SHOAL_MAX_M} m), {len(places)} places')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'penobscot-bay')
