// The overview map (v1062, requested: "an overview map in the lower right hand corner of the screen"): the bay's
// land from its chart (data/regions/<id>/land.geojson), where you're looking from and toward, and the Flyover's
// helicopter; a tap on it takes you there. It folds away to a button (remembered).
//
// makeOverview({ el, rid, box: [w, s, e, n], view, wx, wz, lonOf, latOf, heliAt() → {x, z} | null, onPick(x, z) })
export function makeOverview({ el, rid, box, view, wx, wz, lonOf, latOf, heliAt, onPick }) {
  const [W, S, E, N] = box, k = Math.cos((S + N) / 2 * Math.PI / 180);
  const H = 120, Wd = Math.round(Math.max(90, Math.min(220, H * (E - W) * k / (N - S))));
  const KEY = 'audiochart-bay3d-overview';
  const cv = el.querySelector('canvas'), fold = el.querySelector('.ov-fold'), open = el.querySelector('.ov-open');
  const dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = Wd * dpr; cv.height = H * dpr; cv.style.width = Wd + 'px'; cv.style.height = H + 'px';
  const ctx = cv.getContext('2d');
  const px = lon => (lon - W) / (E - W) * Wd, py = lat => (N - lat) / (N - S) * H;
  // the land, drawn once
  const base = document.createElement('canvas'); base.width = cv.width; base.height = cv.height;
  const bx = base.getContext('2d'); bx.scale(dpr, dpr);
  bx.fillStyle = '#1e3a50'; bx.fillRect(0, 0, Wd, H);
  fetch(`./data/regions/${rid}/land.geojson`).then(r => r.ok ? r.json() : null).then(fc => {
    if (!fc) return;
    bx.fillStyle = '#5b6b4c';
    for (const f of fc.features || []) {
      const g = f.geometry; if (!g) continue;
      for (const poly of g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []) {
        bx.beginPath();
        for (const ring of poly) ring.forEach(([lo, la], i) => i ? bx.lineTo(px(lo), py(la)) : bx.moveTo(px(lo), py(la)));
        bx.fill('evenodd');
      }
    }
  }).catch(() => {});
  let folded = false;
  try { const s = localStorage.getItem(KEY); folded = s ? s === 'folded' : matchMedia('(max-width: 640px)').matches; } catch (_) {}
  const setFolded = f => { folded = f; el.classList.toggle('folded', f); try { localStorage.setItem(KEY, f ? 'folded' : 'open'); } catch (_) {} draw(); };
  fold.addEventListener('click', () => setFolded(true));
  open.addEventListener('click', () => setFolded(false));
  cv.addEventListener('click', e => {
    const r = cv.getBoundingClientRect(), lon = W + (e.clientX - r.left) / Wd * (E - W), lat = N - (e.clientY - r.top) / H * (N - S);
    onPick(wx(lon), wz(lat));
  });
  const toPx = (x, z) => [px(lonOf(x)), py(latOf(z))];
  function draw() {
    if (folded || document.hidden) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(base, 0, 0); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // what you see: from the camera, over the ground (as bay3d.js's placeCamera puts it), toward the point it looks at
    const h = view.dist * Math.sin(view.tilt), cx = view.x - Math.sin(view.az) * h, cz = view.z + Math.cos(view.az) * h;
    const [ax, ay] = toPx(cx, cz), [tx, ty] = toPx(view.x, view.z), len = Math.hypot(tx - ax, ty - ay);
    if (len > 1.5) {
      const ux = (tx - ax) / len, uy = (ty - ay) / len, sp = len * 0.55;
      ctx.fillStyle = 'rgba(224,168,67,0.35)'; ctx.beginPath();
      ctx.moveTo(ax, ay); ctx.lineTo(tx - uy * sp, ty + ux * sp); ctx.lineTo(tx + uy * sp, ty - ux * sp); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = '#e0a843'; ctx.beginPath(); ctx.arc(tx, ty, 2.5, 0, 7); ctx.fill();
    const hp = heliAt?.();
    if (hp) {
      const [hx, hy] = toPx(hp.x, hp.z);
      ctx.fillStyle = '#d33'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(hx, hy, 4, 0, 7); ctx.fill(); ctx.stroke();
    }
  }
  el.classList.toggle('folded', folded); el.hidden = false;
  setInterval(draw, 250);   // (a few times a second is plenty, and costs next to nothing)
  return { draw };
}
