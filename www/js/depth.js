/**
 * Charted depth at a point (v865): the Virtual Journey's depth sounder (through query.js's
 * depthAt) and the 3D view's Depth readout.
 *
 * Soundings are scattered points (~0.2 nm apart in open bay, closer inshore), so the depth
 * between them is an inverse-distance blend of the nearest few. Where a DEPARE shallow-area
 * band covers the point, the blend is held inside that band (a 1.8-3.6 m area never reads 6 m
 * because a deep sounding sits just outside it). Indexes are built lazily and rebuilt when the
 * caller passes different data objects.
 */
const CELL = 0.01;   // degrees, ~0.5 nm
let sndIdx = null, sndSrc = null, bandIdx = null, bandSrc = null;

function distNm(lon1, lat1, lon2, lat2) {
  const k = Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
  return Math.hypot((lon2 - lon1) * k, lat2 - lat1) * 60;
}

function soundingIndex(soundings) {
  if (sndSrc === soundings && sndIdx) return sndIdx;
  sndSrc = soundings; sndIdx = new Map();
  for (const f of soundings?.features || []) {
    const [lon, lat] = f.geometry.coordinates, v = f.properties?.valsou;
    if (typeof v !== 'number') continue;
    const k = `${Math.floor(lon / CELL)},${Math.floor(lat / CELL)}`;
    if (!sndIdx.has(k)) sndIdx.set(k, []);
    sndIdx.get(k).push([lon, lat, v]);
  }
  return sndIdx;
}

// zones: DEPARE 'shallow area' polygon features with depth_label like "1.8-3.6m".
function bandIndex(zones) {
  if (bandSrc === zones && bandIdx) return bandIdx;
  bandSrc = zones; bandIdx = new Map();
  for (const f of zones || []) {
    const m = (f.properties?.depth_label || '').match(/^(-?[\d.]+)-(-?[\d.]+)m$/);
    if (!m) continue;
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) {
      let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
      for (const [x, y] of poly[0]) { if (x < minLon) minLon = x; if (x > maxLon) maxLon = x; if (y < minLat) minLat = y; if (y > maxLat) maxLat = y; }
      const e = { minLon, maxLon, minLat, maxLat, poly, lo: Math.max(0, +m[1]), hi: +m[2] };
      for (let c = Math.floor(minLon / CELL); c <= Math.floor(maxLon / CELL); c++)
        for (let r = Math.floor(minLat / CELL); r <= Math.floor(maxLat / CELL); r++) {
          const k = `${c},${r}`; if (!bandIdx.has(k)) bandIdx.set(k, []); bandIdx.get(k).push(e);
        }
    }
  }
  return bandIdx;
}

function inRing(r, lon, lat) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Estimated charted depth (metres below chart datum, MLLW) at a point, from a soundings
 * FeatureCollection and an array of DEPARE zone features (either may be null).
 * Returns {m, nearNm, band:[lo,hi]|null} or null when there is no data within ~1 nm.
 */
export function depthAtFrom(soundings, zones, lat, lon) {
  const idx = soundingIndex(soundings);
  const c0 = Math.floor(lon / CELL), r0 = Math.floor(lat / CELL);
  const near = [];
  for (let ring = 0; ring <= 2; ring++) {
    for (let c = c0 - ring; c <= c0 + ring; c++)
      for (let r = r0 - ring; r <= r0 + ring; r++) {
        if (Math.max(Math.abs(c - c0), Math.abs(r - r0)) !== ring) continue;
        for (const s of idx.get(`${c},${r}`) || []) near.push([distNm(lon, lat, s[0], s[1]), s[2]]);
      }
    if (near.length >= 6 && ring >= 1) break;
  }
  near.sort((a, b) => a[0] - b[0]);
  const use = near.slice(0, 6).filter(n => n[0] < 1);
  let band = null;
  for (const e of bandIndex(zones).get(`${c0},${r0}`) || []) {
    if (lon < e.minLon || lon > e.maxLon || lat < e.minLat || lat > e.maxLat) continue;
    if (inRing(e.poly[0], lon, lat) && !e.poly.slice(1).some(h => inRing(h, lon, lat))) {
      if (!band || e.hi < band[1]) band = [e.lo, e.hi];
    }
  }
  if (!use.length && !band) return null;
  let m;
  if (use.length) {
    let w = 0, sum = 0;
    for (const [d, v] of use) { const wi = 1 / Math.max(d, 0.01) ** 2; w += wi; sum += wi * v; }
    m = sum / w;
  } else m = (band[0] + band[1]) / 2;
  if (band) m = Math.min(band[1], Math.max(band[0], m));
  return { m, nearNm: use.length ? use[0][0] : null, band };
}
