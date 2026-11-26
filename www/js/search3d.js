// 🔍 Search (v1155, asked in New York: "New York City is really big ... we need a search button to be able to jump to
// different areas"): type a name and fly there. Looked for first in what the bay already has (its towns and
// neighbourhoods, bridges, the chart's places, and its stations: the platforms' names, www/data/rail/<id>-platforms.json),
// then anywhere else by OpenStreetMap's own search (Nominatim, kept to the bay's box, a few a minute at most: its policy).
// Only the words typed go to OpenStreetMap. Part of the armchair layer: bay3d.js loads it on the first 🔍.
let panel = null, ctx = null, stations = null, lastAsk = 0, timer = null, seq = 0;

const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
// a match's score: the whole name, its start, a word's start, anywhere (lower is better)
function score(name, q) {
  const n = norm(name); if (!n || !q) return null;
  if (n === q) return 0; if (n.startsWith(q)) return 1;
  if (n.split(' ').some(w => w.startsWith(q))) return 2;
  if (q.split(' ').every(w => n.includes(w))) return 3;
  return null;
}
async function loadStations() {
  if (stations || !ctx.platformsUrl) return stations || [];
  try {
    const d = await (await fetch(ctx.platformsUrl)).json(), by = new Map();
    for (const p of d.plats || []) {
      if (!p.n) continue;
      const k = p.n.replace(/\s*\(.*?\)\s*/g, ' ').trim(), g = p.g, cx = g.reduce((a, q) => a + q[0], 0) / g.length, cy = g.reduce((a, q) => a + q[1], 0) / g.length;
      const o = by.get(k) || by.set(k, { name: k, lon: 0, lat: 0, n: 0 }).get(k); o.lon += cx; o.lat += cy; o.n++;
    }
    stations = [...by.values()].map(o => ({ name: o.name, kind: 'Station', lon: o.lon / o.n, lat: o.lat / o.n }));
  } catch (_) { stations = []; }
  return stations;
}
function build() {
  const st = document.createElement('style');
  st.textContent = `#search3d { position: fixed; top: 64px; left: 50%; transform: translateX(-50%); width: min(420px, calc(100vw - 32px)); z-index: 40;
      background: rgba(18,24,30,0.94); border: 1px solid rgba(255,255,255,0.18); border-radius: 10px; padding: 8px; font: 14px/1.35 system-ui, sans-serif; color: #e8edf2; box-shadow: 0 8px 28px rgba(0,0,0,0.45); }
    #search3d input { width: 100%; box-sizing: border-box; font: inherit; font-size: 16px; padding: 8px 10px; border-radius: 7px; border: 1px solid rgba(255,255,255,0.25); background: rgba(255,255,255,0.08); color: inherit; outline: none; }
    #search3d input:focus { border-color: #e0a843; }
    #search3d ul { list-style: none; margin: 6px 0 0; padding: 0; max-height: 50vh; overflow-y: auto; }
    #search3d li { padding: 7px 9px; border-radius: 6px; cursor: pointer; display: flex; justify-content: space-between; gap: 10px; }
    #search3d li.sel, #search3d li:hover { background: rgba(224,168,67,0.25); }
    #search3d li small { opacity: 0.6; white-space: nowrap; }
    #search3d .note { padding: 6px 9px; opacity: 0.65; font-size: 12px; }`;
  document.head.appendChild(st);
  panel = document.createElement('div'); panel.id = 'search3d'; panel.hidden = true;
  panel.innerHTML = '<input type="search" placeholder="Search: a place, station, street or address" aria-label="Search" autocomplete="off" spellcheck="false"><ul role="listbox"></ul><div class="note" hidden></div>';
  document.body.appendChild(panel);
  const input = panel.querySelector('input'), list = panel.querySelector('ul');
  input.addEventListener('input', () => find(input.value));
  input.addEventListener('keydown', e => {
    const items = [...list.children], i = items.findIndex(li => li.classList.contains('sel'));
    if (e.key === 'Escape') { close(); e.preventDefault(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!items.length) return; const j = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items.forEach((li, k) => li.classList.toggle('sel', k === j)); items[j].scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); (items[i] || items[0])?.click(); }
    e.stopPropagation();   // (the view's own keys stay quiet while typing)
  });
  document.addEventListener('pointerdown', e => { if (!panel.hidden && !panel.contains(e.target) && e.target !== ctx.button) close(); });
}
function show(results, note = '') {
  const list = panel.querySelector('ul'), nt = panel.querySelector('.note'); list.innerHTML = '';
  results.slice(0, 9).forEach((r, k) => {
    const li = document.createElement('li'); li.setAttribute('role', 'option'); if (!k) li.classList.add('sel');
    const a = document.createElement('span'); a.textContent = r.name; const b = document.createElement('small'); b.textContent = r.kind;
    li.append(a, b); li.addEventListener('click', () => { close(); ctx.go(r); }); list.appendChild(li);
  });
  nt.textContent = note; nt.hidden = !note;
}
async function find(text) {
  const q = norm(text), my = ++seq; clearTimeout(timer);
  if (q.length < 2) { show([]); return; }
  const local = [...ctx.places(), ...(await loadStations())].map(r => ({ ...r, s: score(r.name, q) })).filter(r => r.s != null)
    .sort((a, b) => a.s - b.s || a.name.length - b.name.length);
  const seen = new Set(), uniq = local.filter(r => { const k = norm(r.name) + r.kind; if (seen.has(k)) return false; seen.add(k); return true; });
  if (my !== seq) return;
  show(uniq, q.length >= 3 ? 'Searching OpenStreetMap…' : '');
  if (q.length < 3) return;
  // then OpenStreetMap's search, once she's stopped typing (and not more than one a second, its policy)
  timer = setTimeout(async () => {
    const wait = Math.max(0, lastAsk + 1100 - Date.now()); if (wait) await new Promise(r => setTimeout(r, wait));
    if (my !== seq) return; lastAsk = Date.now();
    const [w, s, e, n] = ctx.box;
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&bounded=1&viewbox=${w},${n},${e},${s}&q=${encodeURIComponent(text.trim())}`, { headers: { 'Accept-Language': 'en' } });
      const j = r.ok ? await r.json() : [];
      if (my !== seq) return;
      // (v1214) an address has no name of its own: "100, West 18th Street, …" is "100 West 18th Street", an Address
      const parts = o => o.display_name.split(',').map(s => s.trim()), addr = o => !o.name && /^\d[\w-]*$/.test(parts(o)[0]);
      const osm = j.map(o => ({ name: addr(o) ? `${parts(o)[0]} ${parts(o)[1]}` : o.name || parts(o)[0], where: parts(o).slice(1, 3).join(', '), kind: addr(o) ? 'Address' : (o.type || o.category || 'Place').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()), lon: +o.lon, lat: +o.lat, bb: o.boundingbox }))
        .filter((o, i, all) => !uniq.some(u => norm(u.name) === norm(o.name)) && all.findIndex(p => norm(p.name) === norm(o.name)) === i);
      show([...uniq, ...osm], uniq.length || osm.length ? '' : 'Nothing by that name in this bay');
    } catch (_) { if (my === seq) show(uniq, uniq.length ? '' : 'OpenStreetMap search is out of reach just now'); }
  }, 450);
}
function close() { if (panel) panel.hidden = true; }
// open (or close) it. c: { button, box: [w, s, e, n], places: () => [{ name, kind, lon, lat } or { name, kind, go }], go(r), platformsUrl }
export function openSearch(c) {
  ctx = c; if (!panel) build();
  if (!panel.hidden) { close(); return; }
  panel.hidden = false; const input = panel.querySelector('input'); input.select(); input.focus(); if (input.value) find(input.value);
}
