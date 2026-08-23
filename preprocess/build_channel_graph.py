#!/usr/bin/env python3
"""
Build a routable channel-graph from three ENC-derived sources:

  1. RECTRC/NAVLNE recommended-track LineStrings (www/data/recommended_tracks.geojson)
     — already real, charted routable lines (a pilot's actual approach track).
     Used directly: each consecutive coordinate pair becomes a graph edge.

  2. FAIRWY channel/fairway polygons (www/data/channels.geojson) — area outlines
     only, no centerline in the source data. A centerline is approximated per
     polygon via a boundary-point Voronoi diagram (the standard technique for
     this: densify the polygon boundary, take the Voronoi diagram of those
     boundary points, keep only the vertices/edges that fall strictly inside
     the polygon — that's the medial axis). The resulting graph is pruned of
     short leaf spurs (noise from boundary concavities), then reduced to its
     longest path for a simple elongated fairway, or kept as a full graph if
     it has a real branch/junction.

  3. Named lateral-buoy/daybeacon chains (www/data/navaid.geojson) — many real,
     actively-used Maine thorofares/passages/river reaches (Fox Islands
     Thorofare among them) have NO charted FAIRWY polygon or RECTRC track at
     all in NOAA's ENC data — they're marked purely by a string of numbered
     lateral aids. Buoys sharing a common name prefix ("Fox Island Thorofare
     Buoy 12", "...Gong Buoy 23", ...) are grouped, connected via a
     minimum-spanning tree (robust to a curving passage, unlike sorting by
     buoy number alone), and any resulting edge that crosses land is dropped
     — channel-graph edges are trusted by the router with NO runtime land
     check (see the "relaxed WITHOUT segBlocked" comment in app.js), so a bad
     synthesized edge here would be a routing hazard, not just a graph
     wart. See buoy_chain_edges() below.

Output: www/data/channel_graph.geojson — a FeatureCollection of LineString
edges (each a 2-point segment), properties: {source, channelName}. Consumed
by www/js/query.js at runtime (see Query.channelNodesNear / the persistent
channel index built alongside _landIndex).

Usage: python3 build_channel_graph.py [--channels PATH] [--tracks PATH]
                                       [--navaid PATH] [--land PATH] [--out PATH]
"""
import argparse
import json
import math
import os
import re

import numpy as np
from pyproj import Transformer
from shapely.geometry import shape, LineString, MultiPolygon, Polygon
from shapely.ops import transform as shp_transform
from shapely.strtree import STRtree
from scipy.spatial import Voronoi
from scipy.sparse.csgraph import minimum_spanning_tree

# Buoy/daybeacon name -> (base channel name, trailing number/code), e.g.
# "Fox Island Thorofare Lighted Gong Buoy 26" -> ("Fox Island Thorofare", "26"),
# "Fox Island Thorofare Junction Buoy" -> ("Fox Island Thorofare", "").
BUOY_NAME_RE = re.compile(
    r'^(.*?)\s+(?:Lighted\s+)?(?:Junction\s+|Gong\s+|Bell\s+|Whistle\s+|Horn\s+)?'
    r'(?:Buoy|Daybeacon|Beacon)\s*([A-Za-z0-9]*)$'
)
# Only build a synthetic chain for names that read as an actual through-passage —
# a same-scheme buoy cluster around a hazard (e.g. "Long Ledge Buoy 2/4/6") is
# NOT a route and must never turn into a routable edge.
CHANNEL_NAME_KEYWORDS = ('thorofare', 'channel', 'passage', 'reach', 'river', 'cut', 'narrows', 'gut')
CHAIN_NAVAID_TYPES = {'BOYLAT', 'BCNLAT', 'BOYSAW'}
MIN_CHAIN_BUOYS = 3

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, '..', 'www', 'data'))

# Channel polygons span a huge size range (a ~150m harbor channel to a
# multi-km river reach) — a single fixed boundary-point spacing either
# drowns a small channel's Voronoi diagram in noise or under-samples a large
# one entirely. Scale the densify spacing (and, proportionally, the prune/
# snap thresholds) to each polygon's own perimeter, targeting a boundary
# point count that keeps the Voronoi diagram tractable and clean regardless
# of absolute size.
TARGET_BOUNDARY_POINTS = 220
MIN_DENSIFY_SPACING_M = 4.0
MAX_DENSIFY_SPACING_M = 60.0


def adaptive_params(perimeter_m):
    spacing = max(MIN_DENSIFY_SPACING_M,
                  min(MAX_DENSIFY_SPACING_M, perimeter_m / TARGET_BOUNDARY_POINTS))
    return spacing, spacing * 1.5, spacing * 0.4  # densify, prune_spur, snap_grid


def load_fc(path):
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return json.load(f).get('features', [])


def local_transformers(lon0, lat0):
    """Forward (lon,lat -> local meters) / inverse transformers for an AEQD
    projection centered on the polygon, using pyproj (already a dependency) —
    numerically stable for Voronoi at any latitude, unlike a flat degree-space
    computation which distorts badly away from the equator."""
    proj4 = f'+proj=aeqd +lat_0={lat0} +lon_0={lon0} +units=m +datum=WGS84'
    fwd = Transformer.from_crs('EPSG:4326', proj4, always_xy=True)
    inv = Transformer.from_crs(proj4, 'EPSG:4326', always_xy=True)
    return fwd, inv


def densify_ring(coords_m, spacing_m):
    """Densify a boundary ring (already in local planar meters) to
    ~spacing_m point spacing so the Voronoi diagram has enough boundary
    points to approximate a medial axis."""
    out = []
    for i in range(len(coords_m) - 1):
        (x1, y1), (x2, y2) = coords_m[i], coords_m[i + 1]
        seg_len = math.hypot(x2 - x1, y2 - y1)
        out.append((x1, y1))
        n = max(1, int(seg_len // spacing_m))
        for k in range(1, n):
            t = k / n
            out.append((x1 + (x2 - x1) * t, y1 + (y2 - y1) * t))
    out.append(coords_m[-1])
    return out


def medial_axis_edges(poly_m, densify_spacing_m):
    """Boundary-point Voronoi medial-axis approximation, in local meters.
    Returns a list of (p1, p2) edges (each a (x, y) tuple) lying inside poly_m."""
    boundary_pts = densify_ring(list(poly_m.exterior.coords), densify_spacing_m)
    if len(boundary_pts) < 4:
        return []
    vor = Voronoi(boundary_pts)
    edges = []
    for (i1, i2) in vor.ridge_vertices:
        if i1 == -1 or i2 == -1:
            continue  # unbounded ridge
        p1, p2 = vor.vertices[i1], vor.vertices[i2]
        mid = ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
        # Interior-only test on both endpoints and the midpoint — a ridge that
        # dips outside a concave stretch of the boundary should be dropped
        # even if both its endpoints happen to fall back inside.
        if (poly_m.contains(_pt(p1)) and poly_m.contains(_pt(p2))
                and poly_m.contains(_pt(mid))):
            edges.append((tuple(p1), tuple(p2)))
    return edges


def _pt(xy):
    from shapely.geometry import Point
    return Point(xy)


def snap_nodes(edges, grid_m):
    """Merge Voronoi vertices within grid_m of each other into one node —
    Voronoi diagrams commonly split a single real junction into a cluster of
    near-coincident vertices connected by near-zero-length edges; left alone,
    each cluster masquerades as several extra branch points and defeats the
    degree-based junction/chain classification below."""
    def snap(p):
        return (round(p[0] / grid_m) * grid_m, round(p[1] / grid_m) * grid_m)
    out = []
    for a, b in edges:
        sa, sb = snap(a), snap(b)
        if sa == sb:
            continue  # collapsed to the same node — drop the now-zero-length edge
        out.append((sa, sb))
    # de-dup identical edges (both directions) produced by the snap
    seen = set()
    deduped = []
    for a, b in out:
        key = (a, b) if a <= b else (b, a)
        if key in seen:
            continue
        seen.add(key)
        deduped.append((a, b))
    return deduped


def prune_spurs(edges, min_len_m):
    """Iteratively drop leaf edges (degree-1 endpoint) shorter than min_len_m —
    noise from reflex vertices on the boundary, not real branches."""
    edges = list(edges)
    changed = True
    while changed:
        changed = False
        deg = {}
        for a, b in edges:
            deg[a] = deg.get(a, 0) + 1
            deg[b] = deg.get(b, 0) + 1
        kept = []
        for a, b in edges:
            length = math.hypot(a[0] - b[0], a[1] - b[1])
            is_leaf = deg[a] == 1 or deg[b] == 1
            if is_leaf and length < min_len_m:
                changed = True
                continue
            kept.append((a, b))
        edges = kept
    return edges


def _bfs_farthest(adj, start):
    """Farthest node from start by path length, plus the BFS predecessor map
    (for reconstructing the path). Shared by the diameter estimate and the
    longest-path extraction below — both are the standard double-BFS trick
    for finding a tree/graph's two most-distant nodes."""
    seen = {start: 0.0}
    prev = {start: None}
    frontier = [start]
    farthest, farthest_d = start, 0.0
    while frontier:
        nxt = []
        for node in frontier:
            for nb in adj.get(node, []):
                if nb in seen:
                    continue
                d = seen[node] + math.hypot(nb[0] - node[0], nb[1] - node[1])
                seen[nb] = d
                prev[nb] = node
                if d > farthest_d:
                    farthest, farthest_d = nb, d
                nxt.append(nb)
        frontier = nxt
    return farthest, farthest_d, prev


def _graph_diameter(edges):
    """Longest shortest-path distance between any two nodes — the double-BFS
    farthest-point trick, exact for a tree (which a pruned medial-axis graph
    normally is) and a reasonable estimate otherwise."""
    adj = {}
    for a, b in edges:
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    end_a, _, _ = _bfs_farthest(adj, edges[0][0])
    _, dist, _ = _bfs_farthest(adj, end_a)
    return dist


def prune_short_branches(edges, min_fraction=0.12):
    """Remove minor whisker branches at a junction whose total length (leaf to
    junction, possibly several edges deep) is small relative to the graph's
    own overall span. A per-edge length threshold (prune_spurs) only catches a
    whisker one edge at a time and stalls once an individual edge in it is
    longer than that threshold even though the whole whisker is clearly minor
    next to a long main channel — this instead judges each branch as a whole,
    so it doesn't accidentally strip a real, comparably-long fork."""
    edges = list(edges)
    if not edges:
        return edges
    span = _graph_diameter(edges)
    # A degenerate "span" (all edges tiny) would make min_fraction*span ~0 and
    # prune nothing — fine, there's nothing meaningfully long to compare against.
    min_len = span * min_fraction

    changed = True
    while changed:
        changed = False
        adj = {}
        for a, b in edges:
            adj.setdefault(a, []).append(b)
            adj.setdefault(b, []).append(a)
        leaves = [n for n, nbrs in adj.items() if len(nbrs) == 1]
        removed = set()
        for leaf in leaves:
            branch = []
            length = 0.0
            node, prev = leaf, None
            while True:
                nbrs = [n for n in adj.get(node, []) if n != prev]
                if len(nbrs) != 1:
                    break  # hit a junction (or another leaf) — branch ends here
                nxt = nbrs[0]
                edge_key = (node, nxt) if node <= nxt else (nxt, node)
                branch.append(edge_key)
                length += math.hypot(node[0] - nxt[0], node[1] - nxt[1])
                prev, node = node, nxt
            if branch and length < min_len:
                removed.update(branch)
        if removed:
            edges = [(a, b) for (a, b) in edges
                     if ((a, b) if a <= b else (b, a)) not in removed]
            changed = True
    return edges


def longest_path_or_full_graph(edges):
    """For a simple chain (no real junction — every node has degree <= 2),
    return the single longest path end-to-end. For a real branch (some node
    with degree >= 3), return the full pruned edge set unchanged — collapsing
    a genuine junction to one path would silently drop a real navigable branch."""
    if not edges:
        return []
    adj = {}
    for a, b in edges:
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    if any(len(nbrs) > 2 for nbrs in adj.values()):
        return edges  # real junction — keep the whole graph

    end_a, _, _ = _bfs_farthest(adj, edges[0][0])
    end_b, _, prev = _bfs_farthest(adj, end_a)
    path_nodes = []
    node = end_b
    while node is not None:
        path_nodes.append(node)
        node = prev[node]
    path_nodes.reverse()
    return [(path_nodes[i], path_nodes[i + 1]) for i in range(len(path_nodes) - 1)]


def channel_to_edges(feature):
    """FAIRWY polygon feature -> list of (lon,lat) edge pairs via the medial-axis pipeline."""
    geom = shape(feature['geometry'])
    polys = geom.geoms if isinstance(geom, MultiPolygon) else [geom]
    out_edges = []
    for poly in polys:
        if not isinstance(poly, Polygon) or poly.is_empty:
            continue
        c = poly.centroid
        fwd, inv = local_transformers(c.x, c.y)
        poly_m = shp_transform(lambda x, y: fwd.transform(x, y), poly)
        densify_m, prune_m, snap_m = adaptive_params(poly_m.exterior.length)
        edges_m = medial_axis_edges(poly_m, densify_m)
        edges_m = snap_nodes(edges_m, snap_m)
        edges_m = prune_spurs(edges_m, prune_m)
        edges_m = prune_short_branches(edges_m)
        edges_m = longest_path_or_full_graph(edges_m)

        # A clean single-chain result is still one point roughly every
        # densify_m along the whole channel — correct, but far more detail
        # than routing needs (a road-network-style graph only needs enough
        # points to represent the path's shape, not survey-grade density).
        # Simplify the ordered path down before re-splitting into edges. Only
        # applies to the simple-chain case: a branching graph has no single
        # ordered point sequence to simplify this way.
        adj_pre = {}
        for a, b in edges_m:
            adj_pre.setdefault(a, []).append(b)
            adj_pre.setdefault(b, []).append(a)
        if edges_m and not any(len(nbrs) > 2 for nbrs in adj_pre.values()):
            ordered = [edges_m[0][0]] + [b for _, b in edges_m]
            simplified = LineString(ordered).simplify(densify_m, preserve_topology=True)
            pts = list(simplified.coords)
            edges_m = [(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]

        # Quality gate: a real medial axis should reduce to a clean chain (or,
        # rarely, a small real Y-junction) — a large edge count surviving this
        # far means the Voronoi diagram is still noisy for this polygon's
        # shape, not that it has a genuinely complex channel network. This is
        # a navigation feature: injecting a noisy, zigzagging "centerline" as
        # a routable edge is worse than just not offering channel data for
        # this one polygon yet, so skip it rather than guess.
        adj = {}
        for a, b in edges_m:
            adj.setdefault(a, []).append(b)
            adj.setdefault(b, []).append(a)
        has_junction = any(len(nbrs) > 2 for nbrs in adj.values())
        if len(edges_m) > 25 and has_junction:
            name = feature['properties'].get('name', '?')
            print(f'    SKIP (unresolved medial axis, {len(edges_m)} edges — needs tuning): {name}')
            continue

        for (ax, ay), (bx, by) in edges_m:
            alon, alat = inv.transform(ax, ay)
            blon, blat = inv.transform(bx, by)
            out_edges.append(((alon, alat), (blon, blat)))
    return out_edges


def track_to_edges(feature):
    coords = feature['geometry']['coordinates']
    return [(tuple(coords[i]), tuple(coords[i + 1])) for i in range(len(coords) - 1)]


def group_channel_buoys(navaid_features):
    """navaid features -> {base channel name: [(lon, lat), ...]} for lateral
    buoy/beacon chains whose shared name reads as a through-passage (see
    CHANNEL_NAME_KEYWORDS) and that have enough members to plausibly trace a
    route, not just a hazard-marking pair."""
    groups = {}
    for f in navaid_features:
        props = f['properties']
        if props.get('objtype') not in CHAIN_NAVAID_TYPES:
            continue
        m = BUOY_NAME_RE.match(props.get('name') or '')
        if not m:
            continue
        base = m.group(1).strip()
        if not any(kw in base.lower() for kw in CHANNEL_NAME_KEYWORDS):
            continue
        lon, lat = f['geometry']['coordinates']
        groups.setdefault(base, []).append((lon, lat))
    return {name: pts for name, pts in groups.items() if len(pts) >= MIN_CHAIN_BUOYS}


def _mst_edges(points_m):
    """Minimum-spanning-tree edges (as point-index pairs) over points already
    in local planar meters — robust to a curving passage where buoy numbering
    order alone wouldn't reliably trace the route, and to buoys marking both
    sides of the channel (an MST prefers the true along-channel neighbors,
    not a straight port-to-starboard hop, whenever those are shorter)."""
    n = len(points_m)
    dist = np.zeros((n, n))
    for i in range(n):
        for j in range(i + 1, n):
            d = math.hypot(points_m[i][0] - points_m[j][0], points_m[i][1] - points_m[j][1])
            dist[i, j] = dist[j, i] = d
    mst = minimum_spanning_tree(dist).toarray()
    return [(i, j) for i in range(n) for j in range(n) if mst[i, j] > 0]


def _connected_components(edges):
    adj = {}
    for a, b in edges:
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    seen, comps = set(), []
    for node in adj:
        if node in seen:
            continue
        comp_nodes, frontier = set(), [node]
        seen.add(node)
        while frontier:
            n2 = frontier.pop()
            comp_nodes.add(n2)
            for nb in adj[n2]:
                if nb not in seen:
                    seen.add(nb)
                    frontier.append(nb)
        comps.append([(a, b) for a, b in edges if a in comp_nodes and b in comp_nodes])
    return comps


def buoy_chain_to_edges(name, points, land_tree):
    """Named lateral-buoy/daybeacon chain -> routable centerline edges. Any
    MST edge that crosses land is dropped outright rather than guessed at —
    see the module docstring for why a bad edge here is a routing hazard, not
    just noise — which can split one chain into several disconnected pieces;
    each surviving piece is independently collapsed to its longest path (or
    kept as a real junction/branch) via longest_path_or_full_graph."""
    c_lon = sum(p[0] for p in points) / len(points)
    c_lat = sum(p[1] for p in points) / len(points)
    fwd, inv = local_transformers(c_lon, c_lat)
    points_m = [fwd.transform(lon, lat) for lon, lat in points]

    kept = []
    for i, j in _mst_edges(points_m):
        seg = LineString([points[i], points[j]])
        if land_tree is not None and len(land_tree.query(seg, predicate='intersects')) > 0:
            continue
        kept.append((i, j))

    out_edges = []
    for comp in _connected_components(kept):
        comp_edges_m = longest_path_or_full_graph([(points_m[i], points_m[j]) for i, j in comp])
        for (ax, ay), (bx, by) in comp_edges_m:
            alon, alat = inv.transform(ax, ay)
            blon, blat = inv.transform(bx, by)
            out_edges.append(((alon, alat), (blon, blat)))
    return out_edges


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--channels', default=os.path.join(DATA_DIR, 'channels.geojson'))
    ap.add_argument('--tracks', default=os.path.join(DATA_DIR, 'recommended_tracks.geojson'))
    ap.add_argument('--navaid', default=os.path.join(DATA_DIR, 'navaid.geojson'))
    ap.add_argument('--land', default=os.path.join(DATA_DIR, 'land.geojson'))
    ap.add_argument('--out', default=os.path.join(DATA_DIR, 'channel_graph.geojson'))
    args = ap.parse_args()

    out_features = []

    channels = load_fc(args.channels)
    print(f'Deriving centerlines for {len(channels)} FAIRWY polygon(s)...')
    for f in channels:
        name = f['properties'].get('name', '')
        edges = channel_to_edges(f)
        print(f'  {name}: {len(edges)} edge(s)')
        for (alon, alat), (blon, blat) in edges:
            out_features.append({
                'type': 'Feature',
                'geometry': {'type': 'LineString',
                             'coordinates': [[round(alon, 6), round(alat, 6)],
                                              [round(blon, 6), round(blat, 6)]]},
                'properties': {'source': 'fairway_centerline', 'channelName': name},
            })

    tracks = load_fc(args.tracks)
    print(f'Adding {len(tracks)} recommended-track LineString(s) as direct edges...')
    for f in tracks:
        name = f['properties'].get('name', '') or f['properties'].get('objtype', '')
        for (alon, alat), (blon, blat) in track_to_edges(f):
            out_features.append({
                'type': 'Feature',
                'geometry': {'type': 'LineString',
                             'coordinates': [[round(alon, 6), round(alat, 6)],
                                              [round(blon, 6), round(blat, 6)]]},
                'properties': {'source': 'recommended_track', 'channelName': name},
            })

    navaids = load_fc(args.navaid)
    land_features = load_fc(args.land)
    land_tree = STRtree([shape(f['geometry']) for f in land_features]) if land_features else None
    if not land_features:
        print(f'  WARNING: no land data at {args.land} — buoy-chain edges cannot be '
              f'land-checked, skipping this source entirely (a bad edge here bypasses '
              f'routing\'s land check at runtime, see module docstring)')
    else:
        groups = group_channel_buoys(navaids)
        print(f'Deriving centerlines for {len(groups)} named buoy/beacon chain(s) '
              f'(no charted FAIRWY/track) from {len(navaids)} navaid(s)...')
        for name, points in groups.items():
            edges = buoy_chain_to_edges(name, points, land_tree)
            print(f'  {name}: {len(points)} buoy(s) -> {len(edges)} edge(s)')
            for (alon, alat), (blon, blat) in edges:
                out_features.append({
                    'type': 'Feature',
                    'geometry': {'type': 'LineString',
                                 'coordinates': [[round(alon, 6), round(alat, 6)],
                                                  [round(blon, 6), round(blat, 6)]]},
                    'properties': {'source': 'buoy_chain', 'channelName': name},
                })

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump({'type': 'FeatureCollection', 'features': out_features}, f, separators=(',', ':'))
    print(f'\nWrote {len(out_features)} edge(s) → {args.out}')


if __name__ == '__main__':
    main()
