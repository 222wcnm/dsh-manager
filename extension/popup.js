'use strict';

// DSH Manager — popup 逻辑
//
// 行为（docs/design.md §8.2）：
//   1. 打开即调 status，随后每 2s 轮询（popup 关闭自动停止）；
//   2. 所有 native 请求经 SW 中转（chrome.runtime.sendMessage，MV3 返回 Promise）；
//   3. starting 就绪后按 settings.autoOpen 自动打开 Web UI；
//   4. 错误态展示错误码中文文案 + [复制日志]；
//   5. 内嵌设置面板，保存到 chrome.storage.local（key 'settings'）；
//   6. external 状态（§6.6/§6.7）：蓝点 + 接管按钮，可接管后由扩展管理；
//   7. 点击反馈：操作立即乐观更新（按钮禁用+转圈+进度条+阶段文案+耗时），
//      完成后 toast 确认（启动完成/已停止/重启完成/接管成功/失败原因）；
//      操作在途（native ack 前）暂停轮询，避免 SW 串行队列堆积。

const $ = (id) => document.getElementById(id);

// 错误码中文文案（与 docs/design.md §6.2 表一致）
const ERROR_TEXTS = {
  DSH_NOT_FOUND: '未检测到 dsh，请先执行 npm i -g @deepseek-ai/dsh',
  PORT_BUSY: '端口已被其他程序占用，请在设置中更换端口',
  ALREADY_RUNNING: 'dsh web 已在运行（幂等成功）',
  ALREADY_STOPPED: 'dsh web 已停止（幂等成功）',
  START_TIMEOUT: '启动超时：30 秒内端口未就绪，请查看日志',
  STOP_FAILED: '停止失败：无法终止 dsh 进程，请检查权限或手动处理',
  EXTERNAL_UNMANAGED: '未找到可接管的外部实例（可能已退出或变化）；请重新打开面板刷新，或在其原终端停止',
  BUSY: '操作进行中，请稍候再试',
  BAD_REQUEST: '请求参数错误（开发期诊断）',
  INTERNAL: '宿主内部错误，请查看日志',
  HOST_NOT_INSTALLED: '未安装宿主，请运行 native-host 目录下的 install.ps1 后重启浏览器',
  NATIVE_ERROR: '与宿主通信失败，请确认已安装宿主并重启浏览器',
};

const DEFAULT_SETTINGS = { port: 3080, profile: 'web', autoOpen: true, badgeInterval: 30 };

// 操作进行中的按钮文案与阶段说明（点击反馈）
const ACTION_LABELS = {
  start: { idle: '启动', busy: '启动中…', progress: { starting: '正在启动：等待端口就绪' } },
  stop: { idle: '停止', busy: '停止中…', progress: { stopping: '正在停止：等待端口关闭' } },
  restart: {
    idle: '重启', busy: '重启中…',
    progress: { stopping: '正在重启：停止旧进程', starting: '正在重启：新进程启动中，等待端口就绪' },
  },
  adopt: { idle: '接管', busy: '接管中…', progress: { starting: '正在接管外部实例' } },
};

let settings = null;
let state = 'unknown'; // stopped | starting | running | stopping | error | external | unknown
let detail = null; // 最近一次 status 的 result
let lastError = null; // { code, message, logTail? }
// pending —— 用户发起、尚未收敛到终态的操作（乐观反馈：按钮转圈 + 进度条 + 阶段文案）
// { action, phase: 'stopping' | 'starting', atMs, ack }；ack=true 表示 native 请求在途
let pending = null;
let startedAtMs = null; // running 起点（用于 mm:ss 时长）
let reqSeq = 0;
let pollTimer = null;
let tickTimer = null;
let toastTimer = null;
let refreshing = false; // 手动刷新在途：btn-refresh 转圈 + 禁用，防止重入
let lastDriftKey = null; // 上次状态漂移提示的键（相同漂移去重）

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

async function init() {
  bindEvents();
  await loadSettings();
  renderSettingsForm();
  await refreshStatus();
  pollTimer = setInterval(refreshStatus, 2000);
  tickTimer = setInterval(() => {
    renderUptime();
    renderProgress(); // 每秒刷新操作耗时
  }, 1000);
}

function bindEvents() {
  $('btn-settings').addEventListener('click', () => toggleSettings());
  $('btn-refresh').addEventListener('click', manualRefresh);
  $('btn-save').addEventListener('click', saveSettings);
  $('btn-cancel').addEventListener('click', () => toggleSettings(false));
  $('btn-start').addEventListener('click', () => doAction('start'));
  $('btn-stop').addEventListener('click', () => doAction('stop'));
  $('btn-restart').addEventListener('click', () => doAction('restart'));
  $('btn-adopt').addEventListener('click', () => doAction('adopt'));
  $('btn-open').addEventListener('click', openWebUI);
  $('btn-copy-log').addEventListener('click', copyLog);
  $('btn-logs').addEventListener('click', openLogs);
  // 输入时清除无效反馈
  $('set-port').addEventListener('input', () => clearFieldInvalid('set-port'));
  $('set-badge').addEventListener('input', () => clearFieldInvalid('set-badge'));
  window.addEventListener('unload', () => {
    if (pollTimer) clearInterval(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
  });
}

// ---------------------------------------------------------------------------
// 与 SW 通信
// ---------------------------------------------------------------------------

async function nativeRequest(action, payload) {
  const id = 'p' + (++reqSeq) + '-' + Date.now().toString(36);
  const resp = await chrome.runtime.sendMessage({
    type: 'native',
    id,
    action,
    payload: payload || {},
  });
  return resp || { ok: false, error: { code: 'NATIVE_ERROR', message: '宿主无响应' } };
}

// ---------------------------------------------------------------------------
// 状态轮询
// ---------------------------------------------------------------------------

async function refreshStatus() {
  // 操作请求在途时跳过轮询：SW 串行队列会让 status 排在操作之后，白白堆积
  if (pending && pending.ack) return;
  let resp;
  try {
    resp = await nativeRequest('status', {});
  } catch (_) {
    setError({ code: 'NATIVE_ERROR', message: '无法连接扩展后台，请重新打开面板' });
    return;
  }
  if (!resp.ok) {
    setError(resp.error || { code: 'NATIVE_ERROR', message: '未知错误' });
    return;
  }
  clearError();
  applyStatus(resp.result || {});
}

// 手动刷新：直接拉取一次 status 并应用结果（与 refreshStatus 一致）。
// 有 pending（操作在途/乐观反馈中）时静默忽略，避免破坏乐观反馈。
async function manualRefresh() {
  if (refreshing) return; // 防重入
  if (pending) return; // 操作在途：保持按钮禁用、乐观反馈不被破坏
  refreshing = true;
  const btn = $('btn-refresh');
  btn.classList.add('is-pending');
  btn.disabled = true;
  try {
    let resp;
    try {
      resp = await nativeRequest('status', {});
    } catch (_) {
      setError({ code: 'NATIVE_ERROR', message: '无法连接扩展后台，请重新打开面板' });
      return;
    }
    if (!resp.ok) {
      setError(resp.error || { code: 'NATIVE_ERROR', message: '未知错误' });
      return;
    }
    clearError();
    applyStatus(resp.result || {});
  } finally {
    refreshing = false;
    btn.classList.remove('is-pending');
    btn.disabled = false;
  }
}

function applyStatus(result) {
  const prev = state;
  state = result.state || 'unknown';
  detail = result;

  // 状态漂移通知（无用户操作时；首次 init 的 prev='unknown' 不触发）
  if (!pending && prev !== 'unknown') {
    notifyDrift(prev, state);
  }

  if (state === 'running') {
    startedAtMs = result.startedAt || Date.now();
    // 我们发起的启动/重启收敛到 running → 完成确认（toast + autoOpen）
    const wasOurStart = !!pending && (pending.action === 'start' || pending.action === 'restart');
    if (wasOurStart) {
      finishPending(pending.action === 'restart'
        ? '重启完成，dsh web 已就绪'
        : '启动完成，dsh web 已就绪', 'success');
    }
    if (wasOurStart && prev !== 'running' && settings && settings.autoOpen) {
      openWebUI();
    }
  } else if (state === 'stopped' || state === 'error' || state === 'external') {
    startedAtMs = null;
    if (pending) {
      if (state === 'stopped' && pending.action === 'stop') {
        finishPending(stopStoppedText(), 'success');
      } else if (state === 'error') {
        finishPending('操作未完成，请查看下方错误信息', 'error');
      } else {
        finishPending(null, null); // 罕见：目标态变化（如 external 漂移），静默结束 pending
      }
    }
  }
  render();
}

// 状态漂移提示（仅无 pending；去重：相同的 prev→state 键不重复弹）
function notifyDrift(prev, next) {
  if (prev === next) return;
  let msg = null;
  if (prev === 'stopped' && next === 'external') {
    msg = '检测到外部 dsh web 实例';
  } else if (prev === 'external' && next === 'stopped') {
    msg = '外部实例已退出';
  } else if (prev === 'running' && next === 'stopped') {
    msg = 'dsh web 已停止（非本扩展操作）';
  } else if (prev === 'error' && next !== 'error') {
    msg = '已恢复';
  }
  if (!msg) return;
  const key = prev + '->' + next;
  if (key === lastDriftKey) return;
  lastDriftKey = key;
  showToast(msg, 'info');
}

// stop 完成 toast 文案：按 stopMethod 区分（graceful/force/缺失）
function stopStoppedText() {
  const m = detail && detail.stopMethod;
  if (m === 'graceful') return '已优雅停止';
  if (m === 'force') return '已强制停止（未检测到插件或优雅停止超时）';
  return '已停止';
}

// 结束 pending 并（可选）弹出完成 toast
function finishPending(msg, kind) {
  pending = null;
  if (msg) showToast(msg, kind);
}

// ---------------------------------------------------------------------------
// 操作（启动 / 停止 / 重启 / 接管）
// ---------------------------------------------------------------------------

async function doAction(action) {
  if (pending) return; // 操作进行中（按钮已禁用，双保险）

  // 乐观反馈：立即进入过渡态 —— 按钮禁用+转圈、圆点脉冲、进度条与阶段文案
  pending = {
    action,
    phase: (action === 'stop' || action === 'restart') ? 'stopping' : 'starting',
    atMs: Date.now(),
    ack: true,
  };
  if (action === 'start') state = 'starting';
  else if (action === 'stop' || action === 'restart') state = 'stopping';
  // adopt：保持 external 状态，仅按钮与进度条反馈
  render();

  // adopt 的 payload 来自最近一次 status 的 external 结果（pid+port，design §6.7）
  const payload = action === 'adopt'
    ? { pid: detail ? detail.pid : null, port: detail ? detail.port : null }
    : {
        profile: settings ? settings.profile : DEFAULT_SETTINGS.profile,
        port: settings ? settings.port : DEFAULT_SETTINGS.port,
      };

  let resp;
  try {
    resp = await nativeRequest(action, payload);
  } catch (_) {
    pending = null;
    setError({ code: 'NATIVE_ERROR', message: '无法连接扩展后台，请重新打开面板' });
    showToast('操作失败：无法连接扩展后台', 'error');
    render();
    return;
  }

  if (!resp.ok) {
    const err = resp.error || {};
    if (err.code === 'ALREADY_RUNNING') {
      // 幂等成功：刷新状态；若配置自动打开则打开 UI
      pending = null;
      showToast('dsh web 已在运行（无需操作）', 'success');
      await refreshStatus();
      if (settings && settings.autoOpen && state === 'running') openWebUI();
      return;
    }
    if (err.code === 'ALREADY_STOPPED') {
      pending = null;
      showToast('dsh web 已停止（无需操作）', 'success');
      await refreshStatus();
      return;
    }
    pending = null;
    setError(err);
    showToast('操作失败：' + (ERROR_TEXTS[err.code] || err.message || err.code), 'error');
    return;
  }

  // 应答成功：立即应用返回状态，后续由 2s 轮询继续收敛到终态
  if (action === 'adopt') {
    pending = null; // adopt 应答即终态
    showToast('接管成功，实例已由扩展管理', 'success');
    applyStatus(resp.result || {});
    refreshStatus();
    return;
  }

  const result = resp.result || {};
  if (action === 'restart' && result.state === 'starting') {
    // 宿主内先 stop 后 start：ack 时旧进程已停、新进程已 spawn
    pending.phase = 'starting';
    showToast('旧进程已停止，新进程启动中…', 'info');
  }
  pending.ack = false;
  applyStatus(result); // 若已 running → finishPending 弹完成 toast
  refreshStatus(); // 立即收敛一次（SW 队列此时空闲）
}

// ---------------------------------------------------------------------------
// 打开 Web UI
// ---------------------------------------------------------------------------

function openWebUI() {
  const port = (detail && detail.port) || (settings ? settings.port : DEFAULT_SETTINGS.port);
  if (!port) return; // M4：动态端口未回填时无 URL 可开
  chrome.tabs.create({ url: 'http://127.0.0.1:' + port + '/' });
}

// 打开日志查看页（扩展页面，M3 日志查看，design §8.4）
function openLogs() {
  chrome.tabs.create({ url: chrome.runtime.getURL('logs.html') });
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function render() {
  const running = state === 'running';
  const external = state === 'external';
  const stopped = state === 'stopped';
  const busy = state === 'starting' || state === 'stopping';
  const isError = state === 'error';
  const locked = !!pending; // 操作在途：所有生命周期按钮锁定，防止并发

  // 状态圆点：灰 stopped / 琥珀脉冲 starting·stopping / 绿 running / 蓝 external / 红 error
  $('dot').className = 'dot ' + (running ? 'dot-running' : external ? 'dot-external' : busy ? 'dot-busy' : isError ? 'dot-error' : 'dot-stopped');

  // 按钮随状态启用/禁用：external 可接管 + 打开 Web UI（design §6.6/§6.7）
  $('btn-start').disabled = locked || !stopped;
  $('btn-stop').disabled = locked || !running;
  $('btn-restart').disabled = locked || !running;
  $('btn-adopt').disabled = locked || !external;
  $('btn-open').disabled = !running && !external;

  // 接管按钮仅 external 状态显示
  $('btn-adopt').classList.toggle('hidden', !external);
  $('btn-open').classList.toggle('wide', external); // 无接管按钮时占满整行

  // 进行中文案 + 转圈：pending 命中的按钮显示 spinner（点击即时反馈）
  setBtnLabel('btn-start', 'start');
  setBtnLabel('btn-stop', 'stop');
  setBtnLabel('btn-restart', 'restart');
  setBtnLabel('btn-adopt', 'adopt');

  // 操作进度行
  renderProgress();

  // URL 行（running / external 时显示）
  if (running || external) {
    const port = (detail && detail.port) || (settings ? settings.port : DEFAULT_SETTINGS.port);
    $('url-text').textContent = 'http://127.0.0.1:' + port;
    $('url-row').classList.remove('hidden');
  } else {
    $('url-row').classList.add('hidden');
  }
  renderUptime();

  // 状态明细行
  let text = '状态：' + state;
  if (running) {
    text = '状态：running' + (detail && detail.pid ? ' · PID ' + detail.pid : '');
    const health = detail && detail.health;
    if (health) {
      text += ' · 健康：' + formatUptime(health.uptimeMs)
        + (health.nodeVersion ? ' · node ' + health.nodeVersion : '');
    }
  } else if (external) {
    text = '状态：external（外部启动，接管后由扩展管理）'
      + (detail && detail.pid ? ' · PID ' + detail.pid : '')
      + (detail && detail.externalCount > 1 ? ' · 共 ' + detail.externalCount + ' 个外部实例' : '');
  } else if (state === 'starting') {
    text = '状态：starting（正在启动…'
      + (detail && detail.requestedPort === 0 ? '，端口自动分配中' : '') + '）';
  } else if (state === 'stopping') {
    text = '状态：stopping（正在停止…）';
  } else if (isError) {
    text = '状态：error';
  }
  $('detail-line').textContent = text;

  // 底部提示：M2 契约 —— lifecycle:true 显示优雅停机已启用
  renderHint();
}

// 底部提示：lifecycle:true → 优雅停机已启用；否则提示安装插件（宿主未升级字段缺失按 false 兜底）
function renderHint() {
  const hint = $('hint');
  if (!hint) return;
  const lifecycle = !!(detail && detail.lifecycle);
  hint.textContent = lifecycle
    ? '优雅停机已启用（dsh-lifecycle）'
    : '安装 dsh-lifecycle 插件可优雅停机';
}

// uptimeMs → 「x m y s」（<60s 只显示「y s」；非法值兜底 0s）
function formatUptime(ms) {
  const sec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return s + ' s';
  return m + ' m ' + s + ' s';
}

// 单个按钮：pending 命中 → busy 文案 + spinner；否则按状态显示文案
function setBtnLabel(id, action) {
  const btn = $(id);
  const label = btn.querySelector('.btn-label');
  const mine = pending && pending.action === action;
  const busyText = ACTION_LABELS[action].busy;
  const idleText = ACTION_LABELS[action].idle;
  if (mine) {
    label.textContent = busyText;
    btn.classList.add('is-pending');
  } else {
    btn.classList.remove('is-pending');
    if (action === 'start') label.textContent = state === 'starting' ? busyText : idleText;
    else if (action === 'stop') label.textContent = state === 'stopping' ? busyText : idleText;
    else if (action === 'restart') label.textContent = state === 'stopping' ? busyText : idleText;
    else label.textContent = idleText; // adopt
  }
}

// 操作进度行：阶段说明 + 已耗时（tickTimer 每秒刷新一次）
function renderProgress() {
  const prog = $('progress');
  if (!prog) return;
  if (!pending) {
    prog.classList.add('hidden');
    return;
  }
  prog.classList.remove('hidden');
  let text = ACTION_LABELS[pending.action].progress[pending.phase] || ACTION_LABELS[pending.action].busy;
  if (pending.action === 'adopt' && detail && detail.pid) {
    text += '（PID ' + detail.pid + '）';
  }
  const sec = Math.floor((Date.now() - pending.atMs) / 1000);
  $('progress-text').textContent = text + ' · 已耗时 ' + sec + 's';
}

function renderUptime() {
  const el = $('uptime-text');
  if (state !== 'running' || !startedAtMs) {
    el.textContent = '';
    return;
  }
  const sec = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  el.textContent = '已运行 ' + mm + ':' + ss;
}

// ---------------------------------------------------------------------------
// 操作结果 toast（点击反馈：完成/失败即时确认，自动消退）
// ---------------------------------------------------------------------------

function showToast(msg, kind) {
  const t = $('toast');
  if (!t) return;
  $('toast-text').textContent = msg;
  t.classList.remove('toast-hidden', 'toast-out', 'toast-success', 'toast-error', 'toast-info');
  t.classList.add('toast-' + (kind || 'info'));
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 4000);
}

function hideToast() {
  const t = $('toast');
  if (!t || t.classList.contains('toast-hidden')) return;
  t.classList.add('toast-out');
  toastTimer = setTimeout(() => t.classList.add('toast-hidden'), 200);
}

// ---------------------------------------------------------------------------
// 错误面板
// ---------------------------------------------------------------------------

function setError(err) {
  lastError = err || {};
  state = 'error'; // 与 Web UI 一致：错误态显示红色圆点，下次 status 轮询自动恢复
  const code = lastError.code || 'NATIVE_ERROR';
  const friendly = ERROR_TEXTS[code] || lastError.message || code;
  let text = friendly;
  if (lastError.message && lastError.message !== friendly) {
    text += '\n' + lastError.message;
  }
  $('error-text').textContent = text;
  $('error-panel').classList.remove('hidden');
  $('btn-copy-log').classList.toggle('hidden', !(lastError.logTail || lastError.message));
  render();
}

function clearError() {
  lastError = null;
  $('error-panel').classList.add('hidden');
  $('btn-copy-log').classList.add('hidden');
}

async function copyLog() {
  if (!lastError) return;
  const text = lastError.logTail || lastError.message || '';
  try {
    await navigator.clipboard.writeText(text);
    showToast('日志已复制', 'success');
  } catch (_) {
    // 兜底：execCommand；两条路径都失败才报错 toast
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    document.body.removeChild(ta);
    if (ok) showToast('日志已复制', 'success');
    else showToast('复制失败，请手动选择复制', 'error');
  }
}

// ---------------------------------------------------------------------------
// 设置面板
// ---------------------------------------------------------------------------

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ settings: DEFAULT_SETTINGS }, (data) => {
      settings = Object.assign({}, DEFAULT_SETTINGS, (data && data.settings) || {});
      resolve();
    });
  });
}

function renderSettingsForm() {
  $('set-port').value = settings.port;
  $('set-profile').value = settings.profile;
  $('set-autoopen').checked = !!settings.autoOpen;
  $('set-badge').value = settings.badgeInterval;
}

function toggleSettings(force) {
  const panel = $('settings-panel');
  const show = (force !== undefined) ? force : panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !show);
  if (show) {
    renderSettingsForm();
    $('settings-error').classList.add('hidden');
  }
}

function saveSettings() {
  const port = parseInt($('set-port').value, 10);
  const badge = parseInt($('set-badge').value, 10);
  const profile = $('set-profile').value.trim();
  const errEl = $('settings-error');

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    errEl.textContent = '端口必须是 0-65535 的整数（0 = 自动分配动态端口）';
    errEl.classList.remove('hidden');
    markFieldInvalid('set-port');
    return;
  }
  if (!Number.isInteger(badge) || badge < 30 || badge > 3600) {
    errEl.textContent = '徽标刷新间隔必须是 30-3600 秒的整数（Chrome 最小周期 30 秒）';
    errEl.classList.remove('hidden');
    markFieldInvalid('set-badge');
    return;
  }

  const next = {
    port,
    profile: profile || 'web',
    autoOpen: $('set-autoopen').checked,
    badgeInterval: badge,
  };

  chrome.storage.local.set({ settings: next }, () => {
    settings = next; // 立即重读生效
    errEl.classList.add('hidden');
    toggleSettings(false);
    showToast('设置已保存', 'success');
    refreshStatus();
  });
}

// 校验失败：红边框 + 抖动一次（0.3s）+ 聚焦到出错输入框
function markFieldInvalid(id) {
  const input = $(id);
  clearFieldInvalid(id, true);
  input.classList.add('field-invalid');
  input.classList.remove('field-shake');
  // 强制重排以重启动画（连续两次同一错误也会抖动）
  void input.offsetWidth;
  input.classList.add('field-shake');
  input.focus();
}

// 输入时清除无效反馈；skipShake 用于抖动重排前不动 shake 类
function clearFieldInvalid(id, skipShake) {
  const input = $(id);
  input.classList.remove('field-invalid');
  if (!skipShake) input.classList.remove('field-shake');
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
