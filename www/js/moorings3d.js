// Moored boats in the harbors, by the season (v944, requested: "Northeast Harbor looks very empty ... add the
// moored boats with seasons"). data/moorings.json gives each harbor's place and its high-summer count of yachts and
// working boats; the date decides how many are in (yachts from late May, all in by late June, hauled through
// October; working boats most of the year, fewer in midwinter), the rest are mooring balls. Each harbor's
// moorings are laid out once its detailed ground has loaded: filling its inner harbor (v945), in open water clear
// of the shore, the piers, the ferry slips and the ferry lines. The boats lie head to wind, each a little
// off it. Drawn as instances of a few furled boats from sailboat3d.js, only for the harbors near the view.
import * as THREE from 'three';
import { makeSailboat } from './sailboat3d.js';

// the share of a harbor's summer boats that are in on a day of the year (piecewise linear through the year)
const YACHT = [[1, 0.03], [110, 0.03], [140, 0.25], [171, 1], [253, 1], [283, 0.35], [304, 0.12], [324, 0.04], [366, 0.03]];
const WORK = [[1, 0.55], [100, 0.6], [135, 0.9], [160, 1], [320, 1], [345, 0.7], [366, 0.55]];
const along = (T, d) => { for (let i = 1; i < T.length; i++) if (d <= T[i][0]) { const [d0, v0] = T[i - 1], [d1, v1] = T[i]; return v0 + (v1 - v0) * (d - d0) / (d1 - d0); } return T[T.length - 1][1]; };
export function seasonShares(date = new Date()) {
  const doy = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 864e5);
  return { yacht: along(YACHT, doy), work: along(WORK, doy) };
}

// the boats: a few furled templates (a boat type and a seed for its colours), the yachts' share of each
const YACHTS = [['cruiser', 11, 3], ['cruiser', 23, 3], ['pocket', 5, 3], ['pocket', 17, 2], ['cd25', 9, 2], ['daysailer', 3, 2], ['lobster', 41, 1]];   // (a Downeast power cruiser among them)
const WORKERS = [['lobster', 2, 1], ['lobster', 7, 1], ['lobster', 13, 1], ['lobster', 29, 1]];
const pick = (list, r) => { const tot = list.reduce((a, b) => a + b[2], 0); let x = r * tot; for (let i = 0; i < list.length; i++) { x -= list[i][2]; if (x <= 0) return i; } return list.length - 1; };

export function makeMoorings({ scene, wx, wz, lonOf, latOf, water, detailAt, clear, windFrom, hidden }) {
  const T = [...YACHTS.map(t => [...t, 'y']), ...WORKERS.map(t => [...t, 'w'])];
  let templates = null;   // per template, its meshes: { geo, mat, rel (matrix in the boat's frame) }
  function build() {
    templates = T.map(([type, seed]) => {
      const b = makeSailboat(type, seed);
      b.trim({ side: 1, boom: 0, jib: 0, jibOn: false, heelK: 0, name: '' }, 0, false); b.wake(0);
      b.group.updateMatrixWorld(true);
      const parts = [];
      b.group.traverse(o => {
        if (!o.isMesh) return;
        for (let p = o; p; p = p.parent) if (!p.visible) return;
        if (o.material.transparent) return;
        parts.push({ geo: o.geometry, mat: o.material, rel: o.matrixWorld.clone() });
      });
      return { parts, L: b.L };
    });
  }
  const harbors = [];
  let ballMesh = null, inst = [], dirty = true, lastWind = null;
  fetch('./data/moorings.json').then(r => r.json()).then(d => {
    for (const h of d.harbors) harbors.push({ ...h, x: wx(h.lon), z: wz(h.lat), spots: null, n: h.yachts + h.working });
  }).catch(err => console.warn('[moorings]', err));

  // lay out a harbor's moorings (v945, requested: "make the moorings fill the whole inner harbor"): a staggered grid
  // flooded out from its middle through the sheltered water, the inner harbor, where land stands within 650 m on
  // most sides, stopping at the open water outside its mouth (and always as far as its summer count would reach);
  // a mooring wherever there's swinging room, clear of the shore, piers, slips and ferry lines (which so stay open
  // as fairways). The working boats lie nearest the middle, as they tend to lie near the landing.
  function layOut(h) {
    const S = 32, SZ = S * 0.87, spots = [];
    let sd = [...h.name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 2147483647, 11) || 11;
    const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
    const at = (i, j) => [h.x + (i + (j & 1 ? 0.5 : 0)) * S, h.z + j * SZ];
    const enclosed = (x, z) => {   // land within 650 m along at least 9 of 12 rays (an island-ringed bay outside, like the Great Harbor of Mount Desert, isn't one)
      let hits = 0;
      for (let k = 0; k < 12; k++) {
        const a = k * Math.PI / 6, dx = Math.cos(a), dz = Math.sin(a);
        for (let d = 30; d <= 650; d += 25) if (!water(x + dx * d, z + dz * d)) { hits++; break; }
        if (hits + (11 - k) < 9) return false;
      }
      return hits >= 9;
    };
    const r0 = Math.max(150, 30 * Math.sqrt(h.n) * 1.2), RMAX = 2200, CAP = 700;
    // start at the water cell nearest the middle
    let start = null;
    for (let r = 0; r < 8 && !start; r++) for (let j = -r; j <= r && !start; j++) for (let i = -r; i <= r && !start; i++) { const [x, z] = at(i, j); if (water(x, z)) start = [i, j]; }
    if (!start) { h.spots = []; return; }
    const seen = new Set([start.join()]), queue = [start];
    while (queue.length && spots.length < CAP) {
      const [i, j] = queue.shift(), [x0, z0] = at(i, j), d = Math.hypot(x0 - h.x, z0 - h.z);
      // a mooring here? (jittered a little off the grid)
      const x = x0 + (rnd() - 0.5) * S * 0.4, z = z0 + (rnd() - 0.5) * S * 0.4;
      let room = water(x, z);
      for (let k = 0; k < 6 && room; k++) { const a = k * Math.PI / 3; room = water(x + Math.cos(a) * 15, z + Math.sin(a) * 15); }
      if (room && clear(x, z)) spots.push({ x, z, d, r: rnd(), t: rnd(), off: (rnd() - 0.5) * 30 });
      // on through the sheltered water
      const nb = j & 1 ? [[1, 0], [-1, 0], [0, -1], [1, -1], [0, 1], [1, 1]] : [[1, 0], [-1, 0], [-1, -1], [0, -1], [-1, 1], [0, 1]];
      for (const [di, dj] of nb) {
        const ni = i + di, nj = j + dj, k = ni + ',' + nj;
        if (seen.has(k)) continue; seen.add(k);
        const [nx, nz] = at(ni, nj), nd = Math.hypot(nx - h.x, nz - h.z);
        if (nd > RMAX || !water(nx, nz)) continue;
        if (nd > r0 && !enclosed(nx, nz)) continue;
        queue.push([ni, nj]);
      }
    }
    // only the harbor's own number of moorings (v963, from "are there really that many boats in carvers harbor":
    // filling every 32 m had drawn about 4x it, 579 moorings there for about 100 boats), spread evenly through all
    // the water flooded above: picked in a random order, each clear of those already picked by a spacing that
    // shares out the area, loosened until there are enough
    if (spots.length > h.n) {
      const order = spots.map(p => [rnd(), p]).sort((a, b) => a[0] - b[0]).map(a => a[1]), keep = [], used = new Set();
      for (let D = Math.sqrt(spots.length * S * SZ / h.n) * 1.1; keep.length < h.n && D > S * 0.5; D *= 0.85)
        for (const p of order) {
          if (keep.length >= h.n) break;
          if (used.has(p) || keep.some(q => Math.hypot(q.x - p.x, q.z - p.z) < D)) continue;
          keep.push(p); used.add(p);
        }
      spots.length = 0; spots.push(...keep);
    }
    spots.sort((p, q) => p.d - q.d);
    const nw = Math.round(spots.length * h.working / Math.max(1, h.n));
    spots.forEach((s, i) => { s.work = i < nw ? rnd() < 0.8 : rnd() < 0.08; });
    for (const s of spots) s.tpl = s.work ? YACHTS.length + pick(WORKERS, s.t) : pick(YACHTS, s.t);
    h.spots = spots;
  }

  const M = new THREE.Matrix4(), R = new THREE.Matrix4(), Q = new THREE.Matrix4(), _q = new THREE.Quaternion(), _y = new THREE.Vector3(0, 1, 0), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
  function rebuild(view) {
    if (!templates) build();
    for (const im of inst) { scene.remove(im); im.dispose(); }
    inst = [];
    if (ballMesh) { scene.remove(ballMesh); ballMesh.dispose(); ballMesh = null; }
    const sh = seasonShares(), wf = windFrom(), near = harbors.filter(h => h.spots && Math.hypot(h.x - view.x, h.z - view.z) < 9000);
    const per = templates.map(() => []), balls = [];
    for (const h of near) for (const s of h.spots) {
      if (s.r < (s.work ? sh.work : sh.yacht)) per[s.tpl].push(s); else balls.push(s);
    }
    templates.forEach((tp, ti) => {
      const list = per[ti]; if (!list.length) return;
      for (const part of tp.parts) {
        const im = new THREE.InstancedMesh(part.geo, part.mat, list.length); im.name = 'moored';
        list.forEach((s, k) => {
          _q.setFromAxisAngle(_y, -((wf + s.off) * Math.PI / 180)); _p.set(s.x, 0, s.z);
          M.compose(_p, _q, _s).multiply(part.rel); im.setMatrixAt(k, M);
        });
        im.instanceMatrix.needsUpdate = true; im.frustumCulled = false; scene.add(im); inst.push(im);
      }
    });
    if (balls.length) {   // the empty moorings: a white ball each
      ballMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.35, 8, 6), new THREE.MeshLambertMaterial({ color: 0xf2f2ee }), balls.length);
      balls.forEach((s, k) => { M.makeTranslation(s.x, 0.12, s.z); ballMesh.setMatrixAt(k, M); });
      ballMesh.instanceMatrix.needsUpdate = true; ballMesh.frustumCulled = false; scene.add(ballMesh);
    }
    lastWind = wf;
  }

  let key = '';
  return {
    harbors, seasonShares,
    // every couple of seconds: lay out the harbors near the view whose ground has loaded, and redraw when the set
    // near the view, the layouts, the season or the wind has changed
    update(view) {
      if (hidden()) { for (const im of inst) im.visible = false; if (ballMesh) ballMesh.visible = false; return; }
      for (const im of inst) im.visible = true; if (ballMesh) ballMesh.visible = true;
      for (const h of harbors) if (!h.spots && Math.hypot(h.x - view.x, h.z - view.z) < 9000 && detailAt(h.x, h.z)) { layOut(h); dirty = true; }
      const k = harbors.filter(h => h.spots && Math.hypot(h.x - view.x, h.z - view.z) < 9000).map(h => h.name).join('|');
      if (k !== key || dirty || Math.abs(((windFrom() - (lastWind ?? 0) + 540) % 360) - 180) > 20) { key = k; dirty = false; rebuild(view); }
    },
    relayout(h) { h.spots = null; },   // (when piers near it arrive)
  };
}
