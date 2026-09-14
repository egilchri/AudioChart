/**
 * AudioChart — GPX file export. Pure browser-file-download utility, no
 * dependency on map state or the query engine — extracted from app.js as
 * part of the reliability-overhaul's Phase 2 (see the plan for rationale).
 */

function _escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// Personal waypoints (search pins, quick-dropped markers) have no
// inherent order or connecting path — unlike a route/track, each one is
// its own <wpt>, not a <trk>/<trkseg>. type/note round-trip through
// <extensions> so this doubles as a real backup: re-importing via
// "Markers (GPX)" restores search-pin icons and notes, not just bare
// name+coordinates.
export function downloadWaypointsGpx(waypoints, fileName) {
  const wpts = waypoints.map(w => {
    const extras = [];
    if (w.type) extras.push(`<type>${_escapeXml(w.type)}</type>`);
    if (w.note) extras.push(`<note>${_escapeXml(w.note)}</note>`);
    const extTag = extras.length ? `\n    <extensions>${extras.join('')}</extensions>` : '';
    return `  <wpt lat="${w.lat.toFixed(7)}" lon="${w.lon.toFixed(7)}">
    <name>${_escapeXml(w.name)}</name>${extTag}
  </wpt>`;
  }).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="AudioChart">
${wpts}
</gpx>`;
  const blob = new Blob([xml], { type: 'application/gpx+xml' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${fileName.replace(/\s+/g, '_')}.gpx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

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
