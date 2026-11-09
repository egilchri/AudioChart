// Amtrak's Capitol Corridor and San Joaquins trains (v1122, requested: "recursively improve the look of an Amtrak
// train"): a Siemens Charger SC-44 in Caltrans' blue, white and gold, pulling or pushing California Car bilevels with
// a cab car at the far end, modelled from Wikimedia Commons photos (Charger 2123 with a Capitol Corridor train; CDTX
// 2108 at San Jose Diridon; train 528 at Berkeley, January 2026: cab car 8301 and the cars' sides).
// The liveries' curves (the Charger's gold crescent, the cars' orange diagonals at their doors) are painted on canvas
// and laid on plain bodies: a few textures, not hundreds of boxes.
// makeCapitol({ cars, locoFront }) → { group, length, cab }: her front to −z, centred, y = 0 at the rail; cab: the
// driver's eye at her leading end, in metres. Each material's boxes are merged into one mesh.
import * as THREE from 'three';

const C = { navy: 0x1f2f86, silver: 0xc9cdd2, white: 0xeef0f2, skirt: 0x2b2e33, steel: 0xbfc4c9, roof: 0xb5babf, dark: 0x1a1d21,
  under: 0x303438, bogie: 0x24272a, glass: 0x182028, lamp: 0xfff4d8, tail: 0xc4161c, gold: 0xe6b422 };

// ── painted sides ──
const TEX = {};
function canvasTex(key, w, h, draw) {
  if (TEX[key]) return TEX[key];
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h; draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return (TEX[key] = t);
}
const css = n => '#' + n.toString(16).padStart(6, '0');
// fine horizontal flutes on stainless, between y0 and y1 (px)
function flutes(c, x0, x1, y0, y1, gap) {
  c.fillStyle = '#c3c8cd'; c.fillRect(x0, y0, x1 - x0, y1 - y0);
  for (let y = y0 + gap / 2; y < y1; y += gap) { c.fillStyle = 'rgba(255,255,255,0.35)'; c.fillRect(x0, y, x1 - x0, 1.5); c.fillStyle = 'rgba(60,66,72,0.35)'; c.fillRect(x0, y + 2, x1 - x0, 1.5); }
}
function rrect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }

// The Charger's side, nose at the left (noseLeft) or the right: LS m long, from the rail-side skirt (y0) to the eave.
const LS = 19.0, LY0 = 0.85, LY1 = 3.95, LPX = 54;   // (px a metre)
function locoSide(noseLeft) {
  return canvasTex('loco' + noseLeft, Math.round(LS * LPX), Math.round((LY1 - LY0) * LPX), (c, w, h) => {
    const X = m => noseLeft ? m * LPX : w - m * LPX, Y = m => h - (m - LY0) * LPX;   // (m from her nose; m above the rail)
    c.fillStyle = css(C.silver); c.fillRect(0, 0, w, h);
    // the blue cab end and its gold crescent: the boundary from high up behind the cab door, down and sweeping back
    const crescent = (off) => { c.beginPath(); c.moveTo(X(4.9 + off), Y(LY1)); c.bezierCurveTo(X(4.2 + off), Y(3.0), X(4.6 + off), Y(1.9), X(7.4 + off), Y(1.62)); };
    c.fillStyle = css(C.navy); c.beginPath(); c.moveTo(X(0), Y(LY1)); c.lineTo(X(4.9), Y(LY1)); c.bezierCurveTo(X(4.2), Y(3.0), X(4.6), Y(1.9), X(7.4), Y(1.62)); c.lineTo(X(0), Y(1.62)); c.closePath(); c.fill();
    c.strokeStyle = css(C.gold); c.lineWidth = 0.22 * LPX; crescent(0.12); c.stroke();
    // her far end's blue swoosh, a gold line on it
    c.fillStyle = css(C.navy); c.beginPath(); c.moveTo(X(LS), Y(3.3)); c.bezierCurveTo(X(LS - 1.2), Y(3.0), X(LS - 1.6), Y(2.2), X(LS - 2.6), Y(1.62)); c.lineTo(X(LS), Y(1.62)); c.closePath(); c.fill();
    c.strokeStyle = css(C.gold); c.lineWidth = 0.1 * LPX; c.beginPath(); c.moveTo(X(LS), Y(3.05)); c.bezierCurveTo(X(LS - 1.3), Y(2.7), X(LS - 1.7), Y(2.0), X(LS - 2.4), Y(1.66)); c.stroke();
    // the white line and the dark skirt under it
    c.fillStyle = css(C.white); c.fillRect(0, Y(1.66), w, 0.08 * LPX);
    c.fillStyle = css(C.skirt); c.fillRect(0, Y(1.58), w, Y(LY0) - Y(1.58));
    // the cab: its side window, the door behind it with its small window and grab rails
    c.fillStyle = css(C.glass); rrect(c, Math.min(X(0.5), X(1.3)), Y(3.45), 0.8 * LPX, 0.75 * LPX, 6); c.fill();
    c.strokeStyle = 'rgba(10,15,40,0.8)'; c.lineWidth = 2; c.strokeRect(Math.min(X(1.9), X(2.75)), Y(3.6), 0.85 * LPX, 1.95 * LPX);
    c.fillStyle = css(C.glass); rrect(c, Math.min(X(2.1), X(2.55)), Y(3.45), 0.45 * LPX, 0.6 * LPX, 5); c.fill();
    c.fillStyle = '#e8e8ec'; c.font = `bold ${Math.round(0.36 * LPX)}px Helvetica, Arial, sans-serif`; c.textAlign = 'center'; c.fillText('CDTX', X(1.0), Y(2.45));
    // the engine room: a tall louvred panel, a square one, the X-braced panel near her end, the Caltrans name
    const louvre = (m0, m1, y0, y1) => { const a = Math.min(X(m0), X(m1)), b = Math.abs(X(m1) - X(m0)); c.fillStyle = '#3a3f46'; c.fillRect(a, Y(y1), b, Y(y0) - Y(y1)); c.fillStyle = 'rgba(200,205,210,0.35)'; for (let y = Y(y1) + 3; y < Y(y0); y += 6) c.fillRect(a + 2, y, b - 4, 2); };
    louvre(7.9, 8.9, 2.0, 3.3); louvre(10.0, 10.5, 2.7, 3.3);
    c.fillStyle = css(C.navy); c.font = `italic bold ${Math.round(0.5 * LPX)}px Helvetica, Arial, sans-serif`; c.fillText('Caltrans', X(12.3), Y(2.55));
    { const a = Math.min(X(15.4), X(16.7)), b = 1.3 * LPX; c.fillStyle = '#5a5f66'; c.fillRect(a, Y(3.3), b, 1.6 * LPX); c.strokeStyle = '#2a2e33'; c.lineWidth = 5; c.beginPath(); c.moveTo(a, Y(3.3)); c.lineTo(a + b, Y(1.7)); c.moveTo(a + b, Y(3.3)); c.lineTo(a, Y(1.7)); c.stroke(); }
    c.strokeStyle = 'rgba(40,45,50,0.5)'; c.lineWidth = 1.5; for (const m of [6.9, 13.9, 14.9]) { c.beginPath(); c.moveTo(X(m), Y(LY1)); c.lineTo(X(m), Y(1.7)); c.stroke(); }   // (her panels' seams)
    // the roofline's row of small dark vents
    c.fillStyle = '#4a4f56'; for (let m = 5.5; m < LS - 1; m += 0.42) c.fillRect(Math.min(X(m), X(m + 0.26)), Y(LY1) + 2, 0.26 * LPX, 0.1 * LPX);
  });
}

// A California Car's side (bilevel), symmetric bar her number: lower and upper windows, the navy band with its orange
// stripe and the orange diagonals either side of her middle doors, fluted stainless between
const CL = 25.9, CY0 = 0.7, CY1 = 4.45, CPX = 64;
function carSide(cab) {
  return canvasTex('car' + cab, Math.round(CL * CPX), Math.round((CY1 - CY0) * CPX), (c, w, h) => {
    const X = m => m * CPX, Y = m => h - (m - CY0) * CPX, mid = CL / 2;
    flutes(c, 0, w, 0, h, 9);
    c.fillStyle = '#c7ccd1'; c.fillRect(0, Y(CY1), w, Y(4.05) - Y(CY1));   // (smooth above the upper windows)
    c.fillStyle = css(C.dark); c.fillRect(X(0.9), Y(4.05), X(CL - 1.8), Y(3.3) - Y(4.05));   // the upper windows' black band
    c.fillStyle = css(C.navy); c.fillRect(0, Y(2.42), w, Y(1.48) - Y(2.42));   // the navy band
    c.fillStyle = '#e8892a'; c.fillRect(0, Y(2.56), w, Y(2.42) - Y(2.56));     // its orange stripe
    // the orange diagonals either side of the doors
    c.fillStyle = '#ec7a3c';
    c.beginPath(); c.moveTo(X(mid - 0.95), Y(2.42)); c.lineTo(X(mid - 0.95), Y(1.48)); c.lineTo(X(mid - 2.4), Y(1.48)); c.closePath(); c.fill();
    c.beginPath(); c.moveTo(X(mid + 0.95), Y(2.42)); c.lineTo(X(mid + 0.95), Y(1.48)); c.lineTo(X(mid + 2.2), Y(2.42)); c.closePath(); c.fill();
    // windows: upper, the length of her; lower, either side of the doors (fewer at the ends: stairs, equipment)
    const win = (m, y0, y1, ww) => { c.fillStyle = '#9aa1a8'; rrect(c, X(m) - 3, Y(y1) - 3, ww * CPX + 6, (y1 - y0) * CPX + 6, 9); c.fill(); c.fillStyle = css(C.glass); rrect(c, X(m), Y(y1), ww * CPX, (y1 - y0) * CPX, 8); c.fill(); };
    for (let m = 1.3; m < CL - 2.2; m += 2.05) win(m, 3.4, 3.95, 1.6);
    for (const m of [3.2, 5.25, 7.3, 9.35]) win(m, 1.62, 2.28, 1.6);
    for (const m of [mid + 1.4, mid + 3.45, mid + 5.5, mid + 7.55]) win(m, 1.62, 2.28, 1.6);
    // the doors: a stainless pair, their windows
    c.fillStyle = '#b9bec3'; c.fillRect(X(mid - 0.92), Y(2.5), 1.84 * CPX, Y(CY0 + 0.05) - Y(2.5)); c.strokeStyle = '#7c838a'; c.lineWidth = 3; c.strokeRect(X(mid - 0.92), Y(2.5), 1.84 * CPX, Y(CY0 + 0.05) - Y(2.5));
    c.beginPath(); c.moveTo(X(mid), Y(2.5)); c.lineTo(X(mid), Y(CY0 + 0.05)); c.stroke();
    for (const s of [-1, 1]) { c.fillStyle = css(C.glass); rrect(c, X(mid + s * 0.46) - 0.2 * CPX, Y(2.3), 0.4 * CPX, 0.75 * CPX, 6); c.fill(); }
    // the louvred equipment panel low at one end
    c.fillStyle = '#41556e'; c.fillRect(X(0.5), Y(2.38), 1.6 * CPX, 0.85 * CPX); c.fillStyle = 'rgba(15,20,30,0.6)'; for (let y = Y(2.38) + 4; y < Y(1.53); y += 7) c.fillRect(X(0.55), y, 1.5 * CPX, 3);
    if (cab) { c.fillStyle = css(C.glass); rrect(c, X(0.4), Y(3.95), 0.9 * CPX, 0.55 * CPX, 8); c.fill(); }   // (the cab car's cab window, upstairs at her end)
    c.fillStyle = '#5ec8d8'; c.font = `bold ${Math.round(0.28 * CPX)}px Helvetica, Arial, sans-serif`; c.fillText('C+T', X(mid + 1.5), Y(2.75));
    c.fillStyle = '#20242a'; c.font = `${Math.round(0.2 * CPX)}px Georgia, serif`; c.fillText('California Department of Transportation', X(mid + 2.2), Y(2.75));
  });
}
// The cab car's end: stainless, the door in its black frame between two windows, number boards, the chevrons
function cabEnd() {
  const EW = 3.2, PX = 96;
  return canvasTex('cabend', Math.round(EW * PX), Math.round((CY1 - CY0) * PX), (c, w, h) => {
    const X = m => (m + EW / 2) * PX, Y = m => h - (m - CY0) * PX;
    c.fillStyle = '#c0c5ca'; c.fillRect(0, 0, w, h);
    c.fillStyle = css(C.dark); c.fillRect(X(-0.55), Y(4.25), 1.1 * PX, Y(2.25) - Y(4.25)); c.fillStyle = '#b4b9be'; c.fillRect(X(-0.45), Y(4.15), 0.9 * PX, Y(2.3) - Y(4.15));
    c.fillStyle = css(C.glass); rrect(c, X(-0.3), Y(4.1), 0.6 * PX, 0.55 * PX, 10); c.fill();
    for (const s of [-1, 1]) { c.fillStyle = css(C.glass); rrect(c, X(s * 1.0) - 0.4 * PX, Y(3.8), 0.8 * PX, 0.55 * PX, 10); c.fill(); }
    // the chevrons: yellow and black, either side and on the door
    const chev = (x0, x1, y0, y1) => { c.save(); c.beginPath(); c.rect(X(x0), Y(y1), (x1 - x0) * PX, (y1 - y0) * PX); c.clip(); c.fillStyle = '#f2c230'; c.fillRect(X(x0), Y(y1), (x1 - x0) * PX, (y1 - y0) * PX); c.strokeStyle = '#111'; c.lineWidth = 0.09 * PX; for (let k = -6; k < 10; k++) { c.beginPath(); c.moveTo(X(x0) + k * 0.2 * PX, Y(y1)); c.lineTo(X(x0) + k * 0.2 * PX + (y1 - y0) * PX * 0.8, Y(y0)); c.stroke(); } c.restore(); };
    chev(-1.35, -0.75, 2.5, 3.0); chev(0.75, 1.35, 2.5, 3.0); chev(-0.4, 0.4, 2.35, 2.95);
    c.fillStyle = css(C.dark); c.fillRect(0, Y(1.75), w, Y(CY0) - Y(1.75));   // (the dark gear low down)
  });
}

// the Caltrans badge: a white C round a white cross-T, on clear
function logoTex() {
  return canvasTex('logo', 128, 104, c => {
    c.strokeStyle = '#f4f6f8'; c.lineWidth = 16; c.beginPath(); c.arc(46, 52, 32, Math.PI * 0.3, Math.PI * 1.7); c.stroke();
    c.fillStyle = '#f4f6f8'; c.fillRect(62, 22, 56, 16); c.fillRect(82, 22, 16, 64); c.fillRect(66, 52, 48, 14);
  });
}
export function makeCapitol({ cars = 4, locoFront = true, glow = 0.42 } = {}) {
  const L = (col, e = glow, extra = {}) => new THREE.MeshLambertMaterial({ color: col, emissive: col, emissiveIntensity: e, ...extra });
  const mats = { navy: L(C.navy, 0.25), white: L(C.white, 0.35), silver: L(C.silver, 0.38), steel: L(C.steel, 0.38), roof: L(C.roof, 0.35), skirt: L(C.skirt, 0), dark: L(C.dark, 0),
    under: L(C.under, 0), bogie: L(C.bogie, 0), glass: L(C.glass, 0.05), navyS: L(C.navy, 0.25, { side: THREE.DoubleSide }), whiteS: L(C.white, 0.35, { side: THREE.DoubleSide }),
    lamp: new THREE.MeshBasicMaterial({ color: C.lamp }), tail: new THREE.MeshBasicMaterial({ color: C.tail }) };
  const tmat = t => new THREE.MeshLambertMaterial({ map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: glow });
  const parts = Object.fromEntries(Object.keys(mats).map(k => [k, []])), decals = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s1 = new THREE.Vector3(1, 1, 1);
  const put = (mat, g, x, y, z, rx = 0, ry = 0, rz = 0) => { g.applyMatrix4(m4.compose(new THREE.Vector3(x, y, z), q.setFromEuler(e.set(rx, ry, rz)), s1)); parts[mat].push(g); };
  const box = (mat, w, h, l, x, y, z) => put(mat, new THREE.BoxGeometry(w, h, l), x, y, z);
  const decal = (tex, w, h, x, y, z, ry) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), tmat(tex)); m.position.set(x, y, z); m.rotation.y = ry; decals.push(m); };
  const roofOf = (W, eave, top, R) => { const s = new THREE.Shape(); s.moveTo(-W / 2, eave); s.lineTo(-W / 2, top - R); s.quadraticCurveTo(-W / 2, top, -W / 2 + R, top); s.lineTo(W / 2 - R, top); s.quadraticCurveTo(W / 2, top, W / 2, top - R); s.lineTo(W / 2, eave); s.lineTo(-W / 2, eave); return s; };
  const bogies = (z0, len, fr) => { for (const f of fr) { box('bogie', 2.3, 0.7, 2.9, 0, 0.55, z0 + f * len); for (const sx of [-1, 1]) for (const dz of [-1, 1]) put('bogie', new THREE.CylinderGeometry(0.46, 0.46, 0.12, 14), sx * 0.8, 0.46, z0 + f * len + dz * 1.15, 0, 0, Math.PI / 2); } };

  const LL = 21.6, NOSE = 2.6, GAP = 0.8, WL = 3.05, WC = 3.2;
  const length = LL + cars * (CL + GAP);
  // her units from the front (−z): the Charger leading (her nose forward) or the cab car leading (the Charger at the back, her nose aft)
  const units = locoFront ? ['loco', ...Array.from({ length: cars }, (_, i) => i === cars - 1 ? 'cab' : 'car')] : ['cab', ...Array.from({ length: cars - 1 }, () => 'car'), 'loco'];
  let z = -length / 2;
  for (const [i, u] of units.entries()) {
    if (u === 'loco') {
      const nf = locoFront ? -1 : 1, zn = nf < 0 ? z : z + LL, zb = zn - nf * NOSE, zr = nf < 0 ? z + LL : z;   // her nose tip, the nose's base, her back
      const zc = (zb + zr) / 2, BL = Math.abs(zr - zb);
      box('silver', WL, LY1 - LY0, BL, 0, (LY0 + LY1) / 2, zc);
      put('roof', new THREE.ExtrudeGeometry(roofOf(WL, LY1 - 0.01, 4.27, 0.5), { depth: BL, bevelEnabled: false, curveSegments: 5 }), 0, 0, Math.min(zb, zr));
      for (const sx of [-1, 1]) decal(locoSide(sx < 0 ? nf < 0 : nf > 0), BL, LY1 - LY0, sx * (WL / 2 + 0.01), (LY0 + LY1) / 2, zc, sx < 0 ? -Math.PI / 2 : Math.PI / 2);
      // the nose, in profile (x back from the tip, y up): the pilot, the black lower face, the blue face raked back to
      // the windscreen, the windscreen, the white visor arching over it to the roof
      const PRO = [[0, 0.35], [0, 1.25], [0.12, 1.62], [0.4, 2.55], [0.62, 2.75], [1.25, 3.72], [1.9, 4.12], [NOSE, 4.27], [NOSE, 0.35]];
      const sh = new THREE.Shape(PRO.map(([a, b]) => new THREE.Vector2(NOSE - a, b)));
      const nose = new THREE.ExtrudeGeometry(sh, { depth: WL, bevelEnabled: false }); nose.translate(0, 0, -WL / 2);
      put('navy', nose, 0, 0, zb, 0, nf < 0 ? Math.PI / 2 : -Math.PI / 2);
      const onSlope = (mat, w, x0, y0, x1, y1, proud = 0.02, xs = 0) => { const a = Math.atan2(x1 - x0, y1 - y0); put(mat, new THREE.BoxGeometry(w, Math.hypot(x1 - x0, y1 - y0), 0.04), xs, (y0 + y1) / 2, zn - nf * ((x0 + x1) / 2 - proud), -nf * a); };
      onSlope('skirt', WL - 0.02, 0, 0.35, 0, 1.25, 0.02);
      // the windscreen, nearly her width (two panes, a slim pillar between), in a dark frame; the white of the visor
      // coming down its sides to its foot
      onSlope('dark', 2.6, 0.62, 2.75, 1.25, 3.72, 0.03);
      onSlope('glass', 2.42, 0.66, 2.82, 1.21, 3.66, 0.045);
      onSlope('dark', 0.07, 0.66, 2.82, 1.21, 3.66, 0.05);
      for (const s of [-1, 1]) onSlope('white', 0.2, 0.6, 2.72, 1.25, 3.72, 0.04, s * 1.42);
      onSlope('white', WL - 0.02, 1.25, 3.72, 1.9, 4.12, 0.02); onSlope('white', WL - 0.02, 1.9, 4.12, NOSE, 4.27, 0.02);   // the visor's top
      onSlope('dark', 1.05, 0.3, 2.22, 0.38, 2.5, 0.03);                          // the destination sign, a slim dark panel under the windscreen
      { const m = tmat(logoTex()); m.transparent = true; m.alphaTest = 0.4; const lg = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.5), m); const a = Math.atan2(0.28, 0.93); lg.position.set(-nf * 0.74, 1.86, zn - nf * 0.16); lg.rotation.set(a, nf < 0 ? Math.PI : 0, 0, 'YXZ'); decals.push(lg); }   // (the Caltrans C+T, low on her face)
      for (const s of [-1, 1]) {   // the headlights high either side, the lamp clusters low; the coupler and pilot
        put('lamp', new THREE.CylinderGeometry(0.11, 0.11, 0.06, 16), s * 1.08, 2.28, zn - nf * 0.3, Math.PI / 2 - nf * 0.3);
        put('tail', new THREE.CylinderGeometry(0.08, 0.08, 0.06, 14), s * 1.08, 2.02, zn - nf * 0.22, Math.PI / 2 - nf * 0.3);
        put('lamp', new THREE.CylinderGeometry(0.09, 0.09, 0.06, 14), s * 0.85, 1.05, zn + nf * 0.03, Math.PI / 2);
      }
      box('skirt', 1.6, 0.9, 0.6, 0, 0.62, zn + nf * 0.25); box('bogie', 0.5, 0.35, 0.8, 0, 0.95, zn + nf * 0.5);
      // the nose's sides: blue, the white visor's arch over the cab windows, down to the windscreen's foot
      for (const sx of [-1, 1]) {
        const toSide = g => g.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, nf < 0 ? 1 : -1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)).premultiply(new THREE.Matrix4().makeTranslation(sx * (WL / 2 + 0.005), 0, zn)));
        const prof = PRO.slice(1, 8).map(([a, b]) => new THREE.Vector2(a, b)); prof.push(new THREE.Vector2(NOSE, LY0), new THREE.Vector2(0, LY0));
        parts.navyS.push(toSide(new THREE.ShapeGeometry(new THREE.Shape(prof))));
        const arch = [[0.62, 2.75], [1.25, 3.72], [1.9, 4.12], [NOSE, 4.27], [NOSE + 0.9, 4.2], [NOSE + 0.9, 3.85], [1.95, 3.82], [1.45, 3.4], [0.95, 2.75]];
        const ws = toSide(new THREE.ShapeGeometry(new THREE.Shape(arch.map(([a, b]) => new THREE.Vector2(a, b))))); ws.translate(sx * 0.008, 0, 0); parts.whiteS.push(ws);   // (just proud of the blue: they'd flicker)
      }
      // under her: two trucks, the fuel tank between; on her roof, the radiator's grille at her back
      bogies(Math.min(zb, zr) - (nf < 0 ? NOSE : 0), LL, [0.23, 0.77]);
      box('under', 2.4, 0.75, 6.5, 0, 0.75, (zn + zr) / 2 + nf * 0.5);
      box('dark', 2.2, 0.08, 3.0, 0, 4.3, zr - nf * 2.2);
      box('skirt', WL, 3.0, 0.04, 0, 2.4, zr + nf * 0.02);   // (her back's end, behind the gangway)
      z += LL + GAP;
    } else {
      const z0 = z, zc = z + CL / 2, cab = u === 'cab', end = locoFront ? z0 + CL : z0, ed = locoFront ? 1 : -1;   // (the cab car's cab end, outward)
      box('steel', WC, CY1 - CY0, CL, 0, (CY0 + CY1) / 2, zc);
      put('roof', new THREE.ExtrudeGeometry(roofOf(WC, CY1 - 0.01, 4.85, 0.6), { depth: CL, bevelEnabled: false, curveSegments: 5 }), 0, 0, z0);
      for (const sx of [-1, 1]) decal(carSide(cab), CL, CY1 - CY0, sx * (WC / 2 + 0.01), (CY0 + CY1) / 2, zc, sx < 0 ? -Math.PI / 2 : Math.PI / 2);
      bogies(z0, CL, [0.1, 0.9]);
      box('under', 2.6, 0.45, CL * 0.55, 0, CY0 - 0.1, zc);
      if (cab) {   // her end: the painted face, the headlights in the chevrons, the horns on the roof
        decal(cabEnd(), WC, CY1 - CY0, 0, (CY0 + CY1) / 2, end + ed * 0.012, ed > 0 ? 0 : Math.PI);
        for (const s of [-1, 0, 1]) put('lamp', new THREE.CylinderGeometry(0.1, 0.1, 0.05, 14), s * (s ? 0.82 : 0.1), s ? 2.2 : 2.62, end + ed * 0.03, Math.PI / 2);
        for (const s of [-1, 1]) put('tail', new THREE.CylinderGeometry(0.08, 0.08, 0.05, 14), s * 1.3, 3.3, end + ed * 0.03, Math.PI / 2);
        for (const s of [-2, -1, 0, 1, 2]) put('dark', new THREE.CylinderGeometry(0.09, 0.07, 0.3, 10), s * 0.18, 4.9, end - ed * 0.4);
        box('skirt', 2.4, 0.5, 0.5, 0, 0.65, end + ed * 0.2);
      }
      if (i < units.length - 1 && units[i + 1] !== 'loco') box('dark', 2.2, 3.4, GAP + 0.2, 0, 2.6, z0 + CL + GAP / 2);   // the gangway between cars
      z += CL + GAP;
    }
  }
  const group = new THREE.Group();
  for (const m of decals) group.add(m);
  for (const [k, gs] of Object.entries(parts)) {
    if (!gs.length) continue;
    const flat = gs.map(g => (g.index ? g.toNonIndexed() : g));
    const n = flat.reduce((a, g) => a + g.attributes.position.count, 0), pos = new Float32Array(n * 3);
    let o = 0; for (const g of flat) { pos.set(g.attributes.position.array, o * 3); o += g.attributes.position.count; g.dispose(); }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.computeVertexNormals();
    group.add(new THREE.Mesh(geo, mats[k]));
  }
  // her driver's eye: in the Charger's cab, or upstairs in the cab car
  const cabEye = locoFront ? [0, 3.1, -length / 2 + 1.4] : [0, 3.9, -length / 2 + 0.6];
  return { group, length, cab: cabEye };
}
