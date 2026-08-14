'use strict';

// DSH Manager — background service worker
//
// 职责（docs/design.md §8.3）：
//   1. 串行化 native 调用：模块级 promise 链，一次只允许一个 connectNative 连接；
//   2. Native Messaging 消息收发：帧格式（4 字节小端长度前缀 + UTF-8 JSON）由
//      Chrome 平台与宿主（native-host/host.js §6.1）两侧实现，扩展只收发
//      JSON 对象，绝不手动编解码帧（Chrome 会自动序列化/反序列化）；
//   3. 本地健康探测（fetch GET /，1.5s 超时，任何 HTTP 响应码都算 up）；
//   4. chrome.alarms 周期刷新图标徽标；
//   5. onInstalled 初始化默认设置。
//
// 注意：MV3 下本文件是经典脚本（无 import/export），全局作用域即 SW 作用域。

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const NATIVE_HOST = 'com.dsh.manager';
const DEFAULT_SETTINGS = {
  port: 3080,
  profile: 'web',
  autoOpen: true,
  badgeInterval: 30, // 秒；chrome.alarms 最小周期 0.5 分钟（30s）
};
const PROBE_TIMEOUT_MS = 1500; // 探活超时
const NATIVE_TIMEOUT_MS = 30000; // 等待宿主响应兜底超时（默认）
// 按动作区分兜底超时：宿主内 stop(≤10s)+start(≤30s) 串行执行的 restart 需更长，
// 避免长操作被默认 30s 误判为「宿主无响应」→ NATIVE_ERROR（与 design §6.3 一致）
const ACTION_TIMEOUT_MS = {
  restart: 120000,
  start: 60000,
  stop: 45000,
  adopt: 45000,
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ settings: DEFAULT_SETTINGS }, (data) => {
      const s = (data && data.settings) || {};
      resolve(Object.assign({}, DEFAULT_SETTINGS, s));
    });
  });
}

// 本地健康探测：GET http://127.0.0.1:<port>/，1.5s 超时；
// 任何 HTTP 响应码都算 up；fetch 抛错 -> false。
async function probePort(port) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch('http://127.0.0.1:' + port + '/', {
      signal: ctrl.signal,
      cache: 'no-store',
    });
    return { up: true };
  } catch (_) {
    return { up: false };
  } finally {
    clearTimeout(timer);
  }
}

// 未安装宿主的标准错误应答
function hostNotInstalled() {
  return {
    ok: false,
    error: {
      code: 'HOST_NOT_INSTALLED',
      message: '未安装宿主，请运行 native-host 目录下的 install.ps1 后重启浏览器',
    },
  };
}

// ---------------------------------------------------------------------------
// 串行 native 调用
// ---------------------------------------------------------------------------

// 模块级 promise 链：一次只允许一个 connectNative 连接，其余排队。
// 该状态允许 MV3 SW 重启后丢失：SW 被回收时已建立的 Native Messaging port 会随之
// 断开，调用方（popup）侧的消息通道也会关闭并收到 reject，不会永久挂起；
// 重启后新调用重新建立队列，宿主端（host.js）另有全局锁保证串行排他，双保险。
let nativeQueue = Promise.resolve();

function enqueueNativeCall(id, action, payload) {
  const timeoutMs = ACTION_TIMEOUT_MS[action] || NATIVE_TIMEOUT_MS;
  const task = nativeQueue.then(() => runNativeCall(id, action, payload, timeoutMs));
  // 队列吞掉错误，避免后续任务因前一个失败而断链
  nativeQueue = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

// 单次 native 往返：连接 -> postMessage 请求对象 -> 按 id 匹配响应（超时兜底）-> 断开
function runNativeCall(id, action, payload, timeoutMs) {
  return new Promise((resolve) => {
    let port = null;
    let timer = null;
    let settled = false;

    const finish = (resp) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (port !== null) {
        try { port.disconnect(); } catch (_) { /* 忽略 */ }
      }
      resolve(resp);
    };

    const isHostMissingError = (msg) =>
      typeof msg === 'string' && /not found|not installed/i.test(msg);

    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      finish(isHostMissingError(msg) ? hostNotInstalled()
        : { ok: false, error: { code: 'NATIVE_ERROR', message: msg } });
      return;
    }

    // Chrome Native Messaging 自带 4 字节长度前缀 + JSON 帧（design §6.1），
    // onMessage 直接收到解析后的对象；禁止在此手动编解码帧。
    port.onMessage.addListener((obj) => {
      if (obj && typeof obj === 'object' && obj.id === id) finish(obj);
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      const err = chrome.runtime.lastError;
      const msg = err && err.message ? err.message : '';
      if (isHostMissingError(msg)) {
        finish(hostNotInstalled());
      } else {
        finish({
          ok: false,
          error: {
            code: 'NATIVE_ERROR',
            message: msg || '宿主连接意外断开',
          },
        });
      }
    });

    timer = setTimeout(() => {
      finish({
        ok: false,
        error: { code: 'NATIVE_ERROR', message: '等待宿主响应超时（' + Math.round(timeoutMs / 1000) + ' 秒）' },
      });
    }, timeoutMs);

    try {
      port.postMessage({ id, action, payload });
    } catch (e) {
      finish({
        ok: false,
        error: {
          code: 'NATIVE_ERROR',
          message: (e && e.message) ? e.message : String(e),
        },
      });
    }
  });
}

// ---------------------------------------------------------------------------
// 消息路由（popup -> SW）
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'native') {
    const id = (typeof msg.id === 'string' && msg.id) ||
      'sw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const action = String(msg.action || '');
    const payload = (msg.payload && typeof msg.payload === 'object') ? msg.payload : {};
    enqueueNativeCall(id, action, payload).then((resp) => {
      try { sendResponse(resp); } catch (_) { /* 消息通道已关闭（popup 已关闭/页面刷新），忽略 */ }
    });
    return true; // 异步应答
  }

  if (msg.type === 'probe') {
    const port = Number(msg.port);
    probePort(Number.isFinite(port) ? port : DEFAULT_SETTINGS.port).then((resp) => {
      try { sendResponse(resp); } catch (_) { /* 消息通道已关闭，忽略 */ }
    });
    return true; // 异步应答
  }

  return false;
});

// ---------------------------------------------------------------------------
// 徽标刷新（chrome.alarms）
// ---------------------------------------------------------------------------

async function refreshBadge() {
  const s = await getSettings();
  // M4：port 0（动态端口）是合法设置值——不能用 `|| 3080` 兜底（会把 0 吞掉、
  // 徽标错误地探测 3080）；仅对非法值（NaN/负/非数）回退默认
  const rawPort = Number(s.port);
  const port = Number.isFinite(rawPort) && rawPort >= 0 ? rawPort : DEFAULT_SETTINGS.port;
  // M4：port 0（动态端口）无法本地探活——经 native status 判定（宿主解析日志/记录中的实际端口）
  if (port === 0) {
    const resp = await enqueueNativeCall('bg-badge-' + Date.now().toString(36), 'status', {});
    const running = !!(resp && resp.ok && resp.result
      && (resp.result.state === 'running' || resp.result.state === 'external'));
    if (running) {
      const p = resp.result.port;
      chrome.action.setBadgeText({ text: '●' });
      chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
      chrome.action.setTitle({ title: 'dsh web 运行中' + (p ? ' (端口 ' + p + ')' : '') });
    } else {
      chrome.action.setBadgeText({ text: '' });
      chrome.action.setTitle({ title: 'dsh web 未运行' });
    }
    return;
  }
  const { up } = await probePort(port);
  if (up) {
    chrome.action.setBadgeText({ text: '●' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
    chrome.action.setTitle({ title: 'dsh web 运行中 (端口 ' + port + ')' });
  } else {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'dsh web 未运行' });
  }
}

// 按设置重建徽标告警（默认 badgeInterval=30 -> periodInMinutes=0.5；Chrome 最小周期 30s）
function ensureBadgeAlarm() {
  getSettings().then((s) => {
    const sec = Math.max(30, Number(s.badgeInterval) || DEFAULT_SETTINGS.badgeInterval);
    chrome.alarms.create('badge', { periodInMinutes: sec / 60 });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === 'badge') refreshBadge();
});

// 设置变更（popup 保存）后立即重建徽标周期
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) ensureBadgeAlarm();
});

// ---------------------------------------------------------------------------
// 安装/启动初始化
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  // 初始化默认设置（不覆盖用户已有值）
  chrome.storage.local.get({ settings: DEFAULT_SETTINGS }, (data) => {
    const merged = Object.assign({}, DEFAULT_SETTINGS, (data && data.settings) || {});
    chrome.storage.local.set({ settings: merged });
  });
  ensureBadgeAlarm();
  refreshBadge();
});

chrome.runtime.onStartup.addListener(() => {
  ensureBadgeAlarm();
  refreshBadge();
});

// SW 被唤醒（如用户重新加载扩展）时立即刷新一次徽标
refreshBadge();
