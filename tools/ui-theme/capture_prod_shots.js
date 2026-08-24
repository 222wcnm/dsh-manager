const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

async function main() {
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const profile = path.join(require('os').tmpdir(), 'dsh-shot-' + Date.now());
  const proc = spawn(edge, [
    '--headless=new',
    '--remote-debugging-port=9445',
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--window-size=800,600',
    'about:blank'
  ]);
  
  await new Promise(r => setTimeout(r, 1500));
  const ver = await fetch('http://127.0.0.1:9445/json/version').then(r => r.json());
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  
  await new Promise(res => { ws.onopen = res; });
  let id = 0;
  const send = (method, params = {}) => new Promise((res, rej) => {
    const cid = ++id;
    const h = (ev) => {
      const d = JSON.parse(ev.data);
      if (d.id === cid) {
        ws.removeEventListener('message', h);
        if (d.error) rej(d.error); else res(d.result);
      }
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: cid, method, params }));
  });

  const extRes = await send('Extensions.loadUnpacked', { path: path.resolve('extension') });
  const extId = extRes.id;
  
  const tab = await fetch('http://127.0.0.1:9445/json/new?about:blank', { method: 'PUT' }).then(r => r.json());
  const pws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(res => { pws.onopen = res; });
  let pid = 0;
  const psend = (method, params = {}) => new Promise((res, rej) => {
    const cid = ++pid;
    const h = (ev) => {
      const d = JSON.parse(ev.data);
      if (d.id === cid) {
        pws.removeEventListener('message', h);
        if (d.error) rej(d.error); else res(d.result);
      }
    };
    pws.addEventListener('message', h);
    pws.send(JSON.stringify({ id: cid, method, params }));
  });

  await psend('Page.enable');
  await psend('Runtime.enable');

  const popupUrl = 'chrome-extension://' + extId + '/popup.html';

  // 1. Dashboard 浅色态
  await psend('Page.navigate', { url: popupUrl });
  await new Promise(r => setTimeout(r, 2000));
  await psend('Runtime.evaluate', { expression: `
    state = 'running';
    startedAtMs = Date.now() - 3600000;
    detail = { port: 3080, pid: 14208, health: { uptimeMs: 3600000, nodeVersion: 'v24.19.0' }, lifecycle: true };
    render();
  ` });
  await new Promise(r => setTimeout(r, 300));
  let shot = await psend('Page.captureScreenshot', { clip: { x: 0, y: 0, width: 380, height: 270, scale: 2 } });
  fs.writeFileSync('tools/ui-theme/v6_prod_dash_light.png', Buffer.from(shot.data, 'base64'));

  // 2. Dashboard 深色态
  await psend('Runtime.evaluate', { expression: `document.body.setAttribute('data-ds-dark-theme', '');` });
  await new Promise(r => setTimeout(r, 300));
  shot = await psend('Page.captureScreenshot', { clip: { x: 0, y: 0, width: 380, height: 270, scale: 2 } });
  fs.writeFileSync('tools/ui-theme/v6_prod_dash_dark.png', Buffer.from(shot.data, 'base64'));

  // 3. 会话感知深色态
  await psend('Runtime.evaluate', { expression: `
    switchV6('sess');
    sessionsData = {
      available: true,
      items: [
        { sessionId: 's1', title: '修改端口后重启仍为8080的问题 (1)', state: 'waiting' },
        { sessionId: 's2', title: 'dsh-manager扩展开发下一步', state: 'working' },
        { sessionId: 's3', title: '弹出界面紧凑布局优化方案', state: 'completed' },
        { sessionId: 's4', title: 'DSH全局技能列表概览', state: 'completed' },
        { sessionId: 's5', title: '笛音仙鹤共舞的象征主义诗景', state: 'completed' }
      ]
    };
    applySessions();
  ` });
  await new Promise(r => setTimeout(r, 300));
  shot = await psend('Page.captureScreenshot', { clip: { x: 0, y: 0, width: 380, height: 270, scale: 2 } });
  fs.writeFileSync('tools/ui-theme/v6_prod_sess_dark.png', Buffer.from(shot.data, 'base64'));

  // 4. 首选项设置深色态
  await psend('Runtime.evaluate', { expression: `switchV6('sett');` });
  await new Promise(r => setTimeout(r, 300));
  shot = await psend('Page.captureScreenshot', { clip: { x: 0, y: 0, width: 380, height: 270, scale: 2 } });
  fs.writeFileSync('tools/ui-theme/v6_prod_sett_dark.png', Buffer.from(shot.data, 'base64'));

  // 5. 首选项设置浅色态
  await psend('Runtime.evaluate', { expression: `document.body.removeAttribute('data-ds-dark-theme');` });
  await new Promise(r => setTimeout(r, 300));
  shot = await psend('Page.captureScreenshot', { clip: { x: 0, y: 0, width: 380, height: 270, scale: 2 } });
  fs.writeFileSync('tools/ui-theme/v6_prod_sett_light.png', Buffer.from(shot.data, 'base64'));

  await psend('Browser.close').catch(() => {});
  proc.kill();
  console.log('ALL PROD SCREENSHOTS CAPTURED');
}

main().catch(console.error);
