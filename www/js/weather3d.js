// Weather and time of day for the 3D views (helm3d.html and bay3d.html), shared since v860.
// One set of conditions, four independent choices that combine:
//   time  day | dawn | sunset | night    the light: sun or moon, sky colours, lights coming on
//   vis   clear | haze | fog | thick     how far you can see, and how far lights and labels carry
//   sky   fair | overcast | rain         a cloud deck, flat light, rain streaks
//   wind  calm | breezy | fresh | rough  sea state, whitecaps (windFrom: degrees)
//   moon  tonight | new | crescent | quarter | gibbous | full   the moon's phase at night (v912)
// Each view builds its sky, water and clouds, hands them to makeEnv(), and calls env.apply(C)
// whenever the conditions change and env.update() every frame; the view adds what is its own
// (the helm view's running lights and boat motion, the bird's-eye view's fog blanket).
// The Weather panel (weatherPanel) and the NWS forecast are here too. The choice is shared by
// both views and remembered.
import * as THREE from 'three';

const rad = THREE.MathUtils.degToRad;
export const sunAt = (alt, brg) => new THREE.Vector3().setFromSphericalCoords(1, rad(90 - alt), rad(180 - brg));   // theta runs from south
export const SUN = new THREE.Vector3().setFromSphericalCoords(1, rad(90 - 32), rad(205));   // the views' clear-day sun
export const MOON = sunAt(22, 150);
export const TIMES = {
  day:    { exp: 0.55, sky: 0xe4ecf2, gnd: 0x4a5644, hemi: 1.7, dlc: 0xfff3e0, dl: 2.1, dir: SUN, haze: 0xb2cbe0, zen: 0x2f62a8, water: 0x3268a0, glint: 0xfff4e0, glow: [1, 0.95, 0.85], lights: 0, fog: 0xbcc5cc, cloud: 0xffffff, over: 0x9aa3ab, deck: 0xa9b1b8 },
  sunset: { exp: 0.6, sky: 0xffc49a, gnd: 0x3b3631, hemi: 0.95, dlc: 0xffa055, dl: 2.0, dir: sunAt(4, 282), haze: 0xeaa47c, zen: 0x2e4a7a, water: 0x2b4a6e, glint: 0xffa860, glow: [1, 0.62, 0.32], lights: 0.55, fog: 0xbfa194, cloud: 0xffc6a0, over: 0x857a7e, deck: 0x8f8384 },
  dawn:   { exp: 0.58, sky: 0xd9c8e2, gnd: 0x35363c, hemi: 1.0, dlc: 0xffc49a, dl: 1.7, dir: sunAt(4, 72), haze: 0xe8bfb2, zen: 0x35558c, water: 0x2c4c72, glint: 0xffcf9c, glow: [1, 0.78, 0.58], lights: 0.35, fog: 0xc4b8b6, cloud: 0xffd9cc, over: 0x8c8a93, deck: 0x9a96a0 },
  night:  { exp: 0.55, sky: 0x8aa2c8, gnd: 0x1a2129, hemi: 0.62, dlc: 0xc6d4ee, dl: 0.75, dir: MOON, haze: 0x152236, zen: 0x03070f, water: 0x0c1e33, glint: 0x37415a, glow: [0, 0, 0], lights: 1, fog: 0x1a2330, cloud: 0x3a4250, over: 0x0f141b, deck: 0x151a21 },
};
// An overnight stop on a Virtual Journey (v887): from the current time of day through sunset,
// night and dawn to day, u (0–1) of the way through, as a blend of the TIMES looks; the views
// apply it by setting env.blendT for one applyConditions call.
const CYCLE = ['sunset', 'night', 'dawn', 'day'];
function blendTimes(A, B, k) {
  const T = {};
  for (const key in A) {
    const a = A[key], b = B[key];
    if (key === 'dir') T.dir = a.clone().lerp(b, k).normalize();
    else if (Array.isArray(a)) T[key] = a.map((v, j) => v + (b[j] - v) * k);
    else if (key === 'exp' || key === 'hemi' || key === 'dl' || key === 'lights') T[key] = a + (b - a) * k;
    else T[key] = new THREE.Color(a).lerp(new THREE.Color(b), k).getHex();
  }
  return T;
}
export function cycleLook(from, u) {
  const seq = [TIMES[from] ? from : 'day', ...CYCLE], x = Math.min(0.9999, Math.max(0, u)) * (seq.length - 1), i = Math.floor(x), k = x - i;
  return { time: k < 0.5 ? seq[i] : seq[i + 1], T: blendTimes(TIMES[seq[i]], TIMES[seq[i + 1]], k), hour: x < 2 ? 18.5 + (x - 1) * 5.5 : 24 + (x - 2) * 5.5 };   // hour: for the moon (sunset 6:30 pm, midnight, dawn 5:30 am)
}
export const VIS_M = { clear: 26000, haze: 8000, fog: 900, thick: 250 };   // metres to where the fog is ~98% thick
export const WINDS = {
  calm:   { dist: 0.5, size: 8, speed: 0.35, heel: 0, move: 0.35, foam: 0, tws: 2, kn: '0–4 kn' },
  breezy: { dist: 1.2, size: 6, speed: 0.6, heel: 5, move: 1, foam: 0, tws: 8, kn: '5–11 kn' },
  fresh:  { dist: 2.2, size: 4, speed: 0.9, heel: 12, move: 1.8, foam: 0.55, tws: 15, kn: '12–19 kn' },
  rough:  { dist: 3.4, size: 2.6, speed: 1.3, heel: 18, move: 3, foam: 1, tws: 24, kn: '20+ kn' },
};
export const DEFAULT_COND = { time: 'day', vis: 'clear', sky: 'fair', wind: 'breezy', windFrom: 225, moon: 'tonight' };
// The moon's phase (v912, requested: "a setting for the moon phase, so we can see it at night"):
// phase angle 0 = new, π = full, and which side is lit (+1 waxing: the right-hand side, toward where the
// sun set, as seen from Maine). "Tonight" is the real phase for today's date, from the mean synodic month
// counted from the new moon of 6 Jan 2000 18:14 UTC (good to within a day or so).
export const MOON_PHASES = { tonight: null, new: [0, 1], crescent: [Math.PI / 3, 1], quarter: [Math.PI / 2, 1], gibbous: [2 * Math.PI / 3, 1], full: [Math.PI, 1] };
export function moonPhase(name, when = Date.now()) {
  const fixed = MOON_PHASES[name];
  if (fixed) return { phi: fixed[0], side: fixed[1] };
  const SYN = 29.530588853, age = (((when - Date.UTC(2000, 0, 6, 18, 14)) / 86400000) % SYN + SYN) % SYN;
  return { phi: 2 * Math.PI * age / SYN, side: age < SYN / 2 ? 1 : -1, age };
}
// Where that moon is in the sky (v913, requested: "move the moon with its phase"): from its elongation
// from the sun, the date's sun on the ecliptic, and Penobscot Bay's latitude, at the night-time hour that
// shows it best (nearest 9 pm for a waxing moon, 4 am for a waning one, while the sky is dark and the moon
// 10–24° up, in sight from the deck). So a crescent hangs low in the west after dusk, a first quarter
// in the south-west, a full moon rises in the east, and a waning moon is in the east before dawn.
// Returns the moon's direction, the sun's (below the horizon, to light the right side of the disc),
// and alt/brg/hour for the record.
// It moves across the sky through the night (v915, requested: "make the moon move across the sky during
// the night"): given `hour` (local, 17–31 = 5 pm to 7 am) it's where it is then. `win` is the stretch of
// the dark night the moon is up, round that best hour, for the night clock to run over; `up` (0–1) fades
// it out as it sets. When it isn't up in the dark at all (near new) it stays put, 6° up, as before.
export function moonSky(name, when = Date.now(), hour = null) {
  const MP = moonPhase(name, when), e = MP.phi;   // phi runs 0–2π through the month: the elongation east of the sun
  const EPS = rad(23.44), LAT = rad(44.2);
  const doy = (when - Date.UTC(new Date(when).getUTCFullYear(), 0, 1)) / 86400000;
  const ls = 2 * Math.PI * (doy - 79.5) / 365.25, lm = ls + e;
  const eq = l => ({ dec: Math.asin(Math.sin(EPS) * Math.sin(l)), ra: Math.atan2(Math.cos(EPS) * Math.sin(l), Math.cos(l)) });
  const S = eq(ls), M = eq(lm);
  const altAz = (H, dec) => ({ alt: Math.asin(Math.sin(LAT) * Math.sin(dec) + Math.cos(LAT) * Math.cos(dec) * Math.cos(H)),
    az: Math.atan2(-Math.cos(dec) * Math.sin(H), Math.sin(dec) * Math.cos(LAT) - Math.cos(dec) * Math.cos(H) * Math.sin(LAT)) });
  const deg = THREE.MathUtils.radToDeg, pref = MP.side > 0 ? 21 : 28;
  const at = t => { const Hs = rad((t - 12) * 15); return { t, s: altAz(Hs, S.dec), m: altAz(Hs - (M.ra - S.ra), M.dec) }; };
  const ok = q => deg(q.s.alt) <= -10 && deg(q.m.alt) > 0;   // dark, and the moon up
  let best = null;
  for (let t = 17; t <= 31; t += 0.25) {
    const q = at(t), a = deg(q.m.alt), cost = Math.abs(t - pref) / 2 + Math.max(0, 10 - a) + Math.max(0, a - 24) * 1.5 + (deg(q.s.alt) > -10 ? 100 : 0);
    if (!best || cost < best.cost) best = { cost, ...q };
  }
  let win = null;
  if (ok(best)) { let w0 = best.t, w1 = best.t; while (w0 > 17 && ok(at(w0 - 0.25))) w0 -= 0.25; while (w1 < 31 && ok(at(w1 + 0.25))) w1 += 0.25; if (w1 - w0 >= 0.5) win = [w0, w1]; }
  const q = win && hour != null ? at(Math.min(win[1] + 0.5, Math.max(win[0] - 0.5, hour))) : best;
  const raw = deg(q.m.alt), alt = win ? Math.max(-3, raw) : Math.max(6, raw), brg = (deg(q.m.az) + 360) % 360;
  const up = win ? THREE.MathUtils.smoothstep(raw, -0.5, 2) : 1;
  return { dir: sunAt(alt, brg), light: sunAt(Math.max(3, alt), brg), sun: sunAt(deg(q.s.alt), (deg(q.s.az) + 360) % 360), alt, brg, up, hour: q.t % 24, best: best.t, win, ...MP };
}
const moonIcon = ({ phi, side }) => { const k = (1 - Math.cos(phi)) / 2; return k < 0.06 ? '🌑' : k > 0.94 ? '🌕' : k < 0.4 ? (side > 0 ? '🌒' : '🌘') : k < 0.6 ? (side > 0 ? '🌓' : '🌗') : (side > 0 ? '🌔' : '🌖'); };
const KEY = 'audiochart-helm3d-conditions';
const MOON_LAPSE = 60;   // with no journey under way the night clock runs 60× (an hour of the moon's travel a minute), or you'd never see it move; on one, at its rate (env.moonRate)

// The sky dome: deep blue overhead fading to the haze colour at the horizon (so distant land and
// water blend into it), with the sun's glow, or the moon's disc and halo at night.
export function makeSky(radius) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false, toneMapped: false,
    uniforms: { zenith: { value: new THREE.Color(0x2f62a8) }, horizon: { value: new THREE.Color(0xb2cbe0) }, sunDir: { value: SUN.clone() }, moonK: { value: 0 }, moonPhase: { value: Math.PI }, moonTilt: { value: 0 }, sunCol: { value: new THREE.Vector3(1, 0.95, 0.85) } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 zenith; uniform vec3 horizon; uniform vec3 sunDir; uniform float moonK; uniform float moonPhase; uniform float moonTilt; uniform vec3 sunCol; varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        vec3 c = mix(horizon, zenith, pow(h, 0.55));
        float g = max(dot(d, sunDir), 0.0);
        c += sunCol * (pow(g, 300.0) * 1.2 + pow(g, 12.0) * 0.12) * (1.0 - moonK);   // the sun's glow by day
        // the moon at night (sunDir holds its direction): a sphere lit from its phase angle, the dark side
        // faint with earthshine, a hint of the maria, and a halo as bright as the moon is full (v912); the lit
        // side turned toward the sun below the horizon (moonTilt, v913)
        vec3 rt = normalize(cross(sunDir, vec3(0.0, 1.0, 0.0))), up = cross(rt, sunDir);
        vec2 q = vec2(dot(d, rt), dot(d, up)) / 0.0105;
        float r2 = dot(q, q), disc = (1.0 - smoothstep(0.86, 1.0, r2)) * step(0.0, dot(d, sunDir));
        vec3 n = vec3(q, sqrt(max(0.0, 1.0 - r2)));
        float lit = smoothstep(-0.07, 0.07, dot(n, vec3(abs(sin(moonPhase)) * cos(moonTilt), abs(sin(moonPhase)) * sin(moonTilt), -cos(moonPhase))));
        float mare = 0.84 + 0.16 * sin(q.x * 4.3 + 1.3) * sin(q.y * 3.7 - 0.7);
        float k = 0.5 - 0.5 * cos(moonPhase);
        c = mix(c, mix(vec3(0.045, 0.05, 0.065), vec3(0.93, 0.94, 0.88) * mare, lit), disc * moonK);
        c += vec3(0.55, 0.62, 0.75) * (pow(g, 2000.0) * 0.35 + pow(g, 30.0) * 0.05) * k * (1.0 - disc) * moonK;
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  }));
  m.renderOrder = -1; m.frustumCulled = false;
  return m;
}

// Glows for lights: a soft round sprite, the same size on screen however far off, or `metres` across
const GLOW = (() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64; const c = cv.getContext('2d');
  const gr = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.15, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.2)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = gr; c.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(cv);
})();
export function glowSprite(color, size, metres = false) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false, toneMapped: false, sizeAttenuation: metres }));
  sp.scale.setScalar(size); sp.visible = false; return sp;
}
// A sector light's colour as seen from `bearing` (true, from the boat to the light) (v918, requested:
// "show the white sectors of lights too"). `sec` is the chart's sectors ({c: 'red', a, b}: from a clockwise
// to b, bearings from seaward); outside them the light's own colour `col`, or dark (null) for a light that
// shows only in its sectors (`only`). E.g. Browns Head: white, red from 1° to 50° and 61° to 91°.
const SECTOR_COL = { white: 0xfff6d8, red: 0xff4b3a, green: 0x5dff8a, yellow: 0xffd75a };
export function sectorColour(sec, only, col, bearing) {
  if (!sec) return col;
  const b = ((bearing % 360) + 360) % 360;
  for (const s of sec) if ((b - s.a + 360) % 360 <= (s.b - s.a + 360) % 360) return SECTOR_COL[s.c.split('/')[0]] ?? col;
  return only ? null : col;
}
// A charted light's characteristic ("Fl G 4s", "Iso W 6s", …) → its period, colour and rhythm
export function flashFor(ch) {
  if (!ch) return null;
  const per = parseFloat((ch.match(/(\d+(?:\.\d+)?)s/) || [])[1]) || (/^Q/.test(ch) ? 1 : 4);
  const col = /\bG\b/.test(ch) ? 0x5dff8a : /\bR\b/.test(ch) ? 0xff4b3a : /\bY\b/.test(ch) ? 0xffd75a : 0xfff6d8;
  return { per, col, iso: /^Iso|^Oc/.test(ch), fixed: /^F\b/.test(ch) };
}
export const flashOn = (fl, t) => { const ph = t % fl.per; return fl.fixed || (fl.iso ? ph < fl.per / 2 : ph < 0.45); };

// The environment: everything the conditions restyle. o = { renderer, scene, hemi, dl, sky, water,
// clouds, starsR (radius of the star field), deckSize, deckY, foamR, foamTile }.
export function makeEnv(o) {
  const { renderer, scene, hemi, dl, sky, water, clouds } = o;
  const stars = (() => {   // ~2,500 stars above the horizon, a few bright, fixed to the sky dome
    const n = 2500, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), R = o.starsR;
    let sd = 7; const rr = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < n; i++) {
      const y = Math.pow(rr(), 0.8), a = rr() * Math.PI * 2, r = Math.sqrt(1 - y * y), b = Math.pow(rr(), 6) * 0.9 + 0.12;
      pos.set([Math.cos(a) * r * R, y * R, Math.sin(a) * r * R], i * 3);
      const warm = rr(); col.set([b * (0.9 + warm * 0.1), b * 0.95, b * (1.05 - warm * 0.12)], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const p = new THREE.Points(geo, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, fog: false, toneMapped: false, depthWrite: false }));
    p.renderOrder = -0.5; p.frustumCulled = false; p.visible = false; scene.add(p);
    return p;
  })();
  // overcast: a solid deck above the broken clouds, which turn grey under it
  const deck = new THREE.Mesh(new THREE.PlaneGeometry(o.deckSize, o.deckSize), new THREE.MeshBasicMaterial({ color: 0xa9b1b8, side: THREE.DoubleSide, fog: true, toneMapped: false }));
  deck.rotation.x = Math.PI / 2; deck.position.y = o.deckY; deck.visible = false; scene.add(deck);
  // whitecaps (fresh and rough): sparse ragged white flecks over a disc round a point, fading out
  // with distance, fixed to the water (the disc moves in whole texture tiles) and drifting downwind
  const TILE = o.foamTile;
  const foam = (() => {
    const N = 256, img = new ImageData(N, N);
    let sd = 3; const rr = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
    const sm = t => t * t * (3 - 2 * t);
    const oct = [[16, 0.55], [48, 0.3], [96, 0.15]].map(([L, w]) => ({ L, w, g: Float32Array.from({ length: L * L }, rr) }));
    const noise = (x, y) => {
      let v = 0;
      for (const { L, w, g } of oct) {
        const at = (i, j) => g[((j % L) + L) % L * L + ((i % L) + L) % L];
        const fx = x / N * L, fy = y / N * L, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = sm(fx - x0), ty = sm(fy - y0);
        const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx, b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
        v += (a + (b - a) * ty) * w;
      }
      return v;
    };
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const v = noise(x, y), ix = (y * N + x) * 4, k = Math.max(0, Math.min(1, (v - 0.74) / 0.06)) * (0.5 + 0.5 * rr());
      img.data[ix] = img.data[ix + 1] = img.data[ix + 2] = 255; img.data[ix + 3] = k * 255;
    }
    const cv = document.createElement('canvas'); cv.width = cv.height = N; cv.getContext('2d').putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    const R = o.foamR, geo = new THREE.CircleGeometry(R, 48);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position, uv = geo.attributes.uv, cols = new Float32Array(p.count * 4);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      uv.setXY(i, x / TILE, -z / TILE);
      cols.set([1, 1, 1, Math.max(0, 1 - Math.hypot(x, z) / R) ** 1.5], i * 4);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 4));
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, vertexColors: true, transparent: true, depthWrite: false, fog: true, toneMapped: false }));
    m.position.y = 0.06; m.renderOrder = 1; m.visible = false; scene.add(m);
    return m;
  })();
  // rain: short falling streaks in a box round the eye, slanting downwind
  const RAIN_N = 1600;
  const rain = (() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAIN_N * 6), 3));
    const m = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xc6d0da, transparent: true, opacity: 0.38, fog: false, depthWrite: false, toneMapped: false }));
    m.frustumCulled = false; m.visible = false; scene.add(m);
    m.userData.drops = Float32Array.from({ length: RAIN_N * 3 }, (_, i) => i % 3 === 1 ? Math.random() * 60 : (Math.random() - 0.5) * 80);
    return m;
  })();
  // none of these show in the water's reflection: ripples break starlight up, and the foam and rain are on or over it
  { const mirror = water.onBeforeRender; water.onBeforeRender = (...a) => { const v = [stars.visible, foam.visible, rain.visible]; stars.visible = foam.visible = rain.visible = false; mirror(...a); [stars.visible, foam.visible, rain.visible] = v; }; }

  const col = h => new THREE.Color(h), _v = new THREE.Vector3(), _u = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  const env = { stars, deck, foam, rain, C: { ...DEFAULT_COND }, T: TIMES.day, W: WINDS.breezy, visM: VIS_M.clear, lightsK: 0, foggy: false, over: false, wet: false, night: false, fogC: col(0xb2cbe0) };
  // The sun's or the moon's light: its direction for the sky's glow, the light on the scene and the glint on
  // the water. At night the moon's place comes from the night clock (moonHour); a new moon's night, or one
  // after the moon has set, is darker.
  const nightHour = () => {
    if (env.blendHour != null) return env.blendHour;   // an overnight stop sets the hour itself
    const key = env.C.moon + new Date().toDateString(), R = env.moonRun, now = performance.now();
    if (!R || R.key !== key) { const m = moonSky(env.C.moon); env.moonRun = { key, win: m.win, h: m.best, t: now }; return m.best; }
    const dt = (now - R.t) / 1000; R.t = now;
    if (!R.win) return R.h;
    R.h += dt * (env.moonRate ?? MOON_LAPSE) / 3600;   // at the Virtual Journey's rate (v916), paused with it
    if (R.h > R.win[1]) R.h = R.win[0] + (R.h - R.win[1]) % (R.win[1] - R.win[0]);   // round again from moonrise (or dusk) once it sets (or dawn comes)
    return R.h;
  };
  env.setMoonRate = r => { if (env.night && env.blendHour == null && env.moonRun) nightHour(); env.moonRate = r; };   // the time so far at the old rate
  const setLight = () => {
    const { C, T, night, over, foggy } = env, su = sky.material.uniforms, wu = water.material.uniforms;
    const MP = env.moon = moonSky(C.moon, Date.now(), night ? nightHour() : null), moonLit = (1 - Math.cos(MP.phi)) / 2 * MP.up;   // 0 new (or set) … 1 full
    const dir = env.dir = night ? MP.dir : T.dir, ld = night ? MP.light : T.dir;   // at night the light, the sky's glow and the glint on the water come from the moon
    su.sunDir.value.copy(dir).normalize();
    su.moonK.value = night && !over && (!foggy || env.aboveFog) ? MP.up : 0;
    su.moonPhase.value = MP.phi;
    { const rt = _v.crossVectors(dir, Y).normalize(), up = _u.crossVectors(rt, dir); su.moonTilt.value = Math.atan2(MP.sun.dot(up), MP.sun.dot(rt)); }
    dl.intensity = T.dl * (over ? 0.25 : 1) * (foggy ? 0.5 : 1) * (night ? 0.3 + 0.7 * moonLit : 1); dl.position.copy(ld).multiplyScalar(1000);
    wu.sunColor.value.set(col(T.glint).multiplyScalar((over ? 0.12 : 1) * (foggy ? 0.3 : 1) * (night ? 0.15 + 0.85 * moonLit : 1)));   // the moon's path on the water
    wu.sunDirection.value.copy(ld).normalize();
  };
  let moonTick = 0;
  env.apply = (next = {}) => {
    const C = Object.assign(env.C, next);
    const T = env.T = env.blendT || TIMES[C.time] || TIMES.day, over = env.over = C.sky !== 'fair', wet = env.wet = C.sky === 'rain', night = env.night = C.time === 'night';
    env.W = WINDS[C.wind] || WINDS.breezy;
    env.visM = Math.min(VIS_M[C.vis] || VIS_M.clear, wet ? 6000 : Infinity);
    const foggy = env.foggy = env.visM < 2000;
    // lights: at dusk and night, and (as vessels must) in fog
    env.lightsK = Math.max(T.lights, foggy ? 0.6 : 0, wet && !night ? 0.2 : 0);
    renderer.toneMappingExposure = T.exp;
    // what you see in the distance, and the sky over it
    const fogC = env.fogC = col(foggy || over ? T.fog : T.haze); if (wet) fogC.multiplyScalar(0.85);
    const zen = col(over ? T.over : T.zen); if (wet) zen.multiplyScalar(0.75);
    if (foggy) zen.lerp(fogC, 0.85);
    scene.fog.color.copy(fogC); scene.fog.density = 1.98 / env.visM;
    const su = sky.material.uniforms;
    su.horizon.value.copy(fogC); su.zenith.value.copy(zen);
    su.sunCol.value.fromArray(over || foggy ? [0, 0, 0] : T.glow);
    // light: flat and dim under cloud, softer in fog
    hemi.color.setHex(T.sky); hemi.groundColor.setHex(T.gnd); hemi.intensity = T.hemi * (over ? (wet ? 0.95 : 1.1) : 1);
    dl.color.setHex(T.dlc);
    // clouds: broken fair-weather cloud by day; a grey deck when overcast; none in fog or on a clear night
    env.cloudsOn = !foggy && (over || !night);
    clouds.material.color.set(over ? col(T.deck).multiplyScalar(wet ? 0.7 : 0.85) : col(T.cloud));
    env.deckOn = over && !foggy; deck.material.color.set(col(T.deck).multiplyScalar(wet ? 0.8 : 1));
    clouds.visible = env.cloudsOn; deck.visible = env.deckOn;
    stars.visible = night && !over && !foggy;
    // the sea
    const wu = water.material.uniforms;
    wu.waterColor.value.set(col(T.water).lerp(col(night ? 0x0c1218 : 0x4b5862), over ? 0.35 : 0).lerp(fogC, foggy ? 0.3 : 0));
    setLight();
    wu.distortionScale.value = env.W.dist + (wet ? 0.8 : 0); wu.size.value = env.W.size;
    env.foamOn = env.W.foam > 0; foam.visible = env.foamOn;
    foam.material.color.set(col(0xffffff).multiplyScalar(night ? 0.3 : T.lights ? 0.75 : 1)); foam.material.opacity = env.W.foam * 0.8;
    env.rainOn = wet; rain.visible = wet; rain.material.color.setHex(night ? 0x5d6672 : 0xc6d0da);
    document.body.classList.toggle('night', night);
    if (!night) env.moonRun = null;
    if (!env.blendT) try { localStorage.setItem(KEY, JSON.stringify(C)); } catch (_) {}   // not each frame of an overnight cycle
    return env;
  };
  // every frame: the sea moves, clouds drift, the foam follows `at` (a point on the water) and drifts, rain falls round the eye
  const _c = new THREE.Vector3();
  env.update = (dt, camera, at, foamScale = 1, foamLift = 0.06) => {
    const to = rad(env.C.windFrom + 180), wxv = Math.sin(to), wzv = -Math.cos(to);   // the way the wind blows, in x (east) and z (south)
    water.material.uniforms.time.value += dt * env.W.speed;
    if (env.night && env.blendHour == null && (moonTick += dt) > 0.5) { moonTick = 0; setLight(); }   // the moon moves on
    clouds.material.map.offset.x += dt * 0.0004 * wxv; clouds.material.map.offset.y += dt * 0.0004 * wzv;
    if (foam.visible) {
      const step = TILE * foamScale;   // seen from high up the flecks are drawn bigger (foamScale), over a wider disc
      foam.scale.setScalar(foamScale); foam.position.y = foamLift; foam.position.x = Math.round(at.x / step) * step; foam.position.z = Math.round(at.z / step) * step;
      foam.material.map.offset.x -= dt * 0.012 * wxv; foam.material.map.offset.y += dt * 0.012 * wzv;
    }
    if (rain.visible) {
      camera.getWorldPosition(_c);
      const d = rain.userData.drops, pos = rain.geometry.attributes.position.array, top = _c.y + 25, sl = 0.08 + env.W.move * 0.06;
      for (let i = 0; i < RAIN_N; i++) {
        let y = d[i * 3 + 1] - dt * 9; if (y < Math.max(0, _c.y - 40)) y += Math.min(top, 65);
        d[i * 3 + 1] = y;
        const x = _c.x + d[i * 3], z = _c.z + d[i * 3 + 2];
        pos.set([x, y, z, x - wxv * sl * 6, y + 0.7, z - wzv * sl * 6], i * 6);
      }
      rain.geometry.attributes.position.needsUpdate = true;
    }
  };
  return env;
}

// The conditions to start with: the URL (?time= &vis= &sky= &wind= &windFrom=, and the older
// ?night=1), else what was chosen last in either 3D view.
export function startConditions(params) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null') || (localStorage.getItem('audiochart-helm3d-night') === '1' ? { time: 'night' } : {}); } catch (_) {}
  const fromUrl = {};
  for (const k of ['time', 'vis', 'sky', 'wind', 'moon']) if (params.get(k)) fromUrl[k] = params.get(k);
  if (params.get('windFrom')) fromUrl.windFrom = Number(params.get('windFrom'));
  if (params.get('night') != null) fromUrl.time = params.get('night') === '1' ? 'night' : 'day';
  const ok = { time: TIMES, vis: VIS_M, sky: { fair: 1, overcast: 1, rain: 1 }, wind: WINDS, moon: MOON_PHASES };
  const start = { ...DEFAULT_COND, ...saved, ...fromUrl };
  for (const k of Object.keys(ok)) if (!(start[k] in ok[k])) start[k] = DEFAULT_COND[k];
  if (!(start.windFrom >= 0 && start.windFrom < 360)) start.windFrom = DEFAULT_COND.windFrom;
  return start;
}

// ── The Weather panel ──
// A "Weather ▾" button appended to `host`, opening a panel appended to `panelParent`: Forecast now,
// then Time, Visibility, Sky, Wind, Moon and Wind from. `where()` → [lon, lat] for the forecast;
// `pick(C)` applies a change. N toggles night. Returns { sync(C, W) } to show the current choice.
const PANEL_CSS = `
.wxbtn.on { background: #c9d4ea !important; color: #0b1626 !important; }
#wxpanel { position: absolute; z-index: 4; display: grid; gap: 4px; background: rgba(20,34,42,0.88); border-radius: 6px; padding: 8px; font: 0.78rem system-ui, -apple-system, sans-serif; color: #e6eef1; max-width: calc(100% - 24px); box-sizing: border-box; }
#wxpanel[hidden] { display: none; }
#wxpanel .wxrow { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; }
#wxpanel .wxrow > span { width: 5.6em; letter-spacing: 0.06em; text-transform: uppercase; font-size: 0.66rem; opacity: 0.85; }
#wxpanel button { font: inherit; color: inherit; background: transparent; border: 0; border-radius: 4px; padding: 3px 8px; cursor: pointer; }
#wxpanel button:hover { background: rgba(255,255,255,0.1); }
#wxpanel button.on { background: rgba(224,168,67,0.9); color: #1b2328; }
#wxpanel select { font: inherit; color: #1b2328; background: #e6eef1; border: 0; border-radius: 4px; padding: 2px 4px; }
#wxpanel em { font-style: normal; opacity: 0.75; margin-left: 8px; font-family: "JetBrains Mono", Menlo, monospace; font-size: 0.72rem; }
#wxpanel .wxfc { padding-bottom: 4px; margin-bottom: 2px; border-bottom: 1px solid rgba(230,238,241,0.18); gap: 8px; }
#wxpanel .wxfc button { background: rgba(255,255,255,0.12); }
#wxpanel .wxfc small { flex: 1 1 14em; min-width: 0; opacity: 0.85; line-height: 1.3; }`;
export function weatherPanel({ host, panelParent, where, pick, btnClass = '' }) {
  if (!document.getElementById('wxpanel-css')) { const st = document.createElement('style'); st.id = 'wxpanel-css'; st.textContent = PANEL_CSS; document.head.appendChild(st); }
  const ROWS = [
    ['time', 'Time', [['day', 'Day'], ['dawn', 'Dawn'], ['sunset', 'Sunset'], ['night', 'Night']]],
    ['vis', 'Visibility', [['clear', 'Clear'], ['haze', 'Haze'], ['fog', 'Fog'], ['thick', 'Thick fog']]],
    ['sky', 'Sky', [['fair', 'Fair'], ['overcast', 'Overcast'], ['rain', 'Rain']]],
    ['wind', 'Wind', [['calm', 'Calm'], ['breezy', 'Breezy'], ['fresh', 'Fresh'], ['rough', 'Rough']]],
    ['moon', 'Moon', [['tonight', 'Tonight'], ['new', '🌑 New'], ['crescent', '🌒 Crescent'], ['quarter', '🌓 Half'], ['gibbous', '🌔 Gibbous'], ['full', '🌕 Full']]],
  ];
  const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];   // 16 points (v869)
  const stop = e => e.stopPropagation();   // not a drag of the view underneath
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = ('wxbtn ' + btnClass).trim(); btn.setAttribute('aria-expanded', 'false');
  btn.title = 'Weather and time of day (N toggles night)';
  btn.addEventListener('pointerdown', stop);
  host.appendChild(btn);
  const panel = document.createElement('div'); panel.id = 'wxpanel'; panel.hidden = true;
  for (const ev of ['pointerdown', 'wheel', 'mousedown', 'touchstart']) panel.addEventListener(ev, stop, { passive: true });
  // Forecast: the National Weather Service's hourly gridpoint forecast at where(), for this hour
  const fcRow = document.createElement('div'); fcRow.className = 'wxrow wxfc';
  const fcBtn = document.createElement('button'); fcBtn.type = 'button'; fcBtn.textContent = '⟳ Forecast now';
  fcBtn.title = 'Set the weather from the National Weather Service forecast for here, this hour (needs internet)';
  const fcNote = document.createElement('small'); fcNote.textContent = 'or pick conditions below';
  fcRow.append(fcBtn, fcNote); panel.appendChild(fcRow);
  fcBtn.addEventListener('click', async () => {
    const [lon, lat] = where();
    fcBtn.disabled = true; fcNote.textContent = 'Asking the National Weather Service…';
    try { const { C, note } = await forecastConditions(lat, lon, new Date()); pick(C); fcNote.textContent = note; }
    catch (err) { fcNote.textContent = navigator.onLine === false ? 'Offline: the forecast needs internet. Pick conditions below.' : `No forecast (${err.message}). Pick conditions below.`; }
    fcBtn.disabled = false;
  });
  for (const [key, label, opts] of ROWS) {
    const row = document.createElement('div'); row.className = 'wxrow'; row.setAttribute('role', 'group'); row.setAttribute('aria-label', label);
    row.innerHTML = `<span>${label}</span>`;
    for (const [v, txt] of opts) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = txt; b.dataset.k = key; b.dataset.v = v;
      b.addEventListener('click', () => pick({ [key]: v })); row.appendChild(b);
    }
    panel.appendChild(row);
  }
  const dirRow = document.createElement('div'); dirRow.className = 'wxrow'; dirRow.innerHTML = '<span>Wind from</span>';
  const sel = document.createElement('select'); sel.setAttribute('aria-label', 'Wind direction');
  DIRS.forEach((d, i) => { const op = document.createElement('option'); op.value = String(i * 22.5); op.textContent = d; sel.appendChild(op); });
  sel.addEventListener('change', () => pick({ windFrom: Number(sel.value) }));
  const kn = document.createElement('em'); dirRow.append(sel, kn); panel.appendChild(dirRow);
  panelParent.appendChild(panel);
  btn.addEventListener('click', () => { panel.hidden = !panel.hidden; btn.setAttribute('aria-expanded', String(!panel.hidden)); });
  let cur = DEFAULT_COND;
  addEventListener('keydown', e => {
    if ((e.key === 'n' || e.key === 'N') && !e.metaKey && !e.ctrlKey && !/INPUT|SELECT/.test(e.target.tagName)) pick({ time: cur.time === 'night' ? 'day' : 'night' });
  });
  return {
    sync(C, W) {
      cur = C;
      for (const b of panel.querySelectorAll('button[data-k]')) b.classList.toggle('on', C[b.dataset.k] === b.dataset.v);
      const tn = panel.querySelector('button[data-k="moon"][data-v="tonight"]');
      if (tn) { const mp = moonPhase('tonight'); tn.textContent = `${moonIcon(mp)} Tonight`; tn.title = `Tonight's real phase: ${Math.round(100 * (1 - Math.cos(mp.phi)) / 2)}% lit, ${mp.side > 0 ? 'waxing' : 'waning'} (${mp.age.toFixed(1)} days old)`; }
      sel.value = String(Math.round(C.windFrom / 22.5) % 16 * 22.5);
      kn.textContent = W.kn;
      const icon = C.time === 'night' ? moonIcon(moonPhase(C.moon)) : C.sky === 'rain' ? '🌧' : C.vis === 'fog' || C.vis === 'thick' ? '🌫' : C.sky === 'overcast' ? '☁' : C.time === 'day' ? '☀' : '🌅';
      btn.textContent = `${icon} Weather ▾`;
      btn.classList.toggle('on', C.time !== 'day' || C.vis !== 'clear' || C.sky !== 'fair' || C.wind !== 'breezy');
    },
  };
}

// ── NOAA forecast → conditions (v859) ──
export function sunPos(lat, lon, date) {   // the sun's altitude and bearing, degrees (NOAA's approximate formulas)
  const r = Math.PI / 180, d = (date - Date.UTC(2000, 0, 1, 12)) / 864e5;
  const g = (357.529 + 0.98560028 * d) * r, q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * r, e = (23.439 - 0.00000036 * d) * r;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24, ha = ((gmst * 15 + lon) * r - ra);
  const alt = Math.asin(Math.sin(lat * r) * Math.sin(dec) + Math.cos(lat * r) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(lat * r) - Math.sin(lat * r) * Math.cos(ha));
  return { alt: alt / r, brg: (az / r + 360) % 360 };
}
function seriesAt(series, t) {   // the value of an NWS gridpoint series at time t (ms)
  for (const v of series?.values || []) {
    const [start, dur] = v.validTime.split('/'), m = dur.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/) || [];
    const t0 = Date.parse(start), t1 = t0 + ((+m[1] || 0) * 24 + (+m[2] || 0)) * 3600e3 + (+m[3] || 0) * 60e3;
    if (t >= t0 && t < t1) return v.value;
  }
  return null;
}
export async function forecastConditions(lat, lon, now) {
  const get = async url => { const r = await fetch(url, { headers: { Accept: 'application/geo+json' } }); if (!r.ok) throw new Error(`NWS ${r.status}`); return r.json(); };
  const pt = await get(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
  const grid = (await get(pt.properties.forecastGridData)).properties, t = now.getTime();
  const kn = (seriesAt(grid.windSpeed, t) ?? 15) / 1.852, from = seriesAt(grid.windDirection, t) ?? 225;
  const cover = seriesAt(grid.skyCover, t) ?? 30, pop = seriesAt(grid.probabilityOfPrecipitation, t) ?? 0;
  const visKm = (seriesAt(grid.visibility, t) ?? 16000) / 1000, waveFt = (seriesAt(grid.waveHeight, t) ?? 0) * 3.281;
  const wx = (seriesAt(grid.weather, t) || []).filter(w => w && w.weather);
  const has = re => wx.some(w => re.test(w.weather) && !/slight_chance|chance/.test(w.coverage || ''));
  const C = { windFrom: Math.round(from / 22.5) % 16 * 22.5 };
  C.wind = kn < 5 ? 'calm' : kn < 12 ? 'breezy' : kn < 20 ? 'fresh' : 'rough';
  if (waveFt >= 4 && C.wind !== 'rough') C.wind = waveFt >= 6 ? 'rough' : 'fresh';
  const fog = has(/fog/), wet = pop >= 50 || has(/rain|drizzle|showers|thunder/);
  C.sky = wet ? 'rain' : cover >= 80 ? 'overcast' : 'fair';
  const visNm = visKm / 1.852;
  C.vis = visNm < 0.5 ? 'thick' : visNm < 1 || fog ? 'fog' : visNm < 4 ? 'haze' : 'clear';
  const sp = sunPos(lat, lon, now);
  C.time = sp.alt < -6 ? 'night' : sp.alt < 8 ? (sp.brg < 180 ? 'dawn' : 'sunset') : 'day';
  const hr = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const skyTxt = wet ? `rain likely (${pop}%)` : fog ? 'fog' : cover >= 80 ? 'overcast' : cover >= 40 ? 'partly cloudy' : 'clear skies';
  const note = `NWS forecast, ${hr}: ${DIRS[Math.round(from / 22.5) % 16]} ${Math.round(kn)} kn, ${skyTxt}, visibility ${visNm >= 10 ? '10+' : visNm.toFixed(visNm < 2 ? 1 : 0)} nm` + (waveFt ? `, seas ${Math.max(1, Math.round(waveFt))} ft` : '') + '.';
  return { C, note };
}

// ── Sail trim (v869 helm view, v870 shared with the Bird's-eye fleet) ──
// The true wind angle from the wind direction and the boat's heading, then the apparent wind
// (true wind plus the headwind of the boat's own speed), which is what the sails are trimmed to:
// boom ≈ half the apparent wind angle less ~12°, the jib sheeted in step until its lead runs
// out, both strapped in close-hauled. Inside 40° of the true wind she can't sail, so the jib is
// furled and the main sheeted flat (motor-sailing). Heel is greatest close-hauled and on a reach,
// little on a run. makeTrimmer() eases the angles so tacks and gybes swing the boom across; dead
// downwind she keeps her side until the wind is clearly on the other quarter.
export const POINTS_OF_SAIL = atwa => atwa < 40 ? 'too close to the wind — motor-sailing' : atwa < 60 ? 'close-hauled' : atwa < 80 ? 'close reach'
  : atwa < 110 ? 'beam reach' : atwa < 150 ? 'broad reach' : 'running';
export function makeTrimmer() {
  const sm = { jib: 12, side: 1, signed: null };
  // windFrom, course: degrees true; tws, boatKn: knots. Returns angles in degrees off the centreline,
  // side +1 = sails out to port (wind from starboard), heelK 0..1 of the wind's full heel.
  return (windFrom, course, tws, boatKn, dt) => {
    const twa = ((windFrom - course + 540) % 360) - 180, atwa = Math.abs(twa), r = twa * Math.PI / 180;
    const awa = Math.abs(Math.atan2(tws * Math.sin(r), tws * Math.cos(r) + boatKn)) * 180 / Math.PI;
    if (atwa < 170 || Math.sign(twa) === sm.side) sm.side = twa >= 0 ? 1 : -1;
    const noGo = atwa < 40, clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const boom = noGo ? 2 : clamp(awa * 0.55 - 12, 4, 80), jib = clamp(awa * 0.3 - 2, 9, 32);
    const k = Math.min(1, dt * 1.6), target = sm.side * boom;   // eased as a signed angle, port +
    sm.signed = sm.signed == null ? target : sm.signed + (target - sm.signed) * k;
    sm.jib += (jib - sm.jib) * k;
    return { boom: Math.abs(sm.signed), jib: sm.jib, side: Math.sign(sm.signed) || sm.side, tack: sm.side, jibOn: !noGo, noGo, atwa,
      heelK: noGo ? 0.25 : 1 - 0.75 * clamp((awa - 70) / 110, 0, 1), name: POINTS_OF_SAIL(atwa) };
  };
}
