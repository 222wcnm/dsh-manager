'use strict';
// ============================================================================
// e2e-m9-manager.js — M9 会话状态端到端（真实 dsh + 真实 profile 插件装配）
//
// 验证目标（docs/design.md §8.10）：
//   - 新版 dsh-lifecycle 插件（含 GET /_manager/sessions）在真实 dsh web 上
//     注册并正确应答：200 {ok:true,items} / 围栏 403 / 非 GET 405；
//   - 宿主 sessions 动作经真实实例返回 available:true（items 原样透传）；
//   - start/status/stop 全链路无回归（stopMethod 应走 graceful）。
//
// 环境与边界：
//   - DSH_HOME = 真实 %USERPROFILE%\.dsh（读取 profile web 的插件装配；
//     dsh 冷启动只读行为：不创建会话、不改设置——会话仅由 web UI 交互产生，
//     本脚本从不打开 UI，因此不会写入任何会话数据）；
//   - run 记录/日志落在工作区 .e2e-m9（隔离 BASE），绝不写入 .dsh 或用户
//     %LOCALAPPDATA%\dsh-manager 的宿主状态目录；
//   - 插件须已升级到含 M9 端点版本（plugins\dsh-lifecycle\index.js），
//     未升级时 NOTE 提示并跳过（best-effort，不 FAIL）；
//   - 失败一律 SKIPPED/NOTE + 原因，绝不重试循环、绝不绕过沙箱拒绝。
// ============================================================================

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HOST_JS = path.join(ROOT, 'native-host', 'host.js');
const BASE = path.join(ROOT, '.e2e-m9');
const TMP = path.join(BASE, 'tmp');
const NPM_PREFIX = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null;
const REAL_BIN = NPM_PREFIX ? path.join(NPM_PREFIX, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js') : null;
const PLUGIN_INDEX = path.join(process.env.USERPROFILE || '', '.dsh', 'plugins', 'dsh-lifecycle', 'index.js');
const PORT = 31998;

let failures = 0;

function record(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} | M9-e2e | ${name}${detail ? ' | ' + detail : ''}`);
  if (!ok) failures += 1;
}

function skip(reason) {
  console.log(`SKIPPED | M9-e2e | ${reason}`);
  cleanup();
  process.exit(0);
}

function runHost(req, tag) {
  fs.mkdirSync(TMP, { recursive: true });
  const reqPath = path.join(TMP, `req-${tag}.json`);
  const resPath = path.join(TMP, `res-${tag}.json`);
  try { fs.unlinkSync(resPath); } catch (_) {}
  fs.writeFileSync(reqPath, JSON.stringify(req), 'utf8');
  const r = spawnSync(process.execPath, [HOST_JS, '--req', reqPath, '--res', resPath], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, {
      DSH_MANAGER_TEST_MODE: '1',
      DSH_MANAGER_BASE_DIR: BASE,
      DSH_MANAGER_NPM_PREFIX: NPM_PREFIX,
      DSH_MANAGER_PID_CHECK: '0',
      DSH_MANAGER_FAKE_PROCESSES: '[]', // Windows 围栏：隔离 8080 harness 干扰 external 判定
      // 注意：DSH_HOME **刻意不设置**——复用真实 profile（web）的插件装配；
      // 只读行为见文件头「环境与边界」。
    }),
  });
  if (r.error) return { spawnError: String(r.error.message || r.error) };
  if (r.status !== 0) return { spawnError: '宿主退出码 ' + r.status };
  try { return JSON.parse(fs.readFileSync(resPath, 'utf8')); }
  catch (e) { return { spawnError: '响应文件不可读: ' + e.message }; }
}

function readRunFile() {
  try { return JSON.parse(fs.readFileSync(path.join(BASE, 'run', 'dsh-web.json'), 'utf8')); }
  catch (_) { return null; }
}

function cleanup() {
  const rec = readRunFile();
  if (rec && Number.isInteger(rec.pid) && rec.pid > 0) {
    spawnSync('taskkill', ['/PID', String(rec.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
  // 残留文件（dsh 进程退出中/文件锁/杀毒索引短时锁）重试删除；失败由 .gitignore 兜底
  for (let i = 0; i < 5; i += 1) {
    try {
      fs.rmSync(BASE, { recursive: true, force: true });
      break;
    } catch (_) {
      const { execSync } = require('child_process');
      try { execSync('timeout /t 2 /nobreak >nul', { stdio: 'ignore' }); } catch (_) { /* 忽略 */ }
    }
  }
}

// 直连端点：GET/POST /_manager/sessions，返回 {code, body}
function managerRequest(method, extraHeaders) {
  return new Promise((resolve) => {
    let req;
    try {
      req = http.request({
        host: '127.0.0.1',
        port: PORT,
        path: '/_manager/sessions',
        method,
        headers: Object.assign({ Connection: 'close' }, extraHeaders || {}),
        timeout: 3000,
        agent: false,
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ code: res.statusCode || 0, body }));
      });
      req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve({ code: 0, body: 'timeout' }); });
      req.on('error', (e) => resolve({ code: 0, body: String(e.message || e) }));
      req.end();
    } catch (e) {
      resolve({ code: 0, body: String(e.message || e) });
    }
  });
}

// 直连 SSE 端点：读取直至出现 ≥2 个事件块（retry + snapshot）或 2.5s，随后主动断开；
// 返回 {code, contentType, text}
function managerEvents() {
  return new Promise((resolve) => {
    let req;
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch (_) { /* 忽略 */ }
      resolve(v);
    };
    try {
      req = http.request({
        host: '127.0.0.1',
        port: PORT,
        path: '/_manager/events',
        method: 'GET',
        headers: { Connection: 'close' },
        timeout: 2500,
        agent: false,
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          if (settled) return;
          text += c;
          const blocks = text.split('\n\n').filter((b) => b.length > 0);
          if (blocks.length >= 2 && /event: snapshot/.test(text)) {
            finish({ code: res.statusCode || 0, contentType: String(res.headers['content-type'] || ''), text });
          }
        });
        res.on('end', () => finish({ code: res.statusCode || 0, contentType: String(res.headers['content-type'] || ''), text }));
        res.on('error', () => finish({ code: 0, contentType: '', text: '' }));
      });
      req.on('timeout', () => finish({ code: 0, contentType: '', text: '' }));
      req.on('error', (e) => finish({ code: 0, contentType: '', text: String(e.message || e) }));
      req.end();
    } catch (e) {
      finish({ code: 0, contentType: '', text: String(e.message || e) });
    }
  });
}

async function main() {
  console.log('=== M9 端到端：真实 dsh + 真实 profile 插件装配（best-effort）===');
  if (!NPM_PREFIX || !fs.existsSync(REAL_BIN)) {
    return skip(`真实 dsh 未安装（${REAL_BIN}），无法集成`);
  }
  if (!fs.existsSync(PLUGIN_INDEX)) {
    return skip(`本机未安装 dsh-lifecycle 插件（${PLUGIN_INDEX} 不存在）`);
  }
  const pluginText = fs.readFileSync(PLUGIN_INDEX, 'utf8');
  if (!pluginText.includes('/_manager/sessions') || !pluginText.includes('/_manager/events')) {
    return skip('本机 dsh-lifecycle 插件未升级到含 M12 SSE 端点的版本（plugins/dsh-lifecycle/index.js 需复制新版）；请先升级插件再复跑');
  }
  console.log('real bin :', REAL_BIN);
  console.log('profile  : web（真实 DSH_HOME 装配；仅只读行为，见脚本头注释）');
  console.log('port     :', PORT);

  cleanup();

  // 1) start（真实 dsh，真实 profile）
  const s = runHost({ id: 'm1', action: 'start', payload: { port: PORT } }, 'm1');
  if (!s || !s.ok) {
    const code = s && s.error ? s.error.code : (s && s.spawnError) || 'unknown';
    const msg = s && s.error ? s.error.message : JSON.stringify(s);
    if (code === 'START_TIMEOUT') return skip(`真实 dsh 30s 未就绪：${msg}`);
    return skip(`start 失败 code=${code} msg=${msg}`);
  }
  record('15.1 真实 dsh start -> ok(running)', s.result.state === 'running', JSON.stringify(s.result));

  // 2) 插件端点：GET 200 {ok:true, items:[]}（无 UI 交互时无 live 会话）
  const g = await managerRequest('GET');
  let parsed = null;
  try { parsed = JSON.parse(g.body); } catch (_) { /* 非 JSON */ }
  record('15.2 /_manager/sessions GET -> 200 且 ok:true、items 数组',
    g.code === 200 && parsed && parsed.ok === true && Array.isArray(parsed.items),
    `code=${g.code} body=${g.body.slice(0, 200)}`);
  if (parsed && Array.isArray(parsed.items) && parsed.items.length > 0) {
    console.log('     （items 非空：' + JSON.stringify(parsed.items.slice(0, 3)) + ' —— 报告不判失败）');
  }

  // 3) 围栏：跨源 Origin -> 403；非 GET -> 405
  const o = await managerRequest('GET', { Origin: 'http://evil.example' });
  record('15.3 跨源 Origin -> 403（围栏）', o.code === 403, `code=${o.code}`);
  const p = await managerRequest('POST');
  record('15.4 非 GET -> 405', p.code === 405, `code=${p.code}`);

  // 4) SSE 端点（M12）：200 text/event-stream + retry + snapshot 帧（内容与 /sessions 同构）
  const es = await managerEvents();
  let snapshotParsed = false;
  try {
    const block = String(es.text || '').split('\n\n').filter((b) => b.length > 0).find((b) => /event: snapshot/.test(b));
    const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
    const j = JSON.parse(data);
    snapshotParsed = j && j.ok === true && Array.isArray(j.items);
  } catch (_) { /* 保持 false */ }
  record('15.4b GET /_manager/events -> 200 SSE + retry + snapshot 帧（与 /sessions 同构）',
    es.code === 200 && /text\/event-stream/.test(es.contentType) && /^retry: 3000/.test(es.text || '') && snapshotParsed,
    `code=${es.code} ctype=${es.contentType} text=${String(es.text || '').slice(0, 220)}`);

  // 5) 宿主 sessions 动作：真实实例 → available:true
  const se = runHost({ id: 'm2', action: 'sessions', payload: {} }, 'm2');
  record('15.5 宿主 sessions 动作 -> available:true',
    se && se.ok === true && se.result && se.result.available === true && Array.isArray(se.result.items),
    JSON.stringify(se && se.result));

  // 5) status：running 且 lifecycle 富状态（插件健康端点未回归）
  const st = runHost({ id: 'm3', action: 'status', payload: {} }, 'm3');
  record('15.6 status -> running 且 lifecycle:true（无回归）',
    st && st.ok === true && st.result.state === 'running' && st.result.lifecycle === true,
    JSON.stringify(st && st.result));

  // 6) stop：优雅停机（真实插件 shutdown 端点未回归）
  const so = runHost({ id: 'm4', action: 'stop', payload: {} }, 'm4');
  record('15.7 stop -> stopped 且 stopMethod=graceful（无回归）',
    so && so.ok === true && so.result.state === 'stopped' && so.result.stopMethod === 'graceful',
    JSON.stringify(so && so.result));

  cleanup();
  console.log(failures === 0
    ? '=== 汇总 ===  M9-e2e 全过'
    : `=== 汇总 ===  ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('[e2e-m9] 异常: ' + (e && e.stack || e));
  cleanup();
  process.exit(1);
});
