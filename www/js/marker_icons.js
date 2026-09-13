/**
 * AudioChart — Leaflet marker icon factories (boat, waypoint, search pin,
 * animated boat, route-label leader lines). Pure functions returning
 * L.icon/L.divIcon objects (or, for _addLeaderLabel, drawing directly onto a
 * caller-supplied layer) — no dependency on map state or the query engine
 * beyond the Leaflet global itself. Extracted from app.js as part of the
 * reliability-overhaul's Phase 2 (see the plan for rationale).
 */

export function pinIcon() {
  return L.icon({ iconUrl: './icons/markicons/Marks-Active-Waypoint.svg', iconSize: [32, 32], iconAnchor: [16, 32], tooltipAnchor: [0, -32] });
}

// Discreet variant for soft/shallow route-check markers (_checkRouteHazards)
// — same yellow-triangle-with-! asset (the international caution symbol,
// per user request) as the general hazard layer, without the skull's
// pulse, so it reads as "worth a glance" rather than "stop and look." A
// skull for a merely draft/tide-dependent shallow patch was the wrong
// signal — reserved for hard hazards (rock/obstruction/wreck). Originally
// 16px; doubled to 32px per live feedback that the original size was too
// small to actually see on the route. (Several sibling icon factories —
// _navaidMarkerIcon, _hazardMarkerIcon, _documentMarkerIcon, etc. — remain
// scattered through app.js; a good candidate for a future consolidation
// pass, not attempted here.)
export function softHazardMarkerIcon() {
  return L.icon({ iconUrl: './icons/markicons/Hazard-Warning.svg', iconSize: [32, 32], iconAnchor: [16, 16], tooltipAnchor: [0, -16] });
}

export function waypointIcon() {
  return L.divIcon({
    className: '',
    html: '<div class="wp-marker"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
    tooltipAnchor: [7, -7],
  });
}

// The ⛵ glyph is a side-profile boat with the sail/jib leading to the LEFT (screen-west)
// in its neutral, hull-down orientation. A single continuous rotation can't represent every
// heading without passing through upside-down/capsized-looking orientations for half the
// compass. Instead, mirror the glyph horizontally for the eastward half of the compass (so
// it always faces "forward" toward its target half — left or right) and rotate by at most
// ±90° from that horizontal reference, so the hull never flips above the sail.
export function boatIconTransform(bearingDeg) {
  const b = ((bearingDeg % 360) + 360) % 360;
  const facingRight = b >= 0 && b <= 180;
  const rotation = facingRight ? (b - 90) : (b - 270);
  return facingRight ? `rotate(${rotation}deg) scaleX(-1)` : `rotate(${rotation}deg)`;
}

export function animBoatIcon(bearingDeg = 0) {
  return L.divIcon({
    className: '',
    html: `<div class="anim-boat" style="transform:${boatIconTransform(bearingDeg)}"><span class="anim-boat-rock">⛵</span></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    tooltipAnchor: [14, -14],
  });
}

// Place a text label offset perpendicular to a route point, with a solid leader line
// and an arrowhead whose tip points to the route.
// side: +1 = right of trueBrg, -1 = left.  offsetNm in nautical miles.
export function addLeaderLabel(layer, anchorLat, anchorLon, trueBrg, side, offsetNm, html, cssClass) {
  const perpBrg = ((trueBrg + side * 90) + 360) % 360;
  const oLat = anchorLat + offsetNm * Math.cos(perpBrg * Math.PI / 180) / 60;
  const oLon = anchorLon + offsetNm * Math.sin(perpBrg * Math.PI / 180) / 60 / Math.cos(anchorLat * Math.PI / 180);

  // Solid leader line from label to route
  L.polyline([[oLat, oLon], [anchorLat, anchorLon]], {
    color: '#6aaad4', weight: 1.5, opacity: 0.7, interactive: false,
  }).addTo(layer);

  // Arrowhead at the route end: SVG triangle, tip pinned to anchor via transform-origin.
  // perpBrg goes from anchor → label, so arrowBrg = +180° = direction pointing back to route.
  const arrowBrg = (perpBrg + 180) % 360;
  L.marker([anchorLat, anchorLon], {
    icon: L.divIcon({
      className: '',
      html: `<svg style="transform:rotate(${arrowBrg}deg);transform-origin:6px 0px"
                  width="12" height="12" viewBox="0 0 12 12"
                  xmlns="http://www.w3.org/2000/svg">
               <polygon points="6,0 0,11 12,11" fill="#6aaad4" fill-opacity="0.85"/>
             </svg>`,
      iconSize: [12, 12],
      iconAnchor: [6, 0],
    }),
    interactive: false,
  }).addTo(layer);

  // Label at offset position, centered on its anchor point
  L.marker([oLat, oLon], {
    icon: L.divIcon({ className: '', html: `<div class="${cssClass}">${html}</div>`, iconSize: [0, 0], iconAnchor: [0, 0] }),
    interactive: false,
  }).addTo(layer);
}

export function segBearing(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const dLon = (lon2 - lon1) * r;
  const y = Math.sin(dLon) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) -
            Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

let _boatCircleDismissed = false;  // true after user taps the boat once

// Tapping the boat toggles its circle background off (declutter) or back on
// — a one-way dismiss with no way back was the original behavior; per direct
// feedback, tapping the now-bare boat should restore it rather than leaving
// it permanently bare until a full reload. Attached to window (not exported)
// because boatIcon()'s own generated HTML below calls it via an inline
// onclick="_toggleBoatCircle(this)" attribute, which can only resolve a
// bare identifier as a global.
window._toggleBoatCircle = function(el) {
  _boatCircleDismissed = !_boatCircleDismissed;
  el.classList.toggle('boat-bare', _boatCircleDismissed);
};

export function boatIcon() {
  const cls = _boatCircleDismissed ? 'boat-marker boat-bare' : 'boat-marker';
  return L.divIcon({
    className: '',
    html: `<div class="${cls}" onclick="_toggleBoatCircle(this)"><span class="boat-emoji">⛵</span></div>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    tooltipAnchor: [22, -22],
  });
}

// Classic teardrop map-pin, for the Search feature — deliberately distinct
// from every other marker shape in the app (boat/waypoint/overnight) so a
// dropped search result reads immediately as "not a real chart object,"
// same convention as the fix-crossing marker's own one-off shape. Anchored
// at the tip (bottom point), not the center, since that's what's actually
// over the searched coordinate.
export function searchPinIcon() {
  return L.divIcon({
    className: 'search-pin-marker',
    html: `<svg width="32" height="42" viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20c0-6.6-5.4-12-12-12z" fill="#e05252" stroke="#3a0d0d" stroke-width="1"/>
        <circle cx="12" cy="12" r="5" fill="#fff"/>
      </svg>`,
    iconSize: [32, 42],
    iconAnchor: [16, 42],
    tooltipAnchor: [0, -38],
  });
}
