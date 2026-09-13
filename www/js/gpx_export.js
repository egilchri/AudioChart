/**
 * AudioChart — GPX file export. Pure browser-file-download utility, no
 * dependency on map state or the query engine — extracted from app.js as
 * part of the reliability-overhaul's Phase 2 (see the plan for rationale).
 */

export function downloadGpx(points, routeName) {
  const trkpts = points.map(p => {
    // Route points have no per-point timestamp (they're planned paths, not a real track) —
    // omit <time> rather than fabricate one.
    const timeTag = (p.t != null) ? `<time>${new Date(p.t).toISOString()}</time>` : '';
    const extTag  = p.overnight ? '<extensions><overnight>true</overnight></extensions>' : '';
    return `    <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${timeTag}${extTag}</trkpt>`;
  }).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="AudioChart">
  <trk>
    <name>${routeName}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
  const blob = new Blob([xml], { type: 'application/gpx+xml' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${routeName.replace(/\s+/g, '_')}.gpx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
