// The freeways' traffic (v1128 begun, v1145 finished; requested: "put car traffic in each direction on the freeway (101?) If it can be
// correlated with the traffic report, all the better"): cars and trucks in every lane of each carriageway, each way
// (www/data/roads/<id>.json, from OpenStreetMap's motorways and trunk roads: design/roads/build_roads.py).
// Their speeds are Caltrans's: the freeway signs' travel times ("SFO ARPT 6 MIN", the District 4 changeable message
// signs, cwwp2.dot.ca.gov, read every 2 minutes) over the road from each sign to each place, worked out at build time,
// give the speed on the stretches on the way; nearer places count for more. Where no sign says, the traffic's free
// (65 mph on a freeway, 50 on a trunk road). The cars run at their stretch's speed, so they bunch where it's slow, as
// traffic does; fewer at night (by the scene's clock). Only near the view: each carriageway's cars made when she's
// within reach, dropped when she's out of it. Not on the big bridges' decks: bridges3d.js has their traffic.
import * as THREE from 'three';

const CMS = 'https://cwwp2.dot.ca.gov/data/d4/cms/cmsStatusD04.json';
const STEP = 20, BIN = 200, LANE = 3.7, MAX = 9000;
const COLOURS = [0xf2f2f0, 0xf2f2f0, 0x1c1c1e, 0x1c1c1e, 0x9a9da3, 0x9a9da3, 0x5d6168, 0xb3262b, 0x24427a, 0x6f8fae, 0x2e5a3c, 0xd8c9a8];
// the traffic through the day, a share of a lane's 1,900 cars an hour (the bay's weekday, roughly), by hour
const DAY = [0.12, 0.08, 0.06, 0.06, 0.1, 0.3, 0.65, 0.95, 1, 0.85, 0.75, 0.75, 0.78, 0.78, 0.8, 0.9, 1, 1, 0.9, 0.7, 0.55, 0.45, 0.35, 0.2];

export async function makeTraffic({ scene, rid, wx, wz, heightAt, clockMin }) {
  let J;
  try { const r = await fetch(`./data/roads/${rid}.json`); if (!r.ok) return null; J = await r.json(); } catch (_) { return null; }
  const ground = (lon, lat) => Math.max(0, heightAt(lon, lat) || 0);
  // each carriageway sampled every 20 m: x, z, s (metres along her), y (her surface, once taken); her bridges' ranges
  const C = J.chains.map((c, i) => {
    const S = []; let s = 0;
    for (let k = 1; k < c.pts.length; k++) {
      const [a0, b0] = c.pts[k - 1], [a1, b1] = c.pts[k], x0 = wx(a0), z0 = wz(b0), x1 = wx(a1), z1 = wz(b1), L = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(L / STEP));
      for (let j = k === 1 ? 0 : 1; j <= n; j++) { const f = j / n; S.push({ lon: a0 + (a1 - a0) * f, lat: b0 + (b1 - b0) * f, x: x0 + (x1 - x0) * f, z: z0 + (z1 - z0) * f, s: s + L * f, y: 0, deck: false }); }
      s += L;
    }
    const xs = S.map(p => p.x), zs = S.map(p => p.z);
    // her free speed, m/s; her speed by 200 m bin (from the signs), and her cars when she's near
    const free = (/^I |^US /.test(c.ref) || c.lanes >= 3) && !c.two ? 29 : 22;
    return { i, c, S, L: s, scale: c.len > 0 ? s / c.len : 1, x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs), free, v: new Float32Array(Math.ceil(s / BIN) + 1).fill(free), cars: null };
  });
  function profile(ch) {   // her surface: the ground's upper envelope, smoothed; across her bridges, straight between their ends
    const S = ch.S, n = S.length, raw = S.map(p => ground(p.lon, p.lat));
    const env = raw.map((_, k) => Math.max(...raw.slice(Math.max(0, k - 2), k + 3)));
    for (let k = 0; k < n; k++) { let a = 0, c = 0; for (let j = Math.max(0, k - 3); j <= Math.min(n - 1, k + 3); j++) { a += env[j]; c++; } S[k].y = a / c; }
    for (const [b0, b1] of ch.c.bridges) {
      const s0 = b0 * ch.scale, s1 = b1 * ch.scale, k0 = S.findIndex(p => p.s >= s0), k1 = S.findLastIndex(p => p.s <= s1); if (k0 < 0 || k1 <= k0) continue;
      for (let k = k0; k <= k1; k++) { const f = (k - k0) / (k1 - k0); S[k].y = Math.max(S[k0].y + (S[k1].y - S[k0].y) * f, raw[k] + 1.5); }
    }
  }
  for (const ch of C) profile(ch);

  // ── the cars: one instanced mesh of boxes ──
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.35 });
  const mesh = new THREE.InstancedMesh(geo, mat, MAX); mesh.count = 0; mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  { const c = new THREE.Color(); for (let i = 0; i < MAX; i++) mesh.setColorAt(i, c.set(COLOURS[i % COLOURS.length])); }
  scene.add(mesh);
  const flow = () => { const h = ((clockMin?.() ?? new Date().getHours() * 60) / 60) % 24, a = DAY[Math.floor(h)], b = DAY[(Math.floor(h) + 1) % 24]; return 0.53 * (a + (b - a) * (h % 1)); };   // (cars a second a lane)
  const vAt = (ch, s) => { const f = s / BIN, i = Math.min(ch.v.length - 2, Math.max(0, Math.floor(f))), u = Math.min(1, Math.max(0, f - i)); return ch.v[i] + (ch.v[i + 1] - ch.v[i]) * u; };
  function populate(ch) {   // her cars, spaced as her traffic's flow at her speeds: closer where it's slow
    const q = flow(), cars = [], n = ch.c.lanes;
    for (let ln = 0; ln < n; ln++) {
      const off = ch.c.two ? (ln + 0.5) * LANE : (ln - (n - 1) / 2) * LANE;
      for (let s = Math.random() * 40; s < ch.L;) {
        const v = vAt(ch, s), truck = Math.random() < (ln === n - 1 ? 0.18 : 0.04), car = { s, off, f: 0.93 + Math.random() * 0.12 - (truck ? 0.06 : 0), truck, col: truck ? 0xe9e7e2 : COLOURS[Math.random() * COLOURS.length | 0] };
        cars.push(car);
        s += Math.max(truck ? 17 : 8, v / q * (0.5 + Math.random()));
      }
    }
    ch.cars = cars;
  }
  // the view's reach: carriageways within it get their cars
  let R = 0, vx = 0, vz = 0, on = true;
  function near(x, z, dist) {
    vx = x; vz = z; R = dist < 9000 ? Math.max(1500, Math.min(5000, dist * 1.4)) : 0;
    for (const ch of C) {
      const inR = R && x > ch.x0 - R && x < ch.x1 + R && z > ch.z0 - R && z < ch.z1 + R;
      if (inR && !ch.cars) populate(ch); else if (!inR && ch.cars) ch.cars = null;
    }
  }
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0), P = new THREE.Vector3(), SC = new THREE.Vector3();
  function update(dt) {
    let n = 0;
    if (on && R) for (const ch of C) {
      if (!ch.cars) continue;
      const S = ch.S, L = ch.L;
      for (const a of ch.cars) {
        a.s += vAt(ch, a.s) * a.f * dt; if (a.s >= L) a.s -= L;
        if (n >= MAX) continue;
        let k = Math.min(S.length - 2, Math.floor(a.s / STEP)); while (k > 0 && S[k].s > a.s) k--; while (k < S.length - 2 && S[k + 1].s <= a.s) k++;
        const A = S[k], B = S[k + 1], u = Math.min(1, Math.max(0, (a.s - A.s) / ((B.s - A.s) || 1)));
        if (A.deck) continue;   // (a big bridge's: its own traffic)
        const tx = B.x - A.x, tz = B.z - A.z, tl = Math.hypot(tx, tz) || 1, nx = -tz / tl, nz = tx / tl;
        const px = A.x + tx * u + nx * a.off, pz = A.z + tz * u + nz * a.off;
        if (Math.abs(px - vx) > R + 400 || Math.abs(pz - vz) > R + 400) continue;
        const L3 = a.truck ? 15 : 4.7, W3 = a.truck ? 2.6 : 1.85, H3 = a.truck ? 3.8 : 1.5;
        P.set(px, A.y + (B.y - A.y) * u + H3 / 2 + 0.05, pz);
        mesh.setMatrixAt(n, M.compose(P, Q.setFromAxisAngle(UP, Math.atan2(tx, tz)), SC.set(W3, H3, L3)));
        if (slot[n] !== a.col) { slot[n] = a.col; mesh.setColorAt(n, _c.set(a.col)); mesh.instanceColor.needsUpdate = true; }
        n++;
      }
    }
    mesh.count = n; mesh.instanceMatrix.needsUpdate = true;
  }
  const _c = new THREE.Color(), slot = new Int32Array(MAX).fill(-1);

  // ── the signs' travel times: each the speed on the road from the sign to her place ──
  let report = { t: 0, signs: 0, est: 0 };
  async function poll() {
    let D;
    try { const r = await fetch(CMS, { cache: 'no-store' }); if (!r.ok) throw new Error(r.status); D = await r.json(); } catch (e) { console.warn('[traffic] signs', e); return; }
    const byId = new Map(J.signs.map(s => [s.id, s])), sum = C.map(ch => new Float32Array(ch.v.length)), wt = C.map(ch => new Float32Array(ch.v.length));
    let est = 0, nsigns = 0;
    for (const x of D.data || []) {
      const c = x.cms, sg = byId.get((c?.location?.locationName || '').split('-')[0]); if (!sg) continue;
      const m = c.message || {}, lines = [1, 2].flatMap(p => [1, 2, 3].map(k => m[`phase${p}`]?.[`phase${p}Line${k}`] || ''));
      let any = false;
      for (const l of lines) {
        const mm = /^(.*?)\s+(\d+)\s*MIN/.exec(l); if (!mm) continue;
        const to = sg.d[mm[1].trim()]; if (!to) continue;
        const [len, ranges] = to, v = len / (+mm[2] * 60);
        if (len < 3000 || v < 2.2 || v > 36) continue;   // (too short to tell, or a road that isn't the one they mean)
        const w = 1 / (len / 1000); any = true; est++;
        for (const [ci, s0, s1] of ranges) {
          const ch = C[ci]; if (!ch) continue;
          for (let b = Math.floor(s0 * ch.scale / BIN); b <= Math.min(ch.v.length - 1, Math.floor(s1 * ch.scale / BIN)); b++) { sum[ci][b] += v * w; wt[ci][b] += w; }
        }
      }
      if (any) nsigns++;
    }
    C.forEach((ch, i) => { for (let b = 0; b < ch.v.length; b++) ch.v[b] = wt[i][b] ? Math.min(ch.free * 1.1, sum[i][b] / wt[i][b]) : ch.free; });
    report = { t: Date.now(), signs: nsigns, est };
  }
  poll(); const timer = setInterval(poll, 120e3);

  return {
    mesh, near, update, report: () => report,
    set on(v) { on = v; mesh.visible = v; },
    // (v1126's rail decks' kin) the big bridges' road decks: those stretches left to bridges3d.js's traffic
    setDecks(D) {
      const cells = new Set(), key = (x, z) => `${Math.floor(x / 25)},${Math.floor(z / 25)}`;
      for (const P of D) for (let i = 1; i < P.length; i++) { const a = P[i - 1], b = P[i], n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 10); for (let j = 0; j <= n; j++) cells.add(key(a.x + (b.x - a.x) * j / n, a.z + (b.z - a.z) * j / n)); }
      // (v1145: and the cells round them: the Bay Bridge's lower deck lies a lane or two off the model's line, and its
      // cars, not on a deck cell, were drawn in the air beside her)
      const near = (x, z) => { for (const dx of [-25, 0, 25]) for (const dz of [-25, 0, 25]) if (cells.has(key(x + dx, z + dz))) return true; return false; };
      for (const ch of C) for (const p of ch.S) p.deck = near(p.x, p.z);
    },
    reheight(w, s, e, n) { for (const ch of C) { const S = ch.S; if (S.some(p => p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n)) profile(ch); } },
    night: k => mat.emissive.setRGB(0.55 * k, 0.45 * k, 0.3 * k),
    // the speed on the road nearest (x, z), m/s, and her route (for checking)
    speedAt(x, z) { let b = null, bd = 1e12; for (const ch of C) for (const p of ch.S) { const d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < bd) { bd = d; b = [ch, p]; } } return b && { ref: b[0].c.ref, v: vAt(b[0], b[1].s), free: b[0].free, d: Math.sqrt(bd) }; },
    stop() { clearInterval(timer); },
    // (for testing) the carriageways within r m of (lon, lat): her ref, her points there, how many on a big bridge's
    // deck (left to bridges3d.js), how many at the water (y under 1 m) and not on one, and her bridges' ranges
    debugNear(lon, lat, r) {
      const x = wx(lon), z = wz(lat), out = [];
      for (const ch of C) { const P = ch.S.filter(p => Math.hypot(p.x - x, p.z - z) < r); if (!P.length) continue;
        out.push({ i: ch.i, ref: ch.c.ref, n: P.length, deck: P.filter(p => p.deck).length, wet: P.filter(p => !p.deck && p.y < 1).length, off: P.filter(p => !p.deck).map(p => [+p.lon.toFixed(5), +p.lat.toFixed(5), +p.y.toFixed(1), +heightAt(p.lon, p.lat).toFixed(1)]).slice(0, 8), bridges: ch.c.bridges.length, at: P.filter(p => !p.deck && p.y < 1).slice(0, 2).map(p => [+p.lon.toFixed(5), +p.lat.toFixed(5)]) }); }
      return out;
    },
  };
}
