// Boat wakes in the water itself (v957 in the helm view; shared with Bird's-eye v959, requested: "give
// Bird's-eye boats the same wake"). Not foam painted over the sea but the sea disturbed: a Kelvin wave
// pattern, worked out once as a height field in a boat's own frame (it's stationary relative to her),
// bends the water shader's normals, so a wake shows the way a real one does, in the sky, cloud and sun
// it reflects. Two wave systems, from the stem and the transom; the crest lines are Kelvin's
// (x = a cos t (1 + sin^2 t), y = a sin t cos^2 t, a = n wavelengths, the cusps at 19.5 degrees), the
// wavelength 2 pi U^2 / g, so the pattern stretches with her speed. Plus a calmed slick astern (the
// ripples damped) and a little foam, lacy, drifting aft at her speed, mostly off the transom (about two
// waterline lengths) and where the bow wave breaks along her sides.
//
// The field is built for the Cape Dory 25D at 5 knots (her frame: stem at z = -4.3, transom at +3.0,
// metres, aft +z); any other boat is mapped onto that frame by her length, so the pattern is sized to
// her as drawn (Bird's-eye draws boats larger from far off), and stretched by her real speed.
//
// makeWakes(water, n): patches a three.js Water's shader for up to n wakes. Each frame, update(list, dt)
// with up to n entries { key, x, z, rotY, L, zc, scale, kn, moving }: her position, group.rotation.y,
// length overall (bow toward -z; zc: where its middle is in her own frame, if not at her origin), the scale she's drawn at, her real speed in
// knots through the water, and whether she's under way.
import * as THREE from 'three';

const U0 = 2.57, LAM = 2 * Math.PI * U0 * U0 / 9.81;   // built for 5 knots: a 4.2 m wavelength
const STEM = -4.3, STERN = 3.0, HB = 1.2, LREF = STERN - STEM, MID = (STEM + STERN) / 2;   // the Cape Dory's frame; half-beam
const X0 = -20, Z0 = -6, W = 40, L = 60, R = 8;   // the field: m across, m along from Z0; R texels a metre

let field = null;
function wakeField() {
  if (field) return field;
  const NX = W * R, NZ = L * R, h = new Float32Array(NX * NZ);
  const splat = (x, z, amp, sg) => {
    const r = Math.ceil(2.5 * sg * R), cx = (x - X0) * R, cz = (z - Z0) * R, k = -1 / (2 * sg * sg * R * R);
    for (let j = Math.max(0, Math.floor(cz - r)); j <= Math.min(NZ - 1, Math.ceil(cz + r)); j++)
      for (let i = Math.max(0, Math.floor(cx - r)); i <= Math.min(NX - 1, Math.ceil(cx + r)); i++)
        h[j * NX + i] += amp * Math.exp(((i - cx) ** 2 + (j - cz) ** 2) * k);
  };
  // one crest (or, half a wavelength on, trough) line of a system from (0, z0): splats a step apart along it
  const crestLine = (z0, a, amp, trans) => {
    const sg = 0.095 * LAM, step = sg * 0.6, norm = step / (Math.sqrt(2 * Math.PI) * sg);
    for (const side of [-1, 1]) {
      let px = null, pz = null, acc = 0;
      for (let t = trans ? 0 : 0.6155; t <= (trans ? 0.6155 : 1.45); t += 0.002) {   // 0.6155 rad: the cusp
        const c = Math.cos(t), sn = Math.sin(t), z = z0 + a * c * (1 + sn * sn), x = side * a * sn * c * c;
        if (px !== null) acc += Math.hypot(x - px, z - pz);
        px = x; pz = z;
        if (acc < step) continue; acc = 0;
        if (z > Z0 + L - 3) continue;
        const cusp = Math.exp(-(((t - 0.6155) / 0.35) ** 2));   // the crests are highest at the cusp
        splat(x, z, amp * norm * (0.45 + 0.55 * cusp) * (trans ? 0.55 : 1), sg);
      }
    }
  };
  for (const [z0, sys] of [[STEM, 1], [STERN, 0.6]]) {
    for (let n = 1; n * LAM < L + 10; n++) {
      const amp = sys / Math.sqrt(n);
      for (const trans of [false, true]) { crestLine(z0, n * LAM, amp, trans); crestLine(z0, (n - 0.5) * LAM, -0.8 * amp, trans); }
    }
  }
  // slopes (rg), foam (b) and calm (a) into a texture
  const data = new Uint8Array(NX * NZ * 4); let mx = 1e-6;
  const gx = new Float32Array(NX * NZ), gz = new Float32Array(NX * NZ);
  for (let j = 1; j < NZ - 1; j++) for (let i = 1; i < NX - 1; i++) {
    const o = j * NX + i; gx[o] = (h[o + 1] - h[o - 1]) * R / 2; gz[o] = (h[o + NX] - h[o - NX]) * R / 2;
    mx = Math.max(mx, Math.abs(gx[o]), Math.abs(gz[o]));
  }
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const o = j * NX + i, x = X0 + i / R, z = Z0 + j / R, d = z - STERN;
    const edge = Math.min(1, (L - (z - Z0)) / 8) * Math.min(1, (W / 2 - Math.abs(x)) / 4);   // fade out before the edges
    const hull = z < STERN ? HB * Math.min(1, Math.sqrt(Math.max(0, z - STEM) / 3.2)) : 0;   // her half-breadth here
    let foam = 0, calm = 0;
    if (d > 0) {
      const wd = HB * 0.9 + 0.07 * d;
      calm = Math.exp(-d / 40) * Math.exp(-((x / wd) ** 4));
      foam = Math.min(1, 1.15 * Math.exp(-d / 7)) * Math.exp(-((x / (HB * 0.75 + 0.1 * d)) ** 2));   // churned water off the rudder and transom, gone in about two waterline lengths
    } else if (z > STEM) {
      const off = Math.abs(x) - hull;                                                    // the bow wave breaking along her sides
      foam = 0.6 * Math.exp(-(((off - 0.12) / 0.14) ** 2)) * Math.exp(-Math.max(0, z - STEM) / 2.2);
    }
    foam = Math.max(foam, Math.max(0, h[o] * 1.6 - 0.5) * Math.exp(-Math.max(0, d) / 12));   // the steepest crests near her break a little
    data[o * 4] = 128 + 127 * edge * gx[o] / mx; data[o * 4 + 1] = 128 + 127 * edge * gz[o] / mx;
    data[o * 4 + 2] = 255 * Math.min(1, foam * edge); data[o * 4 + 3] = 255 * calm * edge;
  }
  const tex = new THREE.DataTexture(data, NX, NZ, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true; tex.needsUpdate = true;
  return (field = tex);
}

const f = v => v.toFixed(3);
export function makeWakes(water, n = 1) {
  const uniforms = {
    wakeMap: { value: wakeField() },
    wakeM: { value: Array.from({ length: n }, () => new THREE.Matrix3()) },
    wakeP: { value: Array.from({ length: n }, () => new THREE.Vector4()) },   // strength, stretch, foam drift, slope gain
  };
  water.material.fragmentShader = water.material.fragmentShader
    .replace('varying vec4 worldPosition;', `varying vec4 worldPosition;
    uniform sampler2D wakeMap; uniform mat3 wakeM[${n}]; uniform vec4 wakeP[${n}];`)
    .replace('vec3 diffuseLight = vec3(0.0);', `float wakeFoam = 0.0;
    {
      vec2 gsum = vec2(0.0); float calm = 0.0;
      for (int i = 0; i < ${n}; i++) {
        vec4 P = wakeP[i];
        if (P.x <= 0.0) continue;
        vec2 wl = (wakeM[i] * vec3(worldPosition.xz, 1.0)).xy;   // her frame, mapped onto the Cape Dory's
        vec2 wq = vec2(wl.x / P.y, ${f(STEM)} + (wl.y - ${f(STEM)}) / P.y);
        vec2 wuv = (wq - vec2(${f(X0)}, ${f(Z0)})) / vec2(${f(W)}, ${f(L)});
        if (wuv.x <= 0.0 || wuv.x >= 1.0 || wuv.y <= 0.0 || wuv.y >= 1.0) continue;
        vec4 wt = texture2D(wakeMap, wuv);
        vec2 g = (wt.rg * 2.0 - 1.0) * P.w * P.x;
        gsum += vec2(dot(wakeM[i][0].xy, g), dot(wakeM[i][1].xy, g));   // her frame's slope, turned to the world's
        calm = max(calm, wt.a * P.x);
        vec2 fp = vec2(wl.x, wl.y - P.z);   // the foam stays where it was made: aft, at her speed
        float lace = texture2D(normalSampler, fp / 6.0).r * 0.55 + texture2D(normalSampler, fp / 2.3 + 0.37).g * 0.45;
        wakeFoam = max(wakeFoam, P.x * wt.b * smoothstep(0.55 - 0.3 * wt.b, 0.75 - 0.2 * wt.b, lace));
      }
      if (calm > 0.0 || gsum != vec2(0.0)) {
        vec3 n0 = noise.xzy * vec3(1.5, 1.0, 1.5);
        n0.xz *= 1.0 - 0.45 * calm;
        n0.xz -= gsum * n0.y * 2.5;
        surfaceNormal = normalize(n0);
      }
    }
    vec3 diffuseLight = vec3(0.0);`)
    .replace('vec3 outgoingLight = albedo;', `vec3 foamLit = vec3(0.86, 0.9, 0.92) * (0.18 + 0.82 * clamp(sunDirection.y * 2.5, 0.0, 1.0)) * mix(vec3(1.0), sunColor, 0.4);
    albedo = mix(albedo, foamLit, clamp(wakeFoam, 0.0, 0.9));
    vec3 outgoingLight = albedo;`);
  Object.assign(water.material.uniforms, uniforms);
  water.material.needsUpdate = true;

  const state = new Map();   // key -> { mov, x, z, flow, seen }
  let frameNo = 0;
  // speed through the water (kn) gives the wake's shape; how fast she crosses the screen is that times the
  // time rate (60x and more), so motion only says whether she's moving (v958: a "jump" filter on screen
  // speed had zeroed the wake at fast rates)
  function update(list, dt) {
    frameNo++;
    for (let i = 0; i < n; i++) {
      const P = uniforms.wakeP.value[i], b = list[i];
      if (!b) { P.x = 0; continue; }
      let s = state.get(b.key);
      if (!s) state.set(b.key, s = { mov: 0, x: b.x, z: b.z, flow: 0 });
      s.seen = frameNo;
      let v = dt > 0 ? Math.hypot(b.x - s.x, b.z - s.z) / dt : 0; if (v > 5000) v = 0;   // a jump (reload, slider) isn't motion
      s.x = b.x; s.z = b.z;
      s.mov += ((b.moving && v > 0.05 ? 1 : 0) - s.mov) * Math.min(1, dt * 1.2);
      const U = Math.max(0.5, (b.kn || 5) * 0.5144), k = LREF / (b.L * (b.scale || 1));   // world metres -> her mapped frame
      s.flow += v * dt * k;
      const c = Math.cos(b.rotY), sn = Math.sin(b.rotY);
      uniforms.wakeM.value[i].set(k * c, -k * sn, -k * (c * b.x - sn * b.z), k * sn, k * c, -k * (sn * b.x + c * b.z + (b.zc || 0)) + MID, 0, 0, 1);
      P.set(s.mov * Math.min(1, U / 1.5),                                                // there from about 3 knots
        Math.min(1.6, Math.max(0.3, (U / U0) ** 2 * LREF / b.L)),                        // the wavelength goes with U^2, against her length
        s.flow, 0.16 / k);                                                               // the slopes as steep whatever her size
    }
    for (const [key, s] of state) if (frameNo - s.seen > 600) state.delete(key);
  }
  return { update };
}
