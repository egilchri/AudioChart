// The bays the 3D views can show (v992, requested: "a real clear way to switch back and forth between Casco and
// Penobscot" for armchair cruising). Each: its chart region's id (data/regions/<id>/), the world frame's origin
// (terrain3d.js), the overview's reach (past the bay, so its horizon is land), the box the camera's target stays in,
// and the whole-bay view. Penobscot's are the numbers Bird's-eye always had.
export const REGIONS3D = {
  'penobscot-bay': {
    name: 'Penobscot Bay', short: 'Penobscot',
    origin: [-68.87, 44.12],
    heliport: { name: 'Knox County Regional Airport', short: 'Knox County airport', lon: -69.0992, lat: 44.0603 },   // (where the Flyover's helicopter takes off: v1049)
    // other places she can start from, offered when you change the take-off spot (v1057, requested: "Add the Bar Harbor
    // airport as a place to start a Penobscot journey"): its apron, south of the runways' crossing, on the NAIP photo
    // (v1062, requested: "add the Coast Guard station as a takeoff possibility": the same wharf apron as its landing spot)
    bases: [{ name: 'Bar Harbor Airport', lon: -68.3624, lat: 44.4464 },
      { name: 'Southwest Harbor Coast Guard Station', short: 'SW Harbor Coast Guard', lon: -68.3126, lat: 44.2750 }],
    // places the Flyover's helicopter can land on the way (v1056, requested: "Crow Island in the Cranberry Isles, or
    // the open soccer field on Islesford"; spots checked on the NAIP photo): tick them in Landing spots
    landings: [
      { name: 'Crow Island', say: 'Landing on Crow Island', lon: -68.2384, lat: 44.2441 },   // (its grassy top; OSM's islet, off Little Cranberry's south shore)
      { name: 'Islesford soccer field', say: 'Landing on the Islesford soccer field', lon: -68.2380, lat: 44.2608 },   // (the mown field beside the town dock)
      // (v1058, requested: "Add the Coast Guard Station in Southwest Harbor as a place to land"): the open apron on its
      // wharf, Clark Point (OSM: Southwest Harbor Coast Guard Station Wharf)
      { name: 'Southwest Harbor Coast Guard Station', say: 'Landing at the Coast Guard station in Southwest Harbor', lon: -68.3126, lat: 44.2750,
        // said on the way there (v1084, requested: "On the flight to the coast guard station, say when it was set up there"):
        // history.uscg.mil (Southwest Harbor, Maine), the Southwest Harbor Public Library's archive, the Mount Desert Islander
        about: 'Clark Point has been a federal waterfront since 1937, when the U.S. Lighthouse Service set up its buoy depot here; two years later the Lighthouse Service was folded into the Coast Guard. The station itself goes back to a Life-Saving Station on Little Cranberry Island, set up by an Act of Congress in 1878. In the mid-1940s that station was moved here and joined to the Southwest Harbor station. Since 2005 the base has been a Sector Field Office of Coast Guard Sector Northern New England, home to its search and rescue crews and the patrol boat Bridle, some sixty to eighty people in all.' },
    ],
    // lakes and ponds (v1087, requested: "add Echo Lake and Long Pond to the map, so that I can add them to places"):
    // named on the map and listed under Lakes and ponds, to fly to or tick to fly over (OpenStreetMap's, Mount Desert)
    lakes: [
      { name: 'Echo Lake', lon: -68.3368, lat: 44.3270 },
      { name: 'Long Pond', lon: -68.3615, lat: 44.3276 },
    ],
    overview: [-69.45, 43.75, -67.95, 44.75],
    bay: [-69.25, 43.85, -68.1, 44.55],
    whole: { lon: -68.7, lat: 44.17, dist: 60000 },
    tz: 'America/New_York',   // (v1041: the scene's clock and the times shown are the bay's; regiontime.js)
  },
  'casco-bay': {
    name: 'Casco Bay & Midcoast', short: 'Casco',
    origin: [-70.05, 43.72],
    heliport: { name: 'the Portland Jetport', lon: -70.3093, lat: 43.6462 },   // (where the Flyover's helicopter takes off: v1049)
    // (v1088: east to Port Clyde with the chart region, for Rockland to Portland: Boothbay, Pemaquid, Muscongus Bay)
    overview: [-70.55, 43.42, -69.1, 44.12],
    bay: [-70.32, 43.55, -69.25, 44.05],
    whole: { lon: -70.06, lat: 43.71, dist: 40000 },
    tz: 'America/New_York',
  },
  // A trial run (v1019, requested: "do the quick test run for San Francisco Bay"): terrain, aerial photos and Live
  // AIS only, so far; no chart data (place names, marks) or buildings yet. Offered like Casco: ?region=sf-bay, or
  // the switch on an unlocked device.
  'sf-bay': {
    name: 'San Francisco Bay', short: 'SF Bay',
    origin: [-122.35, 37.8],
    heliport: { name: 'San Francisco International', lon: -122.3752, lat: 37.6261 },   // (where the Flyover's helicopter takes off: v1049; v1050: on the north ramp, by the big hangar, not the runways)
    overview: [-122.65, 37.4, -122.0, 38.2],
    bay: [-122.55, 37.45, -122.05, 38.12],
    whole: { lon: -122.33, lat: 37.78, dist: 55000 },
    chartWater: [-122.62, 37.42, -122.0, 38.17],   // (v1020: the chart's land tells water from land here; bay3d.js)
    trees: 'broadleaf',   // (v1032: a city's street and park trees, not Maine's spruce; bay3d.js)
    tz: 'America/Los_Angeles',
    armchair: true,   // (v1044: no chart in AudioChart; Bird's-eye leaves out what leads to one: bay3d.js)
  },
  // Portsmouth Harbor and the Piscataqua River (v1028, requested: "Let's bring piscataqua online, similar to how we
  // brought up San Francisco Bay"): Portsmouth, Kittery and New Castle, up the river to Great Bay, the Isles of
  // Shoals offshore. Its chart data is the region build of v399.
  'piscataqua': {
    name: 'Portsmouth Harbor and the Piscataqua', short: 'Piscataqua',
    origin: [-70.74, 43.07],
    heliport: { name: 'Portsmouth International at Pease', lon: -70.8233, lat: 43.0779 },   // (where the Flyover's helicopter takes off: v1049)
    overview: [-71.0, 42.85, -70.45, 43.25],
    bay: [-70.92, 42.94, -70.55, 43.18],
    whole: { lon: -70.73, lat: 43.06, dist: 30000 },
    chartWater: [-70.97, 42.88, -70.39, 43.22],   // (Great Bay's flats and the back channels, as SF's)
    tz: 'America/New_York',
  },
  // New York Harbor (v1032, requested: "Manhattan and Brooklyn, etc"): the Lower and Upper Bay, the Hudson to the
  // George Washington Bridge, the East and Harlem Rivers, the Kills, Jamaica Bay. Chart data from the region build.
  'new-york-harbor': {
    name: 'New York Harbor', short: 'New York',
    origin: [-74.0, 40.69],
    heliport: { name: 'the Downtown Manhattan Heliport', lon: -74.0089, lat: 40.7011 },   // (where the Flyover's helicopter takes off: v1049)
    overview: [-74.35, 40.4, -73.6, 41.0],
    bay: [-74.28, 40.47, -73.68, 40.93],
    whole: { lon: -74.02, lat: 40.66, dist: 40000 },
    chartWater: [-74.3, 40.45, -73.65, 40.95],   // (the Meadowlands and Jamaica Bay's marshes, as SF's flats)
    trees: 'broadleaf',
    tz: 'America/New_York',
    armchair: true,   // (v1044: no chart in AudioChart; Bird's-eye leaves out what leads to one: bay3d.js)
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
