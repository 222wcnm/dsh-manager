'use strict';
// ============================================================================
// e2e-rc1-isolated.js — 真实 dsh 0.1.2-rc.1 + 本地 dsh-lifecycle 插件
// （隔离 DSH_HOME / 隔离 BASE）验证 M13 上游认证兼容与插件 Session.events 适配。
//
// 运行：
//   node native-host/test/e2e-rc1-isolated.js
//   （可选环境变量 DSH_MANAGER_NPM_PREFIX 指向装有 rc.1 的 npm 前缀；
//     缺省回退 %TEMP%\dsh-rc1-prefix——安装命令：
//       npm install --prefix %TEMP%\dsh-rc1-prefix @deepseek-ai/dsh@0.1.2-rc.1）
//
// 验证点（M13，design §2.1.1/§6.3）：
//   1. 宿主 start 在真实 rc.1（GET / 401 认证闸门）下判定 running（httpProbe 401 视为就绪）
//   2. run 记录/status 捕获 launchUrl（含 ?token=），url 为裸 URL
//   3. GET /manifest.webmanifest 公开 200 含指纹（httpDshProbe 指纹端点）
//   4. 装配的 dsh-lifecycle 插件在真实 rc.1 上 /_manager/sessions 200
//      （B5 Session.events 移除 → snapshotEvents 适配生效）
//   5. stop 正常（插件装配后应走 graceful）
//
// 装配注记（rc.1 loader 实测要求，plugin README 方式 B 已同步）：
//   cordis.patch.yml 的插件 name 必须是 file:// URL 且指向 index.js 入口文件
//   （裸路径报 ERR_UNSUPPORTED_ESM_URL_SCHEME、目录导入报 ERR_UNSUPPORTED_DIR_IMPORT）。
// ============================================================================

const fs = require('fs');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HOST_JS = path.join(ROOT, 'native-host', 'host.js');
const BASE = path.join(ROOT, '.smoke-rc1');
const TMP = path.join(BASE, 'tmp');
const DSH_HOME = path.join(BASE, 'dsh-home');
const PLUGIN_DIR = path.join(ROOT, 'plugin', 'dsh-lifecycle');
const NPM_PREFIX = process.env.DSH_MANAGER_NPM_PREFIX
  || (process.env.TEMP ? path.join(process.env.TEMP, 'dsh-rc1-prefix') : null);
const REAL_BIN = NPM_PREFIX ? path.join(NPM_PREFIX, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js') : null;
const PORT = 31991;

let failures = 0;
function record(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} | rc1-e2e | ${name}${detail ? ' | ' + detail : ''}`);
  if (!ok) failures += 1;
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
      DSH_MANAGER_FAKE_PROCESSES: '[]', // Windows 围栏：隔离本会话 harness 干扰 external 判定
      DSH_HOME, // 隔离到工作区内，绝不触碰真实 %USERPROFILE%\.dsh
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

function httpGet(port, p) {
  return new Promise((resolve) => {
    let req;
    try {
      req = http.get({ host: '127.0.0.1', port, path: p, timeout: 3000, agent: false }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; if (body.length > 65536) { try { req.destroy(); } catch (_) {} } });
        res.on('end', () => resolve({ status: res.statusCode, body }));
        res.on('error', () => resolve({ status: res.statusCode, body }));
      });
      req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve({ status: 0, body: '' }); });
      req.on('error', () => resolve({ status: 0, body: '' }));
    } catch (_) { resolve({ status: 0, body: '' }); }
  });
}

function cleanup() {
  const rec = readRunFile();
  if (rec && Number.isInteger(rec.pid) && rec.pid > 0) {
    spawnSync('taskkill', ['/PID', String(rec.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
  for (let i = 0; i < 5; i += 1) {
    try { fs.rmSync(BASE, { recursive: true, force: true }); break; }
    catch (_) { /* 锁占用重试 */ }
  }
}

async function main() {
  console.log('=== 真实 dsh 0.1.2-rc.1 + 本地插件 e2e（隔离 DSH_HOME）===');
  cleanup();
  if (!NPM_PREFIX || !REAL_BIN || !fs.existsSync(REAL_BIN)) {
    console.log('FAIL | rc1-e2e | 临时前缀 rc.1 未安装: ' + REAL_BIN);
    process.exit(1);
  }
  let realVer = '';
  try { realVer = require(path.join(NPM_PREFIX, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')).version; } catch (_) {}
  record('前置：临时前缀 dsh 版本 = 0.1.2-rc.1', realVer === '0.1.2-rc.1', 'version=' + realVer + ' bin=' + REAL_BIN);

  // 方式 B 装配插件：隔离 DSH_HOME/profiles/web/cordis.patch.yml 插入本地插件。
  // rc.1 loader 两点要求（实测）：① Windows 绝对路径必须为 file:// URL；
  // ② name 必须指向具体入口文件（index.js），目录导入报 ERR_UNSUPPORTED_DIR_IMPORT。
  const patchDir = path.join(DSH_HOME, 'profiles', 'web');
  fs.mkdirSync(patchDir, { recursive: true });
  const pluginRef = pathToFileURL(path.join(PLUGIN_DIR, 'index.js')).href;
  fs.writeFileSync(path.join(patchDir, 'cordis.patch.yml'),
    `- id: web-runtime\n  config:\n    openBrowser: false\n    printUrl: true\n- insert:\n    - id: dsh-lifecycle\n      name: '${pluginRef}'\n`, 'utf8');
  record('前置：插件 cordis.patch.yml 已写入隔离 profile', fs.existsSync(path.join(patchDir, 'cordis.patch.yml')),
    path.join(patchDir, 'cordis.patch.yml'));

  // 1) start → running（真实 rc.1 GET / 401，httpProbe 401 视为就绪）
  const s1 = runHost({ id: 'r1', action: 'start', payload: { port: PORT } }, 'r1');
  record('start（真实 rc.1）→ running', !!(s1 && s1.ok === true && s1.result && s1.result.state === 'running'),
    JSON.stringify(s1 && s1.result && { state: s1.result.state, pid: s1.result.pid, port: s1.result.port }));
  if (!(s1 && s1.ok === true && s1.result && s1.result.state === 'running')) {
    // 失败时保留现场：打印 dsh 日志尾部，跳过 cleanup 供人工排查
    const logPath = path.join(BASE, 'logs', 'dsh-web.log');
    try {
      const raw = fs.readFileSync(logPath, 'utf8');
      console.log('----- dsh-web.log tail（保留现场）-----');
      console.log(raw.split('\n').slice(-40).join('\n'));
    } catch (e) { console.log('（日志不可读: ' + e.message + '）'); }
    console.log('FAIL | rc1-e2e | 现场保留于 ' + BASE);
    process.exit(1);
  }

  const readyFile = path.join(BASE, 'ready', 'dsh-web.json');
  let ready;
  try { ready = JSON.parse(fs.readFileSync(readyFile, 'utf8')); } catch (_) {}
  const run = readRunFile();
  record('M13 二期：真实插件已发布匹配本次启动的 ready 文件',
    !!(ready && ready.state === 'ready' && ready.launchId === run.launchId
      && ready.pid === run.pid && ready.port === PORT),
    ready && JSON.stringify({ state: ready.state, pid: ready.pid, port: ready.port }));

  // 2) 直接探测：GET / 应 401（认证闸门）、/manifest.webmanifest 应 200 含指纹
  const root = await httpGet(PORT, '/');
  record('真实 rc.1 GET / → 401（认证闸门无回环豁免）', root.status === 401, 'status=' + root.status);
  const manifest = await httpGet(PORT, '/manifest.webmanifest');
  record('真实 rc.1 GET /manifest.webmanifest → 200 含指纹（公开静态资产）',
    manifest.status === 200 && /deepseek\s*harness/i.test(manifest.body),
    'status=' + manifest.status + ' body=' + manifest.body.slice(0, 120).replace(/\n/g, ''));

  // 3) status → launchUrl 含 token、url 裸 URL、version=rc.1
  const s2 = runHost({ id: 'r2', action: 'status', payload: {} }, 'r2');
  const res2 = s2 && s2.result;
  record('status → running + version=0.1.2-rc.1',
    !!(res2 && res2.state === 'running' && /^0\.1\.2-rc\.1/.test(res2.version || '')),
    JSON.stringify(res2 && { state: res2.state, version: res2.version }));
  record('status.launchUrl 捕获（含 ?token=）',
    !!(res2 && typeof res2.launchUrl === 'string' && res2.launchUrl.startsWith('http://127.0.0.1:' + PORT + '/?token=')),
    res2 && (res2.launchUrl ? '[captured, redacted]' : '[missing]'));
  record('status.url 仍为裸 URL（不含 token）',
    !!(res2 && res2.url === 'http://127.0.0.1:' + PORT && res2.url.indexOf('token') === -1),
    res2 && String(res2.url));

  // 4) 插件端点：/_manager/sessions 在真实 rc.1 上 200 {ok:true}（B5 snapshotEvents 修复生效）
  const sessions = await httpGet(PORT, '/_manager/sessions');
  let sessOk = false;
  try { sessOk = sessions.status === 200 && JSON.parse(sessions.body).ok === true; } catch (_) {}
  record('插件 /_manager/sessions（真实 rc.1）→ 200 ok:true（B5 适配生效）', sessOk,
    'status=' + sessions.status + ' body=' + sessions.body.slice(0, 120));

  // 5) stop → stopped
  const s3 = runHost({ id: 'r3', action: 'stop', payload: {} }, 'r3');
  record('stop → stopped', !!(s3 && s3.ok === true && s3.result && s3.result.state === 'stopped'),
    JSON.stringify(s3 && s3.result));
  record('M13 二期：dispose 删除真实插件就绪文件', !fs.existsSync(readyFile));

  const dynamic = runHost({ id: 'r4', action: 'start', payload: { port: 0 } }, 'r4');
  let dynamicReady;
  try { dynamicReady = JSON.parse(fs.readFileSync(readyFile, 'utf8')); } catch (_) {}
  record('M13 二期：真实动态端口启动及新 launchId',
    !!(dynamic?.ok && dynamic.result.state === 'running' && dynamicReady?.state === 'ready'
      && dynamicReady.port === dynamic.result.port && dynamicReady.pid === dynamic.result.pid
      && dynamicReady.launchId !== ready?.launchId));
  const dynamicStop = runHost({ id: 'r5', action: 'stop' }, 'r5');
  record('M13 二期：动态端口实例停止并清理文件',
    !!(dynamicStop?.ok && dynamicStop.result.state === 'stopped' && !fs.existsSync(readyFile)));

  if (!failures) cleanup();
  else console.log('失败现场保留于 ' + BASE);
  console.log('=== 汇总：FAIL ' + failures + ' ===');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.log('FAIL | rc1-e2e | 异常: ' + (e && e.message || e)); process.exit(1); });
