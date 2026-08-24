'use strict';

// DSH Manager — 日志查看页逻辑（extension/logs.html）
//
// 行为（docs/design.md §8.4）：
//   1. 打开即经 SW 调宿主 logs 动作读取日志尾部（默认 500 行 / 256KB）；
//   2. 「加载更早」按 beforeByte 分页向前翻（宿主保证行边界对齐、块间严格衔接）；
//   3. 「自动刷新」每 2 秒取一次尾部，仅在新内容时合并视图（页面隐藏时暂停）；
//   4. 「复制全部」复制当前已加载的全部日志行（clipboard + execCommand 兜底）；
//   5. 宿主缺失/通信失败显示错误横幅，可一键重试；
//   6. 所有日志内容一律 textContent 渲染，杜绝 HTML 注入。
//
// 视图模型：chunks 从旧到新，每块 { fromByte, toByte, text } 或 { gap: true, text }。
// 相邻块严格衔接（前块 toByte === 后块 fromByte）；缺口（日志轮转/截断）插 gap 标记。

const $ = (id) => document.getElementById(id);

const FOLLOW_INTERVAL_MS = 2000; // 自动刷新周期
const DEFAULT_TAIL_LINES = 500;

const ERROR_TEXTS = {
  HOST_NOT_INSTALLED: '未安装宿主，请运行 native-host 目录下的 install.ps1 后重启浏览器',
  NATIVE_ERROR: '与宿主通信失败，请确认已安装宿主并重启浏览器',
  BAD_REQUEST: '日志请求参数错误（开发期诊断）',
  INTERNAL: '宿主内部错误',
};

let chunks = []; // 从旧到新：{ fromByte, toByte, text } | { gap, text }
let meta = null; // 最近一次 logs 响应元信息（path/sizeBytes 等）
let busy = false; // 请求在途：按钮禁用防重入
let followTimer = null;
let toastTimer = null;
let reqSeq = 0;
let lastPinnedBottom = true; // 用户是否停留在底部（自动刷新后保持贴底）

// 状态圆点：优先级 error > busy > running/stopped（dshRunning 由 status 探测更新）
let dshRunning = false;
let hasError = false;

// ---------------------------------------------------------------------------
// 与 SW 通信
// ---------------------------------------------------------------------------

async function nativeRequest(action, payload) {
  const id = 'lg' + (++reqSeq) + '-' + Date.now().toString(36);
  const resp = await chrome.runtime.sendMessage({
    type: 'native',
    id,
    action,
    payload: payload || {},
  });
  return resp || { ok: false, error: { code: 'NATIVE_ERROR', message: '宿主无响应' } };
}

// ---------------------------------------------------------------------------
// 视图合并与渲染
// ---------------------------------------------------------------------------

// 新尾部块合并进视图：块间保持「前块 toByte === 后块 fromByte」的严格衔接。
// 新尾部块覆盖全部已加载内容（fromByte <= 首块 fromByte）时整视图重置为尾部块；
// 否则裁掉与新尾部重叠的后缀块，再追加新尾部块；与最后一块之间有缺口时插 gap 标记。
function mergeTail(r) {
  const tail = { fromByte: r.fromByte, toByte: r.toByte, text: r.tail };
  const real = chunks.filter((c) => !c.gap);
  if (real.length === 0) return [tail];
  if (r.fromByte <= real[0].fromByte) return [tail];
  let cut = real.length;
  while (cut > 0 && real[cut - 1].toByte > r.fromByte) cut -= 1;
  const kept = real.slice(0, cut);
  if (kept.length === 0) return [tail];
  if (kept[kept.length - 1].toByte < r.fromByte) {
    // 缺口：日志被轮转/截断后出现不连续区间
    kept.push({ gap: true, text: '… 中间日志不连续（文件被轮转/截断） …' });
  }
  return kept.concat([tail]);
}

function isPinnedBottom() {
  const pre = $('log-pre');
  return pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
}

function render() {
  const pre = $('log-pre');
  const wasPinned = lastPinnedBottom || isPinnedBottom();
  // 全部经 textContent 输出（安全）；gap 标记用独立 span 着色
  pre.textContent = '';
  for (const c of chunks) {
    if (c.gap) {
      const span = document.createElement('span');
      span.className = 'gap-marker';
      span.textContent = '\n' + c.text + '\n';
      pre.appendChild(span);
    } else {
      pre.appendChild(document.createTextNode(c.text));
    }
  }
  if (wasPinned) {
    pre.scrollTop = pre.scrollHeight;
  }
  renderFooter();
}

function renderFooter() {
  const f = $('footer');
  if (!meta) {
    f.textContent = '—';
    return;
  }
  const real = chunks.filter((c) => !c.gap);
  let lines = 0;
  for (const c of chunks) {
    if (!c.gap) lines += c.text === '' ? 0 : c.text.split('\n').length - (c.text.endsWith('\n') ? 1 : 0);
  }
  const sizeText = meta.sizeBytes >= 1024 * 1024
    ? (meta.sizeBytes / 1024 / 1024).toFixed(2) + ' MB'
    : (meta.sizeBytes / 1024).toFixed(1) + ' KB';
  const hasEarlier = real.length > 0 && real[0].fromByte > 0;
  f.textContent = '日志文件：' + meta.path
    + '  ·  大小 ' + sizeText
    + '  ·  已加载 ' + lines + ' 行'
    + (hasEarlier ? '  ·  还有更早日志' : '  ·  已到日志开头');
  f.title = meta.path;
}

function renderEmpty() {
  const pre = $('log-pre');
  pre.textContent = '（日志文件为空——dsh web 尚未启动或尚无输出）';
}

// 状态点只表达 dsh 运行状态（error/running/stopped）——页面日志请求在途（busy）不映射到
// 状态点：原实现每 2s 自动刷新的请求窗口把绿点切为 dot-busy（Matrix 闪现，观感「点阵一闪
// 即无」）；popup 状态卡/面板 chip 的 busy 是真实 dsh 状态转换，语义不同（design §8.8 注）。
function setDot(state) {
  const dot = $('dot');
  dot.className = 'dot ' + (state === 'running' ? 'dot-running' : state === 'error' ? 'dot-error' : 'dot-stopped');
}

// 按优先级渲染状态圆点：error > running/stopped（dsh 运行态，probeRunningState 更新）
function renderDot() {
  setDot(hasError ? 'error' : dshRunning ? 'running' : 'stopped');
}

// 探测一次 dsh web 状态（仅更新圆点展示，失败静默保留原状态）
async function probeRunningState() {
  try {
    const resp = await nativeRequest('status', {});
    if (resp && resp.ok && resp.result) {
      dshRunning = resp.result.state === 'running';
    }
  } catch (_) {
    // 状态探测失败不阻塞日志加载（logs 请求会再次暴露宿主问题）
  }
  renderDot();
}

// ---------------------------------------------------------------------------
// 数据请求
// ---------------------------------------------------------------------------

// 拉取尾部块并合并视图；changed 返回是否有新内容（用于 toast）
async function refresh(showToastOnChange) {
  if (busy) return { changed: false };
  busy = true;
  setBusy(true);
  try {
    // 手动刷新时顺带探测一次运行状态（自动刷新不额外增加 native 调用）
    if (showToastOnChange) await probeRunningState();
    const resp = await nativeRequest('logs', { tailLines: DEFAULT_TAIL_LINES });
    if (!resp.ok) {
      showError(resp.error || { code: 'NATIVE_ERROR', message: '未知错误' });
      return { changed: false };
    }
    clearError();
    const r = resp.result || {};
    const prevLast = chunks.filter((c) => !c.gap).pop();
    const changed = !r.exists
      ? chunks.length > 0
      : !prevLast || prevLast.toByte !== r.toByte || prevLast.text !== r.tail;

    if (!r.exists) {
      chunks = [];
      meta = r;
      renderEmpty();
      renderFooter();
      renderDot();
      return { changed };
    }
    chunks = mergeTail(r);
    meta = r;
    render();
    if (showToastOnChange && changed && !$('follow').checked) {
      showToast('日志已更新', 'info');
    }
    return { changed };
  } catch (_) {
    showError({ code: 'NATIVE_ERROR', message: '无法连接扩展后台' });
    return { changed: false };
  } finally {
    busy = false;
    setBusy(false);
  }
}

async function loadEarlier() {
  if (busy) return;
  const real = chunks.filter((c) => !c.gap);
  if (real.length === 0) {
    await refresh(false);
    return;
  }
  if (real[0].fromByte <= 0) {
    showToast('已到日志开头', 'info');
    return;
  }
  // 阅读历史与自动跟随互斥：加载更早时暂停自动刷新，避免新内容到来重置视图
  if ($('follow').checked) {
    $('follow').checked = false;
    syncFollow();
    showToast('已暂停自动刷新（阅读历史日志）', 'info');
  }
  busy = true;
  setBusy(true);
  try {
    const resp = await nativeRequest('logs', { beforeByte: real[0].fromByte, tailLines: DEFAULT_TAIL_LINES });
    if (!resp.ok) {
      showError(resp.error || { code: 'NATIVE_ERROR', message: '未知错误' });
      return;
    }
    clearError();
    const r = resp.result || {};
    if (r.exists && r.tail) {
      const block = { fromByte: r.fromByte, toByte: r.toByte, text: r.tail };
      // 防御：非预期的不衔接时直接重置视图（宿主保证衔接，此分支不应对用户可见）
      if (r.toByte === real[0].fromByte) {
        chunks = [block].concat(chunks);
      } else {
        chunks = [block];
      }
      if (block.fromByte === 0) showToast('已到日志开头', 'info');
    }
    meta = r;
    render();
  } catch (_) {
    showError({ code: 'NATIVE_ERROR', message: '无法连接扩展后台' });
  } finally {
    busy = false;
    setBusy(false);
  }
}

// ---------------------------------------------------------------------------
// 复制 / 错误 / toast
// ---------------------------------------------------------------------------

async function copyAll() {
  let text = '';
  for (const c of chunks) {
    if (c.gap) text += '\n' + c.text + '\n';
    else text += c.text;
  }
  if (!text) {
    showToast('没有可复制的日志', 'info');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制 ' + countLoadedLines() + ' 行日志', 'success');
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    document.body.removeChild(ta);
    if (ok) showToast('已复制 ' + countLoadedLines() + ' 行日志', 'success');
    else showToast('复制失败，请手动选择复制', 'error');
  }
}

function countLoadedLines() {
  let n = 0;
  for (const c of chunks) {
    if (!c.gap && c.text) n += c.text.split('\n').length - (c.text.endsWith('\n') ? 1 : 0);
  }
  return n;
}

function showError(err) {
  hasError = true;
  const code = err.code || 'NATIVE_ERROR';
  const friendly = ERROR_TEXTS[code] || err.message || code;
  let text = friendly;
  if (err.message && err.message !== friendly) text += '\n' + err.message;
  $('error-text').textContent = text;
  $('error-panel').classList.remove('hidden');
  $('btn-retry').classList.remove('hidden');
  renderDot();
}

function clearError() {
  hasError = false;
  $('error-panel').classList.add('hidden');
  $('btn-retry').classList.add('hidden');
  renderDot();
}

function showToast(msg, kind) {
  const t = $('toast');
  if (!t) return;
  $('toast-text').textContent = msg;
  t.classList.remove('toast-hidden', 'toast-success', 'toast-error', 'toast-info');
  t.classList.add('toast-' + (kind || 'info'));
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('toast-hidden'), 3000);
}

function setBusy(v) {
  $('btn-refresh').disabled = v;
  $('btn-load-earlier').disabled = v;
  renderDot();
}

// ---------------------------------------------------------------------------
// 自动刷新（follow）
// ---------------------------------------------------------------------------

function startFollow() {
  if (followTimer) clearInterval(followTimer);
  followTimer = setInterval(() => {
    if (!document.hidden) refresh(false);
  }, FOLLOW_INTERVAL_MS);
}

function stopFollow() {
  if (followTimer) {
    clearInterval(followTimer);
    followTimer = null;
  }
}

function syncFollow() {
  if ($('follow').checked) startFollow();
  else stopFollow();
}

// ---------------------------------------------------------------------------
// 事件与启动
// ---------------------------------------------------------------------------

function bindEvents() {
  $('btn-refresh').addEventListener('click', () => refresh(true));
  $('btn-load-earlier').addEventListener('click', loadEarlier);
  $('btn-copy').addEventListener('click', copyAll);
  $('btn-retry').addEventListener('click', () => refresh(false));
  $('follow').addEventListener('change', syncFollow);
  $('log-pre').addEventListener('scroll', () => {
    lastPinnedBottom = isPinnedBottom();
  });
  document.addEventListener('visibilitychange', () => {
    // 页面隐藏时暂停轮询，重新可见立即刷一次
    if (document.hidden) stopFollow();
    else {
      syncFollow();
      refresh(false);
    }
  });
  window.addEventListener('beforeunload', stopFollow);
}

async function init() {
  DSHTheme.init(); // M6：尽早应用主题（避免浅色闪烁），并订阅 storage/webuiTheme + matchMedia
  bindEvents();
  // 先探测一次运行状态决定圆点颜色（失败不阻塞日志加载）
  await probeRunningState();
  await refresh(false);
  syncFollow();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
