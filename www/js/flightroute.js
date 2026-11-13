// An airliner's route (v1130, requested: "in the info window we see for airplanes, can we see origin and
// destination?"). ADS-B doesn't carry it, so it's looked up by callsign in adsbdb (api.adsbdb.com, free, open to
// the browser): a crowd-kept list, and airlines move flight numbers about, so it can be stale (on 2026-11-13 it had
// UA1372 as SFO→LAS while she was flying Seattle→SFO). judgeRoute checks the listing against what the plane is
// actually doing; a listing she contradicts is shown greyed, as "may be out of date", never as fact.
export const ROUTE_CREDIT = 'Routes from adsbdb.com';
const NM = 1852, R = 6371000, DEG = Math.PI / 180;
const cache = new Map();   // callsign → { t, p (a promise of the route or null) }
const FRESH = 6 * 3600e3;
const airports = new Map();   // every airport seen at either end of a listing: code → place, for destOf's landing check

export function routeLookup(callsign) {
  const cs = (callsign || '').trim().toUpperCase();
  if (!/^[A-Z]{3}\d{1,4}[A-Z]?$/.test(cs)) return null;   // airline callsigns only (not N-numbers)
  const c = cache.get(cs);
  if (c && Date.now() - c.t < FRESH) return c;
  const e = { t: Date.now(), route: undefined };
  e.p = fetch(`https://api.adsbdb.com/v0/callsign/${cs}`, { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(j => { const f = j?.response?.flightroute; e.route = f?.origin && f?.destination ? { from: place(f.origin), to: place(f.destination) } : null; if (e.route) for (const q of [e.route.from, e.route.to]) if (q.code && q.lat != null) airports.set(q.code, q); return e.route; })
    .catch(() => { e.route = null; cache.delete(cs); return null; });   // (offline: try again later)
  cache.set(cs, e);
  return e;
}
const place = a => ({ code: a.iata_code || a.icao_code, city: a.municipality || a.name, name: a.name, lat: a.latitude, lon: a.longitude });

function distNM(lat1, lon1, lat2, lon2) {
  const a = Math.sin((lat2 - lat1) * DEG / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin((lon2 - lon1) * DEG / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a))) / NM;
}
function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * DEG) * Math.cos(lat2 * DEG);
  const x = Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) - Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos((lon2 - lon1) * DEG);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}
const off = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);

// Does the plane (a: lat, lon, trk, vr ft/min, alt ft, ground) fit the listed route? → { ok, why }
export function judgeRoute(route, a) {
  if (!route || a.lat == null) return { ok: true };
  const { from: o, to: d } = route;
  const dO = distNM(a.lat, a.lon, o.lat, o.lon), dD = distNM(a.lat, a.lon, d.lat, d.lon), dOD = distNM(o.lat, o.lon, d.lat, d.lon);
  if (a.ground) return dO < 5 || dD < 5 ? { ok: true } : { ok: false, why: `she's on the ground away from ${o.code} and ${d.code}` };
  if (dO + dD > dOD * 1.5 + 150) return { ok: false, why: `she's far off the line from ${o.code} to ${d.code}` };
  if (a.trk == null) return { ok: true };
  const toO = off(a.trk, bearing(a.lat, a.lon, o.lat, o.lon)), toD = off(a.trk, bearing(a.lat, a.lon, d.lat, d.lon));
  const descending = a.vr != null && a.vr < -300, climbing = a.vr != null && a.vr > 300;
  // arriving where she's listed as leaving from: heading for it, not long out of it, and not climbing out of it
  if (dO > 20 && dO < 200 && toO < 40 && !climbing && toD > 30) return { ok: false, why: `she's heading in to ${o.code}, not away from it` };
  // leaving where she's listed as bound: heading away from it, near it, climbing
  if (dD < 200 && dD > 5 && toD > 120 && (climbing || dD > 25)) return { ok: false, why: `she's heading away from ${d.code}` };
  // well clear of her origin and pointed away from her destination
  if (dO > 40 && toD > 110) return { ok: false, why: `she isn't heading toward ${d.code}` };
  if (descending && dD > 250 && dO < 200 && toO < 60) return { ok: false, why: `she's descending toward ${o.code}` };
  return { ok: true };
}

// Where she's bound (v1131, requested: "a filter so I can track planes with a San Francisco destination"):
// her listing's destination when she fits it; otherwise, when she's coming down (descending, or under 12,000 ft and
// not climbing) and pointed within 20° of a known airport within 60 nm, that one: so a plane flying a number whose
// listing is stale (UA1372, Seattle to SFO, listed SFO→LAS) still counts as bound in. → { code, city, nm, how } or null
export function destOf(a) {
  if (!a) return null;
  const r = routeLookup(a.flight)?.route;
  if (r && judgeRoute(r, a).ok) return { code: r.to.code, city: r.to.city, nm: a.lat != null ? distNM(a.lat, a.lon, r.to.lat, r.to.lon) : null, how: 'listed' };
  if (a.ground || a.lat == null || a.trk == null || (a.vr != null && a.vr > 300)) return null;
  if (!(a.vr != null && a.vr < -300) && !(a.alt != null && a.alt < 12000)) return null;
  let best = null;
  for (const q of airports.values()) {
    const nm = distNM(a.lat, a.lon, q.lat, q.lon);
    if (nm > 60 || nm < 0.5 || off(a.trk, bearing(a.lat, a.lon, q.lat, q.lon)) > 20) continue;
    if (!best || nm < best.nm) best = { code: q.code, city: q.city, nm, how: 'landing' };
  }
  return best;
}
