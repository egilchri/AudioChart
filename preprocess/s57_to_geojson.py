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
                features.append({
                    'type': 'Feature',
                    'geometry': {'type': 'Point', 'coordinates': centroid_point(geom)},
                    'properties': {
                        'objtype': DEPTH_LAYER,
                        'label': OBJTYPE_LABEL[DEPTH_LAYER],
                        'valsou': drval2,
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
                colours = props.get('COLOUR')
                colour_str = None
                if colours:
                    from s57_codes import COLOUR_LABEL
                    colour_str = '/'.join(
                        COLOUR_LABEL.get(int(c), str(c))
                        for c in (colours if isinstance(colours, list) else [colours])
                    )
                features.append({
                    'type': 'Feature',
                    'geometry': {'type': 'Point', 'coordinates': centroid_point(geom)},
                    'properties': {
                        'objtype': layer_name,
                        'label': OBJTYPE_LABEL.get(layer_name, 'navaid'),
                        'name': props.get('OBJNAM'),
                        'colour': colour_str,
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
        print(f' hazards={len(hazards)} places={len(places)} navaids={len(navaids)}')
        return hazards, places, navaids
    except Exception as e:
        print(f' ERROR: {e}')
        return [], [], []


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
    args = parser.parse_args()

    config_path = os.path.join(SCRIPT_DIR, 'charts.yaml')
    with open(config_path) as f:
        config = yaml.safe_load(f)

    chart_dir = config['chart_dir']
    output_dir = os.path.normpath(os.path.join(SCRIPT_DIR, config['output_dir']))
    chart_list = config.get(args.region, [])

    if not chart_list:
        print(f'ERROR: region "{args.region}" not found in charts.yaml')
        sys.exit(1)

    print(f'Processing {len(chart_list)} charts for region: {args.region}')

    all_hazards, all_places, all_navaids = [], [], []
    for rel_path in chart_list:
        enc_path = os.path.join(chart_dir, rel_path)
        if not os.path.exists(enc_path):
            print(f'  SKIP (not found): {rel_path}')
            continue
        h, p, n = process_chart(enc_path)
        all_hazards.extend(h)
        all_places.extend(p)
        all_navaids.extend(n)

    print(f'\nTotals before merge: hazards={len(all_hazards)} places={len(all_places)} navaids={len(all_navaids)}')

    os.makedirs(output_dir, exist_ok=True)
    write_geojson(all_hazards, os.path.join(output_dir, 'hazards_raw.geojson'))
    write_geojson(all_places, os.path.join(output_dir, 'named_places_raw.geojson'))
    write_geojson(all_navaids, os.path.join(output_dir, 'navaid_raw.geojson'))

    print('\nDone. Run merge_charts.py next.')


if __name__ == '__main__':
    main()
