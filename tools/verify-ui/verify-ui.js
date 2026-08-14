'use strict';
// ============================================================================
// verify-ui.js — chrome-devtools-mcp 驱动的 dsh-manager 扩展 UI 自动验收
//
// 原理：以零依赖方式实现 MCP stdio 客户端（换行分隔 JSON-RPC），拉起 Google 官方
// chrome-devtools-mcp（npx 按需下载、版本钉死），驱动一个独立 profile 的 Chrome：
//   1. install_extension 加载本仓库 extension/ 目录（unpacked）
//   2. trigger_extension_action 弹出 popup → take_snapshot/take_screenshot
//   3. navigate_page 打开 logs.html → take_screenshot
// 截图与快照写入 shots/（已 gitignore），控制台输出每步 PASS/FAIL 与关键信息。
//
// 用法：
//   node tools/verify-ui/verify-ui.js            # 完整流程（加载扩展 + popup + 日志页）
//   node tools/verify-ui/verify-ui.js --list     # 仅连接并列出可用工具（快速诊断）
//
// 前置（重要）：
//   - Chrome 进程 IPC（mojo）与子进程 stdio 管道在受限沙箱内可能被拦
//     （与 tools/icons/_gen-icons.js 相同的限制）；首次运行建议在沙箱外/提权终端执行。
//   - 需联网下载 chrome-devtools-mcp（仅首次，npx 缓存）。
//
// 设计取舍（tools/verify-ui/README.md）：
//   - 不依赖 @modelcontextprotocol/sdk：本项目工具链保持零依赖，MCP stdio 协议
//     仅需换行分隔 JSON-RPC，约 60 行即可完整实现。
//   - 版本钉死：MCP_VERSION 与 README 同步，保证可复现。
// ============================================================================
const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const EXT_DIR = path.join(ROOT, 'extension');
const SHOTS_DIR = path.join(__dirname, 'shots');
const NPM_CLI = process.platform === 'win32' ? 'npx.cmd' : 'npx'; // Windows 下 npx 是 .cmd shim，spawn 需显式带扩展名
const MCP_VERSION = '1.7.0'; // 与 README.md 同步
const MCP_ARGS = ['-y', `chrome-devtools-mcp@${MCP_VERSION}`,
  '--categoryExtensions', // 必需：启用扩展类工具（install/reload/trigger/evaluate(SW)）
  '--usageStatistics=false', // 关闭使用统计上报
  ...(process.env.CHROME_PATH ? ['--executablePath', process.env.CHROME_PATH] : []),
];
const CALL_TIMEOUT_MS = 120000; // 单次 tools/call 兜底（Chrome 冷启动较慢）

const LIST_ONLY = process.argv.includes('--list');

let seq = 0;
const pending = new Map();
let child = null;

function log(...a) { console.log('[verify-ui]', ...a); }
function step(name) { console.log('\n=== ' + name + ' ==='); }
function fail(msg) {
  console.error('[verify-ui] 失败: ' + msg);
  if (child) { try { child.kill(); } catch (_) { /* 忽略 */ } }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 最小 MCP stdio 客户端（换行分隔 JSON-RPC，零依赖）
// ---------------------------------------------------------------------------
function rpc(method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    let timer = null;
    pending.set(id, { resolve, reject, method });
    if (timeoutMs) {
      timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`RPC ${method} 超时（${timeoutMs}ms）`));
        }
      }, timeoutMs);
    }
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (err) => {
      if (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

async function callTool(name, args) {
  const res = await rpc('tools/call', { name, arguments: args || {} }, CALL_TIMEOUT_MS);
  if (res.isError) {
    throw new Error(`工具 ${name} 返回错误: ` + JSON.stringify(res.content).slice(0, 2000));
  }
  return res;
}

// content 列表 -> 可读文本（text 块拼接；图片块给摘要）
function contentText(content) {
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content.map((b) => {
    if (b && b.type === 'text') return b.text;
    if (b && b.type === 'image') return `[image ${b.mimeType || ''} ${b.data ? b.data.length + ' bytes(base64)' : 'file:' + b.uri || ''}]`;
    return JSON.stringify(b);
  }).join('\n');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  step('启动 chrome-devtools-mcp ' + MCP_VERSION);
  child = spawn(NPM_CLI, MCP_ARGS, {
    cwd: __dirname,
    stdio: ['pipe', 'pipe', 'inherit'], // stderr 透传（服务器诊断日志），stdout 仅协议
    windowsHide: true,
  });
  child.on('error', (err) => fail('npx 启动失败（可能被沙箱拦截管道或 npx 不可用）: ' + err.message));
  child.on('exit', (code) => {
    if (pending.size > 0) {
      for (const [, p] of pending) p.reject(new Error('MCP 进程提前退出（code=' + code + '）'));
      pending.clear();
    }
  });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch (_) { return; }
    if (m && m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method} 错误: ${JSON.stringify(m.error)}`));
      else p.resolve(m.result);
    }
  });

  step('MCP 握手');
  await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'dsh-manager-verify-ui', version: '1.0.0' },
  }, 60000);
  notify('notifications/initialized', {});

  const toolsRes = await rpc('tools/list', {}, 60000);
  const tools = toolsRes.tools || [];
  const names = tools.map((t) => t.name).sort();
  log('服务器暴露工具数: ' + names.length);
  for (const want of ['install_extension', 'reload_extension', 'trigger_extension_action',
    'take_snapshot', 'take_screenshot', 'navigate_page', 'list_pages', 'list_console_messages',
    'evaluate_script', 'list_extensions']) {
    log(`  工具 ${want}: ${names.includes(want) ? '有' : '缺失'}`);
  }
  if (LIST_ONLY) {
    child.kill();
    return;
  }
  const schemaOf = (n) => (tools.find((t) => t.name === n) || {}).inputSchema || null;
  for (const want of ['install_extension', 'trigger_extension_action']) {
    const s = schemaOf(want);
    log(`  ${want} schema: ${JSON.stringify(s)}`);
  }

  step('安装 unpacked 扩展: ' + EXT_DIR);
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const inst = await callTool('install_extension', { path: EXT_DIR });
  const instText = contentText(inst.content);
  log(instText);
  const extIdMatch = /[a-p]{32}/.exec(instText);
  const extId = extIdMatch ? extIdMatch[0] : null;
  if (!extId) fail('未能从 install_extension 输出解析出扩展 ID');

  step('弹出 popup（trigger_extension_action）');
  const trig = await callTool('trigger_extension_action', { id: extId });
  log(contentText(trig.content));
  await sleep(1500); // 等 popup 渲染与首轮 status 轮询

  step('popup 快照（a11y 树）');
  const snap = await callTool('take_snapshot', {});
  const snapText = contentText(snap.content);
  fs.writeFileSync(path.join(SHOTS_DIR, 'popup-snapshot.txt'), snapText, 'utf8');
  log('快照已存 shots/popup-snapshot.txt（' + snapText.length + ' 字符）');
  console.log(snapText.slice(0, 3000));

  step('popup 截图');
  const shot = await callTool('take_screenshot', { format: 'png', filePath: path.join(SHOTS_DIR, 'popup.png') });
  log(contentText(shot.content));
  expectFile(path.join(SHOTS_DIR, 'popup.png'));

  step('打开日志查看页 logs.html 并截图');
  const logsUrl = `chrome-extension://${extId}/logs.html`;
  const nav = await callTool('navigate_page', { url: logsUrl });
  log(contentText(nav.content));
  await sleep(2000); // 等日志加载（status + logs 两个 native 调用）
  const shot2 = await callTool('take_screenshot', { format: 'png', filePath: path.join(SHOTS_DIR, 'logs.png') });
  log(contentText(shot2.content));
  expectFile(path.join(SHOTS_DIR, 'logs.png'));

  step('页面列表（含扩展页/SW 定位信息）');
  const pages = await callTool('list_pages', {});
  console.log(contentText(pages.content).slice(0, 3000));

  step('结束');
  child.kill();
  log('全部步骤完成；截图与快照见 tools/verify-ui/shots/');
  log('下一步：用 read_image 查看截图做视觉核对；' +
    '把 manual-e2e.md 步骤 13 的其余交互（按钮点击/复制）固化进本脚本。');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function expectFile(f) {
  if (fs.existsSync(f) && fs.statSync(f).size > 0) {
    log('PASS 截图存在: ' + f + ' (' + fs.statSync(f).size + ' bytes)');
  } else {
    fail('截图未生成: ' + f);
  }
}

main().catch((e) => fail(e && e.message ? e.message : String(e)));
