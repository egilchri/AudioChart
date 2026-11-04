// node floor.mjs: SF with Live on; every aircraft low over SFO: her reported height, and how high her model sits
import { connect, sleep } from '../live-tour/cdp.mjs';
const c = await connect(9611); const errs = [];
c.ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description?.slice(0, 300)); });
await c.cmd('Network.enable'); await c.cmd('Network.setCacheDisabled', { cacheDisabled: true }); await c.cmd('Network.setBypassServiceWorker', { bypass: true });
await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 760, deviceScaleFactor: 1, mobile: false });
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8811/www/bay3d.html?region=sf-bay&ais=https://audiochart-ais.egilchri.workers.dev' });
for (let i = 0; i < 60; i++) { await sleep(1000); if (await c.ev(`__bay3d?.air?.count > 20`) === true) break; }
for (let k = 0; k < 3; k++) {
  await sleep(4000);
  console.log(await c.ev(`JSON.stringify(__bay3d.air.items().filter(p => p.a.alt < 800 || p.a.ground).map(p => [p.title, p.a.type, p.a.ground ? 'gnd' : p.a.alt + 'ft', 'y=' + p.y.toFixed(1), 'drop=' + p.drop.toFixed(1), p.y < p.drop - 0.01 ? 'BELOW' : '']).filter(r => r[2] !== 'gnd' || r[5]))`));
}
console.log('ERRORS', errs.join('\n')); process.exit(0);
