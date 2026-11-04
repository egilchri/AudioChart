// node inapp.mjs: the real app (SF, Live on), the small planes and helicopters flying now, each from Side and Chase
import { connect, sleep } from '../live-tour/cdp.mjs';
const c = await connect(9611); const errs = [];
c.ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description?.slice(0, 300)); if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errs.push(JSON.stringify(d.params.args.map(a => a.description || a.value)).slice(0, 300)); });
await c.cmd('Network.enable'); await c.cmd('Network.setCacheDisabled', { cacheDisabled: true }); await c.cmd('Network.setBypassServiceWorker', { bypass: true });
await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 760, deviceScaleFactor: 1, mobile: false });
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8811/www/bay3d.html?region=sf-bay&ais=https://audiochart-ais.egilchri.workers.dev' });
for (let i = 0; i < 60; i++) { await sleep(1000); if (await c.ev(`!!window.__bay3d?.camera`) === true) break; }
for (let i = 0; i < 60; i++) { await sleep(1000); if (await c.ev(`__bay3d.air.count > 20`) === true) break; }
await sleep(2000);
const J = async x => JSON.parse(await c.ev(`JSON.stringify(${x})`));
const want = (process.argv[2] || process.argv[3] || 'CH7A,C172,SR20,P28A,B06,R44,C152,BE36,C25B,CL35').split(',');
const all = await J(`__bay3d.air.items().map(p => ({ hex: p.a.hex, type: p.a.type, reg: p.a.reg, alt: p.a.alt, ground: p.a.ground, real: p.real, L: p.L }))`);
console.log(all.filter(a => !a.real).map(a => a.type || '?').join(' '));
const settle = async () => { await sleep(2500); for (let w = 0; w < 30 && await c.ev(`__bay3d.tiles.some(T=>T.state==='loading'||(T.state==='ready'&&T.photo==='pending'))`); w++) await sleep(1000); await sleep(800); };
let n = 0;
for (const t of want) {
  const a = all.find(x => x.type === t && !x.ground) || all.find(x => x.type === t); if (!a) { console.log('none', t); continue; }
  console.log(t, a.reg, a.alt, a.ground ? 'ground' : '');
  for (const m of ['side', 'stern']) {
    await c.ev(`(() => { const p = __bay3d.air.items().find(p => p.a.hex === '${a.hex}'); __bay3d.ride(p, '${m}'); })()`); await settle();
    await c.shot(`app_${t}_${m}.png`);
  }
  await c.ev(`__bay3d.leaveRide()`); n++;
}
console.log('ERRORS', errs.slice(0, 6).join('\n'));
process.exit(0);
