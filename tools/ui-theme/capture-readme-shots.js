'use strict';
// ============================================================================
// capture-readme-shots.js — README 用 popup 三视图截图（浅色 + 深色）
// 复用 verify-cdp.js 的零依赖 CDP 手法（headless Chrome + Extensions.loadUnpacked）：
//   1. 启动 headless Chrome + 加载 unpacked 扩展
//   2. 打开 popup.html，注入公开安全的 mock 会话数据（真实 dsh 会话标题是用户私密
//      内容，绝不进入公开仓库截图）
//   3. 依次切换 概览 / 会话 / 设置 三视图 + 深色概览，各存一张 2x 高清 PNG
// 用法： node tools/ui-theme/capture-readme-shots.js
// 前置： headless Chrome 需全权限（同 verify-cdp；受限沙箱拦截 mojo 管道 0x5）
// 产物： docs/images/popup-{dashboard,sessions}-light.png + popup-settings-{top,bottom}-light.png
//        （设置区分上下两屏——内容纵向较长，拆两张并排展示避免长图）+ popup-dashboard-dark.png
// ============================================================================
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const EXT_DIR = path.join(ROOT, 'extension');
const OUT_DIR = path.join(ROOT, 'docs', 'images');
const PORT = Number(process.env.SHOT_CDP_PORT) || 9337;
const PROFILE = path.join(os.tmpdir(), 'dsh-readme-shots-' + Date.now());
const CHROME_CANDIDATES = [
  ...(process.env.CHROME_PATH ? [process.env.CHROME_PATH] : []),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[shots]', ...a);

let chromeProc = null;

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.json();
}

async function waitVersion() {
  for (let i = 0; i < 60; i++) {
    try { return await fetchJson('http://127.0.0.1:' + PORT + '/json/version'); } catch (_) { await sleep(250); }
  }
  throw new Error('Chrome CDP 未就绪');
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let idc = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      ws,
      send(method, params) {
        return new Promise((res, rej) => {
          const id = ++idc;
          pending.set(id, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
          ws.send(JSON.stringify({ id, method, params: params || {} }));
          setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + ' 超时')); } }, 30000);
        });
      },
    });
    ws.onerror = () => reject(new Error('WebSocket 连接失败: ' + url));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
  });
}

async function main() {
  const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chromePath) throw new Error('未找到 Chrome/Edge 可执行文件（可设 CHROME_PATH）');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  log('启动 headless Chrome');
  chromeProc = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=800,600',
    '--enable-unsafe-extension-debugging',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  chromeProc.on('error', (e) => { throw new Error('Chrome 启动失败: ' + e.message); });

  const version = await waitVersion();
  log('CDP 就绪: ' + version.Browser);
  const browserWs = await connectWs(version.webSocketDebuggerUrl);
  const r = await browserWs.send('Extensions.loadUnpacked', { path: EXT_DIR });
  const extId = r && r.id;
  if (!extId) throw new Error('Extensions.loadUnpacked 失败');
  log('扩展 ID: ' + extId);

  const tab = await fetchJson('http://127.0.0.1:' + PORT + '/json/new?about:blank', { method: 'PUT' });
  const page = await connectWs(tab.webSocketDebuggerUrl);

  // 视口锁定为 popup 物理尺寸（380×270），2x 超采样出高清图
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 380, height: 270, deviceScaleFactor: 2, mobile: false,
  });
  await page.send('Page.navigate', { url: 'chrome-extension://' + extId + '/popup.html' });
  await sleep(2500);

  // 注入公开安全的演示数据（状态卡 running + 四态会话；不触碰真实 dsh）
  const setup = `(async () => {
    const frame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));
    refreshSessions = () => {}; // 冻结 2s 轮询（真实实例在跑时会覆盖 mock）
    if (typeof pollTimer === 'number' || pollTimer) { clearInterval(pollTimer); pollTimer = null; } // 冻结状态轮询（防真实 status 覆盖 mock）
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    const NOW = Date.now(); const MIN = 60000;
    state = 'running';
    detail = { lifecycle: true, pid: 53844, health: { uptimeMs: 46 * MIN + 12 * 1000, nodeVersion: 'v24.19.0' } };
    settings = Object.assign({}, settings, { port: 3080, retentionMins: 30 });
    readSessions = {};
    sessionsData = { available: true, items: [
      { sessionId: 's-demo-waiting', title: '计划审查：升级方案待拍板', state: 'waiting', updatedAt: NOW - 2 * MIN, blank: false },
      { sessionId: 's-demo-working', title: '深海检索：目标海域巡航资料', state: 'working', updatedAt: NOW - 4 * MIN, blank: false },
      { sessionId: 's-demo-stopped', title: '主会话已停止·子代理未归', state: 'completed', updatedAt: NOW - 120 * MIN, blank: false,
        hasActiveChildren: true, childRuns: [ { childId: 'c1', label: '子代理：文档交叉核对' }, { childId: 'c2' } ] },
      { sessionId: 's-demo-done', title: '数据清洗报告已出', state: 'completed', updatedAt: NOW - 5 * MIN, blank: false,
        hasActiveChildren: false, childRuns: [] },
    ]};
    render(); applySessions();
    await frame(); await frame();
    switchV6('dash');
    await frame();
    return JSON.stringify({ ready: true, ok: !!document.getElementById('v6-p-dash') });
  })()`;
  const st = await page.send('Runtime.evaluate', { expression: setup, returnByValue: true, awaitPromise: true });
  log('注入: ' + (st.result && st.result.value));
  await sleep(600);

  async function shot(name) {
    const s = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const f = path.join(OUT_DIR, name);
    fs.writeFileSync(f, Buffer.from(s.data, 'base64'));
    log('已存 ' + f + ' (' + fs.statSync(f).size + ' bytes)');
  }

  // 1) 浅色：服务概览
  await shot('popup-dashboard-light.png');

  // 2) 浅色：会话感知
  await page.send('Runtime.evaluate', { expression: 'switchV6("sess")', returnByValue: true });
  await sleep(500);
  await shot('popup-sessions-light.png');

  // 3) 浅色：首选项设置——上/下两屏（纵向内容长，拆两张并排展示，避免长图）
  //    上屏：scrollTop=0（服务运行环境 + 徽标与外观）
  await page.send('Runtime.evaluate', {
    expression: 'switchV6("sett"); renderSettingsForm(); const p1 = document.getElementById("v6-p-sett"); if (p1) p1.scrollTop = 0;',
    returnByValue: true,
  });
  await sleep(500);
  await shot('popup-settings-top-light.png');
  //    下屏：scrollTop=底部（扩展徽标与会话颜色 + 会话感知 + 保存操作栏）
  await page.send('Runtime.evaluate', {
    expression: 'const p2 = document.getElementById("v6-p-sett"); if (p2) p2.scrollTop = p2.scrollHeight;',
    returnByValue: true,
  });
  await sleep(500);
  await shot('popup-settings-bottom-light.png');

  // 4) 深色：服务概览（V6 深色令牌走 body[data-ds-dark-theme] 渲染标记，与 webui 同规范）
  await page.send('Runtime.evaluate', {
    expression: 'document.body.setAttribute("data-ds-dark-theme", ""); switchV6("dash");',
    returnByValue: true,
  });
  await sleep(500);
  await shot('popup-dashboard-dark.png');

  log('全部完成');
  try { await browserWs.send('Browser.close'); } catch (_) { /* 已关闭 */ }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[shots] 异常:', e.message || e);
    if (chromeProc && chromeProc.pid) {
      try { require('child_process').spawnSync('taskkill', ['/PID', String(chromeProc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (_) { /* 忽略 */ }
    }
    process.exit(1);
  });
