#!/usr/bin/env python3
"""
Build a supplementary navigable-water routing mesh for a hard,
multi-island passage where the router's ad-hoc, per-query candidate-node
generation structurally fails to find any connected path even though
real open water exists.

Background (Deer Isle / Eggemoggin Reach pilot, 2026-09-27/28): AutoRoute
from south of Deer Isle into Eggemoggin Reach failed completely — not a
timeout, a genuine "no path found" after the router's A* exhausted its
entire candidate graph. Root-caused live: the router builds its search
graph fresh per query from land-ring vertices near the direct start-end
line (see www/js/router.js's _addRingNodes/_pickExtremeVerts). That
places plenty of candidate points on EACH side of a complex multi-island
passage, but has no guarantee any combination of them chains all the way
through — not a budget problem (3x-ing the router's node/ring caps
changed nothing), not sparse candidates (hundreds of nodes already exist
on both sides), and not a missing-buoy-data bug (the real charted buoy
chains on each side are genuinely ~3.35nm apart with no markers between
them — SPATIAL_MAX_GAP_NM in build_channel_graph.py correctly declines
to bridge a gap that large, because the real chart has none).

This script precomputes a mesh of points that already trace connected
paths through real open water in a hard region, using the EXACT SAME
medial-axis technique build_channel_graph.py already uses for real
charted channels (boundary-point Voronoi diagram of a water polygon) —
just pointed at a computed "bbox minus land" polygon instead of a single
charted FAIRWY polygon.

IMPORTANT SAFETY NOTE, do not change without re-reading this: unlike
channel_graph.geojson (built from independently-surveyed NOAA ENC data,
and consumed by the router via Query.channelNeighbors WITHOUT a runtime
land-crossing check — see router.js's own comment on that), this mesh is
DERIVED from the exact same land.geojson the runtime already checks
against, via a geometric pipeline that can have real edge cases
(precision loss from densify/simplify, a thin sliver collapsing near a
tricky coastline). It has no independent survey basis to justify
bypassing the runtime safety check. It MUST be consumed as ordinary
candidate nodes (Query.waterMeshNodesNear), never wired into the
trusted/unchecked channelNeighbors-style edge pathway. See router.js's
own water-mesh node-seeding block for where this is enforced at runtime.

Output schema matches channel_graph.geojson exactly (one edge per
Feature, LineString, {source, channelName} properties) so the existing
JS loader pattern (www/js/query.js's _buildChannelIndex-style consumer)
needs no format changes — see Query.waterMeshNodesNear.

Usage:
  python3 build_water_mesh.py --land PATH --hazards PATH --soundings PATH \
      --bbox minlon,minlat,maxlon,maxlat --out PATH \
      [--label NAME] [--min-piece-area-m2 N] [--ref-draft-ft N]

Insights worth reusing for the next pilot area/region (see the plan this
was built from, and the project's own memory notes, for more):
  - Derive the pilot --bbox from the ROUTER's own observed search bbox
    for the actual failing case (dump nodes[] bounds during a live
    repro), not a guess — that's exactly the area the fix needs to cover.
  - A regional water polygon needs its OWN tuning constants below, not
    build_channel_graph.py's channel-shape-tuned adaptive_params/quality
    gate (TARGET_BOUNDARY_POINTS=220, the ">25 edges + junction" skip,
    longest_path_or_full_graph's single-chain collapse) — all three
    assume one small, mostly-linear polygon and are WRONG for a mesh
    that's supposed to be densely branching. This script reuses only the
    primitives that have no such assumption baked in.
  - Always do the manual sanity check (render bbox + mesh together,
    confirm every edge runs through real water) before shipping — this
    data has no independent survey basis to fall back on.
"""
import argparse
import json
import math
import os

from shapely.geometry import shape, box, LineString
from shapely.ops import transform as shp_transform, unary_union
from shapely.strtree import STRtree

from build_channel_graph import (
    local_transformers, medial_axis_edges, snap_nodes, prune_spurs,
    break_artifact_cycles, refresh_data_version,
)

# Region-scale tuning. A whole-region water polygon's boundary is
# dominated by real coastline length, not "one channel's length" the way
# build_channel_graph.py's adaptive_params (TARGET_BOUNDARY_POINTS=220
# spread over the polygon's own perimeter) assumes — 220 points over a
# multi-mile coastline would be far too coarse for a usable medial axis.
# Fixed absolute spacing instead; tune per pilot if a piece comes out too
# sparse/noisy (see the manual sanity check in the module docstring).
DENSIFY_SPACING_M = 80.0
PRUNE_SPUR_M = DENSIFY_SPACING_M * 1.5
SNAP_GRID_M = DENSIFY_SPACING_M * 0.4
DEFAULT_MIN_PIECE_AREA_M2 = 2000.0  # drop tidal-puddle-sized water slivers
MIN_HAZARD_AREA_DEG2 = 1e-5  # ~roughly a few acres at this latitude — see water_polygon's comment
# Matches router.js's own KEEL_CLEARANCE_MARGIN_M / SOUNDING_SEARCH_RADIUS_NM
# exactly — this script's real-soundings carve-out is meant to agree with
# the router's own _soundingsClearCrossing rescue, not invent its own
# margin/radius policy.
KEEL_CLEARANCE_MARGIN_M = 3 * 0.3048  # 3ft
SOUNDING_SEARCH_RADIUS_M = 0.15 * 1852.0  # 0.15nm


def water_polygon(bbox_lonlat, land_features, shallow_features, soundings_features, ref_draft_m):
    """Pilot bbox minus the union of land polygons AND genuinely-too-
    shallow depth-zone polygons intersecting it — same difference-based
    technique as merge_charts.py's clip_shallow_to_water (STRtree +
    unary_union + .difference()), just scoped to a whole bounding area
    instead of one hazard polygon.

    Three iterations got here, each a real bug found live, not assumed:
    (1) Land-only: checked the resulting mesh's own edges against the
        router's real runtime check afterward and found 29% of them
        (1826 of 6257) inside a charted shallow-area polygon the router
        would actually block — the mesh must not silently disagree with
        the thing it's supplementing.
    (2) Subtract every "too shallow at ref draft" polygon wholesale: a
        charted shallow-area polygon's own valsou is a single worst-case
        value for its WHOLE extent (the same coarse-vs-real theme this
        project keeps running into elsewhere) — most of the thousands of
        matching polygons are individual rock/ledge markers a few meters
        across. Subtracting all of them fragmented the water polygon into
        thousands of disconnected slivers (confirmed live: 3315 pieces).
    (3) Restrict to significant-AREA hazards, but erode each by a fixed
        margin before subtracting: fixed far less fragmentation, but a
        uniform blind erosion is itself the same class of bug one level
        down — too little margin left a genuine, large hazard's core in
        the mesh (confirmed live: a 28-consecutive-edge stretch of the
        medial axis still ran straight through Tinker Ledges, a real
        charted ledge field, and the router's OWN segBlocked correctly
        rejected it, 89 of 575 edges on that specific path); too much
        margin cut off the mesh's own access to real destinations that
        happen to sit close to a hazard's charted boundary.

    This version instead mirrors the router's OWN rescue logic
    (router.js's _soundingsClearCrossing) directly, rather than
    approximating it with a blind buffer: before subtracting a
    significant hazard polygon, carve OUT of it the union of small
    circles around every real nearby sounding that shows genuine depth
    at ref_draft_m (same search-radius idea as the router's own
    SOUNDING_SEARCH_RADIUS_NM) — so the parts of a charted hazard a real
    sounding actually confirms are navigable get left in the water
    polygon, and only the parts with no such confirmation get excluded.
    This is the same "unverified stays conservative, real data can
    override the coarse worst-case" policy already used throughout this
    project, just applied here instead of only at query time."""
    bbox_geom = box(*bbox_lonlat)
    land_geoms = [shape(f['geometry']).buffer(0) for f in land_features]

    draft_with_margin_m = ref_draft_m + KEEL_CLEARANCE_MARGIN_M
    good_sounding_circles = []
    for f in soundings_features:
        valsou = f['properties'].get('valsou')
        if valsou is None or valsou <= draft_with_margin_m:
            continue  # not confirmed deep enough to carve anything out with
        lon, lat = f['geometry']['coordinates']
        cv = max(math.cos(math.radians(lat)), 0.01)
        good_sounding_circles.append(
            shape({'type': 'Point', 'coordinates': [lon, lat]})
            .buffer(1.0, resolution=8)
        )
        # Scale the unit circle to an ellipse of SOUNDING_SEARCH_RADIUS_M
        # in real meters, same trick build_channel_graph.py's own
        # load_hazard_corridor_tree already uses for exactly this reason.
        good_sounding_circles[-1] = shp_transform(
            lambda x, y, cx=lon, cy=lat: (
                cx + (x - cx) * SOUNDING_SEARCH_RADIUS_M / (111320.0 * cv),
                cy + (y - cy) * SOUNDING_SEARCH_RADIUS_M / 111320.0,
            ),
            good_sounding_circles[-1],
        )
    good_soundings_union = unary_union(good_sounding_circles) if good_sounding_circles else None
    print(f'  {len(good_sounding_circles)} real sounding(s) confirm >{ref_draft_m + KEEL_CLEARANCE_MARGIN_M:.1f}m depth '
          f'— their coverage will be carved back out of any hazard subtracted below')

    shallow_geoms = []
    for f in shallow_features:
        valsou = f['properties'].get('valsou')
        if valsou is None or valsou > ref_draft_m:
            continue  # deep enough at the reference draft — leave it navigable
        geom = shape(f['geometry']).buffer(0)
        if geom.area < MIN_HAZARD_AREA_DEG2:
            # Small individual rock/ledge markers — leave these for the
            # router's own live, real-soundings-aware segBlocked check to
            # handle per-query, same as it already does for every route.
            continue
        if good_soundings_union is not None:
            geom = geom.difference(good_soundings_union)
        if geom.is_empty:
            continue
        shallow_geoms.append(geom)
    blockers = land_geoms + shallow_geoms
    if not blockers:
        return bbox_geom
    tree = STRtree(blockers)
    nearby = [blockers[i] for i in tree.query(bbox_geom) if bbox_geom.intersects(blockers[i])]
    if not nearby:
        return bbox_geom
    return bbox_geom.difference(unary_union(nearby))


def build_risk_hazard_index(shallow_features, soundings_features, ref_draft_m):
    """Small, targeted hazard set used only to TAG mesh edges 'risky',
    never to drop them. This is deliberately NOT another attempt at the
    precise per-edge segBlocked port that was tried and reverted earlier
    (2026-09-28) — that dropped edges outright and fragmented the medial
    axis's already-thin redundancy, breaking connectivity everywhere,
    including the already-shipped penobscot-bay fix.

    Here the same "too shallow at ref draft, minus real-sounding
    rescue" test water_polygon() already applies to SIGNIFICANT hazards
    is applied again, but to EVERY shallow-area polygon regardless of
    size (including the small rock/ledge markers water_polygon()
    deliberately leaves in the water polygon for the router's own live
    check to handle — see its comment). A large, already-subtracted
    hazard can never geometrically intersect a medial-axis edge (the
    polygon that generated the mesh already excludes it), so tagging
    against the full set is a safe no-op there; it only has teeth against
    the small hazards the mesh's own geometry doesn't already avoid —
    exactly the class of case (e.g. a small charted rock a medial-axis
    lane threads past) a real live segBlocked call would still reject at
    query time regardless of this tag. The tag is a cost hint for
    Query.waterMeshPath's precomputed Dijkstra so it prefers an existing,
    already-safe detour over an existing-but-risky shortcut; it changes
    no safety behavior on its own — every mesh edge, risky or not, still
    goes through the router's real, live segBlocked check on every
    query."""
    draft_with_margin_m = ref_draft_m + KEEL_CLEARANCE_MARGIN_M
    good_sounding_circles = []
    for f in soundings_features:
        valsou = f['properties'].get('valsou')
        if valsou is None or valsou <= draft_with_margin_m:
            continue
        lon, lat = f['geometry']['coordinates']
        cv = max(math.cos(math.radians(lat)), 0.01)
        circle = shape({'type': 'Point', 'coordinates': [lon, lat]}).buffer(1.0, resolution=8)
        circle = shp_transform(
            lambda x, y, cx=lon, cy=lat: (
                cx + (x - cx) * SOUNDING_SEARCH_RADIUS_M / (111320.0 * cv),
                cy + (y - cy) * SOUNDING_SEARCH_RADIUS_M / 111320.0,
            ),
            circle,
        )
        good_sounding_circles.append(circle)
    good_soundings_union = unary_union(good_sounding_circles) if good_sounding_circles else None

    risk_geoms = []
    for f in shallow_features:
        valsou = f['properties'].get('valsou')
        if valsou is None or valsou > ref_draft_m:
            continue
        geom = shape(f['geometry']).buffer(0)
        if good_soundings_union is not None:
            geom = geom.difference(good_soundings_union)
        if geom.is_empty:
            continue
        # Small conservative buffer (matches the keel-clearance margin, in
        # degrees at this latitude) — a cost hint should lean cautious
        # about near-misses, not just literal polygon crossings, since
        # it only ever nudges Dijkstra's preference, never blocks a path.
        risk_geoms.append(geom.buffer(KEEL_CLEARANCE_MARGIN_M / 111320.0))
    if not risk_geoms:
        return None, []
    return STRtree(risk_geoms), risk_geoms


def edge_is_risky(hazard_tree, hazard_geoms, a_lonlat, b_lonlat):
    if hazard_tree is None:
        return False
    line = LineString([a_lonlat, b_lonlat])
    for idx in hazard_tree.query(line):
        if line.intersects(hazard_geoms[idx]):
            return True
    return False


def water_piece_to_edges(poly, min_piece_area_m2, hazard_tree=None, hazard_geoms=None):
    """One connected water polygon -> medial-axis mesh edges. Reuses
    build_channel_graph.py's medial_axis_edges/snap_nodes/prune_spurs/
    break_artifact_cycles pipeline UNMODIFIED (none of them have any
    fairway-specific assumption baked in) with this module's own
    region-scale tuning constants. Deliberately skips
    longest_path_or_full_graph's single-chain collapse and
    channel_to_edges's "too many edges + has a junction" quality gate —
    both are wrong here: a real regional water piece is SUPPOSED to be a
    densely-branching graph (it needs to cover a reach, a thorofare, and
    the open water south of an island all at once), not reduce to one
    lane or get rejected for having real junctions.

    Every edge is kept regardless of risk (see build_risk_hazard_index's
    docstring for why dropping was tried and reverted) — hazard_tree/
    hazard_geoms, if given, only decide the 'risky' property returned
    alongside each edge for the caller to write into output properties."""
    if poly.is_empty or poly.area <= 0:
        return []
    c = poly.centroid
    fwd, inv = local_transformers(c.x, c.y)
    poly_m = shp_transform(lambda x, y: fwd.transform(x, y), poly)
    if poly_m.area < min_piece_area_m2:
        return []
    edges_m = medial_axis_edges(poly_m, DENSIFY_SPACING_M)
    edges_m = snap_nodes(edges_m, SNAP_GRID_M)
    edges_m = prune_spurs(edges_m, PRUNE_SPUR_M)
    edges_m = break_artifact_cycles(edges_m)
    out = []
    for (ax, ay), (bx, by) in edges_m:
        alon, alat = inv.transform(ax, ay)
        blon, blat = inv.transform(bx, by)
        risky = edge_is_risky(hazard_tree, hazard_geoms, (alon, alat), (blon, blat))
        out.append(((alon, alat), (blon, blat), risky))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--land', required=True, help='land.geojson to subtract')
    ap.add_argument('--hazards', required=True,
                     help='hazards.geojson (its "shallow area" polygons are also subtracted)')
    ap.add_argument('--soundings', required=True,
                     help='soundings.geojson (real depth points used to carve confirmed-deep '
                          'water back out of a subtracted hazard polygon)')
    ap.add_argument('--bbox', required=True,
                     help='minlon,minlat,maxlon,maxlat pilot bounding box')
    ap.add_argument('--out', required=True, help='output water_mesh_*.geojson path')
    ap.add_argument('--label', default='water mesh',
                     help='piece-name prefix stored in properties.channelName')
    ap.add_argument('--min-piece-area-m2', type=float, default=DEFAULT_MIN_PIECE_AREA_M2)
    ap.add_argument('--ref-draft-ft', type=float, default=6.0,
                     help='conservative reference draft (deeper than most cruising boats) used to '
                          'decide which charted shallow-area polygons are too shallow to mesh through')
    args = ap.parse_args()

    bbox = tuple(float(x) for x in args.bbox.split(','))
    with open(args.land) as f:
        land_features = json.load(f).get('features', [])
    with open(args.hazards) as f:
        hazard_features = json.load(f).get('features', [])
    with open(args.soundings) as f:
        soundings_features = json.load(f).get('features', [])
    shallow_features = [f for f in hazard_features
                         if f['properties'].get('label') == 'shallow area'
                         and f['geometry']['type'] != 'Point']
    ref_draft_m = args.ref_draft_ft * 0.3048
    print(f'Computing water polygon for bbox {bbox} against {len(land_features)} land feature(s), '
          f'{len(shallow_features)} shallow-area polygon(s), and {len(soundings_features)} real '
          f'sounding(s) (ref draft {args.ref_draft_ft}ft)...')
    water = water_polygon(bbox, land_features, shallow_features, soundings_features, ref_draft_m)

    # Separate, deliberately narrower index used only to TAG (never drop)
    # risky edges — see build_risk_hazard_index's docstring. Reuses the
    # full unfiltered shallow_features list (not just the "significant
    # area" subset water_polygon() subtracted) since the small hazards
    # left inside the water polygon on purpose are exactly the ones a
    # tag needs to catch.
    hazard_tree, hazard_geoms = build_risk_hazard_index(shallow_features, soundings_features, ref_draft_m)
    print(f'Risk-tagging index: {len(hazard_geoms)} hazard polygon(s) after real-sounding rescue')

    pieces = [g for g in (water.geoms if hasattr(water, 'geoms') else [water])
              if g.geom_type == 'Polygon' and not g.is_empty]
    print(f'Water polygon has {len(pieces)} piece(s); running medial-axis mesh on each...')

    out_features = []
    for i, poly in enumerate(pieces):
        label = f'{args.label} {i + 1}'
        edges = water_piece_to_edges(poly, args.min_piece_area_m2, hazard_tree, hazard_geoms)
        n_risky = sum(1 for (_, _, risky) in edges if risky)
        print(f'  piece {i + 1} (area {poly.area:.6f} deg^2): {len(edges)} edge(s), {n_risky} tagged risky')
        for (alon, alat), (blon, blat), risky in edges:
            props = {'source': 'water_mesh', 'channelName': label}
            if risky:
                props['risky'] = True
            out_features.append({
                'type': 'Feature',
                'geometry': {'type': 'LineString',
                             'coordinates': [[round(alon, 6), round(alat, 6)],
                                              [round(blon, 6), round(blat, 6)]]},
                'properties': props,
            })

    out_dir = os.path.dirname(args.out) or '.'
    os.makedirs(out_dir, exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump({'type': 'FeatureCollection', 'features': out_features}, f, separators=(',', ':'))
    print(f'\nWrote {len(out_features)} edge(s) -> {args.out}')

    if os.path.exists(os.path.join(out_dir, 'data-version.json')):
        refresh_data_version(out_dir)


if __name__ == '__main__':
    main()
