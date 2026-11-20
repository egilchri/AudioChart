// node shoot.mjs <tag> [name]: the Circle Line boat from each side, through view.html (served from the repo root on 8792)
import { spawn } from 'child_process'; import fs from 'fs';
const TAG = process.argv[2] || 'r', NAME = process.argv[3] || 'CIRCLE LINE BROOKLYN', DIR = new URL('.', import.meta.url).pathname;
const ch = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=9334', `--user-data-dir=${DIR}/.prof`, '--window-size=1400,900', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank']);
const sleep = ms => new Promise(r => setTimeout(r, ms)); await sleep(3000);
const tabs = await (await fetch('http://127.0.0.1:9334/json')).json();
const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}; ws.onmessage = e => { const m = JSON.parse(e.data); if (pend[m.id]) { pend[m.id](m); delete pend[m.id]; } };
const cmd = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
for (const cam of ['side', 'bow', 'stern', 'top', 'helm']) {
  await cmd('Page.navigate', { url: `http://127.0.0.1:8792/design/pending/circle-look/view.html?cam=${cam}&name=${encodeURIComponent(NAME)}` }); await sleep(2500);
  const r = await cmd('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${DIR}/${TAG}_${cam}.png`, Buffer.from(r.result.data, 'base64'));
}
ch.kill(); process.exit(0);
