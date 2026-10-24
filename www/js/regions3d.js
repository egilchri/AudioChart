// The bays the 3D views can show (v992, requested: "a real clear way to switch back and forth between Casco and
// Penobscot" for armchair cruising). Each: its chart region's id (data/regions/<id>/), the world frame's origin
// (terrain3d.js), the overview's reach (past the bay, so its horizon is land), the box the camera's target stays in,
// and the whole-bay view. Penobscot's are the numbers Bird's-eye always had.
export const REGIONS3D = {
  'penobscot-bay': {
    name: 'Penobscot Bay', short: 'Penobscot',
    origin: [-68.87, 44.12],
    overview: [-69.45, 43.75, -67.95, 44.75],
    bay: [-69.25, 43.85, -68.1, 44.55],
    whole: { lon: -68.7, lat: 44.17, dist: 60000 },
  },
  'casco-bay': {
    name: 'Casco Bay', short: 'Casco',
    origin: [-70.05, 43.72],
    overview: [-70.55, 43.42, -69.6, 44.02],
    bay: [-70.32, 43.55, -69.78, 43.93],
    whole: { lon: -70.06, lat: 43.71, dist: 40000 },
  },
};
export const REGION3D_KEY = 'audiochart-bay3d-region';
const inBox = (b, lon, lat) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
// The bay this page shows: ?region=<id>; else the bay holding ?lat/?lon (the chart's view when the app opens
// Bird's-eye there); else, in Bird's-eye itself, the one you last switched to; else Penobscot.
export function region3dId() {
  const q = new URLSearchParams(location.search), r = q.get('region');
  if (REGIONS3D[r]) return r;
  const lat = Number(q.get('lat')), lon = Number(q.get('lon'));
  if (q.get('lat') && q.get('lon') && Number.isFinite(lat) && Number.isFinite(lon)) {
    const hit = Object.keys(REGIONS3D).find(id => inBox(REGIONS3D[id].overview, lon, lat));
    if (hit) return hit;
  }
  if (/bay3d\.html$/.test(location.pathname)) { try { const s = localStorage.getItem(REGION3D_KEY); if (REGIONS3D[s]) return s; } catch (_) {} }
  return 'penobscot-bay';
}
// which bays the switch offers: Casco only once the app's region is unlocked for this device (?dev=1; it's still
// in progress, app.js CRUISE_PROFILES), or while you're in it
export function regions3dOffered(current) {
  let dev = false; try { dev = localStorage.getItem('audiochart-dev-unlocked') === '1'; } catch (_) {}
  return Object.keys(REGIONS3D).filter(id => id === 'penobscot-bay' || dev || id === current);
}
