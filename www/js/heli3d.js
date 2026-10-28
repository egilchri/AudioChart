// A little red tour helicopter, ~13 m, nose along -z, for a chase camera: the one in the sailors-page helicopter
// videos (design/pending/*-tour/heli.js), flying Bird's-eye's Flyover since v1048 (flyover.js). → {group, rotor, tail}
import * as THREE from 'three';

export function makeHeli() {
  const M = c => new THREE.MeshLambertMaterial({ color: c });
  const red = M(0xc8202a), white = M(0xf4f2ec), dark = M(0x22262a), glass = new THREE.MeshLambertMaterial({ color: 0x8fb8d8, transparent: true, opacity: 0.75 });
  const g = new THREE.Group(), add = (geo, m, x, y, z, s) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); if (s) o.scale.set(...s); g.add(o); return o; };
  const S = new THREE.SphereGeometry(1, 20, 14);
  add(S, red, 0, 0, 0, [1.25, 1.2, 2.6]);                        // cabin
  add(S, glass, 0, 0.25, -1.55, [1.05, 0.95, 1.3]);              // canopy
  add(S, white, 0, -0.35, 0.2, [1.28, 0.55, 2.4]);               // white belly stripe
  const boom = add(new THREE.CylinderGeometry(0.22, 0.45, 5.6, 10), red, 0, 0.3, 4.2); boom.rotation.x = Math.PI / 2;
  add(new THREE.BoxGeometry(0.12, 1.6, 0.9), red, 0, 1.0, 6.9);   // fin
  add(new THREE.BoxGeometry(1.8, 0.1, 0.6), white, 0, 0.4, 6.5);  // stabilizer
  for (const s of [-1, 1]) { const sk = add(new THREE.CylinderGeometry(0.08, 0.08, 3.6, 6), dark, s * 0.95, -1.5, -0.2); sk.rotation.x = Math.PI / 2;
    for (const z of [-0.9, 0.7]) add(new THREE.CylinderGeometry(0.06, 0.06, 0.6, 6), dark, s * 0.85, -1.2, z); }
  add(new THREE.CylinderGeometry(0.15, 0.15, 0.6, 8), dark, 0, 1.4, -0.2);   // mast
  const rotor = new THREE.Group(); rotor.position.set(0, 1.72, -0.2); g.add(rotor);
  for (let k = 0; k < 2; k++) { const b = new THREE.Mesh(new THREE.BoxGeometry(11, 0.05, 0.32), dark); b.rotation.y = k * Math.PI / 2; rotor.add(b); }
  const disc = new THREE.Mesh(new THREE.CircleGeometry(5.5, 32), new THREE.MeshBasicMaterial({ color: 0x30343a, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
  disc.rotation.x = -Math.PI / 2; rotor.add(disc);
  const tail = new THREE.Group(); tail.position.set(0.18, 1.0, 7.0); g.add(tail);
  for (let k = 0; k < 2; k++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.8, 0.16), dark); b.rotation.x = k * Math.PI / 2; tail.add(b); }
  return { group: g, rotor, tail };
}
