#!/usr/bin/env python3
"""
Merge and deduplicate raw GeoJSON files from s57_to_geojson.py.
Produces the final www/data/ files consumed by the PWA.

Pipeline order:
  1. python3 s57_to_geojson.py       — extract from NOAA ENC S-57 files
  2. python3 backfill_light_names.py — add names from NGA + manual overrides
  3. python3 merge_charts.py         — deduplicate and write final www/data/ files

Usage: python3 merge_charts.py [--region ID]
"""
import argparse
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


def clip_shallow_to_water(hazards, out_dir):
    """Subtract land geometry from 'shallow area' polygons.

    The chart's DEPARE depth bands are bounded by the low-water line, while
    land.geojson (LNDARE) is drawn at high water — so the two legitimately
    overlap in the foreshore/intertidal strip. That makes the depth overlay
    visually bleed onto what looks like dry land. Clipping to the charted
    shoreline keeps the rendered zones from spilling past the coastline.

    land.geojson comes from extract_land.py, which runs AFTER this script in
    the pipeline (see build_region.py) — so on a brand-new region's first-
    ever run this will find nothing yet and skip clipping (same graceful
    fallback the bundled default region has always had, since land.geojson
    there is simply whatever a previous run already produced).
    """
    land_path = os.path.join(out_dir, 'land.geojson')
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


def load_raw(raw_dir, name):
    path = os.path.join(raw_dir, name)
    if not os.path.exists(path):
        print(f'  WARNING: {path} not found — run s57_to_geojson.py first')
        return []
    with open(path) as f:
        fc = json.load(f)
    return fc.get('features', [])


def write(out_dir, features, name):
    fc = {'type': 'FeatureCollection', 'features': features}
    path = os.path.join(out_dir, name)
    os.makedirs(out_dir, exist_ok=True)
    with open(path, 'w') as f:
        json.dump(fc, f, separators=(',', ':'))
    size_kb = os.path.getsize(path) // 1024
    print(f'  {name}: {len(features)} features, {size_kb} KB')


def deduplicate_tracks(features):
    """Deduplicate RECTRC/NAVLNE LineString features — chained real-track
    segments from adjacent chart cells are expected and kept (they're
    genuinely different edges of one connected route); this only drops exact
    duplicate geometry, which happens when a segment sits fully inside more
    than one overlapping chart tile."""
    seen = set()
    out = []
    for f in features:
        key = (f['properties'].get('objtype'), tuple(tuple(c) for c in f['geometry']['coordinates']))
        if key in seen:
            continue
        seen.add(key)
        out.append(f)
    return out


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


def thin_soundings(features, cell_deg=0.003):
    """Thin soundings to one per ~240m grid cell, keeping the shallowest (safety-first).
    All depths included so the tooltip works everywhere, not just in shallow water."""
    grid = {}
    for f in features:
        lon, lat = f['geometry']['coordinates']
        cell = (round(lat / cell_deg), round(lon / cell_deg))
        depth = f['properties']['valsou']
        if cell not in grid or depth < grid[cell]['properties']['valsou']:
            grid[cell] = f
    return list(grid.values())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--region', default='rockland_to_mdi',
                     help='Region key matching the raw-file prefix from s57_to_geojson.py '
                          '--region (default: rockland_to_mdi, the bundled default region — '
                          'unprefixed raw files, output to the top-level www/data/)')
    args = ap.parse_args()

    # The bundled default region's raw/output paths are exactly what they've
    # always been (unprefixed, top-level www/data/) — zero behavior change.
    # Any other region reads its own prefixed raw files and writes to its own
    # www/data/regions/<id>/ subdirectory, never touching the default's files.
    is_default = args.region == 'rockland_to_mdi'
    raw_prefix = '' if is_default else f'{args.region}_'
    out_dir = DATA_DIR if is_default else os.path.join(DATA_DIR, 'regions', args.region)

    print(f'Loading raw GeoJSON files for region: {args.region}...')
    hazards = load_raw(DATA_DIR, f'{raw_prefix}hazards_raw.geojson')
    places = load_raw(DATA_DIR, f'{raw_prefix}named_places_raw.geojson')
    navaids = load_raw(DATA_DIR, f'{raw_prefix}navaid_raw.geojson')
    channels_raw_path = os.path.join(DATA_DIR, f'{raw_prefix}channels_raw.geojson')
    channels = load_raw(DATA_DIR, f'{raw_prefix}channels_raw.geojson') if os.path.exists(channels_raw_path) else []
    tracks_raw_path = os.path.join(DATA_DIR, f'{raw_prefix}recommended_tracks_raw.geojson')
    tracks = load_raw(DATA_DIR, f'{raw_prefix}recommended_tracks_raw.geojson') if os.path.exists(tracks_raw_path) else []
    soundings_raw_path = os.path.join(DATA_DIR, f'{raw_prefix}soundings_raw.geojson')
    soundings = load_raw(DATA_DIR, f'{raw_prefix}soundings_raw.geojson') if os.path.exists(soundings_raw_path) else []

    print(f'Raw counts: hazards={len(hazards)}, places={len(places)}, navaids={len(navaids)}')

    print('Deduplicating hazards...')
    hazards = deduplicate(hazards)

    print('Clipping shallow-area polygons to the shoreline...')
    hazards = clip_shallow_to_water(hazards, out_dir)

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

    if tracks:
        print('Deduplicating recommended tracks...')
        tracks = deduplicate_tracks(tracks)

    if soundings:
        print(f'Thinning soundings ({len(soundings)} → ', end='', flush=True)
        soundings = thin_soundings(soundings)
        print(f'{len(soundings)})...')

    print(f'Writing output files to {out_dir}...')
    write(out_dir, hazards, 'hazards.geojson')
    write(out_dir, places, 'named_places.geojson')
    write(out_dir, navaids, 'navaid.geojson')
    if channels:
        write(out_dir, channels, 'channels.geojson')
    if tracks:
        write(out_dir, tracks, 'recommended_tracks.geojson')
    if soundings:
        write(out_dir, soundings, 'soundings.geojson')

    bounds = build_chart_bounds(hazards)
    if bounds:
        path = os.path.join(out_dir, 'chart_bounds.geojson')
        with open(path, 'w') as f:
            json.dump(bounds, f, separators=(',', ':'))
        print(f'  chart_bounds.geojson: coverage polygon written')

    # Generate a version fingerprint from this region's own file contents —
    # per-region for a non-default region so the PWA's per-region IndexedDB
    # staleness check (see query.js) is scoped correctly; the default
    # region's data-version.json stays at its exact original top-level path.
    digest_input = b''
    for name in ('navaid.geojson', 'hazards.geojson', 'named_places.geojson'):
        p = os.path.join(out_dir, name)
        with open(p, 'rb') as f:
            digest_input += f.read()
    version = hashlib.sha256(digest_input).hexdigest()[:16]
    version_path = os.path.join(out_dir, 'data-version.json')
    with open(version_path, 'w') as f:
        json.dump({'version': version}, f)
    print(f'  data-version.json: {version}')

    print('\nMerge complete.')


if __name__ == '__main__':
    main()
