// The tide gauge, measured against predicted (v1014, requested: "now do the measured vs predicted tide"). NOAA's
// live water-level gauge for each bay — Bar Harbor for Penobscot (Rockland has none), Portland for Casco — every
// six minutes, against NOAA's prediction for the same gauge: the difference is the surge (wind, pressure, a storm)
// that the tide tables leave out. Heights are feet above mean lower low water, the chart's datum. Offline: the
// predictions (three days of them) are kept, so the predicted tide is still right; the last measurement is kept
// with its time and shown with its age, up to 12 hours. Never an error on the screen.
export const GAUGES = {
  'penobscot-bay': { id: '8413320', name: 'Bar Harbor', lat: 44.3922, lon: -68.2043 },
  'casco-bay': { id: '8418150', name: 'Portland', lat: 43.6581, lon: -70.2442 },
};
const API = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter', KEEP = 12 * 3600e3;
export const gaugePage = G => `https://tidesandcurrents.noaa.gov/stationhome.html?id=${G.id}`;
const ymd = d => d.toISOString().slice(0, 16).replace(/-/g, '').replace('T', '%20');
const when = t => Date.parse(t.replace(' ', 'T') + ':00Z');

async function series(G, q) {
  const r = await fetch(`${API}?station=${G.id}&datum=MLLW&units=english&time_zone=gmt&format=json&application=AudioChart&${q}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${G.id}: ${r.status}`);
  const j = await r.json(), rows = j.data || j.predictions || [];
  return rows.map(p => [when(p.t), parseFloat(p.v)]).filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));
}

// The predicted height at time t, from the kept predictions (six minutes apart); null outside them
export function predAt(S, t) {
  const P = S?.pred; if (!P?.length || t < P[0][0] || t > P[P.length - 1][0]) return null;
  let lo = 0, hi = P.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P[m][0] <= t) lo = m; else hi = m; }
  const [t0, v0] = P[lo], [t1, v1] = P[hi];
  return t1 === t0 ? v0 : v0 + (v1 - v0) * (t - t0) / (t1 - t0);
}
// The newest measurement, and the surge: measured less predicted, over the last half hour (a seiche or a wake
// moves one reading; the surge is what stays)
export function surgeOf(S) {
  const M = S?.meas; if (!M?.length) return null;
  const last = M[M.length - 1], d = M.filter(([t]) => t > last[0] - 30 * 60e3).map(([t, v]) => v - predAt(S, t)).filter(Number.isFinite);
  return d.length ? { t: last[0], ft: last[1], surge: d.reduce((a, b) => a + b, 0) / d.length } : null;
}
// Rising or falling, by the prediction an hour either side (feet an hour), and the next highs and lows
export function trendAt(S, t) {
  const a = predAt(S, t - 30 * 60e3), b = predAt(S, t + 30 * 60e3);
  return a == null || b == null ? null : b - a;
}
export function nextTurns(S, t, n = 2) {
  const P = S?.pred || [], out = [];
  for (let i = 1; i < P.length - 1 && out.length < n; i++) {
    if (P[i][0] <= t) continue;
    const up = P[i][1] - P[i - 1][1], dn = P[i + 1][1] - P[i][1];
    if (up > 0 && dn <= 0) out.push({ t: P[i][0], ft: P[i][1], high: true });
    else if (up < 0 && dn >= 0) out.push({ t: P[i][0], ft: P[i][1], high: false });
  }
  return out;
}

// Keeps the predictions (asked for again when fewer than a day of them is left) and the last day measured; asks for
// new measurements every `every` ms while online. onData(state) at once with what's kept, and after each read.
export function makeTideGauge(G, { onData, every = 6 * 60e3 }) {
  const KEY = `audiochart-tide-${G.id}`;
  let S = { pred: [], meas: [] }, timer = null, failed = false;
  try { const k = JSON.parse(localStorage.getItem(KEY) || 'null'); if (k?.pred) S = k; } catch (_) {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (_) {} };
  async function refresh() {
    if (navigator.onLine === false) { failed = true; return; }
    const now = Date.now(), P = S.pred;
    const [p, m] = await Promise.allSettled([
      !P.length || P[P.length - 1][0] < now + 24 * 3600e3 || P[0][0] > now - 24 * 3600e3
        ? series(G, `product=predictions&interval=6&begin_date=${ymd(new Date(now - 24 * 3600e3))}&range=96`) : null,
      series(G, 'product=water_level&range=24'),
    ]);
    if (p.status === 'fulfilled' && p.value?.length) S.pred = p.value;
    if (m.status === 'fulfilled' && m.value.length) S.meas = m.value;
    failed = m.status !== 'fulfilled' || !m.value.length;
    S.meas = S.meas.filter(([t]) => t > now - 24 * 3600e3);
    save(); onData(S);
  }
  return {
    start() { onData(S); refresh(); timer ??= setInterval(refresh, every); addEventListener('online', refresh); },
    stop() { clearInterval(timer); timer = null; removeEventListener('online', refresh); },
    get state() { return S; },
    get surge() { const s = surgeOf(S); return s && Date.now() - s.t < KEEP ? s : null; },   // (none older than 12 hours)
    get failed() { return failed || navigator.onLine === false; },
  };
}

// The last day and the next half: predicted (dashed) and measured (solid), now marked, as a small SVG
export function tideChart(S, now = Date.now(), w = 260, h = 84) {
  const t0 = now - 24 * 3600e3, t1 = now + 12 * 3600e3;
  const P = (S?.pred || []).filter(([t]) => t >= t0 && t <= t1), M = (S?.meas || []).filter(([t]) => t >= t0);
  if (P.length < 2) return '';
  const all = [...P, ...M].map(p => p[1]), lo = Math.floor(Math.min(...all) - 0.5), hi = Math.ceil(Math.max(...all) + 0.5);
  const X = t => ((t - t0) / (t1 - t0) * (w - 24) + 22).toFixed(1), Y = v => ((hi - v) / (hi - lo) * (h - 24) + 6).toFixed(1);
  const path = A => A.map(([t, v], i) => `${i ? 'L' : 'M'}${X(t)},${Y(v)}`).join('');
  const ticks = [lo, Math.round((lo + hi) / 2), hi].map(v => `<text x="18" y="${+Y(v) + 3}" text-anchor="end">${String(v).replace('-', '−')}</text><line x1="22" x2="${w - 2}" y1="${Y(v)}" y2="${Y(v)}" class="g"/>`).join('');
  return `<svg class="tidechart" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Tide, the last day and the next 12 hours: predicted dashed, measured solid">`
    + `${ticks}<line x1="${X(now)}" x2="${X(now)}" y1="2" y2="${h - 14}" class="now"/>`
    + `<path d="${path(P)}" class="p"/>${M.length > 1 ? `<path d="${path(M)}" class="m"/>` : ''}`
    + `<text x="22" y="${h - 1}">−24 h</text><text x="${X(now)}" y="${h - 1}" text-anchor="middle">now</text><text x="${w - 2}" y="${h - 1}" text-anchor="end">+12 h</text></svg>`;
}
