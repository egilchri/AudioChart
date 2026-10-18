// Boats for the Bird's-eye view (v870; v905 a mixed fleet, requested: "do the same [as the helm
// view's Cape Dory] for the fleet boats, with some variety in their sizes and types"). Each type is
// lofted the way the helm view's Cape Dory 25D is: overhanging bow and counter (the waterline shorter
// than the deck), white or painted topsides with cove stripe and boot-top, antifouling below the
// waterline, a cabin or wheelhouse, Dacron (or canvas) sails with seams, and a wake that comes up
// with her speed. Built along -z (bow), real metres; trimmed with trim() from weather3d.js's
// makeTrimmer (boom and jib angles, side, heel). Hull and rig geometry is built once per type and
// shared; materials are cached by colour, so a fleet of forty stays cheap.
//
//   daysailer  17 ft open-cockpit sloop with a cuddy (Herreshoff / Bullseye-like)
//   cd25       Cape Dory 25D, your own boat: transom-hung rudder, navy stripes
//   pocket     25-28 ft classic cruisers in assorted colours (the Cape Dory's cousins)
//   cruiser    34 ft modern sloop: near-plumb bow, wide transom, taller fractional rig
//   schooner   a Penobscot Bay windjammer, ~100 ft on deck: two gaff masts, bowsprit, two headsails
//   lobster    a 36 ft Maine lobster boat under power: high bow, wheelhouse forward, low working deck
//   bowdoin    the Arctic schooner Bowdoin (v919), Maine Maritime Academy's, out of Castine: 88 ft,
//              bald-headed knockabout (no topmasts, no bowsprit), the ice barrel at the foremast head
import * as THREE from 'three';

const V3 = THREE.Vector3;
const mats = new Map();
const mat = (c, extra = {}) => { const k = c + JSON.stringify(extra); if (!mats.has(k)) mats.set(k, new THREE.MeshLambertMaterial({ color: c, side: THREE.DoubleSide, ...extra })); return mats.get(k); };

// ── Sailcloth: panel seams and a leech tabling, with a little glow so sails against the light read as cloth
const clothTex = {};
function cloth(kind) {
  if (!clothTex[kind]) {
    const c = document.createElement('canvas'); c.width = 64; c.height = 256;
    const x = c.getContext('2d'), base = { dacron: '#f7f4ec', canvas: '#efe4c8', tanbark: '#a2593a', burgundy: '#7a2c2a' }[kind], dark = kind === 'tanbark' || kind === 'burgundy';
    x.fillStyle = base; x.fillRect(0, 0, 64, 256);
    x.fillStyle = dark ? 'rgba(50,15,10,0.35)' : 'rgba(120,110,90,0.3)';
    if (kind === 'dacron') for (let k = 1; k < 10; k++) x.fillRect(0, Math.round(k * 256 / 10), 64, 1);   // cross-cut panels
    else for (let k = 1; k < 9; k++) x.fillRect(Math.round(k * 64 / 9), 0, 1, 256);                         // canvas: vertical cloths
    x.fillRect(60, 0, 4, 256); x.fillRect(0, 0, 2, 256);
    const t = new THREE.CanvasTexture(c); t.anisotropy = 4;
    clothTex[kind] = new THREE.MeshLambertMaterial({ color: 0xffffff, map: t, emissive: dark ? 0x2a120e : 0x55524b, side: THREE.DoubleSide });
  }
  return clothTex[kind];
}

// a lofted sail with a belly (deepest ~40% back from the luff): luff(u), leech(u) points, belly(u) leeward unit vector
function sailGeo(luff, leech, belly, nu = 8, nv = 6) {
  const pos = [], idx = [], uv = [];
  for (let i = 0; i <= nu; i++) {
    const u = i / nu, a = luff(u), b = leech(u), w = belly(u), chord = a.distanceTo(b);
    for (let j = 0; j <= nv; j++) {
      const v = j / nv, p = a.clone().lerp(b, v).addScaledVector(w, chord * 0.11 * Math.sin(Math.PI * Math.pow(v, 0.8)));
      pos.push(p.x, p.y, p.z); uv.push(v, u);
    }
  }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { const k = i * (nv + 1) + j; idx.push(k, k + nv + 1, k + 1, k + 1, k + nv + 1, k + nv + 2); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
// a mainsail or gaff sail in its boom's frame (luff up the mast at z 0, foot along +z), twisting off aloft
function mainGeo(H, boomL, gaff = null) {
  const tw = u => -0.2 * u, belly = u => new V3(-Math.cos(tw(u)), 0, Math.sin(tw(u)) * 0.2).normalize();
  if (!gaff) return sailGeo(u => new V3(0, 0.1 + u * H, 0.05),
    u => { const r = boomL * (1 - u) * (1 + 0.15 * Math.sin(Math.PI * u)) + 0.1 * u, t = tw(u); return new V3(Math.sin(t) * r, 0.1 + u * H, 0.05 + Math.cos(t) * r); }, belly);
  // gaff: luff to the throat at H; the head along the gaff, peaked up ~35°; the leech clew → peak
  const a = 35 * Math.PI / 180, peak = new V3(0, H + gaff * Math.sin(a), 0.05 + gaff * Math.cos(a)), clew = new V3(0, 0.1, boomL);
  return sailGeo(u => new V3(0, 0.1 + u * (H - 0.1), 0.05),
    u => { const p = clew.clone().lerp(peak, u), t = tw(u) * 0.6; return new V3(Math.sin(t) * (p.z - 0.05), p.y, 0.05 + Math.cos(t) * (p.z - 0.05)); }, belly);
}
// a headsail on a stay from tack to head, its clew swung deg off the centreline (side +1: to port)
function jibGeo(tack, head, R, clewY, deg, side) {
  const a = deg * Math.PI / 180, clew = new V3(-side * Math.sin(a) * R, clewY, tack.z + Math.cos(a) * R);
  return sailGeo(u => tack.clone().lerp(head, u), u => clew.clone().lerp(head, u),
    u => { const c = clew.clone().lerp(head, u).sub(tack.clone().lerp(head, u)); return new V3(c.z, 0, -c.x).multiplyScalar(side).setY(0).normalize(); });
}

// ── Hulls ────────────────────────────────────────────────────────────────────
// u: 0 at the stem head, 1 at the transom top; v: 0 at the sheer, 1 at the waterline.
function merge(geos) {   // one geometry per material slot: positions, normals, indices concatenated
  const pos = [], nor = [], idx = []; let off = 0;
  for (const g of geos) {
    const ng = g.index ? g : g;   // all ours are indexed
    if (!ng.attributes.normal) ng.computeVertexNormals();
    pos.push(...ng.attributes.position.array); nor.push(...ng.attributes.normal.array);
    for (const i of ng.index.array) idx.push(i + off);
    off += ng.attributes.position.count;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); m.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); m.setIndex(idx);
  return m;
}
function loftGeo(nz, nx, f) {
  const pos = [], idx = [];
  for (let i = 0; i <= nz; i++) for (let j = 0; j <= nx; j++) pos.push(...f(i / nz, j / nx));
  for (let i = 0; i < nz; i++) for (let j = 0; j < nx; j++) { const a = i * (nx + 1) + j, b = a + 1, c = a + nx + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
const box = (w, h, d, x, y, z, rx = 0) => { const g = new THREE.BoxGeometry(w, h, d); if (rx) g.rotateX(rx); g.translate(x, y, z); return g; };
const cyl = (r0, r1, h, x, y, z, rx = 0, rz = 0) => { const g = new THREE.CylinderGeometry(r0, r1, h, 6); if (rx) g.rotateX(rx); if (rz) g.rotateZ(rz); g.translate(x, y, z); return g; };

function buildHull(T) {
  const { L, B, fbF, fbM, fbA, ovB, ovS, tr, maxAt = 0.55 } = T;
  const hw = u => B / 2 * (u < maxAt ? Math.sqrt(Math.max(0, 1 - Math.pow((maxAt - u) / maxAt, 2.2))) : 1 - (1 - tr) * Math.pow((u - maxAt) / (1 - maxAt), 1.8));
  const sh = u => fbM + (fbF - fbM) * Math.pow(Math.max(0, 0.6 - u) / 0.6, 1.7) + (fbA - fbM) * Math.pow(Math.max(0, u - 0.6) / 0.4, 2);
  const zD = u => -L / 2 + u * L, zW = u => -L / 2 + ovB + u * (L - ovB - ovS);
  const side = (s, u, v, out = 0) => { const f = v ** 1.6, z = zD(u) + (zW(u) - zD(u)) * f; return [s * hw(u) * (1 - 0.08 * f) * (1 + out), sh(u) * (1 - v), z]; };
  const D = Math.min(0.9, 0.09 * L);
  const under = (s, u, v) => [s * hw(u) * 0.92 * (1 - (0.55 + 0.3 * u) * v ** 1.3), -D * v, zW(u) + (u < 0.1 ? 0.6 * D * v * (1 - u / 0.1) : 0)];
  const deckY = (u, x) => sh(u) + 0.03 * B * (1 - Math.min(1, (x / (hw(u) || 1e-3)) ** 2));
  const P = { hull: [], stripe: [], boot: [], bottom: [], deck: [], cabin: [], teak: [], dark: [], spar: [] };
  const band = (d0, d1, slot) => { for (const s of [-1, 1]) P[slot].push(loftGeo(40, 1, (u, a) => side(s, u, (d0(u) + (d1(u) - d0(u)) * a) / sh(u), 0.008))); };
  for (const s of [-1, 1]) { P.hull.push(loftGeo(40, 5, (u, v) => side(s, u, v))); P.bottom.push(loftGeo(24, 3, (u, v) => under(s, u, v))); }
  P.deck.push(loftGeo(40, 10, (u, j) => { const x = (j * 2 - 1) * hw(u); return [x, deckY(u, x), zD(u)]; }));
  const trPt = (a, v, out = 0) => { const p = side(-1, 1, v), q = side(1, 1, v); return [p[0] + (q[0] - p[0]) * a, p[1], p[2] + 0.02 * B * Math.sin(Math.PI * a) + out]; };
  P.hull.push(loftGeo(6, 8, (v, a) => trPt(a, v)));
  P.bottom.push(loftGeo(3, 8, (v, a) => { const p = under(-1, 1, v), q = under(1, 1, v); return [p[0] + (q[0] - p[0]) * a, p[1], p[2]]; }));
  const bootH = 0.012 * L + 0.03;
  band(u => sh(u) - bootH, u => sh(u), 'boot');
  P.boot.push(loftGeo(1, 8, (v, a) => trPt(a, 1 - bootH * (1 - v) / sh(1), 0.01)));
  if (T.cove) band(() => 0.012 * L, () => 0.012 * L + 0.025 + 0.004 * L, 'stripe');
  // toe rail / bulwark cap along the sheer
  for (const s of [-1, 1]) {
    const pts = []; for (let i = 0; i <= 24; i++) { const u = i / 24; pts.push(new V3(s * (hw(u) - 0.02), sh(u) + 0.03, zD(u))); }
    P[T.bulwark ? 'stripe' : 'teak'].push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 30, T.bulwark ? 0.12 : 0.025 + 0.002 * L, 4));
  }
  // cabin trunk (sailboats) or deckhouse: rounded front, sides leaning in, cambered top
  if (T.cabin) {
    const { u0, u1, w, h } = T.cabin, z0 = zD(u0), z1 = zD(u1);
    const cw = z => { const t = (z - z1) / (z0 - z1); return w * Math.min(hw((z - zD(0)) / L), B / 2) * Math.pow(Math.max(0, 1 - Math.pow(t, 6)), 0.5); };
    const base = z => sh((z - zD(0)) / L) + 0.02, top = (z, x) => base(z) + h + 0.04 * B * (1 - Math.min(1, (x / (cw(z) || 1e-3)) ** 2));
    const tz = a => z1 + a * (z0 - z1);
    P.cabin.push(loftGeo(16, 8, (a, j) => { const z = tz(a), x = (j * 2 - 1) * (cw(z) - 0.03); return [x, top(z, x), z]; }));
    for (const s of [-1, 1]) {
      P.hull.push(loftGeo(16, 1, (a, v) => { const z = tz(a), c = cw(z); return [s * (c - 0.03 * v), base(z) + v * (top(z, s * (c - 0.03)) - base(z)), z]; }));
      for (let k = 0; k < (T.cabin.ports ?? 2); k++) {   // portlights
        const z = z1 + (z0 - z1) * (0.3 + 0.4 * k / Math.max(1, (T.cabin.ports ?? 2) - 1)), c = cw(z);
        P.dark.push(box(0.02, h * 0.3, Math.min(0.45, 0.04 * L), s * (c + 0.004), base(z) + h * 0.55, z));
      }
    }
    P.hull.push(loftGeo(1, 8, (v, j) => { const x = (j * 2 - 1) * cw(z1); return [x, base(z1) + v * (top(z1, x) - base(z1)), z1]; }));   // after end
  }
  // cockpit: a recessed sole between teak coamings
  if (T.cockpit) {
    const { u0, u1, w } = T.cockpit, z0 = zD(u0), z1 = zD(u1), cw = w * hw((u0 + u1) / 2), y = sh((u0 + u1) / 2);
    P.dark.push(box(cw * 2, 0.02, z1 - z0, 0, y + 0.02, (z0 + z1) / 2));
    for (const s of [-1, 1]) P.teak.push(box(0.04, 0.18, z1 - z0, s * cw, y + 0.1, (z0 + z1) / 2));
  }
  // lobster boat: wheelhouse with a raked windshield, roof overhanging aft, radar mast
  if (T.wheelhouse) {
    const { u0, u1, h } = T.wheelhouse, z0 = zD(u0), z1 = zD(u1), y0 = sh((u0 + u1) / 2), w = hw((u0 + u1) / 2) * 0.82;
    P.cabin.push(box(w * 2, h, z1 - z0, 0, y0 + h / 2, (z0 + z1) / 2));
    P.dark.push(box(w * 2 + 0.02, h * 0.35, 0.03, 0, y0 + h * 0.72, z0 - 0.01));                       // windshield
    for (const s of [-1, 1]) P.dark.push(box(0.03, h * 0.3, (z1 - z0) * 0.6, s * (w + 0.01), y0 + h * 0.72, z0 + (z1 - z0) * 0.35));
    P.deck.push(box(w * 2 + 0.25, 0.08, (z1 - z0) + 1.2, 0, y0 + h + 0.04, (z0 + z1) / 2 + 0.6));       // roof
    P.spar.push(cyl(0.05, 0.05, 1.4, 0, y0 + h + 0.75, z0 + 0.4));
    P.dark.push(box(0.9, 0.12, 0.25, 0, y0 + h + 1.35, z0 + 0.4));                                      // radar
    P.dark.push(box(0.25, 0.9, 0.25, w * 0.7, y0 + h * 0.3, z1 + 0.6));                                 // hauler davit
    for (const [x, y, z] of [[-0.55, 0, 0.8], [-0.55, 0.5, 0.8], [0.4, 0, 0.86]]) P.teak.push(box(1.0, 0.48, 0.6, x * w, sh(z) + 0.24 + y, zD(z)));   // traps stacked aft
  }
  // transom-hung "barn door" rudder and tiller (Alberg boats: the Cape Dory, the daysailer)
  if (T.rudder) {
    const top = sh(1) + 0.15, zLE = y => L / 2 - ovS + ovS * y / sh(1), sp = new THREE.Shape();
    sp.moveTo(zLE(top), top); sp.lineTo(zLE(top) + 0.1, top); sp.bezierCurveTo(zLE(0.5) + 0.2, 0.5, zLE(0.1) + 0.05 * L, 0.1, zLE(-D) + 0.06 * L, -D * 0.6);
    sp.quadraticCurveTo(zLE(-D) + 0.05 * L, -D * 1.05, zLE(-D), -D); sp.lineTo(zLE(top), top);
    const rg = new THREE.ShapeGeometry(sp, 6); rg.rotateY(-Math.PI / 2); P.hull.push(rg);
    P.teak.push(cyl(0.03, 0.035, 0.2 * L, 0, top + 0.1, L / 2 - 0.1 * L + 0.05, Math.PI / 2 + 0.12));
  }
  // bowsprit (schooner)
  if (T.sprit) P.spar.push(cyl(0.12, 0.16, T.sprit, 0, sh(0) + 0.3, -L / 2 - T.sprit / 2 + 1, Math.PI / 2 - 0.08));
  const out = {};
  for (const k in P) if (P[k].length) out[k] = merge(P[k]);
  return { geos: out, hw, sh, zD, zW, L };
}

// ── Types ────────────────────────────────────────────────────────────────────
const TYPES = {
  daysailer: { L: 5.3, B: 1.85, fbF: 0.8, fbM: 0.6, fbA: 0.66, ovB: 0.7, ovS: 0.55, tr: 0.55, cove: false, rudder: true, kn: 4.5,
    cabin: { u0: 0.18, u1: 0.4, w: 0.7, h: 0.28, ports: 1 }, cockpit: { u0: 0.42, u1: 0.88, w: 0.75 },
    rig: { mast: 0.3, H: 7.2, boom: 2.6, by: 1.3, clewY: 1.0, jibR: 1.8 },
    hulls: [0xf4f1ea, 0x1d2f4d, 0x2e4d3a, 0xe8dcc0, 0xf4f1ea], stripes: [0x1d2f4d, 0x7a1f1f], bottoms: [0x6e2a22, 0x2a3a5a], decks: [0xe4d9bf, 0xc9a77a], cloth: 'dacron' },
  cd25: { L: 7.5, B: 2.44, fbF: 1.07, fbM: 0.82, fbA: 0.93, ovB: 0.85, ovS: 0.55, tr: 0.6, cove: true, rudder: true, kn: 5,
    cabin: { u0: 0.12, u1: 0.5, w: 0.72, h: 0.46, ports: 2 }, cockpit: { u0: 0.56, u1: 0.9, w: 0.62 },
    rig: { mast: 0.3, H: 10.5, boom: 3.2, by: 2.4, clewY: 1.75, jibR: 2.6 },
    hulls: [0xf3f0e8], stripes: [0x1f3352], bottoms: [0x6e2a22], decks: [0xe4d9bf], cloth: 'dacron' },
  pocket: { L: 8.2, B: 2.6, fbF: 1.1, fbM: 0.85, fbA: 0.95, ovB: 0.9, ovS: 0.7, tr: 0.62, cove: true, rudder: false, kn: 5.2,
    cabin: { u0: 0.12, u1: 0.52, w: 0.72, h: 0.5, ports: 3 }, cockpit: { u0: 0.58, u1: 0.9, w: 0.62 },
    rig: { mast: 0.32, H: 11.5, boom: 3.4, by: 2.5, clewY: 1.8, jibR: 2.9 },
    hulls: [0xf3f0e8, 0xf3f0e8, 0x1d2f4d, 0x7a1f1f, 0x2e4d3a, 0xe9dfc3, 0x3b5f7a], stripes: [0x1f3352, 0x7a1f1f, 0x2e4d3a, 0xc9a24a], bottoms: [0x6e2a22, 0x2a3a5a, 0x222222], decks: [0xe4d9bf, 0xeeeae0], cloth: 'dacron' },
  cruiser: { L: 10.4, B: 3.45, fbF: 1.35, fbM: 1.15, fbA: 1.12, ovB: 0.35, ovS: 0.3, tr: 0.92, maxAt: 0.6, cove: true, rudder: false, kn: 6,
    cabin: { u0: 0.2, u1: 0.6, w: 0.68, h: 0.45, ports: 3 }, cockpit: { u0: 0.64, u1: 0.95, w: 0.7 },
    rig: { mast: 0.4, H: 15, boom: 4.2, by: 2.6, clewY: 1.9, jibR: 3.0, frac: 0.82 },
    hulls: [0xf6f6f4, 0xf6f6f4, 0xf6f6f4, 0x9aa3a8, 0x223a5e], stripes: [0x30353a, 0x1f3352, 0x8a8f94], bottoms: [0x222222, 0x2a3a5a], decks: [0xeceee9], cloth: 'dacron' },
  schooner: { L: 30, B: 7.2, fbF: 2.6, fbM: 1.9, fbA: 2.3, ovB: 3.2, ovS: 2.6, tr: 0.55, cove: true, bulwark: true, rudder: false, kn: 7, sprit: 8,
    cabin: { u0: 0.35, u1: 0.55, w: 0.55, h: 1.0, ports: 4 }, cockpit: { u0: 0.82, u1: 0.93, w: 0.35 },
    rig: { masts: [{ u: 0.3, H: 15, boom: 9, gaff: 6.5, top: 22 }, { u: 0.56, H: 17, boom: 12.5, gaff: 8, top: 25 }], clewY: 4.5, jibs: [[-6.5, 0.92, 8.5], [1.5, 0.8, 6.5]] },
    hulls: [0x16191d, 0xf2efe6, 0x24402f, 0x1d2f4d], stripes: [0xd8c070, 0xf2efe6, 0x8a2a20], bottoms: [0x6e2a22], decks: [0xb89268], cloth: ['canvas', 'canvas', 'tanbark'] },
  // Angelique (v905, requested as a boat of your own): Camden's gaff topsail ketch, built 1980 of
  // steel, 95 ft on deck and 130 ft overall with her bowsprit, ~24 ft beam; glossy green hull and the
  // fleet's only deep red-brown (burgundy) sails. Mainmast forward, the shorter mizzen aft, a topsail
  // over each gaff, two headsails off the bowsprit; deckhouses fore and aft, the wheel at the stern.
  angelique: { L: 29, B: 7.3, fbF: 2.7, fbM: 2.0, fbA: 2.4, ovB: 3.0, ovS: 2.4, tr: 0.5, cove: true, bulwark: true, rudder: false, kn: 7, sprit: 9,
    cabin: { u0: 0.42, u1: 0.62, w: 0.5, h: 1.1, ports: 4 }, cockpit: { u0: 0.84, u1: 0.94, w: 0.35 },
    rig: { masts: [{ u: 0.3, H: 18, boom: 11, gaff: 8, top: 27 }, { u: 0.7, H: 14, boom: 8.5, gaff: 6, top: 21, by: 2.6 }], clewY: 4.8, topsails: true, jibs: [[-7.5, 0.9, 9], [1.0, 0.78, 7]] },
    hulls: [0x1d4a33], stripes: [0xd8c070], bottoms: [0x6e2a22], decks: [0xb89268], cloth: 'burgundy' },
  // The schooner Bowdoin (v919, requested: "add the schooner Bowdoin, currently owned by Maine Maritime
  // Academy, to the fleet … give it a Crow's Nest"). Built 1921 by Hodgdon Brothers, East Boothbay, to a
  // William Hand design for MacMillan's Arctic voyages: 88 ft overall, 72 ft waterline, 21 ft beam, 10 ft
  // draft (MMA's fact sheet). A gaff schooner, "bald-headed, knockabout": no topmasts and no bowsprit, her
  // jib and forestaysail tacked down on deck forward; an ice barrel (her crow's nest) at the foremast head.
  // Colours aren't in the sources: a white hull and cream canvas sails, as a guess to correct.
  bowdoin: { L: 26.8, B: 6.4, fbF: 2.3, fbM: 1.65, fbA: 1.95, ovB: 2.6, ovS: 2.3, tr: 0.5, cove: false, bulwark: true, rudder: false, kn: 7,
    cabin: { u0: 0.4, u1: 0.57, w: 0.5, h: 0.9, ports: 3 }, cockpit: { u0: 0.84, u1: 0.93, w: 0.35 },
    rig: { masts: [{ u: 0.3, H: 15, boom: 8, gaff: 6, top: 18.5 }, { u: 0.56, H: 16.5, boom: 11.5, gaff: 7.5, top: 20 }], clewY: 4.0, jibs: [[0.4, 0.94, 7], [3.4, 0.8, 5.5]], iceBarrel: true },
    hulls: [0xf2efe6], stripes: [0x2a2a2a], bottoms: [0x6e2a22], decks: [0xc9a77a], cloth: 'canvas' },
  lobster: { L: 11, B: 3.6, fbF: 2.0, fbM: 1.15, fbA: 1.0, ovB: 0.7, ovS: 0.02, tr: 0.88, maxAt: 0.5, cove: false, rudder: false, kn: 9, power: true,
    wheelhouse: { u0: 0.28, u1: 0.48, h: 1.9 },
    hulls: [0xf4f4f0, 0xf4f4f0, 0x9cc3d6, 0x2e5d3a, 0xd9c24a, 0x9b2a24, 0x2b4a7a], stripes: [0x222222], bottoms: [0x6e2a22, 0x222222], decks: [0xd9d6cc], cloth: null },
};
const built = {};
const put = (parent, mesh, x, y, z) => { mesh.position.set(x, y, z); parent.add(mesh); return mesh; };
const pick = (a, r) => Array.isArray(a) ? a[Math.floor(r() * a.length) % a.length] : a;

// ── Wakes: foam arms (and astern, the churned streak), drawn once and shared ──
const foamTex = {};
function foam(kind) {
  if (foamTex[kind]) return foamTex[kind];
  const [w, h, spread, churn] = kind === 'bow' ? [128, 256, 0.46, false] : [256, 1024, 0.42, true];
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d'); let sd = 7; const rr = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 2600; i++) {
    const t = rr() ** 0.8, s = rr() < 0.5 ? -1 : 1, a = (1 - t) ** 1.4;
    x.fillStyle = `rgba(246,250,252,${(0.25 + 0.5 * rr()) * a})`;
    x.beginPath(); x.ellipse(w / 2 + s * (w * 0.04 + spread * w * t) + (rr() - 0.5) * (3 + 14 * t), t * h, 1 + 3 * rr() * (0.4 + t), 2 + 6 * rr(), 0, 0, 2 * Math.PI); x.fill();
    if (churn && rr() < 0.6) {
      const tc = rr() ** 1.3;
      x.fillStyle = `rgba(240,247,250,${(0.2 + 0.35 * rr()) * (1 - tc) ** 2})`;
      x.beginPath(); x.ellipse(w / 2 + (rr() - 0.5) * w * (0.08 + 0.18 * tc), tc * h, 2 + 5 * rr(), 3 + 8 * rr(), 0, 0, 2 * Math.PI); x.fill();
    }
  }
  return (foamTex[kind] = new THREE.CanvasTexture(c));
}

// The fleet's mix (v905): mostly small and mid-sized sloops, a few modern cruisers, lobster boats
// working, and the odd windjammer. Your own boat is always 'cd25'.
export const FLEET_MIX = [['daysailer', 7], ['pocket', 12], ['cruiser', 9], ['lobster', 8], ['schooner', 3]];
export function fleetType(r) {
  const tot = FLEET_MIX.reduce((a, [, n]) => a + n, 0); let k = r() * tot;
  for (const [t, n] of FLEET_MIX) if ((k -= n) < 0) return t;
  return 'pocket';
}

export function makeSailboat(type = 'pocket', seed = 0) {
  if (typeof type === 'number') { seed = type; type = 'pocket'; }   // the old makeSailboat(seed)
  const T = TYPES[type] || TYPES.pocket;
  let sd = 9973 + seed * 7919; const r = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  r(); r();
  const H = built[type] || (built[type] = buildHull(T));
  const hullC = pick(T.hulls, r), dark = hullC !== 0xf3f0e8 && hullC !== 0xf4f1ea && hullC !== 0xf6f6f4 && hullC !== 0xf4f4f0 && hullC !== 0xf2efe6 && hullC !== 0xe9dfc3 && hullC !== 0xe8dcc0;
  let stripeC = pick(T.stripes, r); if (stripeC === hullC) stripeC = 0xf2efe6;
  const C = { hull: mat(hullC), stripe: mat(dark && !T.bulwark ? 0xd8c070 : stripeC), boot: mat(T.power ? 0x222222 : stripeC), bottom: mat(pick(T.bottoms, r)),
    deck: mat(pick(T.decks, r)), cabin: mat(T.power ? 0xf4f4f0 : 0xeeeae0), teak: mat(T.power ? 0x6d6a62 : 0x93613a), dark: mat(0x23282c), spar: mat(0xc9ccd0) };
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body);   // body heels; g turns to the heading
  for (const k in H.geos) body.add(new THREE.Mesh(H.geos[k], C[k]));
  const { sh, zD, L } = H, uZ = u => zD(u);
  const sails = [], booms = [], jibs = [];
  let nest = null;
  const clothM = T.cloth ? cloth(pick(T.cloth, r)) : null;
  if (T.rig && !T.rig.masts) {   // a sloop
    const R = T.rig, MZ = uZ(R.mast), foot = sh(R.mast) + (T.cabin ? T.cabin.h : 0), top = R.H;
    put(body, new THREE.Mesh(new THREE.CylinderGeometry(0.04 + 0.004 * L, 0.05 + 0.004 * L, top - foot, 6), C.spar), 0, (top + foot) / 2, MZ);
    const bg = new THREE.Group(); bg.position.set(0, R.by, MZ); body.add(bg);
    put(bg, new THREE.Mesh(new THREE.CylinderGeometry(0.035 + 0.003 * L, 0.035 + 0.003 * L, R.boom, 5), C.spar), 0, 0, R.boom / 2).rotation.x = Math.PI / 2;
    const main = new THREE.Mesh(built[type + ':main'] || (built[type + ':main'] = mainGeo(top - 0.35 - R.by, R.boom)), clothM); bg.add(main);
    booms.push(bg); sails.push(main);
    const tack = new V3(0, sh(0) + 0.15, zD(0) + 0.1), head = tack.clone().lerp(new V3(0, top, MZ), (R.frac ?? 1) * 0.86);
    jibs.push({ m: new THREE.Mesh(jibGeo(tack, head, R.jibR, R.clewY, 20, 1), clothM), tack, head, R: R.jibR, y: R.clewY, key: '' });
    // forestay and backstay
    const wire = (a, b) => body.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(a, b), 1, 0.01 + 0.001 * L, 3), C.spar));
    wire(tack, new V3(0, top * (R.frac ?? 1), MZ)); wire(new V3(0, top, MZ), new V3(0, sh(1) + 0.1, zD(1) - 0.05));
  } else if (T.rig) {   // the schooner (and the ketch Angelique): gaff sails, topmasts, headsails off the bowsprit, topmasts, two headsails off the bowsprit
    const R = T.rig;
    for (const m of R.masts) {
      const MZ = uZ(m.u), foot = sh(m.u);
      put(body, new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, m.top - foot, 6), C.teak), 0, (m.top + foot) / 2, MZ);
      const by = m.by ?? 1.6, bg = new THREE.Group(); bg.position.set(0, foot + by, MZ); body.add(bg);   // by: boom height over the deck
      const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, m.boom, 5), C.teak); boom.rotation.x = Math.PI / 2; boom.position.z = m.boom / 2; bg.add(boom);
      const a = 35 * Math.PI / 180, gaff = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, m.gaff, 5), C.teak);
      gaff.rotation.x = Math.PI / 2 - a; gaff.position.set(0, m.H - by + Math.sin(a) * m.gaff / 2, Math.cos(a) * m.gaff / 2); bg.add(gaff);
      const sail = new THREE.Mesh(built[`${type}:g${m.u}`] || (built[`${type}:g${m.u}`] = mainGeo(m.H - by, m.boom - 0.3, m.gaff)), clothM); bg.add(sail);
      booms.push(bg); sails.push(sail);
      if (R.topsails) {   // a gaff topsail: luff up the topmast from the throat, foot along the gaff to its peak
        const thY = m.H - by, pk = new V3(0, thY + Math.sin(a) * m.gaff, 0.05 + Math.cos(a) * m.gaff), hd = new V3(0, m.top - by - foot - 0.4, 0.05);
        const ts = new THREE.Mesh(built[`${type}:t${m.u}`] || (built[`${type}:t${m.u}`] = sailGeo(u => new V3(0, thY + 0.2, 0.05).lerp(hd, u), u => pk.clone().lerp(hd, u), () => new V3(-1, 0, 0), 6, 4)), clothM);
        bg.add(ts); sails.push(ts);
      }
    }
    const foreTop = new V3(0, R.masts[0].H + 2, uZ(R.masts[0].u));   // the foremost mast: a schooner's fore, a ketch's main
    if (R.iceBarrel) {   // Bowdoin's crow's nest: an open barrel at the foremast head, hooped, a lookout's eye in it
      const m = R.masts[0], MZ = uZ(m.u);
      put(body, new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.42, 1.2, 12, 1, true), C.teak), 0, m.top + 0.4, MZ);
      put(body, new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.06, 12), C.teak), 0, m.top - 0.17, MZ);
      for (const y of [-0.45, 0, 0.45]) put(body, new THREE.Mesh(new THREE.TorusGeometry(0.47 - y * 0.06, 0.025, 4, 16), C.dark), 0, m.top + 0.4 + y, MZ).rotation.x = Math.PI / 2;
      for (const s of [-1, 1]) {   // ratlines up the fore shrouds to it
        const a = new V3(s * (H.hw(m.u) - 0.1), sh(m.u) + 0.4, MZ + 0.3), b = new V3(s * 0.25, m.top - 0.3, MZ);
        body.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(a, b), 1, 0.02, 3), C.dark));
        for (let k = 1; k < 14; k++) { const p = a.clone().lerp(b, k / 14); body.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(p, new V3(0, p.y, p.z + 0.25)), 1, 0.012, 3), C.dark)); }
      }
      nest = new THREE.Object3D(); nest.position.set(0, m.top + 1.4, MZ); body.add(nest);   // the lookout's eye, standing in the barrel
    }
    for (const [off, frac, rad] of R.jibs) {   // off: metres aft of the stem head (negative: out on the bowsprit)
      const tack = new V3(0, sh(0) + 0.6 + (off < 0 ? 0.5 : 0), zD(0) + off), head = tack.clone().lerp(foreTop, frac);
      jibs.push({ m: new THREE.Mesh(jibGeo(tack, head, rad, R.clewY, 20, 1), clothM), tack, head, R: rad, y: R.clewY, key: '' });
    }
  }
  for (const j of jibs) body.add(j.m);
  // wake on g (level: heel doesn't tip it under), scaled to her length; a powerboat's churns more
  const fanM = new THREE.MeshBasicMaterial({ map: foam('fan'), transparent: true, depthWrite: false, opacity: 0 });
  const fan = new THREE.Mesh(new THREE.PlaneGeometry(1.9 * L, 6.7 * L), fanM); fan.rotation.x = -Math.PI / 2; fan.renderOrder = 1; g.add(fan);
  const bowM = new THREE.MeshBasicMaterial({ map: foam('bow'), transparent: true, depthWrite: false, opacity: 0 });
  const bw = new THREE.Mesh(new THREE.PlaneGeometry(0.45 * L, 0.67 * L), bowM); bw.rotation.x = -Math.PI / 2; bw.position.set(0, 0.06, H.zW(0) - 0.05 * L + 0.33 * L); bw.renderOrder = 1; g.add(bw);
  const sternZ = H.zW(1) - 0.03 * L;
  const wake = k => {
    fanM.opacity = (T.power ? 0.85 : 0.7) * k; bowM.opacity = 0.8 * k;
    fan.scale.y = 0.4 + 0.6 * k; fan.position.set(0, 0.05, sternZ + 3.35 * L * fan.scale.y);
    fan.visible = bw.visible = k > 0.02;
  };
  wake(0);
  // where you'd stand or sit at her helm, in her own frame, for the Bird's-eye view to ride (v937): in a
  // lobster boat's wheelhouse, abaft the windshield; at a sailboat's tiller or wheel, aft in the cockpit
  const helm = T.wheelhouse ? [0, sh((T.wheelhouse.u0 + T.wheelhouse.u1) / 2) + 1.65, zD(T.wheelhouse.u0) + 0.8]
    : T.cockpit ? [0, sh(T.cockpit.u1) + (L > 15 ? 1.7 : 1.1), zD(T.cockpit.u1 - 0.03)] : [0, sh(0.9) + 1.6, zD(0.9)];
  return {
    group: g, type, L, kn: T.kn, power: !!T.power, nest, helm,
    wake,
    // p: a makeTrimmer() result; heelRad: the wind's full heel; up: false furls everything (calm)
    trim(p, heelRad, up) {
      if (T.power) return;
      for (const s of sails) s.visible = up;
      for (const bg of booms) bg.rotation.y = -p.side * (up ? p.boom : 0) * Math.PI / 180;
      for (const s of sails) s.scale.x = p.side < 0 ? -1 : 1;
      body.rotation.z = up ? p.side * p.heelK * heelRad * (T.L > 20 ? 0.45 : 1) : 0;   // heels to leeward (a big schooner stiffer)
      const key = `${Math.round(p.jib)},${p.side}`;
      for (const j of jibs) {
        j.m.visible = up && p.jibOn;
        if (j.m.visible && key !== j.key) { j.key = key; j.m.geometry.dispose(); j.m.geometry = jibGeo(j.tack, j.head, j.R, j.y, p.jib, p.side); }
      }
    },
  };
}
