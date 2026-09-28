# AudioChart routing architecture — a high-level summary

*Written 2026-09-28, after the v715/v716 water-mesh work, as a snapshot
of how the dock-to-dock router is actually built and why — and as a
direct comparison against `suggest_algorithmn.md`'s proposal for a
from-scratch Python router, to make explicit which of its ideas we
already have, which we adopted, and which we deliberately didn't.*

## The one constraint that shapes everything else

AudioChart is offline-first: once a sailor leaves the dock, there is no
network. Every routing decision has to be made **in the browser, from
data already downloaded**. This rules out anything that wants to run a
server-side or Python-side computation at query time — `suggest_algorithmn.md`'s
entire proposal is a Python module (`osgeo.ogr`, `shapely`, `scipy`), and
Python simply cannot run in this app's actual execution environment. That
single fact is why this project's real router is JavaScript, and why
Python is only ever used at *build time*, to produce static data files
the JS then loads and searches offline. This isn't a stylistic choice —
it's the hard boundary the whole architecture is built around.

## What actually exists today

**Runtime (`www/js/`), in the browser, per query:**

- `query.js` owns all chart data: land polygons, depth/hazard polygons,
  real soundings, named places, and (per region) real charted channel
  graphs and — as of v715 — a precomputed navigable-water mesh. It
  exposes fast spatial lookups (`landBlocks`, `ringBlocks`,
  `nearestSounding`, `channelNeighbors`, `waterMeshPath`, …) backed by a
  grid index (`_landIndex`) built once when data loads.
- `router.js` runs the actual search: a **complete-graph, land/hazard-
  checked A\*** over a candidate-node set built per query from land-ring
  vertices near the direct start→end line, real charted channel/buoy
  nodes, and (for hard passages) a seeded shortest path through the
  precomputed water mesh. Every edge the search considers is validated
  live by `segBlocked`, which checks real land crossings, real charted
  hazard rings, and — critically — a real-soundings rescue
  (`_soundingsClearCrossing`) that lets an individual real depth reading
  override a coarse polygon's worst-case value.
- Routes over 20nm decompose into depart/transit/arrive legs
  (`long_range_routing`) rather than one unbounded search.
- `gpx_export.js` already ships GPX 1.1 output, matching one of
  `suggest_algorithmn.md`'s stated deliverables.

**Build time (`preprocess/`), in Python, offline, before shipping:**

- `s57_to_geojson.py` / `extract_land.py` / `merge_charts.py` ingest real
  NOAA S-57 ENC data — the same source format `suggest_algorithmn.md`'s
  `chart_ingest.py` describes — into the static GeoJSON files the app
  actually ships and loads.
- `build_channel_graph.py` computes a boundary-point-Voronoi medial axis
  over real charted fairway (`FAIRWY`) polygons, producing a small,
  **independently-surveyed, trusted** graph of real channel centerlines.
- `build_water_mesh.py` (new this month) applies that *same* medial-axis
  technique to a computed "open water" polygon (bbox minus land minus
  significant hazards) for hard, island-dense passages where per-query
  candidate generation structurally can't find a path — see below.

## The central design principle: precomputed data is a hint, never an authority

This is the one idea this project treats as close to inviolable, and
it's the sharpest point of contrast with `suggest_algorithmn.md`'s
design. That proposal's `mesh_graph.py` would hand Theta* a graph and let
it search — implicitly trusting that graph's edges are safe. This
project instead draws a hard line between two kinds of precomputed data:

1. **Independently-surveyed data** (real NOAA charted channels, buoy
   chains — `channel_graph.geojson`) — consumed via `channelNeighbors`
   **without** a live `segBlocked` check, because a mismatch against this
   project's own simplified land polygons is a known, accepted
   digitization artifact, not a sign the real charted channel is unsafe.
2. **Everything this project computes itself** (the water mesh, any
   future derived geometry) — consumed strictly as **ordinary candidate
   nodes**. Every edge, no matter how it was generated, still goes
   through a real, live `segBlocked` check on *every* query before the
   router will use it. A bug in the mesh-generation pipeline can at worst
   produce an unused candidate node — never an unsafe shipped route.

`suggest_algorithmn.md` doesn't distinguish these two cases at all; its
mesh, however generated, becomes the search space Theta* trusts
directly. For a navigation-safety app that's the wrong default. This
project learned this lesson the hard way in miniature this month: the
water mesh's own generation pipeline had several real bugs during
development (a shared function silently ignoring interior rings/holes;
a hazard polygon's coarse worst-case depth disagreeing with real
soundings 29% of the time) — none of them ever reached a real route,
specifically because the live safety check downstream doesn't care where
a candidate node came from.

## Ideas from `suggest_algorithmn.md` we already have, just built differently

- **Any-angle search.** Theta*'s whole point is avoiding a search that's
  artificially confined to a fixed-angle grid. This project's A* already
  searches a *complete graph* of real candidate points (not a grid) with
  a live line-of-sight check (`segBlocked`) on every edge — functionally
  the same property Theta* is designed to deliver, arrived at from a
  different starting structure.
- **Spatial indexing for fast obstacle queries.** `suggest_algorithmn.md`
  wants an `STRtree` over obstacle segments. `query.js`'s `_landIndex`
  (a grid-bucketed index built once at load time) does the same job.
- **CDT/Voronoi mesh over open water.** This is the one genuinely useful,
  previously-missing idea in the document, and this project adopted it —
  see below.
- **GPX export.** Already shipped, already in the format described.

## The idea we adopted: a precomputed water mesh (v715, this month)

A real user report — AutoRoute failing completely (not timing out; A\*
exhausting its *entire* candidate graph with "no path found") between two
points inside Eggemoggin Reach, Maine — turned out to have a real,
diagnosable cause: per-query candidate generation places plenty of points
on *each side* of a complex multi-island passage, with no guarantee any
combination of them chains all the way through. That's a structural gap
in *where candidate points come from*, not in the search algorithm
itself — and it's exactly the gap `suggest_algorithmn.md`'s mesh idea
targets.

The fix, `build_water_mesh.py`, reuses this project's own existing
medial-axis code (already proven on real charted channels) against a
computed open-water polygon instead of one fairway polygon, shipped as
`water_mesh_deer_isle.geojson` for the Penobscot Bay region. At runtime,
`Query.waterMeshPath` precomputes the mesh's own shortest path once per
query (a few thousand nodes — cheap) and `router.js` seeds just that
path into its normal candidate array, under the "ordinary node, always
live-checked" rule above.

Two naive integration attempts were tried and rejected before this
worked: seeding the *whole* mesh unconditionally (timed out — the
router's complete-graph search cost scales with total node count) and
capping mesh nodes by distance to the query's own direct line
(actively wrong — a real detour around an island is, by definition, far
from that line). Precomputing the shortest path *within the mesh's own
graph* and handing the router only that solved both problems at once.

A follow-up this month (v716) refined how the mesh handles hazards it
can't fully resolve at build time: rather than dropping any edge a
precise live-equivalent check would reject (tried, and made things
*worse* — a single medial-axis skeleton has almost no redundancy, so
dropping edges fragments it faster than it helps), edges are now tagged
`risky` and penalized, not excluded, in the mesh's own precomputed
Dijkstra — steering toward an existing safe detour when one exists,
while never losing the fallback of a still-live-checked risky edge when
there's truly no alternative.

## Ideas from `suggest_algorithmn.md` deliberately not adopted, and why

- **Blanket obstacle dilation by `vessel_beam * 2.0`, plus a smooth
  `1/dist²` proximity-cost field.** This is the most tempting idea in the
  document and the one most worth naming explicitly as *rejected*, not
  overlooked. This project tried something in this spirit — hard
  standoff/proximity rules — and it broke 6 of 8 real regression cases
  in this hazard-dense data (charted Maine coastal water is *thick* with
  individually-charted rocks and ledges; a blanket buffer or proximity
  penalty tends to treat legitimately narrow-but-safe real passages as
  unsafe). The fix that shipped instead treats standoff/proximity as a
  **post-hoc warning**, computed after a route is found, not a hard
  constraint the search itself enforces. A smooth cost field is
  elegant in open water and actively wrong in an archipelago — exactly
  the geography this app spends most of its routing effort on.
- **A single from-scratch router replacing the existing one.** The
  request that led to reading `suggest_algorithmn.md` was explicit about
  this: evaluate it for ideas to fold into the existing dock-to-dock
  algorithm, not build it as a parallel system. Every idea above was
  extracted and evaluated on that basis, not adopted wholesale.

## Honest open gap

The water-mesh technique is shipped and verified for the Penobscot Bay
region only. Two attempts to extend it to the bundled-default (whole
coastal Maine/NH) dataset this month both improved the specific case
tested (a near-miss past Pickering Island went from routing directly
through it to a genuine ~15x safety margin) without fully resolving it —
bundled-default's much denser hazard data causes the real live
`segBlocked` check to reject a large fraction of the precomputed mesh
path there, a broader mismatch than either edge-dropping or edge-tagging
alone fixes. That's a real, understood, and explicitly deferred gap, not
a silent one — see `CHANGELOG.md`'s v716 entry and the project's own
memory notes for the next investigation this points to.
