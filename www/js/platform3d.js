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
// (v1154) New York's subway lines, by the MTA's colours ('A train', '1 train', the Staten Island Railway's)
const NYC_COL = { 1: '#ee352e', 2: '#ee352e', 3: '#ee352e', 4: '#00933c', 5: '#00933c', 6: '#00933c', 7: '#b933ad', A: '#0039a6', C: '#0039a6', E: '#0039a6',
  B: '#ff6319', D: '#ff6319', F: '#ff6319', M: '#ff6319', G: '#6cbe45', J: '#996633', Z: '#996633', L: '#a7a9ac', N: '#fccc0a', Q: '#fccc0a', R: '#fccc0a', W: '#fccc0a', S: '#808183' };
export const lineColour = rail => LINE_COL[rail] || (rail === 'LIRR' ? '#1d4f91' : rail === 'PATH' ? '#0d3b70' : rail === 'Metro-North' ? '#ee0034' : null) || NYC_COL[(rail || '').replace(/ train$/, '')] || (rail === 'Staten Island Railway' ? '#0039a6' : null);
const SKIN = [0xf1c8a8, 0xe0ac86, 0xc68a62, 0x9b6744, 0x6e4a32, 0x4a3224];
const CLOTH = [0x1c1c1e, 0x1c1c1e, 0x2b2f38, 0x3b3d42, 0x24324a, 0x4a5a6e, 0x6b6e72, 0x8b8f94, 0xc9c6bf, 0x7a2a2a, 0x2e4a36, 0xb8945a, 0x5a3a2a, 0xd8d4cc, 0x8a2432, 0x2a4a7a];
const TROUSERS = [0x1c1c1e, 0x23262c, 0x2e3a52, 0x3a4660, 0x4a4a4a, 0x6b5a44, 0x8a8a86];
const pick = a => a[Math.random() * a.length | 0];

// ── a person waiting (v1155, asked of the platforms' people: "can we recursively self improve them?") ──
// Her parts in her own frame: feet at y 0, facing +z, metres; each [geometry, colour]. Rounded (capsules, tapered
// cylinders, an egg of a head), in a few poses (arms down, hands in pockets, looking at her phone, its screen lit),
// a long coat on some, hair long or short, a beanie or a cap, a backpack, a shoulder bag or a roller case. The
// station merges them into its one mesh (put), as it did the boxes they were.
const HAIR = [0x1a1410, 0x1a1410, 0x2a1d14, 0x3a2818, 0x4a3420, 0x6b4a2a, 0x8a6a40, 0x8a8478, 0xb9b2a4];
const BAGS = [0x1c1c1e, 0x24324a, 0x7a2a2a, 0x3b3d42, 0x5a4632, 0x2e4a36];
export function personParts(rnd = Math.random) {
  // (v1162, round 2: limbs between real joints, so arms meet the shoulders and the elbows join; a turned torso, waist
  // to chest; a rounded pelvis under the shirt's hem; hair swept back from the brow; eyes, ears, a smaller nose; a
  // collar, and a jacket worn open over a shirt on some)
  const pk = a => a[rnd() * a.length | 0], out = [], add = (g, hex) => out.push([g, hex]);
  const fem = rnd() < 0.5, h = (fem ? 1.6 : 1.7) + rnd() * 0.18, k = h / 1.75;
  const top = pk(CLOTH), legsC = pk(TROUSERS), skin = pk(SKIN), hairC = pk(HAIR), shoe = pk([0x1a1a1a, 0x1a1a1a, 0x3a2a1c, 0xd8d8d4, 0x5a5a5e]);
  const coat = rnd() < 0.35, open = !coat && rnd() < 0.3, shirt = pk([0xe8e6e0, 0xd9d4c8, 0x2a2d33, 0x8aa0b8]);
  const pose = pk(['down', 'down', 'pockets', 'phone', 'phone', 'both']), sw = (fem ? 0.175 : 0.2) * (0.95 + rnd() * 0.1);
  const V = (x, y, z) => new THREE.Vector3(x, y, z), _q = new THREE.Quaternion(), Y = V(0, 1, 0);
  const limb = (a, b, r, hex, r2 = r) => {   // a capsule from joint a to joint b (tapering to r2 at b)
    const d = b.clone().sub(a), L = d.length(); if (L < 1e-4) return;
    const g = r2 === r ? new THREE.CapsuleGeometry(r, L, 3, 8) : new THREE.CylinderGeometry(r2, r, L, 9);
    g.applyQuaternion(_q.setFromUnitVectors(Y, d.normalize())); g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2); add(g, hex);
    if (r2 !== r) { const j = new THREE.SphereGeometry(r2, 9, 7); j.translate(b.x, b.y, b.z); add(j, hex); }
  };
  const ball = (r, x, y, z, hex, sx = 1, sy = 1, sz = 1, th = Math.PI, tilt = 0) => { const g = new THREE.SphereGeometry(r, 14, 10, 0, Math.PI * 2, 0, th); g.scale(sx, sy, sz); g.rotateX(tilt); g.translate(x, y, z); add(g, hex); };
  const lathe = (pts, hex, sz = 0.62, y0 = 0) => { const g = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 14); g.scale(1, 1, sz); g.translate(0, y0, 0); add(g, hex); };
  const hip = 0.9 * k, knee = 0.49 * k, ank = 0.075, sh = 1.44 * k, lx = sw * 0.47, bend = rnd() < 0.4 ? (rnd() < 0.5 ? -1 : 1) : 0;   // (bend: her weight on one leg, the other knee a little forward)
  // her shoes, legs (hip to knee to ankle) and a rounded pelvis
  for (const s of [-1, 1]) {
    const kn = V(s * lx * 0.95, knee, bend === s ? 0.05 : 0), an = V(s * lx * 0.9, ank, bend === s ? 0.02 : 0);
    limb(V(s * lx, hip, 0), kn, 0.072 * k, legsC, 0.058 * k); limb(kn, an, 0.056 * k, legsC, 0.045 * k);
    const g = new THREE.CapsuleGeometry(0.047, 0.15, 2, 8); g.rotateX(Math.PI / 2); g.scale(1.1, 0.8, 1); g.translate(an.x, 0.045, an.z + 0.05); add(g, shoe);
  }
  ball(sw * 0.78, 0, hip - 0.03, 0, legsC, 1, 0.5, 0.6);   // (under the shirt's hem, not through it)
  // her body: a turned profile, the shirt's hem over her hips, waist, chest, shoulders, to her neck's root
  const T = [[sw * 0.88, -0.1], [sw * 0.88, 0.0], [sw * 0.8, 0.16], [sw * 0.9, 0.3], [sw * 0.98, sh - hip - 0.16], [sw * 0.96, sh - hip - 0.06], [sw * 0.72, sh - hip + 0.01], [sw * 0.3, sh - hip + 0.035]];
  lathe(T, open ? shirt : top, 0.6, hip);
  if (open) { lathe(T.map(([r, y]) => [r * 1.04, y]), top, 0.62, hip); const g = new THREE.BoxGeometry(sw * 0.5, sh - hip - 0.06, 0.02); g.translate(0, (hip + sh) / 2 - 0.02, sw * 0.62 + 0.005); add(g, shirt); }   // (her jacket, open over her shirt)
  if (coat) lathe([[sw * 0.9, 0], [sw * 0.98, -(hip - knee) * 0.5], [sw * 1.05, -(hip - knee) - 0.06]], top, 0.66, hip + 0.02);
  { const g = new THREE.TorusGeometry(0.06, 0.016, 6, 14); g.rotateX(Math.PI / 2); g.translate(0, sh + 0.02, 0.005); add(g, open || rnd() < 0.3 ? shirt : top); }   // her collar
  for (const s of [-1, 1]) ball(0.05, s * (sw - 0.02), sh - 0.05, 0, top, 1, 1, 0.9);   // her shoulders, rounded
  // her arms, shoulder to elbow to wrist, by her pose
  const arm = (s, kind) => {
    const S = V(s * (sw - 0.01), sh - 0.06, 0); let E, W;
    if (kind === 'pockets') { E = V(s * (sw + 0.035), sh - 0.32 * k, -0.03); W = V(s * sw * 0.72, hip + 0.03, 0.07); limb(S, E, 0.05, top, 0.046); limb(E, W, 0.045, top, 0.04); return; }
    if (kind === 'phone') { E = V(s * (sw + 0.015), sh - 0.3 * k, 0.03); W = V(s * 0.05, sh - 0.33, 0.25); }
    else { E = V(s * (sw + 0.03), sh - 0.3 * k, -0.015); W = V(s * (sw + 0.035), sh - 0.56 * k, 0.025); }
    limb(S, E, 0.05, top, 0.046); limb(E, W, 0.045, top, 0.038);
    ball(0.042, W.x, W.y - 0.045, W.z + 0.01, skin, 0.8, 1.35, 0.6);   // her hand
    if (kind === 'phone' && s > 0) { const ph = new THREE.BoxGeometry(0.07, 0.14, 0.01); ph.rotateX(-0.85); ph.translate(0, W.y + 0.03, W.z + 0.02); add(ph, 0x9fc8ff); }   // (her phone, its screen lit)
  };
  arm(-1, pose === 'both' ? 'phone' : pose === 'phone' ? 'down' : pose); arm(1, pose === 'both' ? 'phone' : pose);
  // her neck and head: an egg, tipped down a little at her phone; eyes, ears, a nose; her hair swept back from her brow
  limb(V(0, sh, 0.005), V(0, sh + 0.075, 0.01), 0.05, skin);
  const look = pose === 'phone' || pose === 'both', hy = sh + 0.17, hz = look ? 0.03 : 0.012, tip = look ? 0.3 : 0;
  ball(0.098, 0, hy, hz, skin, 0.84, 1.12, 1.0);
  ball(0.016, 0, hy - 0.012 - tip * 0.02, hz + 0.098, skin, 0.75, 1.2, 0.9);   // her nose
  for (const s of [-1, 1]) { ball(0.011, s * 0.033, hy + 0.018 - tip * 0.03, hz + 0.088, 0x1d1712); ball(0.022, s * 0.083, hy, hz - 0.005, skin, 0.5, 1, 0.8); }   // eyes, ears
  const hat = rnd();
  if (hat < 0.12) ball(0.103, 0, hy + 0.012, hz - 0.006, pk([0x1c1c1e, 0x7a2a2a, 0x3a4a6a, 0xb9b2a4, 0x2e4a36]), 0.88, 1.15, 1.03, Math.PI * 0.55);   // a beanie
  else if (hat < 0.2) { ball(0.102, 0, hy + 0.02, hz - 0.005, 0x23262c, 0.88, 1.05, 1.03, Math.PI * 0.5); const b = new THREE.BoxGeometry(0.14, 0.012, 0.09); b.translate(0, hy + 0.035, hz + 0.12); add(b, 0x23262c); }   // a cap
  else {
    ball(0.104, 0, hy + 0.006, hz - 0.018, hairC, 0.89, 1.12, 1.05, Math.PI * (fem ? 0.62 : 0.56), -0.42);   // (swept back: the hairline high at her brow, low at her nape)
    if (fem && rnd() < 0.7) limb(V(0, hy - 0.02, hz - 0.07), V(0, hy - 0.2 - rnd() * 0.12, hz - 0.08), 0.072, hairC, 0.06);   // long hair, down her back
  }
  // what she carries
  const bag = rnd();
  if (bag < 0.3) { const g = new THREE.CapsuleGeometry(0.11, 0.2, 3, 8); g.scale(1.2, 1, 0.6); g.translate(0, sh - 0.28, -sw * 0.62 - 0.07); add(g, pk(BAGS)); for (const s of [-1, 1]) { limb(V(s * sw * 0.5, sh + 0.005, -0.06), V(s * sw * 0.55, sh - 0.08, sw * 0.6), 0.012, 0x1a1a1a); limb(V(s * sw * 0.55, sh - 0.08, sw * 0.6), V(s * sw * 0.9, sh - 0.3, sw * 0.5), 0.012, 0x1a1a1a); } }   // (its straps over her shoulders and down under her arms)   // a backpack, its straps over her shoulders
  else if (bag < 0.48) { const s = rnd() < 0.5 ? -1 : 1, g = new THREE.BoxGeometry(0.07, 0.24, 0.3); g.translate(s * (sw + 0.1), hip - 0.02, 0); add(g, pk(BAGS)); limb(V(-s * sw * 0.6, sh - 0.01, 0.02), V(s * (sw + 0.08), hip + 0.12, 0.02), 0.012, 0x1a1a1a); }   // a shoulder bag, its strap across her
  else if (bag < 0.52) { const g = new THREE.BoxGeometry(0.38, 0.55, 0.22); g.translate(0.42, 0.33, 0.05); add(g, pk([0x1c1c1e, 0x24324a, 0x6b6e72, 0x7a2a2a])); limb(V(0.42, 0.6, 0.05), V(0.42, 0.95, 0.05), 0.012, 0x8b8f94); }   // a roller case at her side
  return out;
}

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
// ── (v1159, "do the New York station looks next") New York's stations ──
// From the record (the MTA's and the stations' own histories): the IRT's 1904 stations, cream tile with a mosaic frieze
// and mosaic name tablets in a terracotta frame; the BMT's, white tile, a coloured trim, mosaic tablets in its colour;
// the IND's (1932 on), white tile with its colour-coded trim line and the name in plain black letters. Low flat
// ceilings on steel cross girders, rows of steel I-beam columns (black and white name plates on some), black hanging
// signs with white letters and the line's bullet. The art at a few, as likenesses of its style, not copies: the pop
// mural at Times Square (after Roy Lichtenstein's, 2002), the fossil mosaics at 81 St–Museum of Natural History, the
// small bronze figures at 14 St–8 Av (after Tom Otterness's "Life Underground", 2001), the Second Avenue line's high
// caverns (2017) with 96 St's blue-on-white tile (after Sarah Sze's "Blueprint for a Landscape").
const NYC_IND = ['#b5302a', '#2a6a4a', '#6a3d8a', '#c99a1a', '#2a5a9a', '#7a7d80', '#a0522d', '#3a7a7a'];
const hashOf = t => [...(t || '')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const nycTileTex = cream => canvasTex('nyctile' + cream, 256, 128, (x, w, h) => {   // 3 by 6 in subway tile, glazed
  x.fillStyle = '#9a968c'; x.fillRect(0, 0, w, h);
  for (let r = 0; r < 4; r++) for (let c = -1; c < 5; c++) { const ox = r % 2 ? 32 : 0, v = (cream ? 228 : 238) + (Math.random() * 12 | 0); x.fillStyle = cream ? `rgb(${v},${v - 8},${v - 26})` : `rgb(${v},${v},${v - 3})`; x.fillRect(c * 64 + ox + 1, r * 32 + 1, 62, 30); x.fillStyle = 'rgba(255,255,255,0.35)'; x.fillRect(c * 64 + ox + 4, r * 32 + 3, 40, 3); }
}, true);
const friezeTex = () => canvasTex('frieze', 512, 96, (x, w, h) => {   // the IRT's mosaic frieze: a running border of tesserae
  x.fillStyle = '#e9dfc4'; x.fillRect(0, 0, w, h);
  const tess = (cx, cy, col) => { x.fillStyle = col; x.fillRect(cx, cy, 7, 7); };
  for (let i = 0; i < w; i += 8) { tess(i, 2, '#8a3e24'); tess(i, h - 9, '#8a3e24'); tess(i, 12, (i / 8) % 2 ? '#2f6a5a' : '#c9a24a'); tess(i, h - 19, (i / 8) % 2 ? '#2f6a5a' : '#c9a24a'); }
  for (let c = 0; c < w; c += 64) {   // a diamond and rosette each 64 px
    for (let k = -3; k <= 3; k++) for (let j = -(3 - Math.abs(k)); j <= 3 - Math.abs(k); j++) tess(c + 32 + j * 8, h / 2 - 3 + k * 8, Math.abs(k) + Math.abs(j) === 3 - 0 ? '#8a3e24' : (k + j) % 2 ? '#2f6a5a' : '#d8b860');
    tess(c + 4, h / 2 - 3, '#3a5a8a'); tess(c + 12, h / 2 - 3, '#3a5a8a');
  }
}, true);
function tabletTex(name, era, trim) {   // a station's name tablet in her line's era
  const nm = name.toUpperCase();
  return canvasTex('tab:' + era + nm + trim, 1024, 256, (x, w, h) => {
    if (era === 'irt') {
      x.fillStyle = '#8a3e24'; x.fillRect(0, 0, w, h);
      for (let i = 0; i < w; i += 16) for (const y of [6, h - 18]) { x.fillStyle = (i / 16) % 2 ? '#d8b860' : '#2f6a5a'; x.fillRect(i + 2, y, 12, 12); }
      for (let j = 22; j < h - 22; j += 16) for (const xx of [6, w - 18]) { x.fillStyle = (j / 16) % 2 ? '#d8b860' : '#2f6a5a'; x.fillRect(xx, j, 12, 12); }
      x.fillStyle = '#efe4c8'; x.fillRect(30, 30, w - 60, h - 60);
      x.fillStyle = '#1f4a5a'; x.textAlign = 'center'; x.textBaseline = 'middle'; let s = 120; x.font = `bold ${s}px Georgia, "Times New Roman", serif`;
      while (x.measureText(nm).width > w - 120 && s > 40) { s -= 4; x.font = `bold ${s}px Georgia, "Times New Roman", serif`; }
      x.fillText(nm, w / 2, h / 2 + 6);
    } else if (era === 'bmt') {
      x.fillStyle = trim; x.fillRect(0, 0, w, h);
      for (let i = 0; i < 600; i++) { x.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)'; x.fillRect(Math.random() * w, Math.random() * h, 8, 8); }
      x.fillStyle = '#f2efe6'; x.fillRect(26, 26, w - 52, h - 52);
      x.fillStyle = '#222'; x.textAlign = 'center'; x.textBaseline = 'middle'; let s = 112; x.font = `bold ${s}px "Gill Sans", Helvetica, sans-serif`;
      while (x.measureText(nm).width > w - 110 && s > 40) { s -= 4; x.font = `bold ${s}px "Gill Sans", Helvetica, sans-serif`; }
      x.fillText(nm, w / 2, h / 2 + 4);
    } else {   // the IND's: plain black letters on white tile, the trim's colour above and below
      x.fillStyle = '#f2f1ec'; x.fillRect(0, 0, w, h); x.fillStyle = trim; x.fillRect(0, 0, w, 34); x.fillRect(0, h - 34, w, 34); x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(0, 34, w, 4); x.fillRect(0, h - 38, w, 4);
      x.fillStyle = '#111'; x.textAlign = 'center'; x.textBaseline = 'middle'; let s = 120; x.font = `bold ${s}px Futura, "Trebuchet MS", Helvetica, sans-serif`;
      while (x.measureText(nm).width > w - 90 && s > 40) { s -= 4; x.font = `bold ${s}px Futura, "Trebuchet MS", Helvetica, sans-serif`; }
      x.fillText(nm, w / 2, h / 2 + 4);
    }
  });
}
const trimTex = col => canvasTex('trim' + col, 256, 64, (x, w, h) => {   // a tile trim line: its colour, darker edges, its tiles
  x.fillStyle = col; x.fillRect(0, 0, w, h); x.fillStyle = 'rgba(0,0,0,0.3)'; x.fillRect(0, 0, w, 8); x.fillRect(0, h - 8, w, 8);
  x.strokeStyle = 'rgba(0,0,0,0.18)'; x.lineWidth = 2; for (let i = 0; i < w; i += 32) { x.beginPath(); x.moveTo(i, 8); x.lineTo(i, h - 8); x.stroke(); }
}, true);
function nycSignTex(name, line, col) {   // the MTA's hanging sign: black, the name in white Helvetica, her bullet
  return canvasTex('nycsign:' + name + line, 1024, 160, (x, w, h) => {
    x.fillStyle = '#111'; x.fillRect(0, 0, w, h); x.fillStyle = '#fff'; x.fillRect(0, 10, w, 4);
    x.textBaseline = 'middle'; x.textAlign = 'left'; let s = 84; x.font = `bold ${s}px Helvetica, Arial, sans-serif`;
    while (x.measureText(name).width > w - 200 && s > 34) { s -= 4; x.font = `bold ${s}px Helvetica, Arial, sans-serif`; }
    x.fillText(name, 34, h / 2 + 8);
    if (line) { const r = 52, cx = w - 80, cy = h / 2 + 8; x.fillStyle = col; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
      x.fillStyle = col === '#fccc0a' ? '#111' : '#fff'; x.textAlign = 'center'; x.font = `bold ${line.length > 1 ? 44 : 70}px Helvetica, Arial, sans-serif`; x.fillText(line, cx, cy + 4); }
  });
}
const plateTex = name => canvasTex('plate:' + name, 512, 128, (x, w, h) => {   // a column's name plate
  x.fillStyle = '#121212'; x.fillRect(0, 0, w, h); x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
  let s = 64; x.font = `bold ${s}px Helvetica, Arial, sans-serif`; while (x.measureText(name).width > w - 30 && s > 22) { s -= 3; x.font = `bold ${s}px Helvetica, Arial, sans-serif`; } x.fillText(name, w / 2, h / 2 + 3);
});
const popTex = () => canvasTex('pop', 2048, 512, (x, w, h) => {   // Times Square: a pop-art mural, black outlines, primary colours, dots
  x.fillStyle = '#f6f1e2'; x.fillRect(0, 0, w, h);
  x.fillStyle = '#3a7ad0'; for (let yy = 8; yy < h * 0.55; yy += 18) for (let xx = (yy / 18 % 2) * 9; xx < w; xx += 18) { x.beginPath(); x.arc(xx, yy, 5, 0, Math.PI * 2); x.fill(); }   // Ben-Day dots: the sky
  const out = (f) => { x.lineWidth = 10; x.strokeStyle = '#111'; f(); x.stroke(); };
  // a streamlined train of the future, racing left to right, in yellow and red
  x.fillStyle = '#f2c40f'; x.beginPath(); x.moveTo(140, 330); x.lineTo(1500, 300); x.quadraticCurveTo(1820, 300, 1900, 380); x.lineTo(140, 420); x.closePath(); x.fill(); out(() => { x.beginPath(); x.moveTo(140, 330); x.lineTo(1500, 300); x.quadraticCurveTo(1820, 300, 1900, 380); x.lineTo(140, 420); x.closePath(); });
  x.fillStyle = '#d42a1e'; x.fillRect(140, 380, 1700, 26); out(() => { x.beginPath(); x.rect(140, 380, 1700, 26); });
  for (let i = 0; i < 9; i++) { x.fillStyle = '#9ad0f2'; x.fillRect(240 + i * 140, 322, 90, 40); out(() => { x.beginPath(); x.rect(240 + i * 140, 322, 90, 40); }); }
  for (let i = 0; i < 5; i++) { x.fillStyle = '#111'; x.fillRect(60 - i * 10, 340 + i * 14, 70 + i * 20, 6); }   // speed lines
  // the city behind: blocks in red, blue and black, outlined
  for (let i = 0; i < 12; i++) { const bx = 40 + i * 170, bw = 120, bh = 120 + (i * 53 % 140); x.fillStyle = ['#d42a1e', '#2a5aa8', '#f6f1e2', '#111'][i % 4]; x.fillRect(bx, 290 - bh, bw, bh); out(() => { x.beginPath(); x.rect(bx, 290 - bh, bw, bh); }); }
  x.fillStyle = '#111'; x.fillRect(0, 430, w, 82); x.fillStyle = '#f2c40f'; for (let i = 0; i < w; i += 120) x.fillRect(i, 466, 70, 10);
}, true);
const fossilTex = () => canvasTex('fossil', 1024, 512, (x, w, h) => {   // 81 St: fossils and animals in mosaic, on sand
  x.fillStyle = '#d9c9a4'; x.fillRect(0, 0, w, h);
  for (let i = 0; i < 1400; i++) { const v = 190 + (Math.random() * 40 | 0); x.fillStyle = `rgb(${v},${v - 14},${v - 46})`; x.fillRect(Math.random() * w, Math.random() * h, 9, 9); }
  x.lineWidth = 9; x.strokeStyle = '#6a4a2a';
  for (const [cx, cy, r] of [[180, 160, 110], [760, 360, 90]]) { x.beginPath(); for (let t = 0; t < 22; t += 0.1) { const rr = r * Math.exp(-t * 0.09); x.lineTo(cx + Math.cos(t) * rr, cy + Math.sin(t) * rr); } x.stroke(); }   // ammonites
  x.strokeStyle = '#4a3a2a'; x.beginPath(); x.moveTo(380, 330); x.quadraticCurveTo(520, 200, 690, 250); x.stroke();   // a dinosaur's spine and ribs
  for (let i = 0; i < 9; i++) { const px = 400 + i * 32, py = 300 - i * 9; x.beginPath(); x.moveTo(px, py); x.lineTo(px + 6, py + 70); x.stroke(); }
  x.beginPath(); x.arc(700, 245, 26, 0, Math.PI * 2); x.stroke();
  x.fillStyle = '#5a6a3a'; for (const [cx, cy] of [[300, 430], [900, 120]]) { x.beginPath(); x.ellipse(cx, cy, 60, 26, 0.3, 0, Math.PI * 2); x.fill(); }   // trilobites
}, true);
const szeTex = () => canvasTex('sze', 1024, 512, (x, w, h) => {   // 96 St: blue line drawing on white porcelain tile
  x.fillStyle = '#f4f6f8'; x.fillRect(0, 0, w, h); x.strokeStyle = 'rgba(160,170,180,0.5)'; x.lineWidth = 2; for (let i = 0; i <= w; i += 64) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, h); x.stroke(); } for (let j = 0; j <= h; j += 64) { x.beginPath(); x.moveTo(0, j); x.lineTo(w, j); x.stroke(); }
  x.strokeStyle = '#2a5ab0'; x.lineWidth = 3;
  for (let i = 0; i < 70; i++) { const a = Math.random() * Math.PI * 2, L = 40 + Math.random() * 260, sx = Math.random() * w, sy = Math.random() * h; x.beginPath(); x.moveTo(sx, sy); x.lineTo(sx + Math.cos(a) * L, sy + Math.sin(a) * L); x.stroke(); }   // the scaffolding's lines
  for (let i = 0; i < 26; i++) { const cx = Math.random() * w, cy = Math.random() * h; x.beginPath(); x.moveTo(cx - 14, cy); x.quadraticCurveTo(cx - 6, cy - 9, cx, cy); x.quadraticCurveTo(cx + 6, cy - 9, cx + 14, cy); x.stroke(); }   // birds
  x.fillStyle = 'rgba(42,90,176,0.5)'; for (let i = 0; i < 14; i++) { x.beginPath(); x.ellipse(Math.random() * w, Math.random() * h, 22, 8, Math.random() * 3, 0, Math.PI * 2); x.fill(); }   // leaves blowing
}, true);
function ledTex(dest) {   // the countdown sign: her destination, and BRD (she's boarding)
  return canvasTex('led:' + dest, 512, 128, (x, w, h) => {
    x.fillStyle = '#050505'; x.fillRect(0, 0, w, h); x.fillStyle = '#ffb21e'; x.textBaseline = 'middle';
    let s = 46; x.font = `bold ${s}px "Courier New", monospace`; while (x.measureText(dest).width > w - 140 && s > 22) { s -= 2; x.font = `bold ${s}px "Courier New", monospace`; }
    x.fillText(dest, 18, h * 0.32); x.textAlign = 'right'; x.font = 'bold 46px "Courier New", monospace'; x.fillText('BRD', w - 18, h * 0.32);
    x.textAlign = 'left'; x.globalAlpha = 0.25; x.font = 'bold 30px "Courier New", monospace'; x.fillText('Stand back from the platform edge', 18, h * 0.76);
  });
}

// (v1152) a tile mosaic's name, as the T's old stations have them ("SOUTH STATION UNDER", "SCOLLAY UNDER"): blue
// letters on white tile in a blue border
function mosaicTex(text) {
  return canvasTex('mosaic:' + text, 1024, 192, (x, w, h) => {
    const t = 16;
    for (let r = 0; r < h / t; r++) for (let c = 0; c < w / t; c++) { const v = 228 + (Math.random() * 20 | 0); x.fillStyle = `rgb(${v},${v - 1},${v - 6})`; x.fillRect(c * t, r * t, t - 1, t - 1); }
    x.fillStyle = '#1d4f9a'; for (const [a, b, cw, ch] of [[0, 0, w, 2 * t], [0, h - 2 * t, w, 2 * t], [0, 0, 2 * t, h], [w - 2 * t, 0, 2 * t, h]]) x.fillRect(a, b, cw, ch);
    x.fillStyle = '#2a64b8'; for (let c = 0; c < w / t; c += 2) { x.fillRect(c * t, t * 0.5, t - 1, t - 1); x.fillRect(c * t, h - t * 1.5, t - 1, t - 1); }
    x.fillStyle = '#163f80'; x.textAlign = 'center'; x.textBaseline = 'middle'; let s = 96; x.font = `bold ${s}px Georgia, serif`;
    while (x.measureText(text).width > w - 120 && s > 40) { s -= 4; x.font = `bold ${s}px Georgia, serif`; }
    x.fillText(text, w / 2, h / 2 + 4);
    x.strokeStyle = 'rgba(60,60,60,0.35)'; x.lineWidth = 1; for (let c = 0; c <= w / t; c++) { x.beginPath(); x.moveTo(c * t - 0.5, 0); x.lineTo(c * t - 0.5, h); x.stroke(); } for (let r = 0; r <= h / t; r++) { x.beginPath(); x.moveTo(0, r * t - 0.5); x.lineTo(w, r * t - 0.5); x.stroke(); }
  });
}
// (v1152) Park Street's Green Line wall, after Lilli Ann K. Rosenberg's "Celebration of the Underground" (1978): a long
// mosaic of handmade tiles, figures and found things in bright colour along the outbound tracks' wall (a likeness of
// its manner, made up here, not a copy of it); a repeat 8 m long
const muralTex = () => canvasTex('mural', 2048, 512, (x, w, h) => {
  const C = ['#e8b23a', '#d2462f', '#2f7fbf', '#3a9a5b', '#7d3f98', '#f0e0c0', '#e07a2e', '#1f4f7a', '#c23a6b', '#6cb3c9', '#8a6a3a', '#f4d35e'];
  x.fillStyle = '#efe6d2'; x.fillRect(0, 0, w, h);
  for (let i = 0; i < 1700; i++) { x.fillStyle = C[Math.random() * C.length | 0]; x.globalAlpha = 0.35 + Math.random() * 0.5; const s = 8 + Math.random() * 22; x.save(); x.translate(Math.random() * w, Math.random() * h); x.rotate(Math.random() * 3); x.fillRect(-s / 2, -s / 2, s, s * (0.6 + Math.random() * 0.8)); x.restore(); }
  x.globalAlpha = 1;
  for (let i = 0; i < 26; i++) {   // the figures: people of the city, arms up
    const cx = 40 + i * (w - 80) / 25 + (Math.random() - 0.5) * 30, base = h * (0.82 + Math.random() * 0.1), s = 0.75 + Math.random() * 0.5, c = C[Math.random() * C.length | 0];
    x.fillStyle = c; x.strokeStyle = c; x.lineCap = 'round';
    x.beginPath(); x.arc(cx, base - 250 * s, 26 * s, 0, 7); x.fill();
    x.lineWidth = 34 * s; x.beginPath(); x.moveTo(cx, base - 215 * s); x.lineTo(cx, base - 110 * s); x.stroke();
    x.lineWidth = 16 * s; const up = Math.random() < 0.6;
    for (const sg of [-1, 1]) { x.beginPath(); x.moveTo(cx, base - 200 * s); x.lineTo(cx + sg * 55 * s, base - (up ? 280 : 130) * s); x.stroke(); x.beginPath(); x.moveTo(cx, base - 110 * s); x.lineTo(cx + sg * 30 * s, base); x.stroke(); }
    x.fillStyle = '#1a1a1a'; x.beginPath(); x.arc(cx - 8 * s, base - 254 * s, 3.5 * s, 0, 7); x.arc(cx + 8 * s, base - 254 * s, 3.5 * s, 0, 7); x.fill();
  }
  for (let i = 0; i < 60; i++) { x.fillStyle = C[Math.random() * C.length | 0]; x.beginPath(); x.arc(Math.random() * w, Math.random() * h * 0.4, 6 + Math.random() * 18, 0, 7); x.fill(); }   // (the found things set in it)
  x.strokeStyle = 'rgba(80,70,60,0.25)'; x.lineWidth = 2; for (let c = 0; c < w; c += 24) { x.beginPath(); x.moveTo(c, 0); x.lineTo(c, h); x.stroke(); } for (let r = 0; r < h; r += 24) { x.beginPath(); x.moveTo(0, r); x.lineTo(w, r); x.stroke(); }
  x.strokeStyle = '#6a5a3a'; x.lineWidth = 14; x.strokeRect(7, 7, w - 14, h - 14);
}, true);
// (v1152) terrazzo, the floor in the line's colour (Government Center's): chips in a ground of the colour
function terrazzoTex(hex) {
  return canvasTex('terrazzo:' + hex, 256, 256, (x, w, h) => {
    x.fillStyle = '#c9c5bc'; x.fillRect(0, 0, w, h); x.fillStyle = hex; x.globalAlpha = 0.55; x.fillRect(0, 0, w, h); x.globalAlpha = 1;
    for (let i = 0; i < 900; i++) { const v = Math.random() < 0.5 ? 240 : 60 + (Math.random() * 80 | 0); x.fillStyle = `rgb(${v},${v},${v})`; x.globalAlpha = 0.5 + Math.random() * 0.5; x.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 4, 1 + Math.random() * 3); }
  }, true);
}

// ── (v1152, asked: "model the real stations, like Park Street and South Station") which station looks how ──
// From the record (Wikipedia's articles on the stations, the MBTA's): what's known of each one's platforms. The
// layout itself (where the platforms are, how wide and long, the tracks between) is OpenStreetMap's, fitted in
// fitStation; this is what's on the walls and over the tracks.
//  - Park Street, Green Line level (1897, the oldest subway station in North America): green steel columns; along
//    the outbound tracks' wall, Lilli Ann K. Rosenberg's mosaic "Celebration of the Underground" (1978)
//  - Park Street, Red Line level ("Park Street Under", 1912): its double-vaulted ceiling; Ralph Helmick's
//    "Benedictions", a giant bronze hand over each track
//  - South Station, Red Line: the blue-and-white tile "SOUTH STATION UNDER", found in 2005 and restored
//  - Kendall/MIT: Paul Matisse's "Kendall Band" between the tracks (chimes, a great ring, a sheet of metal), played
//    by levers on the platforms
//  - Porter: a single cylindrical concrete shell (the deepest station, its inbound platform over the outbound)
//  - Government Center (rebuilt 2016): terrazzo floors in the line's colour; the restored "SCOLLAY UNDER" tile on the
//    Blue Line
//  - Boylston, Arlington, Copley, Hynes, Kenmore: the Green Line's old stations' green columns
export function stationStyle(name = '', rail = '') {
  const s = { cols: 0x5a646c, vault: null, rise: 0, art: [], floor: null, wall: 'tile' };
  const green = /Green/.test(rail), red = /Red/.test(rail);
  if (green && /Park Street|Boylston|Arlington|Copley|Hynes|Kenmore/.test(name)) s.cols = 0x2f5a46;
  if (green && /Park Street/.test(name)) s.art.push('celebration');
  if (red && /Park Street/.test(name)) { s.vault = 'double'; s.rise = 2.4; s.art.push('hands'); }
  if (red && /South Station/.test(name)) s.art.push('under:SOUTH STATION UNDER');
  if (red && /Kendall/.test(name)) s.art.push('band');
  if (red && /Porter/.test(name)) { s.vault = 'single'; s.rise = 4; s.wall = 'concrete'; }
  if (/Government Center/.test(name)) { s.floor = lineColour(rail) || null; if (/Blue/.test(rail)) s.art.push('under:SCOLLAY UNDER'); }
  // (v1159) New York's, by her line's era (above, at tabletTex); the special ones by name
  const ny = (rail || '').match(/^([1-7A-Z]) train$/);
  if (ny) {
    const line = ny[1];
    s.nyc = /^[1-7S]$/.test(line) ? 'irt' : /^[JZLNQRW]$/.test(line) ? 'bmt' : 'ind';
    s.cols = { irt: 0x2c4a3a, bmt: 0x34383c, ind: 0x2c3c52 }[s.nyc];
    s.rise = -1.4;   // (her low flat ceiling: about 3.7 m over the platform)
    s.trim = s.nyc === 'irt' ? '#8a3e24' : s.nyc === 'bmt' ? ['#6b3a2a', '#2e5e4e', '#5a4a8a', '#8a6a2a'][hashOf(name) % 4] : NYC_IND[hashOf(name) % NYC_IND.length];
    s.line = line; s.lineCol = lineColour(rail) || '#808183';
    if (/Times Sq/.test(name)) s.art.push('pop');
    if (/^81 St/.test(name)) s.art.push('fossils');
    if (/^14 St/.test(name) && /^[ACEL]$/.test(line)) s.art.push('bronzes');
    if ((line === 'Q' && /^(72|86|96) St$/.test(name)) || /Hudson Yards/.test(name)) { s.nyc = 'cavern'; s.vault = 'single'; s.rise = 4.5; s.wall = 'clean'; if (/^96 St$/.test(name)) s.art.push('sze'); }
  }
  return s;
}

// ── (v1152) the real layout: OpenStreetMap's platforms beside her track at a station, fitted to it ──
// plats: the region's platforms (data/rail/<id>-platforms.json); P: her track's rings; sd: where along them the
// station is; fix: her report's {lon, lat, x, z} (the scene's place for a lon/lat); nearTrack(x, z, r): a track
// within r m. Returns { plats: [{ u0, u1, d0, d1, eL, eH }], tracks: [u], lo, hi, d0, d1, cam } (u across her track,
// right +; eL/eH: a track at its low/high edge) or null (none fits: a made-up one is used).
const GAP = 1.65;   // m: a track's middle to its platform's edge
export function fitStation(data, P, sd, fix, nearTrack, under) {
  if (!data?.plats || !fix) return null;
  const DEG = Math.PI / 180, kx = 111320 * Math.cos(fix.lat * DEG);
  const X = lon => fix.x + (lon - fix.lon) * kx, Z = lat => fix.z - (lat - fix.lat) * 111120;
  const N = P.length - 1, d0r = P[0].d, STEP = (P[N].d - d0r) / N, ring = d => P[Math.max(0, Math.min(N, Math.round((d - d0r) / STEP)))];
  const r0 = ring(sd);
  const proj = (x, z) => { let b = P[0], bd = Infinity; for (const r of P) { const e = (r.x - x) ** 2 + (r.z - z) ** 2; if (e < bd) { bd = e; b = r; } } const dx = x - b.x, dz = z - b.z; return [b.d + dx * Math.sin(b.h) - dz * Math.cos(b.h), dx * Math.cos(b.h) + dz * Math.sin(b.h), b]; };
  // the tracks across hers at the station: hits at three places along it, kept where two agree
  const hits = new Map();
  for (const dd of [-15, 0, 15]) { const r = ring(sd + dd); for (let u = -26; u <= 26.01; u += 0.5) if (nearTrack(r.x + Math.cos(r.h) * u, r.z + Math.sin(r.h) * u, 0.7)) hits.set(u.toFixed(1), (hits.get(u.toFixed(1)) || 0) + 1); }
  const us = [...hits].filter(([, n]) => n >= 2).map(([u]) => +u).sort((a, b) => a - b);
  let tracks = []; for (let i = 0; i < us.length;) { let j = i; while (j + 1 < us.length && us[j + 1] - us[j] <= 1.01) j++; tracks.push((us[i] + us[j]) / 2); i = j + 1; }
  // (two tracks' middles are 3.6 m apart at the least: one nearer hers is a crossover's, or OSM's drawing off; pushed out)
  tracks = tracks.filter(t => Math.abs(t) > 2); tracks.push(0); tracks.sort((a, b) => a - b);
  for (let i = tracks.indexOf(0) + 1; i < tracks.length; i++) tracks[i] = Math.max(tracks[i], tracks[i - 1] + 3.6);
  for (let i = tracks.indexOf(0) - 1; i >= 0; i--) tracks[i] = Math.min(tracks[i], tracks[i + 1] - 3.6);
  // the platforms near: as d (along) and u (across) ranges, each edge snapped to the track beside it
  const out = [];
  for (const pl of data.plats) {
    if (pl.lv != null && (under ? pl.lv > 0 : pl.lv < 0)) continue;
    const xs = pl.g.map(([lo, la]) => [X(lo), Z(la)]);
    if (!xs.some(([x, z]) => (x - r0.x) ** 2 + (z - r0.z) ** 2 < 260 * 260)) continue;
    const pr = xs.map(([x, z]) => proj(x, z));
    if (pr.every(([, , r]) => r === P[0] || r === P[N])) continue;
    let u0 = Math.min(...pr.map(q => q[1])), u1 = Math.max(...pr.map(q => q[1]));
    let d0 = Math.max(P[0].d, Math.min(...pr.map(q => q[0]))), d1 = Math.min(P[N].d, Math.max(...pr.map(q => q[0])));
    if (!pl.c) { const m = (u0 + u1) / 2; u0 = m - 1.8; u1 = m + 1.8; }   // (a line: the platform's middle, 3.6 m wide)
    else {   // (an outline: its width straight across her track near the station, not its corners' spread, on a curve)
      const U0 = [], U1 = [];
      for (let k = -2; k <= 2; k++) {
        const dd = sd + k * 18; if (dd < d0 + 2 || dd > d1 - 2) continue;
        const r = ring(dd), cx = Math.cos(r.h), cz = Math.sin(r.h), us = [];
        for (let i = 0; i + 1 < xs.length; i++) {
          const [ax, az] = xs[i], ex = xs[i + 1][0] - ax, ez = xs[i + 1][1] - az, den = cx * ez - cz * ex; if (Math.abs(den) < 1e-9) continue;
          const ox = ax - r.x, oz = az - r.z, u = (ox * ez - oz * ex) / den, t = (ox * cz - oz * cx) / den;
          if (t >= 0 && t <= 1 && Math.abs(u) < 45) us.push(u);
        }
        if (us.length >= 2) { U0.push(Math.min(...us)); U1.push(Math.max(...us)); }
      }
      const med = A => A.sort((a, b) => a - b)[A.length >> 1];
      if (U0.length) { u0 = med(U0); u1 = med(U1); }
    }
    if (d0 < sd - (under ? 110 : 220)) d0 = sd - (under ? 110 : 220); if (d1 > sd + (under ? 110 : 220)) d1 = sd + (under ? 110 : 220);   // (one that curves away round a loop: its part along hers)
    if (d1 - d0 < 15 || u1 - u0 > 14 || d1 - d0 < (u1 - u0) * 2 || d0 > sd + 80 || d1 < sd - 80) continue;   // (along the track, near the station)
    // the tracks at its edges (OSM's platforms overlap their tracks by a metre or two, or stop short by as much)
    const lowT = tracks.filter(t => t <= u0 + 2.2 && t > u0 - 4.5).at(-1), highT = tracks.filter(t => t >= u1 - 2.2 && t < u1 + 4.5)[0];
    let best = null;
    for (const [L, H] of [[lowT, highT], [lowT, undefined], [undefined, highT]]) {
      if (L === undefined && H === undefined) continue;
      let a = L !== undefined ? L + GAP : u0, b = H !== undefined ? H - GAP : u1;
      if (b - a < 3 && (L === undefined) !== (H === undefined)) { if (L === undefined) a = b - 3.5; else b = a + 3.5; }   // (drawn too thin: 3.5 m, back from its track)
      if (b - a < 2.5) continue;
      if (tracks.some(t => t > a - 0.5 && t < b + 0.5 && t !== L && t !== H && t !== 0)) continue;
      const cost = Math.abs(a - u0) + Math.abs(b - u1) - (L !== undefined && H !== undefined ? 1.5 : 0);
      if (!best || cost < best.cost) best = { u0: a, u1: b, eL: L !== undefined, eH: H !== undefined, cost };
    }
    if (!best || (best.u0 < 0 && best.u1 > 0)) continue;
    out.push({ u0: best.u0, u1: best.u1, d0, d1, eL: best.eL, eH: best.eH, lv: pl.lv });
  }
  // hers: one with an edge at her track; others on another level (where OSM says) left out, and any that overlap hers
  const atHers = o => (o.eL && Math.abs(o.u0 - GAP) < 0.05) || (o.eH && Math.abs(o.u1 + GAP) < 0.05);
  const mine = out.filter(o => atHers(o) && o.d0 <= sd + 30 && o.d1 >= sd - 30).sort((a, b) => (a.d1 - a.d0) * 0 + Math.abs((a.d0 + a.d1) / 2 - sd) - Math.abs((b.d0 + b.d1) / 2 - sd));
  if (!mine.length) return null;
  const lv = mine[0].lv, keep = [];
  for (const o of [...mine, ...out.filter(o => !atHers(o))]) {
    if (lv != null && o.lv != null && o.lv !== lv) continue;
    if (keep.some(k => k.u0 < o.u1 - 0.5 && k.u1 > o.u0 + 0.5)) continue;
    keep.push(o);
  }
  const plats = keep.sort((a, b) => a.u0 - b.u0);
  // the tracks: hers, any beside a platform, and any within 5 m of hers; none through a platform (another level's)
  tracks = tracks.filter(t => t === 0 || (!plats.some(o => t > o.u0 && t < o.u1) && (Math.abs(t) < 5 || plats.some(o => Math.abs(o.u0 - GAP - t) < 0.05 || Math.abs(o.u1 + GAP - t) < 0.05))));
  const lo = Math.min(...plats.map(o => o.u0), ...tracks.map(t => t - 2.3)), hi = Math.max(...plats.map(o => o.u1), ...tracks.map(t => t + 2.3));
  const sd0 = Math.min(...mine.map(o => o.d0)), sd1 = Math.max(...mine.map(o => o.d1));
  return finish({ plats, tracks, lo, hi, d0: Math.min(sd0, ...plats.map(o => o.d0)), d1: Math.max(sd1, ...plats.map(o => o.d1)), real: true });
}
// a made-up one (no platform in OSM fits): hers on the side away from the other track, len m long
export function oneSide(sd, len, sSide, other, TRACKS, P) {
  const W = 5.5, pl = sSide > 0 ? { u0: GAP, u1: GAP + W, eL: true, eH: false } : { u0: -GAP - W, u1: -GAP, eL: false, eH: true };
  pl.d0 = Math.max(P[0].d, sd - len / 2); pl.d1 = Math.min(P[P.length - 1].d, sd + len / 2);
  const tracks = other ? [0, other * TRACKS].sort((a, b) => a - b) : [0];
  const lo = Math.min(pl.u0, other < 0 ? -(TRACKS + 2.4) : -2.5), hi = Math.max(pl.u1, other > 0 ? TRACKS + 2.4 : 4.4);
  return finish({ plats: [pl], tracks, lo, hi, d0: pl.d0, d1: pl.d1, real: false });
}
// where the camera stands on hers: her edge's u, the side of her it's on, and the platform's width
function finish(R) {
  let best = null;
  for (const o of R.plats) for (const [e, side] of [[o.eL && Math.abs(o.u0 - GAP) < 0.05 ? o.u0 : null, 1], [o.eH && Math.abs(o.u1 + GAP) < 0.05 ? o.u1 : null, -1]]) if (e != null && (!best || o.u1 - o.u0 > best.w)) best = { edge: e, side, w: o.u1 - o.u0 };
  R.cam = best; return R;
}

// built: { group, dispose }
// R: the layout (fitStation's, or oneSide's); ceil: the roof's height over her track (a vault springs from it)
export function buildStation({ P, sd, R, platY, rail, name, dest, under, ceil, layer = 0, canopy = 'all', bright = 2.3, style = stationStyle(name, rail) }) {
  const group = new THREE.Group(), mats = [], geos = [];
  const band = lineColour(rail) || '#5a6a7a';
  const N = P.length - 1, d0 = P[0].d, STEP = (P[N].d - d0) / N;
  const ring = d => P[Math.max(0, Math.min(N, Math.round((d - d0) / STEP)))];
  const s0 = R.d0, s1 = R.d1;
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
  function put(g, d, u, y, yaw, hex, k = 1, shade = false) {   // (shade: light from above and a side baked in, for the unlit stations underground: v1155)
    const r = ring(d); W(r, u, y, _v); _m.compose(_v, _q.setFromAxisAngle(UP, yaw), _s); g.applyMatrix4(_m);
    const p = g.attributes.position, n = g.attributes.normal, o = M.pos.length / 3; _c.set(hex).multiplyScalar(k);
    for (let i = 0; i < p.count; i++) { M.pos.push(p.getX(i), p.getY(i), p.getZ(i)); M.nor.push(n.getX(i), n.getY(i), n.getZ(i));
      const f = shade ? 0.62 + 0.3 * Math.max(0, n.getY(i)) + 0.16 * Math.max(0, 0.5 * n.getX(i) + 0.7 * n.getZ(i)) - 0.12 * Math.max(0, -n.getY(i)) : 1;
      M.col.push(_c.r * f, _c.g * f, _c.b * f); }
    const I = g.index; if (I) for (let i = 0; i < I.count; i++) M.idx.push(o + I.getX(i)); else for (let i = 0; i < p.count; i++) M.idx.push(o + i);
    g.dispose();
  }
  // a box in the frame of a thing at (d, u, y) turned yaw: its own offsets (along its facing: lx across, lz ahead)
  const boxAt = (w, h, l, d, u, y, yaw, hex, lx = 0, ly = 0, lz = 0, k) => { const g = new THREE.BoxGeometry(w, h, l); g.translate(lx, ly + h / 2, lz); put(g, d, u, y, yaw, hex, k); };
  const cylAt = (r, h, d, u, y, yaw, hex, lx = 0, ly = 0, lz = 0, seg = 10, k) => { const g = new THREE.CylinderGeometry(r, r, h, seg); g.translate(lx, ly + h / 2, lz); put(g, d, u, y, yaw, hex, k); };

  const camU = R.cam ? R.cam.edge + R.cam.side * Math.min(2.4, R.cam.w - 0.5) : null;
  const pls = R.plats.map(o => ({ ...o, w: o.u1 - o.u0, m: (o.u0 + o.u1) / 2, len: o.d1 - o.d0 }));
  // where each platform's edges are: [edge u, inward sign]
  const edges = o => [o.eL && [o.u0, 1], o.eH && [o.u1, -1]].filter(Boolean);
  // a person's or a bench's facing: toward the platform's nearer edge
  const toEdge = (o, u) => { const E = edges(o); if (!E.length) return 1; const [e] = E.reduce((a, b) => Math.abs(b[0] - u) < Math.abs(a[0] - u) ? b : a); return e < u ? -1 : 1; };

  // ── the platforms ──
  const floorM = style.floor ? mat({ map: terrazzoTex(style.floor) }) : mat({ map: paverTex() });
  const tactM = mat({ map: tactileTex() }), granM = mat({ color: 0xb4b2ac }), faceM = mat({ color: 0x3a3733, glow: under ? 0.9 : undefined }), lipM = mat({ color: 0x2a2724, glow: under ? 0.8 : undefined }), noseM = mat({ color: 0x8e8a82 });
  for (const o of pls) {
    const a = o.eL ? o.u0 + 0.9 : o.u0, b = o.eH ? o.u1 - 0.9 : o.u1;
    strip(o.d0, o.d1, () => [a, platY, b, platY], floorM, 0.6, 0.6);
    for (const [e, s] of edges(o)) {
      strip(o.d0, o.d1, () => [e + s * 0.3, platY + 0.004, e + s * 0.9, platY + 0.004], tactM, 0.3, 0.3);
      strip(o.d0, o.d1, () => [e, platY + 0.002, e + s * 0.3, platY + 0.002], granM);   // the granite edge
      strip(o.d0, o.d1, () => [e, -0.3, e, platY - 0.08], faceM);
      strip(o.d0, o.d1, () => [e + s * 0.12, platY - 0.08, e, platY - 0.08], lipM);   // its lip, overhanging
      strip(o.d0, o.d1, () => [e, platY - 0.08, e, platY], noseM);
    }
    if (!under) for (const e of [!o.eL && o.u0, !o.eH && o.u1]) if (e !== false) strip(o.d0, o.d1, () => [e, -0.3, e, platY], mat({ color: 0x5b5852 }));   // its back
    for (const e of [o.d0, o.d1]) { const r = ring(e); boxAt(o.w, platY + 0.3, 0.05, e, o.m, -0.3, along(r), 0x5b5852, 0, 0, 0, under ? 1.2 : 1); }   // its ends
  }
  // which walls have a platform against them (its back), which a track beside them
  const backed = u => pls.some(o => (Math.abs(o.u0 - u) < 0.4 && !o.eL) || (Math.abs(o.u1 - u) < 0.4 && !o.eH));

  if (under) {
    const NY = style.nyc, nyOld = NY && NY !== 'cavern';   // (v1159: New York's; the old stations, not the Second Avenue line's caverns)
    const top = ceil + (NY && style.rise < 0 ? style.rise : 0);
    // ── the walls: tile (Porter's concrete), the line's band, names, posters and maps; on both sides ──
    const wallM = style.wall === 'concrete' ? mat({ color: 0x8f8a80 }) : style.wall === 'clean' ? mat({ color: 0xe6e8ea, glow: 1.25 }) : NY ? mat({ map: nycTileTex(NY === 'irt') }) : mat({ map: tileTex() });
    const walls = [[R.lo + 0.03, -1], [R.hi - 0.03, 1]];   // [u, its side]
    for (const [u, s] of walls) {
      strip(s0, s1, () => [u, -0.3, u, top + (style.vault ? 0.4 : 0)], wallM, 0.6, 0.3);
      if (NY === 'irt') strip(s0, s1, () => [u - s * 0.01, top - 0.55, u - s * 0.01, top - 0.2], mat({ map: friezeTex(), glow: 1.5 }), 3.2, 0.35);   // (the IRT's mosaic frieze)
      else if (nyOld) strip(s0, s1, () => [u - s * 0.01, platY + 2.6, u - s * 0.01, platY + 2.9], mat({ map: trimTex(style.trim), glow: 1.5 }), 2, 0.3);   // (the BMT's and IND's trim line)
      else if (!NY && style.wall !== 'concrete') strip(s0, s1, () => [u - s * 0.01, platY + 2.45, u - s * 0.01, platY + 2.75], mat({ color: band, glow: 1.6 }));
    }
    const nameM = mat({ map: nameTex(name, band), glow: 1.5 });
    const tabletM = nyOld ? mat({ map: tabletTex(name, NY, style.trim), glow: 1.5 }) : null, nySignM = NY ? mat({ map: nycSignTex(name, style.line, style.lineCol), glow: 1.6 }) : null;
    const under_ = style.art.find(a => a.startsWith('under:'));
    // (Park Street) the mosaic on the wall with a track beside it
    // (on a wall seen across a track from a platform: one with a track beside it but not hers, else a platform's back
    // not hers, else the wall beside her track)
    const camPl = R.cam && pls.find(o => (R.cam.side > 0 ? o.u0 : o.u1) === R.cam.edge);
    const muralWall = !style.art.includes('celebration') && !style.art.includes('pop') ? null : walls.find(([u]) => !backed(u) && Math.abs(u) > 3) || walls.find(([u]) => backed(u) && !(camPl && (Math.abs(camPl.u0 - u) < 0.4 || Math.abs(camPl.u1 - u) < 0.4))) || walls.find(([u]) => !backed(u));
    if (muralWall) {
      const [u, s] = muralWall, a = Math.max(s0 + 4, sd - 30), b = Math.min(s1 - 4, sd + 30);
      if (style.art.includes('pop')) { const c = sd; strip(c - 9, c + 9, () => [u - s * 0.02, platY + 0.7, u - s * 0.02, platY + 2.5], mat({ map: popTex(), glow: 1.45 }), 18, 1.8); }   // (Times Square's pop mural: 18 m of it)
      else strip(a, b, () => [u - s * 0.02, platY - 0.1, u - s * 0.02, platY + 2.3], mat({ map: muralTex(), glow: 1.45 }), 8, 2.4);
    }
    let k = 0;
    for (let d = s0 + 8; d <= s1 - 6; d += 6, k++) {
      const what = k % 4 === 0 ? 'name' : under_ && k % 4 === 2 ? 'mosaic' : k % 8 === 2 ? 'map' : 'poster';
      for (const [u0, s] of walls) {
        const u = u0 - s * 0.02, y0 = backed(u0) ? platY : platY - 0.2;
        if (what === 'name') { if (tabletM) panel(d, u, y0 + 1.95, 2.6, 0.65, tabletM, s); else if (NY) panel(d, u, y0 + 2.7, 3.2, 0.5, nySignM, s); else panel(d, u, y0 + 3.15, 3.6, 0.56, nameM, s); }
        else if (style.art.includes('fossils') && k % 2) panel(d, u, y0 + 1.5, 2.4, 1.2, mat({ map: fossilTex(), glow: 1.5 }), s);
        else if (style.art.includes('sze')) panel(d, u, y0 + 2.2, 4.8, 2.4, mat({ map: szeTex(), glow: 1.4 }), s);
        else if (muralWall && muralWall[0] === u0 && Math.abs(d - sd) < 31) continue;
        else if (what === 'mosaic') panel(d, u, y0 + 1.7, 3.2, 0.6, mat({ map: mosaicTex(under_.slice(6)), glow: 1.5 }), s);
        else if (what === 'map') panel(d, u, y0 + 1.65, 1.5, 1.5, mat({ map: mapTex(), glow: 1.7 }), s);
        else { panel(d, u, y0 + 1.65, 1.2, 1.8, mat({ map: posterTex((k * 3 + (s > 0 ? 1 : 0)) % 8), glow: 1.6 }), s); boxAt(1.36, 1.96, 0.04, d, u, y0 + 0.67, facing(ring(d), s), 0x2a2a2a, 0, 0, -0.03, 1.4); }
      }
    }
    // the ceiling: flat, or vaulted (Park Street Under's two vaults, one over each track and its platform; Porter's one shell)
    if (style.vault) {
      const spans = style.vault === 'double' && R.tracks.length >= 2 ? (() => { const mid = pls.find(o => o.eL && o.eH)?.m ?? (R.tracks[0] + R.tracks.at(-1)) / 2; return [[R.lo, mid], [mid, R.hi]]; })() : [[R.lo, R.hi]];
      const vM = mat({ color: style.wall === 'concrete' ? 0x8a857b : 0xd8d2c2, glow: 1.2 });
      for (const [a, b] of spans) {
        const n = 12, c = (a + b) / 2, hw = (b - a) / 2;
        for (let i = 0; i < n; i++) { const t0 = Math.PI * i / n, t1 = Math.PI * (i + 1) / n; strip(s0, s1, () => [c - Math.cos(t0) * hw, top + Math.sin(t0) * style.rise, c - Math.cos(t1) * hw, top + Math.sin(t1) * style.rise], vM); }
        for (let d = s0 + 3; d <= s1 - 3; d += 12) for (let i = 0; i < n; i++) { const t0 = Math.PI * i / n, t1 = Math.PI * (i + 1) / n, r = ring(d), u0 = c - Math.cos(t0) * hw, u1 = c - Math.cos(t1) * hw, y0 = top + Math.sin(t0) * style.rise - 0.15, y1 = top + Math.sin(t1) * style.rise - 0.15; const g = new THREE.BoxGeometry(Math.hypot(u1 - u0, y1 - y0) + 0.05, 0.22, 0.4); g.rotateZ(Math.atan2(y1 - y0, u1 - u0)); g.translate((u0 + u1) / 2, (y0 + y1) / 2, 0); put(g, d, 0, 0, -r.h, 0x9a9284, 1.1); }
      }
    }
    // the lamps hung from the roof: two rows over each platform
    for (const o of pls) for (let d = o.d0 + 2; d <= o.d1 - 2; d += 4.5) {
      for (const t of o.w > 4 ? [0.3, 0.75] : [0.5]) { const u = o.u0 + o.w * t; boxAt(0.16, 0.07, 2.4, d, u, top - 0.3, along(ring(d)), 0xfff6e0, 0, 0, 0, 2.6); boxAt(0.02, 0.23, 0.02, d, u, top - 0.23, 0, 0x333333, 0, 0, 0, 1.2); }
    }
    // the stairs up, on the widest platform, a fifth of the way along: steps rising along the track into the roof
    const sp = pls.reduce((a, b) => b.w > a.w ? b : a);
    const stair = sp.w >= 4.6 ? { d: Math.max(sp.d0 + 4, Math.min(sp.d1 - 14, sd + sp.len * 0.2)), u: sp.m } : null;
    const inStair = (d, u) => stair && d > stair.d - 1.5 && d < stair.d + 10 && Math.abs(u - stair.u) < 1.8;
    if (stair) { const r = ring(stair.d), yaw = along(r), n = Math.ceil((top - platY + 0.2) / 0.18);
      for (let i = 0; i < n; i++) boxAt(2.4, 0.18, 0.3, stair.d, stair.u, platY + i * 0.18, yaw, 0x8a8780, 0, 0, i * 0.28, 1.05);
      for (const sx of [-1.25, 1.25]) { const g = new THREE.BoxGeometry(0.12, 1.0, n * 0.28 + 0.6); g.translate(sx, 0.5, n * 0.14); g.applyMatrix4(new THREE.Matrix4().makeShear(0, 0, 0, 0, 0, 0.64)); put(g, stair.d, stair.u, platY + 0.2, yaw, 0xcfc9b8, 1.1); }
      boxAt(2.8, 0.06, 0.06, stair.d, stair.u, platY + 1.05, yaw, 0x9a9a98, 0, 0, -0.2, 1.2); }
    // the columns: down the middle of each wide platform, and between tracks with no platform between them
    if (nyOld) {
      // (v1159) New York's: steel I-beams every 4.6 m, 1.3 m in from each platform edge with a track, and between tracks
      // with no platform between; a black name plate on every third; steel girders across the ceiling over them
      const ibeam = (d, u, y, h) => { const yaw = along(ring(d)); boxAt(0.3, h, 0.035, d, u, y, yaw, style.cols, 0, 0, -0.13, 1.1); boxAt(0.3, h, 0.035, d, u, y, yaw, style.cols, 0, 0, 0.13, 1.1); boxAt(0.035, h, 0.26, d, u, y, yaw, style.cols, 0, 0, 0, 1.0); };
      const plateM = mat({ map: plateTex(name), glow: 1.6 }); let n = 0;
      for (const o of pls) if (o.w >= 3.2) for (const [has, u] of [[o.eL, o.u0 + 1.3], [o.eH, o.u1 - 1.3]]) if (has) for (let d = o.d0 + 3; d <= o.d1 - 3; d += 4.6) {
        if (inStair(d, u)) continue; ibeam(d, u, platY, top - platY);
        if (n++ % 3 === 0) for (const t of [0, Math.PI]) { const pl = panel(d, u, platY + 1.9, 0.9, 0.22, plateM, null); pl.rotation.y = along(ring(d)) + t; pl.position.y += 0; pl.translateZ(0.15); }
      }
      for (let i = 0; i + 1 < R.tracks.length; i++) { const a = R.tracks[i], b = R.tracks[i + 1]; if (b - a > 2.8 && !pls.some(o => o.u0 > a && o.u1 < b)) for (let d = s0 + 3; d <= s1 - 3; d += 4.6) ibeam(d, (a + b) / 2, -0.3, top + 0.3); }
      for (let d = s0 + 3; d <= s1 - 3; d += 4.6) boxAt(R.hi - R.lo, 0.32, 0.22, d, (R.lo + R.hi) / 2, top - 0.32, along(ring(d)), style.cols, 0, 0, 0, 0.9);
    } else if (!NY) {
    for (const o of pls) if (o.w >= 4.5) for (let d = o.d0 + 5; d <= o.d1 - 4; d += 9) if (!inStair(d, o.m)) boxAt(0.36, top - platY, 0.36, d, o.m, platY, along(ring(d)), style.cols, 0, 0, 0, 1.1);
    for (let i = 0; i + 1 < R.tracks.length; i++) { const a = R.tracks[i], b = R.tracks[i + 1]; if (b - a > 2.8 && !pls.some(o => o.u0 > a && o.u1 < b)) for (let d = s0 + 3; d <= s1 - 3; d += 6) boxAt(0.3, top + 0.3, 0.3, d, (a + b) / 2, -0.3, along(ring(d)), style.cols, 0, 0, 0, 1.0); }
    }
    // hanging signs over each platform: the name, and the countdown
    const led = mat({ map: ledTex(dest || name), glow: 1.6 });
    for (const o of pls) for (let d = o.d0 + 18; d <= o.d1 - 10; d += 32) {
      const r = ring(d), y = top - 0.8, u = o.u0 + o.w * (o.w > 4 ? 0.4 : 0.5);
      for (const t of [1, -1]) { const nm = panel(d, u, y, NY ? 2.8 : 2.4, NY ? 0.44 : 0.38, nySignM || nameM, null); nm.rotation.y = facing(r, -1) + t * Math.PI / 2; }
      for (const t of [0, Math.PI]) { const l = panel(d + 9, u, y, 1.9, 0.48, led, null); l.rotation.y = along(r) + t; }
      for (const dd of [d, d + 9]) boxAt(0.03, top - y - 0.2, 0.03, dd, u, y + 0.2, 0, 0x333333, 0, 0, 0, 1.2);
    }
    // (14 St–8 Av) little bronze people, after "Life Underground": on the girders, at the columns' feet, by the benches
    if (style.art.includes('bronzes')) for (let i = 0; i < 14; i++) {
      const o = pls[i % pls.length], d = sd - 28 + i * 4.3 + (i % 3), u = o.u0 + 0.6 + ((i * 0.37) % 1) * Math.max(0.2, o.w - 1.2), up = i % 4 === 0;
      const y = up ? top - 0.16 : platY, B = 0x6a4a24, k = 1.1, yaw = along(ring(d)) + i;
      { const g = new THREE.CylinderGeometry(0.11, 0.14, 0.32, 10); g.translate(0, 0.28, 0); put(g, d, u, y, yaw, B, k); }   // her round body
      { const g = new THREE.SphereGeometry(0.1, 12, 10); g.translate(0, 0.53, 0); put(g, d, u, y, yaw, B, k); }   // her round head
      { const g = new THREE.CylinderGeometry(0.075, 0.075, 0.08, 10); g.translate(0, 0.66, 0); put(g, d, u, y, yaw, B, k); const b = new THREE.CylinderGeometry(0.13, 0.13, 0.012, 12); b.translate(0, 0.62, 0); put(b, d, u, y, yaw, B, k); }   // her bowler hat
      for (const sx of [-0.06, 0.06]) { const g = new THREE.CylinderGeometry(0.035, 0.04, 0.14, 6); g.translate(sx, 0.07, 0); put(g, d, u, y, yaw, B, k); }
      if (i % 3 === 1) { const g = new THREE.BoxGeometry(0.16, 0.16, 0.08); g.translate(0.15, 0.25, 0); put(g, d, u, y, yaw, 0xb08a3a, k); }   // a moneybag
    }
    // (Park Street Under) "Benedictions": a giant bronze hand over each track, raised in blessing
    if (style.art.includes('hands')) R.tracks.forEach((t, i) => { const d = sd + (i ? 14 : -14), yaw = along(ring(d)) + (i ? Math.PI : 0); hand(d, t, top + style.rise * 0.35, yaw); });
    // (Kendall/MIT) the Kendall Band, between the tracks: chimes, a great ring, a sheet of metal; levers on the platforms
    if (style.art.includes('band') && R.tracks.length >= 2) {
      const u = (R.tracks[0] + R.tracks[1]) / 2, yaw = along(ring(sd));
      for (let i = 0; i < 8; i++) { const l = 1.8 + i * 0.3; cylAt(0.11, l, sd - 13 + i * 0.6, u, top - 0.8 - l, yaw, 0xd4d8dc, 0, 0, 0, 12, 1.4); boxAt(0.02, 0.8, 0.02, sd - 13 + i * 0.6, u, top - 0.8, 0, 0x333333, 0, 0, 0, 1.2); }   // the chimes
      { const g = new THREE.TorusGeometry(1.3, 0.12, 10, 36); g.translate(0, 1.3, 0); put(g, sd + 2, u, top - 3.4, facing(ring(sd + 2), 1), 0x9c8a58, 1.4); }   // the ring
      { const g = new THREE.BoxGeometry(0.03, 1.6, 2.4); g.translate(0, 0.8, 0); put(g, sd + 12, u, top - 2.6, yaw, 0xaeb4ba, 1.3); }   // the sheet
      for (const o of pls) for (const dd of [-12, 2, 12]) { const s = toEdge(o, o.m); boxAt(0.14, 1.0, 0.14, sd + dd, o.m - s * o.w * 0.25, platY, 0, 0x4a4a48, 0, 0, 0, 1.1); boxAt(0.06, 0.06, 0.6, sd + dd, o.m - s * o.w * 0.25, platY + 1.0, facing(ring(sd + dd), -s), 0x8a6a2a, 0, 0, 0.25, 1.3); }
    }
  } else {
    // ── in the open: a canopy over each platform, its posts and lamps, a railing at a back, name signs ──
    const cy = platY + 3.3;
    for (const o of pls) {
      const [c0, c1] = canopy === 'all' ? [o.d0 + 3, o.d1 - 3] : canopy === 'shelter' ? [sd - 4, sd + 4] : [Math.max(o.d0, sd - Math.min(35, o.len * 0.25)), Math.min(o.d1, sd + Math.min(35, o.len * 0.25))];
      const a = o.eL ? o.u0 + 0.6 : o.u0 - 0.1, b = o.eH ? o.u1 - 0.6 : o.u1 + 0.1;
      strip(c0, c1, () => [a, cy, b, cy + 0.35], mat({ color: 0x55606a }));
      strip(c0, c1, () => [a, cy - 0.02, b, cy + 0.33], mat({ color: 0x8a9298, glow: true }));   // (its underside, lit by the lamps and the light off the platform)
      const pu = o.eL && o.eH ? o.m : o.eL ? o.u0 + o.w * 0.62 : o.u1 - o.w * 0.62;
      for (let d = c0 + 1; d <= c1 - 1; d += 9) { const yaw = along(ring(d)); boxAt(0.2, cy - platY, 0.2, d, pu, platY, yaw, 0x4a565e); for (const e of edges(o)) boxAt(0.25, 0.08, 2.2, d, e[0] + e[1] * Math.min(2, o.w * 0.3), cy - 0.1, yaw, 0xfff6e0, 0, 0, 0, 1.6); }
      for (const [e, sb] of [[!o.eL && o.u0, 1], [!o.eH && o.u1, -1]]) if (e !== false) {   // the railing along a back
        for (let d = o.d0 + 1; d <= o.d1 - 1; d += 2.5) boxAt(0.05, 1.1, 0.05, d, e + sb * 0.12, platY, along(ring(d)), 0x3d454a);
        strip(o.d0, o.d1, () => [e + sb * 0.12, platY + 1.08, e + sb * 0.12, platY + 1.14], mat({ color: 0x3d454a }));
      }
      const nameM = mat({ map: nameTex(name, band) });
      for (let d = o.d0 + 10; d <= o.d1 - 8; d += 28) {
        const nu = o.eL && o.eH ? o.m : o.eL ? o.u1 - 0.6 : o.u0 + 0.6;
        for (const s of o.eL && o.eH ? [-1, 1] : [o.eL ? 1 : -1]) panel(d, nu + s * 0.03, platY + 2.3, 2.6, 0.42, nameM, s);
        for (const lz of [-1.1, 1.1]) boxAt(0.07, 2.5, 0.07, d, nu, platY, along(ring(d)), 0x3d454a, 0, 0, lz);
      }
      if (canopy !== 'shelter' && /Line|Mattapan| train$|Railway/.test(rail || '')) { const r = ring(sd + 6), led = mat({ map: ledTex(dest || name), glow: 1 }); for (const t of [0, Math.PI]) { const l = panel(sd + 6, o.m, cy - 0.75, 1.9, 0.48, led, null); l.rotation.y = along(r) + t; } }
    }
  }
  // ── benches and bins: along a side platform's back, down an island's middle; facing the track ──
  for (const o of pls) for (let d = o.d0 + 7; d <= o.d1 - 5; d += 13) {
    const r = ring(d), u = o.eL && o.eH ? o.m : o.eL ? o.u1 - 0.75 : o.u0 + 0.75, s = toEdge(o, u), yaw = facing(r, -s);
    if (o.w < 3.2) continue;
    boxAt(1.9, 0.06, 0.42, d, u, platY + 0.44, yaw, 0x6b4a2a, 0, 0, 0, 1.1); boxAt(1.9, 0.45, 0.05, d, u, platY + 0.5, yaw, 0x6b4a2a, 0, 0, -0.22, 1.1);
    for (const lx of [-0.8, 0.8]) boxAt(0.06, 0.44, 0.4, d, u, platY, yaw, 0x3a3a3a, lx);
    cylAt(0.28, 0.95, d + 4, u, platY, 0, 0x1f3a2c);
    cylAt(0.3, 0.05, d + 4, u, platY + 0.95, 0, 0x3a3a3a);
  }
  // ── people waiting ──
  for (const o of pls) {
    const n = Math.round(o.len / (under ? 4.5 : 9) * (o.w / 5.5) * (0.6 + Math.random() * 0.6));
    for (let i = 0; i < n; i++) {
      const d = o.d0 + 3 + Math.random() * (o.len - 6), u = o.u0 + 1.0 + Math.random() * Math.max(0.2, o.w - 2.0), r = ring(d);
      if (under && stairAt(d, u)) continue;   // (not on the stairs)
      if (camU != null && Math.abs(u - camU) < 0.8) continue;   // (nor where the camera stands)
      const yaw = Math.random() < 0.75 ? facing(r, -toEdge(o, u)) + (Math.random() - 0.5) * 1.2 : along(r) + (Math.random() < 0.5 ? 0 : Math.PI);
      person(d, u, platY, yaw);
    }
  }
  function stairAt(d, u) { const sp = pls.reduce((a, b) => b.w > a.w ? b : a); if (sp.w < 4.6) return false; const sdd = Math.max(sp.d0 + 4, Math.min(sp.d1 - 14, sd + sp.len * 0.2)); return d > sdd - 1.5 && d < sdd + 10 && Math.abs(u - sp.m) < 1.8; }
  function person(d, u, y, yaw) {   // (v1155: personParts, above; underground, their light and shade baked into their colours)
    for (const [g, hex] of personParts()) put(g, d, u, y, yaw, hex, 1, under);
  }
  // a bronze hand, 3 m tall, fingers up, its palm toward yaw
  function hand(d, u, y, yaw) {
    const B = 0x7a5a2e, k = 1.5;
    boxAt(1.0, 1.2, 0.3, d, u, y, yaw, B, 0, 0, 0, k);   // the palm
    boxAt(0.55, 0.7, 0.32, d, u, y - 0.65, yaw, B, 0, 0, 0, k);   // the wrist
    [[-0.36, 0.95], [-0.12, 1.1], [0.12, 1.05], [0.36, 0.85]].forEach(([lx, L]) => cylAt(0.11, L, d, u, y + 1.2, yaw, B, lx, 0, 0, 8, k));
    { const g = new THREE.CylinderGeometry(0.12, 0.12, 0.8, 8); g.translate(0, 0.4, 0); g.rotateZ(-0.9); g.translate(0.5, 0.35, 0); put(g, d, u, y, yaw, B, k); }   // the thumb
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
  if (/ train$|^Staten Island Railway$|^PATH$/.test(rail || '')) return { platY: 1.1, len: Math.max(160, trainLen + 15), canopy: 'all' };   // (v1154: New York's subway; PATH's, v1160)
  if (rail === 'LIRR' || rail === 'Metro-North') return { platY: 1.15, len: Math.max(260, trainLen + 20), canopy: 'middle' };   // (Metro-North's high platforms too: v1163)   // (v1160: the LIRR's high platforms, all of them)
  if (/Line/.test(rail || '')) return { platY: 1.05, len: Math.max(125, trainLen + 15), canopy: 'all' };
  return { platY: CR_HIGH.test(name || '') ? 1.1 : 0.25, len: Math.max(170, trainLen + 40), canopy: 'middle' };
}
