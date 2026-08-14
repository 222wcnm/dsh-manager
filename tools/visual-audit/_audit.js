'use strict';
// ============================================================================
// _audit.js — popup 视觉审计（一次性工具，脱离沙箱运行）
// 用 headless Chrome + CDP：
//   1. 渲染 _preview.html 的 6 个状态并截图到 _shots\*.png；
//   2. 提取关键元素的 computed style 与 bounding rect → _audit.json；
//   3. 打开 dsh Web UI 存档（5f6ed241-….htm），提取其真实设计令牌计算值
//      与代表性按钮样式，供与 popup.css 逐项对比。
// ============================================================================
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const SHOTS = path.join(__dirname, 'shots');
const PREVIEW = 'file:///' + path.join(__dirname, 'preview.html').replace(/\\/g, '/');
const ARCHIVE_FILE = path.join(ROOT, '5f6ed241-486a-478e-8fe2-b5340b9d92fd.htm');
const ARCHIVE = fs.existsSync(ARCHIVE_FILE) ? 'file:///' + ARCHIVE_FILE.replace(/\\/g, '/') : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.json();
}

// 等到 CDP 就绪
async function waitCdp() {
  for (let i = 0; i < 40; i++) {
    try { await fetchJson('http://127.0.0.1:' + PORT + '/json/version'); return; } catch (_) { await sleep(250); }
  }
  throw new Error('CDP 未就绪');
}

// 为 URL 打开一个新标签页，返回 WebSocket 客户端封装
async function openPage(url) {
  const t = await fetchJson('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(url), { method: 'PUT' });
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let idc = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise((res) => {
    const id = ++idc;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  return { ws, send, targetId: t.id };
}

async function evalJs(send, expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  const inner = r && r.result && r.result.result;
  if ((r && r.result && r.result.exceptionDetails) || (inner && inner.exceptionDetails)) {
    const d = (r && r.result && r.result.exceptionDetails) || inner.exceptionDetails;
    throw new Error('JS 异常: ' + JSON.stringify(d).slice(0, 400));
  }
  return inner ? inner.value : undefined;
}

// 提取指定选择器的 computed style（含 ::before/::after）与 rect
// 注意：getPropertyValue 只接受 kebab-case 属性名
const STYLE_PROPS = ['color', 'background-color', 'border-color', 'border-width', 'border-style',
  'border-radius', 'font-family', 'font-size', 'font-weight', 'line-height', 'width', 'height',
  'padding', 'margin', 'display', 'visibility', 'opacity', 'box-shadow', 'gap'];

function auditExpr(selectors) {
  return `(() => {
    const out = {};
    const props = ${JSON.stringify(STYLE_PROPS)};
    for (const sel of ${JSON.stringify(selectors)}) {
      const el = document.querySelector(sel);
      if (!el) { out[sel] = null; continue; }
      const cs = getComputedStyle(el);
      const entry = {};
      for (const p of props) entry[p] = cs.getPropertyValue(p);
      const before = getComputedStyle(el, '::before');
      const after = getComputedStyle(el, '::after');
      entry.pseudoBefore = { color: before.getPropertyValue('color'), backgroundColor: before.getPropertyValue('background-color'), opacity: before.getPropertyValue('opacity'), borderRadius: before.getPropertyValue('border-radius') };
      entry.pseudoAfter = { color: after.getPropertyValue('color'), backgroundColor: after.getPropertyValue('background-color'), opacity: after.getPropertyValue('opacity'), borderRadius: after.getPropertyValue('border-radius'), animation: after.getPropertyValue('animation-name') };
      const r = el.getBoundingClientRect();
      entry.rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      out[sel] = entry;
    }
    return out;
  })()`;
}

const SELECTORS = ['body', '.panel', '.status-row', '.brand-logo', '#dot', '.title', '.icon-btn',
  '.url-row', '.url-text', '.uptime-text', '.btn-row', '#btn-start', '#btn-stop', '#btn-restart',
  '#btn-adopt', '#btn-open', '#detail-line', '#error-panel', '.error-text', '#btn-copy-log',
  '.hint', '.settings', '.settings-title', '.field-label', '#set-port', '.field input[type="checkbox"]', '#btn-save', '#btn-cancel'];

const STATES = ['stopped', 'running', 'external', 'starting', 'error', 'settings-stopped'];

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1', '--window-size=320,720',
    '--user-data-dir=' + path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'chrome-headless-dsh'),
    '--remote-debugging-port=' + PORT,
    'about:blank',
  ], { stdio: 'ignore' });
  try {
    await waitCdp();
    const audit = { states: {}, tokensPreview: {}, tokensWebUi: {}, webUiReference: {} };

    for (const st of STATES) {
      const page = await openPage(PREVIEW + '#' + st);
      await sleep(1500); // 等 popup.js 初始化渲染
      audit.states[st] = await evalJs(page.send, auditExpr(SELECTORS));
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      const shotData = shot && shot.result && shot.result.data;
      if (shotData) fs.writeFileSync(path.join(SHOTS, st + '.png'), Buffer.from(shotData, 'base64'));
      console.log('shot: ' + st + '.png ' + (shotData ? Buffer.from(shotData, 'base64').length + 'B' : 'FAILED'));
      await fetchJson('http://127.0.0.1:' + PORT + '/json/close/' + page.targetId).catch(() => {});
      page.ws.close();
    }

    // popup 页的 :root 令牌计算值
    {
      const page = await openPage(PREVIEW + '#stopped');
      await sleep(1200);
      audit.tokensPreview = await evalJs(page.send, `(() => {
        const cs = getComputedStyle(document.documentElement);
        const names = ['--dsw-alias-label-primary','--dsw-alias-label-secondary','--dsw-alias-label-tertiary',
          '--dsw-alias-label-caption','--dsw-alias-bg-base','--dsw-alias-border-l1','--dsw-alias-border-l2',
          '--dsw-alias-interactive-bg-hover','--dsw-alias-brand-primary','--dsw-alias-button-primary-hover',
          '--dsw-alias-state-success-primary','--dsw-alias-state-warn-primary','--dsw-alias-state-error-primary',
          '--dsw-alias-state-business-primary','--dsw-font-family','--dsw-static-neutral-bluish-1000',
          '--dsw-static-neutral-bluish-750','--dsw-static-neutral-bluish-50','--dsw-static-red-50',
          '--dsw-static-deepseek-500','--dsw-static-green-500','--dsw-static-amber-500','--dsw-static-red-600'];
        const out = {};
        for (const n of names) out[n] = cs.getPropertyValue(n).trim();
        return out;
      })()`);
      await fetchJson('http://127.0.0.1:' + PORT + '/json/close/' + page.targetId).catch(() => {});
      page.ws.close();
    }

    // 真实 Web UI 存档：同批令牌的计算值 + 代表性按钮样式（存档缺失时跳过）
    if (ARCHIVE) {
      const page = await openPage(ARCHIVE);
      await sleep(2000);
      audit.tokensWebUi = await evalJs(page.send, `(() => {
        const cs = getComputedStyle(document.documentElement);
        const names = ['--dsw-alias-label-primary','--dsw-alias-label-secondary','--dsw-alias-label-tertiary',
          '--dsw-alias-label-caption','--dsw-alias-bg-base','--dsw-alias-border-l1','--dsw-alias-border-l2',
          '--dsw-alias-interactive-bg-hover','--dsw-alias-brand-primary','--dsw-alias-button-primary-hover',
          '--dsw-alias-state-success-primary','--dsw-alias-state-warn-primary','--dsw-alias-state-error-primary',
          '--dsw-alias-state-business-primary','--dsw-font-family','--dsw-static-neutral-bluish-1000',
          '--dsw-static-neutral-bluish-750','--dsw-static-neutral-bluish-50','--dsw-static-red-50',
          '--dsw-static-deepseek-500','--dsw-static-green-500','--dsw-static-amber-500','--dsw-static-red-600',
          '--dsw-specific-sidebar-fill','--dsw-alias-bg-layer-2','--dsw-static-neutral-bluish-75',
          '--dsw-alias-button-elevated-fill','--dsw-alias-button-floating-hover'];
        const out = {};
        for (const n of names) out[n] = cs.getPropertyValue(n).trim();
        return out;
      })()`);
      audit.webUiReference = await evalJs(page.send, `(() => {
        const out = {};
        const grab = (sel, extra) => {
          const el = document.querySelector(sel);
          if (!el) { out[sel] = null; return; }
          const cs = getComputedStyle(el);
          const entry = {};
          for (const p of ['color','background-color','border-color','border-width','border-radius','font-family','font-size','font-weight','line-height','width','height','padding','gap','box-shadow','display']) entry[p] = cs.getPropertyValue(p);
          const r = el.getBoundingClientRect();
          entry.rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
          if (extra && extra.before) entry.pseudoBefore = (() => { const b = getComputedStyle(el, '::before'); return { color: b.getPropertyValue('color'), backgroundColor: b.getPropertyValue('background-color'), opacity: b.getPropertyValue('opacity'), borderRadius: b.getPropertyValue('border-radius') }; })();
          out[sel] = entry;
        };
        grab('.hHd-Xa_newSession');       // 侧栏「新建会话」主按钮
        grab('.hHd-Xa_iconButton');       // 侧栏图标按钮（设置齿轮同款）
        grab('.nL4_yW_sessionLogButton'); // 会话导出描边按钮
        grab('.hHd-Xa_root');             // 侧栏容器（背景/字体）
        grab('._dot_10orb_3', { before: true }); // 状态圆点组件
        grab('._row_9cl6j_10');           // 列表行
        return out;
      })()`);
      await fetchJson('http://127.0.0.1:' + PORT + '/json/close/' + page.targetId).catch(() => {});
      page.ws.close();
    } else {
      console.log('archive missing, skipped Web UI token comparison: ' + ARCHIVE_FILE);
    }

    fs.writeFileSync(path.join(__dirname, '_audit.json'), JSON.stringify(audit, null, 2), 'utf8');
    console.log('audit written: _audit.json');
  } finally {
    try { chrome.kill(); } catch (_) {}
    try {
      await fetchJson('http://127.0.0.1:' + PORT + '/json/close/' + (await fetchJson('http://127.0.0.1:' + PORT + '/json/list')).map(t => t.id).join('/')).catch(() => {});
    } catch (_) {}
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
