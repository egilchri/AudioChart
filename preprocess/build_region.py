#!/usr/bin/env python3
"""
Parameterized end-to-end pipeline for bringing up a new region.

Given NOAA ENC chart cells already downloaded locally for a target area
(same manual prerequisite the bundled Maine data has always assumed — this
does not fetch charts itself), runs the full extraction -> merge -> land ->
channel-graph -> validate pipeline and writes everything a new
CRUISE_PROFILES entry needs.

Usage:
    python3 preprocess/build_region.py <region_id> \
        --chart-dir ~/Documents/Charts/ENC/US_CA \
        --bbox 33.5,33.7,-117.95,-117.8 \
        --name "Newport Beach"

The region_id must NOT be "rockland_to_mdi" — that's the bundled default
region and is built by the existing bare invocations of each script
(s57_to_geojson.py, merge_charts.py, etc. with no --region flag), not this
orchestrator, so the bundled top-level www/data/ files are never at risk of
being overwritten by a new-region run.

Steps (stops on the first failure — no partial-success masking):
  1. s57_to_geojson.py   --region <id> --chart-dir <dir>
  2. backfill_light_names.py --region <id>
  3. merge_charts.py     --region <id>              -> www/data/regions/<id>/{hazards,named_places,navaid,channels,recommended_tracks,soundings,chart_bounds}.geojson
  4. build_channel_graph.py --region <id>            -> www/data/regions/<id>/channel_graph.geojson
  5. extract_land.py     --chart-dir <dir> --bbox <bbox> --region <id> -> www/data/regions/<id>/land.geojson
  6. chartdb.py          --chart-dir <dir>            (additive upsert into the shared server/charts.db)
  7. build_regions.py    --region <id> --bbox <bbox> --name <name> -> www/data/regions/<id>.json
  8. validate_output.py  --region <id> --bbox <bbox>
  9. Prints a ready-to-paste CRUISE_PROFILES stub.

Not automated: sourcing the region's ENC cells in the first place, and
adding the printed CRUISE_PROFILES stub to www/js/app.js — both stay manual.
"""
import argparse
import os
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, '../server'))


def run(cmd, cwd=None):
    print(f'\n$ {" ".join(cmd)}')
    result = subprocess.run(cmd, cwd=cwd)
    if result.returncode != 0:
        print(f'\nFAILED at: {" ".join(cmd)}')
        sys.exit(result.returncode)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('region_id', help='Region key, e.g. "newport-beach"')
    ap.add_argument('--chart-dir', required=True, help='Local directory of ENC .000 chart cells')
    ap.add_argument('--bbox', required=True, help='minlat,maxlat,minlon,maxlon')
    ap.add_argument('--name', required=True, help='Display name, e.g. "Newport Beach"')
    args = ap.parse_args()

    if args.region_id == 'rockland_to_mdi':
        print('ERROR: "rockland_to_mdi" is the bundled default region — build it with the '
              'individual scripts\' bare invocations (no --region flag), not this orchestrator.')
        sys.exit(1)

    chart_dir = os.path.expanduser(args.chart_dir)
    if not os.path.isdir(chart_dir):
        print(f'ERROR: --chart-dir not found: {chart_dir}')
        sys.exit(1)

    # This orchestrator needs a charts.yaml region entry to tell
    # s57_to_geojson.py which .000 chart cell files to process (that script
    # only extracts named layers from cells it's told about — it doesn't
    # walk chart_dir itself the way extract_land.py / chartdb.py do). Rather
    # than requiring a hand-edit before every run, discover every .000 file
    # under chart_dir and register/overwrite this region_id's entry in
    # charts.yaml as a {chart_dir, charts} dict — reproducible from --chart-dir
    # alone, matching how extract_land.py/chartdb.py already just scan the
    # whole directory.
    charts_yaml_path = os.path.join(SCRIPT_DIR, 'charts.yaml')
    rel_cells = []
    for root, _, files in os.walk(chart_dir):
        for fn in files:
            if fn.endswith('.000'):
                rel_cells.append(os.path.relpath(os.path.join(root, fn), chart_dir))
    rel_cells.sort()
    if not rel_cells:
        print(f'ERROR: no .000 ENC cells found under {chart_dir}')
        sys.exit(1)
    print(f'Found {len(rel_cells)} ENC cell(s) under {chart_dir}')

    import yaml
    with open(charts_yaml_path) as f:
        charts_config = yaml.safe_load(f)
    charts_config[args.region_id] = {'chart_dir': chart_dir, 'charts': rel_cells}
    with open(charts_yaml_path, 'w') as f:
        yaml.safe_dump(charts_config, f, sort_keys=False)
    print(f'Registered "{args.region_id}" in charts.yaml ({len(rel_cells)} cells)')

    py = sys.executable

    run([py, 's57_to_geojson.py', '--region', args.region_id, '--chart-dir', chart_dir], cwd=SCRIPT_DIR)
    run([py, 'backfill_light_names.py', '--region', args.region_id, '--bbox', args.bbox], cwd=SCRIPT_DIR)
    run([py, 'merge_charts.py', '--region', args.region_id], cwd=SCRIPT_DIR)
    run([py, 'build_channel_graph.py',
         '--channels', f'../www/data/regions/{args.region_id}/channels.geojson',
         '--tracks', f'../www/data/regions/{args.region_id}/recommended_tracks.geojson',
         '--out', f'../www/data/regions/{args.region_id}/channel_graph.geojson'], cwd=SCRIPT_DIR)
    run([py, 'extract_land.py', '--chart-dir', chart_dir, '--bbox', args.bbox, '--region', args.region_id], cwd=SCRIPT_DIR)
    run([py, 'chartdb.py', '--chart-dir', chart_dir], cwd=SERVER_DIR)
    run([py, 'build_regions.py', '--region', args.region_id, '--bbox', args.bbox, '--name', args.name], cwd=SCRIPT_DIR)
    run([py, 'validate_output.py', '--region', args.region_id, '--bbox', args.bbox], cwd=SCRIPT_DIR)

    print(f'''
Done. Next steps (manual):

1. Add a CRUISE_PROFILES entry in www/js/app.js:

  '{args.name}': {{
    dataUrl: './data/regions/{args.region_id}.json',
    stops: [
      // {{ name: '...', lat: 0, lon: 0 }},
    ],
  }},

2. Commit www/data/regions/{args.region_id}/, www/data/regions/{args.region_id}.json,
   preprocess/charts.yaml, and preprocess/regions.yaml, then push — GitHub
   Pages deploys the www/ directory as-is, no build step.
''')


if __name__ == '__main__':
    main()
