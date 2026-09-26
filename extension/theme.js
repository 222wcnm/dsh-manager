'use strict';

// ============================================================================
// Whalekeeper — 主题与深色模式（M6，design §8.7）
//
// 零依赖 IIFE，挂 window.DSHTheme。popup 与 logs 页共用。
//
// 四态主题模型：
//   follow-webui  （默认）与 webui 实际渲染一致（storage 镜像 webuiTheme.dark）
//   follow-system        与操作系统一致（prefers-color-scheme）
//   light / dark         手动锁定
//
// 落地方式：在 document.body 上 设/移除 data-ds-dark-theme 属性（与 webui
// 渲染标记一致），由 popup.css / logs.css 的 body[data-ds-dark-theme]{…} 令牌块换肤。
// 主题偏好经 F9/F10 围栏无法从浏览器侧读取，扩展只做 DOM 镜像，不回写 webui 偏好。
// ============================================================================

(function () {
  const THEME_KEYS = ['follow-webui', 'follow-system', 'light', 'dark'];
  const DEFAULT_THEME = 'follow-webui';
  const mq = window.matchMedia('(prefers-color-scheme: dark)');

  // 白名单校验，非法回退默认
  function normalizeTheme(value) {
    return THEME_KEYS.indexOf(value) !== -1 ? value : DEFAULT_THEME;
  }

  // 解析四态 → 是否深色
  //   light => false；dark => true；
  //   follow-system => matchMedia；
  //   follow-webui => 优先 webuiTheme.dark（仅 boolean 采信），否则回退 matchMedia。
  function resolveTheme(settings, webuiTheme) {
    const theme = normalizeTheme(settings && settings.theme);
    if (theme === 'light') return false;
    if (theme === 'dark') return true;
    if (theme === 'follow-system') return mq.matches;
    // follow-webui：仅 boolean 才采信镜像；无镜像回退系统（设计规定的唯一回退）
    if (webuiTheme && typeof webuiTheme.dark === 'boolean') return webuiTheme.dark;
    return mq.matches;
  }

  // 应用主题：读 storage（settings.theme + webuiTheme 镜像）→ 解析 → 设/移除属性
  function applyTheme() {
    chrome.storage.local.get({ settings: {}, webuiTheme: null }, function (data) {
      const dark = resolveTheme(data.settings, data.webuiTheme);
      if (dark) document.body.setAttribute('data-ds-dark-theme', '');
      else document.body.removeAttribute('data-ds-dark-theme');
    });
  }

  // 各监听幂等防重复：用标志位确保只注册一次
  let storageBound = false;
  let mqBound = false;
  let lastApplied = null; // 防抖：避免重复触发重读 storage

  function applyThemeIdempotent() {
    if (lastApplied) {
      clearTimeout(lastApplied);
      lastApplied = null;
    }
    lastApplied = setTimeout(applyTheme, 0);
  }

  function init() {
    applyTheme(); // 立即应用一次（脚本在 </body> 前同步执行后手动调用）

    if (!storageBound) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        if ((changes.settings && changes.settings.newValue) ||
            (changes.webuiTheme && changes.webuiTheme.newValue !== undefined)) {
          applyThemeIdempotent();
        }
      });
      storageBound = true;
    }

    if (!mqBound) {
      mq.addEventListener('change', applyThemeIdempotent);
      mqBound = true;
    }
  }

  window.DSHTheme = {
    THEME_KEYS: THEME_KEYS,
    DEFAULT_THEME: DEFAULT_THEME,
    normalizeTheme: normalizeTheme,
    resolveTheme: resolveTheme,
    init: init,
    // apply 与 applyTheme 同义：供 popup 外观行「点选即生效」直接调用
    applyTheme: applyTheme,
    apply: applyTheme,
  };
})();
