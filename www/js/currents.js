// The NECOFS forecast currents (v1015, requested: "now do the NECOFS current arrows"): UMass Dartmouth's FVCOM
// model of the Gulf of Maine (and in Casco, from v1016, its finer Casco Bay model), its surface current hourly over
// each bay, out about four days, built at deploy by preprocess/necofs_currents.mjs into data/currents/<bay>.json. Kept in localStorage, so offline the arrows go on
// until the forecast runs out; then (and with nothing kept) there are none. Never an error on the screen.
const KEY = id => `audiochart-currents-${id}`;

const int8 = s => { const b = atob(s), uv = new Int8Array(b.length); for (let i = 0; i < b.length; i++) uv[i] = (b.charCodeAt(i) << 24) >> 24; return uv; };
// The Gulf of Maine model's hours (evenly spaced), and in Casco the finer Casco Bay model's (v1016: its own list of
// hours, which can have gaps), each a layer of points
function unpack(J) {
  const F = { ...J, n: J.pts.length / 4, uv: int8(J.uv), t1: J.t0 + (J.nt - 1) * J.dt };
  F.ts = Array.from({ length: J.nt }, (_, k) => J.t0 + k * J.dt);
  if (J.fine?.ts?.length) F.fine = { ...J.fine, n: J.fine.pts.length / 4, uv: int8(J.fine.uv), t0: J.fine.ts[0], t1: J.fine.ts[J.fine.ts.length - 1] };
  for (const L of [F, F.fine]) if (L) {   // a point that never runs 0.1 kn is ashore (Casco's model covers the land, for flooding)
    L.wet = new Uint8Array(L.n);
    for (let i = 0; i < L.uv.length; i += 2) if (Math.abs(L.uv[i]) * L.unit >= 5 || Math.abs(L.uv[i + 1]) * L.unit >= 5) L.wet[(i >> 1) % L.n] = 1;
  }
  return F;
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

// Every point's current in layer L at time t (ms), interpolated between its hours: Float32Array [u, v, ...] in knots
// (east, north), or null outside them (or in a gap of more than an hour and a half)
export function currentsAt(L, t) {
  const T = L?.ts; if (!T || t < T[0] || t > T[T.length - 1]) return null;
  let a = 0; while (a < T.length - 2 && T[a + 1] <= t) a++;
  if (T.length < 2 || T[a + 1] - T[a] > 1.5 * 3600e3) return null;
  const f = (t - T[a]) / (T[a + 1] - T[a]), n = L.n, out = new Float32Array(n * 2), k = L.unit * 0.0194384;
  for (let i = 0; i < n * 2; i++) out[i] = (L.uv[a * n * 2 + i] * (1 - f) + L.uv[(a + 1) * n * 2 + i] * f) * k;
  return out;
}
// The layer for time t: the finer one when it has that hour, else the Gulf of Maine model's
export function layerAt(F, t) {
  if (F?.fine) { const uv = currentsAt(F.fine, t); if (uv) return { L: F.fine, uv }; }
  const uv = currentsAt(F, t); return uv ? { L: F, uv } : null;
}
