// Buoy F, West Penobscot Bay (v1013, requested: "start with Buoy F, but remember, we should fail gracefully if we
// are out of wifi range"). The University of Maine's NERACOOS buoy F01 between Owls Head and North Haven
// (NDBC 44033): the current measured from 10 m down to the bottom every hour, the current at 2 m, temperature and
// salinity at 1 to 50 m, wind, air and pressure, and waves. Read straight from NERACOOS's ERDDAP server (CORS
// open, no key). Offline: the last reading, kept in localStorage, shown with its age; none older than 12 hours,
// and nothing at all with no reading. Never an error on the screen.
export const BUOY_F = { name: 'Buoy F', site: 'F01', ndbc: '44033', lat: 44.0534, lon: -68.9985,
  page: 'https://mariners.neracoos.org/platform/F01', credit: 'University of Maine · NERACOOS' };
const ERDDAP = 'https://data.neracoos.org/erddap/tabledap/', KEY = 'audiochart-buoyf', KEEP = 12 * 3600e3;
const KN = 0.0194384;   // cm/s to knots

async function table(ds, vars, hours) {
  const r = await fetch(`${ERDDAP}${ds}.json?${vars.join(',')}&time%3E=now-${hours}hours`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${ds}: ${r.status}`);
  const { table: { columnNames: c, rows } } = await r.json();
  return rows.map(row => Object.fromEntries(c.map((k, i) => [k, row[i]])));
}
const good = q => q === 1 || q === 2;   // QARTOD: pass, or not evaluated
const newest = rows => rows.reduce((m, r) => (r.time > m ? r.time : m), '');
const fin = v => typeof v === 'number' && Number.isFinite(v);

// The newest reading of each kind (any of them can be missing: an instrument down, or a dataset late)
export async function readBuoyF() {
  const [adcp, surf, ocean, met, waves] = await Promise.allSettled([
    table('F01_doppler_currents', ['time', 'depth', 'current_speed', 'current_direction', 'current_speed_qc_agg'], 4),
    table('F01_surface_currents', ['time', 'current_speed', 'current_direction', 'current_speed_qc_agg'], 4),
    table('F01_ocean_agg', ['time', 'depth', 'temperature', 'salinity', 'temperature_qc_agg', 'salinity_qc_agg'], 4),
    table('F01_met', ['time', 'wind_speed', 'wind_gust', 'wind_direction', 'air_temperature', 'barometric_pressure', 'visibility', 'wind_speed_qc_agg'], 3),
    table('F01_waves', ['time', 'significant_wave_height', 'dominant_wave_period', 'mean_wave_direction', 'significant_wave_height_qc_agg'], 4),
  ]);
  const ok = p => p.status === 'fulfilled' ? p.value : [];
  const R = { fetched: Date.now() };
  { const rows = ok(adcp), t = newest(rows);   // the profile: speed and the way it sets, at each depth
    const P = rows.filter(r => r.time === t && good(r.current_speed_qc_agg) && fin(r.current_speed) && fin(r.current_direction))
      .map(r => ({ depth: r.depth, kn: r.current_speed * KN, to: r.current_direction })).sort((a, b) => a.depth - b.depth);
    if (P.length) R.profile = { t, P }; }
  { const r = ok(surf).filter(r => good(r.current_speed_qc_agg) && fin(r.current_speed)).sort((a, b) => a.time < b.time ? 1 : -1)[0];
    if (r) R.surface = { t: r.time, depth: 2, kn: r.current_speed * KN, to: r.current_direction }; }
  { const rows = ok(ocean), byDepth = new Map();   // the newest good temperature (and salinity) at each depth
    for (const r of rows) if (good(r.temperature_qc_agg) && fin(r.temperature) && !(byDepth.get(r.depth)?.time > r.time)) byDepth.set(r.depth, r);
    const W = [...byDepth.values()].sort((a, b) => a.depth - b.depth).map(r => ({ depth: r.depth, t: r.time, c: r.temperature, psu: good(r.salinity_qc_agg) && fin(r.salinity) ? r.salinity : null }));
    if (W.length) R.water = W; }
  { const r = ok(met).filter(r => good(r.wind_speed_qc_agg) && fin(r.wind_speed)).sort((a, b) => a.time < b.time ? 1 : -1)[0];
    if (r) R.met = { t: r.time, kn: r.wind_speed * 1.94384, gust: fin(r.wind_gust) ? r.wind_gust * 1.94384 : null, from: r.wind_direction,
      air: fin(r.air_temperature) ? r.air_temperature : null, mb: fin(r.barometric_pressure) ? r.barometric_pressure : null, vis: fin(r.visibility) ? r.visibility : null }; }
  { const r = ok(waves).filter(r => good(r.significant_wave_height_qc_agg) && fin(r.significant_wave_height)).sort((a, b) => a.time < b.time ? 1 : -1)[0];
    if (r) R.waves = { t: r.time, hs: r.significant_wave_height, per: fin(r.dominant_wave_period) ? r.dominant_wave_period : null, from: fin(r.mean_wave_direction) ? r.mean_wave_direction : null }; }
  if (!R.profile && !R.surface && !R.water && !R.met && !R.waves) throw new Error('no readings');
  return R;
}

// The reading's time: the newest of its parts
export const buoyTime = R => Date.parse([R.profile?.t, R.surface?.t, R.met?.t, R.waves?.t, ...(R.water || []).map(w => w.t)].filter(Boolean).sort().pop() || 0);

// Keeps the last reading and asks for a new one every `every` ms while online; calls onData(reading) with the kept
// one at once (if any, and not too old) and with each new one. A failed read changes nothing.
export function makeBuoyF({ onData, every = 10 * 60e3 }) {
  let R = null, timer = null, failed = false;
  try { const k = JSON.parse(localStorage.getItem(KEY) || 'null'); if (k && Date.now() - buoyTime(k) < KEEP) R = k; } catch (_) {}
  const fresh = () => R && Date.now() - buoyTime(R) < KEEP;
  async function refresh() {
    if (navigator.onLine === false) return;
    try {
      const N = await readBuoyF();
      R = N; failed = false; try { localStorage.setItem(KEY, JSON.stringify(N)); } catch (_) {}
      onData(R);
    } catch (_) { failed = true; if (R && !fresh()) { R = null; onData(null); } }   // (out of range: keep what we have, while it's recent)
  }
  return {
    start() { if (R) onData(R); refresh(); timer ??= setInterval(refresh, every); addEventListener('online', refresh); },
    stop() { clearInterval(timer); timer = null; removeEventListener('online', refresh); },
    get reading() { return fresh() ? R : null; },
    get failed() { return failed || navigator.onLine === false; },   // (the last try didn't reach NERACOOS)
  };
}

// Words for the card and the label
export const compass16 = d => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round((((d % 360) + 360) % 360) / 22.5) % 16];
// Up the bay is the flood, down it the ebb (the bay runs about 015°–195° true here); slack under 0.15 kn
export const tideWord = (kn, to) => kn < 0.15 ? 'slack' : Math.cos((to - 15) * Math.PI / 180) > 0.4 ? 'flood' : Math.cos((to - 15) * Math.PI / 180) < -0.4 ? 'ebb' : '';
// The current a boat feels: the 2 m reading if it's recent, else the profile's shallowest
export function topCurrent(R) {
  const p0 = R?.profile?.P[0], s = R?.surface;
  if (s && (!p0 || Date.parse(s.t) >= Date.parse(R.profile.t) - 2 * 3600e3)) return s;
  return p0 ? { ...p0, t: R.profile.t } : null;
}
// The strongest current in the profile, and its depth
export const strongest = R => R?.profile?.P.reduce((m, p) => (p.kn > (m?.kn ?? -1) ? p : m), null) ?? null;
