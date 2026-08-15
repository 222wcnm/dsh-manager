'use strict';
// ============================================================================
// verify-cdp.js — 零依赖 CDP 直连的扩展 UI 最小验收（沙箱内可用）
//
// 为什么存在（tools/verify-ui/README.md）：
//   chrome-devtools-mcp 仅提供 stdio 传输（无 HTTP 模式），而受限沙箱拦截
//   子进程 stdio 管道（实测 spawn EINVAL）；另一方面 headless Chrome +
//   CDP（HTTP /json + WebSocket）在沙箱内实测可用。本脚本沿用
//   tools/icons/_gen-icons.js 的零依赖 CDP 手法（Node ≥ 22 内置 fetch/WebSocket）：
//     1. 启动 headless Chrome（独立临时 profile + --remote-debugging-port）
//     2. CDP Extensions.loadUnpacked 加载本仓库 extension/（unpacked）
//     3. 同一标签页依次打开 popup.html 与 logs.html：
//        读 document.body.innerText 做文本断言 + Page.captureScreenshot 存档
//     4. 收集页面 console 异常（exceptionThrown / console.error）并汇报
//     5. Browser.close 干净收尾（失败则 taskkill 兜底），删除临时 profile
//
// 用法：  node tools/verify-ui/verify-cdp.js
// 环境：  CHROME_PATH 可指定 Chrome；VERIFY_CDP_PORT 可换调试端口（默认 9335）
// 产物：  tools/verify-ui/shots/{popup,logs}.png + {popup,logs}-text.txt（gitignore）
// ============================================================================
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const EXT_DIR = path.join(ROOT, 'extension');
const SHOTS_DIR = path.join(__dirname, 'shots');
const PORT = Number(process.env.VERIFY_CDP_PORT) || 9335;
const PROFILE = path.join(os.tmpdir(), 'dsh-verify-ui-' + Date.now());
const CHROME_CANDIDATES = [
  ...(process.env.CHROME_PATH ? [process.env.CHROME_PATH] : []),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const results = [];
let chromeProc = null;
let browserWs = null;

function log(...a) { console.log('[verify-cdp]', ...a); }
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fail(msg) {
  console.error('[verify-cdp] 失败: ' + msg);
  await cleanup();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CDP 基础：HTTP 端点 + WebSocket 会话
// ---------------------------------------------------------------------------
async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.json();
}

async function waitVersion() {
  for (let i = 0; i < 60; i++) {
    try {
      const v = await fetchJson('http://127.0.0.1:' + PORT + '/json/version');
      return v;
    } catch (_) { await sleep(250); }
  }
  throw new Error('Chrome CDP 未就绪（60 次轮询失败）');
}

// WebSocket CDP 会话：send(method, params) -> result；事件进入 onEvent 回调
function connectWs(url, onEvent) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let idc = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      ws,
      send(method, params) {
        return new Promise((res, rej) => {
          const id = ++idc;
          pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)));
          ws.send(JSON.stringify({ id, method, params: params || {} }));
          setTimeout(() => {
            if (pending.has(id)) { pending.delete(id); rej(new Error(method + ' 超时')); }
          }, 30000);
        });
      },
    });
    ws.onerror = (e) => reject(new Error('WebSocket 连接失败: ' + url));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      } else if (onEvent) {
        try { onEvent(m); } catch (_) { /* 事件回调异常不影响协议 */ }
      }
    };
  });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chromePath) fail('未找到 Chrome/Edge 可执行文件（可设 CHROME_PATH）');
  log('Chrome: ' + chromePath);
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  log('启动 headless Chrome（profile: ' + PROFILE + '）');
  chromeProc = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1280,900',
    '--enable-unsafe-extension-debugging', // 新版 Chrome 可能已无需此旗标，传了也无害
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  chromeProc.on('error', (e) => fail('Chrome 启动失败: ' + e.message));
  const version = await waitVersion();
  log('CDP 就绪: ' + version.Browser);

  browserWs = await connectWs(version.webSocketDebuggerUrl, (m) => {
    if (m.method === 'Browser.downloadProgress') { /* 忽略 */ }
  });

  // 1) 加载 unpacked 扩展（CDP Extensions 域）
  log('加载 unpacked 扩展: ' + EXT_DIR);
  let extId = null;
  try {
    const r = await browserWs.send('Extensions.loadUnpacked', { path: EXT_DIR });
    extId = r && r.id;
    record('Extensions.loadUnpacked', !!extId, 'extensionId=' + extId);
  } catch (e) {
    fail('CDP Extensions.loadUnpacked 失败（Chrome 版本过旧或域不可用）: ' + e.message);
  }

  // 2) 新标签页依次访问 popup.html 与 logs.html
  const tab = await fetchJson('http://127.0.0.1:' + PORT + '/json/new?about:blank', { method: 'PUT' });
  const consoleErrors = [];
  const page = await connectWs(tab.webSocketDebuggerUrl, (m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params && m.params.exceptionDetails;
      consoleErrors.push('exception: ' + (d && d.text || JSON.stringify(d)).slice(0, 400));
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params && m.params.type === 'error') {
      const args = (m.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || ''))).join(' ');
      consoleErrors.push('console.error: ' + args.slice(0, 400));
    }
  });
  await page.send('Runtime.enable');
  await page.send('Page.enable');

  const visit = async (path, label) => {
    await page.send('Page.navigate', { url: 'chrome-extension://' + extId + '/' + path });
    await sleep(3000); // 等页面脚本与 chrome.* 异步调用收敛
    const ev = await page.send('Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText : ""',
      returnByValue: true,
    });
    const text = ev && ev.result ? String(ev.result.value || '') : '';
    fs.writeFileSync(pathShots(label + '-text.txt'), text, 'utf8');
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    const png = pathShots(label + '.png');
    fs.writeFileSync(png, Buffer.from(shot.data, 'base64'));
    record(label + ' 截图', fs.statSync(png).size > 2000, png + ' (' + fs.statSync(png).size + ' bytes)');
    return text;
  };

  function pathShots(n) { return path.join(SHOTS_DIR, n); }

  // 3) popup：断言标题与状态行/错误面板（沙箱内宿主未注册 → 预期出现 HOST_NOT_INSTALLED 文案）
  log('访问 popup.html');
  const popupText = await visit('popup.html', 'popup');
  record('popup 含标题「dsh web」', popupText.includes('dsh web'), JSON.stringify(popupText.split('\n').slice(0, 4)));
  record('popup 渲染状态/错误文案', popupText.includes('状态：') || popupText.includes('未安装宿主'),
    (popupText.includes('状态：') ? '状态行存在' : popupText.includes('未安装宿主') ? 'HOST_NOT_INSTALLED 面板（沙箱内预期）' : '缺失'));
  record('popup 含「查看日志」入口', popupText.includes('查看日志'), '');

  // 4) logs.html：断言标题与错误横幅/日志底栏
  log('访问 logs.html');
  const logsText = await visit('logs.html', 'logs');
  record('logs 含标题「dsh web 日志」', logsText.includes('dsh web 日志'), '');
  record('logs 渲染错误横幅或底栏', logsText.includes('未安装宿主') || logsText.includes('日志文件：'),
    logsText.includes('未安装宿主') ? 'HOST_NOT_INSTALLED 横幅（沙箱内预期）' : logsText.includes('日志文件：') ? '日志底栏存在' : '缺失');

  // 5) console 异常汇总（只统计扩展页面 popup/logs 阶段；后续 dsh GUI 页面自身的日志不算）
  record('扩展页面无未捕获异常', consoleErrors.length === 0, consoleErrors.length ? consoleErrors.join(' ||| ').slice(0, 800) : '');
  for (const e of consoleErrors.slice(0, 5)) log('  console: ' + e);
  consoleErrors.length = 0; // 清空：面板步骤在真实 dsh GUI 页面上，其自身日志与扩展无关

  // 6) 页面内管理面板（design §8.6）：注入真实 dsh Web UI 页面并断言 shadow 面板
  const dshUrl = process.env.VERIFY_DSH_URL || 'http://127.0.0.1:8080/';
  log('访问 dsh Web UI 并检查页面内管理面板: ' + dshUrl);
  await page.send('Page.navigate', { url: dshUrl });
  await sleep(8000); // 等 SPA 加载 + content script 注入 + 首轮 status 轮询
  const evp = await page.send('Runtime.evaluate', {
    expression: `(() => {
      const h = document.getElementById('dsh-manager-panel-host');
      if (!h || !h.shadowRoot) return JSON.stringify({ injected: false });
      const chip = h.shadowRoot.querySelector('.chip');
      const status = h.shadowRoot.querySelector('.status-text');
      const dot = h.shadowRoot.querySelector('.dot');
      return JSON.stringify({
        injected: true,
        chip: chip ? chip.textContent.trim() : '',
        status: status ? status.textContent.trim() : '',
        dot: dot ? dot.className : '',
      });
    })()`,
    returnByValue: true,
  });
  let panelInfo = { injected: false };
  try { panelInfo = JSON.parse(evp && evp.result ? String(evp.result.value) : '{}'); } catch (_) { /* 保持默认 */ }
  record('页面内管理面板已注入', panelInfo.injected === true, JSON.stringify(panelInfo));
  record('面板徽章文本', typeof panelInfo.chip === 'string' && panelInfo.chip.length > 0, panelInfo.chip);
  record('面板状态文本', typeof panelInfo.status === 'string' && panelInfo.status.length > 0, panelInfo.status);
  record('面板：托管运行中为绿点且显示端口',
    panelInfo.dot === 'dot dot-running' && /端口 \d+/.test(panelInfo.status || ''),
    JSON.stringify(panelInfo));
  const shot3 = await page.send('Page.captureScreenshot', { format: 'png' });
  const panelPng = pathShots('panel.png');
  fs.writeFileSync(panelPng, Buffer.from(shot3.data, 'base64'));
  record('panel 截图', fs.statSync(panelPng).size > 2000, panelPng + ' (' + fs.statSync(panelPng).size + ' bytes)');

  // 7) 展开面板：点击徽章后断言状态行 + 停止/重启按钮（绝不点击操作按钮——面板面向真实实例）；
  //    同时断言胶囊位置在展开前后不变、面板从胶囊上方展开（回归：body 曾为流内元素把胶囊顶上去）
  const chipRectBefore = await page.send('Runtime.evaluate', {
    expression: `(() => {
      const h = document.getElementById('dsh-manager-panel-host');
      if (!h || !h.shadowRoot) return JSON.stringify({ ok: false });
      const r = h.shadowRoot.querySelector('.chip').getBoundingClientRect();
      return JSON.stringify({ ok: true, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
    })()`,
    returnByValue: true,
  });
  await page.send('Runtime.evaluate', {
    expression: `(() => {
      const h = document.getElementById('dsh-manager-panel-host');
      if (!h || !h.shadowRoot) return 'no-host';
      h.shadowRoot.querySelector('.chip').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'clicked';
    })()`,
    returnByValue: true,
  });
  await sleep(1500); // 展开时立即触发一次 status 刷新
  const evo = await page.send('Runtime.evaluate', {
    expression: `(() => {
      const h = document.getElementById('dsh-manager-panel-host');
      if (!h || !h.shadowRoot) return JSON.stringify({ open: false });
      const body = h.shadowRoot.querySelector('.body');
      const visible = !!body && getComputedStyle(body).display !== 'none';
      const buttons = Array.from(h.shadowRoot.querySelectorAll('.btn')).map((b) => ({ text: b.textContent.trim(), disabled: b.disabled }));
      const cr = h.shadowRoot.querySelector('.chip').getBoundingClientRect();
      const br = body.getBoundingClientRect();
      return JSON.stringify({
        open: visible,
        buttons,
        chip: { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height) },
        body: { bottom: Math.round(br.bottom), top: Math.round(br.top) },
      });
    })()`,
    returnByValue: true,
  });
  let openInfo = { open: false };
  try { openInfo = JSON.parse(evo && evo.result ? String(evo.result.value) : '{}'); } catch (_) { /* 保持默认 */ }
  record('面板展开（点击徽章）', openInfo.open === true, JSON.stringify(openInfo));
  record('面板含停止/重启按钮且停止可用', Array.isArray(openInfo.buttons) && openInfo.buttons.length === 2
    && openInfo.buttons[0].text === '停止' && openInfo.buttons[0].disabled === false
    && openInfo.buttons[1].text === '重启' && openInfo.buttons[1].disabled === false,
    JSON.stringify(openInfo.buttons));
  let beforeRect = null;
  try { beforeRect = JSON.parse(String(chipRectBefore.result.value)); } catch (_) { /* 保持默认 */ }
  const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1;
  const chipStable = !!(beforeRect && beforeRect.ok && openInfo.chip
    && near(beforeRect.x, openInfo.chip.x) && near(beforeRect.y, openInfo.chip.y)
    && near(beforeRect.w, openInfo.chip.w) && near(beforeRect.h, openInfo.chip.h));
  record('面板展开时胶囊位置不变', chipStable,
    'before=' + JSON.stringify(beforeRect) + ' after=' + JSON.stringify(openInfo.chip));
  const bodyAbove = !!(openInfo.open && openInfo.body && openInfo.chip
    && openInfo.body.bottom <= openInfo.chip.y + 1);
  record('面板展开在胶囊上方', bodyAbove,
    'body.bottom=' + JSON.stringify(openInfo.body && openInfo.body.bottom) + ' chip.y=' + JSON.stringify(openInfo.chip && openInfo.chip.y));
  const shot4 = await page.send('Page.captureScreenshot', { format: 'png' });
  const panelOpenPng = pathShots('panel-open.png');
  fs.writeFileSync(panelOpenPng, Buffer.from(shot4.data, 'base64'));
  record('panel-open 截图', fs.statSync(panelOpenPng).size > 2000, panelOpenPng + ' (' + fs.statSync(panelOpenPng).size + ' bytes)');

  // 7b) 停止两步确认（安全：只验证确认态出现与 3s 超时还原，绝不二次点击执行）
  await page.send('Runtime.evaluate', {
    expression: `(() => {
      const h = document.getElementById('dsh-manager-panel-host');
      h.shadowRoot.querySelectorAll('.btn')[0].click();
      return 'clicked';
    })()`,
    returnByValue: true,
  });
  await sleep(400);
  const confirmText = await page.send('Runtime.evaluate', {
    expression: `(() => {
      const h = document.getElementById('dsh-manager-panel-host');
      const b = h.shadowRoot.querySelectorAll('.btn')[0];
      return JSON.stringify({ text: b.textContent.trim(), confirm: b.classList.contains('confirm') });
    })()`,
    returnByValue: true,
  });
  try {
    const ct = JSON.parse(String(confirmText.result.value));
    record('面板：停止首击进入确认态', ct.confirm === true && ct.text === '确认停止', JSON.stringify(ct));
  } catch (_) {
    record('面板：停止首击进入确认态', false, '解析失败');
  }
  await sleep(3200); // 超过 3s 确认窗口，未二次点击必须还原
  const revertText = await page.send('Runtime.evaluate', {
    expression: `(() => {
      const h = document.getElementById('dsh-manager-panel-host');
      const b = h.shadowRoot.querySelectorAll('.btn')[0];
      return JSON.stringify({ text: b.textContent.trim(), confirm: b.classList.contains('confirm') });
    })()`,
    returnByValue: true,
  });
  try {
    const rt = JSON.parse(String(revertText.result.value));
    record('面板：确认态 3s 超时还原', rt.confirm === false && rt.text === '停止', JSON.stringify(rt));
  } catch (_) {
    record('面板：确认态 3s 超时还原', false, '解析失败');
  }

  // 8) 徽标（M4 动态端口路径）：附加扩展 service worker 实测——
  //    port 0 → refreshBadge 走 native status 分支（本机真实 dsh 在跑 → 绿点）；
  //    无监听端口 → 清空；恢复默认设置。回归守护 background.js 的 `|| 3080` 吞 0 缺陷。
  const targets = await fetchJson('http://127.0.0.1:' + PORT + '/json/list');
  const swCandidates = targets.filter((t) => t.type === 'service_worker');
  record('徽标：service_worker 目标清单', swCandidates.length > 0,
    JSON.stringify(swCandidates.map((t) => t.url)));
  // 必须按本扩展 ID 精确匹配：Chrome 组件扩展也可能有 service_worker
  // （其 SW 无 chrome.action/chrome.storage API），find 首个会选错
  const swTarget = swCandidates.find((t) => (t.url || '').includes(extId));
  if (!swTarget) {
    record('徽标（扩展 SW 目标）', false, '未找到扩展 service worker target');
  } else {
    try {
      const sw = await connectWs(swTarget.webSocketDebuggerUrl);
      await sw.send('Runtime.enable');
      const evalInSw = async (expr) => {
        const r = await sw.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (!r || !r.result) return { value: undefined, raw: JSON.stringify(r) };
        if (r.result.exceptionDetails) {
          return { value: undefined, raw: 'exception: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 500) };
        }
        return { value: r.result.value, raw: '' };
      };
      const probe = await evalInSw(`JSON.stringify({ chrome: typeof chrome, action: typeof (typeof chrome !== 'undefined' && chrome.action), getBadgeText: typeof (typeof chrome !== 'undefined' && chrome.action && chrome.action.getBadgeText), refreshBadge: typeof refreshBadge, storage: typeof (typeof chrome !== 'undefined' && chrome.storage) })`);
      record('徽标：SW 环境探针', true, String(probe.value));
      await evalInSw(`(async () => { await chrome.storage.local.set({ settings: { port: 0, profile: 'web', autoOpen: true, badgeInterval: 30 } }); })()`);
      await evalInSw('refreshBadge()');
      const badge0 = await evalInSw('chrome.action.getBadgeText({})');
      record('徽标：port 0 经 native status 显示绿点', badge0.value === '●', 'badge=' + JSON.stringify(badge0.value) + (badge0.raw ? ' ' + badge0.raw : ''));
      await evalInSw(`(async () => { await chrome.storage.local.set({ settings: { port: 59999, profile: 'web', autoOpen: true, badgeInterval: 30 } }); })()`);
      await evalInSw('refreshBadge()');
      const badgeNone = await evalInSw('chrome.action.getBadgeText({})');
      record('徽标：无监听端口清空', badgeNone.value === '', 'badge=' + JSON.stringify(badgeNone.value) + (badgeNone.raw ? ' ' + badgeNone.raw : ''));
      await evalInSw(`(async () => { await chrome.storage.local.set({ settings: { port: 3080, profile: 'web', autoOpen: true, badgeInterval: 30 } }); })()`);
      await evalInSw('refreshBadge()');
      const badgeDefault = await evalInSw('chrome.action.getBadgeText({})');
      record('徽标：恢复默认端口后无异常', badgeDefault.value === '●' || badgeDefault.value === '', 'badge=' + JSON.stringify(badgeDefault.value) + (badgeDefault.raw ? ' ' + badgeDefault.raw : ''));
    } catch (e) {
      record('徽标（扩展 SW 目标）', false, 'SW 附加失败: ' + e.message);
    }
  }

  // 8b) 面板重载回归：扩展重载（chrome://extensions「重新加载」等价，同路径 loadUnpacked
  //     会替换已加载实例）后，已打开页面里的旧内容脚本上下文失效——曾表现为永久红错
  //     「状态获取失败」直到刷新页面。现在应显示「已断开」中性提示并停止轮询；
  //     刷新页面后新面板注入并恢复托管状态。
  log('面板重载回归（扩展重载 → 提示刷新；刷新页面 → 恢复）');
  await browserWs.send('Extensions.loadUnpacked', { path: EXT_DIR });
  await sleep(4000);
  const det = await page.send('Runtime.evaluate', {
    expression: `(() => {
      const h = document.getElementById('dsh-manager-panel-host');
      if (!h || !h.shadowRoot) return JSON.stringify({ injected: false });
      const s = h.shadowRoot.querySelector('.status-text');
      const d = h.shadowRoot.querySelector('.dot');
      const c = h.shadowRoot.querySelector('.chip');
      return JSON.stringify({ injected: true, status: s ? s.textContent.trim() : '', dot: d ? d.className : '', chip: c ? c.textContent.trim() : '' });
    })()`,
    returnByValue: true,
  });
  let detInfo = { injected: false };
  try { detInfo = JSON.parse(String(det.result.value)); } catch (_) { /* 保持默认 */ }
  record('面板：扩展重载后提示刷新（非红错）',
    detInfo.injected === true && /刷新页面/.test(detInfo.status || '') && !/dot-error/.test(detInfo.dot || ''),
    JSON.stringify(detInfo));
  await page.send('Page.reload');
  await sleep(8000);
  const rec = await page.send('Runtime.evaluate', {
    expression: `(() => {
      const h = document.getElementById('dsh-manager-panel-host');
      if (!h || !h.shadowRoot) return JSON.stringify({ injected: false });
      const s = h.shadowRoot.querySelector('.status-text');
      const d = h.shadowRoot.querySelector('.dot');
      return JSON.stringify({ injected: true, status: s ? s.textContent.trim() : '', dot: d ? d.className : '' });
    })()`,
    returnByValue: true,
  });
  let recInfo = { injected: false };
  try { recInfo = JSON.parse(String(rec.result.value)); } catch (_) { /* 保持默认 */ }
  record('面板：刷新页面后恢复托管状态',
    recInfo.injected === true && /运行中/.test(recInfo.status || '') && recInfo.dot === 'dot dot-running',
    JSON.stringify(recInfo));

  // 9) 日志页交互（安全只读）：点「加载更早」（真实日志 < 500 行 → toast 已到开头）
  //    与「复制全部」（toast 显示行数）——验证按钮/toast 链路，不触碰生命周期。
  log('日志页交互（加载更早 / 复制全部）');
  await page.send('Page.navigate', { url: 'chrome-extension://' + extId + '/logs.html' });
  await sleep(3000);
  const clickInPage = async (expr) => {
    const r = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r && r.result ? String(r.result.value ?? '') : '';
  };
  // 等待初始加载完成（按钮可用且底栏出现）再点击——2s 跟随刷新会短暂 busy，
  // 直接点击可能落在禁用窗口被静默丢弃
  let clickState = 'timeout';
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    clickState = await clickInPage(`(() => {
      const b = document.getElementById('btn-load-earlier');
      const f = document.getElementById('footer');
      return JSON.stringify({ disabled: b ? b.disabled : null, footerReady: f ? f.textContent.includes('已加载') : false });
    })()`);
    if (clickState.includes('"disabled":false') && clickState.includes('"footerReady":true')) break;
  }
  const readyForClick = clickState.includes('"disabled":false') && clickState.includes('"footerReady":true');
  if (readyForClick) {
    await clickInPage(`(() => { document.getElementById('btn-load-earlier').click(); return 'clicked'; })()`);
  }
  let earlierToast = '';
  for (let i = 0; i < 8; i++) {
    await sleep(500);
    earlierToast = await clickInPage(`(() => { const t = document.getElementById('toast-text'); return t ? t.textContent : ''; })()`);
    if (earlierToast) break;
  }
  record('日志页：加载更早反馈', readyForClick && /已到日志开头|已暂停自动刷新/.test(earlierToast),
    earlierToast + (earlierToast ? '' : '（点击前状态: ' + clickState + '）'));
  await clickInPage(`(() => { const b = document.getElementById('btn-copy'); if (b) b.click(); return 'clicked'; })()`);
  await sleep(1500);
  const copyInfo = await clickInPage(`(() => {
    const t = document.getElementById('toast-text');
    return t ? t.textContent : '';
  })()`);
  record('日志页：复制全部反馈', /已复制|没有可复制|复制失败/.test(copyInfo), copyInfo);

  // 10) popup 设置面板交互（安全）：展开设置 → 断言字段；无效端口 → 红框错误文案；
  //     改回合法值保存 → toast；取消关闭。
  log('popup 设置面板交互');
  await page.send('Page.navigate', { url: 'chrome-extension://' + extId + '/popup.html' });
  await sleep(3000);
  await clickInPage(`(() => { const b = document.getElementById('btn-settings'); if (b) b.click(); return 'clicked'; })()`);
  await sleep(800);
  const settingsOpen = await clickInPage(`(() => {
    const p = document.getElementById('settings-panel');
    const port = document.getElementById('set-port');
    return JSON.stringify({ open: !!(p && !p.classList.contains('hidden')), portValue: port ? port.value : '' });
  })()`);
  try {
    const so = JSON.parse(settingsOpen);
    record('popup：设置面板展开', so.open === true, settingsOpen);
  } catch (_) {
    record('popup：设置面板展开', false, settingsOpen);
  }
  await clickInPage(`(() => {
    const input = document.getElementById('set-port');
    input.value = '70000';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-save').click();
    return 'saved';
  })()`);
  await sleep(800);
  const invalidInfo = await clickInPage(`(() => {
    const e = document.getElementById('settings-error');
    const input = document.getElementById('set-port');
    return JSON.stringify({ err: e ? e.textContent : '', invalid: input ? input.classList.contains('field-invalid') : false });
  })()`);
  try {
    const ii = JSON.parse(invalidInfo);
    record('popup：无效端口校验（红框 + 文案）', ii.invalid === true && /0-65535/.test(ii.err), ii.err);
  } catch (_) {
    record('popup：无效端口校验（红框 + 文案）', false, invalidInfo);
  }
  await clickInPage(`(() => {
    const input = document.getElementById('set-port');
    input.value = '3080';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-save').click();
    return 'saved';
  })()`);
  await sleep(1000);
  const saveInfo = await clickInPage(`(() => {
    const t = document.getElementById('toast-text');
    return t ? t.textContent : '';
  })()`);
  record('popup：合法设置保存 toast', saveInfo.includes('设置已保存'), saveInfo);

  await cleanup();
  const failed = results.filter((r) => !r.ok);
  log('=== 汇总 ===  PASS ' + (results.length - failed.length) + ' / FAIL ' + failed.length);
  log('产物目录: ' + SHOTS_DIR);
  process.exit(failed.length ? 1 : 0);
}

async function cleanup() {
  try {
    if (browserWs && browserWs.ws && browserWs.ws.readyState === 1) {
      try { await browserWs.send('Browser.close'); } catch (_) { /* 忽略 */ }
    }
  } catch (_) { /* 忽略 */ }
  try {
    if (chromeProc && chromeProc.pid) {
      spawnSync('taskkill', ['/PID', String(chromeProc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
  } catch (_) { /* 忽略 */ }
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
}

main().catch(async (e) => {
  console.error('[verify-cdp] 异常: ' + (e && e.stack || e));
  await cleanup();
  process.exit(1);
});
