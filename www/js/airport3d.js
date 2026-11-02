// An airport's ground in Bird's-eye (v1111, requested: "let's add lots of detail to San Francisco Airport"), from
// www/data/airports/<id>.json (design/airports/build_airport.py, OpenStreetMap's aeroways): her runways with their
// markings (threshold bars, numbers, the dashed centreline, touchdown-zone and aiming-point bars, edge stripes), the
// blast pads beyond them, taxiways with their yellow centrelines and hold-short bars, the aprons, the jet bridges on
// their legs, the approach-light piers out into the bay with the sequenced strobes running in to the runway, runway
// edge and threshold lights, the control tower, the AirTrain on its columns, and the windsock.
// The flat layers lie on the ground drawn in order (no depth written), so they never flicker against each other or
// against the terrain under them.
// makeAirport({ data, wx, wz, heightAt }) → { group, update(t) }
import * as THREE from 'three';

// (round 2: under the app's tone mapping the taxiways came out black and the aprons tan; SFO's are grey concrete)
const ASPHALT = '#4b4e52', TAXI = 0x76797c, CONCRETE = 0xbfc1bf, YELLOW = 0xf5c838, PAD = 0x434548;
const LIFT = 0.6;   // (her surfaces this far over the ground, and pulled toward the eye: polygonOffset)
const flat = (color, order) => new THREE.MeshLambertMaterial({ color, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -40 - order * 4, side: THREE.DoubleSide });

export function makeAirport({ data, wx, wz, heightAt }) {
  const group = new THREE.Group(), D2R = Math.PI / 180;
  const X = p => wx(p[0]), Z = p => wz(p[1]), H = (x, z, lon, lat) => Math.max(0, heightAt(lon, lat) || 0);
  const lonOf = (x, p0) => p0[0] + (x - X(p0)) / (111320 * Math.cos(p0[1] * D2R)), latOf = (z, p0) => p0[1] - (z - Z(p0)) / 111120;
  const yAt = (x, z, p0) => H(x, z, lonOf(x, p0), latOf(z, p0)) + LIFT;
  const add = (geo, mat, order) => { const m = new THREE.Mesh(geo, mat); m.renderOrder = order; m.frustumCulled = false; group.add(m); return m; };
  const P0 = data.runways[0]?.ends[0] || data.aprons[0]?.[0];

  // ── a ribbon along a polyline, w wide, on the ground ──
  function ribbon(pts, w, y0 = 0) {
    const P = pts.map(p => [X(p), Z(p)]), pos = [], idx = [];
    for (let i = 0; i < P.length; i++) {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1, nx = -dz / l * w / 2, nz = dx / l * w / 2;
      for (const s of [-1, 1]) { const x = P[i][0] + nx * s, z = P[i][1] + nz * s; pos.push(x, yAt(x, z, P0) + y0, z); }
      if (i) { const k = (i - 1) * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
  }
  // ── a polygon on the ground ──
  function area(poly, y0 = 0) {
    const P = poly.slice(0, -1).map(p => new THREE.Vector2(X(p), Z(p))), tri = THREE.ShapeUtils.triangulateShape(P, []), pos = [];
    for (const v of P) pos.push(v.x, yAt(v.x, v.y, P0) + y0, v.y);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(tri.flat()); g.computeVertexNormals(); return g;
  }
  const merge = gs => {   // (many of one thing as one mesh)
    let n = 0; const flatGs = gs.map(g => (g.index ? g.toNonIndexed() : g)); for (const g of flatGs) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3); let o = 0;
    for (const g of flatGs) { pos.set(g.attributes.position.array, o * 3); if (!g.attributes.normal) g.computeVertexNormals(); nor.set(g.attributes.normal.array, o * 3); o += g.attributes.position.count; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); return g;
  };

  // ── the aprons, then the taxiways, their centrelines and hold-short bars, the blast pads ──
  if (data.aprons.length) add(merge(data.aprons.map(p => area(p))), flat(CONCRETE, 1), 1);
  if (data.taxiways.length) add(merge(data.taxiways.map(t => ribbon(t.pts, t.width))), flat(TAXI, 2), 2);
  if (data.taxiways.length) add(merge(data.taxiways.map(t => ribbon(t.pts, 0.6))), flat(YELLOW, 3), 3);
  if (data.holds.length) add(merge(data.holds.map(h => ribbon(h, 1.8))), flat(YELLOW, 3), 3);
  if (data.stopways.length) add(merge(data.stopways.map(s => ribbon(s.pts, s.width))), flat(PAD, 4), 4);
  if (data.helipads.length) add(merge(data.helipads.map(p => area(p))), flat(0x8f8c84, 4), 4);

  // ── the runways: one strip each, her markings painted on a texture along her ──
  for (const r of data.runways) {
    const [A, B] = r.ends, ax = X(A), az = Z(A), bx = X(B), bz = Z(B), Lm = Math.hypot(bx - ax, bz - az), W = r.width;
    const ux = (bx - ax) / Lm, uz = (bz - az) / Lm, nx = -uz, nz = ux;
    const tex = runwayTexture(r, Lm);
    const SEG = Math.max(8, Math.round(Lm / 60)), pos = [], uv = [], idx = [];
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG, cx = ax + (bx - ax) * t, cz = az + (bz - az) * t, y = yAt(cx, cz, P0) + 0.05;
      for (const s of [0, 1]) { pos.push(cx + nx * W * (s - 0.5), y, cz + nz * W * (s - 0.5)); uv.push(s, t); }
      if (i) { const k = (i - 1) * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    const mat = flat(0xffffff, 5); mat.map = tex; add(g, mat, 5);
  }

  // ── the lights: runway edges (white, every 60 m), thresholds (green) and ends (red), the approach lights on
  // their piers (white bars every 30 m; the sequenced strobes, white, running in to the runway twice a second) ──
  const lamp = new THREE.SphereGeometry(0.45, 6, 4), lights = [], strobes = [];
  const light = (x, z, y, c) => lights.push([x, y, z, c]);
  for (const r of data.runways) {
    const [A, B] = r.ends, ax = X(A), az = Z(A), bx = X(B), bz = Z(B), Lm = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / Lm, uz = (bz - az) / Lm, nx = -uz, nz = ux, W = r.width / 2 + 1.5;
    for (let d = 0; d <= Lm; d += 60) for (const s of [-1, 1]) { const x = ax + ux * d + nx * W * s, z = az + uz * d + nz * W * s; light(x, z, yAt(x, z, P0) + 0.5, 0xfff4d6); }
    for (let k = -8; k <= 8; k++) { const o = k / 8 * (W - 1);
      light(ax + nx * o - ux * 1, az + nz * o - uz * 1, yAt(ax, az, P0) + 0.5, 0x37ff6b); light(bx + nx * o + ux * 1, bz + nz * o + uz * 1, yAt(bx, bz, P0) + 0.5, 0xff3b30); }
  }
  for (const pier of data.lightPiers) {
    const P = pier.pts.map(p => [X(p), Z(p)]);
    // (her deck, out over the water)
    add(ribbon(pier.pts, 1.8, 0.9), new THREE.MeshLambertMaterial({ color: 0x55585c }), 0);
    // (her lights along her: which end is the runway's, the strobes run toward it)
    const near = (() => { let best = 0, bd = 1e9; for (const r of data.runways) for (const e of r.ends) for (const [i, p] of [[0, P[0]], [1, P[P.length - 1]]]) { const d = Math.hypot(X(e) - p[0], Z(e) - p[1]); if (d < bd) { bd = d; best = i; } } return best; })();
    const seq = [];
    let run = 0;
    for (let i = 1; i < P.length; i++) {
      const [x0, z0] = P[i - 1], [x1, z1] = P[i], l = Math.hypot(x1 - x0, z1 - z0), ux = (x1 - x0) / l, uz = (z1 - z0) / l;
      for (let d = (30 - run % 30) % 30; d <= l; d += 30) {
        const x = x0 + ux * d, z = z0 + uz * d, y = yAt(x, z, P0) + 2.2;
        for (let k = -2; k <= 2; k++) light(x - uz * k * 1.2, z + ux * k * 1.2, y, 0xfffaf0);
        seq.push([x, y + 0.6, z]);
      }
      run += l;
    }
    if (near === 0) seq.reverse();   // (in from her far end)
    strobes.push(seq);
  }
  if (lights.length) {
    const im = new THREE.InstancedMesh(lamp, new THREE.MeshBasicMaterial({ toneMapped: false }), lights.length), m4 = new THREE.Matrix4(), c = new THREE.Color();
    lights.forEach(([x, y, z, col], i) => { im.setMatrixAt(i, m4.makeTranslation(x, y, z)); im.setColorAt(i, c.setHex(col).multiplyScalar(1.6)); });
    im.frustumCulled = false; group.add(im);
  }
  const flash = strobes.flat().length ? new THREE.InstancedMesh(new THREE.SphereGeometry(1.1, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), strobes.flat().length) : null;
  if (flash) { flash.frustumCulled = false; group.add(flash); }

  // ── the jet bridges: a box from the terminal out to her door, on a leg at her outer end ──
  const jb = [];
  for (const line of data.jetBridges) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i], x0 = X(a), z0 = Z(a), x1 = X(b), z1 = Z(b), l = Math.hypot(x1 - x0, z1 - z0); if (l < 1) continue;
      const g = new THREE.BoxGeometry(3.2, 3.0, l); g.rotateY(Math.atan2(x1 - x0, z1 - z0)); g.translate((x0 + x1) / 2, yAt((x0 + x1) / 2, (z0 + z1) / 2, P0) + 4.2, (z0 + z1) / 2); jb.push(g);
    }
    const e = line[line.length - 1], x = X(e), z = Z(e), y = yAt(x, z, P0);
    const leg = new THREE.BoxGeometry(0.8, 3.0, 0.8); leg.translate(x, y + 1.3, z); jb.push(leg);
    const cab = new THREE.BoxGeometry(4.2, 3.4, 3.6); const a = line[line.length - 2]; cab.rotateY(Math.atan2(x - X(a), z - Z(a))); cab.translate(x, y + 4.2, z); jb.push(cab);
  }
  if (jb.length) add(merge(jb), new THREE.MeshLambertMaterial({ color: 0xb4b8bc }), 0);

  // ── the AirTrain: her guideway on columns, 9 m up (5 m where she comes down to a station) ──
  const at = [];
  for (const t of data.airtrain) {
    const up = t.layer >= 5 ? 9 : t.layer >= 1 ? 5 : 1.5;
    for (let i = 1; i < t.pts.length; i++) {
      const a = t.pts[i - 1], b = t.pts[i], x0 = X(a), z0 = Z(a), x1 = X(b), z1 = Z(b), l = Math.hypot(x1 - x0, z1 - z0); if (l < 0.5) continue;
      const g = new THREE.BoxGeometry(4.2, 1.4, l + 0.3); g.rotateY(Math.atan2(x1 - x0, z1 - z0)); g.translate((x0 + x1) / 2, yAt((x0 + x1) / 2, (z0 + z1) / 2, P0) + up, (z0 + z1) / 2); at.push(g);
      for (let d = 0; d < l; d += 34) { const x = x0 + (x1 - x0) * d / l, z = z0 + (z1 - z0) * d / l, y = yAt(x, z, P0), col = new THREE.BoxGeometry(1.4, up, 1.4); col.translate(x, y + up / 2 - 0.7, z); at.push(col); }
    }
  }
  if (at.length) add(merge(at), new THREE.MeshLambertMaterial({ color: 0xd6d6d0 }), 0);

  // ── the control tower: her shaft rising and flaring to the glass cab, the roof, the mast (SFO's, 2016: 67 m) ──
  if (data.tower) {
    const { at: p, height: Ht } = data.tower, x = X(p), z = Z(p), y = yAt(x, z, P0) - LIFT, cabB = Ht * 0.83, cabT = Ht * 0.93;
    const prof = [[8.5, 0], [6.2, 4], [4.6, Ht * 0.25], [4.2, Ht * 0.65], [6.5, Ht * 0.76], [8.8, cabB], [9.4, cabB + 0.4], [9.4, cabT], [6, cabT + 1.2], [0.01, cabT + 1.4]].map(([r, h]) => new THREE.Vector2(r, h));
    const shaft = new THREE.LatheGeometry(prof, 32); shaft.translate(x, y, z); add(shaft, new THREE.MeshLambertMaterial({ color: 0xe9e8e3 }), 0);
    const glass = new THREE.CylinderGeometry(9.5, 9.1, cabT - cabB - 1.4, 32, 1, true); glass.translate(x, y + (cabB + cabT) / 2 + 0.2, z); add(glass, new THREE.MeshPhongMaterial({ color: 0x1f3442, specular: 0x88aacc, shininess: 80, side: THREE.DoubleSide }), 0);
    const mast = new THREE.CylinderGeometry(0.25, 0.35, Ht - cabT - 1.4, 8); mast.translate(x, y + (Ht + cabT + 1.4) / 2, z); add(mast, new THREE.MeshLambertMaterial({ color: 0xb0b0b0 }), 0);
  }
  // ── the windsock: a pole and her orange sock ──
  for (const p of data.windsocks) {
    const x = X(p), z = Z(p), y = yAt(x, z, P0), pole = new THREE.CylinderGeometry(0.1, 0.12, 6, 6), sock = new THREE.ConeGeometry(0.6, 3.5, 12, 1, true);
    pole.translate(x, y + 3, z); sock.rotateZ(-Math.PI / 2 + 0.25); sock.translate(x + 1.8, y + 5.6, z);
    add(pole, new THREE.MeshLambertMaterial({ color: 0xdddddd }), 0); add(sock, new THREE.MeshLambertMaterial({ color: 0xff6a1a, side: THREE.DoubleSide }), 0);
  }

  const m4 = new THREE.Matrix4(), zero = new THREE.Matrix4().makeScale(0, 0, 0);
  return {
    group,
    update(t) {   // the sequenced strobes: a ball of light running in along each pier, twice a second
      if (!flash) return;
      let i = 0;
      for (const seq of strobes) { const k = Math.floor((t * 2 % 1) * (seq.length + 3)); seq.forEach(([x, y, z], j) => flash.setMatrixAt(i++, j === k ? m4.makeTranslation(x, y, z) : zero)); }
      flash.instanceMatrix.needsUpdate = true;
    },
  };
}

// her markings (the FAA's precision-runway pattern), painted on a canvas along her: v = 0 at her first end
function runwayTexture(r, Lm) {
  const PX = 2.2, Wm = r.width, cw = Math.round(Wm * PX), ch = Math.min(8192, Math.round(Lm * PX * 0.5)), sy = ch / Lm, sx = cw / Wm;
  const c = document.createElement('canvas'); c.width = cw; c.height = ch; const g = c.getContext('2d');
  g.fillStyle = ASPHALT; g.fillRect(0, 0, cw, ch);
  // (rubber where they touch down, near each end)
  for (const [a, b] of [[150, 900], [Lm - 900, Lm - 150]]) { const gr = g.createLinearGradient(0, a * sy, 0, b * sy); gr.addColorStop(0, 'rgba(15,15,15,0)'); gr.addColorStop(0.5, 'rgba(15,15,15,0.45)'); gr.addColorStop(1, 'rgba(15,15,15,0)'); g.fillStyle = gr; g.fillRect(cw * 0.25, a * sy, cw * 0.5, (b - a) * sy); }
  g.fillStyle = '#ecebe6';
  const bar = (u0, v0, w, l) => g.fillRect(u0 * sx, v0 * sy, Math.max(1, w * sx), Math.max(1, l * sy));
  bar(1, 0, 0.9, Lm); bar(Wm - 1.9, 0, 0.9, Lm);   // her edges
  for (const end of [0, 1]) {
    const at = d => end ? Lm - d : d, span = (d0, l) => end ? [Lm - d0 - l, l] : [d0, l];
    // the threshold's piano keys: 16 bars, 1.8 m wide, 46 m long, 6 m in
    for (let k = 0; k < 16; k++) { const u = 3 + k * ((Wm - 6) / 16) + (k >= 8 ? 1.8 : 0); const [v, l] = span(6, 46); bar(u, v, 1.8, l); }
    // her number and letter, read by a pilot coming in over this end
    const [num, letter] = [r.names[end].replace(/[LRC]$/, ''), (r.names[end].match(/[LRC]$/) || [''])[0]];
    g.save(); g.translate(cw / 2, at(end ? 64 : 64) * sy); if (!end) g.rotate(Math.PI);   // (her top toward the runway's far end)
    g.font = `bold ${Math.round(18 * sy)}px Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'top';
    g.save(); g.scale(sx / sy, 1);   // (18 m tall, about 3 m a figure across)
    g.fillText(letter, 0, -2 * sy - 18 * sy - 6 * sy - 18 * sy + 6 * sy); g.fillText(num, 0, -2 * sy - 18 * sy - 6 * sy);
    g.restore(); g.restore();
    // the aiming point (two broad bars at 305 m) and the touchdown zone (bars in threes, twos and ones)
    for (const s of [-1, 1]) {
      const [v, l] = span(305, 45); bar(Wm / 2 + s * 9 - (s < 0 ? 9 : 0), v, 9, l);
      for (const [d, n] of [[150, 3], [450, 2], [600, 2], [750, 1], [900, 1]]) for (let k = 0; k < n; k++) { const [vv, ll] = span(d, 22.5); bar(Wm / 2 + s * (6 + k * 3) - (s < 0 ? 1.8 : 0), vv, 1.8, ll); }
    }
  }
  // the centreline: 36 m dashes, 24 m apart, between the numbers
  for (let d = 110; d < Lm - 110; d += 60) bar(Wm / 2 - 0.45, d, 0.9, 36);
  const tex = new THREE.CanvasTexture(c); tex.flipY = false; tex.anisotropy = 8; tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
