// A station's platform, as it looks from on it (v1151, asked: "when we stop at a platform it should look like a realistic
// rendition of the platform. I'm talking about the T, and trains"): built beside her where she's stopped, along her
// own track (the rings subway3d.js walks: { x, z, h (radians), y, d }), underground or in the open.
//  - the platform: concrete pavers, a granite edge and the yellow tactile strip (the T's detectable warning), its face
//    down to the trackbed
//  - underground (the T's subway stations): white tiled walls on both sides of the tracks with a band in the line's
//    colour, the station's name on them (white on black, as the T's), posters and the system map between, rows of
//    lamps hung from the roof, the platform's columns, a stair going up, hanging name and countdown signs (her
//    destination, "BRD": she's boarding)
//  - in the open (the T's surface stations, the commuter rail's and Caltrain's): a canopy (along all of a subway
//    line's platform, over the middle of a commuter rail's, a shelter at a trolley stop) on posts, lamps under it, a
//    railing along the back, name signs on posts
//  - benches, bins, and people waiting, in a few hundred colours of clothes
// All merged into a few meshes. Underground, lit flat (MeshBasic, the tunnel's lamps baked in); in the open, by the
// scene's sun and night.
import * as THREE from 'three';

const LINE_COL = { 'Red Line': '#da291c', 'Orange Line': '#ed8b00', 'Blue Line': '#003da5', 'Green Line': '#00843d', 'Mattapan Trolley': '#da291c', 'Commuter Rail': '#80276c' };
const SKIN = [0xf1c8a8, 0xe0ac86, 0xc68a62, 0x9b6744, 0x6e4a32, 0x4a3224];
const CLOTH = [0x1c1c1e, 0x1c1c1e, 0x2b2f38, 0x3b3d42, 0x24324a, 0x4a5a6e, 0x6b6e72, 0x8b8f94, 0xc9c6bf, 0x7a2a2a, 0x2e4a36, 0xb8945a, 0x5a3a2a, 0xd8d4cc, 0x8a2432, 0x2a4a7a];
const TROUSERS = [0x1c1c1e, 0x23262c, 0x2e3a52, 0x3a4660, 0x4a4a4a, 0x6b5a44, 0x8a8a86];
const pick = a => a[Math.random() * a.length | 0];

// ── textures, made once ──
const TEX = {};
function canvasTex(key, w, h, draw, rep) {
  if (TEX[key]) return TEX[key];
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  if (rep) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  return (TEX[key] = t);
}
// subway tile, 6 by 3 in, white with grey grout (a tile repeat is 0.6 m wide, 0.3 m high: 4 by 4 tiles)
const tileTex = () => canvasTex('tile', 256, 128, (x, w, h) => {
  x.fillStyle = '#a8a69e'; x.fillRect(0, 0, w, h);
  for (let r = 0; r < 4; r++) for (let c = -1; c < 5; c++) { const ox = r % 2 ? 32 : 0; const v = 232 + (Math.random() * 14 | 0); x.fillStyle = `rgb(${v},${v - 2},${v - 8})`; x.fillRect(c * 64 + ox + 2, r * 32 + 2, 60, 28); }
}, true);
// pavers: 0.6 m squares of grey concrete
const paverTex = () => canvasTex('paver', 128, 128, (x, w, h) => {
  x.fillStyle = '#76736c'; x.fillRect(0, 0, w, h);
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) { const v = 150 + (Math.random() * 22 | 0); x.fillStyle = `rgb(${v},${v - 2},${v - 6})`; x.fillRect(c * 64 + 1, r * 64 + 1, 62, 62); for (let k = 0; k < 40; k++) { x.fillStyle = `rgba(0,0,0,${Math.random() * 0.12})`; x.fillRect(c * 64 + Math.random() * 62, r * 64 + Math.random() * 62, 2, 2); } }
}, true);
// the detectable warning: yellow, rows of domes (a repeat 0.3 m square)
const tactileTex = () => canvasTex('tactile', 128, 128, (x, w, h) => {
  x.fillStyle = '#d9b21f'; x.fillRect(0, 0, w, h);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { const cx = c * 32 + 16, cy = r * 32 + 16, g = x.createRadialGradient(cx - 3, cy - 3, 1, cx, cy, 11); g.addColorStop(0, '#fff2a0'); g.addColorStop(0.6, '#e6c030'); g.addColorStop(1, '#9a7a10'); x.fillStyle = g; x.beginPath(); x.arc(cx, cy, 10, 0, 7); x.fill(); }
}, true);
// posters: blocks of colour, a headline's bars, a picture (made up, no one's brand)
function posterTex(i) {
  return canvasTex('poster' + i, 256, 384, (x, w, h) => {
    const P = [['#1d3557', '#e63946', '#f1faee'], ['#264653', '#e9c46a', '#f4a261'], ['#2b2d42', '#8d99ae', '#ef233c'], ['#006d77', '#83c5be', '#ffddd2'], ['#3d405b', '#f2cc8f', '#e07a5f'], ['#22223b', '#c9ada7', '#f2e9e4'], ['#0b3d20', '#9ad18b', '#fefae0'], ['#5f0f40', '#fb8b24', '#e36414']][i % 8];
    x.fillStyle = P[0]; x.fillRect(0, 0, w, h);
    x.fillStyle = P[1]; if (i % 2) { x.beginPath(); x.arc(w * 0.5, h * 0.38, 80, 0, 7); x.fill(); } else x.fillRect(24, 40, w - 48, h * 0.45);
    x.fillStyle = P[2]; for (let k = 0; k < 3; k++) x.fillRect(24, h * 0.62 + k * 28, (w - 48) * (k ? 0.7 - k * 0.15 : 1), 16);
    x.fillStyle = 'rgba(255,255,255,0.6)'; x.fillRect(24, h - 40, 60, 12);
    x.strokeStyle = '#222'; x.lineWidth = 8; x.strokeRect(4, 4, w - 8, h - 8);
  });
}
// the system map: the lines on white, their stations as dots (a schematic, not the real one)
const mapTex = () => canvasTex('map', 384, 384, (x, w, h) => {
  x.fillStyle = '#f4f4f0'; x.fillRect(0, 0, w, h); x.lineCap = 'round'; x.lineWidth = 9;
  for (const [c, pts] of [['#da291c', [[60, 40], [150, 140], [200, 200], [230, 300], [250, 360]]], ['#ed8b00', [[220, 30], [210, 140], [200, 200], [150, 340]]], ['#003da5', [[340, 70], [260, 150], [210, 170]]], ['#00843d', [[40, 250], [120, 220], [200, 200], [250, 160], [290, 90]]], ['#80276c', [[20, 330], [120, 300], [230, 300], [360, 330]]]]) {
    x.strokeStyle = c; x.beginPath(); pts.forEach(([a, b], k) => k ? x.lineTo(a, b) : x.moveTo(a, b)); x.stroke();
    x.fillStyle = '#fff'; for (const [a, b] of pts) { x.beginPath(); x.arc(a, b, 5, 0, 7); x.fill(); x.strokeStyle = '#222'; x.lineWidth = 2; x.stroke(); x.lineWidth = 9; x.strokeStyle = c; }
  }
  x.fillStyle = '#222'; x.fillRect(0, 0, w, 26); x.strokeStyle = '#222'; x.lineWidth = 6; x.strokeRect(3, 3, w - 6, h - 6);
});
function nameTex(name, band) {
  return canvasTex('name:' + name + band, 1024, 160, (x, w, h) => {
    x.fillStyle = '#141414'; x.fillRect(0, 0, w, h); x.fillStyle = band; x.fillRect(0, h - 22, w, 22);
    x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle'; let s = 92; x.font = `bold ${s}px Helvetica, Arial, sans-serif`;
    while (x.measureText(name).width > w - 80 && s > 36) { s -= 4; x.font = `bold ${s}px Helvetica, Arial, sans-serif`; }
    x.fillText(name, w / 2, (h - 22) / 2 + 4);
  });
}
function ledTex(dest) {   // the countdown sign: her destination, and BRD (she's boarding)
  return canvasTex('led:' + dest, 512, 128, (x, w, h) => {
    x.fillStyle = '#050505'; x.fillRect(0, 0, w, h); x.fillStyle = '#ffb21e'; x.textBaseline = 'middle';
    let s = 46; x.font = `bold ${s}px "Courier New", monospace`; while (x.measureText(dest).width > w - 140 && s > 22) { s -= 2; x.font = `bold ${s}px "Courier New", monospace`; }
    x.fillText(dest, 18, h * 0.32); x.textAlign = 'right'; x.font = 'bold 46px "Courier New", monospace'; x.fillText('BRD', w - 18, h * 0.32);
    x.textAlign = 'left'; x.globalAlpha = 0.25; x.font = 'bold 30px "Courier New", monospace'; x.fillText('Stand back from the platform edge', 18, h * 0.76);
  });
}

// built: { group, dispose }
export function buildStation({ P, sd, sSide, len, platY, edge = 1.65, width = 5.5, rail, name, dest, under, wallFar, ceil, layer = 0, canopy = 'all', bright = 2.3 }) {
  const group = new THREE.Group(), mats = [], geos = [];
  const band = LINE_COL[rail] || '#5a6a7a';
  const N = P.length - 1, d0 = P[0].d, STEP = (P[N].d - d0) / N;
  const ring = d => P[Math.max(0, Math.min(N, Math.round((d - d0) / STEP)))];
  const s0 = Math.max(P[0].d, sd - len / 2), s1 = Math.min(P[N].d, sd + len / 2);
  const inPl = d => d >= s0 && d <= s1;
  const W = (r, u, y, out = new THREE.Vector3()) => out.set(r.x + Math.cos(r.h) * u, r.y + y, r.z + Math.sin(r.h) * u);
  const yawOf = (fx, fz) => Math.atan2(fx, fz);
  const along = r => yawOf(Math.sin(r.h), -Math.cos(r.h)), facing = (r, s) => yawOf(-s * Math.cos(r.h), -s * Math.sin(r.h));   // (along her track; facing the track from side s)
  const mat = (o = {}) => {
    const { glow, ...p } = o; let m;
    if (under) m = new THREE.MeshBasicMaterial({ ...p, color: new THREE.Color(p.color ?? 0xffffff).multiplyScalar(glow ?? bright) });
    else { m = new THREE.MeshLambertMaterial({ ...p, color: p.color ?? 0xffffff }); if (glow) { m.emissive.set(p.color ?? 0xffffff); m.emissiveIntensity = 0.8; if (p.map) m.emissiveMap = p.map; } }
    mats.push(m); return m;
  };
  const mesh = (g, m) => { const o = new THREE.Mesh(g, m); o.layers.set(layer); o.frustumCulled = false; group.add(o); geos.push(g); return o; };
  // a strip along the rings over [a, b], its cross-section (u0, y0) to (u1, y1); its texture repeated every ru m along, rv m across
  function strip(a, b, f, m, ru = 1, rv = 1) {
    const pos = [], uv = [], idx = []; let prev = -1;
    for (const r of P) {
      if (r.d < a - 1e-6 || r.d > b + 1e-6) continue;
      const [u0, y0, u1, y1] = f(r), A = W(r, u0, y0), B = W(r, u1, y1), span = Math.hypot(u1 - u0, y1 - y0), i = pos.length / 3;
      pos.push(A.x, A.y, A.z, B.x, B.y, B.z); uv.push(r.d / ru, 0, r.d / ru, span / rv);
      if (prev >= 0) idx.push(prev, prev + 1, i, prev + 1, i + 1, i);
      prev = i;
    }
    if (pos.length < 12) return;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    m.side = THREE.DoubleSide; mesh(g, m);
  }
  // a flat panel at d (a sign, a poster), w by h, its middle at (u, y), facing the track from side s (or along the track)
  function panel(d, u, y, w, h, m, s) { const r = ring(d), o = mesh(new THREE.PlaneGeometry(w, h), m); W(r, u, y, o.position); o.rotation.y = s ? facing(r, s) : along(r); return o; }
  // boxes and the like, merged: each part placed at d along, u across, y up, turned yaw (radians, round from along the track)
  const M = { pos: [], nor: [], col: [], idx: [] }, _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _c = new THREE.Color(), UP = new THREE.Vector3(0, 1, 0);
  function put(g, d, u, y, yaw, hex, k = 1) {
    const r = ring(d); W(r, u, y, _v); _m.compose(_v, _q.setFromAxisAngle(UP, yaw), _s); g.applyMatrix4(_m);
    const p = g.attributes.position, n = g.attributes.normal, o = M.pos.length / 3; _c.set(hex).multiplyScalar(k);
    for (let i = 0; i < p.count; i++) { M.pos.push(p.getX(i), p.getY(i), p.getZ(i)); M.nor.push(n.getX(i), n.getY(i), n.getZ(i)); M.col.push(_c.r, _c.g, _c.b); }
    const I = g.index; if (I) for (let i = 0; i < I.count; i++) M.idx.push(o + I.getX(i)); else for (let i = 0; i < p.count; i++) M.idx.push(o + i);
    g.dispose();
  }
  // a box in the frame of a thing at (d, u, y) turned yaw: its own offsets (along its facing: lx across, lz ahead)
  const boxAt = (w, h, l, d, u, y, yaw, hex, lx = 0, ly = 0, lz = 0, k) => { const g = new THREE.BoxGeometry(w, h, l); g.translate(lx, ly + h / 2, lz); put(g, d, u, y, yaw, hex, k); };
  const cylAt = (r, h, d, u, y, yaw, hex, lx = 0, ly = 0, lz = 0, seg = 10) => { const g = new THREE.CylinderGeometry(r, r, h, seg); g.translate(lx, ly + h / 2, lz); put(g, d, u, y, yaw, hex); };
  const S = sSide, U = t => S * (edge + t);   // across the platform: t m in from her edge

  // ── the platform ──
  strip(s0, s1, () => [U(0.9), platY, U(width), platY], mat({ map: paverTex() }), 0.6, 0.6);
  strip(s0, s1, () => [U(0.3), platY + 0.004, U(0.9), platY + 0.004], mat({ map: tactileTex() }), 0.3, 0.3);
  strip(s0, s1, () => [U(0), platY + 0.002, U(0.3), platY + 0.002], mat({ color: 0xb4b2ac }));   // the granite edge
  strip(s0, s1, () => [U(0), -0.3, U(0), platY - 0.08], mat({ color: 0x3a3733, glow: under ? 0.9 : undefined }));
  strip(s0, s1, () => [U(0.12), platY - 0.08, U(0), platY - 0.08], mat({ color: 0x2a2724, glow: under ? 0.8 : undefined }));   // its lip, overhanging
  strip(s0, s1, () => [U(0), platY - 0.08, U(0), platY], mat({ color: 0x8e8a82 }));
  if (!under) strip(s0, s1, () => [U(width), -0.3, U(width), platY], mat({ color: 0x5b5852 }));   // its back

  if (under) {
    // ── the walls: tile, the line's band, names, posters and maps; on her platform's side and across the tracks ──
    const nearU = U(width) - S * 0.03, farU = wallFar + S * 0.03;
    strip(s0, s1, () => [nearU, platY, nearU, ceil], mat({ map: tileTex() }), 0.6, 0.3);
    strip(s0, s1, () => [farU, -0.3, farU, ceil], mat({ map: tileTex() }), 0.6, 0.3);
    strip(s0, s1, () => [nearU - S * 0.01, platY + 2.45, nearU - S * 0.01, platY + 2.75], mat({ color: band, glow: 1.6 }));
    strip(s0, s1, () => [farU + S * 0.01, platY + 2.45, farU + S * 0.01, platY + 2.75], mat({ color: band, glow: 1.6 }));
    const nameM = mat({ map: nameTex(name, band), glow: 1.5 });
    let k = 0;
    for (let d = s0 + 8; d <= s1 - 6; d += 6, k++) {
      const what = k % 4 === 0 ? 'name' : k % 4 === 2 && k % 8 === 2 ? 'map' : 'poster';
      for (const [u, y0, s] of [[nearU - S * 0.02, platY, S], [farU + S * 0.02, platY - 0.2, -S]]) {
        if (what === 'name') panel(d, u, y0 + 3.15, 3.6, 0.56, nameM, s);
        else if (what === 'map') panel(d, u, y0 + 1.65, 1.5, 1.5, mat({ map: mapTex(), glow: 1.7 }), s);
        else { panel(d, u, y0 + 1.65, 1.2, 1.8, mat({ map: posterTex((k * 3 + (s > 0 ? 1 : 0)) % 8), glow: 1.6 }), s); boxAt(1.36, 1.96, 0.04, d, u - s * 0.0, y0 + 0.67, facing(ring(d), s), 0x2a2a2a, 0, 0, -0.03, 1.4); }
      }
    }
    // the lamps hung from the roof: two rows over the platform, one over the tracks
    for (let d = s0 + 2; d <= s1 - 2; d += 4.5) {
      for (const t of [width * 0.3, width * 0.75]) { boxAt(0.16, 0.07, 2.4, d, U(t), ceil - 0.3, along(ring(d)), 0xfff6e0, 0, 0, 0, 2.6); boxAt(0.02, 0.23, 0.02, d, U(t), ceil - 0.23, 0, 0x333333, 0, 0, 0, 1.2); }
    }
    // her platform's columns, steel, down its middle
    const stairD = sd + len * 0.22, inStair = (d, u) => d > stairD - 1.5 && d < stairD + 10 && Math.abs(u - U(width * 0.55)) < 1.8;
    const colHex = /Park Street|Boylston|Arlington|Copley|Hynes|Kenmore/.test(name) ? 0x2f5a46 : 0x5a646c;
    for (let d = s0 + 5; d <= s1 - 4; d += 9) if (!inStair(d, U(width * 0.55))) boxAt(0.36, ceil - platY, 0.36, d, U(width * 0.55), platY, along(ring(d)), colHex, 0, 0, 0, 1.1);
    // the stairs up, a third of the way along: steps rising along the track into the roof, a wall each side
    { const sd0 = stairD, uS = U(width * 0.55), r = ring(sd0), yaw = along(r), n = Math.ceil((ceil - platY + 0.2) / 0.18);
      for (let i = 0; i < n; i++) boxAt(2.4, 0.18, 0.3, sd0, uS, platY + i * 0.18, yaw, 0x8a8780, 0, 0, i * 0.28, 1.05);
      for (const sx of [-1.25, 1.25]) { const g = new THREE.BoxGeometry(0.12, 1.0, n * 0.28 + 0.6); g.translate(sx, 0.5, n * 0.14); const sh = new THREE.Matrix4().makeShear(0, 0, 0, 0, 0, 0.64); g.applyMatrix4(sh); put(g, sd0, uS, platY + 0.2, yaw, 0xcfc9b8, 1.1); }
      boxAt(2.8, 0.06, 0.06, sd0, uS, platY + 1.05, yaw, 0x9a9a98, 0, 0, -0.2, 1.2); }
    // hanging signs over the platform: the name, and the countdown
    for (let d = s0 + 18; d <= s1 - 10; d += 32) {
      const r = ring(d), y = ceil - 0.8;
      const nm = panel(d, U(width * 0.4), y, 2.4, 0.38, nameM, null); nm.rotation.y = facing(r, -S) + Math.PI / 2;
      const nm2 = panel(d, U(width * 0.4), y, 2.4, 0.38, nameM, null); nm2.rotation.y = facing(r, -S) - Math.PI / 2;
      const led = mat({ map: ledTex(dest || name), glow: 1.6 });
      const l1 = panel(d + 9, U(width * 0.4), y, 1.9, 0.48, led, null); l1.rotation.y = along(r);
      const l2 = panel(d + 9, U(width * 0.4), y, 1.9, 0.48, led, null); l2.rotation.y = along(r) + Math.PI;
      for (const dd of [d, d + 9]) boxAt(0.03, ceil - y - 0.2, 0.03, dd, U(width * 0.4), y + 0.2, 0, 0x333333, 0, 0, 0, 1.2);
    }
  } else {
    // ── in the open: the canopy, its posts and lamps, a railing at the back, name signs on posts ──
    const [c0, c1] = canopy === 'all' ? [s0 + 3, s1 - 3] : canopy === 'shelter' ? [sd - 4, sd + 4] : [sd - Math.min(35, len * 0.25), sd + Math.min(35, len * 0.25)];
    const cy = platY + 3.3;
    strip(c0, c1, () => [U(0.6), cy, U(width + 0.1), cy + 0.35], mat({ color: 0x55606a }));
    strip(c0, c1, () => [U(0.6), cy - 0.02, U(width + 0.1), cy + 0.33], mat({ color: 0x8a9298, glow: true }));   // (its underside, lit by the lamps and the light off the platform)
    for (let d = c0 + 1; d <= c1 - 1; d += 9) { const yaw = along(ring(d)); boxAt(0.2, cy - platY, 0.2, d, U(width * 0.62), platY, yaw, 0x4a565e); boxAt(0.25, 0.08, 2.2, d, U(width * 0.4), cy - 0.1, yaw, 0xfff6e0, 0, 0, 0, 1.6); }
    for (let d = s0 + 1; d <= s1 - 1; d += 2.5) { const yaw = along(ring(d)); boxAt(0.05, 1.1, 0.05, d, U(width - 0.12), platY, yaw, 0x3d454a); }
    strip(s0, s1, () => [U(width - 0.12), platY + 1.08, U(width - 0.12), platY + 1.14], mat({ color: 0x3d454a }));
    const nameM = mat({ map: nameTex(name, band) });
    for (let d = s0 + 10; d <= s1 - 8; d += 28) { panel(d, U(width - 0.6), platY + 2.3, 2.6, 0.42, nameM, S); for (const lz of [-1.1, 1.1]) boxAt(0.07, 2.5, 0.07, d, U(width - 0.6), platY, along(ring(d)), 0x3d454a, 0, 0, lz); }
    if (canopy !== 'shelter' && /Line|Mattapan/.test(rail || '')) { const r = ring(sd + 6), led = mat({ map: ledTex(dest || name), glow: 1 }); const l1 = panel(sd + 6, U(width * 0.4), cy - 0.75, 1.9, 0.48, led, null); l1.rotation.y = along(r); const l2 = panel(sd + 6, U(width * 0.4), cy - 0.75, 1.9, 0.48, led, null); l2.rotation.y = along(r) + Math.PI; }
  }
  // ── benches and bins along the back, facing the track ──
  for (let d = s0 + 7; d <= s1 - 5; d += 13) {
    const r = ring(d), yaw = facing(r, S), u = U(width - 0.75);
    boxAt(1.9, 0.06, 0.42, d, u, platY + 0.44, yaw, 0x6b4a2a, 0, 0, 0, 1.1); boxAt(1.9, 0.45, 0.05, d, u, platY + 0.5, yaw, 0x6b4a2a, 0, 0, -0.22, 1.1);
    for (const lx of [-0.8, 0.8]) boxAt(0.06, 0.44, 0.4, d, u, platY, yaw, 0x3a3a3a, lx);
    cylAt(0.28, 0.95, d + 4, U(width - 0.6), platY, 0, 0x1f3a2c);
    cylAt(0.3, 0.05, d + 4, U(width - 0.6), platY + 0.95, 0, 0x3a3a3a);
  }
  // ── people waiting ──
  const n = Math.round((s1 - s0) / (under ? 4.5 : 9) * (0.6 + Math.random() * 0.6));
  for (let i = 0; i < n; i++) {
    const d = s0 + 3 + Math.random() * (s1 - s0 - 6), t = 1.2 + Math.random() * (width - 2.2), r = ring(d);
    if (under && d > sd + len * 0.22 - 1.5 && d < sd + len * 0.22 + 10 && Math.abs(t - width * 0.55) < 1.8) continue;   // (not on the stairs)
    const yaw = Math.random() < 0.75 ? facing(r, S) + (Math.random() - 0.5) * 1.2 : along(r) + (Math.random() < 0.5 ? 0 : Math.PI);
    person(d, U(t), platY, yaw);
  }
  function person(d, u, y, yaw) {
    const h = 1.58 + Math.random() * 0.3, k = h / 1.75, top = pick(CLOTH), legs = pick(TROUSERS), skin = pick(SKIN), hair = pick([0x1a1410, 0x2a1d14, 0x4a3420, 0x6b4a2a, 0x8a8478, 0x1a1410]);
    for (const lx of [-0.1, 0.1]) boxAt(0.15, 0.82 * k, 0.17, d, u, y, yaw, legs, lx);
    boxAt(0.17, 0.08, 0.27, d, u, y, yaw, 0x222222, -0.1, 0, 0.04); boxAt(0.17, 0.08, 0.27, d, u, y, yaw, 0x222222, 0.1, 0, 0.04);
    boxAt(0.44, 0.62 * k, 0.24, d, u, y, yaw, top, 0, 0.8 * k);
    for (const lx of [-0.27, 0.27]) boxAt(0.1, 0.58 * k, 0.12, d, u, y, yaw, top, lx, 0.82 * k);
    boxAt(0.2, 0.24 * k, 0.22, d, u, y, yaw, skin, 0, 1.47 * k);
    boxAt(0.21, 0.08, 0.23, d, u, y, yaw, hair, 0, 1.69 * k);
    if (Math.random() < 0.35) boxAt(0.32, 0.4 * k, 0.16, d, u, y, yaw, pick([0x1c1c1e, 0x24324a, 0x7a2a2a, 0x3b3d42]), 0, 0.95 * k, -0.2);   // a backpack
  }
  if (M.pos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(M.pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(M.nor, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(M.col, 3)); g.setIndex(M.idx);
    mesh(g, under ? (mats.push(new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(1, 1, 1).multiplyScalar(bright * 0.8) })), mats.at(-1)) : (mats.push(new THREE.MeshLambertMaterial({ vertexColors: true })), mats.at(-1)));
  }
  return { group, s0, s1, dispose() { group.removeFromParent(); for (const g of geos) g.dispose(); for (const m of mats) m.dispose(); } };
}
// the platform's height and length for a train at a station: the T's subway lines' high platforms, a trolley's low
// ones; the commuter rail's mostly low (a few rebuilt stations high)
const CR_HIGH = /Back Bay|Ruggles|Forest Hills|JFK|Quincy Center|Braintree|Porter|Lansdowne|Boston Landing|Route 128|Anderson|Salem|Lynn|Malden|Oak Grove|Newmarket|Four Corners|Talbot|Blue Hill|Fairmount|Readville|Uphams|Morton|River Works|Worcester|Framingham|Lowell|Haverhill|Providence|South Station|North Station/;
export function platformFor(rail, name, trainLen) {
  if (/Green|Mattapan/.test(rail || '')) return { platY: 0.3, len: Math.max(60, trainLen + 15), canopy: 'shelter' };
  if (/Line/.test(rail || '')) return { platY: 1.05, len: Math.max(125, trainLen + 15), canopy: 'all' };
  return { platY: CR_HIGH.test(name || '') ? 1.1 : 0.25, len: Math.max(170, trainLen + 40), canopy: 'middle' };
}
