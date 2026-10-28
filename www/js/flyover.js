// Flyover (v1046, requested: "a flyover feature in the app ... a table of places, and they would check which ones
// they wanted to fly over"; v1048: "I want the helicopter to fly around, giving the tour"): the red helicopter from
// the sailors-page videos (heli3d.js) flies Bird's-eye through a list of stops, the camera riding just behind her,
// climbing for the long hops and coming down low at each place. Each stop's name is said as it comes into view
// (tts.js, the device's voice), and the camera turns slowly round it for a few seconds before going on. A stop can be a
// vessel (bay3d.js adds the ships near the way): the camera keeps up with her while she moves, and her card opens.
// She takes off from a pad (the bay's heliport, regions3d.js, or a spot you pick; v1049: "We should always take off
// from the same place ... a way to specify takeoff and landing spot"): the rotors wind up, she lifts off and climbs
// away, the camera swinging round from her side to astern of her. At the end she comes in over the landing pad (the
// take-off one, unless you've picked another, or none), settles down onto it and winds down, and waits there.
// Any drag, zoom or tap pauses the tour: she hovers where she is while you look round; ▶ and she comes back in
// front of you and goes on to the same stop; ✕ ends it.
// This module is only the flying, the voice and the bar along the top; bay3d.js chooses and orders the stops.

import * as THREE from 'three';
import { makeHeli } from './heli3d.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// what the device's voice gets instead (the names it says wrong; design/pending/voice/lexicon.json has Piper's)
const RESPELL = { Vinalhaven: 'Vynalhaven', Carquinez: 'Carkeenez', Rafael: 'Ruffelle', Tiburon: 'Tibberon', buoy: 'booey' };
const spoken = s => s.replace(/\b[A-Za-z]+\b/g, w => RESPELL[w] || RESPELL[w.toLowerCase()] || w);

let TTS = null;
import('./tts.js').then(m => { TTS = m; }).catch(() => {});   // (no speech on this device: the tour flies silent)

// stop: { name, say?, target() → { x, z, dist, az, tilt } (radians), hold (s), onArrive?(), onLeave?() }
// spot (take-off and landing): { name, x, z, y() → the ground's height there }
export function makeFlyover({ view, bar, camera, scene, onEnd }) {
  let tour = null, spots = { from: null, to: null }, parked = null;
  // the helicopter: ahead of the camera and a little below, her nose the way we look, banked into the turns (as the
  // videos' recorder put her); paused, she hovers where she was; between tours she waits on her pad
  const heli = makeHeli(); heli.group.visible = false; scene.add(heli.group);
  const H = { prevAz: null, roll: 0, back: 1, hover: new THREE.Vector3() }, dir = new THREE.Vector3(), at = new THREE.Vector3();
  const SKID = 1.6, HIGH = 45;   // (her skids, below her middle; how high she climbs straight up)
  // helipads: a grey disc with a white ring and H, at the take-off and landing spots
  const padTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
    x.fillStyle = '#4a4f55'; x.beginPath(); x.arc(128, 128, 126, 0, 7); x.fill();
    x.strokeStyle = '#f2f2ee'; x.lineWidth = 12; x.beginPath(); x.arc(128, 128, 104, 0, 7); x.stroke();
    x.fillStyle = '#f2f2ee'; x.fillRect(84, 66, 20, 124); x.fillRect(152, 66, 20, 124); x.fillRect(84, 118, 88, 20);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const pads = [0, 1].map(() => { const m = new THREE.Mesh(new THREE.CircleGeometry(11, 40), new THREE.MeshLambertMaterial({ map: padTex, polygonOffset: true, polygonOffsetFactor: -4 })); m.rotation.x = -Math.PI / 2; m.visible = false; scene.add(m); return m; });
  const putPads = () => [spots.from, spots.to].forEach((p, i) => { pads[i].visible = !!p; if (p) pads[i].position.set(p.x, p.y() + 0.25, p.z); });
  const text = bar.querySelector('.fly-text'), playBtn = bar.querySelector('.fly-play'), endBtn = bar.querySelector('.fly-end');
  const caption = s => { text.textContent = s; };
  const speak = s => { if (tour?.talk && s) try { TTS?.sayImmediate(spoken(s)); } catch (_) {} };
  const hush = () => { try { TTS?.stop(); } catch (_) {} };
  const smooth = u => u * u * (3 - 2 * u);
  const bearing = (a, b) => Math.atan2(b.x - a.x, -(b.z - a.z));

  // the view of her over a pad: e = 0 on it (from her side, close), 1 up at HIGH (astern of her, further back). The
  // target is where the line through her meets sea level, so she's in the middle however high the ground is.
  function padView(p, e, nose, hy) {
    const az = nose + (1 - e) * 1.25, tilt = (64 - 6 * e) * Math.PI / 180, fwd = hy * Math.tan(tilt);
    return { x: p.x + Math.sin(az) * fwd, z: p.z - Math.cos(az) * fwd, dist: 48 + 140 * e, tilt, az };
  }
  function leg(now) {   // from wherever the camera is now to stop i
    const S = tour.stops[tour.i];
    if (S.land) tour.landNose = bearing(view, S);   // (she comes in over the pad on the line she's flying)
    const to = S.target(), from = { ...view };
    const hop = Math.hypot(to.x - from.x, to.z - from.z);
    // long hops fly higher, as flyTo does, and take longer, but never so fast the ground can't keep up
    const peak = Math.max(from.dist, to.dist, hop * 0.6);
    let daz = (to.az - from.az) % (2 * Math.PI); if (daz > Math.PI) daz -= 2 * Math.PI; if (daz < -Math.PI) daz += 2 * Math.PI;
    Object.assign(tour, { phase: 'fly', t0: now, from, daz, dur: clamp(3.5 + hop / 1300, 4, 18) * 1000, pin: null,
      bump: Math.max(0, Math.log(peak) - Math.max(Math.log(from.dist), Math.log(to.dist))), spoke: false });
    const n = tour.stops.filter(s => !s.land).length;
    caption(S.land ? S.name : `${tour.i + 1} of ${n} · ${S.name}`);
  }
  function arrive() {
    const S = tour.stops[tour.i];
    tour.spoke = true; speak(S.say ?? S.name); S.onArrive?.();
  }
  function next(now) {
    tour.stops[tour.i].onLeave?.();
    tour.i++;
    if (tour.i >= tour.stops.length) { end('done'); return; }
    leg(now);
  }
  // the take-off: on the pad 3 s (the rotors winding up), then 4.5 s straight up and away, the view swinging round
  // from her side to astern of her
  const UP = 3000, CLIMB = 4500;
  function takeoff(now) {
    const p = spots.from, L = now - tour.t0, e = smooth(clamp((L - UP) / CLIMB, 0, 1)), gy = p.y();
    tour.spin = clamp(L / UP, 0.15, 1);
    const hy = gy + SKID + HIGH * e * e;
    Object.assign(view, padView(p, e, tour.noseAz, hy));
    tour.pin = { x: p.x, y: hy, z: p.z, nose: tour.noseAz, pitch: -0.12 * e };
    if (L >= UP + CLIMB) { tour.ground = false; tour.spin = 1; H.hover.set(p.x, hy, p.z); H.back = 0; H.prevAz = null; leg(now); }
  }
  // the landing: 2 s to settle over the pad, 4.5 s down (the view swinging round to her side), 2.5 s winding down
  const SETTLE = 2000, DOWN = 4500, WIND = 2500;
  function landing(now) {
    const p = tour.stops[tour.i], L = now - tour.t0, e = 1 - smooth(clamp((L - SETTLE) / DOWN, 0, 1)), gy = p.y();
    const hy = gy + SKID + HIGH * e * e, k = smooth(clamp(L / SETTLE, 0, 1));
    Object.assign(view, padView(p, e, tour.landNose, hy));
    at.set(p.x, hy, p.z).lerp(H.hover, 1 - k);
    tour.pin = { x: at.x, y: at.y, z: at.z, nose: tour.landNose, pitch: -0.12 * e };
    tour.spin = 1 - 0.85 * clamp((L - SETTLE - DOWN) / WIND, 0, 1);
    if (L >= SETTLE + DOWN + WIND) end('landed');
  }
  function step(now, dt) {
    if (!tour || tour.paused) return;
    if (tour.ground) { takeoff(now); return; }
    if (tour.phase === 'land') { landing(now); return; }
    const S = tour.stops[tour.i], to = S.target?.();
    if (!to) { next(now); return; }   // (a vessel that's gone)
    if (tour.phase === 'fly') {
      const u = clamp((now - tour.t0) / tour.dur, 0, 1), e = smooth(u), f = tour.from;
      view.x = f.x + (to.x - f.x) * e; view.z = f.z + (to.z - f.z) * e;
      view.az = f.az + tour.daz * e; view.tilt = f.tilt + (to.tilt - f.tilt) * e;
      view.dist = Math.exp(Math.log(f.dist) + (Math.log(to.dist) - Math.log(f.dist)) * e + tour.bump * Math.sin(Math.PI * u));
      if (!tour.spoke && u > 0.7) arrive();
      if (u >= 1) {
        if (S.land) { tour.phase = 'land'; tour.t0 = now; H.hover.copy(heli.group.position); }
        else { tour.phase = 'hold'; tour.t0 = now; tour.az = view.az; }
      }
    } else {   // round her slowly, keeping up if she's under way
      tour.az += dt * 0.07;
      Object.assign(view, { x: to.x, z: to.z, dist: to.dist, tilt: to.tilt, az: tour.az });
      if (now - tour.t0 > S.hold * 1000) next(now);
    }
  }
  const pose = (x, y, z, nose, pitch = 0) => { heli.group.position.set(x, y, z); heli.group.rotation.set(0, 0, 0); heli.group.rotateY(-nose); heli.group.rotateX(pitch); };
  // after the camera's placed for the frame (bay3d.js)
  function place(dt) {
    if (!tour) {   // waiting on her pad (the ground under it may still be loading)
      if (parked) pose(parked.p.x, parked.p.y() + SKID, parked.p.z, parked.nose);
      if (spots.from || spots.to) putPads();
      return;
    }
    heli.rotor.rotation.y += dt * 22 * tour.spin; heli.tail.rotation.x += dt * 32 * tour.spin;
    if (tour.paused) return;   // (hovering)
    putPads();
    if (tour.pin) { const P = tour.pin; pose(P.x, P.y, P.z, P.nose, P.pitch); return; }   // (taking off or landing)
    const cam = camera.position;
    dir.set(view.x - cam.x, -cam.y, view.z - cam.z).normalize();
    const D = Math.min(60, 26 + view.dist * 0.004) * (camera.aspect < 1 ? 1.5 : 1);   // (a phone held upright: a little further off)
    at.set(cam.x + dir.x * D, cam.y + dir.y * D - D * 0.34, cam.z + dir.z * D);
    if (H.back < 1) { H.back = Math.min(1, H.back + dt / 1.5); at.lerpVectors(H.hover, at, smooth(H.back)); }   // (back in front of you after a pause or the take-off)
    heli.group.position.copy(at);
    let turn = 0; if (H.prevAz != null && dt > 0) { let d = view.az - H.prevAz; d = Math.atan2(Math.sin(d), Math.cos(d)); turn = d / dt * 180 / Math.PI; }
    H.prevAz = view.az;
    H.roll += (clamp(-turn * 1.6, -28, 28) - H.roll) * Math.min(1, dt * 2);
    heli.group.rotation.set(0, 0, 0); heli.group.rotateY(-view.az); heli.group.rotateZ(H.roll * Math.PI / 180); heli.group.rotateX(-0.09);
  }
  function park(p, nose = 0) { parked = p ? { p, nose } : null; heli.group.visible = !!p; }
  // where she takes off from and lands (null: no landing, the tour ends in the air); she waits on the take-off pad
  function setSpots(from, to) {
    spots = { from, to }; putPads();
    if (!tour) park(from, parked?.p === from ? parked.nose : 0);
  }
  function start(stops, { talk = true } = {}) {
    if (!stops.length) return;
    end();
    const to = spots.to, from = spots.from;
    if (to) stops = [...stops, { name: `Landing at ${to.name}`, say: `Landing at ${to.name}`, land: true, x: to.x, z: to.z, y: to.y, hold: 0,
      target: () => padView(to, 1, tour.landNose, to.y() + SKID + HIGH) }];
    tour = { stops, i: 0, talk, paused: false, spin: 1, pin: null };
    parked = null; heli.group.visible = true; H.prevAz = null; H.roll = 0; H.back = 1;
    bar.hidden = false; playBtn.textContent = '⏸'; playBtn.title = 'Pause the flyover';
    if (from) {   // on the pad, her nose toward the first stop
      Object.assign(tour, { ground: true, t0: performance.now(), noseAz: bearing(from, stops[0]), spin: 0.15 });
      caption(`Taking off from ${from.name}`); speak(`Taking off from ${from.name}`);
      takeoff(tour.t0);
    } else leg(performance.now());
  }
  function pause() {
    if (!tour || tour.paused) return;
    tour.paused = true; hush(); H.hover.copy(heli.group.position);
    playBtn.textContent = '▶'; playBtn.title = 'Go on with the flyover';
    caption(`Paused · next: ${tour.stops[tour.i].name}`);
  }
  function resume() {
    if (!tour || !tour.paused) return;
    tour.paused = false; playBtn.textContent = '⏸'; playBtn.title = 'Pause the flyover'; H.back = 0; H.prevAz = null;
    tour.ground = false; tour.spin = 1;   // (paused on the pad or climbing: she goes straight on to the first stop; landing: she comes round again)
    leg(performance.now());   // (back to the stop it was at, from wherever you've moved to)
  }
  function end(why) {
    if (!tour) return;
    const t = tour; tour = null;
    t.stops[t.i]?.onLeave?.(); hush();
    const later = (s, then) => { caption(s); playBtn.hidden = true; setTimeout(() => { if (!tour) { bar.hidden = true; playBtn.hidden = false; then?.(); } }, 2500); };
    if (why === 'landed') { const p = t.stops[t.i]; park(p, t.landNose); later(`Landed at ${p.name.replace(/^Landing at /, '')}`); }
    else if (why === 'done') later('Flyover done', () => park(spots.from));
    else { bar.hidden = true; park(spots.from); }
    onEnd?.(why);
  }
  playBtn.addEventListener('click', () => tour?.paused ? resume() : pause());
  endBtn.addEventListener('click', () => end());
  addEventListener('keydown', e => { if (e.key === 'Escape' && tour) end(); });
  return { start, step, place, pause, end, setSpots, active: () => !!tour && !tour.paused, on: () => !!tour };
}

// the order to fly them in: nearest first from where you are, then any two crossing legs uncrossed (2-opt)
export function orderStops(stops, from) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z), left = stops.slice(), out = [];
  let at = from;
  while (left.length) { left.sort((a, b) => d(at, a) - d(at, b)); at = left.shift(); out.push(at); }
  const len = r => r.reduce((s, p, i) => s + d(i ? r[i - 1] : from, p), 0);
  for (let better = true, n = 0; better && n < 50; n++) {
    better = false;
    for (let i = 0; i < out.length - 1; i++) for (let j = i + 1; j < out.length; j++) {
      const r = [...out.slice(0, i), ...out.slice(i, j + 1).reverse(), ...out.slice(j + 1)];
      if (len(r) < len(out) - 1) { out.splice(0, out.length, ...r); better = true; }
    }
  }
  return out;
}

// how far a point is from the line between two others (for the ships near the way)
export function offLeg(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1, u = clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / L2, 0, 1);
  return { d: Math.hypot(p.x - (a.x + dx * u), p.z - (a.z + dz * u)), u };
}
