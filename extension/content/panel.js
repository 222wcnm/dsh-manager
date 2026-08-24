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
//   - 归属验证：仅当扩展管理的实例运行中且端口与当前页面一致时才开放操作；
//     其余情况（stopped、端口不匹配、外部/WSL 启动的实例）一律只读提示「未托管」；
//   - Shadow DOM：宿主节点 + open shadow root，样式内联在 shadow 内，与页面
//     CSS 双向零干扰；颜色用 --dsw-* 令牌（CSS 自定义属性可穿透 shadow 继承）
//     并带 fallback；
//   - 主题镜像：MutationObserver 观察 body[data-ds-dark-theme] →
//     chrome.storage.local.webuiTheme（design §8.7.3），供 popup/logs 跟随；
//   - 停止两步确认：面板所在页面将随 dsh 关闭，首次点击进入 3s 待确认态；
//   - 只读页面：仅追加自身节点，不读取/修改 dsh 页面 DOM 与数据；
//   - 圆点语义随「展示语义」而非原始状态：绿=本页托管运行中、蓝=外部实例、
//     灰=未托管/已停止、琥珀=启动/停止中、红=连续失败后才报「状态获取失败」；
//   - 扩展重载/更新后旧脚本上下文失效（chrome.runtime.id 为空）→ 停止轮询并
//     提示刷新页面，避免孤儿脚本永久误报红错；
//   - 展开面板绝对定位在胶囊上方：胶囊位置不动，面板向上弹出；
//   - M8/M8.1 徽标提醒（§8.9）：只读扫描会话状态标记（data-state 语义属性），页面
//     后台时 工作完成/等待用户 → 经 SW 上报表栏「!」/「?」提醒；并上报工作中/等待
//     计数（蓝 n 会话状态概览）；可见即清除。
// ============================================================================
(() => {
  // ---- 指纹激活：仅 dsh Web UI 页面 ----
  if (!/deepseek\s*harness/i.test(document.title)) return;
  if (window.__dshManagerPanelInjected) return; // 防重复注入
  window.__dshManagerPanelInjected = true;

  const POLL_MS = 2000;
  const CONFIRM_WINDOW_MS = 3000;
  const FAIL_STREAK_LIMIT = 3; // 连续失败次数阈值：MV3 SW 唤醒竞态等瞬时失败不立即红

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
  box-shadow: var(--dsw-shadow-lv1, 0 4px 16px rgba(15, 17, 21, 0.12));
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
.dot-external { color: var(--dsw-alias-state-business-primary, rgb(65, 118, 230)); }
.dot-busy { color: var(--dsw-alias-state-warn-primary, rgb(245, 158, 11)); }
.dot-error { color: var(--dsw-alias-state-error-primary, rgb(236, 19, 19)); }
/* 运行态呼吸（design §8.8：实心点 opacity .5↔1 + scale .88↔1，光晕同步 .08↔.16；
   reduced-motion 见下方媒体查询） */
@keyframes dsh-dot-breathe {
  0%, 100% { opacity: 0.5; transform: scale(0.88); }
  50% { opacity: 1; transform: scale(1); }
}
@keyframes dsh-halo-breathe {
  0%, 100% { opacity: 0.08; }
  50% { opacity: 0.16; }
}
.dot-running:after,
.dot-external:after {
  animation: dsh-dot-breathe 2.2s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}
.dot-running:before,
.dot-external:before {
  animation: dsh-halo-breathe 2.2s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}
@keyframes dshm-pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
.dot-busy:after { animation: dshm-pulse 1.2s cubic-bezier(0.4, 0, 0.2, 1) infinite; }
.body {
  display: none;
  /* 展开面板绝对定位在胶囊上方：胶囊（chip）位置不动，面板向上弹出 */
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  padding: 10px 12px;
  width: 240px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, rgb(255, 255, 255));
  box-shadow: var(--dsw-shadow-lv2, 0 6px 24px rgba(15, 17, 21, 0.14));
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
  .dot-running:after, .dot-running:before, .dot-external:after, .dot-external:before, .dot-busy:after, .spinner { animation-duration: 0.01ms; animation-iteration-count: 1; }
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
  let state = 'unknown'; // stopped | starting | running | stopping | external | error | detached
  let detail = null;
  let busy = false;
  let failStreak = 0; // 连续 status 失败计数（达 FAIL_STREAK_LIMIT 才进 error）
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

  // 归属判定：页面身份 ≠ 进程归属（页面标题只说明「有 dsh 的 UI」，不说明
  // 「这个 dsh 归扩展管」——WSL/终端启动的实例同样满足注入指纹）。仅当扩展
  // 管理的实例正在运行且其端口与当前页面端口一致时，本面板才有控制权。
  function ownership() {
    const pagePort = Number(window.location.port) || 0;
    const repPort = detail && Number(detail.port);
    return {
      repPort,
      isManagedHere: state === 'running' && repPort === pagePort,
      isExternalHere: state === 'external' && repPort === pagePort,
    };
  }

  // 圆点颜色跟随「展示语义」而非原始状态：绿只表示「本页托管实例运行中」；
  // 未托管（stopped / 端口不匹配 / external 不在本页）一律中性灰，外部实例蓝，
  // 启动/停止中琥珀脉冲，状态获取失败红（连续失败后）
  function dotStateClass() {
    const o = ownership();
    if (state === 'error') return 'dot-error';
    if (state === 'starting' || state === 'stopping') return 'dot-busy';
    if (o.isManagedHere) return 'dot-running';
    if (o.isExternalHere) return 'dot-external';
    return '';
  }

  function renderStatus() {
    if (!busy) dot.className = 'dot ' + dotStateClass();
    const o = ownership();
    let text = '';
    let chip = '';
    if (state === 'detached') {
      // 扩展重载/更新后旧内容脚本上下文失效（孤儿脚本）：页面刷新前无法恢复，
      // 明确提示而非误报「状态获取失败」
      text = '扩展已重载或更新，请刷新页面恢复';
      chip = 'dsh web · 已断开';
      btnStop.disabled = true;
      btnRestart.disabled = true;
    } else if (state === 'unknown') {
      // 状态未就绪：保持中性占位，按钮先禁用（refresh 很快收敛）
      if (!busy) { btnStop.disabled = true; btnRestart.disabled = true; }
      return;
    } else if (o.isManagedHere) {
      text = '运行中';
      if (Number.isInteger(o.repPort)) text += ' · 端口 ' + o.repPort;
      if (detail && detail.health && detail.health.ok) text += ' · 健康';
      chip = 'dsh web · ' + (Number.isInteger(o.repPort) ? o.repPort : '运行中');
    } else if (o.isExternalHere) {
      text = '外部实例（非本扩展启动）';
      if (Number.isInteger(o.repPort)) text += ' · 端口 ' + o.repPort;
      chip = 'dsh web · 外部';
    } else if (state === 'starting') {
      text = '正在启动…';
      chip = 'dsh web · 启动中';
    } else if (state === 'stopping') {
      text = '正在停止…';
      chip = 'dsh web · 停止中';
    } else if (state === 'error') {
      text = '状态获取失败';
      chip = 'dsh web · 错误';
    } else {
      // stopped，或 running/external 但端口与当前页面不一致：
      // 当前页面的 dsh 不由本扩展管理（如终端/WSL 启动的另一实例）
      text = '此实例不由本扩展管理（请在扩展 popup 中操作）';
      chip = 'dsh web · 未托管';
    }
    statusText.textContent = text;
    chipText.textContent = chip;
    // 仅「扩展管理的实例（运行中且端口匹配）」可停止/重启；其余一律只读
    if (!busy) {
      btnStop.disabled = !o.isManagedHere;
      btnRestart.disabled = !o.isManagedHere;
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

  // 扩展重载/更新后，旧内容脚本的 chrome.runtime 上下文失效（孤儿脚本）：
  // 消息将永远失败且页面刷新前无法恢复——统一走 detached（停止轮询 + 提示刷新）
  function contextAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  async function refresh() {
    if (busy) return;
    if (!contextAlive()) {
      state = 'detached';
      stopPoll();
      renderStatus();
      return;
    }
    let resp;
    try {
      resp = await nativeRequest('status', {});
    } catch (_) {
      failTick();
      return;
    }
    if (resp && resp.ok) {
      failStreak = 0;
      detail = resp.result || {};
      state = detail.state || 'stopped';
    } else {
      failTick();
      return;
    }
    renderStatus();
  }

  // 瞬时失败去抖：MV3 SW 休眠/唤醒竞态会让单次消息失败、下一轮即恢复；
  // 连续 FAIL_STREAK_LIMIT 次失败（约 6s）才显示红色错误态，期间保留上次成功状态
  function failTick() {
    failStreak += 1;
    if (failStreak >= FAIL_STREAK_LIMIT) {
      state = 'error';
      renderStatus();
    }
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
        feedback.textContent = '已停止。如需再次管理，请在扩展 popup 中操作。';
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
      // 动作在途扩展被重载：立即进 detached，避免短暂恢复旧状态（≤2s 后才被轮询纠正）
      if (!contextAlive()) { state = 'detached'; stopPoll(); }
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
      // 动作在途扩展被重载：立即进 detached，避免短暂恢复旧状态（≤2s 后才被轮询纠正）
      if (!contextAlive()) { state = 'detached'; stopPoll(); }
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
    if (document.hidden) { stopPoll(); attTick(); }
    else { startPoll(); refresh(); attTick(); }
  });

  // ---- 主题镜像（design §8.7.3）----
  // webui 深色状态以 <body data-ds-dark-theme> 属性标记（浅色无属性）。扩展
  // 无法直接读 dsh 的主题偏好（F9/F10 围栏），故此处只做 DOM 镜像：webui 翻主题
  // 时观察器回调 → 读 body 属性得 dark → 写 chrome.storage.local.webuiTheme，
  // 供 popup/logs 的 theme.js 跟随。幂等：值未变不写，避免无谓 storage 通知。
  function syncThemeMirror() {
    // 扩展重载/更新后旧上下文失效（孤儿脚本）：停止观察并静默，与既有 detached 模式一致
    if (!contextAlive()) {
      themeObserver.disconnect();
      return;
    }
    const dark = document.body.hasAttribute('data-ds-dark-theme');
    const port = Number(window.location.port) || null;
    chrome.storage.local.get({ webuiTheme: null }, (items) => {
      if (chrome.runtime.lastError) return; // SW/SW 上下文失效时静默跳过
      const prev = items.webuiTheme;
      if (prev && prev.dark === dark && prev.port === port) return; // 幂等
      chrome.storage.local.set({ webuiTheme: { dark, at: Date.now(), port } });
    });
  }

  const themeObserver = new MutationObserver(syncThemeMirror);
  themeObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['data-ds-dark-theme'],
  });

  // ---- 徽标提醒「该点回来看看了」（design §8.9，M8；M8.1 徽标=会话状态层）----
  // 只读扫描会话状态标记（webui 事实基线：StateDot 的 data-state 语义属性——
  // 工作中 = svg[data-state="ongoing"]；等待用户 = [data-state="warning"]；
  // 空闲/完成 = data-state="done"），页面隐藏时跟踪状态快照并上报**计数**
  // （蓝 n = n 个会话工作中）：
  //   waiting>0 → 'waiting'（紫「?」，优先级覆盖 done/working）；
  //   working>0 → 'working'（蓝 n 常驻状态概览）；
  //   工作 → 空闲（稳定 1.2s）→ 'done'（琥珀「!」事件提醒）；
  //   空闲 → 'idle'（该 tab 无会话信号）。
  // 页面重新可见即发 clear。只判定标记存在性与数量，不读取页面消息内容。
  // **计数数据源（2026-08-24 修复，design §8.9 修订）**：优先同源服务端点
  // GET /_manager/sessions（dsh-lifecycle 插件，与 popup「会话」区同一端点、同一
  // 状态判定）——原实现扫描 webui 页面 DOM（data-state），而 webui 显示态相对
  // 服务端事件流存在前段渲染延迟，会话完成/空闲的瞬间徽标会拿到旧计数（「徽标
  // 蓝 2、popup 会话区进行中 1」类不一致）；端点不可用（插件未装/旧版/网络失败）
  // 时才回退 DOM 扫描（历史行为；此时 popup 会话区为降级/隐藏路径，无「数字
  // 不一致」用户可见面）。同实例多标签重复计数由 SW 按端口去重（background.js）。
  const ATTENTION_TICK_MS = 1000; // 隐藏页定时器被 Chrome 节流到 1Hz，取 1s 与节流上限对齐
  const ATTENTION_DEBOUNCE_MS = 1200; // 工作→空闲需稳定空态 1.2s（吸收 React 重渲染瞬时抖动）
  const ATT_SESSIONS_ENDPOINT = '/_manager/sessions';
  const ATT_FETCH_TIMEOUT_MS = 1500; // 端点快取超时（与服务端点探测/宿主动作一致）
  let attPhase = 'idle'; // idle | working | waiting-fired | done-fired
  let attIdleSince = 0;
  let attActive = false; // 已向 SW 上报过（重新可见时需要 clear）
  let attLastSig = '';   // 最近上报过的 waiting:working 计数签名（变化才上报）
  let attTimer = null;
  let attBusy = false;   // 端点快取在途：跳过重叠 tick（fetch 超时可 > 1s 周期）

  // 服务端点计数（与 popup 会话区同源）；任何失败返回 null（调用方回退 DOM 扫描）
  async function attCountsFromEndpoint() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ATT_FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(ATT_SESSIONS_ENDPOINT, { signal: ctrl.signal, cache: 'no-store' });
      if (!resp.ok) return null;
      const data = await resp.json();
      if (!data || data.ok !== true || !Array.isArray(data.items)) return null;
      let working = 0;
      let waiting = 0;
      for (const it of data.items) {
        if (!it || typeof it !== 'object') continue;
        if (it.state === 'working') working += 1;
        else if (it.state === 'waiting') waiting += 1;
      }
      return { working, waiting };
    } catch (_) { /* 端点不可达/被拦截：回退 */ return null; }
    finally { clearTimeout(timer); }
  }

  // 计数快照：端点优先（同源一致），失败回退 webui DOM 扫描（插件未装/旧版）
  async function attSnapshot() {
    const ep = await attCountsFromEndpoint();
    if (ep !== null) return ep;
    let working = 0;
    let waiting = 0;
    try {
      working = document.querySelectorAll('svg[data-state="ongoing"]').length;
      waiting = document.querySelectorAll('[data-state="warning"]').length;
    } catch (_) { /* 页面卸载中：按无标记处理 */ }
    return { working, waiting };
  }

  function attSend(op, kind, s) {
    if (!contextAlive()) { attStop(); return; }
    const counts = { working: s ? s.working : 0, waiting: s ? s.waiting : 0 };
    chrome.runtime.sendMessage({ type: 'attention', op, kind, counts }).catch(() => { /* SW 休眠/唤醒竞态：静默，storage 引理自愈 */ });
  }

  async function attTick() {
    if (!contextAlive()) { attStop(); return; }
    const now = Date.now();
    if (!document.hidden) {
      // 页面可见：清除提醒（用户正在看），并复位状态机基线（无需端点数据）
      if (attActive) { attActive = false; attSend('clear'); }
      attPhase = 'idle';
      attIdleSince = 0;
      attLastSig = '';
      return;
    }
    if (attBusy) return; // 上一 tick 的端点快取未返回：跳过（hidden 1Hz 下仅偶发）
    attBusy = true;
    let s;
    try {
      s = await attSnapshot();
    } catch (_) {
      s = null; // 极端分支兜底（attSnapshot 内部已自吸收，此处双保险）
    } finally {
      attBusy = false;
    }
    if (!s) s = { working: 0, waiting: 0 };
    const sig = s.waiting + ':' + s.working;
    if (s.waiting > 0) {
      // 等待用户：立即上报（等待 > 进行中 > 完成）；计数变化（其他会话工作变化）也更新
      attIdleSince = 0;
      if (attPhase !== 'waiting-fired') attPhase = 'waiting-fired';
      if (sig !== attLastSig) {
        attLastSig = sig;
        attActive = true;
        attSend('set', 'waiting', s);
      }
    } else if (s.working > 0) {
      // 工作中：计数变化即上报（蓝 n 常驻概览）
      attIdleSince = 0;
      attPhase = 'working';
      if (sig !== attLastSig) {
        attLastSig = sig;
        attActive = true;
        attSend('set', 'working', s);
      }
    } else if (attPhase === 'working') {
      // 工作 → 空闲：稳定 ATTENTION_DEBOUNCE_MS 后上报「回来看看」
      if (attIdleSince === 0) attIdleSince = now;
      else if (now - attIdleSince >= ATTENTION_DEBOUNCE_MS) {
        attPhase = 'done-fired';
        attLastSig = sig;
        attActive = true;
        attSend('set', 'done', s);
      }
    } else if (attPhase !== 'done-fired') {
      // 一直空闲（无事件）：首次/计数变化时上报 idle（清空该 tab 的会话信号）
      attIdleSince = 0;
      if (sig !== attLastSig) {
        attLastSig = sig;
        attActive = true;
        attSend('set', 'idle', s);
      }
    }
  }

  function attStop() {
    if (attTimer) { clearInterval(attTimer); attTimer = null; }
  }

  refresh();
  startPoll();
  syncThemeMirror(); // 覆盖「面板注入时页面已是深色」场景
  attTimer = setInterval(attTick, ATTENTION_TICK_MS);
  attTick(); // 立即按当前可见性建基线
  // M2：同标签导航离开 dsh（tab 不关闭）时主动清除提醒；SW 侧 tabs.onUpdated 同规则兜底
  window.addEventListener('pagehide', () => {
    if (attActive) { attActive = false; attSend('clear'); }
  });
})();
