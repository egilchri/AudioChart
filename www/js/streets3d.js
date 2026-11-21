// A city's streets (v1193, asked riding an M5 bus: "recursively improve the various views of the bus. Like how the roads
// look"): each road in a building area (www/data/streets/<area>.json, design/streets/build_streets.py, from OpenStreetMap)
// laid on the ground: its roadway in asphalt, its sidewalks either side in concrete, and its markings: a two-way
// street's double yellow line down the middle, white lane lines (dashed, 10 ft on 30, as New York's) between lanes the
// same way, a white edge line on the big roads; all of them stopping short of the junctions, where the crosswalks are
// (a ladder of white bars across the roadway). Draped on the 10 m ground (hAt: its height, interpolated), a little above
// it, so the ground's own photo of the street shows nowhere. Part of the armchair layer (bay3d.js loadArmchair).
import * as THREE from 'three';

const SIDEWALK = 4.2, STEP = 7;   // a sidewalk's width (m); the most between heights along a road
let MATS = null;
function mats() {
  if (MATS) return MATS;
  const off = (m, k) => { m.polygonOffset = true; m.polygonOffsetFactor = -1 - k; m.polygonOffsetUnits = -2 - 2 * k; return m; };
  // the asphalt: a little noise in it (its patches and wear), repeating every 8 m
  const cv = document.createElement('canvas'); cv.width = cv.height = 128; const c = cv.getContext('2d');
  c.fillStyle = '#4a4c4f'; c.fillRect(0, 0, 128, 128);
  let sd = 7; const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 2600; k++) { const v = 58 + rnd() * 30 | 0; c.fillStyle = `rgba(${v},${v + 1},${v + 3},${0.25 + rnd() * 0.3})`; c.fillRect(rnd() * 128, rnd() * 128, 1 + rnd() * 2, 1 + rnd() * 2); }
  for (let k = 0; k < 7; k++) { c.fillStyle = `rgba(30,31,33,${0.15 + rnd() * 0.2})`; c.fillRect(rnd() * 128, rnd() * 128, 10 + rnd() * 40, 6 + rnd() * 20); }   // (patches)
  const tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  MATS = {
    walk: off(new THREE.MeshLambertMaterial({ color: 0xb4b1aa }), 0),
    road: off(new THREE.MeshLambertMaterial({ map: tex }), 1),
    paint: off(new THREE.MeshLambertMaterial({ vertexColors: true }), 2),
    mall: off(new THREE.MeshLambertMaterial({ map: mallTexture() }), 1),
  };
  return MATS;
}

// a planted mall's ground (v1196): grass, a darker clump of planting here and there, mulch round it; repeating every 8 m
function mallTexture() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128; const c = cv.getContext('2d');
  let sd = 13; const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  c.fillStyle = '#4f6b34'; c.fillRect(0, 0, 128, 128);
  for (let k = 0; k < 3000; k++) { const g = 80 + rnd() * 50 | 0; c.fillStyle = `rgba(${g * 0.55 | 0},${g},${g * 0.4 | 0},0.5)`; c.fillRect(rnd() * 128, rnd() * 128, 1, 1 + rnd() * 2); }
  for (let k = 0; k < 9; k++) {   // shrubs in their beds of mulch
    const x = rnd() * 128, y = rnd() * 128, r = 6 + rnd() * 10;
    c.fillStyle = 'rgba(92,64,42,0.75)'; c.beginPath(); c.ellipse(x, y, r * 1.25, r * 1.1, 0, 0, 7); c.fill();
    for (let j = 0; j < 14; j++) { const g = 60 + rnd() * 40 | 0; c.fillStyle = `rgb(${g * 0.45 | 0},${g},${g * 0.35 | 0})`; c.beginPath(); c.arc(x + (rnd() - 0.5) * r * 1.4, y + (rnd() - 0.5) * r * 1.2, 2 + rnd() * r * 0.4, 0, 7); c.fill(); }
  }
  const tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; return tex;
}
// a divided street's twins (v1196, asked: "make Broadway's center mall green"): OpenStreetMap draws Broadway above
// Columbus Circle, Park Avenue and the parkways as two one-way roadways; between them is their mall. A one-way road whose
// twin (her name, the other way) runs alongside on her left, 6 to 45 m off, for a good part of her length: → how far off
// (m, the twin's middle line; the mall's middle is half that), else 0
function twinGap(r, Q, N, byName) {
  const others = byName.get(r.n) || [], offs = []; let tried = 0;
  for (let i = 0; i < Q.length; i += 2) {
    tried++; const q = Q[i], n = N[i]; let best = null, bd = 45 * 45;
    for (const o of others) {
      if (o.r === r) continue;
      for (let k = 0; k < o.Q.length; k++) { const p = o.Q[k], d2 = (p.x - q.x) ** 2 + (p.z - q.z) ** 2; if (d2 < bd && o.N[k].dx * n.dx + o.N[k].dz * n.dz < -0.7) { bd = d2; best = p; } }
    }
    if (!best) continue;
    const off = (best.x - q.x) * n.nx + (best.z - q.z) * n.nz, along = Math.abs((best.x - q.x) * n.dx + (best.z - q.z) * n.dz);
    if (off < -6 && off > -45 && along < 12) offs.push(-off);
  }
  if (offs.length < Math.max(2, tried * 0.4)) return 0;
  offs.sort((a, b) => a - b); return offs[offs.length >> 1];
}
// a polyline in metres, resampled so no two heights are more than STEP apart: [{x, z, s (along), j (a junction: the
// crossing street's width, m; 0 where none)}]
function resample(P, J) {
  const out = [];
  for (let i = 0; i < P.length; i++) {
    if (i) {
      const a = P[i - 1], b = P[i], L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.ceil(L / STEP);
      for (let k = 1; k < n; k++) { const t = k / n; out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, s: out.at(-1).s + L / n, j: false }); }
      out.push({ x: b.x, z: b.z, s: out.at(-1).s + L / n, j: J.get(i) ?? 0 });
    } else out.push({ x: P[0].x, z: P[0].z, s: 0, j: J.get(0) ?? 0 });
  }
  return out;
}
// the side direction (to the right going along) at each point, mitred at the bends, not too far at a sharp one
function sides(Q) {
  return Q.map((q, i) => {
    const a = Q[Math.max(0, i - 1)], b = Q[Math.min(Q.length - 1, i + 1)];
    let dx = b.x - a.x, dz = b.z - a.z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    let k = 1;
    if (i > 0 && i < Q.length - 1) {
      const ux = q.x - a.x, uz = q.z - a.z, ul = Math.hypot(ux, uz) || 1;
      const cos = (ux / ul) * dx + (uz / ul) * dz; k = 1 / Math.max(0.5, cos);
    }
    return { nx: -dz * k, nz: dx * k, dx, dz };
  });
}

// → { group } (y up, the ground's own frame); data: the area's streets; hAt(lon, lat): the ground's height
export function makeStreets({ data, wx, wz, hAt, lonOf, latOf }) {
  const M = mats(), lift = { walk: 0.22, road: 0.3, paint: 0.36, mall: 0.42 };
  const B = { walk: [[], [], []], road: [[], [], []], paint: [[], [], [], []], mall: [[], [], []] };   // positions, uvs or colours, indices
  const yAt = (x, z, up) => hAt(lonOf(x), latOf(z)) + up;
  // a strip along Q between offsets o0 and o1 (m, + right), from s0 to s1 along it
  function strip(buf, Q, N, o0, o1, s0, s1, up, colour = null) {
    const [pos, aux, idx] = buf, base = pos.length / 3; let n = 0;
    const pts = [];
    for (let i = 0; i < Q.length; i++) {
      const q = Q[i];
      if (q.s < s0 && !(Q[i + 1] && Q[i + 1].s > s0)) continue;
      if (q.s > s1 && !(Q[i - 1] && Q[i - 1].s < s1)) continue;
      // (clipped to s0..s1: the ends moved in along the segment)
      let x = q.x, z = q.z, s = q.s;
      if (s < s0) { const b = Q[i + 1], t = (s0 - s) / (b.s - s); x += (b.x - x) * t; z += (b.z - z) * t; s = s0; }
      if (s > s1) { const a = Q[i - 1], t = (s1 - a.s) / (s - a.s); x = a.x + (x - a.x) * t; z = a.z + (z - a.z) * t; s = s1; }
      pts.push({ x, z, s, n: N[i] });
    }
    if (pts.length < 2) return;
    for (const p of pts) for (const o of [o0, o1]) {
      const x = p.x + p.n.nx * o, z = p.z + p.n.nz * o;
      pos.push(x, yAt(x, z, up), z);
      if (colour) aux.push(...colour); else aux.push(o / 8, p.s / 8);
      n++;
    }
    // (facing up whichever way across it runs: o0 to o1 rightward turns the other winding)
    for (let k = 0; k + 1 < pts.length; k++) { const a = base + k * 2; if (o1 < o0) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); else idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const WHITE = [0.86, 0.86, 0.82], YELLOW = [0.86, 0.66, 0.16];
  const W = data.ways.filter(r => r.p.length >= 2).map(r => { const Q = resample(r.p.map(([lo, la]) => ({ x: wx(lo), z: wz(la) })), new Map(r.j || [])); return { r, Q, N: sides(Q) }; });
  const byName = new Map(); for (const w of W) if (w.r.o && w.r.n) (byName.get(w.r.n) || byName.set(w.r.n, []).get(w.r.n)).push(w);
  for (const { r, Q, N } of W) {
    const L = Q.at(-1).s;
    const hw = r.w / 2, big = r.c === 'mot' || r.c === 'tru', svc = r.c === 'ser';
    const gap = r.o && r.n && !big ? twinGap(r, Q, N, byName) : 0, mall = gap / 2 > hw + 1 ? gap / 2 : 0;   // (her half of the mall, on her left)
    // (her roadway's width is a guess from her lanes, wide for Broadway: by her mall it's kept to leave the mall 3 m a side)
    const hwL = mall ? Math.max(Math.min(hw, mall - 3), r.l * 1.6 + 0.5, 3) : hw;
    if (!big && !svc) for (const sd of [-1, 1]) strip(B.walk, Q, N, sd < 0 ? -hwL : hw, sd < 0 && mall ? -mall : sd * (hw + SIDEWALK), 0, L, lift.walk);
    strip(B.road, Q, N, -hwL, hw, 0, L, lift.road);
    if (svc || L < 12) continue;
    // the markings, in the runs between junctions, each kept back from the junction past the crossing street's kerb and
    // its crosswalk
    const js = Q.filter(q => q.j).map(q => ({ s: q.s, keep: q.j / 2 + 4.2 }));
    const runs = []; let a = { s: 0, keep: Q[0].j ? Q[0].j / 2 + 4.2 : 0 };
    for (const b of [...js.filter(j => j.s > 0), { s: L, keep: Q.at(-1).j ? Q.at(-1).j / 2 + 4.2 : 0 }]) {
      if (b.s === L && js.at(-1)?.s === L) b.keep = js.at(-1).keep;
      const s0 = a.s + a.keep, s1 = b.s - b.keep; if (s1 - s0 > 4) runs.push([s0, s1]); a = b;
      if (b.s >= L) break;
    }
    // the mall: planted, its stone kerb round it (the concrete under it showing), ending short of each crossing street
    if (mall) for (const [s0, s1] of runs) if (s1 - s0 > 6) strip(B.mall, Q, N, -hwL - 0.6, -mall, s0 + 1.5, s1 - 1.5, lift.mall);
    const travel = Math.min(r.w - 1, r.l * 3.2), lanes = r.l;
    for (const [s0, s1] of runs) {
      if (!r.o && lanes >= 2) for (const o of [-0.12, 0.12]) strip(B.paint, Q, N, o - 0.06, o + 0.06, s0, s1, lift.paint, YELLOW);   // the double yellow
      // white lane lines between lanes going the same way: dashed
      const per = r.o ? lanes : Math.floor(lanes / 2), lw = travel / lanes;
      for (const sd of r.o ? [0] : [-1, 1]) for (let k = 1; k < per; k++) {
        const o = r.o ? -travel / 2 + k * lw : sd * k * lw;
        for (let s = s0 + 1; s + 3 < s1; s += 12.2) strip(B.paint, Q, N, o - 0.06, o + 0.06, s, s + 3, lift.paint, WHITE);
      }
      if (big) for (const sd of [-1, 1]) strip(B.paint, Q, N, sd * (hw - 0.4) - 0.07, sd * (hw - 0.4) + 0.07, s0, s1, lift.paint, WHITE);
    }
    // the crosswalks: a ladder of bars across the roadway, 3 m deep, at each junction (not on the expressways)
    if (!big) for (const { s, keep } of js) for (const at of [s - keep + 2.2, s + keep - 2.2]) {
      if (at < 2 || at > L - 2) continue;
      for (let o = -hw + 0.6; o + 0.5 < hw - 0.4; o += 1.2) strip(B.paint, Q, N, o, o + 0.55, at - 1.5, at + 1.5, lift.paint, WHITE);
    }
  }
  const group = new THREE.Group(); group.name = 'streets';
  const mesh = (buf, mat, colours) => {
    const [pos, aux, idx] = buf; if (!idx.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute(colours ? 'color' : 'uv', new THREE.Float32BufferAttribute(aux, colours ? 3 : 2));
    g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat); m.receiveShadow = true; group.add(m);
  };
  mesh(B.walk, M.walk); mesh(B.road, M.road); mesh(B.paint, M.paint, true); mesh(B.mall, M.mall);
  group.userData.credit = data.credit;
  return { group };
}
