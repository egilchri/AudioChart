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
import * as THREE from 'three';

export const UNDER = 1;   // the layer
const DEG = Math.PI / 180;
const LINE_COL = { 'Red Line': '#da291c', 'Orange Line': '#ed8b00', 'Blue Line': '#003da5', 'Green Line': '#00843d', 'Mattapan Trolley': '#da291c' };
const LIGHT_RAIL = r => /Green|Mattapan/.test(r || '');
const BACK = 350, AHEAD = 450, STEP = 2, LAMP = 10, TRACKS = 3.9;   // m: the tunnel's reach, its rings, the lamps' spacing, between the two tracks' middles

export function makeSubway({ scene, rail }) {
  const root = new THREE.Group(); scene.add(root);
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const hemi = new THREE.HemisphereLight(0xc8c2b4, 0x2a2620, 0.9), eye = new THREE.PointLight(0xfff0d8, 60, 0, 2), head = new THREE.PointLight(0xfff6e8, 160, 0, 2);
  for (const l of [hemi, eye, head]) { l.layers.set(UNDER); l.visible = false; scene.add(l); }
  const fog = new THREE.Fog(0x030304, 25, 300), black = new THREE.Color(0x030304);
  let built = null, active = null, station = null;
  const shown = new Set(), _c = new THREE.Color(), _t = new THREE.Vector3(), _e = new THREE.Vector3();

  // where on her track, d metres from her middle (a place {x, z, h, ...} or null past the track's end)
  const at = (p, d) => p.cur ? rail.step(p.cur, d) : null;

  function build(p) {
    clear();
    const P = [];   // rings: { x, z, h, y, d }
    for (const sg of [-1, 1]) {
      let q = p.cur;
      for (let d = 0; d <= (sg < 0 ? BACK : AHEAD); d += STEP) {
        if (d) { const n = rail.step(q, sg * STEP); if (!n) break; q = n; }
        if (sg > 0 || d) P.push({ x: q.x, z: q.z, h: q.h, d: sg * d, y: rail.trackY(q.x, q.z) ?? p.y });
      }
    }
    P.sort((a, b) => a.d - b.d);
    if (P.length < 4) return;
    { const ys = P.map(r => r.y); P.forEach((r, i) => { let s = 0, n = 0; for (let j = Math.max(0, i - 4); j <= Math.min(ys.length - 1, i + 4); j++) { s += ys[j]; n++; } r.y = s / n; }); }   // (eased: a railway's grades)
    // her heading along the rings, the way they run (a backward ring's h is hers still)
    for (const r of P) r.h *= DEG;
    // the other track: beside hers, to the right or the left, about TRACKS m off
    const mid = P[P.findIndex(r => r.d >= 0)] || P[0];
    const side = s => [0.8, 1, 1.2].some(f => rail.nearTrack(mid.x + Math.cos(mid.h) * TRACKS * f * s, mid.z + Math.sin(mid.h) * TRACKS * f * s, 1.5));
    const other = side(1) ? 1 : side(-1) ? -1 : 0;
    const light = LIGHT_RAIL(p.a.rail), H = light ? 6 : 5;
    // the station (where she's stopped at one): its middle where she stood, kept as she pulls out
    if (p.a.atStop && p.a.next && station?.name !== p.a.next) station = { name: p.a.next, x: p.x, z: p.z, rail: p.a.rail };
    let sd = null;
    if (station) { let bd = 15 * 15; for (const r of P) { const e = (r.x - station.x) ** 2 + (r.z - station.z) ** 2; if (e < bd) { bd = e; sd = r.d; } } if (sd == null) station = null; }
    const sLen = light ? 70 : 125, sSide = other ? -other : 1, inSta = d => sd != null && Math.abs(d - sd) <= sLen / 2;
    const platEdge = 1.65, platW = 5.5, platY = light ? 0.3 : 1.05;
    // the walls' offsets (− left, + right of her track), the station's side set back past its platform
    const uL = d => inSta(d) && sSide < 0 ? -(platEdge + platW) : other < 0 ? -(TRACKS + 2.4) : -2.5;
    const uR = d => inSta(d) && sSide > 0 ? platEdge + platW : other > 0 ? TRACKS + 2.4 : 4.4;   // (one track: a walkway along her right)
    const hOf = d => inSta(d) ? H + 1.2 : H;
    // the lamps: along both walls, under the roof; brighter and closer in the station
    const lit = (d, u, y) => {
      if (inSta(d)) return 1.25;
      let s = 0.1; const n0 = Math.round(d / LAMP);
      for (let n = n0 - 3; n <= n0 + 3; n++) for (const lu of [uL(d) + 0.3, uR(d) - 0.3]) { const r2 = (d - n * LAMP) ** 2 + (u - lu) ** 2 + (y - (H - 0.5)) ** 2; s += 2.2 / (1 + r2 / 5); }
      return Math.min(1.6, s);
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
    const wallCol = d => inSta(d) ? '#d9cfb4' : '#7c786f', lowCol = d => inSta(d) ? '#b9ae94' : '#47423b';
    strip(0, N, r => [uL(r.d), -0.3, uR(r.d), -0.3], '#2a2724');   // the floor
    strip(0, N, r => [uL(r.d), hOf(r.d), uR(r.d), hOf(r.d)], '#4e4b45');   // the roof
    // (the walls' colours change at the station: each ring its own)
    const wall = (u, y0, y1, cf) => { let prev = null; for (let i = 0; i <= N; i++) { const r = P[i], uu = u(r.d), c = cf(r.d), a = vert(r, uu, y0, c), b = vert(r, uu, Math.min(y1, hOf(r.d)), c); if (prev) idx.push(prev[0], prev[1], a, prev[1], b, a); prev = [a, b]; } };
    for (const u of [uL, uR]) { wall(u, -0.3, 1.4, lowCol); wall(u, 1.4, 2.3, wallCol); wall(u, 2.7, 9, wallCol); wall(u, 2.3, 2.7, d => inSta(d) ? (LINE_COL[p.a.rail] || '#888888') : '#6c685f'); }
    // her rails and the other track's: steel tops, a darker trough between; the third rail (a heavy-rail tunnel's,
    // on the wall's side) or the overhead wire
    for (const tu of other ? [0, other * TRACKS] : [0]) {
      strip(0, N, () => [tu - 1.0, -0.12, tu + 1.0, -0.12], '#3a352f');
      for (const s of [-1, 1]) strip(0, N, () => [tu + s * 0.72 - 0.04, 0, tu + s * 0.72 + 0.04, 0], '#b8b4ae');
      if (light) strip(0, N, () => [tu - 0.03, 5.4, tu + 0.03, 5.4], '#222222', 0.6);
      else { const ou = tu + (tu === 0 && other ? other : tu ? Math.sign(tu) : -1) * 1.25; strip(0, N, () => [ou - 0.18, 0.32, ou + 0.18, 0.32], '#4a3f2c'); }
    }
    // the lamps themselves (bright strips on the walls), the signals (green on ahead of her, red behind), the station's platform and columns
    const box = (r, u, y, w, h, l, hex, k) => {   // a small box at ring r, l metres long along the track
      const r2 = P[Math.min(N, P.indexOf(r) + Math.max(1, Math.round(l / STEP)))];
      const q = [[u - w / 2, y], [u + w / 2, y], [u + w / 2, y + h], [u - w / 2, y + h]], A = q.map(([a, b]) => vert(r, a, b, hex, k)), B = q.map(([a, b]) => vert(r2, a, b, hex, k));
      for (let j = 0; j < 4; j++) { const j2 = (j + 1) % 4; idx.push(A[j], A[j2], B[j], A[j2], B[j2], B[j]); }
      idx.push(A[0], A[1], A[2], A[0], A[2], A[3], B[0], B[2], B[1], B[0], B[3], B[2]);
    };
    for (const r of P) {
      if (Math.abs(r.d % LAMP) < STEP / 2 && !inSta(r.d)) for (const [u, s] of [[uL(r.d) + 0.08, 1], [uR(r.d) - 0.08, -1]]) box(r, u, H - 0.75, 0.12, 0.18, 1.4, '#fff3d6', 2.4);
      if (Math.abs(r.d % 140) < STEP / 2 && Math.abs(r.d) > 30) box(r, (other > 0 ? uL(r.d) : uR(r.d)) + (other > 0 ? 0.25 : -0.25), 2.6, 0.22, 0.22, 0.3, r.d > 0 ? '#2cff6a' : '#ff2a1a', 3);
      if (other && !inSta(r.d) && Math.abs(r.d % 6) < STEP / 2) box(r, other * TRACKS / 2 - 0.15, -0.3, 0.3, H + 0.3, 0.3, '#3c4a52');   // the steel columns between the tracks
      if (inSta(r.d)) {
        if (Math.abs((r.d - sd) % 10) < STEP / 2) box(r, sSide * (platEdge + platW * 0.55), platY, 0.45, hOf(r.d) - platY, 0.45, '#2f5a46');
      }
    }
    if (!other) {   // one track: the walkway, its top and its face
      strip(0, N, r => !inSta(r.d) && [2.2, 0.9, 4.4, 0.9], '#6d6961');
      strip(0, N, r => !inSta(r.d) && [2.2, -0.3, 2.2, 0.9], '#3a3631');
    }
    if (sd != null) {   // the platform: its top, its yellow edge, its face down to the trackbed
      const pf = r => inSta(r.d);
      strip(0, N, r => pf(r) && [sSide * (platEdge + 0.6), platY, sSide * (platEdge + platW), platY], '#9b968c');
      strip(0, N, r => pf(r) && [sSide * platEdge, platY + 0.005, sSide * (platEdge + 0.6), platY + 0.005], '#e0b423');
      strip(0, N, r => pf(r) && [sSide * platEdge, -0.3, sSide * platEdge, platY], '#3d3a35');
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx);
    const m = new THREE.Mesh(g, mat); m.layers.set(UNDER); m.frustumCulled = false; root.add(m);
    // the station's name on its walls, every 25 m (white on black, as the T's are)
    if (sd != null) {
      const tex = nameTex(station.name);
      for (let d = sd - sLen / 2 + 12; d <= sd + sLen / 2 - 8; d += 25) {
        const r = P.reduce((b, x) => Math.abs(x.d - d) < Math.abs(b.d - d) ? x : b, P[0]), u = sSide > 0 ? uR(r.d) - 0.05 : uL(r.d) + 0.05;
        const s = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 0.8), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })), [x, y, z] = W(r, u, 3.3);
        s.position.set(x, y, z); s.rotation.y = Math.atan2(-sSide * Math.cos(r.h), -sSide * Math.sin(r.h));   // (facing the track) s.layers.set(UNDER); root.add(s);
      }
    }
    const dAt = (x, z) => { let b = P[0], bd = Infinity; for (const r of P) { const e = (r.x - x) ** 2 + (r.z - z) ** 2; if (e < bd) { bd = e; b = r; } } return b.d; };
    built = { dAt, p, x: p.x, z: p.z, P, other, uL, uR, H, sd, sSide, platY, platEdge, platW, inSta };
  }
  function nameTex(name) {
    const c = document.createElement('canvas'); c.width = 840; c.height = 160; const x = c.getContext('2d');
    x.fillStyle = '#111'; x.fillRect(0, 0, 840, 160); x.fillStyle = '#fff'; x.font = 'bold 92px Helvetica, Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    let s = 92; while (x.measureText(name).width > 790 && s > 40) { s -= 4; x.font = `bold ${s}px Helvetica, Arial, sans-serif`; }
    x.fillText(name, 420, 84);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  function clear() {
    for (const o of [...root.children]) { root.remove(o); o.geometry?.dispose(); if (o.material !== mat) { o.material.map?.dispose(); o.material.dispose(); } }
    built = null;
  }
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
  }
  return {
    get active() { return active; },
    get station() { return built?.sd != null && built.inSta(built.dAt(built.p.x, built.p.z)) ? station?.name : null; },
    // each frame, riding p in mode: whether the tunnel's the view, and if so the camera placed in it
    update(p, mode, nest, camera) {
      const want = p?.kind === 'rail' && p.under && p.cur && mode !== 'drone';
      if (!want) { off(); return false; }
      if (active !== p) { off(); active = p; }
      if (!built || built.p !== p || Math.hypot(p.x - built.x, p.z - built.z) > 150 || (p.a.atStop && p.a.next && station?.name !== p.a.next)) build(p);
      if (!built) { off(); return false; }
      showTrains(p);
      for (const l of [hemi, eye, head]) l.visible = true;
      const sta = built.sd != null && built.inSta(built.dAt(p.x, p.z));
      hemi.intensity = sta ? 2.4 : 0.9;
      const B = built, half = (p.len || 60) / 2, z = nest.zoom || 1, tu = B.other ? B.other * TRACKS / 2 : 0;
      const place = (q, u, y, out) => out.set(q.x + Math.cos(q.h * DEG) * u, (rail.trackY(q.x, q.z) ?? p.y) + y, q.z + Math.sin(q.h * DEG) * u);
      const front = at(p, half) || p.cur; place(front, 0, 1.6, head.position);
      if (mode === 'helm') { eye.position.copy(camera.position); camera.fov = 58 / z; camera.updateProjectionMatrix(); return true; }
      let cam, look;
      if (mode === 'side') {   // across from her: on the platform at a station, else by the far wall (between the tracks' columns where there's another), looking at her a little ahead
        const q = at(p, -half * 0.25) || p.cur, lq = at(p, half * 0.35) || p.cur;
        const u = sta ? B.sSide * (B.platEdge + 2.4) : B.other ? B.other * (TRACKS + 1.6) : 3.7;   // (on the platform, across the other track, or on the walkway)
        cam = place(q, u, sta ? B.platY + 1.65 : B.other ? 1.9 : 2.5, _e); look = place(lq, 0, 1.7, _t);
        camera.fov = 66 / z;
      } else {   // ahead of her, as she comes on (or behind her), a little to the side
        const sg = mode === 'stern' ? -1 : 1, q = at(p, sg * (half + 26 / z)) || at(p, sg * half) || p.cur, lq = at(p, sg * half * 0.6) || p.cur;
        cam = place(q, tu ? -Math.sign(tu) * 0.9 : 1.1, 2.8, _e); look = place(lq, 0, 1.6, _t);   // (on her side of the columns)
        camera.fov = 56;
      }
      // dragged round: the look turned about the camera
      const yaw = ((nest.yaw || 0) - ({ side: -90, stern: 0, bow: -165 }[mode] ?? 0)) * DEG, pitch = ((nest.pitch || 0) - (-6)) * DEG;
      const dx = look.x - cam.x, dz = look.z - cam.z, c = Math.cos(yaw), s = Math.sin(yaw);
      camera.position.copy(cam); camera.lookAt(cam.x + dx * c - dz * s, look.y + Math.hypot(dx, dz) * Math.tan(-pitch * 0.5), cam.z + dx * s + dz * c);
      eye.position.copy(cam); camera.updateProjectionMatrix();
      return true;
    },
    // the frame: drawn with only the tunnel's layer, its fog, on black
    render(renderer, camera) {
      const f = scene.fog, bg = scene.background;
      scene.fog = fog; scene.background = black; camera.layers.set(UNDER);
      renderer.render(scene, camera);
      scene.fog = f; scene.background = bg; camera.layers.set(0);
    },
    off,
  };
}
