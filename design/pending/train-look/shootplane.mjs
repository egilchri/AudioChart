// node shootplane.mjs <tag> [type] [flight]: renders a plane from each angle to <tag>_<view>.png
import { connect, sleep } from '../live-tour/cdp.mjs';
const [tag = 'p0', type = 'B738', flight = 'UAL1'] = process.argv.slice(2), c = await connect(9567); const errs = [];
c.ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description?.slice(0, 300)); });
await c.cmd('Network.enable'); await c.cmd('Network.setCacheDisabled', { cacheDisabled: true });
for (const [v, bg] of [['side', 'white'], ['top', 'white'], ['front', 'white'], ['three', ''], ['below', '']]) {
  await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await c.cmd('Page.navigate', { url: `http://127.0.0.1:8795/design/pending/train-look/view.html?model=plane&type=${type}&flight=${flight}&view=${v}&bg=${bg}` });
  for (let i = 0; i < 20 && await c.ev('!!window.__done') !== true; i++) await sleep(300);
  await c.shot(`${tag}_${v}.png`);
}
console.log(errs.length ? 'ERRORS\n' + errs.join('\n') : 'ok');
process.exit(0);
