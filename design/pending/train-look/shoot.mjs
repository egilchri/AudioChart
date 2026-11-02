// node shoot.mjs <tag>: renders each view to <tag>_<view>.png (Chrome on :9567, the repo root served on :8795)
import { connect, sleep } from '../live-tour/cdp.mjs';
const tag = process.argv[2] || 'r0', c = await connect(9567); const errs = [];
c.ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description?.slice(0, 300)); });
await c.cmd('Network.enable'); await c.cmd('Network.setCacheDisabled', { cacheDisabled: true });
for (const v of ['side', 'full', 'front', 'three', 'aerial']) {
  await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1600, height: v === 'side' || v === 'full' ? 560 : 1000, deviceScaleFactor: 1, mobile: false });
  await c.cmd('Page.navigate', { url: `http://127.0.0.1:8795/design/pending/train-look/view.html?view=${v}` });
  for (let i = 0; i < 20 && await c.ev('!!window.__done') !== true; i++) await sleep(300);
  await c.shot(`${tag}_${v}.png`);
}
console.log(errs.length ? 'ERRORS\n' + errs.join('\n') : 'ok');
process.exit(0);
