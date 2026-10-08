s=open('page.html').read()
def cut(a,b,new):
    global s
    i=s.index(a); j=s.index(b,i)
    s=s[:i]+new+s[j:]
def rep(a,b):
    global s
    assert s.count(a)==1, a
    s=s.replace(a,b)
rep("<title>Lookout View</title>","<title>Lookout View: USGS Terrain</title>")
rep("<h1>Lookout View</h1>","<h1>Lookout View: USGS Terrain</h1>")
rep("Drawn live from AudioChart's own chart data: shoreline, buoys, beacons, lights and island names.",
    "Land is drawn from USGS 3DEP elevation (30 m grid), with buoys, beacons, lights and names from AudioChart's chart data.")
i=s.index('<p class="note">Eye height'); j=s.index('</p>',i)+4
s=s[:i]+"""<p class="note">Eye height 2.5 m. Terrain is real USGS elevation (1 arc-second, about 30 m), lit from the northwest and drawn up to 5× taller than true so it reads on screen. Colours are by height and slope only: there's no land-cover data yet, so towns and fields still look like woods. A buoy or name is hidden when terrain on that bearing blocks it.</p>
<p class="note" id="loading">Loading terrain…</p>"""+s[j:]
rep("const NM = 1852, R_EARTH = 6371000, EYE = 2.5, VEX = 4, MAXR = 12;","const NM = 1852, R_EARTH = 6371000, EYE = 2.5, VEX = 5, MAXR = 14;\nconst DEM_META = __DEMMETA__, DEM_B64 = '__DEMB64__';")
cut("const BIN = 0.125;","let S = 0, playing = false, last = 0;",'''const DIP = -Math.sqrt(2 * EYE / R_EARTH);
let DEM = null, SHADE = null;
async function loadDem() {
  const bytes = Uint8Array.from(atob(DEM_B64), ch => ch.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const v = new Uint8Array(await new Response(stream).arrayBuffer());
  const { w, h, k } = DEM_META, cellM = DEM_META.dy * 60 * NM;
  DEM = new Float32Array(w * h);
  for (let i = 0; i < v.length; i++) DEM[i] = v[i] ? (v[i] / k) ** 2 : 0;
  // hillshade, sun from the northwest 40° up
  SHADE = new Float32Array(w * h);
  const az = 315 * Math.PI / 180, alt = 40 * Math.PI / 180, cx = cellM * KX;
  for (let r = 1; r < h - 1; r++) for (let c = 1; c < w - 1; c++) {
    const i = r * w + c;
    const gx = (DEM[i + 1] - DEM[i - 1]) / (2 * cx), gy = (DEM[i - w] - DEM[i + w]) / (2 * cellM);
    const slope = Math.atan(Math.hypot(gx, gy)), aspect = Math.atan2(-gx, -gy);
    SHADE[i] = Math.max(0.35, Math.sin(alt) * Math.cos(slope) + Math.cos(alt) * Math.sin(slope) * Math.cos(az - aspect));
  }
}
function demAt(xnm, ynm) {   // nm (absolute) -> [height m, cell index] or null
  const c = Math.floor((xnm / (KX * 60) - DEM_META.west) / DEM_META.dx), r = Math.floor((DEM_META.north - ynm / 60) / DEM_META.dy);
  if (c < 0 || r < 0 || c >= DEM_META.w || r >= DEM_META.h) return null;
  const i = r * DEM_META.w + c; return [DEM[i], i];
}
function demSmooth(xnm, ynm) {   // bilinear height, so near terrain isn't blocky
  const fc = (xnm / (KX * 60) - DEM_META.west) / DEM_META.dx - 0.5, fr = (DEM_META.north - ynm / 60) / DEM_META.dy - 0.5;
  const c = Math.floor(fc), r = Math.floor(fr), W2 = DEM_META.w;
  if (c < 0 || r < 0 || c >= W2 - 1 || r >= DEM_META.h - 1) return null;
  const i = r * W2 + c, tx = fc - c, ty = fr - r;
  const h = (DEM[i] * (1 - tx) + DEM[i + 1] * tx) * (1 - ty) + (DEM[i + W2] * (1 - tx) + DEM[i + W2 + 1] * tx) * ty;
  return [h, i];
}
const angOf = (hM, dNm) => Math.atan((hM - EYE) / (dNm * NM)) - dNm * NM / (2 * R_EARTH);
// highest terrain angle seen along a bearing before distance dMax (for line of sight)
function maxAngleBefore(bx, by, phi, dMax) {
  const sx = Math.sin(phi), sy = Math.cos(phi); let best = -Infinity;
  for (let d = 0.02; d < dMax; d += Math.max(0.006, d * 0.01)) {
    const s = demAt(bx + sx * d, by + sy * d); if (s && s[0] > 0) best = Math.max(best, angOf(s[0], d));
  }
  return best;
}
''')
cut("  // land, far to near","  // lighthouses (named) and fixed lights",'''  // terrain: march each screen column outward, nearest first, drawing only what rises above what's already drawn
  const img = c.getImageData(0, 0, Math.round(W * DPR), Math.round(H * DPR)), px = img.data, IW = img.width, IH = img.height;
  for (let col = 0; col < IW; col++) {
    const rel = (col / DPR - W / 2) / pxDeg, phi = (hdg + rel) * Math.PI / 180, sx = Math.sin(phi), sy = Math.cos(phi);
    let ybuf = IH;
    for (let d = 0.02; d < MAXR; d += Math.max(0.006, d * 0.01)) {
      const s = demSmooth(bx + sx * d, by + sy * d);
      if (!s) break;
      const hM = s[0];
      if (hM <= 0.4) { const wy = Math.round(yOf(-(EYE / (d * NM) + d * NM / (2 * R_EARTH))) * DPR); if (wy < ybuf) ybuf = Math.max(wy, Math.round(HY * DPR)); continue; }
      const y = Math.max(0, Math.round(yOf(angOf(hM, d)) * DPR));
      if (y >= ybuf) continue;
      const sh = SHADE[s[1]] || 0.7, haze = 1 - Math.exp(-d / 3.6);
      const base = hM < 2.5 ? GRANITE : hM > 180 ? [70, 82, 70] : SPRUCE;
      const r0 = Math.min(255, base[0] * sh * 1.35), g0 = Math.min(255, base[1] * sh * 1.35), b0 = Math.min(255, base[2] * sh * 1.35);
      const R = r0 + (HAZE[0] - r0) * haze, G = g0 + (HAZE[1] - g0) * haze, B = b0 + (HAZE[2] - b0) * haze;
      for (let yy = y; yy < ybuf; yy++) { const o = (yy * IW + col) * 4; px[o] = R; px[o + 1] = G; px[o + 2] = B; px[o + 3] = 255; }
      ybuf = y;
      if (ybuf <= 0) break;
    }
  }
  c.putImageData(img, 0, 0);
''')
cut("    if (nearestLand(rel) < d - (m.kind === 'house' ? 0.15 : 0.01)) continue;","    shown.push({ ...m, d, rel });",
"""    if (m.kind !== 'house' && d > 2.5) continue;
    const topH = m.kind === 'house' ? 20 : 2.5;
    if (maxAngleBefore(bx, by, (hdg + rel) * Math.PI / 180, d - 0.02) > angOf(topH, d)) continue;
""")
cut("  for (const p of places) {\n    if (p.t === 'LIGHTS' || p.r < 0) continue;","  named.sort(",'''  for (const p of places) {
    if (p.t === 'LIGHTS') continue;
    const dx = p.xy[0] - bx, dy = p.xy[1] - by, d = Math.hypot(dx, dy); if (d > 7 || d < 0.05) continue;
    const rel = wrap180(Math.atan2(dx, dy) * 180 / Math.PI - hdg); if (Math.abs(rel) > FOV / 2 - 1) continue;
    const s = demAt(p.xy[0], p.xy[1]); if (!s || s[0] <= 0) continue;
    const a = angOf(Math.max(s[0], 3), d);
    if (maxAngleBefore(bx, by, (hdg + rel) * Math.PI / 180, d - 0.08) > a) continue;
    named.push({ p, d, rel, y: yOf(a) });
  }
''')
rep("  if (!W) return;","  if (!W || !DEM) return;")
rep("const AMAX = 0.13;","const AMAX = 0.2;")
rep("""S = 7.4;   // just inside the Thorofare's western approach
resize();""","""S = 7.4;   // just inside the Thorofare's western approach
resize();
loadDem().then(() => { document.getElementById('loading').hidden = true; draw(); })
  .catch(() => { document.getElementById('loading').textContent = 'This browser could not unpack the terrain data.'; });""")
rep("  named.sort((a, b) => a.d - b.d);","  named.sort((a, b) => a.d - b.d);\n  named.length = Math.min(named.length, 9);  // nearest few only, so the horizon stays readable")
open('page_dem.html','w').write(s)
out=s.replace('__DATA__',open('data.json').read()).replace('__DEMMETA__',open('dem_meta.json').read()).replace('__DEMB64__',open('dem.b64').read())
open('lookout_view_usgs.html','w').write(out)
