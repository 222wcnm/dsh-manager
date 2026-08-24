# AGENTS.md — DSH Manager

浏览器扩展 + Native Messaging 宿主，管理 DeepSeek Harness（dsh）web 服务生命周期：浏览器一键启动/停止/重启 `dsh web`（默认 http://127.0.0.1:3080），免开终端。

## 权威文档（改动前必读）

- `docs/design.md` — 唯一规格：架构、宿主协议（§6）、安全模型（§12）、路线图（§15）；基于 @deepseek-ai/dsh@0.1.0-rc.6 逐条核验的事实基线（§2）
- `native-host/test/VERIFICATION.md` — M1 验收报告与已知偏差清单
- `native-host/test/manual-e2e.md` — 人工验证步骤

**约定：重大改动先改 design.md 再改代码；扩展与宿主间的协议变更必须同步 §6.2 与两处实现；改 host.js 必须补跑/新增 smoke 场景。**

## 目录

- `extension/` — Chrome MV3 扩展，原生 JS 零依赖（manifest.json 含固定 key → 扩展 ID `dahcfklamlpgkngijomlnoclclfodkjm`；background.js 串行 native 调用+徽标；popup.*；logs.*（M3 日志查看页）；content/panel.js（M3 页面内管理面板，content script + Shadow DOM））
- `native-host/` — `host.js` 零依赖 CJS 宿主（stdio 4 字节帧 + `--req/--res` 文件模式）；`install.ps1`/`uninstall.ps1`（Windows）；`install.sh`/`uninstall.sh`（Linux/macOS，M4，用户级 NativeMessagingHosts 清单）；`test/`（smoke.js、fake-dsh.js、smoke-real.js、e2e-m9-manager.js（M9 真实实例 e2e，真实 profile 插件装配））
- `plugin/` — M2 起：dsh-lifecycle 插件
- `tools/` — 开发期工具：`visual-audit/`（视觉审计）、`icons/`（图标生成）、`verify-ui/`（扩展 UI 自动验收：`verify-cdp.js` 沙箱内可用零依赖 CDP；`verify-ui.js` MCP 路径需沙箱外）
- `docs/` — 设计文档、接手说明

## 常用命令

```powershell
node --check native-host/host.js                     # 宿主语法检查
node native-host/test/smoke.js                       # 冒烟测试 27 场景（本机：Windows 347 PASS+1 SKIP——场景 26 POSIX；Linux 337 PASS+1 SKIP——场景 27 载体为 Windows 专属；全新克隆：Windows 332 PASS+4 SKIP——3 项本地产物核对跳过；BASE_ENV 进程枚举围栏仅 Windows 生效——场景 26 在 POSIX 不注入任何钩子走真实 /proc 平台层）
node native-host/test/smoke-real.js                  # 真实 dsh 集成（需 DSH_MANAGER_NPM_PREFIX=%APPDATA%\npm）
node native-host/test/e2e-m9-manager.js              # M9 真实实例 e2e（真实 profile 插件装配；插件未升级时 SKIP；需 danger-full-access）
node --test "plugin\dsh-lifecycle\test\*.test.js"    # dsh-lifecycle 插件单测（33 项）
powershell -ExecutionPolicy Bypass -File native-host\install.ps1 -DryRun   # 安装预演（Windows）
sh native-host/install.sh --dry-run                                          # 安装预演（Linux/macOS）
powershell -ExecutionPolicy Bypass -File tools\linux\verify-linux.ps1 -E2E  # WSL Linux 冒烟 + 真实安装 E2E
node tools/verify-ui/verify-cdp.js                   # 扩展 UI 自动验收 97 断言（沙箱内可用，若沙箱拦 headless Chrome 启动则需沙箱外；popup/logs/面板注入与展开 + 面板停止两步确认态（首击确认/3s 还原，不执行） + 面板体验回归（托管绿点+端口、展开时胶囊位置不变、面板在胶囊上方、扩展重载后旧面板提示刷新/刷新恢复） + 日志页「加载更早/复制全部」交互 + popup 设置校验交互 + 徽标三步实测 + M8/M8.1 徽标提醒（SW 分层 done「!」/ waiting「?」/ 蓝 n 工作中计数 / 9+ 边界 / done>working 优先级 / 清空恢复 + 角标断言（icon 状态 + title）+ e2e 后台页注入等待标记 → 黄「?」→ 切回标签自动清除）+ 主题与深色断言（面板深色跟随、storage 镜像写入、popup 四态 + Emulation 系统模拟、深色段无新增 console 异常）+ M7 断言（状态卡结构/文案、状态变体（running 实心点呼吸 / external / busy 琥珀脉冲无矩阵 / error 红调卡 / stopped 灰点）、深/浅状态卡背景（深=#1e2025 渲染）、面板呼吸动画）+ M9 断言（会话区初始隐藏、四态渲染+圆点色表（M11：待确认>进行中/已停止>已完成新鲜；idle 与陈旧完成不渲染）、title 降级「会话 #id 前8」、子代理树行、空态、插件不可用降级）+ M10 断言（默认色板三态、改色后会话区/徽标底色实际变化、实例层圆点不随角色色改、撞色 toast、恢复默认（storage 键级比对）、字符语义回归）+ M11 断言（仅新鲜完成显示、已读入口与 3s 撤销倒计时、落库移除行、retentionMins=0 时已停止恒显）+ console 异常检查；默认 dsh URL 3080（VERIFY_DSH_URL 覆盖））
node tools/verify-ui/verify-ui.js --list             # MCP 路径诊断（chrome-devtools-mcp，需沙箱外）
```

- 扩展改动 → `chrome://extensions` 重新加载
- 宿主或安装器改动 → 重跑 `install.ps1`，并**完全重启浏览器**（native host 注册只在浏览器启动时读取）

## 环境事实

- Node ≥ 18；dsh 0.1.0-rc.6 全局安装；默认端口 3080
- 宿主安装位置 Windows `%LOCALAPPDATA%\dsh-manager\host\`（host.cmd 内是绝对路径，**项目移动必须重跑 install.ps1**）；注册表 HKCU：Chrome/Edge/Firefox 的 `NativeMessagingHosts\com.dsh.manager`。Linux/macOS 为 `$XDG_CONFIG_HOME/dsh-manager`（或 `~/.config` / `~/Library/Application Support`），install.sh 写四份用户级浏览器清单（google-chrome/chromium/microsoft-edge/.mozilla），无需 sudo
- 宿主测试钩子（环境变量）：`DSH_MANAGER_BASE_DIR`、`DSH_BIN_STUB`、`DSH_MANAGER_NPM_PREFIX`、`DSH_MANAGER_PID_CHECK=0`、`DSH_MANAGER_FAKE_PROCESSES`（JSON `[{pid,cmdline}]`）、`DSH_MANAGER_FAKE_LISTENERS`（JSON `[{pid,addr,port}]`）；仅当 `DSH_MANAGER_TEST_MODE=1` 时生效

## 当前状态与路线

- **M11.1 Popup 空间架构升级（2026-08-25 完成与定稿，design §8.2）**：彻底解决传统单列 Popup 在会话展开、设置切换时的尺寸拉长与高度抖动问题，升级为 **V6 侧边 Rail 导轨模式（380px 宽度 × 270px 严格物理锁定高度，绝对零抖动）**。
  - **核心架构**：左侧 **46px 极窄 Rail 导轨**（概览/会话/设置 3 态导航 + 同相位 2.2s 常驻呼吸指示灯）+ 右侧 **334px 独立视口**（搭载 `panel-slide-in` 平滑进场动效）。
  - **官方原生资产库全量接入 (`dsh-assets-library.js`)**：100% 提取自 `@deepseek-ai/` 官方 bundle，包含 `FishLogo`（精准 23.16:17.04 比例，悬停触发原厂 `dsh-fish-swim` 游弋动效）、`BrandBadge`（`[DSH WEB]` 矩形微胶囊）、`StateMatrix`（进行中点阵）、4 态外观主题图标与全套业务图标。
  - **官方真实选中态规范**：严格遵循 Web UI 真实规范——无粗重反色填充，无多余外黑/白框线，采用**纯净柔和的灰色圆角背景**（深色 `rgba(255,255,255,0.14)`，浅色 `rgba(38,49,72,0.10)`），图标文本高亮提亮。
  - **排版重构与精修**：
    - **服务概览**：`[FishLogo] Whalekeeper [DSH WEB] [3080]` + 状态卡 + 打开 Web UI + 三态运维操作行 + 优雅停机感知与「查看日志」入口；
    - **会话感知**：卡片流只读感知（琥珀待确认、`shimmer` 流光扫光进行中、柔绿已完成）+「前往 Web UI 统一处理」；
    - **首选项设置**：三大分组微卡片（服务运行环境 / 徽标与外观 / 扩展徽标与会话颜色）+ Profile 方案 A 友好说明 + 4 态外观 Theme Cube + 3 角色静态单层柔光色盘（安静不呼吸）+ 底部双操作栏。
  - **无回归兼容**：保持原有全部 DOM ID 契约与 Service Worker / Native 通信链路 100% 兼容。

- **M10 颜色语义自定义（2026-08-24 完成 + M10.1 定稿，design §8.12 + 实施注记）**：`settings.colorMap` 预设色板，用户可改色（同 theme-cube 交互；「恢复默认色板」；保存设置不覆盖）；error 红（`#ec1313`）与字符/文字语义锁定。链路：新增 `extension/colors.js`（`window.DSHColors`，theme.js 同构：storage 订阅 + documentElement inline `--dsh-mgr-sem-*`；白名单色板无任意输入；popup.html 引入）→ popup 会话区圆点走语义变量（`.dot-error` 集中引用 `--dsh-mgr-sem-error`）→ **SW 徽标底色运行时读 colorMap**（`background.js` `normColorMap` 零依赖同口径；字符 `?`/`!`/n 恒在）。**M10.1 定稿（2026-08-24 用户拍板——体验后确认最终色板，定稿流程闭环）**：**只显示三态三色，遵循 Web UI 区分**——进行中=webui 蓝 `#5686fe` / 待确认=琥珀黄 `#f59e0b`（用户实机观察 webui 计划面板=黄色，取同色系；紫色退出默认色板）/ 完成=绿 `#22c55e`；**done（完成待办提醒）并入 completed 色**（徽标「!」随定稿由琥珀改绿；「查看后不再显示」= M8 页面可见即 clear，行为不变；`attentionDone` 独立开关保留）；**idle 不再展示**（渲染层过滤——live 集合近零出现 + webui 本体不区分，§8.10 idle 注记）；状态词「等你拍板」→「**待确认**」（拍板；emoji 徽标仅问询，暂不引入——字符语义仍锁定）。**生效范围取舍（实施注记）**：colorMap 严格按 §8.12 角色表载体列生效（徽标 + popup 会话区圆点）；**状态展示层（状态卡/面板/logs 实例圆点）不随角色色改**——其主语义是颜色（§8.9.1），防「空闲→绿」把已停止实例渲染成绿点毁坏实例语义，继续走 `--dsw-alias-state-*` 令牌（verify 显式断言不变）。验收：verify-cdp **94 / FAIL 0**（M10 段 + M9 idle 过滤 + 徽标色断言全量更新）；`node --check` 全过；无新增 console 异常。**顺带修复**：verify 默认 dsh URL 8080→**3080**（8080 为用户旧实例端口，真实 run 记录在 3080——面板/主题段此前因指向空端口假失败）。**UI 用词（2026-08-24 用户拍板）**：设置面板区名「**颜色角色**」（直观、点明"每种颜色承担一个角色"）；术语层=**语义色（semantic color）**——design token 标准语，里程碑名/代码 `--dsh-mgr-sem-*`/`settings.colorMap` 沿用"颜色语义"表述。

- **M8 徽标计数同源修复（2026-08-24，design §8.9 修订）**：用户实机反馈「徽标蓝 n 与 popup 会话区进行中数量偶发不一致」（同日在管 dsh 上复现：徽标 2 vs 会话区 1 working + 2 completed）。根因：徽标计数来自 content script 扫描 webui 页面 DOM（`data-state` 显示态——相对服务端事件流有前端渲染延迟，会话完成/空闲瞬间拿到旧计数），会话区来自 `/ _manager/sessions` 服务端点（事件流判定），两源不同步；且同实例多标签各自上报被 SW 按 tab 累加（重复计数）。修复：① **panel.js 计数数据源改为同源服务端点优先**（`fetch('/_manager/sessions')`，1.5s 超时，与 popup 会话区同一端点/同一判定；页面无 CSP 头、插件 `allow()` 同源放行——已实测），DOM 扫描仅回退（插件未装/旧版/端点失败；此时 popup 会话区为降级路径，无数字不一致可见面）；attTick 加 `attBusy` 重入保护（fetch 超时可 > 1s 周期）；② **background.js `pickAggregate` 按端口归并去重**（同端口只保留 `at` 最新条目，idle 无信号不参与竞争；无端口条目按 tab 独立，兼容旧数据）；③ verify-cdp M8 e2e 适配双路径：先探测端点可用性——可用走 **Fetch 域 mock 端点响应**驱动真实链路（`sessionsMockProvider` + `fulfillSessionsMock`），不可用走原 DOM 注入回退路径；④ design §8.9/§12.2 同步；⑤ **宿主侧 actionRestart 修复**（同日用户反馈「设置改端口后重启仍起旧端口」）：restart 以 payload 显式字段（host/port/profile/extraArgs）优先、run 记录回退（非 adopted extraArgs 仍走 §12.1 白名单；adopted 分支 payload 生命周期字段先过 validateStartPayload 再重放，extraArgs 恒黑名单过滤）；smoke 全量 **PASS 360 / FAIL 0 / SKIP 1**（场景 6 新增 s6b/s6c 端口覆盖断言）；host.cmd 直接引用仓库 host.js，改动即生效，无需重装。
- **规划（2026-08-23 用户提出，已定稿于 design.md）**：① **扩展能力边界规范（§8.11）**——防「喧宾夺主」：扩展只做四象限（生命周期管理 / 状态情报（摘要） / 快速入口 / 安全护栏），六条红线（不做会话内容与会话内操作、不替 dsh 配置编排、不做完整状态镜像、不碰凭据与数据、不越权管理任意进程端口）+ 三问准则 + 体积/权限纪律；**新增功能先过本节对照**。② **M10 颜色语义自定义（§8.12）——已交付且定稿完成（2026-08-24，见顶部 M10/M10.1 记录）**：三角色三色定稿（进行中蓝/待确认黄/完成绿；done 并入完成色、idle 不再展示），无剩余待办。③ **M11 项目更名（§15.1）**——名字太朴实；命名候选 **Whalekeeper/鲸守 已确认为候选（2026-08-23 用户认可）**（Portwatch/Loopkeeper 备选）；一期显示品牌（manifest/README/popup/GitHub 仓库名，key 不变则扩展 ID 不变）+ 二期全量更名（`com.dsh.manager` 协议名、注册表、状态目录、`DSH_MANAGER_*` 钩子，含迁移/卸载兼容）；**Chrome Web Store 上架前必须完成**；待最终定名（冲突核查 + 中文副名「鲸守」确认）。
- **M9 扩展面板会话状态（2026-08-23 完成，design §8.10）**：popup「会话」区（状态卡下、
  操作区上，可折叠默认展开）展示扩展管理实例的 **live 会话摘要（只读元数据，不读消息内容）**：
  标题 + 状态圆点色表（琥珀=进行中 / 紫=等你拍板（§8.9.1 紫语义）/ 绿=已完成 / 灰=空闲，
  恒带文字状态词防颜色混淆）+ 计数；行**纯展示**（无点击交互，见 M9 修补）。链路四层：① **dsh-lifecycle
  插件**（M9.2）新增只读端点 `GET /_manager/sessions`（lifecycle 同款 `allow()` 围栏 + 405；
  title 从 `session/title` 事件 fold——不依赖 sessionTitle 服务；state 由事件流判定：
  `approval/asked`↔`approval/decided`（id 配对，apiproxy 同款回扫）、`tool/call`
  (name=ask_user_question)↔`tool/result`（callId 配对）；`agents.get(id).status==='running'`
  →working；有 `turn/end`→completed；其余 idle；v1 只列 live 会话）；② **host**（M9.3a）
  新增只读 `sessions` 动作：readRunRecord→`getManagerSessions(port,1500)`（HTTP 200+json.ok+
  items 数组才通，≤128KB），不可用一律 `{available:false,items:[]}` 不抛错，items 上限 50；
  ③ **SW**：泛化 native 路由零改动，`ACTION_TIMEOUT_MS` 增 `sessions: 8000`；④ **popup**
  （M9.3b）：会话区 HTML/CSS（`--dsw-*` 令牌；新增 `--dsw-static-violet-500:#8b5cf6`（浅/深
  两套已定义，徽标紫同源））+ `refreshSessions()`（随 2s 轮询、仅 running/external 拉取，
  失败静默）+ `applySessions()`（null→隐藏；不可用且运行中→「安装/升级 dsh 配套插件后可
  查看会话」、未运行→隐藏；空→「暂无会话」）。**M9.1 spike 结论**：host 侧全部信号权威
  可读（sessions.list / agents.status / session/title 事件 / approval·question 事件对），
  webui 的 pendingInteraction 是客户端帧跟踪，插件改用等价事件流判定，不依赖 apiproxy
  内部状态；**D1=扩展现有 dsh-lifecycle 包**。验收：插件单测 **29/29**（新增 8 项）；
  宿主 smoke **356 / FAIL 0 / SKIP 1**（场景 28 新增 9 断言）；verify-cdp **82 / FAIL 0**
  （M9 段 8 断言：初始隐藏、四态渲染+圆点色、title 降级「会话 #id 前 8」、空态、降级提示、
  折叠 aria、行点击 chrome.tabs.create spy）；真实实例 e2e **7/7**（`e2e-m9-manager.js`：
  真实 dsh **0.1.1-rc.2**——事实基线已从 0.1.0-rc.6 漂移（用户已升级，design §2 待同步）+
  真实 profile web 装配，临时端口 31998 + 隔离 BASE：端点 200/403/405、available:true、
  lifecycle/优雅停机无回归；真实 DSH_HOME 只读行为）。**本机插件已升级**（
  `%USERPROFILE%\.dsh\plugins\dsh-lifecycle\index.js` ← 新版，原版备份 `index.js.bak-m9`）。
  已知局限（低）：v1 只列 live 会话；plan-review 归入 waiting 不细分（契约 4 态）；
  verify M9 段为 mock 注入（真实状态流转由插件单测覆盖）。**M9 修补（2026-08-23 用户实机
  反馈）**：会话行原「点击 → 打开该实例 Web UI」构成误导——Web UI 无 URL 会话深链
  （打开后恢复 localStorage「上次选中会话」），点 B 行却进 A 会话；**行改为纯展示**
  （无 role/tabindex/pointer/点击，verify-cdp 断言同步改为「点击不触发 tabs.create 防
  误导回归」），导航由「打开 Web UI」按钮承担；「会话深链」列为规划（待 Web UI 支持
  URL 定位后行点击带 sessionId 打开指定会话，属 §8.11 快速入口象限；design §8.10 修订）。
  **M9 修补二（2026-08-23 用户实机反馈，两次修订定稿）**：会话指示灯呼吸——① 补呼吸；
  ② **四态全呼吸 2.2s**（各颜色/状态都呼吸：动画仅辅助，文字状态词仍主语义）+
  **呼吸全 popup 同步**（popup.js 以打开时刻为时钟零点，渲染时负 animation-delay
  （`--dot-align-delay`）折算回零点相位；实测 effect 进度差 <8ms）+ **会话点补光晕层**
  （复刻 `.dot` 分层圆点：外圈 10% 光晕 + 内实心，光晕同步呼吸；尺寸与实例点统一 10px——M9 初版 8px 为次级元素旧尺寸）；verify-cdp 新增 2 条
  断言（四态全呼吸+光晕、全 popup 相位同步——用 `effect.getComputedTiming().progress`
  度量），全量 **PASS 84 / FAIL 0**；design §8.10 已修订为定稿规则。
- **M8 徽标提醒「该点回来看看了」（2026-08-22，design §8.9）**：
  解决「用户不驻守 dsh 标签」场景——dsh 页面在后台时，会话状态变化经工具栏徽标提醒：
  一轮工作完成 → 琥珀「!」（`#f59e0b`）；随时等待拍板（批准/问答/计划审查）→ 紫「?」
  （`#8b5cf6`——方案 A（2026-08-22 用户决策）：原红「?」#ec1313 与状态层错误红撞色，
  紫=「等你拍板」专用色，红色全域只留给错误；§8.9.1 三层语义分层表），优先级覆盖完成；
  页面重新可见/标签关闭自动清除，徽标恢复服务态（绿点/空）。
  ① **检测层（content/panel.js）**：只读扫描 webui StateDot 的**语义 data-state 属性**（事实
  基线取自 @deepseek-ai/dsh-client-ui-workspace 0.1.1-rc.2：工作中 = `svg[data-state="ongoing"]`
  点阵、等待用户 = `[data-state="warning"]`、空闲/完成 = `done`）——非 CSS-module 哈希类名，
  跨版本漂移风险低；仅判定存在性，**不读消息内容**（§12.2 已补例外说明）。状态机
  `idle→working→(稳定 1.2s 空态)→done-fired`；`waiting-fired` 出现即上报；`document.hidden`
  （标签不活跃/窗口最小化）才上报，可见即 clear；`done-fired` 须再见 working 才可复位
  （防同一轮重复上报）。② **渲染层（background.js）**：`attentionMap`（storage.local，
  `{tabId:{kind,at}}`，MV3 SW 可回收的安全持久化）+ 徽标分层渲染 `waiting > done > 服务态`
  （`refreshBadge` 只算服务态快照，`applyBadge` 统一应用）；`sender.tab.id` 为事实键（多
  dsh 标签各记各）；`tabs.onRemoved`/`onStartup`/`onInstalled` 清理 + 4h TTL 兜底防僵尸键；
  `settings.attention`（默认开）关闭后忽略 set 并回退服务态。③ **popup**：设置面板「界面」
  分组新增「徽标提醒（回来看看）」开关（`set-attention`）。④ **verify-cdp 新增 8 条
  记录**（7 断言 + 1 e2e 异常兜底记录）：SW 分层渲染（done→琥珀「!」/ waiting→紫「?」
  且覆盖 / 清空恢复）+ e2e（真实 dsh 页
  切后台 → 注入 `[data-state="warning"]` → 紫「?」→ 切回标签自动清除）——e2e 依赖
  `--headless=new` 的标签激活可见性语义与内容脚本 1s 扫描；全量 **PASS 71 / FAIL 0**；
  `node --check` 全过。
  已知局限（design §8.9）：会话侧栏完全关闭（宽度 0，行组件卸载）时无标记可扫（默认布局
  与窄屏 rail 均渲染行）；仅 alt-tab 到其他应用（窗口未最小化）时 `document.hidden=false`
  不触发——浏览器页面可见性语义。
  **M8 修补（2026-08-22，子代理盲审后修订）**：① **H1**：`handleAttention` 的 set 分支加
  `cachedSettings.attention === false` 前置拒绝（原实现只在渲染层看开关——关闭期间 SW 仍
  被事件唤醒写 storage，且重开开关会冒出关闭期间累积的陈旧提醒；storage.onChanged 在开关
  变 off 瞬间清空 attentionMap）；② **M1**：verify 补 done「!」路径真实链路 e2e（注入
  `svg[data-state=ongoing]`→移除→attentionMap done 条目+琥珀「!」；基线存在真实工作中会话
  时如实记录不执行）；③ **M2**：同标签导航离开 dsh 时清残留——panel.js `pagehide` 发
  clear + SW `tabs.onUpdated` 按 URL 判定兜底；④ **L3**：`handleAttention` 校验
  `sender.tab.url` 为 dsh 回环页（本扩展 host_permissions 覆盖，零新权限）；⑤ **L4**：
  background `DEFAULT_SETTINGS` 补 `theme:'follow-webui'`（与 popup 默认值分裂会导致
  onInstalled 合并丢弃主题）；⑥ **L2**：verify 断言补 fg=白（`getBadgeTextColor`）；
  e2e 以 storage `attentionMap` 条目为链路证据（防「页面原生 warning」假阳性）+ `hidden`
  显式断言 + 轮询替代固定 sleep（M4 缓解）。verify-cdp M8 段现为 7 断言 + 1 e2e 异常兜底记录。
  **M8.1 徽标语义重构（2026-08-22 用户决策，design §8.9/§8.9.1，verify-cdp 74/74）**：双载体分层——
  实例状态层 → **图标角标**（setIcon 预生成变体 `icons/{ok,error}-*.png`：绿点=运行/红点=错误·未装宿主/
  无点=停止）；徽标 → 会话状态层（紫?=等你拍板 / 琥珀!=完成（`settings.attentionDone` 独立开关）/
  **蓝 n**=n 会话工作中 #5686fe=webui `--dsh-state-ongoing` 同源，n≥10 显示 9+；优先级 waiting>done>working）。
  panel.js 扫描改**计数**并隐藏页内计数签名变化即上报（`{op:'set',kind:'idle|working|waiting|done',counts}`）；
  attentionMap 条目 `{kind,working,waiting,at,port}`，refreshBadge 判实例未运行/异常即按 port 清会话信号
  （死提醒联动）；自定义语义（预设/字符映射）暂缓（用户先要基础功能）。
- **M7 完成（2026-08-22：popup 排版优化——方案 A「应用栏 + 状态卡 + 分组设置」，design §8.8，verify-cdp 当前口径 63/63）**：
  解决 §8.2 现行排版的「平铺朴实感」。① **三区结构**（popup.html/css/js）：应用栏
  （20px 鲸鱼 + 「DSH Manager」15/600 + 「dsh web」胶囊标签 + 28px 圆形刷新/设置）、
  **状态卡**（`bg-module-platform` 底 + border-l1 + 圆角 12：状态词 13/500 + 端口 12/500
  业务蓝 + 次级行 11.5px caption tabular-nums——原 url-row/detail-line 三处文本合并为卡内
  两行，`renderStatusCard()`/`dotStateClass()` 抽出；`#dot`/`#url-text`/`#uptime-text`/
  `#detail-line` 等 29 个既有 id 全保留（旧三元素移入隐藏 legacy 容器）+ 4 个新增状态卡 id
  （statuscard/state-word/port-text/row2-text））、操作区
  （h32 primary/danger/outline + 「打开 Web UI」全宽 ghost）、底栏（border-top-l1 +
  11px 提示 + 「查看日志」link）。② **状态变体**：running 绿点（**实心点呼吸 2.2s**：opacity
  .5↔1 + scale .88↔1，光晕同步 .08↔.16——用户偏好，光晕单独呼吸难观察故迁移到实心点）/
  stopped 灰点 / external 蓝点（同呼吸）端口 / starting·stopping 琥珀 warn + **琥珀圆点脉冲**
  （1.2s；webui Matrix 点阵已撤销，见下）/ **error 红调卡**
  （border rgba(236,19,19,.25) + 状态词 error 红，错误详情仍走既有 error 面板）。
  ③ **§8.8.1 Matrix 动效（已撤销 2026-08-22 用户复盘）**：曾按 webui 会话侧栏「正在工作」
  点阵原样复刻（SVG 10×10 viewBox 3×3 外圈 8 个 2×2 rect、`@keyframes dot-chase` 1s 循环、
  125ms 相位差——提取存档见 git 历史）；复盘结论：webui 点阵语义=**长时进行中的会话工作**，
  扩展 busy（starting/stopping/操作在途）是**秒级过渡态**，1Hz 追逐动画套上观感为「点阵闪现」，
  语义不匹配 → 不使用，busy 统一琥珀脉冲；popup/panel/logs 三处矩阵代码（SVG/关键帧/
  makeMatrix）全部移除。全部视觉走 `--dsw-*` 令牌零新增硬编码色，深色随 §8.7 自动适配；
  设置面板加「服务」/「界面」分组（11px/500 caption 组标题，actions 仍在分组外底部），
  **M6 主题引擎/镜像/外观行逻辑零改动**（另：设置齿轮补齐内圈 path——webui bundle
  `IconSettingsOutline16` 的 `<g>` 含外圈+内圈环两个 path，此前只内联外圈致「只有外圈没内圈」，
  已从 `dsh-web-frontend/dist/assets/index-ClqxG24t.js` 补全，与 webui 渲染一致；
  工具栏扩展图标同批修补：透明黑鲸（内容仅 88%×63% 上下留白 37%、无底色，与相邻满铺色块
  图标比显小）→ 品牌深底 #0F1115 圆角 22% + 白色鲸鱼（100%×100% 满铺，webui 深色主题
  白鲸同款；_gen-icons.js 模板加 .bg 层 + 注入 fill 替换，whale.svg 源不变，重新生成已入库））。
  ④ verify-cdp 当前 13 条 M7 验收记录（12 项断言：状态卡结构/文案、状态变体（running 实心
  点呼吸 / external / busy 琥珀脉冲无矩阵 / error 红调卡 / stopped 灰点）、深/浅状态卡背景
  （深=bluish-800 #353638 精确值）、面板呼吸动画、无新增 console 异常；另含 popup-m7.png
  截图存档），全量 **PASS 63 / FAIL 0**；`popup-m7.png`（浅）/ `popup-dark.png`（深）截图
  vision 核验通过。已知遗留（低）：「点击操作的真实 busy 视觉未截图」；深度审核另见盲审报告。
  **M7 修补（2026-08-22，用户实机观察反馈，design §8.8 注记）**：
  ① logs 页状态点原把「页面日志请求在途（2s 自动刷新窗口）」映射为 dot-busy——绿点每 2s 被
  Matrix 替换几十毫秒再恢复（「点阵闪现」），改为状态点只表达 dsh 运行状态（error/running/
  stopped，busy 不再上点）；
  ② 徽标「●」+ 绿底组合渲染混乱（Chrome 自动对比文字色）→ 改「text:'●' + 绿底 #22c55e +
  文字色同底」（隐形文字=纯绿状态块；曾试「无文字+绿底」——**Chrome 徽标空 text 整体不渲染**，
  实机重载后不可见，二次修订；verify 断言 text/bg/fg 三值）；③ popup 打开瞬间初始态（首查前「—」+空行2+「安装插件」提示+按钮可点）
  → hint/行2 中性文案 + 主按钮初始 disabled。注意：**sandbox 拦截 headless Chrome 启动（mojo 管道 0x5），
  运行 verify-cdp 需 danger-full-access 侧挂**（2026-08-22 实测）。
- **M6 完成（2026-08-22：主题与深色模式，design §8.7，verify-cdp 48/48）**：四态主题模型
  （`follow-webui` 默认 / `follow-system` / `light` / `dark`）。① 深色令牌：popup.css /
  logs.css 内联 dsh Web UI 深色主题全量 `--dsw-*`（static/alias/specific，取自
  dsh-client-ui-theme 打包源码；仓库内 `tools/ui-theme/dsw-tokens-dark.css` 存档，改动前
  用提取脚本重跑核对），`body[data-ds-dark-theme]` 渲染标记与 webui 一致；`.btn.primary`
  改 `button-primary-fill`+`label-primary-foreground`（深色=白底深字与 webui 同策略，
  原 brand-primary+bluish-00 深色下会白底白字）、toast/`.error`/`.field-invalid` 深色覆盖、
  `color-scheme: dark`。② `extension/theme.js`（新，popup/logs 共用）：四态白名单解析 +
  body 属性应用 + storage.onChanged / matchMedia 实时自动切换。③ popup 设置面板「外观」行
  （4 个 theme-cube 2×2，复刻 webui AppearanceRow 视觉，点选即生效；保存其它设置保留主题；
  **三态图标为 webui bundle 原样提取**：IconLightOutline16 / IconDarkOutline16 /
  IconFollowsystemOutline16——变更时用括号平衡提取器从 dist/assets/index-*.js 抽同名变量
  定义，勿自绘近似；跟随 Web UI 用鲸鱼剪影）。
  ④ 面板：CSS 变量继承天然跟随（零逻辑），MutationObserver 观察 `body[data-ds-dark-theme]`
  → storage 镜像 `webuiTheme`（幂等含 port/at），popup/logs 跟随 webui **实际渲染态**（只读
  镜像、不回写 webui 偏好），webui 未开时回退系统主题。⑤ verify-cdp 新增 15 项主题断言
  （面板深色跟随/镜像写入/popup 四态+Emulation 系统模拟/无新增 console 异常），全量
  PASS 50 / FAIL 0（**含盲审修复后的 2 条防回归断言**：浅色选中态背景渲染、外观行键盘导航）；
  popup-dark/light 双截图 vision 核验通过。盲审修复（2026-08-22）：浅色 :root 补
  `--dsw-alias-bg-module-platform`（此前 theme-cube 选中态浅色下无背景）、panel.js
  镜像加 `contextAlive()` 前置 + 失效 disconnect、外观行补 radiogroup roving tabindex +
  方向键、popup/logs :root 定义 `--dsw-shadow-lv1/2`。注意：**sandbox 拦截 headless
  Chrome 启动（mojo 管道 0x5），运行 verify-cdp 需 danger-full-access 侧挂**（2026-08-22 实测）。
  已知遗留（低）：verify-cdp 主题段有多处固定 sleep 与「SW 不在线即失败」判定，
  盲审标注为潜在 flaky 源，两轮全量实跑稳定，待后续改用 waitFor 轮询 + SW 离线 SKIP。
- **M1 完成**：冒烟 38/38 通过，真机可用
- **M1.1 完成（外部实例检测）**：冒烟 57/57 通过。status 无 run 记录时自动发现外部 dsh web（进程枚举 powershell → 命令行解析 `--port` → netstat 端口表回退 → `GET /` 指纹 `DeepSeek Harness`），`external` 状态展示 + 打开 UI；stop/restart 返回 `EXTERNAL_UNMANAGED`；测试钩子 `DSH_MANAGER_FAKE_PROCESSES`/`DSH_MANAGER_FAKE_LISTENERS`
- **M1.2 完成（外部实例接管 + Web UI 同款视觉）**：冒烟 70/70 通过。`adopt` 动作（pid+port 双重匹配 → 解析原命令行 → 回写 run 记录 `adopted:true`），接管后 stop/restart 可用，restart 按原 argv 归一化重放且血统延续（跳过 §12.1 白名单，参数源自本机进程表）；popup 重设计为 dsh Web UI 同款设计令牌（`--dsw-*` 浅色主题，令牌值取自 dsh Web UI 存档），鲸鱼 logo 与设置齿轮图标从同一存档原样内联
- **M1.3 完成（鲸鱼图标 + 点击反馈/动效）**：扩展图标 16/48/128 由占位「蓝底 D」替换为与 Web UI 同源的鲸鱼图形（透明底黑鲸，`tools/icons/_gen-icons.js` 用 headless Chrome 4x 超采样渲染，需沙箱外/提权运行）；popup 增加操作乐观反馈（点击即按钮禁用+转圈+不定进度条+阶段文案+耗时）、完成/失败 toast 确认（重启三阶段可见：停止旧进程 → 新进程启动中 → 就绪）、按钮按压/面板淡入/圆点颜色过渡动效（`prefers-reduced-motion` 关闭）；SW native 兜底超时按 action 区分（restart 120s），修复长 restart 被 30s 误判 NATIVE_ERROR；操作在途暂停轮询避免 SW 队列堆积
- **M2 完成（dsh-lifecycle 优雅停机 + 点击反馈举一反三）**：冒烟 94/94 + 插件单测 18/18。`plugin/dsh-lifecycle`：POST `/_lifecycle/shutdown`（注入 `webServer`/`appExit`，回环+Origin 围栏）+ GET `/_lifecycle/health`；**实测发现并修正挂载机制**——`dsh plugin add` 是 pnpm 转发器，包必须带 `dsh.bundle.patch` + `cordis.patch.yml`（`- insert: [{id,name}]`）才真正挂载，README 给出实测安装命令。宿主 stop 先探 health 判定插件可用再优雅停（3s 内端口关闭 → `stopMethod:'graceful'`，否则 taskkill → `'force'`）；status 附 `lifecycle`/`health` 富状态（不作存活判定依据）。popup：手动刷新按钮、设置无效输入红框+抖动+聚焦、复制失败 toast、状态漂移通知（去重）、hint 动态化、健康富状态、stopMethod toast。smoke `BASE_ENV` 默认围栏真实进程枚举（否则「空目录→stopped」误报 external）
- 已知遗留：**外部发现生产路径已沙箱内实测通过**（smoke-real 新增只读段：真实 powershell/netstat 枚举检测到本会话 harness 8080 → external，stop 被 `EXTERNAL_UNMANAGED` 拒绝）；**接管（adopt）生产路径仍不自动实测**（会写 run 记录并获停真实实例能力，按 manual-e2e.md 步骤 9 用一次性实例沙箱外验证）；start 返回语义的文档矛盾已解决（§8.3/§9.1 已与 §6.3 实现对齐）；**pnpm Windows 跨盘符缺陷**（仓库与 profile 不同盘时 `dsh plugin add` 装出坏 junction/ENOENT，插件安装须走「复制到 `.dsh\plugins` + 相对 link」方式，见 plugin/README 与 manual-e2e.md 步骤 12.1）；插件真机预检已跑通（临时实例：health 200 + 优雅停 202 后端口关闭）；**dsh 命令执行闪窗已由 M5.5 隐藏控制台载体消除**（Windows；上游若修复受限令牌限制可移除载体回归直接 spawn）
- **M4 部分完成（2026-08-14：--port 0 动态端口 + Firefox 宿主注册 + Linux 实测通过；2026-08-15 移除「显示 dsh 控制台窗口」设置；本节数字为 M4 完成时点快照，最新口径见顶部常用命令）**：冒烟 25 场景（Windows 338 PASS+2 SKIP / Linux 337 PASS）。① `--port 0`：start 以动态端口拉起 dsh → 从日志（`logStartBytes` 偏移之后）解析 `dsh web:` URL 行回填 run 记录实际端口（回填前 status 报 `port:null`+`requestedPort:0`+`starting` 且可自愈回填）；restart 按动态端口语义重放；payload 放宽为 0-65535；popup 设置 0=自动、徽标改经 native status。**smoke-real 真机段对真实 dsh 0.1.0-rc.6 实测通过**（端口 58230 回填 + 停止全链路）。② Firefox（Windows）：manifest 声明 `browser_specific_settings.gecko.id`（`dsh-manager@local`）；install.ps1 解析 gecko id 写入宿主清单 `allowed_extensions`（Chrome ID + gecko ID），注册表新增 Mozilla 项（uninstall 同步清理）；smoke 静态断言 gecko id/模板一致；**扩展在 Firefox 中的运行时行为未实测**（本机无 Firefox）。③ **Linux（M4 平台层，design §6.8）已实测通过——Kali WSL（WSL2）全量冒烟 337/337**：host.js POSIX 分支（`~/.config` 状态目录、SIGTERM 进程组→SIGKILL 终止、零依赖 /proc 枚举 + /proc/net/tcp 端口表 + /proc PID 校验）；**smoke 场景 26（POSIX 专属）不注入任何 fake 钩子**走真实平台路径完成外部实例发现/接管/停止全链路；`BASE_ENV` 进程枚举围栏改为仅 Windows 生效（Linux 无围栏让真实 /proc 参与冒烟）；`tools/linux/`（`verify-linux.ps1` + `run-smoke-linux.sh`，自动准备便携 Node 22.16.0，幂等）。④ **Linux 安装器（install.sh/uninstall.sh）真实安装 E2E 15/15 通过**（`tools/linux/run-e2e-linux.sh`：Kali 内 npm i -g 真实 dsh 0.1.0-rc.6 → install.sh 安装 + 四浏览器用户级注册 + 清单断言 → 经已安装 host.sh 拉起真实 dsh start/status/指纹/stop → uninstall.sh 清理；顺带修复 resolveDshBin 两处 POSIX 缺陷：npm `prefix/lib/node_modules` 布局与 `command -v` 改经 sh 内建）。⑤ **「显示 dsh 控制台窗口」设置项与协议字段 `windowsHide` 已移除（2026-08-15 实测核验）**：Node `detached:true` 在 Windows 下由 libuv 无条件加 `DETACHED_PROCESS`（子进程既不继承也不新建控制台），`windowsHide` 不产生实际差异——两种状态均无常驻控制台窗口、命令执行均闪现临时终端窗口（上游受限令牌限制）；popup 改为灰字如实说明，design §6.3 第 5 步同步修订，原 smoke 场景 27 移除（编号复用于 M5.5 载体链路测试）。注意：install.ps1/uninstall.ps1 为 UTF-8 **带 BOM**（Windows PowerShell 5.1 解析中文需要，编辑工具改写后必须补回 BOM）；E2E 内 curl 用 `--noproxy '*'`（WSL 透传 Windows http_proxy 会误判端口状态）。剩余 M4：仅 macOS（`ps`/`lsof`/`~/Library` 与 install.sh 的 `uname` 分支已实现未实测，无 macOS 设备）。
- **M5.5 完成（2026-08-15：Windows 隐藏控制台载体）**：消除 dsh 命令执行闪窗——host.js
  Windows 分支经 `launch-hidden.vbs`（BASE_DIR 运行时自生成）+ wscript `Run(cmd,0,False)`
  以 SW_HIDE 拉起 dsh：dsh 有控制台（命令子进程继承、不再闪窗）但窗口从不显示；命令经
  `DSH_MANAGER_LAUNCH_CMD` 环境变量传递并显式 `cmd /d /c call` 执行（WshShell.Run 对引号
  开头命令直接 CreateProcess 会丢失重定向）；`1>> 日志 2>&1` 保住日志页与动态端口解析；
  run 记录 pid 端口就绪后经 netstat 反查（`findPidByPort`），START_TIMEOUT 尽力回写；
  POSIX 维持直接 spawn。实测：真实 dsh 载体启动窗口不可见、停止无孤儿；冒烟场景 27
  （Windows）新增，全量 PASS 347/348。
- **M3.1 完成（2026-08-16：页面内管理面板体验修复，verify-cdp 33/33）**：① 修复
  「扩展重载/更新后旧面板永久红灯『状态获取失败』直到刷新页面」——已 CDP 实测复现
  （重载扩展 → 红错；刷新 → 恢复）：旧内容脚本上下文失效（`chrome.runtime.id` 为空）
  时停止轮询并提示「扩展已重载或更新，请刷新页面恢复」（中性灰，徽章「已断开」）；
  单次 status 失败不再立即红（连续 3 次约 6s 才显示错误态，吸收 MV3 SW 休眠/唤醒
  竞态，期间保留上次成功状态）。② 圆点颜色改随展示语义：绿=本页托管运行中、蓝=
  外部实例、灰=未托管/已停止、琥珀=过渡、红=连续失败（此前「未托管」页面误显绿灯）。
  ③ 展开面板不再顶动胶囊：面板体绝对定位在胶囊上方弹出（此前 body 流内布局把胶囊
  向上顶起）。verify-cdp 新增 5 条回归断言（托管绿点+端口显示、展开时胶囊位置不变、
  面板在胶囊上方、扩展重载后提示刷新非红错、刷新页面后恢复托管状态），全量 PASS 33 /
  FAIL 0；design §8.6 同步修订。
- M4 跨平台/Firefox（`--port 0` 已支持）→ M5 上游反馈（**官方暂不接受外部 PR**（2026-08-13 公告），走 GitHub Discussions 与插件生态；**Discussions 帖子草稿已备好**：`docs/upstream-feedback.md`，需用户 GitHub 账号发布并回填链接；若开放 PR 再提 lifecycle 子命令）
- **M3 完成（2026-08-14）**：冒烟 324/324 + verify-cdp 28/28。① 日志查看：宿主只读 `logs` 动作（design §6.3：`tailLines`/`maxBytes`/`beforeByte` 分页，UTF-8 字节精确 + 行边界对齐，块间严格衔接；修复行边界误删首行与尾部截断多删一行两个缺陷）+ 扩展日志查看页 `logs.html/js/css`（design §8.4：2s 自动刷新、贴底跟随、加载更早、复制全部、错误横幅，textContent 渲染）+ popup「查看日志」入口。② 页面内管理面板：`content/panel.js`（design §8.6，**content script 方案替代 dsh client 插件**——实测核验外部插件无独立构建路径，见 §8.6 决策）：dsh 指纹页面右下角注入 shadow 面板（状态徽章 + 展开后停止两步确认/重启，全部动作经 SW → 宿主全套防护）。③ UI 自动验收 `tools/verify-ui`：`verify-cdp.js` 零依赖 CDP（headless Chrome + `Extensions.loadUnpacked`，沙箱内实测 28/28：popup/logs/面板注入与展开断言 + 面板停止两步确认态（首击确认/3s 还原，不执行）+ 日志页「加载更早/复制全部」交互 + popup 设置校验交互 + 徽标三步实测（附加扩展 SW）+ console 检查，视觉核验经 vision 工具确认）；`verify-ui.js` 为 chrome-devtools-mcp 路径（stdio 传输被沙箱拦管道，需沙箱外，版本钉 1.7.0）。
- **开源前审查与修复已完成**（含 5 项阻断发现与处理状态）：① 本机用户名/绝对路径已去个人化（`<user>` / `<repo-root>` 占位、tools 用 `__dirname` 推导）；② `.reg` 现场产物不入库（`.gitignore`）；③ 鲸鱼 logo 品牌风险 → README 免责声明 + NOTICE 声明（logo 替换计划中）；④ `appExit` 语义措辞校正（优雅 dispose 请求，退出依赖事件循环排空，宿主以端口关闭为权威）；⑤ 插件 HTTP 围栏已补 `sec-fetch-site` 校验并增 shutdown 幂等（409）——插件单测 21/21 通过。另：宿主测试钩子门控（`DSH_MANAGER_TEST_MODE=1`）、adopt 重放危险参数过滤、install/uninstall 加固（JSON 转义、PID 命令行校验）、冒烟增至 95 断言（94 PASS + 1 环境 SKIP）。
- **外部网络核查完成（2026-08-14）**：npm `latest` = `0.1.0-rc.6`（无正式版，事实基线成立）；GitHub 无 releases；根 LICENSE 逐字核对 MIT（Copyright (c) 2026 DeepSeek）；官方 docs/ 确认 `ctx.web`/`ctx.webServer` 为文档化 seam/core、provider 生态含 `web-search-perplexity`、`appExit` 仅包级 README 文档化；官方品牌资产位于 `apps/web/public/favicon.svg`（NOTICE 已更新溯源）。结论已写入 design.md §2 在线复核注记。
