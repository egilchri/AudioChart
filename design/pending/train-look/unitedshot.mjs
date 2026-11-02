// A side view of a United flight with ships on the bay below: node unitedshot.mjs [out.png]
import { connect, sleep } from '../live-tour/cdp.mjs';
const OUT = process.argv[2] || 'united.png', c = await connect(9567); const errs = [];
c.ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description?.slice(0, 300)); if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errs.push(JSON.stringify(d.params.args.map(a => a.description || a.value)).slice(0, 300)); });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
await c.cmd('Network.enable'); await c.cmd('Network.setCacheDisabled', { cacheDisabled: true }); await c.cmd('Network.setBypassServiceWorker', { bypass: true });
await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8793/bay3d.html?region=sf-bay&ais=https://audiochart-ais.egilchri.workers.dev' });
for (let i = 0; i < 60; i++) { await sleep(1000); if (await c.ev(`!!window.__bay3d?.camera`) === true) break; }
const J = async x => JSON.parse(await c.ev(`JSON.stringify(${x})`)); const R = `document.querySelector('#scene canvas').getBoundingClientRect()`;
const km = (a, b) => Math.hypot((a.lon - b.lon) * 88.0, (a.lat - b.lat) * 111.1);
let pick = null;
for (let tries = 0; tries < 30 && !pick; tries++) {   // (a United flight low over the water, ships round her)
  await sleep(tries ? 10000 : 20000);
  const air = await J(`__bay3d.air.list()`), ships = await J(`window.__live()`);
  const cands = air.filter(a => /^UAL/.test(a.flight) && !a.ground && a.alt > 1200 && a.alt < 6500 && a.at.lon > -122.5 && a.at.lon < -122.12 && a.at.lat > 37.5 && a.at.lat < 37.95)
    .map(a => ({ a, water: null, near: ships.filter(s => km(s, a.at) < 8) }));
  for (const k of cands) k.water = await c.ev(`__bay3d.waterAt(${k.a.at.lon}, ${k.a.at.lat})`);
  const ok = cands.filter(k => k.water === true && k.near.length >= 3).sort((x, y) => y.near.length - x.near.length);
  log('United candidates', cands.map(k => `${k.a.flight} ${k.a.alt}ft water=${k.water} ships=${k.near.length}`).join(' | ') || 'none');
  if (ok.length) pick = ok[0];
}
if (!pick) { log('no United flight low over the bay with ships near; try again later'); process.exit(3); }
const A = pick.a; log('pick', A.flight, A.type, A.alt, 'ft', 'trk', A.trk, 'ships near', pick.near.length);
// which side faces the ships: their middle, bearing from her, against her track
const cx = pick.near.reduce((s, v) => s + v.lon, 0) / pick.near.length, cy = pick.near.reduce((s, v) => s + v.lat, 0) / pick.near.length;
const brg = (Math.atan2((cx - A.at.lon) * 88, (cy - A.at.lat) * 111.1) * 180 / Math.PI + 360) % 360, rel = ((brg - A.trk + 540) % 360) - 180;
// Side's camera is off her right (starboard) wing looking at her: to look toward ships on her left, it goes to her right
const camOnRight = rel < 0;
log('ships bear', Math.round(brg), 'rel', Math.round(rel), camOnRight ? 'camera on her right' : 'camera on her left');
await c.ev(`__bay3d.setView(${JSON.stringify({ lat: A.at.lat, lon: A.at.lon, dist: 6000, az: 0, tilt: 40 })})`); await sleep(2500);
for (let k = 0; k < 5; k++) { const me = (await J(`__bay3d.air.list(__bay3d.camera, ${R})`)).find(x => x.hex === A.hex); if (me?.sx != null) { await c.click(me.sx, me.sy); await sleep(600); } if (await c.ev(`!document.getElementById('aisinfo').hidden`) === true) break; }
await c.ev(`[...document.querySelectorAll('#aisinfo .go button')].find(b => b.dataset.m === 'side').click()`); await sleep(1500);
log('riding:', await c.ev(`document.getElementById('ridename').textContent`));
const key = async (k, n) => { for (let i = 0; i < n; i++) { await c.cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[k] }); await c.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k }); } };
await c.ev(`document.activeElement?.blur()`);
if (!camOnRight) await key('ArrowLeft', 45);   // (round to her other side: 4° a press)
await key('ArrowDown', 2);   // (a little above her: the bay and its ships behind and below)
await c.cmd('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 960, y: 540, deltaX: 0, deltaY: -90 });   // (in a little closer)
await c.ev(`(() => { const st = document.createElement('style'); st.textContent = '.panel,#scale,#help,#nesthud,#ridechart,#aisinfo,#followhud,#livemarks,#labels,#ovmap,#credit,#loading,#bayswitch,#nestrep,#wxpanel{display:none!important}'; document.head.appendChild(st); })()`);
for (let w = 0; w < 60 && await c.ev(`__bay3d.tiles.some(T=>T.state==='loading'||(T.state==='ready'&&T.photo==='pending'))`); w++) await sleep(1000);
await sleep(2500);
await c.shot(OUT); log('shot', OUT, A.flight, A.type);
console.log('ERRORS', errs.slice(0, 5).join('\n'));
process.exit(0);
