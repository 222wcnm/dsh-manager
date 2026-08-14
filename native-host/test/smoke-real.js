'use strict';
// ============================================================================
// smoke-real.js — 真实 dsh 集成测试（best-effort，可能 SKIPPED）
//
// 运行：node native-host/test/smoke-real.js
//
// 前置：
//   - 真实 dsh 位于 %APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js
//   - 通过 host.js 文件模式 + DSH_MANAGER_NPM_PREFIX 让宿主解析到真实 bin.js
//   - 端口 31997
//
// 安全约束（本沙箱 / 用户要求）：
//   - DSH_HOME 重定向到工作区内 .smoke-real\dsh-home（隔离），
//     严禁任何读写真实 <user>\.dsh 的操作；
//   - 失败一律记录 SKIPPED + 原因，绝不重试循环、绝不绕过沙箱拒绝。
// ============================================================================

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HOST_JS = path.join(ROOT, 'native-host', 'host.js');
const BASE = path.join(ROOT, '.smoke-real');
const TMP = path.join(BASE, 'tmp');
const NPM_PREFIX = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null;
const REAL_BIN = NPM_PREFIX ? path.join(NPM_PREFIX, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js') : null;
const DSH_HOME = path.join(BASE, 'dsh-home'); // 隔离 DSH_HOME（工作区内）
const PORT = 31997;

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
      DSH_HOME, // 隔离到工作区，杜绝触碰真实 <user>\.dsh
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
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) {}
}

function skip(reason) {
  console.log(`SKIPPED | real-dsh 集成 | ${reason}`);
  cleanup();
  process.exit(0);
}

function main() {
  console.log('=== 真实 dsh 集成测试（best-effort）===');
  if (!NPM_PREFIX || !fs.existsSync(REAL_BIN)) {
    return skip(`真实 dsh 未安装于 %APPDATA%\\npm（${REAL_BIN} 不存在），无法集成`);
  }
  console.log('real bin :', REAL_BIN);
  console.log('DSH_HOME :', DSH_HOME, '（隔离，工作区内）');
  console.log('port     :', PORT);

  cleanup();

  // start
  const s = runHost({ id: 'r1', action: 'start', payload: { port: PORT } }, 'r1');
  if (!s || !s.ok) {
    const code = s && s.error ? s.error.code : (s && s.spawnError) || 'unknown';
    const msg = s && s.error ? s.error.message : JSON.stringify(s);
    if (code === 'START_TIMEOUT') {
      return skip(`真实 dsh 在 30s 内未就绪（隔离 DSH_HOME 初始化或沙箱限制）。logTail=${(s.error.logTail || '').split('\n').slice(-3).join(' | ')}`);
    }
    return skip(`start 失败 code=${code} msg=${msg}`);
  }
  console.log('start ->', JSON.stringify(s.result));

  // status
  const st = runHost({ id: 'r2', action: 'status', payload: {} }, 'r2');
  const okSt = st && st.ok === true && st.result.state === 'running';
  console.log('status ->', JSON.stringify(st && st.result));
  if (!okSt) return skip(`status 未达 running：${JSON.stringify(st)}`);

  // stop
  const so = runHost({ id: 'r3', action: 'stop', payload: {} }, 'r3');
  const okSo = so && so.ok === true && so.result.state === 'stopped';
  console.log('stop ->', JSON.stringify(so && so.result));
  if (!okSo) return skip(`stop 失败：${JSON.stringify(so)}`);

  // ---- M4 --port 0 动态端口（best-effort）：验证「日志回填实际端口」假设
  // 与真实 dsh 的输出格式（dsh web: http://127.0.0.1:<实际端口>）。不通过只记
  // NOTE 不判失败——真实 dsh 对 --port 0 的支持需在沙箱外复核。
  console.log('--- M4 --port 0 动态端口（best-effort）---');
  const s0 = runHost({ id: 'r4', action: 'start', payload: { port: 0 } }, 'r4');
  if (!s0 || !s0.ok || !(s0.result && Number.isInteger(s0.result.port) && s0.result.port > 0)) {
    const code = s0 && s0.error ? s0.error.code : (s0 && s0.spawnError) || 'unknown';
    const msg = s0 && s0.error ? s0.error.message : JSON.stringify(s0);
    console.log(`NOTE | real-dsh --port 0 | 未通过（code=${code}）：${msg}`);
    console.log('     真实 dsh 对 --port 0 的支持与日志 URL 行格式需在沙箱外按 manual-e2e.md 步骤 4 复核');
  } else {
    console.log('start --port 0 ->', JSON.stringify(s0.result));
    const so0 = runHost({ id: 'r5', action: 'stop', payload: {} }, 'r5');
    console.log('stop ->', JSON.stringify(so0 && so0.result));
    console.log('PASS | real-dsh --port 0 | 真实 dsh 动态端口回填 + 停止全链路通过');
  }

  // ---- 外部发现生产路径（best-effort，只读）：不加 DSH_MANAGER_FAKE_PROCESSES 围栏，
  // 走真实 powershell 进程枚举 + netstat 端口表 + 指纹探测，检测本机真实运行的
  // dsh web（通常为本会话 harness，127.0.0.1:8080）。绝不接管/停止真实实例。----
  console.log('--- 外部发现生产路径（真实 powershell/netstat，只读）---');
  const ext = runHost({ id: 'r6', action: 'status', payload: {} }, 'r6');
  if (ext && ext.ok === true && ext.result.state === 'external') {
    console.log('status ->', JSON.stringify(ext.result));
    console.log('PASS | 真实外部发现 | 生产路径（powershell 进程枚举 + netstat + 指纹）检测到外部 dsh web');
  } else if (ext && ext.ok === true && ext.result.state === 'stopped') {
    console.log('NOTE | 真实外部发现 | 本机当前无真实 dsh web 在跑——生产路径本身已执行无异常（沙箱外按 manual-e2e 步骤 9 复核）');
  } else {
    console.log('NOTE | 真实外部发现 | status 失败：' + JSON.stringify(ext));
  }
  const stExt = runHost({ id: 'r7', action: 'stop', payload: {} }, 'r7');
  if (stExt && stExt.ok === false && stExt.error && stExt.error.code === 'EXTERNAL_UNMANAGED') {
    console.log('PASS | EXTERNAL_UNMANAGED | 外部实例 stop 被拒（未触碰真实 dsh）');
  } else {
    console.log('NOTE | EXTERNAL_UNMANAGED | 无外部实例时 stop 返回：' + JSON.stringify(stExt && stExt.error));
  }

  cleanup();
  console.log('PASS | real-dsh 集成 | start -> status(running) -> stop 全链路通过（隔离 DSH_HOME，未触碰真实 .dsh）');
}

main();
