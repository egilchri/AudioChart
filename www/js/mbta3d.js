// Boston's trains in Bird's-eye (v1140, requested: "recursively improve the look of the commuter rail ... Also all of
// the T trains"), modelled from Wikimedia Commons photos (design/pending/mbta-look/ref: HSP46 2034 leaving North
// Station, September 2025; bilevels 749 and 854 on a Franklin Line train at Walpole, March 2025).
// - The commuter rail: an MPI HSP46 in the MBTA's magenta (her nose and cab all magenta, a yellow line under her
//   windscreen and along her side, silver behind with the white T roundel), pushing or pulling Kawasaki bilevels:
//   stainless, a gold-edged magenta band that steps up round the upper deck's windows between the trucks and down at
//   the ends, the lower deck's windows under it, a cab car at the far end. The locomotive is always at the outbound end.
// - The T: the Red, Orange and Blue Lines' cars (stainless or white, a black window band, the line's colour along them,
//   two or three pairs of doors), the Green Line's articulated cars (pantograph, a green band) and Mattapan's PCC cars.
// Each → { group, length, spans, cab }: her front to −z, centred, y = 0 at the rail; spans: each car's [front, back];
// cab: the driver's eye at her leading end. Painted sides on plain bodies; each material's boxes merged into one mesh.
import * as THREE from 'three';

const TEX = {};
function canvasTex(key, w, h, draw) {
  if (TEX[key]) return TEX[key];
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h; draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return (TEX[key] = t);
}
const css = n => '#' + n.toString(16).padStart(6, '0');
function rrect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
function flutes(c, x0, x1, y0, y1, gap, base = '#c3c8cd') {
  c.fillStyle = base; c.fillRect(x0, y0, x1 - x0, y1 - y0);
  for (let y = y0 + gap / 2; y < y1; y += gap) { c.fillStyle = 'rgba(255,255,255,0.3)'; c.fillRect(x0, y, x1 - x0, 1.5); c.fillStyle = 'rgba(60,66,72,0.3)'; c.fillRect(x0, y + 2, x1 - x0, 1.5); }
}

const C = { magenta: 0xc4428e, gold: 0xe2a63a, silver: 0xc4c8cd, steel: 0xbcc1c6, roof: 0x9aa0a6, dark: 0x1b1e22, skirt: 0x2a2d31,
  under: 0x2e3135, bogie: 0x232629, glass: 0x172029, lamp: 0xfff4d8, tail: 0xc4161c, white: 0xeef0f1 };

// ── the commuter rail ──
// The HSP46's side, nose at the left or right: LS m, from her skirt (LY0) to the eave (LY1)
const LS = 18.4, LY0 = 0.95, LY1 = 4.05, LPX = 54;
function hspSide(noseLeft) {
  return canvasTex('hsp' + noseLeft, Math.round(LS * LPX), Math.round((LY1 - LY0) * LPX), (c, w, h) => {
    const X = m => noseLeft ? m * LPX : w - m * LPX, Y = m => h - (m - LY0) * LPX, L = (a, b) => [Math.min(X(a), X(b)), Math.abs(X(b) - X(a))];
    c.fillStyle = css(C.silver); c.fillRect(0, 0, w, h);
    // her cab, magenta to the roof, a sweep back along her lower side under the yellow line; dark below it
    c.fillStyle = css(C.magenta); c.beginPath(); c.moveTo(X(0), Y(LY1)); c.lineTo(X(2.6), Y(LY1)); c.lineTo(X(2.6), Y(2.55)); c.lineTo(X(LS), Y(2.55)); c.lineTo(X(LS), Y(1.5)); c.lineTo(X(0), Y(1.5)); c.closePath(); c.fill();
    c.fillStyle = css(C.gold); c.fillRect(0, Y(2.62), w, 0.07 * LPX); c.fillRect(0, Y(1.56), w, 0.05 * LPX);
    c.fillStyle = css(C.skirt); c.fillRect(0, Y(1.5), w, Y(LY0) - Y(1.5));
    // the cab's side window and door
    { const [a, b] = L(0.35, 1.2); c.fillStyle = css(C.glass); rrect(c, a, Y(3.65), b, 0.6 * LPX, 5); c.fill(); }
    { const [a, b] = L(1.45, 2.3); c.strokeStyle = 'rgba(20,10,20,0.75)'; c.lineWidth = 2; c.strokeRect(a, Y(3.75), b, 2.1 * LPX); c.fillStyle = css(C.glass); rrect(c, a + 8, Y(3.6), b - 16, 0.55 * LPX, 4); c.fill(); }
    // the T roundel: a white disc, a grey T in it
    { const cx = X(4.1), cy = Y(2.95), r = 0.78 * LPX; c.fillStyle = '#f2f3f4'; c.beginPath(); c.ellipse(cx, cy, r * 0.82, r, 0, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#5e6266'; c.lineWidth = 0.06 * LPX; c.stroke(); c.fillStyle = '#5e6266'; c.fillRect(cx - r * 0.5, cy - r * 0.55, r, r * 0.22); c.fillRect(cx - r * 0.11, cy - r * 0.55, r * 0.22, r * 1.15); }
    // the engine room's doors and the louvred radiator panels at her back, her panel seams
    c.strokeStyle = 'rgba(40,45,52,0.45)'; c.lineWidth = 1.5; for (const m of [5.6, 7.4, 9.2, 11.0, 12.6]) { c.beginPath(); c.moveTo(X(m), Y(LY1)); c.lineTo(X(m), Y(2.62)); c.stroke(); }
    const louvre = (m0, m1, y0, y1) => { const [a, b] = L(m0, m1); c.fillStyle = '#4a4f57'; c.fillRect(a, Y(y1), b, Y(y0) - Y(y1)); c.fillStyle = 'rgba(210,214,220,0.35)'; for (let y = Y(y1) + 3; y < Y(y0); y += 6) c.fillRect(a, y, b, 2); };
    louvre(13.2, 15.4, 2.85, 3.9); louvre(15.7, 17.9, 2.85, 3.9); louvre(6.0, 6.9, 3.0, 3.7);
    c.fillStyle = '#f2f3f4'; c.font = `bold ${Math.round(0.34 * LPX)}px Helvetica, Arial, sans-serif`; c.textAlign = 'center'; c.fillText('2034', X(9.5), Y(2.0));
  });
}
// A Kawasaki bilevel's side: CL m, rail-side skirt (CY0) to the eave (CY1); the magenta band, gold-edged, high round
// the upper deck's windows between the trucks (UP0..UP1 m along) and down at the ends' middle-level seats
const CL = 25.9, CY0 = 0.75, CY1 = 4.4, CPX = 60, UP0 = 5.6, UP1 = 20.3;
function bilevelSide(cab, num) {
  return canvasTex('bl' + cab + num, Math.round(CL * CPX), Math.round((CY1 - CY0) * CPX), (c, w, h) => {
    const X = m => m * CPX, Y = m => h - (m - CY0) * CPX;
    flutes(c, 0, w, 0, h, 10, '#c6cacf');
    c.fillStyle = '#cdd1d5'; c.fillRect(0, Y(CY1), w, Y(3.95) - Y(CY1));
    // the band: high in the middle (2.75..3.75), low at the ends (2.2..3.15), a slope between
    const top = m => m < UP0 - 0.6 ? 3.15 : m < UP0 ? 3.15 + (m - UP0 + 0.6) / 0.6 * 0.6 : m <= UP1 ? 3.75 : m < UP1 + 0.6 ? 3.75 - (m - UP1) / 0.6 * 0.6 : 3.15;
    const bot = m => m < UP0 - 0.6 ? 2.2 : m < UP0 ? 2.2 + (m - UP0 + 0.6) / 0.6 * 0.55 : m <= UP1 ? 2.75 : m < UP1 + 0.6 ? 2.75 - (m - UP1) / 0.6 * 0.55 : 2.2;
    const ms = []; for (let m = 0; m <= CL + 0.01; m += 0.1) ms.push(m);
    const band = (dy, col) => { c.fillStyle = col; c.beginPath(); ms.forEach((m, i) => (i ? c.lineTo : c.moveTo).call(c, X(m), Y(top(m) + dy))); [...ms].reverse().forEach(m => c.lineTo(X(m), Y(bot(m) - dy))); c.closePath(); c.fill(); };
    band(0.07, css(C.gold)); band(0, css(C.magenta));
    const win = (m, y0, y1, ww) => { c.fillStyle = '#7d848c'; rrect(c, X(m) - 3, Y(y1) - 3, ww * CPX + 6, (y1 - y0) * CPX + 6, 8); c.fill(); c.fillStyle = css(C.glass); rrect(c, X(m), Y(y1), ww * CPX, (y1 - y0) * CPX, 7); c.fill(); };
    for (let m = UP0 + 0.4; m < UP1 - 1.5; m += 2.1) win(m, 2.95, 3.55, 1.75);   // the upper deck
    for (let m = UP0 + 0.4; m < UP1 - 1.5; m += 2.1) win(m, 1.45, 2.1, 1.75);    // the lower deck, under the band
    for (const m of [2.3, 21.6]) win(m, 2.35, 2.95, 1.7);                         // the ends' middle level
    // the doors at each end: a single leaf, its window, magenta round it as on the real ones
    for (const m of [0.55, CL - 1.55]) { c.fillStyle = css(C.magenta); c.fillRect(X(m) - 4, Y(3.25), 1.0 * CPX + 8, 0.95 * CPX); c.fillStyle = '#b8bdc2'; c.fillRect(X(m), Y(3.2), 1.0 * CPX, Y(CY0 + 0.05) - Y(3.2)); c.strokeStyle = '#6f767d'; c.lineWidth = 3; c.strokeRect(X(m), Y(3.2), 1.0 * CPX, Y(CY0 + 0.05) - Y(3.2)); c.fillStyle = css(C.glass); rrect(c, X(m + 0.18), Y(3.05), 0.64 * CPX, 0.7 * CPX, 5); c.fill(); }
    if (cab) win(0.3, 3.45, 3.95, 1.0);
    c.fillStyle = '#2a2d31'; c.fillRect(X(13.3), Y(3.98), 2.6 * CPX, 0.3 * CPX); c.fillStyle = '#f0a83a'; c.font = `bold ${Math.round(0.2 * CPX)}px Helvetica, Arial, sans-serif`; c.textAlign = 'center'; c.fillText('SOUTH STATION', X(14.6), Y(4.06));
    c.fillStyle = '#3a3e44'; c.font = `bold ${Math.round(0.26 * CPX)}px Helvetica, Arial, sans-serif`; c.fillText(String(num), X(19.0), Y(1.95));
    c.fillStyle = '#2a63b8'; c.fillRect(X(6.2), Y(2.62), 0.32 * CPX, 0.32 * CPX); c.fillStyle = '#fff'; c.font = `${Math.round(0.24 * CPX)}px Helvetica`; c.fillText('♿', X(6.36), Y(2.36));
  });
}
// the cab car's end: stainless, magenta round the windows, the door in the middle, the lamps
function cabEnd() {
  const EW = 3.2, PX = 96;
  return canvasTex('mbtacab', Math.round(EW * PX), Math.round((CY1 - CY0) * PX), (c, w, h) => {
    const X = m => (m + EW / 2) * PX, Y = m => h - (m - CY0) * PX;
    c.fillStyle = '#c3c7cc'; c.fillRect(0, 0, w, h);
    c.fillStyle = css(C.magenta); c.fillRect(0, Y(4.1), w, Y(2.55) - Y(4.1)); c.fillStyle = css(C.gold); c.fillRect(0, Y(2.6), w, 0.06 * PX);
    for (const s of [-1, 1]) { c.fillStyle = css(C.glass); rrect(c, X(s * 0.95) - 0.5 * PX, Y(4.0), 1.0 * PX, 0.8 * PX, 10); c.fill(); }
    c.fillStyle = '#b4b9be'; c.fillRect(X(-0.4), Y(3.9), 0.8 * PX, Y(1.0) - Y(3.9)); c.fillStyle = css(C.glass); rrect(c, X(-0.25), Y(3.75), 0.5 * PX, 0.7 * PX, 8); c.fill();
    c.fillStyle = css(C.dark); c.fillRect(0, Y(1.6), w, Y(CY0) - Y(1.6));
  });
}

// ── the T ──
// each line's car: length, height, width, its doors (pairs a side), its look
const T_LOOK = {
  'Red Line': { len: 21.3, h: 3.75, w: 3.05, doors: 3, body: '#c9cdd1', band: '#da291c', fluted: true },
  'Orange Line': { len: 19.8, h: 3.7, w: 3.05, doors: 3, body: '#c9cdd1', band: '#ed8b00', fluted: true },
  'Blue Line': { len: 14.8, h: 3.6, w: 2.85, doors: 2, body: '#eef0f1', band: '#003da5', fluted: false },
  'Green Line': { len: 22.6, h: 3.5, w: 2.65, doors: 3, body: '#eef0f1', band: '#00843d', fluted: false, lrv: true },
  'Mattapan Trolley': { len: 14.2, h: 3.2, w: 2.6, doors: 2, body: '#efe3bd', band: '#c4572a', fluted: false, lrv: true, pcc: true },
  // (v1160) the LIRR's M7s and M9s: 85 ft stainless cars, two doors a side, her blue stripe; PATH's PA5s: 51 ft, three doors,
  // PATH's sign on her ends and sides
  LIRR: { len: 25.9, h: 3.95, w: 3.15, doors: 2, body: '#c9cdd1', band: '#1d4f91', fluted: true },
  'Metro-North': { len: 25.9, h: 3.95, w: 3.15, doors: 2, body: '#c9cdd1', band: '#ee0034', fluted: true },   // (v1163: its M8s and M7As, its red)
  PATH: { len: 15.6, h: 3.65, w: 2.8, doors: 3, body: '#c6cace', band: '#0d3b70', fluted: false, nyc: 'PATH' },
};
const T_CARS = { 'Red Line': 6, 'Orange Line': 6, 'Blue Line': 6, 'Green Line': 2, 'Mattapan Trolley': 1, LIRR: 10, PATH: 7, 'Metro-North': 8 };
// (v1154) New York's subway: stainless cars (the R142s and R160s that run most lines now), her line's bullet on her
// side signs and her ends. The IRT's (1 to 7, the 42 St shuttle) 51 ft cars, three doors a side; the B Division's
// (the lettered lines, Staten Island's) 60 ft, four. Her line's colour from the MTA's own (NYC_LINES).
export const NYC_LINES = { 1: '#ee352e', 2: '#ee352e', 3: '#ee352e', 4: '#00933c', 5: '#00933c', 6: '#00933c', 7: '#b933ad',
  A: '#0039a6', C: '#0039a6', E: '#0039a6', B: '#ff6319', D: '#ff6319', F: '#ff6319', M: '#ff6319', G: '#6cbe45',
  J: '#996633', Z: '#996633', L: '#a7a9ac', N: '#fccc0a', Q: '#fccc0a', R: '#fccc0a', W: '#fccc0a', S: '#808183', SIR: '#0039a6' };
export const NYC_RAIL = /^([1-7A-Z]|SIR) train$|^Staten Island Railway$/;
export const nycLine = rail => rail === 'Staten Island Railway' ? 'SIR' : (rail || '').replace(/ train$/, '');
const NYC_CARS = { L: 8, J: 8, Z: 8, M: 8, G: 5, S: 4, SIR: 4, 7: 11 };
function nycLook(rail) {
  if (T_LOOK[rail]) return T_LOOK[rail];
  const line = nycLine(rail), irt = /^[1-7]$/.test(line) || line === 'S';
  T_CARS[rail] = NYC_CARS[line] || 10;
  return (T_LOOK[rail] = irt ? { len: 15.6, h: 3.65, w: 2.68, doors: 3, body: '#c6cace', band: NYC_LINES[line] || '#808183', fluted: false, nyc: line }
    : { len: 18.35, h: 3.7, w: 3.05, doors: 4, body: '#c6cace', band: NYC_LINES[line] || '#808183', fluted: false, nyc: line });
}
// a line's bullet: her colour's circle, her letter or number in it (black on the N, Q, R and W's yellow)
function bullet(c, x, y, r, line, col) {
  c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  c.fillStyle = col === '#fccc0a' ? '#111' : '#fff'; c.font = `bold ${Math.round(r * (line.length > 1 ? 0.95 : 1.35))}px Helvetica`; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(line === 'SIR' ? 'SIR' : line, x, y + r * 0.06);
}
function tSide(rail) {
  const T = T_LOOK[rail], PX = 60, H0 = 0.85;
  return canvasTex('t' + rail, Math.round(T.len * PX), Math.round((T.h - H0) * PX), (c, w, h) => {
    const X = m => m * PX, Y = m => h - (m - H0) * PX;
    if (T.nyc) {   // (v1154) New York's: plain stainless, her windows between the doors, her bullet on the side signs
      c.fillStyle = T.body; c.fillRect(0, 0, w, h);
      c.fillStyle = 'rgba(0,0,0,0.12)'; for (let m = 0.3; m < T.len; m += 0.9) c.fillRect(X(m), Y(1.6), 1, Y(H0) - Y(1.6));   // (her lower panels' seams)
      const dw = 1.27, doorAt = k => T.len * (k + 0.5) / T.doors - dw / 2, y0 = Y(T.h - 0.55), y1 = Y(2.0);
      for (let k = 0; k <= T.doors; k++) {   // the windows between the doors (and past the end doors), lit inside
        const a = k === 0 ? 0.35 : doorAt(k - 1) + dw + 0.25, b = k === T.doors ? T.len - 0.35 : doorAt(k) - 0.25;
        for (let m = a; m < b - 0.3; m += Math.min(1.5, b - a)) {
          const ww = Math.min(1.3, b - m - 0.1); if (ww < 0.4) continue;
          const g = c.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, 'rgba(236,232,214,0.95)'); g.addColorStop(0.3, 'rgba(150,148,138,0.6)'); g.addColorStop(1, 'rgba(30,32,34,0.9)');
          c.fillStyle = '#1d2024'; rrect(c, X(m) - 2, y0 - 2, ww * PX + 4, y1 - y0 + 4, 6); c.fill(); c.fillStyle = g; rrect(c, X(m), y0, ww * PX, y1 - y0, 5); c.fill();
        }
      }
      for (let k = 0; k < T.doors; k++) {   // her doors: two leaves, a window in each, black edges
        const m = doorAt(k); c.fillStyle = '#b8bcc0'; c.fillRect(X(m), Y(T.h - 0.3), dw * PX, Y(H0 + 0.05) - Y(T.h - 0.3));
        c.strokeStyle = '#2a2d31'; c.lineWidth = 3; c.strokeRect(X(m), Y(T.h - 0.3), dw * PX, Y(H0 + 0.05) - Y(T.h - 0.3)); c.beginPath(); c.moveTo(X(m + dw / 2), Y(T.h - 0.3)); c.lineTo(X(m + dw / 2), Y(H0 + 0.05)); c.stroke();
        for (const d of [0.12, 0.72]) { c.fillStyle = css(C.glass); rrect(c, X(m + d), Y(T.h - 0.55), 0.43 * PX, 1.05 * PX, 4); c.fill(); }
      }
      for (const m of [T.len * 0.12, T.len * 0.88]) {   // the side signs: a black panel, her bullet and an amber line of text
        c.fillStyle = '#111'; c.fillRect(X(m - 0.55), Y(T.h - 0.12), 1.1 * PX, 0.36 * PX);
        bullet(c, X(m - 0.36), Y(T.h - 0.3), 0.15 * PX, T.nyc, T.band); c.fillStyle = '#ff9e1b'; c.fillRect(X(m - 0.15), Y(T.h - 0.32), 0.6 * PX, 0.05 * PX);
      }
      return;
    }
    if (T.fluted) flutes(c, 0, w, 0, h, 9, T.body); else { c.fillStyle = T.body; c.fillRect(0, 0, w, h); }
    if (T.pcc) { c.fillStyle = T.band; c.fillRect(0, Y(1.75), w, Y(H0) - Y(1.75)); c.fillStyle = '#5a2a14'; c.fillRect(0, Y(1.8), w, 0.05 * PX); }
    // the window band: black glass the length of her between the doors, the line's colour under it
    c.fillStyle = css(C.dark); c.fillRect(X(0.4), Y(T.h - 0.45), X(T.len - 0.8), Y(1.95) - Y(T.h - 0.45));
    // (v1149, seen close in the tunnels) her lit inside through it: the ceiling's lamps along the top, the far side's windows dimmer below, grab poles
    { const y0 = Y(T.h - 0.45), y1 = Y(1.95), g = c.createLinearGradient(0, y0, 0, y1);
      g.addColorStop(0, 'rgba(240,236,218,0.95)'); g.addColorStop(0.2, 'rgba(210,206,190,0.55)'); g.addColorStop(0.55, 'rgba(130,128,118,0.3)'); g.addColorStop(1, 'rgba(40,40,40,0)');
      c.fillStyle = g; c.fillRect(X(0.4), y0, X(T.len - 0.8), y1 - y0);
      c.fillStyle = 'rgba(30,30,30,0.5)'; for (let m = 1.2; m < T.len - 0.8; m += 1.6) c.fillRect(X(m), y0, Math.max(2, 0.04 * PX), y1 - y0); }
    c.fillStyle = T.band; c.fillRect(0, Y(1.9), w, 0.32 * PX); if (!T.pcc) c.fillRect(0, Y(T.h - 0.15), w, 0.12 * PX);
    // the doors: pairs of leaves, evenly along her, each leaf with its window
    for (let k = 0; k < T.doors; k++) {
      const m = T.len * (k + 0.5) / T.doors - 0.65;
      c.fillStyle = T.fluted ? '#b9bec3' : '#dfe2e4'; c.fillRect(X(m), Y(T.h - 0.35), 1.3 * PX, Y(H0 + 0.05) - Y(T.h - 0.35));
      c.strokeStyle = '#555b61'; c.lineWidth = 2.5; c.strokeRect(X(m), Y(T.h - 0.35), 1.3 * PX, Y(H0 + 0.05) - Y(T.h - 0.35)); c.beginPath(); c.moveTo(X(m + 0.65), Y(T.h - 0.35)); c.lineTo(X(m + 0.65), Y(H0 + 0.05)); c.stroke();
      for (const d of [0.1, 0.75]) { c.fillStyle = css(C.glass); rrect(c, X(m + d), Y(T.h - 0.55), 0.45 * PX, 1.0 * PX, 4); c.fill(); }
      c.fillStyle = T.band; c.fillRect(X(m), Y(T.h - 0.35), 1.3 * PX, 0.08 * PX);
    }
    if (T.lrv && !T.pcc) { c.fillStyle = 'rgba(20,24,28,0.6)'; c.fillRect(X(T.len / 2) - 3, 0, 6, h); }   // (the articulation's bellows; not the PCC's)
  });
}
function tEnd(rail) {
  const T = T_LOOK[rail], PX = 96, H0 = 0.85;
  return canvasTex('te' + rail, Math.round(T.w * PX), Math.round((T.h - H0) * PX), (c, w, h) => {
    const X = m => (m + T.w / 2) * PX, Y = m => h - (m - H0) * PX;
    if (T.nyc) {   // (v1154) New York's: a black cab end, the storm door's window in the middle, her bullet lit beside it
      c.fillStyle = '#1a1c1f'; c.fillRect(0, 0, w, h); c.fillStyle = T.body; c.fillRect(0, Y(1.5), w, Y(H0) - Y(1.5));
      c.fillStyle = css(C.glass); rrect(c, X(-0.35), Y(T.h - 0.4), 0.7 * PX, 1.4 * PX, 8); c.fill();
      c.fillStyle = 'rgba(20,24,30,0.9)'; rrect(c, X(-T.w / 2 + 0.15), Y(T.h - 0.5), 0.9 * PX, 0.9 * PX, 8); c.fill(); rrect(c, X(T.w / 2 - 1.05), Y(T.h - 0.5), 0.9 * PX, 0.9 * PX, 8); c.fill();
      bullet(c, X(T.w / 2 - 0.6), Y(T.h - 0.95), 0.3 * PX, T.nyc, T.band);
      c.fillStyle = '#ff9e1b'; c.fillRect(X(-T.w / 2 + 0.3), Y(T.h - 0.62), 0.6 * PX, 0.07 * PX);
      return;
    }
    c.fillStyle = T.pcc ? T.body : T.fluted ? '#c3c7cc' : T.body; c.fillRect(0, 0, w, h);
    c.fillStyle = T.band; c.fillRect(0, Y(1.95), w, 0.4 * PX);
    if (T.pcc) { c.fillStyle = T.band; c.fillRect(0, Y(1.75), w, Y(H0) - Y(1.75)); }
    c.fillStyle = css(C.glass); rrect(c, X(-T.w / 2 + 0.25), Y(T.h - 0.35), (T.w - 0.5) * PX, 1.05 * PX, 12); c.fill();
    c.fillStyle = '#222'; c.fillRect(X(-0.7), Y(T.h - 0.32), 1.4 * PX, 0.28 * PX); c.fillStyle = '#ffb300'; c.font = `bold ${Math.round(0.2 * PX)}px Helvetica`; c.textAlign = 'center'; c.fillText(rail.replace(' Trolley', '').toUpperCase(), X(0), Y(T.h - 0.1));
  });
}

// ── building ──
// (v1140: with ~70 T trains live, a mesh and material for every car's every colour and painted side made thousands
// of draw calls, 3 fps. Now each train is one vertex-coloured mesh for all her plain parts (one shared material that
// glows a little in each part's own colour, as the others' emissive materials do), and one merged mesh per painted
// texture, each texture's material shared by every train)
const PAINT = {}, DECAL_MAT = new Map();
function paintMat(glow) {
  if (PAINT[glow]) return PAINT[glow];
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = sh => { sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n  totalEmissiveRadiance += vColor.rgb * ${glow.toFixed(3)};`); };
  m.customProgramCacheKey = () => 'mbtaPaint' + glow;
  return (PAINT[glow] = m);
}
const decalMat = (t, glow) => { const k = t.uuid + glow; if (!DECAL_MAT.has(k)) DECAL_MAT.set(k, new THREE.MeshLambertMaterial({ map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: glow })); return DECAL_MAT.get(k); };
function builder(glow) {
  // each part's colour, and how much more it glows than the rest (the lamps: as bright as they come)
  const COL = { magenta: [C.magenta, 1], gold: [C.gold, 1], silver: [C.silver, 1], steel: [C.steel, 1], roof: [C.roof, 0.9], dark: [C.dark, 0], skirt: [C.skirt, 0], under: [C.under, 0],
    bogie: [C.bogie, 0], glass: [C.glass, 0.1], white: [C.white, 1], lamp: [C.lamp, 2.4], tail: [C.tail, 2.4] };
  const parts = [], decals = new Map(), col = new THREE.Color();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s1 = new THREE.Vector3(1, 1, 1);
  const put = (mat, g, x, y, z, rx = 0, ry = 0, rz = 0) => {
    g.applyMatrix4(m4.compose(new THREE.Vector3(x, y, z), q.setFromEuler(e.set(rx, ry, rz)), s1));
    const flat = g.index ? g.toNonIndexed() : g; if (flat !== g) g.dispose();
    const [hex, k] = COL[mat]; col.setHex(hex); const n = flat.attributes.position.count, c = new Float32Array(n * 3);   // (setHex gives linear already: no second conversion)
    // (the shader adds glow × colour: the lamps' extra comes from brightening their colour)
    const f = k > 1 ? k : 1; for (let i = 0; i < n; i++) { c[i * 3] = col.r * f; c[i * 3 + 1] = col.g * f; c[i * 3 + 2] = col.b * f; }
    flat.setAttribute('color', new THREE.BufferAttribute(c, 3)); flat.deleteAttribute('uv'); parts.push(flat);
  };
  const box = (mat, w, h, l, x, y, z) => put(mat, new THREE.BoxGeometry(w, h, l), x, y, z);
  const decal = (tex, w, h, x, y, z, ry) => { const g = new THREE.PlaneGeometry(w, h).toNonIndexed(); g.applyMatrix4(m4.compose(new THREE.Vector3(x, y, z), q.setFromEuler(e.set(0, ry, 0)), s1)); (decals.get(tex) || decals.set(tex, []).get(tex)).push(g); };
  const roof = (mat, W, eave, top, R, z0, len) => { const s = new THREE.Shape(); s.moveTo(-W / 2, eave); s.lineTo(-W / 2, top - R); s.quadraticCurveTo(-W / 2, top, -W / 2 + R, top); s.lineTo(W / 2 - R, top); s.quadraticCurveTo(W / 2, top, W / 2, top - R); s.lineTo(W / 2, eave); s.closePath(); put(mat, new THREE.ExtrudeGeometry(s, { depth: len, bevelEnabled: false, curveSegments: 5 }), 0, 0, z0); };
  const bogies = (z0, len, fr, r = 0.46) => { for (const f of fr) { box('bogie', 2.2, 0.6, 2.6, 0, r + 0.08, z0 + f * len); for (const sx of [-1, 1]) for (const dz of [-1, 1]) put('bogie', new THREE.CylinderGeometry(r, r, 0.12, 10), sx * 0.78, r, z0 + f * len + dz * 1.05, 0, 0, Math.PI / 2); } };
  const merge = (gs, keys) => {
    const n = gs.reduce((a, g) => a + g.attributes.position.count, 0), geo = new THREE.BufferGeometry();
    for (const [k, sz] of keys) { const A = new Float32Array(n * sz); let o = 0; for (const g of gs) { A.set(g.attributes[k].array, o * sz); o += g.attributes.position.count; } geo.setAttribute(k, new THREE.BufferAttribute(A, sz)); }
    for (const g of gs) g.dispose(); return geo;
  };
  const finish = () => {
    const group = new THREE.Group();
    const geo = merge(parts, [['position', 3], ['color', 3]]); geo.computeVertexNormals(); group.add(new THREE.Mesh(geo, paintMat(glow)));
    for (const [tex, gs] of decals) group.add(new THREE.Mesh(merge(gs, [['position', 3], ['normal', 3], ['uv', 2]]), decalMat(tex, glow)));
    return group;
  };
  return { put, box, decal, roof, bogies, finish };
}

// the commuter rail: the HSP46 and `cars` bilevels, the last a cab car; locoFront: she leads (outbound)
export function makeMbtaCR({ cars = 6, locoFront = true, glow = 0.42 } = {}) {
  const B = builder(glow), { put, box, decal } = B;
  const LL = 21.3, NOSE = 1.0, GAP = 0.8, WL = 3.05, WC = 3.2;
  const units = locoFront ? ['loco', ...Array.from({ length: cars }, (_, i) => i === cars - 1 ? 'cab' : 'car')] : ['cab', ...Array.from({ length: cars - 1 }, () => 'car'), 'loco'];
  const length = units.reduce((a, u) => a + (u === 'loco' ? LL : CL), 0) + GAP * (units.length - 1), spans = [];
  let z = -length / 2;
  for (const [i, u] of units.entries()) {
    if (u === 'loco') {
      const nf = locoFront ? -1 : 1, zn = nf < 0 ? z : z + LL, zb = zn - nf * NOSE, zr = nf < 0 ? z + LL : z, zc = (zb + zr) / 2, BL = Math.abs(zr - zb);
      box('silver', WL, LY1 - LY0, BL, 0, (LY0 + LY1) / 2, zc);
      B.roof('roof', WL, LY1 - 0.01, 4.45, 0.45, Math.min(zb, zr), BL);
      for (const sx of [-1, 1]) decal(hspSide(sx < 0 ? nf < 0 : nf > 0), BL, LY1 - LY0, sx * (WL / 2 + 0.01), (LY0 + LY1) / 2, zc, sx < 0 ? -Math.PI / 2 : Math.PI / 2);
      // the cab front, in profile (back from the tip, up): the pilot, the short nose, the windscreen raked back, the roof
      const PRO = [[0, 0.3], [0, 2.55], [0.2, 2.75], [0.55, 3.75], [NOSE, 4.3], [NOSE, 0.3]];
      const sh = new THREE.Shape(PRO.map(([a, b]) => new THREE.Vector2(NOSE - a, b)));
      const nose = new THREE.ExtrudeGeometry(sh, { depth: WL, bevelEnabled: false }); nose.translate(0, 0, -WL / 2);
      put('magenta', nose, 0, 0, zb, 0, nf < 0 ? Math.PI / 2 : -Math.PI / 2);
      const onSlope = (mat, w, x0, y0, x1, y1, proud = 0.02, xs = 0) => { const a = Math.atan2(x1 - x0, y1 - y0); put(mat, new THREE.BoxGeometry(w, Math.hypot(x1 - x0, y1 - y0), 0.04), xs, (y0 + y1) / 2, zn - nf * ((x0 + x1) / 2 - proud), -nf * a); };
      for (const s of [-1, 1]) { onSlope('dark', 1.28, 0.22, 2.8, 0.52, 3.68, 0.03, s * 0.72); onSlope('glass', 1.16, 0.24, 2.86, 0.5, 3.62, 0.045, s * 0.72); }   // the two windscreens
      onSlope('gold', WL - 0.02, 0.0, 2.48, 0.0, 2.56, 0.03);   // the yellow line under them
      onSlope('dark', 0.9, 0.0, 2.0, 0.0, 2.35, 0.03, -0.75); onSlope('dark', 0.9, 0.0, 2.0, 0.0, 2.35, 0.03, 0.75);   // the number boards
      onSlope('dark', WL - 0.1, 0.0, 1.05, 0.0, 1.45, 0.03);     // the dark band low on her face, the lamps in it
      onSlope('lamp', 0.5, 0.48, 3.95, 0.55, 4.05, 0.05);        // the headlight over the windscreens
      for (const s of [-1, 1]) {
        put('lamp', new THREE.CylinderGeometry(0.13, 0.13, 0.06, 16), s * 0.6, 1.25, zn + nf * 0.04, Math.PI / 2);
        put('tail', new THREE.CylinderGeometry(0.08, 0.08, 0.06, 14), s * 1.2, 2.18, zn + nf * 0.04, Math.PI / 2);
      }
      box('skirt', WL - 0.2, 0.75, 0.5, 0, 0.6, zn + nf * 0.22); box('bogie', 0.5, 0.35, 0.8, 0, 0.95, zn + nf * 0.5);
      for (const s of [-1, 0, 1]) put('dark', new THREE.CylinderGeometry(0.1, 0.08, 0.35, 10), s * 0.2, 4.55, zb - nf * 0.3);   // the horns
      B.bogies(Math.min(zb, zr) - (nf < 0 ? NOSE : 0), LL, [0.2, 0.8]);
      box('under', 2.4, 0.75, 6.0, 0, 0.8, (zn + zr) / 2); put('under', new THREE.CylinderGeometry(0.55, 0.55, 5.0, 14), 0, 0.85, (zn + zr) / 2, Math.PI / 2);   // the fuel tank
      box('dark', 2.2, 0.08, 4.4, 0, 4.47, zr + nf * 3.0);   // the radiators' grilles on her roof at her back
      box('skirt', WL, 3.0, 0.04, 0, 2.4, zr + nf * 0.02);
      spans.push([z, z + LL]); z += LL + GAP;
    } else {
      const z0 = z, zc = z + CL / 2, cab = u === 'cab', end = locoFront ? z0 + CL : z0, ed = locoFront ? 1 : -1;
      box('steel', WC, CY1 - CY0, CL, 0, (CY0 + CY1) / 2, zc);
      B.roof('roof', WC, CY1 - 0.01, 4.87, 0.55, z0, CL);
      const num = 700 + ((i * 37) % 280);
      for (const sx of [-1, 1]) decal(bilevelSide(cab, num), CL, CY1 - CY0, sx * (WC / 2 + 0.01), (CY0 + CY1) / 2, zc, sx < 0 ? -Math.PI / 2 : Math.PI / 2);
      box('roof', 1.4, 0.25, 2.6, 0, 4.95, zc - 5); box('roof', 1.4, 0.25, 2.6, 0, 4.95, zc + 5);   // the air-conditioning units
      B.bogies(z0, CL, [0.1, 0.9]);
      box('under', 2.6, 0.4, CL * 0.5, 0, CY0 - 0.05, zc);
      if (cab) {
        decal(cabEnd(), WC, CY1 - CY0, 0, (CY0 + CY1) / 2, end + ed * 0.012, ed > 0 ? 0 : Math.PI);
        for (const s of [-1, 1]) { put('lamp', new THREE.CylinderGeometry(0.12, 0.12, 0.05, 14), s * 0.95, 2.2, end + ed * 0.03, Math.PI / 2); put('tail', new THREE.CylinderGeometry(0.08, 0.08, 0.05, 14), s * 1.35, 1.9, end + ed * 0.03, Math.PI / 2); }
        put('lamp', new THREE.CylinderGeometry(0.11, 0.11, 0.05, 14), 0, 4.55, end + ed * 0.03, Math.PI / 2);
        box('skirt', 2.4, 0.5, 0.5, 0, 0.65, end + ed * 0.2);
      }
      if (i < units.length - 1 && units[i + 1] !== 'loco') box('dark', 2.2, 3.0, GAP + 0.2, 0, 2.4, z0 + CL + GAP / 2);
      spans.push([z, z + CL]); z += CL + GAP;
    }
  }
  const cabEye = locoFront ? [0, 3.3, -length / 2 + 1.3] : [0, 3.6, -length / 2 + 0.6];
  return { group: B.finish(), length, spans, cab: cabEye };
}

// a T train: `cars` of her line's cars, cabs at both ends (a Green Line or Mattapan car is one, articulated)
export function makeTTrain(rail, { cars, glow = 0.42 } = {}) {
  if (NYC_RAIL.test(rail)) nycLook(rail);   // (v1154: New York's lines' looks, made as they're first seen)
  cars ??= T_CARS[rail] || 2;
  const T = T_LOOK[rail] || T_LOOK['Red Line'], B = builder(glow), { put, box, decal } = B, GAP = 0.6, H0 = 0.85;
  const length = cars * T.len + (cars - 1) * GAP, spans = [];
  const sideTex = tSide(rail), endTex = tEnd(rail);
  const bodyMat = T.fluted ? 'steel' : 'white';
  let z = -length / 2;
  for (let i = 0; i < cars; i++) {
    const z0 = z, zc = z + T.len / 2;
    box(bodyMat, T.w, T.h - H0, T.len, 0, (H0 + T.h) / 2, zc);
    B.roof('roof', T.w, T.h - 0.01, T.h + 0.28, 0.35, z0, T.len);
    for (const sx of [-1, 1]) decal(sideTex, T.len, T.h - H0, sx * (T.w / 2 + 0.01), (H0 + T.h) / 2, zc, sx < 0 ? -Math.PI / 2 : Math.PI / 2);
    for (const [zz, d] of [[z0, -1], [z0 + T.len, 1]]) {   // each end: her face, lamps
      decal(endTex, T.w, T.h - H0, 0, (H0 + T.h) / 2, zz + d * 0.012, d > 0 ? 0 : Math.PI);
      for (const s of [-1, 1]) { put('lamp', new THREE.CylinderGeometry(0.09, 0.09, 0.04, 12), s * (T.w / 2 - 0.35), 1.55, zz + d * 0.02, Math.PI / 2); put('tail', new THREE.CylinderGeometry(0.06, 0.06, 0.04, 12), s * (T.w / 2 - 0.2), 1.3, zz + d * 0.02, Math.PI / 2); }
    }
    if (T.lrv) {   // the pantograph (a trolley's pole on Mattapan's PCC)
      const zp = zc + (T.pcc ? 0 : -T.len * 0.18);
      if (T.pcc) { put('dark', new THREE.CylinderGeometry(0.04, 0.04, 5.5, 6), 0, T.h + 1.2, zc + 1.5, -1.15, 0, 0); }
      else { box('dark', 1.6, 0.12, 1.4, 0, T.h + 0.4, zp); put('dark', new THREE.CylinderGeometry(0.035, 0.035, 2.4, 6), 0, T.h + 1.3, zp - 0.4, 0.65, 0, 0); put('dark', new THREE.CylinderGeometry(0.035, 0.035, 2.2, 6), 0, T.h + 1.3, zp + 0.4, -0.75, 0, 0); box('dark', 1.8, 0.06, 0.12, 0, T.h + 2.25, zp); }
    }
    box('roof', 1.5, 0.3, 2.4, 0, T.h + 0.36, zc + T.len * 0.25);   // the air-conditioning
    B.bogies(z0, T.len, T.lrv && !T.pcc ? [0.15, 0.5, 0.85] : [0.17, 0.83], T.pcc ? 0.33 : 0.36);
    box('under', T.w - 0.5, 0.35, T.len * 0.5, 0, H0 - 0.1, zc);
    if (i < cars - 1) box('dark', 1.8, 2.4, GAP + 0.2, 0, (H0 + T.h) / 2, z0 + T.len + GAP / 2);
    spans.push([z, z + T.len]); z += T.len + GAP;
  }
  return { group: B.finish(), length, spans, cab: [0, 2.6, -length / 2 + 0.8] };
}
export const T_RAILS = Object.keys(T_LOOK);
