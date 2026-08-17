#!/usr/bin/env python3
"""
Build a routable channel-graph from two ENC-derived sources:

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

Output: www/data/channel_graph.geojson — a FeatureCollection of LineString
edges (each a 2-point segment), properties: {source, channelName}. Consumed
by www/js/query.js at runtime (see Query.channelNodesNear / the persistent
channel index built alongside _landIndex).

Usage: python3 build_channel_graph.py [--channels PATH] [--tracks PATH] [--out PATH]
"""
import argparse
import json
import math
import os

from pyproj import Transformer
from shapely.geometry import shape, LineString, MultiPolygon, Polygon
from shapely.ops import transform as shp_transform
from scipy.spatial import Voronoi

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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--channels', default=os.path.join(DATA_DIR, 'channels.geojson'))
    ap.add_argument('--tracks', default=os.path.join(DATA_DIR, 'recommended_tracks.geojson'))
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

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump({'type': 'FeatureCollection', 'features': out_features}, f, separators=(',', ':'))
    print(f'\nWrote {len(out_features)} edge(s) → {args.out}')


if __name__ == '__main__':
    main()
