// Moored boats in the harbors, by the season (v944, requested: "Northeast Harbor looks very empty ... add the
// moored boats with seasons"). data/moorings.json gives each harbor's place and its high-summer count of yachts and
// working boats; the date decides how many are in (yachts from late May, all in by late June, hauled through
// October; working boats most of the year, fewer in midwinter), the rest are mooring balls. Each harbor's
// moorings are laid out once its detailed ground has loaded: on a staggered grid out from its middle, in open water
// clear of the shore, the piers, the ferry slips and the ferry lines. The boats lie head to wind, each a little
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

  // lay out a harbor's moorings: a staggered grid out from its middle, open water only, the nearest first
  function layOut(h) {
    const S = 36, need = h.n, spots = [];
    let sd = [...h.name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 2147483647, 11) || 11;
    const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
    const cand = [];
    const R = Math.max(250, 30 * Math.sqrt(need)) * 2.2;
    for (let j = -Math.ceil(R / (S * 0.87)); j * S * 0.87 <= R; j++) for (let i = -Math.ceil(R / S); i * S <= R; i++) {
      const x = h.x + (i + (j & 1 ? 0.5 : 0)) * S + (rnd() - 0.5) * S * 0.45, z = h.z + j * S * 0.87 + (rnd() - 0.5) * S * 0.45, d = Math.hypot(x - h.x, z - h.z);
      if (d <= R) cand.push({ x, z, d });
    }
    cand.sort((a, b) => a.d - b.d);
    for (const c of cand) {
      if (spots.length >= need) break;
      if (!water(c.x, c.z)) continue;
      let ok = true;
      for (let k = 0; k < 6 && ok; k++) { const a = k * Math.PI / 3; ok = water(c.x + Math.cos(a) * 16, c.z + Math.sin(a) * 16); }   // swinging room, off the shore
      if (!ok || !clear(c.x, c.z)) continue;
      spots.push({ x: c.x, z: c.z, r: rnd(), t: rnd(), off: (rnd() - 0.5) * 30 });
    }
    // which are yachts and which working boats: the working boats nearer the landing (the middle), as they tend to lie
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
