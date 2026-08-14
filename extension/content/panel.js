'use strict';
// ============================================================================
// panel.js — DSH Manager 页面内管理面板（content script，design §8.6）
//
// 在 dsh Web UI 页面（127.0.0.1 / localhost 任意端口）右下角注入一个状态徽章 +
// 可展开的管理面板：停止 / 重启 dsh web，全部动作经 SW 中转 native 宿主
// （复用 background.js 的 {type:'native'} 通道），面板自身不直连 /_lifecycle。
//
// 关键决策（design §8.6）：
//   - 指纹激活：仅 document.title 含 "DeepSeek Harness" 才注入，误注入面为零；
//   - Shadow DOM：宿主节点 + open shadow root，样式内联在 shadow 内，与页面
//     CSS 双向零干扰；颜色用 --dsw-* 令牌（CSS 自定义属性可穿透 shadow 继承）
//     并带 fallback；
//   - 停止两步确认：面板所在页面将随 dsh 关闭，首次点击进入 3s 待确认态；
//   - 只读页面：仅追加自身节点，不读取/修改 dsh 页面 DOM 与数据。
// ============================================================================
(() => {
  // ---- 指纹激活：仅 dsh Web UI 页面 ----
  if (!/deepseek\s*harness/i.test(document.title)) return;
  if (window.__dshManagerPanelInjected) return; // 防重复注入
  window.__dshManagerPanelInjected = true;

  const POLL_MS = 2000;
  const CONFIRM_WINDOW_MS = 3000;

  // ---- 样式（内联于 shadow root；令牌来自页面 :root 的 --dsw-*，fallback 兜底） ----
  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; padding: 0; }
.panel {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483000;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary, rgb(15, 17, 21));
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1, rgb(255, 255, 255));
  box-shadow: 0 4px 16px rgba(15, 17, 21, 0.12);
  cursor: pointer;
  user-select: none;
  transition: background 0.1s ease-in-out;
}
.chip:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06)); }
.dot {
  position: relative;
  width: 10px;
  height: 10px;
  flex: none;
  color: var(--dsw-static-neutral-bluish-400, rgb(173, 178, 184));
  transition: color 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.dot:before {
  content: "";
  position: absolute; inset: 0;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.1;
}
.dot:after {
  content: "";
  position: absolute;
  top: 20%; right: 20%; bottom: 20%; left: 20%;
  border-radius: 50%;
  background: currentColor;
}
.dot-running { color: var(--dsw-alias-state-success-primary, rgb(34, 197, 94)); }
.dot-busy { color: var(--dsw-alias-state-warn-primary, rgb(245, 158, 11)); }
.dot-error { color: var(--dsw-alias-state-error-primary, rgb(236, 19, 19)); }
@keyframes dshm-pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
.dot-busy:after { animation: dshm-pulse 1.2s cubic-bezier(0.4, 0, 0.2, 1) infinite; }
.body {
  display: none;
  margin-top: 8px;
  padding: 10px 12px;
  width: 240px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, rgb(255, 255, 255));
  box-shadow: 0 6px 24px rgba(15, 17, 21, 0.14);
}
.panel.open .body { display: block; }
.status-line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  color: var(--dsw-alias-label-secondary, rgb(97, 102, 107));
}
.status-text { word-break: break-all; }
.btn-row { display: flex; gap: 8px; margin-top: 10px; }
.btn {
  flex: 1;
  height: 28px;
  padding: 4px 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  border-radius: 12px;
  background: var(--dsw-alias-bg-base, rgb(255, 255, 255));
  color: var(--dsw-alias-label-primary, rgb(15, 17, 21));
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  transition: background 0.1s ease-in-out, transform 0.1s ease-in-out;
}
.btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06)); }
.btn:active:not(:disabled) { transform: scale(0.96); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn.danger {
  color: var(--dsw-alias-state-error-primary, rgb(236, 19, 19));
}
.btn.danger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(236, 19, 19, 0.05));
}
.btn.confirm {
  background: var(--dsw-alias-state-error-primary, rgb(236, 19, 19));
  border-color: var(--dsw-alias-state-error-primary, rgb(236, 19, 19));
  color: rgb(255, 255, 255);
}
.feedback {
  display: none;
  margin-top: 8px;
  color: var(--dsw-alias-label-caption, rgb(173, 178, 184));
  word-break: break-all;
}
.feedback.visible { display: block; }
.feedback.error { color: var(--dsw-alias-state-error-primary, rgb(236, 19, 19)); }
.spinner {
  display: none;
  width: 10px;
  height: 10px;
  margin-right: 6px;
  vertical-align: -1px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: dshm-spin 0.8s linear infinite;
}
.btn.pending .spinner { display: inline-block; }
@keyframes dshm-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .dot-busy:after, .spinner { animation-duration: 0.01ms; animation-iteration-count: 1; }
  .chip, .dot, .btn { transition-duration: 0.01ms; }
}
`;

  // ---- DOM 构建（全部 createElement + textContent，无 innerHTML） ----
  const hostEl = document.createElement('div');
  hostEl.id = 'dsh-manager-panel-host';
  const root = hostEl.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  const panel = document.createElement('div');
  panel.className = 'panel';
  const chip = document.createElement('div');
  chip.className = 'chip';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const chipText = document.createElement('span');
  chipText.textContent = 'dsh web';
  chip.appendChild(dot);
  chip.appendChild(chipText);

  const body = document.createElement('div');
  body.className = 'body';
  const statusLine = document.createElement('div');
  statusLine.className = 'status-line';
  const statusText = document.createElement('span');
  statusText.className = 'status-text';
  statusText.textContent = '—';
  statusLine.appendChild(statusText);
  const btnRow = document.createElement('div');
  btnRow.className = 'btn-row';
  const btnStop = document.createElement('button');
  btnStop.className = 'btn danger';
  btnStop.textContent = '停止';
  const btnRestart = document.createElement('button');
  btnRestart.className = 'btn';
  btnRestart.textContent = '重启';
  btnRow.appendChild(btnStop);
  btnRow.appendChild(btnRestart);
  const feedback = document.createElement('div');
  feedback.className = 'feedback';
  body.appendChild(statusLine);
  body.appendChild(btnRow);
  body.appendChild(feedback);
  panel.appendChild(chip);
  panel.appendChild(body);
  root.appendChild(panel);
  document.body.appendChild(hostEl);

  // ---- 状态 ----
  let state = 'unknown'; // stopped | starting | running | stopping | external | error
  let detail = null;
  let busy = false;
  let confirmTimer = null;
  let pollTimer = null;
  let reqSeq = 0;

  function setBusy(v) {
    busy = v;
    btnStop.disabled = v;
    btnRestart.disabled = v;
    dot.className = 'dot ' + (v ? 'dot-busy' : dotStateClass());
    if (v) {
      btnStop.classList.add('pending');
      btnStop.insertBefore(makeSpinner(), btnStop.firstChild);
    } else {
      btnStop.classList.remove('pending');
      const sp = btnStop.querySelector('.spinner');
      if (sp) sp.remove();
    }
  }

  function makeSpinner() {
    const s = document.createElement('span');
    s.className = 'spinner';
    return s;
  }

  function dotStateClass() {
    if (state === 'running') return 'dot-running';
    if (state === 'starting' || state === 'stopping') return 'dot-busy';
    if (state === 'error') return 'dot-error';
    return '';
  }

  function renderStatus() {
    if (!busy) dot.className = 'dot ' + dotStateClass();
    let text = '';
    if (state === 'running') {
      text = '运行中';
      if (detail && Number.isInteger(detail.port)) text += ' · 端口 ' + detail.port;
      if (detail && detail.health && detail.health.ok) text += ' · 健康';
      chipText.textContent = 'dsh web · ' + (detail && Number.isInteger(detail.port) ? detail.port : '运行中');
    } else if (state === 'external') {
      text = '外部实例（非本扩展启动）';
      if (detail && Number.isInteger(detail.port)) text += ' · 端口 ' + detail.port;
      chipText.textContent = 'dsh web · 外部';
    } else if (state === 'starting') {
      text = '正在启动…';
      chipText.textContent = 'dsh web · 启动中';
    } else if (state === 'stopping') {
      text = '正在停止…';
      chipText.textContent = 'dsh web · 停止中';
    } else if (state === 'error') {
      text = '状态获取失败';
      chipText.textContent = 'dsh web · 错误';
    } else {
      text = '已停止';
      chipText.textContent = 'dsh web';
    }
    statusText.textContent = text;
    // running 可停止/重启；stopped 时重启等价于启动（宿主 restart 退化为 start）
    const running = state === 'running';
    if (!busy) {
      btnStop.disabled = !running;
      btnRestart.disabled = !(running || state === 'stopped');
    }
  }

  // ---- 与 SW 通信（复用既有 {type:'native'} 通道） ----
  async function nativeRequest(action, payload) {
    const id = 'cs' + (++reqSeq) + '-' + Date.now().toString(36);
    const resp = await chrome.runtime.sendMessage({
      type: 'native',
      id,
      action,
      payload: payload || {},
    });
    return resp || { ok: false, error: { code: 'NATIVE_ERROR', message: '扩展后台无响应' } };
  }

  async function refresh() {
    if (busy) return;
    let resp;
    try {
      resp = await nativeRequest('status', {});
    } catch (_) {
      state = 'error';
      renderStatus();
      return;
    }
    if (resp && resp.ok) {
      detail = resp.result || {};
      state = detail.state || 'stopped';
    } else {
      state = 'error';
    }
    renderStatus();
  }

  // ---- 操作 ----
  async function doStop() {
    if (busy) return;
    setBusy(true);
    feedback.className = 'feedback visible';
    feedback.textContent = '正在停止 dsh web（此页面将随之断开）…';
    try {
      const resp = await nativeRequest('stop', {});
      if (resp && resp.ok) {
        state = 'stopped';
        feedback.textContent = '已停止。可点「重启」恢复。';
        chipText.textContent = 'dsh web';
      } else if (resp && resp.error && resp.error.code === 'ALREADY_STOPPED') {
        state = 'stopped';
        feedback.textContent = 'dsh web 已停止（幂等）。';
      } else {
        feedback.className = 'feedback visible error';
        feedback.textContent = '停止失败：' + ((resp && resp.error && (resp.error.message || resp.error.code)) || '未知错误');
      }
    } catch (_) {
      feedback.className = 'feedback visible error';
      feedback.textContent = '停止失败：无法连接扩展后台';
    } finally {
      setBusy(false);
      renderStatus();
    }
  }

  async function doRestart() {
    if (busy) return;
    setBusy(true);
    feedback.className = 'feedback visible';
    feedback.textContent = '正在重启：停止旧进程 → 新进程启动中…';
    try {
      const resp = await nativeRequest('restart', {});
      if (resp && resp.ok) {
        detail = resp.result || {};
        state = detail.state || 'starting';
        feedback.textContent = '重启完成，dsh web 已就绪。';
      } else {
        feedback.className = 'feedback visible error';
        feedback.textContent = '重启失败：' + ((resp && resp.error && (resp.error.message || resp.error.code)) || '未知错误');
      }
    } catch (_) {
      feedback.className = 'feedback visible error';
      feedback.textContent = '重启失败：无法连接扩展后台';
    } finally {
      setBusy(false);
      renderStatus();
    }
  }

  // 两步确认：首次点击进入 3s 待确认态（面板所在页面将随 dsh 关闭，防误触）
  function onStopClick() {
    if (busy) return;
    if (btnStop.classList.contains('confirm')) {
      if (confirmTimer) clearTimeout(confirmTimer);
      btnStop.classList.remove('confirm');
      btnStop.textContent = '停止';
      doStop();
      return;
    }
    btnStop.classList.add('confirm');
    btnStop.textContent = '确认停止';
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => {
      btnStop.classList.remove('confirm');
      btnStop.textContent = '停止';
      confirmTimer = null;
    }, CONFIRM_WINDOW_MS);
  }

  function onChipClick() {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) refresh();
  }

  chip.addEventListener('click', onChipClick);
  btnStop.addEventListener('click', onStopClick);
  btnRestart.addEventListener('click', doRestart);

  // ---- 轮询与生命周期 ----
  function startPoll() { if (!pollTimer) pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS); }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPoll();
    else { startPoll(); refresh(); }
  });

  refresh();
  startPoll();
})();
