/**
 * AudioChart — hazard marker screen-clustering. A rock-strewn stretch of the
 * Maine coast can put a dozen+ charted hazards within a few boat-lengths of
 * each other; this merges markers that are close enough on SCREEN (not
 * nautical distance — purely a rendering fix, every hazard is still
 * full-accuracy queryable data underneath) at the current zoom into one
 * soft-edged blob, and re-clusters on zoom so zooming in un-merges them.
 * Parameterized on map/layerGroup/points — no dependency on app state
 * beyond Leaflet. Extracted from app.js as part of the reliability-
 * overhaul's Phase 3 (see the plan for rationale).
 */

let _zoomHandler = null;

/** Union-find clustering of `points` ({lat,lon}[]) by on-screen pixel distance
 * at the map's current zoom/pan. Returns arrays of indices into `points`.
 * Grid-bucketed (cell size = pixelRadius, each point only compared against
 * its own + 8 neighboring cells) rather than the naive all-pairs check —
 * Penobscot Bay alone charts thousands of point hazards, and a full-bay
 * viewport can put a real fraction of those on screen at once; plain
 * all-pairs comparison at that count is a genuine multi-second main-thread
 * hang, not just an inefficiency (found live-testing this feature). */
export function clusterIndicesByPixel(map, points, pixelRadius) {
  const n = points.length;
  const px = points.map(p => map.latLngToContainerPoint([p.lat, p.lon]));
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const cell = Math.max(pixelRadius, 1);
  const cellKey = (cx, cy) => `${cx},${cy}`;
  const grid = new Map();
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(px[i].x / cell), cy = Math.floor(px[i].y / cell);
    const k = cellKey(cx, cy);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  const r2 = pixelRadius * pixelRadius;
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(px[i].x / cell), cy = Math.floor(px[i].y / cell);
    for (let dcx = -1; dcx <= 1; dcx++) {
      for (let dcy = -1; dcy <= 1; dcy++) {
        const neighbors = grid.get(cellKey(cx + dcx, cy + dcy));
        if (!neighbors) continue;
        for (const j of neighbors) {
          if (j <= i) continue; // each unordered pair checked once, still symmetric via union()
          const dx = px[i].x - px[j].x, dy = px[i].y - px[j].y;
          if (dx * dx + dy * dy <= r2) union(i, j);
        }
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  return [...groups.values()];
}

export function hazardBlobIcon(count) {
  // Deliberately NOT sized to the cluster's real pixel spread — a bug found
  // live (2026-08-23): sizing the blob to maxD-of-members meant that when
  // the DOM-count safety valve (below) widens the grouping radius on a
  // hazard-dense view, every resulting blob (and its blur halo) ballooned
  // to match, and dozens of huge overlapping halos washed the whole chart
  // in a continuous orange fog instead of reading as distinct local blobs.
  // A small, count-driven size — same convention as any standard map
  // marker cluster — stays legible and local regardless of how far apart
  // the real members ended up; clicking still zooms to the members' real
  // bounds (see renderClusteredHazards), which is how more detail actually
  // surfaces — no on-blob count/text (user feedback 2026-08-23: the number
  // badges read as clutter of their own; the exact count is still in the
  // tooltip on hover/tap, just not permanently painted on the map).
  const r = Math.min(10 + Math.sqrt(count) * 2.5, 22);
  const size = r * 2;
  const blurId = `hazBlur${Math.round(r)}`;
  const svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    <defs><filter id="${blurId}" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="${Math.max(r * 0.1, 1.5)}" />
    </filter></defs>
    <circle cx="${r}" cy="${r}" r="${r * 0.85}" fill="#f5c842" fill-opacity="0.88" filter="url(#${blurId})" />
  </svg>`;
  return L.divIcon({ className: 'hazard-blob-marker', html: svg, iconSize: [size, size], iconAnchor: [r, r] });
}

/** Renders hazardPts into layerGroup: an isolated hazard gets its normal
 * marker (makeMarker(h) — identical to what each caller already built
 * before this existed), a screen-crowded group gets one blob instead;
 * clicking a blob zooms in on it (which re-clusters via the zoomend
 * listener below and reveals the real markers once they're no longer
 * crowded — nothing is ever hidden permanently or dropped from the data). */
export function renderClusteredHazards(map, layerGroup, hazardPts, makeMarker) {
  // A whole-bay, zoomed-out view can have hundreds/thousands of hazards
  // spread widely enough on screen that a small cluster radius barely merges
  // any of them — still one real DOM marker+SVG icon per point, which is a
  // genuine multi-second freeze at that count regardless of how fast the
  // clustering math itself is. Below MAX_HAZARD_MARKERS use a tight radius
  // (merge only truly-crowded icons, keep isolated ones exact); above it,
  // widen the radius until the marker count actually produced drops under
  // the cap — trading precision for a bounded number of DOM nodes only when
  // the point count demands it.
  const MAX_HAZARD_MARKERS = 250;
  if (_zoomHandler) { map.off('zoomend', _zoomHandler); _zoomHandler = null; }
  function render() {
    layerGroup.clearLayers();
    if (!hazardPts.length) return;
    let clusterPx = 26; // roughly one hazard-icon width
    let groups = clusterIndicesByPixel(map, hazardPts, clusterPx);
    for (let guard = 0; groups.length > MAX_HAZARD_MARKERS && guard < 8; guard++) {
      clusterPx *= 2;
      groups = clusterIndicesByPixel(map, hazardPts, clusterPx);
    }
    for (const idxs of groups) {
      if (idxs.length === 1) { makeMarker(hazardPts[idxs[0]]).addTo(layerGroup); continue; }
      const members = idxs.map(i => hazardPts[i]);
      const pxPts = members.map(h => map.latLngToContainerPoint([h.lat, h.lon]));
      const cx = pxPts.reduce((s, p) => s + p.x, 0) / pxPts.length;
      const cy = pxPts.reduce((s, p) => s + p.y, 0) / pxPts.length;
      L.marker(map.containerPointToLatLng([cx, cy]), {
        icon: hazardBlobIcon(members.length), zIndexOffset: 500,
      }).bindTooltip(`${members.length} hazards — tap to expand`, {
        permanent: false, direction: 'top', className: 'map-tooltip',
      }).on('click', () => map.fitBounds(L.latLngBounds(members.map(h => [h.lat, h.lon])).pad(0.6)))
        .addTo(layerGroup);
    }
  }
  render();
  _zoomHandler = render;
  map.on('zoomend', _zoomHandler);
}
