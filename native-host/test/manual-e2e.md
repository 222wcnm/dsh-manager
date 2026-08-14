# DSH Manager — 人工端到端验收清单（沙箱外）

本文档供在真实 Windows 10/11 + Chrome/Edge 环境中人工验证 DSH Manager 使用。沙箱内自动冒烟结果见 [VERIFICATION.md](VERIFICATION.md)；以下步骤覆盖自动测试无法覆盖的浏览器与注册表路径。

> 前置条件：Node.js ≥ 18；已全局安装 dsh（`npm i -g @deepseek-ai/dsh`）；本机为 Windows。
> 全程建议开一个管理员无关的普通 PowerShell 窗口，并在每一步记录输出。

---

## 0. 自检（2 分钟）

```powershell
node -v                                    # ≥ 18
dsh --version                              # 应输出包版本
Get-Command dsh | Select-Object Source     # 应位于 %APPDATA%\npm\dsh*
node <repo-root>\native-host\compute-id.js
# 输出扩展 ID：dahcfklamlpgkngijomlnoclclfodkjm
Get-Content <repo-root>\EXTENSION_ID.txt
# 应与上一步一致
```

**通过标准**：dsh 可执行、扩展 ID 一致（`dahcfklamlpgkngijomlnoclclfodkjm`）。

---

## 1. 安装（≤ 2 分钟）

```powershell
cd <repo-root>
# 1a. 预演（只打印，不写任何东西）：
powershell -ExecutionPolicy Bypass -File .\native-host\install.ps1 -DryRun

# 1b. 正式安装：
powershell -ExecutionPolicy Bypass -File .\native-host\install.ps1
```

**通过标准**：

```powershell
# 注册表两项存在，默认值指向宿主清单：
reg query HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dsh.manager
reg query HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.dsh.manager
# 宿主清单内容正确（allowed_origins 含扩展 ID）：
Get-Content "$env:LOCALAPPDATA\dsh-manager\host\com.dsh.manager.json"
# 数据目录就绪：
Get-ChildItem "$env:LOCALAPPDATA\dsh-manager"   # 应有 host\ run\ logs\
# host.cmd 内容为：@echo off + "<node.exe>" "<...\host.js>" %*
Get-Content "$env:LOCALAPPDATA\dsh-manager\host\host.cmd"
```

若注册表写入被安全软件拦截：双击 `native-host\com.dsh.manager.reg` 手动导入后重跑。

---

## 2. 加载扩展

1. 打开 `chrome://extensions`（或 `edge://extensions`）。
2. 开启右上角「开发者模式」→「加载已解压的扩展程序」→ 选择 `<repo-root>\extension`。
3. **完全退出并重新启动浏览器**（Native Messaging 宿主注册变更必须重启才生效）。
4. 确认扩展 ID 显示为 `dahcfklamlpgkngijomlnoclclfodkjm`（若不一致，说明 key 与清单不匹配，停止并排查）。

**通过标准**：扩展图标出现在工具栏；无加载错误。

---

## 3. 首次状态验证（HOST_NOT_INSTALLED 分支）

1. 点击扩展图标打开 popup。
2. 预期显示：**stopped**（灰点），三个按钮中「启动」可用。
3. 若显示「未安装宿主（HOST_NOT_INSTALLED）」：回步骤 1 检查注册表与 manifest，然后**再次完全重启浏览器**。

**通过标准**：显示 stopped 而非 HOST_NOT_INSTALLED。

---

## 4. 启动（核心体验）

> **动态端口变体（M4）**：popup 设置端口填 `0` 保存 → 启动 → 状态收敛 running 且
> URL 行显示实际分配的端口（宿主从日志回填）；重启后端口重新分配；徽标仍显示绿点。

1. popup 点击「启动」。
2. 预期：按钮变「启动中…」→ 状态 starting（黄点）→ running（绿点）；若设置中「自动打开 Web UI」开启，则自动打开 `http://127.0.0.1:3080/` 新标签页且页面可交互。
3. 命令行复核：

```powershell
Get-NetTCPConnection -LocalPort 3080 | Select-Object State,OwningProcess
Get-Content "$env:LOCALAPPDATA\dsh-manager\run\dsh-web.json"   # pid/port/profile/cmdline
Get-Content "$env:LOCALAPPDATA\dsh-manager\run\dsh-web.pid"    # 纯文本 pid
# 日志在持续写入：
Get-Content "$env:LOCALAPPDATA\dsh-manager\logs\dsh-web.log" -Tail 10
```

**通过标准**：popup 绿点 + PID/URL 显示正确；端口 3080 被 dsh 的 node 进程监听；run 记录与日志存在。启动到 UI 打开 ≤ 15s（含 dsh 冷启动）。

---

## 5. 宿主死亡实验（dsh 独立存活）

1. 找到宿主进程（其命令行含 `host.js`）：`Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object CommandLine -like '*host.js*'`（宿主短命，通常已随请求退出——若找不到属正常）。
2. 若宿主仍在，`taskkill /PID <宿主pid> /T /F` 强杀宿主。
3. 等 2s 后再次打开 popup → **状态仍为 running**（dsh 由 detached 进程独立运行，不受宿主生死影响）。
4. `Get-Process -Id <run记录的pid>` 确认 dsh 进程仍在。

**通过标准**：宿主死亡不影响 dsh；popup status 自动收敛为真实状态。

---

## 6. SW 回收实验

1. 打开 `chrome://serviceworker-internals`，找到 DSH Manager 的 service worker，点「Stop」。
2. 等待 ≥ 10s（让 SW 完全回收），再次点击扩展图标。
3. popup 应正确显示 running（重新发起 status 收敛，无残留状态）。

**通过标准**：SW 回收后无僵尸宿主、无错误状态；徽标恢复正确（绿点 = running）。

---

## 7. 重启

1. popup 点击「重启」。
2. 预期：先 stopped（黄点）→ 自动重新 running（绿点），自动打开 UI 行为同启动。
3. 复核 `run\dsh-web.json` 的 **pid 已变化**；旧进程已不存在。

**通过标准**：restart 后 running，pid 变化，端口 3080 重新监听。

---

## 8. 停止

1. popup 点击「停止」。
2. 预期：状态 → stopped（灰点），URL 行消失。
3. 复核：

```powershell
Get-NetTCPConnection -LocalPort 3080 -ErrorAction SilentlyContinue   # 无输出 = 端口关闭
Test-Path "$env:LOCALAPPDATA\dsh-manager\run\dsh-web.json"           # False = 记录清除
# 无 dsh 残留进程：
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*@deepseek-ai*dsh*'
```

4. 若安装了 M2 的 dsh-lifecycle 插件，`logs\dsh-web.log` 中应出现 dispose 相关日志（优雅停机，无 taskkill 调用）；未装插件时为 taskkill 强制停止（正常路径）。

**通过标准**：stopped、端口关闭、run 记录清除、系统内无本项目与 dsh 的任何驻留进程（核心验收 §14.3）。

---

## 9. 外部实例检测（M1.1）

验证扩展能发现「不是由本扩展启动」的 dsh web 及其端口（design §6.6）。

1. 在终端手工启动一个不同端口的 dsh web：

```powershell
dsh web --port 4080
# 或动态端口：dsh web --port 0（启动日志会打印实际端口，如 http://127.0.0.1:XXXXX）
```

2. 打开 popup（此时扩展没有任何 run 记录）：
   - 预期：**蓝点** + `external` 状态；URL 行显示 `http://127.0.0.1:4080`（`--port 0` 时显示实际端口）；明细行显示外部实例 PID 与「外部启动，接管后由扩展管理」。
   - 「接管」与「打开 Web UI」可用；「启动 / 停止 / 重启」按钮禁用。
3. 安全边界复核：
   - 向宿主直发 `{"action":"stop"}`（可用文件模式 `node host.js --req stop.json --res out.json`）→ 应返回 `EXTERNAL_UNMANAGED`，dsh 进程不受影响。
   - 设置端口为 4080 后点「启动」→ PORT_BUSY 文案应提示「端口 4080 已有一个正在运行的 dsh web（外部启动，非本扩展管理）…」。
4. 接管（M1.2）：
   - 点「接管」→ popup 变 running/managed，按钮恢复「启动/停止/重启」三键；`run\dsh-web.json` 出现且 `pid` 为外部实例 pid、`adopted:true`。
   - 点「停止」→ 实例停止、记录清除；再点「启动」→ 按接管参数（profile/端口/原 argv）重放启动。
5. 多实例：再开一个 `dsh web --port 4081` → popup 明细行出现「共 2 个外部实例」；接管其一后其余实例待其停止后再次发现。
6. 清理：在各自终端 Ctrl+C 关闭实例 → popup 状态回到 stopped。

**通过标准**：外部实例被识别且端口/URL 正确；未接管前 stop/restart 被拒；接管后全生命周期可用且重启按原参数重放；实例退出后状态收敛。

---

## 10. 异常矩阵（各 1 次）

| 场景 | 操作 | 预期 |
|------|------|------|
| 端口占用 | 先 `netstat -ano` 确认 3080 被占（或用 `node -e "require('net').createServer().listen(3080)"` 占住），再点「启动」 | popup 显示 PORT_BUSY 文案；错误面板出现，可「复制日志」 |
| 快速连点启动 | running 状态下连点「启动」多次 | 幂等：不报错、不双开（ALREADY_RUNNING 视为成功） |
| 快速连点停止 | stopped 状态下连点「停止」 | ALREADY_STOPPED，幂等无副作用 |
| 设置换端口 | 设置中把端口改为 3090 保存 → 启动 | 监听 3090；URL 行显示 3090 |
| 非法 host | 手动向宿主发 `{"action":"start","payload":{"host":"0.0.0.0"}}`（可用 `node -e` 管道） | BAD_REQUEST |
| 徽标 | running 时观察工具栏图标 | 绿点徽标；停止后徽标消失 |

---

## 11. 卸载

```powershell
cd <repo-root>
# 10a. 保留日志先备份到桌面：
powershell -ExecutionPolicy Bypass -File .\native-host\uninstall.ps1 -KeepLogs
# 10b. 或直接卸载（日志随目录删除）：
powershell -ExecutionPolicy Bypass -File .\native-host\uninstall.ps1
```

**通过标准**：

```powershell
# 注册表项已删除：
reg query HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dsh.manager   # 应报"找不到"
reg query HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.dsh.manager
# 数据目录已删除：
Test-Path "$env:LOCALAPPDATA\dsh-manager"   # False
# （-KeepLogs 时）桌面存在 dsh-manager-logs-<时间戳> 备份
```

10c. 清理：在 `chrome://extensions` 移除 DSH Manager 扩展（可选保留）。

---

## 12. M2：优雅停机插件与点击反馈（dsh-lifecycle）

### 12.1 安装插件（实测语法，dsh ≥ 0.1.0-rc.6）

> ⚠️ **Windows 跨盘符陷阱（2026-08-14 实测）**：仓库（D:\）与 profile（C:\）不同盘时，
> pnpm v10 会把 `D:\...` 当相对路径处理（`link:` 装出坏 junction、`file:`/`file:///` 直接
> ENOENT），`dsh plugin --profile web add ./plugin/dsh-lifecycle` **不可用**（reconcile 报
> `declares no dsh.bundle`）。同盘符时该命令可直接用（仓库根执行）。跨盘符用下面的
> 「复制 + 相对 link」方式（与 vision-toolkit 同款，本机已验证）：

```powershell
# 方式 A（本机验证通过）：复制到 .dsh\plugins + 相对路径 link
Copy-Item -Recurse -Force <repo-root>\plugin\dsh-lifecycle `
  "$env:USERPROFILE\.dsh\plugins\dsh-lifecycle"
Set-Location "$env:USERPROFILE\.dsh\profiles\web"
pnpm add link:..\..\plugins\dsh-lifecycle
dsh plugin --profile web install        # reconcile → dsh.profile.bundles

# 确认挂载：dependencies 与 dsh.profile.bundles 均含 dsh-lifecycle
Get-Content "$env:USERPROFILE\.dsh\profiles\web\package.json"
```

> 方法 B（手工挂载，不装依赖）：在 `$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml` 覆盖层追加
> `- insert: [{ id: dsh-lifecycle, name: 'dsh-lifecycle' }]`（或绝对路径），见
> `plugin/dsh-lifecycle/README.md`。
>
> 一次性真机预检（2026-08-14 已跑通）：临时实例 `dsh web --port 31930` → health 200、
> `POST /_lifecycle/shutdown` 202 后 0.5s 端口关闭、进程退出码 0 —— 插件在真实 dsh 上可用。

### 12.2 优雅停验证

1. popup 启动 dsh → 明细行出现「健康：… · node v…」，底部提示「优雅停机已启用（dsh-lifecycle）」。
2. popup 点「停止」→ toast「已优雅停止」；`logs\dsh-web.log` 有 dispose 痕迹、无 taskkill 调用；`Get-NetTCPConnection -LocalPort 3080` 无监听。
3. 卸载/移除插件（`dsh plugin --profile web remove dsh-lifecycle` 或去掉挂载行）并重启 dsh → 底部提示回到「安装 dsh-lifecycle 插件可优雅停机」；点「停止」→ toast「已强制停止（未检测到插件或优雅停止超时）」，日志无优雅停痕迹。

**通过标准**：优雅/强制两条路径的 toast、hint、日志与 `stopMethod` 一致。

### 12.3 点击反馈清单（M1.3/M2）

| 交互 | 预期反馈 |
|------|----------|
| 点「启动/停止/重启/接管」 | 按钮立即禁用+转圈+「…中」，进度条+阶段文案+耗时；完成后对应 toast（重启三阶段：停止旧进程 → 新进程启动中 → 重启完成） |
| 点「刷新」 | 按钮转圈禁用，status 返回后恢复 |
| 设置保存无效输入 | 红边框 + 抖动 + 聚焦 + 错误行 |
| 设置保存成功 / 复制日志 | 「设置已保存」/「日志已复制」toast；复制失败弹错误 toast |
| 外部实例出现/退出、意外停止、错误恢复 | 对应漂移 toast（info） |

**通过标准**：上述反馈逐项出现且不重复刷屏；`prefers-reduced-motion` 下动画收敛。

---

## 13. M3：日志查看页（logs.html）

> **可自动验收**：`node tools/verify-ui/verify-cdp.js` 已在沙箱内实测覆盖本步骤的
> 1/2/5/6/7 项（页面加载、状态圆点、日志底栏、「加载更早」反馈、「复制全部」toast、
> 错误横幅/底栏 + 截图 + 文本断言 + console 异常检查），人工只需补 3/4/8 的
> 动态行为项（自动刷新跟随、贴底保持、宿主缺失横幅）。完整交互流可用
> `tools/verify-ui/verify-ui.js`（chrome-devtools-mcp，沙箱外）扩展。

1. 启动 dsh（popup）→ 点 popup 底部「查看日志」→ 新标签页打开扩展日志页。
2. 页面显示 dsh 启动日志尾部，底部状态行显示文件路径/大小/已加载行数；圆点为绿色（running）。
3. 「自动刷新」默认开：终端里再跑一次 `dsh --version`（或操作 dsh 产生新日志）→ 2 秒内页面尾部出现新行，且滚动停留在底部。
4. 向上滚动离开底部 → 新日志到达时**不**被拽回底部；回到底部后恢复跟随。
5. 点「加载更早」→ 更早的历史日志被加载、自动刷新自动关闭并 toast 提示；连续点直至「已到日志开头」。
6. 点「复制全部」→ 剪贴板包含已加载全部日志行，toast 显示行数。
7. 停止 dsh → 圆点变灰；「刷新」仍能读取历史日志。
8. 卸载宿主（uninstall.ps1）后打开日志页 → 错误横幅「未安装宿主…」+ 重试按钮。

**通过标准**：以上行为逐项符合；日志内容与 `%LOCALAPPDATA%\dsh-manager\logs\dsh-web.log` 一致（含中文不乱码）。

---

## 14. M3：页面内管理面板（content script）

> **可自动验收**：`node tools/verify-ui/verify-cdp.js` 已覆盖「注入 + 徽章/状态文本 +
> 展开后停止/重启按钮可用」断言与截图（16 断言）；人工只需补交互项（3-5）。

1. 打开 dsh Web UI（任意端口）→ 右下角出现「dsh web · <端口>」徽章，圆点颜色随状态（绿 = 运行中）。
2. 点击徽章展开面板：状态行「运行中 · 端口 X · 健康」（插件安装时）；「停止」红字、「重启」描边，均可用。
3. 点「停止」→ 按钮变「确认停止」（红色实底），3 秒不确认自动还原；再点确认 → 面板显示「正在停止…」，随后 dsh 页面断开。
4. dsh 停止后重新打开任意 dsh 页面（如 popup 重启后）→ 面板显示「已停止」，「重启」可用（等价启动）。
5. 点「重启」→ 面板显示「正在重启：停止旧进程 → 新进程启动中…」，就绪后回到「运行中」。
6. 打开任意**非 dsh** 的本地页面（如其他本地服务）→ 不出现面板。
7. 面板不应遮挡/改动页面原有元素（shadow 隔离），`prefers-reduced-motion` 下动画收敛。

**通过标准**：1-7 逐项符合；停止/重启走宿主全套防护（优雅停优先、PID 校验），面板自身不直连 /_lifecycle。

---

## 验收汇总表

| # | 验收点 | 步骤 | 通过标准 |
|---|--------|------|----------|
| 1 | 安装 | 1 | 注册表 2 项 + manifest + host.cmd + 目录齐全 |
| 2 | 扩展 ID 一致性 | 0/2 | 扩展页 ID = EXTENSION_ID.txt |
| 3 | popup stopped | 3 | 非 HOST_NOT_INSTALLED |
| 4 | 一键启动 | 4 | ≤15s 到 UI；running + 徽标绿 |
| 5 | 宿主死亡 | 5 | dsh 独立存活，status 收敛 |
| 6 | SW 回收 | 6 | 无僵尸、状态正确 |
| 7 | 重启 | 7 | running，pid 变化 |
| 8 | 停止零残留 | 8 | 端口关、记录清、无进程 |
| 9 | 外部实例检测 | 9 | external 识别端口/URL 正确；stop/restart 被拒；打开 UI 可用 |
| 10 | 异常矩阵 | 10 | 各场景文案与幂等 |
| 11 | 卸载 | 11 | 注册表/目录清除，日志可选备份 |
| 12 | M2 优雅停 + 点击反馈 | 12 | 优雅停 toast/日志；降级 force；反馈清单逐项符合 |
| 13 | M3 日志查看页 | 13 | 尾部/翻页/自动刷新/复制/错误横幅逐项符合，内容与日志文件一致 |
| 14 | M3 页面内管理面板 | 14 | 注入/状态/两步确认停止/重启/非 dsh 页面不注入，全部经宿主防护 |
