/**
 * Pure logic for splitting a route into overnight-to-overnight legs.
 * No DOM/localStorage access — plain data in, plain data out.
 */

function _distanceNm(lon1, lat1, lon2, lat2) {
  const R = 3440.065;
  const phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180;
  const dphi = (lat2 - lat1) * Math.PI / 180;
  const dlam = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Split `points` into legs at each interior point flagged `overnight: true`.
 * Distance is the actual routed distance along the intervening points (not
 * straight-line), so land-avoidance jogs are reflected in each leg's length.
 * Returns [] if there are no overnight-flagged interior points.
 */
export function splitIntoLegs(points, speedKt) {
  if (!Array.isArray(points) || points.length < 2) return [];

  const stopIndices = [];
  for (let i = 1; i < points.length - 1; i++) {
    if (points[i]?.overnight) stopIndices.push(i);
  }
  if (stopIndices.length === 0) return [];

  const allIndices = [0, ...stopIndices, points.length - 1]
    .filter((idx, i, arr) => i === 0 || idx !== arr[i - 1]); // dedupe adjacent duplicates

  const legs = [];
  for (let s = 0; s < allIndices.length - 1; s++) {
    const startIdx = allIndices[s], endIdx = allIndices[s + 1];
    let distNm = 0;
    for (let i = startIdx; i < endIdx; i++) {
      distNm += _distanceNm(points[i].lon, points[i].lat, points[i + 1].lon, points[i + 1].lat);
    }
    if (distNm < 0.01) continue; // skip degenerate zero-length legs
    legs.push({
      startIdx,
      endIdx,
      distNm,
      hours: speedKt > 0 ? distNm / speedKt : 0,
    });
  }
  return legs;
}
