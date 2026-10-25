// The NECOFS forecast currents (v1015, requested: "now do the NECOFS current arrows"): UMass Dartmouth's FVCOM
// model of the Gulf of Maine, its surface current hourly over each bay, out about four days, built at deploy by
// preprocess/necofs_currents.mjs into data/currents/<bay>.json. Kept in localStorage, so offline the arrows go on
// until the forecast runs out; then (and with nothing kept) there are none. Never an error on the screen.
const KEY = id => `audiochart-currents-${id}`;

function unpack(J) {
  const b = atob(J.uv), uv = new Int8Array(b.length);
  for (let i = 0; i < b.length; i++) uv[i] = (b.charCodeAt(i) << 24) >> 24;
  return { ...J, n: J.pts.length / 4, uv, t1: J.t0 + (J.nt - 1) * J.dt };
}

// onData(forecast) at once with the kept one (if it isn't over), and when a newer one comes
export function makeCurrents(id, { onData, every = 3 * 3600e3 }) {
  let F = null, timer = null;
  try { const k = JSON.parse(localStorage.getItem(KEY(id)) || 'null'); if (k?.uv) F = unpack(k); } catch (_) {}
  if (F && F.t1 < Date.now()) F = null;
  async function refresh() {
    if (navigator.onLine === false) return;
    try {
      const r = await fetch(`data/currents/${id}.json`, { cache: 'no-store' }); if (!r.ok) return;
      const J = await r.json(); if (!J?.uv || (F && J.made <= F.made)) return;
      F = unpack(J); try { localStorage.setItem(KEY(id), JSON.stringify(J)); } catch (_) {}
      onData(F);
    } catch (_) {}   // (out of range: keep what we have)
  }
  return {
    start() { if (F) onData(F); refresh(); timer ??= setInterval(refresh, every); addEventListener('online', refresh); },
    get forecast() { return F; },
  };
}

// Every point's current at time t (ms), interpolated between the hours: Float32Array [u, v, ...] in knots (east,
// north), or null outside the forecast
export function currentsAt(F, t) {
  if (!F || t < F.t0 || t > F.t1) return null;
  const h = (t - F.t0) / F.dt, a = Math.min(Math.floor(h), F.nt - 2), f = h - a, n = F.n, out = new Float32Array(n * 2), k = F.unit * 0.0194384;
  for (let i = 0; i < n * 2; i++) out[i] = (F.uv[a * n * 2 + i] * (1 - f) + F.uv[(a + 1) * n * 2 + i] * f) * k;
  return out;
}
