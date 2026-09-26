'use strict';

// ============================================================================
// Whalekeeper — 颜色语义自定义（M10，design §8.12）
//
// 零依赖 IIFE，挂 window.DSHColors。popup 与 logs 页共用（脚本标签引入）；
// 结构同 theme.js：storage 订阅 + documentElement 注入覆盖。
//
// 语义角色（可改，设置面板「颜色角色」区；M10.1 定稿三角色）：
// waiting（待确认）/ working（进行中）/ completed（完成）；
// 锁定（§8.9.1 硬规则）：error 红（红色只属于错误）、全部字符/文字语义。
// 改色不改义——颜色始终是辅助载体。
//
// 预设色板：只提供白名单色值（浅/深主题均可见），不开放任意输入
// （design §8.12 约束：色彩工程交给令牌体系）。
//
// 落地方式：读 settings.colorMap → 在 documentElement 上写 inline 语义变量
// --dsh-mgr-sem-<role>（:root 默认值见 popup.css / logs.css），组件一律引用
// 语义变量而非字面色值；改色只动 colorMap 一处（§8.12「一处配置、全域同语义」）。
// 实例状态层（状态卡/面板/logs 状态点）主语义=颜色（§8.9.1），不经本模块
// 配色调改，维持 --dsw-alias-state-* 令牌（不随会话角色色联动——见 §8.12
// 实施注记，2026-08-24）。
// ============================================================================

(function () {
  // M10.1 定稿（2026-08-24 用户拍板）：遵循 Web UI 区分，只显示三态——
  // 进行中（蓝）/ 待确认（黄）/ 完成（绿）。done（完成待办消息）并入 completed 色
  // （徽标「!」底色取 completed）；idle 不再展示（live 集合近零出现，见 design §8.10 注记）。
  const ROLES = ['waiting', 'working', 'completed'];

  // 默认色板（**定稿值**——design §8.12 M10.1：用户体验并确认最终色板，已回填）
  const DEFAULT_COLOR_MAP = {
    waiting: '#f59e0b',   // 琥珀黄=待确认（徽标「?」/ 会话区圆点；用户实机观察 webui 计划面板=黄色，取同色系）
    working: '#5686fe',   // webui 蓝=进行中（徽标「n」/ 会话区圆点；--dsh-state-ongoing 同源）
    completed: '#22c55e', // 绿=完成（徽标「!」——原琥珀随定稿改绿 + 会话区圆点）
  };

  // 预设色板（白名单）：蓝/琥珀/紫/绿/红/灰（复用 dsh 静态令牌值，浅深两套主题均可见）。
  // 红色 #ec1313 = 错误语义锁定色：可选但触发撞色提示（不硬拦——颜色仍为辅助载体）。
  const PALETTE = [
    { id: 'blue', color: '#5686fe', name: '蓝' },
    { id: 'amber', color: '#f59e0b', name: '琥珀' },
    { id: 'violet', color: '#8b5cf6', name: '紫' },
    { id: 'green', color: '#22c55e', name: '绿' },
    { id: 'red', color: '#ec1313', name: '红' },
    { id: 'gray', color: '#adb2b8', name: '灰' },
  ];

  const ERROR_COLOR = '#ec1313'; // 锁定：红色只属于错误（§8.9.1 防语义毁坏）

  const SEM_VAR_PREFIX = '--dsh-mgr-sem-';

  // 归一化 hex（#rgb → #rrggbb；非法返回 null）
  function normHex(value) {
    if (typeof value !== 'string') return null;
    const v = value.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(v)) return v;
    if (/^#[0-9a-f]{3}$/.test(v)) return '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    return null;
  }

  function isPalette(value) {
    const v = normHex(value);
    return !!v && PALETTE.some((p) => p.color === v);
  }

  // 规范化 colorMap：白名单角色 × 白名单色值；缺省/非法回退默认色板
  function normalizeColorMap(map) {
    const out = Object.assign({}, DEFAULT_COLOR_MAP);
    if (map && typeof map === 'object') {
      for (const role of ROLES) {
        if (isPalette(map[role])) out[role] = map[role];
      }
    }
    return out;
  }

  // 与错误红撞色判定（改 waiting/completed 时提示；不硬拦）
  function isReddish(hex) {
    return normHex(hex) === ERROR_COLOR;
  }

  // 注入语义变量（popup 点选即生效可直调；读 storage 路径经 applyIdempotent）
  function applyVars(map) {
    const m = normalizeColorMap(map);
    for (const role of ROLES) {
      document.documentElement.style.setProperty(SEM_VAR_PREFIX + role, m[role]);
    }
  }

  let lastApplied = null;

  function applyIdempotent() {
    if (lastApplied) clearTimeout(lastApplied);
    lastApplied = setTimeout(function () {
      chrome.storage.local.get({ settings: {} }, function (data) {
        const s = (data && data.settings) || {};
        applyVars(s.colorMap);
      });
    }, 0);
  }

  let storageBound = false;

  function init() {
    applyIdempotent();
    if (!storageBound) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        if (changes.settings && changes.settings.newValue) applyIdempotent();
      });
      storageBound = true;
    }
  }

  window.DSHColors = {
    ROLES: ROLES,
    DEFAULT_COLOR_MAP: DEFAULT_COLOR_MAP,
    PALETTE: PALETTE,
    ERROR_COLOR: ERROR_COLOR,
    normalizeColorMap: normalizeColorMap,
    isPalette: isPalette,
    isReddish: isReddish,
    applyVars: applyVars,
    init: init,
  };
})();
