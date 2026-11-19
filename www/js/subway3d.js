// Underground (v1149, requested: "When I ask to see the red line, maybe it's underground ... let's develop an
// underground POV, for say front view and side view"): riding a train while she's in a tunnel (the T downtown, the
// Blue Line under the harbour), Cab, Ahead, Side and Behind look round her in the tunnel she's in, not at the street
// over her. The tunnel's built where she is, along her own track 350 m back and 450 m on: a box tunnel of grimy
// concrete, the other track beside hers where there is one (the T's tunnels are mostly double-track boxes, steel
// columns between), lamps along the walls, her rails and the third rail (the Green Line's overhead wire), signals,
// and, while she's stopped at a station (the MBTA says which), its platform beside her: tiled walls in her line's
// colour, its name on the wall. Her train, and any other in the tunnel near, is drawn in it. All of it is on layer 1:
// the camera sees only layer 1 while underground (the town, the water and the sky are layer 0, out of sight), with
// its own lights and a black fog where the tunnel runs out of sight.
// (v1152, asked: "model the real stations, like Park Street and South Station") the station's layout is the real one,
// OpenStreetMap's platforms fitted to her track (platform3d.js fitStation), the tunnel widening to it; its look is
// each station's own (stationStyle)
import * as THREE from 'three';
import { buildStation, platformFor, fitStation, oneSide, stationStyle, lineColour } from './platform3d.js';

export const UNDER = 1, GHOST = 2;   // the layers: the tunnel's, and a ghost's
const DEG = Math.PI / 180;
const LIGHT_RAIL = r => /Green|Mattapan/.test(r || '');
const BACK = 350, AHEAD = 450, STEP = 2, LAMP = 15, TRACKS = 3.9;   // (v1161: lamps 15 m apart, in pools: the tunnel dark between, each lamp a flash as she passes)   // m: the tunnel's reach, its rings, the lamps' spacing, between the two tracks' middles

export function makeSubway({ scene, rail, platforms }) {
  // (v1152) the region's real platforms (OpenStreetMap's), fetched the first time she stops at a station
  let plats = null, platsAsked = false;
  const wantPlats = () => { if (platsAsked || !platforms) return; platsAsked = true; platforms().then(d => { plats = d; if (built?.sd != null) built.stale = true; if (surf) surf.stale = true; }).catch(e => console.warn('[subway] platforms', e)); };
  const root = new THREE.Group(); scene.add(root);
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const hemi = new THREE.HemisphereLight(0xc8c2b4, 0x2a2620, 0.9), eye = new THREE.PointLight(0xfff0d8, 60, 0, 2), head = new THREE.PointLight(0xfff6e8, 160, 0, 2);
  for (const l of [hemi, eye, head]) { l.layers.set(UNDER); l.visible = false; scene.add(l); }
  const fog = new THREE.Fog(0x030304, 25, 300), black = new THREE.Color(0x030304);
  // (v1161) her headlights: two soft beams thrown down the tunnel ahead of her, and the bright patch they make on the track
  const beams = new THREE.Group(); beams.visible = false; scene.add(beams);
  { const cone = new THREE.ConeGeometry(2.4, 42, 20, 1, true); cone.translate(0, -25, 0); cone.rotateX(-Math.PI / 2);   // (its tip 4 m out ahead of her lamp, so the cab's eye isn't inside it, opening ahead along -z)
    const bm = new THREE.MeshBasicMaterial({ color: 0xfff1cf, transparent: true, opacity: 0.06, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.FrontSide, fog: false });
    for (const sx of [-0.75, 0.75]) { const b = new THREE.Mesh(cone, bm); b.position.set(sx, 1.0, 0); b.rotation.x = 0.04; beams.add(b); }
    const cv = document.createElement('canvas'); cv.width = cv.height = 128; const x = cv.getContext('2d'), gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,240,205,0.8)'); gr.addColorStop(0.5, 'rgba(255,230,190,0.25)'); gr.addColorStop(1, 'rgba(255,230,190,0)'); x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 26), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    pool.rotation.x = -Math.PI / 2; pool.position.set(0, 0.04, -17); beams.add(pool);
    beams.traverse(o => { o.layers.set(UNDER); o.frustumCulled = false; }); }
  let built = null, active = null, station = null;
  const shown = new Set(), _c = new THREE.Color(), _t = new THREE.Vector3(), _e = new THREE.Vector3();

  // where on her track, d metres from her middle (a place {x, z, h, ...} or null past the track's end)
  const at = (p, d) => p.cur ? rail.step(p.cur, d) : null;

  // her track's rings, back m behind her middle to ahead m on: { x, z, h (radians), y, d }
  function rings(p, back, ahead) {
    const P = [];
    for (const sg of [-1, 1]) {
      let q = p.cur;
      for (let d = 0; d <= (sg < 0 ? back : ahead); d += STEP) {
        if (d) { const n = rail.step(q, sg * STEP); if (!n) break; q = n; }
        if (sg > 0 || d) P.push({ x: q.x, z: q.z, h: q.h, d: sg * d, y: rail.trackY(q.x, q.z) ?? p.y });
      }
    }
    P.sort((a, b) => a.d - b.d);
    if (P.length < 4) return null;
    { const ys = P.map(r => r.y); P.forEach((r, i) => { let s = 0, n = 0; for (let j = Math.max(0, i - 4); j <= Math.min(ys.length - 1, i + 4); j++) { s += ys[j]; n++; } r.y = s / n; }); }   // (eased: a railway's grades)
    for (const r of P) r.h *= DEG;   // (her heading along the rings, the way they run)
    return P;
  }
  // the other track: beside hers, to the right (1) or the left (−1), about TRACKS m off; 0 if none
  // (v1152: looked for at her and 60, 120 and 200 m each way, so a station's tracks spread apart don't hide it)
  function otherSide(P) {
    const v = { 1: 0, [-1]: 0 }; let n = 0;
    for (const dd of [0, -60, 60, -120, 120, -200, 200]) {
      const r = P.find(q => q.d >= dd); if (!r || r.d - dd > STEP * 2) continue; n++;
      for (const s of [1, -1]) if ([0.8, 1, 1.2].some(f => rail.nearTrack(r.x + Math.cos(r.h) * TRACKS * f * s, r.z + Math.sin(r.h) * TRACKS * f * s, 1.5))) v[s]++;
    }
    return v[1] >= Math.max(1, n / 3) && v[1] >= v[-1] ? 1 : v[-1] >= Math.max(1, n / 3) ? -1 : 0;
  }
  const ringAt = (P, x, z) => { let b = P[0], bd = Infinity; for (const r of P) { const e = (r.x - x) ** 2 + (r.z - z) ** 2; if (e < bd) { bd = e; b = r; } } return b; };
  const dAtOf = P => (x, z) => ringAt(P, x, z).d;
  let stationObj = null, surf = null, cur = null;
  function stationAhead(P, p) {
    if (!plats?.plats || !p.fix) return null;
    const kx = 111320 * Math.cos(p.fix.lat * DEG), X = lon => p.fix.x + (lon - p.fix.lon) * kx, Z = lat => p.fix.z - (lat - p.fix.lat) * 111120;
    let best = null;
    for (const pl of plats.plats) {
      const g = pl.g; let x = 0, z = 0; for (const q of g) { x += X(q[0]); z += Z(q[1]); } x /= g.length; z /= g.length;
      if (Math.abs(x - p.x) > AHEAD + 50 || Math.abs(z - p.z) > AHEAD + 50) continue;
      const r = ringAt(P, x, z); if (r.d < 40 || r.d > AHEAD - 70 || (r.x - x) ** 2 + (r.z - z) ** 2 > 14 * 14) continue;
      if (!best || r.d < best.d) best = { d: r.d, x: r.x, z: r.z, n: pl.n };
    }
    return best && { name: p.a.next || best.n || 'Station', x: best.x, z: best.z, rail: p.a.rail, d: best.d };
  }
  function build(p) {
    clear();
    const P = rings(p, BACK, AHEAD); if (!P) return;
    const other = otherSide(P);
    const light = LIGHT_RAIL(p.a.rail), H = light ? 6 : 5;
    // the station (where she's stopped at one): its middle where she stood, kept as she pulls out
    if (p.a.atStop && p.a.next && station?.name !== p.a.next) station = { name: p.a.next, x: p.fix?.x ?? p.x, z: p.fix?.z ?? p.z, rail: p.a.rail };   // (the station where the MBTA puts her, stopped: her walk along the track may lag it)
    let sd = null;
    if (station) { let bd = 40 * 40; for (const r of P) { const e = (r.x - station.x) ** 2 + (r.z - station.z) ** 2; if (e < bd) { bd = e; sd = r.d; } } if (sd == null) station = null; }
    // (v1161, asked: "when we pull into a station and see the people on the platforms") the next station along her track,
    // built before she gets there: the first of OpenStreetMap's platforms beside it within reach ahead, its name the
    // next stop the feed gives her (else the platform's own)
    wantPlats();
    if (sd == null || sd < -60) { const ah = stationAhead(P, p); if (ah) { station = ah; sd = ah.d; } }
    const F = platformFor(p.a.rail, station?.name, p.len || 60);   // (v1151: the platform's height and length as the line's)
    const sSide = other ? -other : 1, platY = F.platY;
    // (v1152) the station's layout: OpenStreetMap's platforms and the tracks between them, fitted to hers; or one
    // made up, beside her on the side away from the other track
    if (sd != null) wantPlats();
    const R = sd == null ? null : fitStation(plats, P, sd, p.fix, rail.nearTrack, true) || oneSide(sd, F.len, sSide, other, TRACKS, P);
    const sty = sd == null ? null : stationStyle(station.name, p.a.rail);
    // how far into the station: 1 in it, easing to 0 over the 30 m the tunnel widens to it at each end
    const FL = 30, sm = k => k * k * (3 - 2 * k);
    const kSta = d => !R ? 0 : d >= R.d0 && d <= R.d1 ? 1 : sm(Math.max(0, 1 - (d < R.d0 ? R.d0 - d : d - R.d1) / FL));
    const inSta = d => kSta(d) === 1;
    const mix = (a, b, k) => a + (b - a) * k;
    // the walls' offsets (− left, + right of her track): the tunnel's, out to the station's
    const tL = other < 0 ? -(TRACKS + 2.4) : -2.5, tR = other > 0 ? TRACKS + 2.4 : 4.4;   // (one track: a walkway along her right)
    const uL = d => mix(tL, R ? R.lo : tL, kSta(d)), uR = d => mix(tR, R ? R.hi : tR, kSta(d));   // (in it, the station's own walls: on its platforms' backs)
    const hOf = d => H + (1.2 + (sty?.rise || 0) + 0.3 * !!sty?.vault) * kSta(d);
    // the tracks: the tunnel's, and the station's (each eased to the tunnel's nearest as the tunnel narrows)
    const tunT = other ? [0, other * TRACKS] : [0];
    const staT = R ? R.tracks.map(t => [t, t === 0 ? 0 : tunT.reduce((a, b) => Math.abs(b - t) < Math.abs(a - t) ? b : a)]) : [];
    const hasEdge = (t, s) => R && R.plats.some(o => s > 0 ? o.eL && Math.abs(o.u0 - t - 1.65) < 0.1 : o.eH && Math.abs(o.u1 - t + 1.65) < 0.1);
    // the lamps: along both walls, under the roof; brighter and closer in the station
    const lit = (d, u, y) => {
      if (inSta(d)) return 1.25;
      let s = 0.05 + 0.25 * kSta(d); const n0 = Math.round(d / LAMP);
      for (let n = n0 - 2; n <= n0 + 2; n++) for (const lu of [uL(d) + 0.3, uR(d) - 0.3]) { const r2 = (d - n * LAMP) ** 2 + (u - lu) ** 2 + (y - (H - 0.5)) ** 2; s += 2.0 / (1 + r2 / 2.2); }
      return Math.min(1.5, s);
    };
    const pos = [], col = [], idx = [];
    const W = (r, u, y) => [r.x + Math.cos(r.h) * u, r.y + y, r.z + Math.sin(r.h) * u];
    const vert = (r, u, y, hex, k = lit(r.d, u, y)) => { const [x, yy, z] = W(r, u, y); pos.push(x, yy, z); _c.set(hex).multiplyScalar(k * 1.9); col.push(_c.r, _c.g, _c.b); return pos.length / 3 - 1; };
    // a strip along the rings: its cross-section's two points (u, y) from a function of the ring, its colour
    const strip = (from, to, f, hex, glow) => {
      let prev = null;
      for (let i = from; i <= to; i++) {
        const r = P[i], s = f(r); if (!s) { prev = null; continue; }
        const a = vert(r, s[0], s[1], hex, glow), b = vert(r, s[2], s[3], hex, glow);
        if (prev) idx.push(prev[0], prev[1], a, prev[1], b, a);
        prev = [a, b];
      }
    };
    const N = P.length - 1;
    // the box: floor, walls (sooty below, concrete above), roof
    const wallCol = d => kSta(d) > 0.5 ? '#d9cfb4' : '#7c786f', lowCol = d => kSta(d) > 0.5 ? '#b9ae94' : '#47423b';
    strip(0, N, r => [uL(r.d), -0.3, uR(r.d), -0.3], '#2a2724');   // the floor
    strip(0, N, r => [uL(r.d), hOf(r.d), uR(r.d), hOf(r.d)], '#4e4b45');   // the roof
    // (the walls' colours change at the station: each ring its own)
    const wall = (u, y0, y1, cf) => { let prev = null; for (let i = 0; i <= N; i++) { const r = P[i], uu = u(r.d), c = cf(r.d), a = vert(r, uu, y0, c), b = vert(r, uu, Math.min(y1, hOf(r.d)), c); if (prev) idx.push(prev[0], prev[1], a, prev[1], b, a); prev = [a, b]; } };
    for (const u of [uL, uR]) { wall(u, -0.3, 1.4, lowCol); wall(u, 1.4, 2.3, wallCol); wall(u, 2.7, 9, wallCol); wall(u, 2.3, 2.7, d => inSta(d) ? (lineColour(p.a.rail) || '#888888') : '#6c685f'); }
    // her rails and the other track's: steel tops, a darker trough between; the third rail (a heavy-rail tunnel's,
    // on the wall's side) or the overhead wire
    // (v1152: in the station its own tracks, eased in from the tunnel's; the third rail on the side with no platform)
    const outT = r => kSta(r.d) === 0 || kSta(r.d - STEP) === 0 || kSta(r.d + STEP) === 0;
    const tr = [...tunT.map(t => [r => outT(r) ? t : null, t === 0 && other ? other : t ? Math.sign(t) : -1]),
      ...staT.map(([t, t0]) => [r => kSta(r.d) > 0 ? mix(t0, t, kSta(r.d)) : null, !hasEdge(t, -1) ? -1 : !hasEdge(t, 1) ? 1 : -1])];
    for (const [uf, side] of tr) {
      const on = f => r => { const u = uf(r); return u == null ? false : f(u); };
      strip(0, N, on(tu => [tu - 1.0, -0.12, tu + 1.0, -0.12]), '#3a352f');
      for (const s of [-1, 1]) strip(0, N, on(tu => [tu + s * 0.72 - 0.04, 0, tu + s * 0.72 + 0.04, 0]), '#b8b4ae');
      if (light) strip(0, N, on(tu => [tu - 0.03, 5.4, tu + 0.03, 5.4]), '#222222', 0.6);
      else strip(0, N, on(tu => [tu + side * 1.25 - 0.18, 0.32, tu + side * 1.25 + 0.18, 0.32]), '#4a3f2c');
    }
    // the lamps themselves (bright strips on the walls), the signals (green on ahead of her, red behind), the station's platform and columns
    const box = (r, u, y, w, h, l, hex, k) => {   // a small box at ring r, l metres long along the track
      const r2 = P[Math.min(N, P.indexOf(r) + Math.max(1, Math.round(l / STEP)))];
      const q = [[u - w / 2, y], [u + w / 2, y], [u + w / 2, y + h], [u - w / 2, y + h]], A = q.map(([a, b]) => vert(r, a, b, hex, k)), B = q.map(([a, b]) => vert(r2, a, b, hex, k));
      for (let j = 0; j < 4; j++) { const j2 = (j + 1) % 4; idx.push(A[j], A[j2], B[j], A[j2], B[j2], B[j]); }
      idx.push(A[0], A[1], A[2], A[0], A[2], A[3], B[0], B[2], B[1], B[0], B[3], B[2]);
    };
    for (const r of P) {
      if (Math.abs(r.d % LAMP) < STEP / 2 && kSta(r.d) === 0) for (const [u, s] of [[uL(r.d) + 0.08, 1], [uR(r.d) - 0.08, -1]]) box(r, u, H - 0.75, 0.12, 0.18, 1.4, '#fff3d6', 2.4);
      if (Math.abs(r.d % 140) < STEP / 2 && Math.abs(r.d) > 30) box(r, (other > 0 ? uL(r.d) : uR(r.d)) + (other > 0 ? 0.25 : -0.25), 2.6, 0.22, 0.22, 0.3, r.d > 0 ? '#2cff6a' : '#ff2a1a', 3);
      if (other && kSta(r.d) === 0 && Math.abs(r.d % 6) < STEP / 2) box(r, other * TRACKS / 2 - 0.15, -0.3, 0.3, H + 0.3, 0.3, '#3c4a52');   // the steel columns between the tracks
    }
    if (!other) {   // one track: the walkway, its top and its face
      strip(0, N, r => kSta(r.d) === 0 && [2.2, 0.9, 4.4, 0.9], '#6d6961');
      strip(0, N, r => kSta(r.d) === 0 && [2.2, -0.3, 2.2, 0.9], '#3a3631');
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx);
    const m = new THREE.Mesh(g, mat); m.layers.set(UNDER); m.frustumCulled = false; root.add(m);
    // (v1161) the ties under her rails and the other track's, every 0.75 m: from the cab they stream under her
    { const T = [], tracksU = [...tunT];   // (v1162: at every 0.75 m exactly, just under her rails, not level with them)
      for (let n = Math.ceil(P[0].d / 0.75), i = 0; n * 0.75 <= P[N].d; n++) {
        const d = n * 0.75; while (i < N - 1 && P[i + 1].d < d) i++;
        const a = P[i], b = P[i + 1], f = (d - a.d) / ((b.d - a.d) || 1);
        if (kSta(d) > 0 && staT.length) continue;
        for (const u of tracksU) T.push(a.x + (b.x - a.x) * f + Math.cos(a.h) * u, a.y + (b.y - a.y) * f - 0.1, a.z + (b.z - a.z) * f + Math.sin(a.h) * u, a.h);
      }
      const k = lit(0, 0, 0) > 0 ? 1 : 1, im = new THREE.InstancedMesh(TIE_G, TIE_M, Math.max(1, T.length / 4)); im.count = T.length / 4;
      const mm = new THREE.Matrix4(), qq = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), vv = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
      for (let i = 0; i < im.count; i++) im.setMatrixAt(i, mm.compose(vv.set(T[i * 4], T[i * 4 + 1], T[i * 4 + 2]), qq.setFromAxisAngle(up, -T[i * 4 + 3]), one));
      im.layers.set(UNDER); im.frustumCulled = false; root.add(im); }
    // (v1151) the station: its platform, walls, signs, lamps, stairs and people (platform3d.js)
    if (R) { stationObj = buildStation({ P, sd, R, platY, rail: p.a.rail, name: station.name, dest: p.a.dest, under: true, ceil: H + 1.2, layer: UNDER, style: sty }); root.add(stationObj.group); }
    const dAt = dAtOf(P);
    built = { dAt, p, x: p.x, z: p.z, P, other, uL, uR, H, sd, platY, s0: R?.d0, s1: R?.d1, cam: R?.cam, real: R?.real, inSta: d => !!R && d >= R.d0 && d <= R.d1 };
  }
  function clear() {
    stationObj?.dispose(); stationObj = null;
    for (const o of [...root.children]) { root.remove(o); o.geometry?.dispose(); if (o.material && o.material !== mat) { o.material.map?.dispose(); o.material.dispose(); } }
    built = null;
  }
  // (v1151) a station in the open, where she's stopped above ground: its platform beside her (the T's surface
  // stations, the commuter rail's, Caltrain's), kept till she's 600 m on
  function buildSurface(p) {
    clearSurf();
    const P = rings(p, 260, 260); if (!P) return;
    const other = otherSide(P), F = platformFor(p.a.rail, p.a.next, p.len || 60), sSide = other ? -other : 1;
    const sd = dAtOf(P)(p.fix?.x ?? p.x, p.fix?.z ?? p.z);   // (where her report puts her, stopped)
    wantPlats();
    const R = fitStation(plats, P, sd, p.fix, rail.nearTrack, false) || oneSide(sd, F.len, sSide, other, TRACKS, P);
    const st = buildStation({ P, sd, R, platY: F.platY, rail: p.a.rail, name: p.a.next, dest: p.a.dest, under: false, canopy: F.canopy, layer: 0 });
    scene.add(st.group);
    surf = { st, p, name: p.a.next, s0: st.s0, s1: st.s1, x: p.x, z: p.z, P, other, sd, platY: F.platY, cam: R.cam, real: R.real, inSta: d => d >= st.s0 && d <= st.s1, dAt: dAtOf(P) };
  }
  function clearSurf() { surf?.st.dispose(); surf = null; }
  // the trains in it: hers and any other underground near her, drawn on layer 1 too
  function showTrains(p) {
    for (const q of rail.items()) {
      const near = q === p || (q.under && Math.hypot(q.x - p.x, q.z - p.z) < 700);
      if (near) { if (!q._ug) { q.g.traverse(o => o.layers.enable(UNDER)); q._ug = true; } q.model.visible = true; shown.add(q); }
      else if (shown.has(q)) { q.model.visible = !q.under; shown.delete(q); }
    }
  }
  function off() {
    if (!active) return;
    for (const q of shown) if (rail.has(q)) q.model.visible = !q.under;
    shown.clear(); clear(); station = null; active = null;
    for (const l of [hemi, eye, head]) l.visible = false;
    beams.visible = false;
  }
  // the track's place q moved u m across, y up (the track's height there)
  const place0 = (q, u, y, out, p) => out.set(q.x + Math.cos(q.h * DEG) * u, (rail.trackY(q.x, q.z) ?? p.y) + y, q.z + Math.sin(q.h * DEG) * u);
  // Side, Ahead or Behind in the tunnel or at a station in the open (B: the built tunnel or the surface station; sta: she's at its platform)
  function placeCam(B, p, mode, nest, camera, sta) {
    const half = (p.len || 60) / 2, z = nest.zoom || 1, tu = B.other ? B.other * TRACKS / 2 : 0;
    const place = (q, u, y, out) => out.set(q.x + Math.cos(q.h * DEG) * u, ringAt(B.P, q.x, q.z).y + y, q.z + Math.sin(q.h * DEG) * u);   // (on the tunnel's own eased heights: the track's own, at a portal's slope, put the camera through its roof)
    let cam, look;
    if (mode === 'side') {   // across from her: on the platform at a station, else by the far wall (between the tracks' columns where there's another), looking at her a little ahead
      const q = at(p, -half * 0.25) || p.cur, lq = at(p, half * 0.35) || p.cur;
      const c = B.cam, u = sta && c ? c.edge + c.side * Math.min(2.4, c.w - 0.5) : B.other ? B.other * (TRACKS + 1.6) : 3.7;   // (on the platform, across the other track, or on the walkway)
      cam = place(q, u, sta ? B.platY + 1.65 : B.other ? 1.9 : 2.5, _e); look = place(lq, 0, 1.7, _t);
      camera.fov = 66 / z;
    } else if (sta && cur === 'surface') {   // (in the open) on the platform at its end, looking down her length as she stands
      // (v1152: at most to the platform's end, a short one's too)
      const sg = mode === 'stern' ? -1 : 1, herD = B.dAt(p.x, p.z), want = Math.max(B.s0 + 1.5, Math.min(B.s1 - 1.5, herD + sg * (half + 12 / z))) - herD;
      const q = at(p, want) || at(p, sg * half) || p.cur, lq = at(p, -sg * half * 0.2) || p.cur;
      const c = B.cam; cam = place(q, c ? c.edge + c.side * Math.min(1.6, c.w - 0.5) : 3.25, B.platY + 1.65, _e); look = place(lq, 0, 1.8, _t);
      camera.fov = 60;
    } else {   // ahead of her, as she comes on (or behind her), a little to the side
      const sg = mode === 'stern' ? -1 : 1, q = at(p, sg * (half + 26 / z)) || at(p, sg * half) || p.cur, lq = at(p, sg * half * 0.6) || p.cur;
      cam = place(q, tu ? -Math.sign(tu) * 0.9 : 1.1, 2.8, _e); look = place(lq, 0, 1.6, _t);   // (on her side of the columns)
      camera.fov = 56;
    }
    // dragged round: the look turned about the camera
    const yaw = ((nest.yaw || 0) - ({ side: -90, stern: 0, bow: -165 }[mode] ?? 0)) * DEG, pitch = ((nest.pitch || 0) - (-6)) * DEG;
    const dx = look.x - cam.x, dz = look.z - cam.z, c = Math.cos(yaw), s = Math.sin(yaw);
    camera.position.copy(cam); camera.lookAt(cam.x + dx * c - dz * s, look.y + Math.hypot(dx, dz) * Math.tan(-pitch * 0.5), cam.z + dx * s + dz * c);
    camera.updateProjectionMatrix();
  }
  return {
    get active() { return active; },
    get layout() { const B = cur === 'surface' ? surf : built; return B ? { real: B.real, cam: B.cam, name: cur === 'surface' ? B.name : station?.name, sd: B.sd, s0: B.s0, s1: B.s1, her: B.dAt(B.p.x, B.p.z), fix: B.p.fix && B.dAt(B.p.fix.x, B.p.fix.z) } : null; },   // (for testing)
    get station() { const B = cur === 'tunnel' ? built : cur === 'surface' ? surf : null; return B?.sd != null && B.inSta(B.dAt(B.p.x, B.p.z)) ? (cur === 'tunnel' ? station?.name : B.name) : null; },
    // each frame, riding p in mode: whether the tunnel's the view, and if so the camera placed in it
    update(p, mode, nest, camera) {
      cur = null;
      stationObj?.tick?.(); surf?.st?.tick?.();   // (v1164: the people walking its platforms)
      if (p?.kind !== 'rail' || !p.cur) { off(); clearSurf(); return false; }
      if (!(p.under && mode !== 'drone')) {
        off();
        // (v1151) above ground: a platform where she's stopped, and Side, Ahead and Behind standing on it while she's at it
        if (!p.under && p.a.atStop && p.a.next && (!surf || surf.p !== p || surf.name !== p.a.next || surf.stale)) buildSurface(p);
        if (surf && (surf.p !== p || Math.hypot(p.x - surf.x, p.z - surf.z) > 600)) clearSurf();
        if (!surf || p.under || !['side', 'bow', 'stern'].includes(mode) || !surf.inSta(surf.dAt(p.x, p.z))) return false;
        cur = 'surface'; placeCam(surf, p, mode, nest, camera, true); return cur;
      }
      clearSurf();
      if (active !== p) { off(); active = p; }
      if (!built || built.p !== p || Math.hypot(p.x - built.x, p.z - built.z) > 150 || (p.a.atStop && p.a.next && station?.name !== p.a.next) || built.stale) build(p);
      if (!built) { off(); return false; }
      showTrains(p);
      for (const l of [hemi, eye, head]) l.visible = true;
      const sta = built.sd != null && built.inSta(built.dAt(p.x, p.z));
      hemi.intensity = sta ? 2.4 : 0.9; cur = 'tunnel';
      const half0 = (p.len || 60) / 2, fr = at(p, half0) || p.cur; place0(fr, 0, 1.6, head.position, p);
      // (v1161) her headlights at her front, along her track (dimmer in a lit station)
      place0(fr, 0, 0, beams.position, p); beams.rotation.set(0, -fr.h * DEG, 0); beams.visible = true; beams.children[0].material.opacity = sta ? 0.025 : 0.06;
      if (mode === 'helm') { eye.position.copy(camera.position); camera.fov = 58 / (nest.zoom || 1); camera.updateProjectionMatrix(); return cur; }
      placeCam(built, p, mode, nest, camera, sta); eye.position.copy(camera.position);
      return cur;
    },
    // the frame: drawn with only the tunnel's layer, its fog, on black
    render(renderer, camera) {
      const f = scene.fog, bg = scene.background;
      scene.fog = fog; scene.background = black; camera.layers.set(UNDER);
      renderer.render(scene, camera);
      scene.fog = f; scene.background = bg; camera.layers.set(0);
    },
    off() { off(); clearSurf(); cur = null; },
    // (v1150, asked: "do the ghost for drone view") from the Drone, or following her, a train in a tunnel is her own
    // shape (her cars, along her track) in her line's colour, see-through and drawn over the street and the buildings
    // above her: a second pass after the scene's, of her alone (layer 2), every part in the ghost's material
    ghost(renderer, camera, p) {
      if (!p?.model) return;
      if (!p._gh) { p.g.traverse(o => o.layers.enable(GHOST)); p._gh = true; }
      const col = lineColour(p.a.rail) || (p.a.rail === 'Commuter Rail' ? '#c4428e' : '#ffffff');
      if (!GHOSTS.has(col)) GHOSTS.set(col, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false, fog: false }));
      const vis = p.model.visible, auto = renderer.autoClear, f = scene.fog;
      p.model.visible = true; scene.overrideMaterial = GHOSTS.get(col); scene.fog = null; renderer.autoClear = false; camera.layers.set(GHOST);
      renderer.render(scene, camera);
      camera.layers.set(0); renderer.autoClear = auto; scene.overrideMaterial = null; scene.fog = f; p.model.visible = vis;
    },
  };
}
const GHOSTS = new Map();
// (v1161) a tie: 2.6 m across her track, 0.25 m along, dark creosoted wood (unlit, as the tunnel is)
const TIE_G = new THREE.BoxGeometry(2.5, 0.1, 0.22), TIE_M = new THREE.MeshBasicMaterial({ color: 0x433a31 });
