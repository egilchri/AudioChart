// Observed wind and waves (v1016, requested: "now do the Matinicus Rock wind and waves"): what's blowing and what
// the sea is doing out at the mouth of the bay, measured, beside the Weather panel's forecast. Penobscot: NOAA's
// station on Matinicus Rock (MISM1: wind, gusts, pressure, air; it has no wave sensor), and the waves at the
// University of Maine's Buoy E (E01, NDBC 44032), 9 nm WSW of the Rock in the open Gulf. Casco: NOAA's Portland
// buoy (44007), which has both. All read from NERACOOS's ERDDAP server (CORS open, no key). Offline: the last
// reading, kept with its time and shown with its age, up to 12 hours; never an error on the screen.
const ERDDAP = 'https://data.neracoos.org/erddap/tabledap/', KEEP = 12 * 3600e3;
export const OBS = {
  'penobscot-bay': {
    wind: { ds: 'NDBC_C-MAN_MISM1', name: 'Matinicus Rock', id: 'MISM1', lat: 43.7836, lon: -68.8553 },
    waves: { ds: 'E01_waves', name: 'Buoy E', id: '44032', lat: 43.7148, lon: -69.3578, umaine: true },
  },
  'casco-bay': {
    wind: { ds: 'NDBC_44007', name: 'Portland buoy', id: '44007', lat: 43.525, lon: -70.14 },
    waves: { ds: 'NDBC_44007', name: 'Portland buoy', id: '44007', lat: 43.525, lon: -70.14 },
  },
};
// which bay's: Casco's west of 69.6° W, else Penobscot's
export const obsFor = lon => OBS[lon < -69.6 ? 'casco-bay' : 'penobscot-bay'];
export const obsPage = st => `https://www.ndbc.noaa.gov/station_page.php?station=${st.id}`;

async function rows(ds, vars, hours) {
  const r = await fetch(`${ERDDAP}${ds}.json?${vars.join(',')}&time%3E=now-${hours}hours`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${ds}: ${r.status}`);
  const { table: { columnNames: c, rows: R } } = await r.json();
  return R.map(row => Object.fromEntries(c.map((k, i) => [k, row[i]]))).sort((a, b) => (a.time < b.time ? -1 : 1));
}
const fin = v => typeof v === 'number' && Number.isFinite(v);
const lastWith = (R, k) => { for (let i = R.length - 1; i >= 0; i--) if (fin(R[i][k])) return R[i]; return null; };

// { fetched, wind: {t, from, kn, gust, mb, mbWas, air, dew, water}, waves: {t, ft, s, from} }; either can be missing
export async function readObs(set) {
  const [w, v] = await Promise.allSettled([
    rows(set.wind.ds, ['time', 'WDIR', 'WSPD', 'GST', 'PRES', 'ATMP', 'DEWP', 'WTMP', 'WVHT', 'DPD', 'MWD'], 4),   // (an NDBC station's waves too, if it has them)
    set.waves.umaine ? rows(set.waves.ds, ['time', 'significant_wave_height', 'dominant_wave_period', 'mean_wave_direction', 'significant_wave_height_qc_agg'], 4) : null,
  ]);
  const O = { fetched: Date.now() };
  const W = w.status === 'fulfilled' ? w.value : [], r = lastWith(W, 'WSPD');
  if (r) {
    const p = lastWith(W, 'PRES'), p3 = p && W.find(x => fin(x.PRES) && Date.parse(x.time) >= Date.parse(p.time) - 3.2 * 3600e3);
    O.wind = { t: r.time, from: fin(r.WDIR) ? r.WDIR : null, kn: r.WSPD * 1.94384, gust: fin(r.GST) ? r.GST * 1.94384 : null,
      mb: p ? p.PRES : null, mbWas: p3 && Date.parse(p.time) - Date.parse(p3.time) > 2.5 * 3600e3 ? p3.PRES : null,
      air: lastWith(W, 'ATMP')?.ATMP ?? null, dew: lastWith(W, 'DEWP')?.DEWP ?? null, water: lastWith(W, 'WTMP')?.WTMP ?? null };
  }
  if (set.waves.umaine) {
    const R = (v.status === 'fulfilled' ? v.value : []).filter(x => (x.significant_wave_height_qc_agg === 1 || x.significant_wave_height_qc_agg === 2) && fin(x.significant_wave_height)), x = R[R.length - 1];
    if (x) O.waves = { t: x.time, ft: x.significant_wave_height * 3.281, s: fin(x.dominant_wave_period) ? x.dominant_wave_period : null, from: fin(x.mean_wave_direction) ? x.mean_wave_direction : null };
  } else {
    const x = lastWith(W, 'WVHT');
    if (x) O.waves = { t: x.time, ft: x.WVHT * 3.281, s: fin(x.DPD) ? x.DPD : null, from: fin(x.MWD) ? x.MWD : null };
  }
  if (!O.wind && !O.waves) throw new Error('no readings');
  return O;
}
export const obsTime = O => Math.max(...[O?.wind?.t, O?.waves?.t].filter(Boolean).map(Date.parse), 0);

// The last reading kept (per bay), a new one asked for every `every` ms while running and online
export function makeObs(set, { onData, every = 10 * 60e3 }) {
  const KEY = `audiochart-obs-${set.wind.id}`;
  let O = null, timer = null, failed = false, busy = null;
  try { const k = JSON.parse(localStorage.getItem(KEY) || 'null'); if (k && Date.now() - obsTime(k) < KEEP) O = k; } catch (_) {}
  const fresh = () => O && Date.now() - obsTime(O) < KEEP;
  function refresh() {
    if (navigator.onLine === false) { failed = true; return Promise.resolve(); }
    return busy ??= readObs(set).then(N => { O = N; failed = false; try { localStorage.setItem(KEY, JSON.stringify(N)); } catch (_) {} onData?.(O); },
      () => { failed = true; if (O && !fresh()) O = null; onData?.(O); }).finally(() => { busy = null; });
  }
  return {
    set, refresh,
    start() { if (O) onData?.(O); refresh(); timer ??= setInterval(refresh, every); addEventListener('online', refresh); },
    stop() { clearInterval(timer); timer = null; removeEventListener('online', refresh); },
    get reading() { return fresh() ? O : null; },
    get failed() { return failed || navigator.onLine === false; },
  };
}

// Words
const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const pt16 = d => DIRS[Math.round((((d % 360) + 360) % 360) / 22.5) % 16];
const fF = c => `${Math.round(c * 9 / 5 + 32)}°F`;
const ago = t => { const m = Math.round((Date.now() - Date.parse(t)) / 60e3); return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
export const at = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export function windWords(w) {
  return `${w.kn < 1 ? 'calm' : `${w.from != null ? pt16(w.from) + ' ' : ''}${Math.round(w.kn)} kn`}${w.gust != null && w.gust >= w.kn + 3 ? `, gusts ${Math.round(w.gust)}` : ''}`;
}
export const wavesWords = v => `seas ${v.ft < 1 ? v.ft.toFixed(1) : Math.round(v.ft * 2) / 2} ft${v.s ? `, ${Math.round(v.s)} s` : ''}${v.from != null ? ` from ${pt16(v.from)}` : ''}`;
// one line for each station, for the panel
export function obsLines(set, O) {
  const L = [];
  if (O?.wind) {
    const w = O.wind, d = w.mb != null && w.mbWas != null ? w.mb - w.mbWas : null;
    L.push(`${set.wind.name}, ${at(w.t)} (${ago(w.t)}): ${windWords(w)}${w.air != null ? ` · air ${fF(w.air)}` : ''}${w.mb != null ? ` · ${Math.round(w.mb)} mb${d == null ? '' : Math.abs(d) < 1 ? ', steady' : d > 0 ? ', rising' : ', falling'}` : ''}`);
  }
  if (O?.waves) L.push(`${set.waves.name}, ${at(O.waves.t)} (${ago(O.waves.t)}): ${wavesWords(O.waves)}${O.wind?.water != null ? ` · water ${fF(O.wind.water)}` : ''}`);
  return L;
}
// The panel's conditions for them: the wind's strength and direction (the seas can raise the wind's look)
export function obsConditions(O) {
  const w = O?.wind; if (!w) return null;
  const C = {}, kn = Math.max(w.kn, (w.gust ?? 0) * 0.8);
  C.wind = kn < 5 ? 'calm' : kn < 12 ? 'breezy' : kn < 20 ? 'fresh' : 'rough';
  const ft = O.waves?.ft ?? 0; if (ft >= 4 && C.wind !== 'rough') C.wind = ft >= 6 ? 'rough' : 'fresh';
  if (w.from != null) C.windFrom = Math.round(w.from / 22.5) % 16 * 22.5;
  return C;
}
