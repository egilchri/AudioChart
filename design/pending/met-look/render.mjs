import { connect, sleep } from '/Users/edgargilchrist/tools/AudioChart/design/pending/live-tour/cdp.mjs';
const c = await connect(9568), out = process.argv[2];
await c.cmd('Network.enable'); await c.cmd('Page.addScriptToEvaluateOnNewDocument',{source:'window.__errs=[];addEventListener("error",e=>__errs.push(String(e.message)));addEventListener("unhandledrejection",e=>__errs.push(String(e.reason)))'}); await c.cmd('Network.clearBrowserCache'); await c.cmd('Storage.clearDataForOrigin', { origin: 'http://127.0.0.1:8791', storageTypes: 'all' }); await c.cmd('Network.setCacheDisabled', { cacheDisabled: true });
await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8791/bay3d.html?region=new-york-harbor&v=' + Date.now() });
for (let i = 0; i < 90; i++) { await sleep(1000); if (await c.ev(`!!window.__bay3d?.walkEye`) === true) break; }
await sleep(5000);
console.log(await c.ev(`fetch('./data/buildings/nyc-upper-west-side.json',{cache:'no-store'}).then(r=>r.json()).then(d=>d.buildings.filter(b=>b.n&&/Metropolitan/.test(b.n)).length)`));
const shots = [['m1_aerial', { lat: 40.77895, lon: -73.9628, dist: 330, az: 299, tilt: 66 }], ['m2_corner', null, { lon: -73.961788, lat: 40.779501, az: 240, pitch: 6 }], ['m3_across', null, { lon: -73.96254, lat: 40.77884, az: 299, pitch: 14 }]];
for (const [n, v, e] of shots) {
  if (v) { await c.ev(`__bay3d.walkEye(null)`); await c.ev(`__bay3d.setView(${JSON.stringify(v)})`); } else await c.ev(`__bay3d.walkEye(${JSON.stringify(e)})`);
  for (let k = 0; k < 60; k++) { await sleep(500); if (!(await c.ev(`__bay3d.tiles.some(T=>T.state==='loading'||(T.state==='ready'&&T.photo==='pending'))`))) break; }
  await sleep(3500); await c.shot(`${out}/${n}.png`);
}
console.log(await c.ev(`JSON.stringify(window.__errs||[])`));
process.exit(0);
