#!/usr/bin/env python3
"""
Parse NOAA S-57 ENC charts into GeoJSON for AudioChart.
Usage: python3 s57_to_geojson.py [--region rockland_vinalhaven]
"""
import argparse
import json
import os
import sys

import fiona
import yaml
from shapely.geometry import mapping, shape

from s57_codes import (
    DEPTH_LAYER, HAZARD_LAYERS, HAZARDOUS_WATLEV, NAMED_PLACE_LAYERS,
    NAVAID_LAYERS, OBJTYPE_LABEL, SHALLOW_DEPTH_THRESHOLD_M,
)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def centroid_point(geom):
    """Return [lon, lat] centroid of any geometry."""
    s = shape(geom)
    c = s.centroid
    return [c.x, c.y]


def extract_hazards(enc_path, chart_id):
    """Extract hazard features from UWTROC, OBSTRN, WRECKS, shallow DEPARE."""
    features = []
    layers = set(fiona.listlayers(enc_path))

    for layer_name in HAZARD_LAYERS:
        if layer_name not in layers:
            continue
        with fiona.open(enc_path, layer=layer_name) as src:
            for feat in src:
                geom = feat.get('geometry')
                if not geom:
                    continue
                props = feat['properties']
                watlev = props.get('WATLEV')
                # Skip features that are permanently dry/above water (WATLEV=3)
                if watlev == 3:
                    continue
                features.append({
                    'type': 'Feature',
                    'geometry': {'type': 'Point', 'coordinates': centroid_point(geom)},
                    'properties': {
                        'objtype': layer_name,
                        'label': OBJTYPE_LABEL[layer_name],
                        'valsou': props.get('VALSOU'),
                        'watlev': watlev,
                        'name': props.get('OBJNAM'),
                        'chart': chart_id,
                    },
                })

    if DEPTH_LAYER in layers:
        with fiona.open(enc_path, layer=DEPTH_LAYER) as src:
            for feat in src:
                geom = feat.get('geometry')
                if not geom:
                    continue
                props = feat['properties']
                drval2 = props.get('DRVAL2')
                if drval2 is None or drval2 > SHALLOW_DEPTH_THRESHOLD_M:
                    continue
                drval1 = props.get('DRVAL1')
                depth_label = ''
                if drval1 is not None and drval2 is not None:
                    depth_label = f'{drval1:.1f}-{drval2:.1f}m'
                # Use drval1 (shallowest bound) for safety checks — drval2 is the
                # deeper bound and gives a false impression of safety at high tide.
                # For intertidal zones, drval1 < 0 (above MLLW), so effective depth
                # = drval1 + tideHeight can still be negative (exposed) at high tide.
                simplified = shape(geom).simplify(0.0001, preserve_topology=True)
                features.append({
                    'type': 'Feature',
                    'geometry': mapping(simplified),
                    'properties': {
                        'objtype': DEPTH_LAYER,
                        'label': OBJTYPE_LABEL[DEPTH_LAYER],
                        'valsou': drval1 if drval1 is not None else drval2,
                        'depth_label': depth_label,
                        'chart': chart_id,
                    },
                })

    return features


def extract_named_places(enc_path, chart_id):
    """Extract named sea areas, land regions, harbors, anchorages, fairways."""
    features = []
    layers = set(fiona.listlayers(enc_path))

    for layer_name in NAMED_PLACE_LAYERS:
        if layer_name not in layers:
            continue
        with fiona.open(enc_path, layer=layer_name) as src:
            for feat in src:
                geom = feat.get('geometry')
                if not geom:
                    continue
                name = feat['properties'].get('OBJNAM')
                if not name or len(name.strip()) < 2:
                    continue
                # Skip generic single-letter anchorage labels like "A", "B"
                if len(name.strip()) <= 2 and name.strip().isalpha():
                    continue
                name = name.strip()
                features.append({
                    'type': 'Feature',
                    'geometry': {'type': 'Point', 'coordinates': centroid_point(geom)},
                    'properties': {
                        'objtype': layer_name,
                        'label': OBJTYPE_LABEL.get(layer_name, layer_name.lower()),
                        'name': name,
                        'name_lower': name.lower(),
                        'chart': chart_id,
                    },
                })

    return features


def build_light_characteristic(props):
    """Build a light characteristic string (e.g. 'Fl(1) W 5s') from S-57 LIGHTS properties."""
    from s57_codes import LITCHR_ABBR, LIGHT_COLOUR_ABBR
    litchr  = props.get('LITCHR')
    sigper  = props.get('SIGPER')
    siggrp  = (props.get('SIGGRP') or '').strip('()')  # S-57 may include parens already
    colours = props.get('COLOUR')

    char_abbr = LITCHR_ABBR.get(int(litchr), '') if litchr else ''
    if not char_abbr:
        return None

    grp = f'({siggrp})' if siggrp else ''

    col_abbr = ''
    if colours:
        codes = colours if isinstance(colours, list) else [colours]
        col_abbr = '/'.join(
            LIGHT_COLOUR_ABBR.get(int(c), '') for c in codes
        ).strip('/')

    period = f' {int(sigper)}s' if sigper else ''

    parts = [char_abbr, grp]
    if col_abbr:
        parts.append(f' {col_abbr}')
    parts.append(period)
    return ''.join(parts).strip() or None


def extract_navaids(enc_path, chart_id):
    """Extract buoys, beacons, and lights."""
    features = []
    layers = set(fiona.listlayers(enc_path))

    for layer_name in NAVAID_LAYERS:
        if layer_name not in layers:
            continue
        with fiona.open(enc_path, layer=layer_name) as src:
            for feat in src:
                geom = feat.get('geometry')
                if not geom:
                    continue
                props = feat['properties']

                # Colour: use display names for buoys/beacons, abbreviations baked
                # into characteristic for lights
                colours = props.get('COLOUR')
                colour_str = None
                if colours:
                    from s57_codes import COLOUR_LABEL
                    colour_str = '/'.join(
                        COLOUR_LABEL.get(int(c), str(c))
                        for c in (colours if isinstance(colours, list) else [colours])
                    )

                # Light characteristic and range (LIGHTS layer only)
                characteristic = None
                height_m = None
                range_nm = None
                if layer_name == 'LIGHTS':
                    characteristic = build_light_characteristic(props)
                    height_m = props.get('HEIGHT')
                    range_nm = props.get('VALNMR')

                features.append({
                    'type': 'Feature',
                    'geometry': {'type': 'Point', 'coordinates': centroid_point(geom)},
                    'properties': {
                        'objtype':        layer_name,
                        'label':          OBJTYPE_LABEL.get(layer_name, 'navaid'),
                        'name':           props.get('OBJNAM'),
                        'colour':         colour_str,
                        'characteristic': characteristic,
                        'height_m':       height_m,
                        'range_nm':       range_nm,
                        'chart':          chart_id,
                    },
                })

    return features


def extract_soundings(enc_path, chart_id):
    """Extract SOUNDG depth sounding points. Z coord is charted depth in meters (MLLW)."""
    features = []
    layers = set(fiona.listlayers(enc_path))
    if 'SOUNDG' not in layers:
        return features
    with fiona.open(enc_path, layer='SOUNDG') as src:
        for feat in src:
            geom = feat.get('geometry')
            if not geom or geom['type'] != 'MultiPoint':
                continue
            for coord in geom['coordinates']:
                if len(coord) < 3:
                    continue
                lon, lat, depth = coord[0], coord[1], coord[2]
                features.append({
                    'type': 'Feature',
                    'geometry': {'type': 'Point', 'coordinates': [round(lon, 6), round(lat, 6)]},
                    'properties': {
                        'objtype': 'SOUNDG',
                        'valsou': round(depth, 1),
                        'chart': chart_id,
                    },
                })
    return features


def extract_channels(enc_path, chart_id):
    """Extract FAIRWY (fairway/channel) polygon features with real geometry."""
    features = []
    layers = set(fiona.listlayers(enc_path))
    if 'FAIRWY' not in layers:
        return features
    with fiona.open(enc_path, layer='FAIRWY') as src:
        for feat in src:
            geom = feat.get('geometry')
            if not geom or geom['type'] not in ('Polygon', 'MultiPolygon'):
                continue
            name = (feat['properties'].get('OBJNAM') or '').strip()
            if not name:
                continue
            simplified = shape(geom).simplify(0.00005, preserve_topology=True)
            features.append({
                'type': 'Feature',
                'geometry': mapping(simplified),
                'properties': {
                    'objtype': 'FAIRWY',
                    'label': 'channel',
                    'name': name,
                    'name_lower': name.lower(),
                    'chart': chart_id,
                },
            })
    return features


def extract_recommended_tracks(enc_path, chart_id):
    """
    Extract RECTRC (recommended track) and NAVLNE (navigation line) LineString
    features — real, charted routable lines (a harbor pilot's actual approach
    track), unlike FAIRWY which is only an area outline with no centerline.
    Where both exist for the same passage, NAVLNE is typically the finer-grained
    trace and RECTRC the officially-designated subset — both are kept and
    deduped downstream (merge_charts.py) since consecutive charts' segments
    chain together into one continuous track (e.g. Portsmouth Harbor's
    approach, which spans US5PSMBD/US5PSMCD/US5PSMCC as separate chart cells).
    """
    features = []
    layers = set(fiona.listlayers(enc_path))
    for layer_name in ('RECTRC', 'NAVLNE'):
        if layer_name not in layers:
            continue
        with fiona.open(enc_path, layer=layer_name) as src:
            for feat in src:
                geom = feat.get('geometry')
                if not geom or geom['type'] != 'LineString':
                    continue
                props = feat['properties']
                name = (props.get('OBJNAM') or '').strip()
                coords = [[round(c[0], 6), round(c[1], 6)] for c in geom['coordinates']]
                features.append({
                    'type': 'Feature',
                    'geometry': {'type': 'LineString', 'coordinates': coords},
                    'properties': {
                        'objtype': layer_name,
                        'label': 'recommended_track',
                        'name': name,
                        'name_lower': name.lower(),
                        'chart': chart_id,
                    },
                })
    return features


def process_chart(enc_path):
    chart_id = os.path.splitext(os.path.basename(enc_path))[0]
    print(f'  Processing {chart_id}...', end='', flush=True)
    try:
        hazards = extract_hazards(enc_path, chart_id)
        places = extract_named_places(enc_path, chart_id)
        navaids = extract_navaids(enc_path, chart_id)
        channels = extract_channels(enc_path, chart_id)
        tracks = extract_recommended_tracks(enc_path, chart_id)
        soundings = extract_soundings(enc_path, chart_id)
        print(f' hazards={len(hazards)} places={len(places)} navaids={len(navaids)} channels={len(channels)} tracks={len(tracks)} soundings={len(soundings)}')
        return hazards, places, navaids, channels, tracks, soundings
    except Exception as e:
        print(f' ERROR: {e}')
        return [], [], [], [], [], []


def write_geojson(features, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fc = {'type': 'FeatureCollection', 'features': features}
    with open(path, 'w') as f:
        json.dump(fc, f, separators=(',', ':'))
    print(f'  Wrote {len(features)} features → {path}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--region', default='rockland_to_mdi',
                        help='Region key from charts.yaml (default: rockland_to_mdi)')
    parser.add_argument('--chart-dir', default=None,
                        help='Override the ENC source directory (charts.yaml\'s '
                             'global chart_dir, or a region entry\'s own chart_dir, '
                             'still apply if this is omitted)')
    args = parser.parse_args()

    config_path = os.path.join(SCRIPT_DIR, 'charts.yaml')
    with open(config_path) as f:
        config = yaml.safe_load(f)

    output_dir = os.path.normpath(os.path.join(SCRIPT_DIR, config['output_dir']))
    region_entry = config.get(args.region)

    if not region_entry:
        print(f'ERROR: region "{args.region}" not found in charts.yaml')
        sys.exit(1)

    # A region entry is either a flat list of chart paths (uses the global
    # chart_dir) or a dict {chart_dir, charts} overriding it for regions whose
    # ENC cells live under a different local directory than the default.
    if isinstance(region_entry, dict):
        chart_list = region_entry.get('charts', [])
        chart_dir = region_entry.get('chart_dir', config['chart_dir'])
    else:
        chart_list = region_entry
        chart_dir = config['chart_dir']
    if args.chart_dir:
        chart_dir = args.chart_dir

    if not chart_list:
        print(f'ERROR: region "{args.region}" has no charts listed')
        sys.exit(1)

    print(f'Processing {len(chart_list)} charts for region: {args.region} (chart_dir={chart_dir})')

    all_hazards, all_places, all_navaids, all_channels, all_tracks, all_soundings = [], [], [], [], [], []
    for rel_path in chart_list:
        enc_path = os.path.join(chart_dir, rel_path)
        if not os.path.exists(enc_path):
            print(f'  SKIP (not found): {rel_path}')
            continue
        h, p, n, c, t, s = process_chart(enc_path)
        all_hazards.extend(h)
        all_places.extend(p)
        all_navaids.extend(n)
        all_channels.extend(c)
        all_tracks.extend(t)
        all_soundings.extend(s)

    print(f'\nTotals before merge: hazards={len(all_hazards)} places={len(all_places)} navaids={len(all_navaids)} channels={len(all_channels)} tracks={len(all_tracks)} soundings={len(all_soundings)}')

    os.makedirs(output_dir, exist_ok=True)
    write_geojson(all_hazards, os.path.join(output_dir, 'hazards_raw.geojson'))
    write_geojson(all_places, os.path.join(output_dir, 'named_places_raw.geojson'))
    write_geojson(all_navaids, os.path.join(output_dir, 'navaid_raw.geojson'))
    write_geojson(all_channels, os.path.join(output_dir, 'channels_raw.geojson'))
    write_geojson(all_tracks, os.path.join(output_dir, 'recommended_tracks_raw.geojson'))
    write_geojson(all_soundings, os.path.join(output_dir, 'soundings_raw.geojson'))

    print('\nDone. Run merge_charts.py next.')


if __name__ == '__main__':
    main()
