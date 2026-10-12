// A small sloop for the Bird's-eye fleet (v870): hull, mast, boom, mainsail and jib, simple enough to
// draw a few dozen at once. Built along -z (bow) like the helm view's Cape Dory, ~8 m overall, and
// trimmed with trim() from weather3d.js's makeTrimmer (boom and jib angles, side, heel).
import * as THREE from 'three';

const V3 = THREE.Vector3;
const HULL_COLORS = [0xf4f1ea, 0xf4f1ea, 0xf4f1ea, 0x1d2f4d, 0x7a1f1f, 0x2e4d3a, 0xe8dcc0];
const mats = new Map();
const mat = (c, extra = {}) => { const k = c + JSON.stringify(extra); if (!mats.has(k)) mats.set(k, new THREE.MeshLambertMaterial({ color: c, ...extra })); return mats.get(k); };
const CLOTH = () => mat(0xf6f3ec, { side: THREE.DoubleSide });

// a lofted sail with a belly (deepest ~40% back from the luff): luff(u), leech(u) points, belly(u) leeward unit vector
function sailGeo(luff, leech, belly, nu = 8, nv = 6) {
  const pos = [], idx = [];
  for (let i = 0; i <= nu; i++) {
    const u = i / nu, a = luff(u), b = leech(u), w = belly(u), chord = a.distanceTo(b);
    for (let j = 0; j <= nv; j++) {
      const v = j / nv, p = a.clone().lerp(b, v).addScaledVector(w, chord * 0.11 * Math.sin(Math.PI * Math.pow(v, 0.8)));
      pos.push(p.x, p.y, p.z);
    }
  }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { const k = i * (nv + 1) + j; idx.push(k, k + nv + 1, k + 1, k + 1, k + nv + 1, k + nv + 2); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}

let hullGeo = null;
function hullGeometry() {
  if (hullGeo) return hullGeo;
  // deck outline: pointed bow at z = -4.1, wide quarters, flat transom at z = +3.6; extruded down to the waterline
  const s = new THREE.Shape();
  s.moveTo(0, -4.1); s.quadraticCurveTo(1.35, -2.4, 1.3, 0.6); s.quadraticCurveTo(1.25, 2.8, 1.0, 3.6);
  s.lineTo(-1.0, 3.6); s.quadraticCurveTo(-1.25, 2.8, -1.3, 0.6); s.quadraticCurveTo(-1.35, -2.4, 0, -4.1);
  hullGeo = new THREE.ExtrudeGeometry(s, { depth: 0.9, bevelEnabled: false, curveSegments: 8 });
  hullGeo.rotateX(Math.PI / 2); hullGeo.translate(0, 0.75, 0);   // shape's y → -z; deck at 0.75 m, waterline at -0.15
  return hullGeo;
}

export function makeSailboat(seed = 0) {
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body);   // body heels; g turns to the heading
  body.add(new THREE.Mesh(hullGeometry(), mat(HULL_COLORS[seed % HULL_COLORS.length])));
  const deck = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.35, 2.4), mat(0xe9e4d8)); deck.position.set(0, 0.92, -0.6); body.add(deck);   // cabin top
  const MZ = -1.6, MTOP = 10.5, BY = 1.9;
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, MTOP - 0.75, 6), mat(0xc9ccd0)); mast.position.set(0, (MTOP + 0.75) / 2, MZ); body.add(mast);
  const boomG = new THREE.Group(); boomG.position.set(0, BY, MZ); body.add(boomG);
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3.6, 5), mat(0xc9ccd0)); boom.rotation.x = Math.PI / 2; boom.position.z = 1.8; boomG.add(boom);
  const mainH = MTOP - 0.4 - BY, tw = u => -0.2 * u;
  const main = new THREE.Mesh(sailGeo(u => new V3(0, 0.1 + u * mainH, 0.05),
    u => { const r = 3.5 * (1 - u) * (1 + 0.15 * Math.sin(Math.PI * u)) + 0.1 * u, t = tw(u); return new V3(Math.sin(t) * r, 0.1 + u * mainH, 0.05 + Math.cos(t) * r); },
    u => new V3(-Math.cos(tw(u)), 0, Math.sin(tw(u)) * 0.2).normalize()), CLOTH());
  boomG.add(main);
  const tack = new V3(0, 0.95, -3.9), headJ = tack.clone().lerp(new V3(0, MTOP, MZ), 0.84), CR = 2.6;
  const jibGeo = (deg, side) => {
    const a = deg * Math.PI / 180, clew = new V3(-side * Math.sin(a) * CR, 1.6, tack.z + Math.cos(a) * CR);
    return sailGeo(u => tack.clone().lerp(headJ, u), u => clew.clone().lerp(headJ, u),
      u => { const c = clew.clone().lerp(headJ, u).sub(tack.clone().lerp(headJ, u)); return new V3(c.z, 0, -c.x).multiplyScalar(side).setY(0).normalize(); });
  };
  const jib = new THREE.Mesh(jibGeo(20, 1), CLOTH()); body.add(jib);
  let jibKey = '';
  return {
    group: g,
    // p: a makeTrimmer() result; heelRad: the wind's full heel; up: false furls everything (calm)
    trim(p, heelRad, up) {
      main.visible = up; jib.visible = up && p.jibOn;
      boomG.rotation.y = -p.side * (up ? p.boom : 0) * Math.PI / 180;
      main.scale.x = p.side < 0 ? -1 : 1;
      body.rotation.z = up ? p.side * p.heelK * heelRad : 0;   // heels to leeward
      const key = `${Math.round(p.jib)},${p.side}`;
      if (jib.visible && key !== jibKey) { jibKey = key; jib.geometry.dispose(); jib.geometry = jibGeo(p.jib, p.side); }
    },
  };
}
