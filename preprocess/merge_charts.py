#!/usr/bin/env python3
"""
Merge and deduplicate raw GeoJSON files from s57_to_geojson.py.
Produces the final www/data/ files consumed by the PWA.

Pipeline order:
  1. python3 s57_to_geojson.py       — extract from NOAA ENC S-57 files
  2. python3 backfill_light_names.py — add names from NGA + manual overrides
  3. python3 merge_charts.py         — deduplicate and write final www/data/ files

Usage: python3 merge_charts.py
"""
import hashlib
import json
import math
import os

from shapely.geometry import shape, mapping
from shapely.ops import unary_union
from shapely.strtree import STRtree

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, '../www/data'))
DEDUP_RADIUS_M = 15.0  # merge features within this distance (metres)


def haversine_m(lon1, lat1, lon2, lat2):
    """Return distance in metres between two WGS84 points."""
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _feature_centroid(feat):
    """Return (lon, lat) centroid for any geometry type."""
    geom = feat['geometry']
    coords = geom['coordinates']
    if geom['type'] == 'Point':
        return coords[0], coords[1]
    # For Polygon/MultiPolygon, use the centroid of the exterior ring
    if geom['type'] == 'Polygon':
        ring = coords[0]
    elif geom['type'] == 'MultiPolygon':
        ring = coords[0][0]
    else:
        ring = coords[0] if coords else [[0, 0]]
    lons = [p[0] for p in ring]
    lats = [p[1] for p in ring]
    return sum(lons) / len(lons), sum(lats) / len(lats)


def deduplicate(features, radius_m=DEDUP_RADIUS_M):
    """Remove near-duplicate features. Keeps whichever has more populated properties."""
    kept = []
    for feat in features:
        lon, lat = _feature_centroid(feat)
        duplicate = False
        for k in kept:
            klon, klat = _feature_centroid(k)
            if haversine_m(lon, lat, klon, klat) < radius_m:
                feat_score = sum(1 for v in feat['properties'].values() if v is not None)
                k_score = sum(1 for v in k['properties'].values() if v is not None)
                if feat_score > k_score:
                    kept[kept.index(k)] = feat
                duplicate = True
                break
        if not duplicate:
            kept.append(feat)
    return kept


def deduplicate_places(features):
    """Deduplicate named places by exact name match + proximity."""
    seen_names = {}
    kept = []
    for feat in features:
        name = feat['properties'].get('name_lower', '').strip()
        if not name:
            continue
        lon, lat = feat['geometry']['coordinates']
        if name in seen_names:
            # Keep if closer to the map center (prefer the more specific chart cell)
            pass  # just skip duplicate names
        else:
            seen_names[name] = feat
            kept.append(feat)
    return kept


def clip_shallow_to_water(hazards):
    """Subtract land geometry from 'shallow area' polygons.

    The chart's DEPARE depth bands are bounded by the low-water line, while
    land.geojson (LNDARE) is drawn at high water — so the two legitimately
    overlap in the foreshore/intertidal strip. That makes the depth overlay
    visually bleed onto what looks like dry land. Clipping to the charted
    shoreline keeps the rendered zones from spilling past the coastline.
    """
    land_path = os.path.join(DATA_DIR, 'land.geojson')
    if not os.path.exists(land_path):
        print('  WARNING: land.geojson not found — skipping shallow-area clipping')
        return hazards
    with open(land_path) as f:
        land_features = json.load(f).get('features', [])
    land_geoms = [shape(feat['geometry']).buffer(0) for feat in land_features]
    tree = STRtree(land_geoms)

    clipped = dropped = 0
    out = []
    for feat in hazards:
        if (feat['properties'].get('label') != 'shallow area'
                or feat['geometry']['type'] not in ('Polygon', 'MultiPolygon')):
            out.append(feat)
            continue
        geom = shape(feat['geometry']).buffer(0)
        nearby = [land_geoms[i] for i in tree.query(geom) if geom.intersects(land_geoms[i])]
        if not nearby:
            out.append(feat)
            continue
        diff = geom.difference(unary_union(nearby))
        if diff.is_empty:
            dropped += 1
            continue
        clipped += 1
        out.append({**feat, 'geometry': mapping(diff)})
    print(f'  Clipped {clipped} shallow-area polygons to the shoreline; dropped {dropped} fully on land')
    return out


def build_chart_bounds(hazard_features):
    """Build a single bounding box polygon from all hazard feature coordinates."""
    lons = [_feature_centroid(f)[0] for f in hazard_features]
    lats = [_feature_centroid(f)[1] for f in hazard_features]
    if not lons:
        return None
    minlon, maxlon = min(lons), max(lons)
    minlat, maxlat = min(lats), max(lats)
    # Add small buffer
    buf = 0.02
    ring = [
        [minlon - buf, minlat - buf],
        [maxlon + buf, minlat - buf],
        [maxlon + buf, maxlat + buf],
        [minlon - buf, maxlat + buf],
        [minlon - buf, minlat - buf],
    ]
    return {
        'type': 'FeatureCollection',
        'features': [{
            'type': 'Feature',
            'geometry': {'type': 'Polygon', 'coordinates': [ring]},
            'properties': {'description': 'Chart coverage area'},
        }],
    }


def load_raw(name):
    path = os.path.join(DATA_DIR, name)
    if not os.path.exists(path):
        print(f'  WARNING: {path} not found — run s57_to_geojson.py first')
        return []
    with open(path) as f:
        fc = json.load(f)
    return fc.get('features', [])


def write(features, name):
    fc = {'type': 'FeatureCollection', 'features': features}
    path = os.path.join(DATA_DIR, name)
    with open(path, 'w') as f:
        json.dump(fc, f, separators=(',', ':'))
    size_kb = os.path.getsize(path) // 1024
    print(f'  {name}: {len(features)} features, {size_kb} KB')


def deduplicate_channels(features):
    """Deduplicate FAIRWY polygon features by name — keep largest polygon per unique name."""
    seen = {}
    for f in features:
        name = f['properties'].get('name_lower') or f['properties'].get('name', '')
        if name not in seen:
            seen[name] = f
        else:
            # Prefer the polygon with more vertices — clipped slivers at tile boundaries have very few
            existing_pts = len(seen[name]['geometry']['coordinates'][0])
            new_pts = len(f['geometry']['coordinates'][0])
            if new_pts > existing_pts:
                seen[name] = f
    return list(seen.values())


def main():
    print('Loading raw GeoJSON files...')
    hazards = load_raw('hazards_raw.geojson')
    places = load_raw('named_places_raw.geojson')
    navaids = load_raw('navaid_raw.geojson')
    channels_raw_path = os.path.join(DATA_DIR, 'channels_raw.geojson')
    channels = load_raw('channels_raw.geojson') if os.path.exists(channels_raw_path) else []

    print(f'Raw counts: hazards={len(hazards)}, places={len(places)}, navaids={len(navaids)}')

    print('Deduplicating hazards...')
    hazards = deduplicate(hazards)

    print('Clipping shallow-area polygons to the shoreline...')
    hazards = clip_shallow_to_water(hazards)

    print('Deduplicating named places...')
    places = deduplicate_places(places)

    print('Deduplicating navaids...')
    navaids = deduplicate(navaids, radius_m=5.0)

    # Sort hazards: shallowest (most dangerous) first
    def hazard_sort_key(f):
        v = f['properties'].get('valsou')
        return v if v is not None else 999

    hazards.sort(key=hazard_sort_key)

    if channels:
        print('Deduplicating channels...')
        channels = deduplicate_channels(channels)

    print('Writing output files...')
    write(hazards, 'hazards.geojson')
    write(places, 'named_places.geojson')
    write(navaids, 'navaid.geojson')
    if channels:
        write(channels, 'channels.geojson')

    bounds = build_chart_bounds(hazards)
    if bounds:
        path = os.path.join(DATA_DIR, 'chart_bounds.geojson')
        with open(path, 'w') as f:
            json.dump(bounds, f, separators=(',', ':'))
        print(f'  chart_bounds.geojson: coverage polygon written')

    # Generate a version fingerprint from the navaid + hazard file contents.
    # Stored in data-version.json so the PWA can detect stale IndexedDB data.
    digest_input = b''
    for name in ('navaid.geojson', 'hazards.geojson', 'named_places.geojson'):
        p = os.path.join(DATA_DIR, name)
        with open(p, 'rb') as f:
            digest_input += f.read()
    version = hashlib.sha256(digest_input).hexdigest()[:16]
    version_path = os.path.join(DATA_DIR, 'data-version.json')
    with open(version_path, 'w') as f:
        json.dump({'version': version}, f)
    print(f'  data-version.json: {version}')

    print('\nMerge complete.')


if __name__ == '__main__':
    main()
