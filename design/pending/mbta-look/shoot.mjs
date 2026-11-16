// node shoot.mjs <tag> [rail]: each view to <tag>_<view>.png (headless Chrome on :9633, the repo root served on :8795)
import { connect, sleep } from '../live-tour/cdp.mjs';
const tag = process.argv[2] || 'r0', rail = process.argv[3] || 'Commuter Rail', c = await connect(9633); const errs = [];
c.ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description?.slice(0, 300)); });
await c.cmd('Network.enable'); await c.cmd('Network.setCacheDisabled', { cacheDisabled: true });
for (const v of (process.env.VIEWS || 'photo,side,car,head').split(',')) {
  await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1600, height: v === 'side' || v === 'full' ? 560 : 1000, deviceScaleFactor: 1, mobile: false });
  await c.cmd('Page.navigate', { url: `http://127.0.0.1:8795/design/pending/mbta-look/view.html?view=${v}&rail=${encodeURIComponent(rail)}&lead=${process.env.LEAD || 'loco'}` });
  for (let i = 0; i < 20 && await c.ev('!!window.__done') !== true; i++) await sleep(300);
  await c.shot(`${tag}_${v}.png`);
}
console.log(errs.length ? 'ERRORS\n' + errs.join('\n') : 'ok');
process.exit(0);
