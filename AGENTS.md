# AGENTS.md — DSH Manager

浏览器扩展 + Native Messaging 宿主，管理 DeepSeek Harness（dsh）web 服务生命周期：浏览器一键启动/停止/重启 `dsh web`（默认 http://127.0.0.1:3080），免开终端。

## 权威文档（改动前必读）

- `docs/design.md` — 唯一规格：架构、宿主协议（§6）、安全模型（§12）、路线图（§15）；基于 @deepseek-ai/dsh@0.1.0-rc.6 逐条核验的事实基线（§2）
- `native-host/test/VERIFICATION.md` — M1 验收报告与已知偏差清单
- `native-host/test/manual-e2e.md` — 人工验证步骤

**约定：重大改动先改 design.md 再改代码；扩展与宿主间的协议变更必须同步 §6.2 与两处实现；改 host.js 必须补跑/新增 smoke 场景。**

## 目录

- `extension/` — Chrome MV3 扩展，原生 JS 零依赖（manifest.json 含固定 key → 扩展 ID `dahcfklamlpgkngijomlnoclclfodkjm`；background.js 串行 native 调用+徽标；popup.*；logs.*（M3 日志查看页）；content/panel.js（M3 页面内管理面板，content script + Shadow DOM））
- `native-host/` — `host.js` 零依赖 CJS 宿主（stdio 4 字节帧 + `--req/--res` 文件模式）；`install.ps1`/`uninstall.ps1`（Windows）；`install.sh`/`uninstall.sh`（Linux/macOS，M4，用户级 NativeMessagingHosts 清单）；`test/`（smoke.js、fake-dsh.js、smoke-real.js）
- `plugin/` — M2 起：dsh-lifecycle 插件
- `tools/` — 开发期工具：`visual-audit/`（视觉审计）、`icons/`（图标生成）、`verify-ui/`（扩展 UI 自动验收：`verify-cdp.js` 沙箱内可用零依赖 CDP；`verify-ui.js` MCP 路径需沙箱外）
- `docs/` — 设计文档、接手说明

## 常用命令

```powershell
node --check native-host/host.js                     # 宿主语法检查
node native-host/test/smoke.js                       # 冒烟测试 27 场景（本机：Windows 347 PASS+1 SKIP——场景 26 POSIX；Linux 337 PASS+1 SKIP——场景 27 载体为 Windows 专属；全新克隆：Windows 332 PASS+4 SKIP——3 项本地产物核对跳过；BASE_ENV 进程枚举围栏仅 Windows 生效——场景 26 在 POSIX 不注入任何钩子走真实 /proc 平台层）
node native-host/test/smoke-real.js                  # 真实 dsh 集成（需 DSH_MANAGER_NPM_PREFIX=%APPDATA%\npm）
node --test "plugin\dsh-lifecycle\test\*.test.js"    # dsh-lifecycle 插件单测（21 项）
powershell -ExecutionPolicy Bypass -File native-host\install.ps1 -DryRun   # 安装预演（Windows）
sh native-host/install.sh --dry-run                                          # 安装预演（Linux/macOS）
powershell -ExecutionPolicy Bypass -File tools\linux\verify-linux.ps1 -E2E  # WSL Linux 冒烟 + 真实安装 E2E
node tools/verify-ui/verify-cdp.js                   # 扩展 UI 自动验收 33 断言（沙箱内可用，若沙箱拦 headless Chrome 启动则需沙箱外；popup/logs/面板注入与展开 + 面板停止两步确认态（首击确认/3s 还原，不执行） + 面板体验回归（托管绿点+端口、展开时胶囊位置不变、面板在胶囊上方、扩展重载后旧面板提示刷新/刷新恢复） + 日志页「加载更早/复制全部」交互 + popup 设置校验交互 + 徽标三步实测 + console 异常检查）
node tools/verify-ui/verify-ui.js --list             # MCP 路径诊断（chrome-devtools-mcp，需沙箱外）
```

- 扩展改动 → `chrome://extensions` 重新加载
- 宿主或安装器改动 → 重跑 `install.ps1`，并**完全重启浏览器**（native host 注册只在浏览器启动时读取）

## 环境事实

- Node ≥ 18；dsh 0.1.0-rc.6 全局安装；默认端口 3080
- 宿主安装位置 Windows `%LOCALAPPDATA%\dsh-manager\host\`（host.cmd 内是绝对路径，**项目移动必须重跑 install.ps1**）；注册表 HKCU：Chrome/Edge/Firefox 的 `NativeMessagingHosts\com.dsh.manager`。Linux/macOS 为 `$XDG_CONFIG_HOME/dsh-manager`（或 `~/.config` / `~/Library/Application Support`），install.sh 写四份用户级浏览器清单（google-chrome/chromium/microsoft-edge/.mozilla），无需 sudo
- 宿主测试钩子（环境变量）：`DSH_MANAGER_BASE_DIR`、`DSH_BIN_STUB`、`DSH_MANAGER_NPM_PREFIX`、`DSH_MANAGER_PID_CHECK=0`、`DSH_MANAGER_FAKE_PROCESSES`（JSON `[{pid,cmdline}]`）、`DSH_MANAGER_FAKE_LISTENERS`（JSON `[{pid,addr,port}]`）；仅当 `DSH_MANAGER_TEST_MODE=1` 时生效

## 当前状态与路线

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
