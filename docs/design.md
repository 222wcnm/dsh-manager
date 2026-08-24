# DSH Manager — 浏览器扩展管理 DSH 运行状态 · 详细设计文档

- 版本：0.1.0（M1–M4 已实现）
- 日期：2026-08-14（持续维护）
- 状态：已实现并通过冒烟/UI 验收（§14）；macOS 与 Firefox 运行时待实测（§6.8/§15）
- 目标平台：Windows 10/11 + Chrome / Edge（Linux 平台层与安装器已实测；Firefox/macOS 列为后续）

---

## 1. 背景与目标

DeepSeek Harness（以下简称 dsh，npm 包 `@deepseek-ai/dsh`）的 Web 界面通过
`dsh web` 命令启动，默认监听 `http://127.0.0.1:3080`。目前的使用路径是：

```
打开终端 → 运行 dsh web → 手工打开浏览器 → 访问 Web UI
```

本项目希望反转该流程：

```
浏览器扩展一键启动 dsh → 自动打开 Web UI → 一键停止 / 重启
```

**核心目标**

1. 在浏览器内完成 dsh web 服务的 start / stop / restart / status 全生命周期管理。
2. 无需用户打开终端；无需常驻守护进程（dsh 停止时系统不残留任何本项目的进程）。
3. 状态可视化（图标徽标 + popup 面板），启动成功后一键打开 Web UI。
4. 不修改 dsh 本体即可工作；进程内的优雅停机与健康状态通过**可选 dsh 插件**获得（M2，见 §7）。

**非目标（v1 不做）**

- 多实例并行管理（同一时间只管理一个 web 实例）。
- 通过扩展调用 dsh 的 `/api` 业务接口（受 Origin 信任围栏限制，见 §12.2）。
- 远程（非本机）管理。

---

## 2. 现状核验（事实基线）

以下结论基于本机实际安装的 `@deepseek-ai/dsh@0.1.0-rc.6` 逐条核验，作为设计依据：

> **2026-08-14 在线复核（外部网络已恢复）**：npm `dist-tags.latest` = `0.1.0-rc.6`（无更高版本/正式版）；GitHub 仓库**无 releases**；GitHub 根 `LICENSE` 逐字核对为 MIT License, Copyright (c) 2026 DeepSeek（与本机 npm 包一致）。官方 `docs/` 文档体系存在且持续更新：`capability-seams.md` 将 `ctx.web` 列为官方 seam（provider 生态：`web-search-exa`、`web-search-perplexity`、`web-search-deepseek`、`web-fetch-http`），`ctx.webServer` 列为 core；`web-styling.md` 规范 `--dsw-*` 令牌；`appExit` 的书面文档仅存在于 `dsh-cmdline` 包 README（顶级 docs 未收录）——与 §7.3 的耦合风险结论一致。**本事实基线成立，无需更新。**
> ⚠️ **2026-08-23 基线漂移警示（待全面复核）**：本机 dsh 已升级至 `0.1.1-rc.2`（M9 真实实例 e2e 即基于该版本，§8.10 已注明）——本节基于 0.1.0-rc.6 的核验**已过期**；涉及上游语义/API 的章节待按 0.1.1-rc.2 全量复核后更新（webui 事实基线 §8.9 已另按 0.1.1-rc.2 核验）。

| # | 事实 | 核验来源 | 对设计的影响 |
|---|------|----------|--------------|
| F1 | CLI 入口为 `dsh`（npm 全局 bin，Windows 下有 `dsh` / `dsh.cmd` / `dsh.ps1` 三个 shim），位于 `%APPDATA%\npm` | `package.json` 的 `bin` 字段 | 宿主需正确解析启动命令（见 §6.4） |
| F2 | CLI 仅有 profile 引导（`dsh web` = `dsh --profile web`）、`dsh plugin`、`--dump-config` 三类调用，**没有 start/stop/status 等生命周期子命令** | `lib/bin.js` 源码 | 生命周期必须由本项目实现，产品缺口真实存在 |
| F3 | `dsh web` 支持 `--host <host>`、`--port <port>`（0 = 系统分配）、`--trusted-host <authority...>`；**拒绝 `--host 0.0.0.0`**（安全考虑） | `dsh-web-app/lib/startup.js` | v1 固定端口、固定 `127.0.0.1`，最稳 |
| F4 | 默认端口 **3080**，默认主机 `127.0.0.1`（webserver 行的 fallback：`ctx.webStartup.port ?? 3080`） | `dsh-web-app/cordis.patch.yml` | 扩展默认配置值取 3080 |
| F5 | 启动成功后打印 `dsh web: http://127.0.0.1:<port>` | `dsh-web-app/lib/index.js` | 日志解析可拿到实际端口（为 `--port 0` 预留） |
| F6 | profile 目录：`$DSH_HOME/profiles/<name>/cordis.yml`（本机 `DSH_HOME=C:\Users\<user>\.dsh`）；用户覆盖层是 `cordis.patch.yml` | 本机文件系统 | 宿主必须透传 `DSH_HOME` 环境变量 |
| F7 | 进程退出：`profile-boot` 注册了 SIGINT（exit 130）/ SIGTERM（exit 0）→ 先 dispose 整棵 fiber 树再退出 | `lib/profile-boot-*.js` | POSIX 可优雅停；**Windows 无法从外部触发这两个处理器**（Node 的 `process.kill(pid,'SIGTERM')` 在 Windows 上是 TerminateProcess 硬杀） |
| F8 | 会话持久化：session checkpoint 策略在「模型请求前、工具副作用前」落盘（JSONL 增量写） | `dsh-session-checkpoint-policy` | 硬杀进程最多丢失最后几秒状态，可接受 |
| F9 | `/api/*` 走 RPC 网关，受 trusted-host 围栏保护：Host 头必须为回环/信任域名，且**存在 Origin 头时其 host 必须等于 Host 的 host** | `dsh-client-connection/lib/index.js` | 扩展页面 fetch 会带 `Origin: chrome-extension://<id>`，**必然被围栏拒绝**；健康探测改用 `GET /`（静态 fallback，无围栏） |
| F10 | 设置/凭据类 RPC 额外限定回环同源 | 同上（loopback-gated 列表） | 本项目不应尝试绕过；遵守 dsh 的安全模型 |
| F11 | `dsh --version` 输出包版本（commander `-V`） | `lib/bin.js` | 宿主可做最低版本检查 |
| F12 | 优雅退出出口：`dsh-cmdline` 的 `provideCmdline` 提供 **`appExit` 服务**（= launcher 的 `shutdown` → `fiber.dispose()` → exit）；`webServer` 服务提供 `register({kind:'exact', path, handler})` 路由注册契约 | `dsh-cmdline/lib/index.js`、`dsh-host-webserver/lib/index.js` | 生命周期插件可走官方 dispose 路径（§7）；插件路由不经过 `/api` 围栏，需自管安全 |
| F13 | dsh 是 MIT 协议开源项目（github.com/deepseek-ai/deepseek-harness，根 LICENSE 已逐字核对），插件体系为 Cordis；官方 `docs/` 有 architecture/capability-seams/api-gateway 等文档 | 官方 README / npm / GitHub | 生命周期插件可行（M2）；上游反馈走 GitHub Discussions 与插件生态（**官方暂不接受外部 PR**，2026-08-13 公告） |
| F14 | Web 客户端主题：内置 `light`/`dark` 两主题 + `system` 偏好（默认 system）；偏好持久化于 settings namespace `ui-theme.preference`（**host 用户设置文档，非浏览器 localStorage**）；实际渲染以 `body[data-ds-dark-theme]` 属性标记（浅色无属性）；全部 `--dsw-*` 令牌（static/alias/specific）**浅/深两套**由主题插件经内联 CSS 注入 | `dsh-client-ui-theme/lib/client.js`（打包源码，2026-08 核验） | 扩展深色模式可复刻同一令牌体系与渲染标记（§8.7）；主题偏好不能从浏览器侧直接读取（F9/F10 围栏），扩展走 DOM 镜像 |

---

## 3. 方案选型

### 3.1 为什么必须用 Native Messaging

浏览器扩展运行在受限沙箱中，**没有任何 API 可以启动本地进程**。要执行
`dsh web` 这条命令，只有三种合法途径：

| 方案 | 原理 | 优点 | 缺点 | 结论 |
|------|------|------|------|------|
| **A. Native Messaging 宿主** | 扩展通过 `chrome.runtime.connectNative()` 与注册在本机的宿主进程通信，宿主代为执行命令 | 无常驻进程；dsh 停止时系统零残留；安装即用；跨浏览器标准 | 需要安装器写注册表；宿主开发量略大 | ✅ **采用** |
| B. 常驻本地 supervisor 守护进程 + HTTP | 扩展 fetch 本地 HTTP 服务，由守护进程管理 dsh | 扩展侧代码最简单 | 必须常驻一个进程（自启动/计划任务），恰好违背「不运行命令」的初衷；扩展与守护进程是两个要维护的组件 | 否决 |
| C. 修改 dsh 上游，内置 lifecycle 子命令 | 给 dsh 提 `dsh server start/stop` PR | 最正统 | 依赖上游节奏；且「start」仍需一个前台终端或后台驻留，不能单独解决浏览器一键启动 | 作为长期贡献项，不作为本项目依赖 |

### 3.2 关键技术选型

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 扩展构建方式 | 纯手写 JS（无打包器） | MVP 仅 3 个文件，免构建链；后续若复杂化可迁 WXT（工作目录 `chrome-mcp-server-0.0.6` 即为 WXT 产物参考） |
| 宿主语言 | Node.js（与 dsh 同生态） | 复用本机已装的 Node；无需额外运行时 |
| 宿主生命周期 | **无状态短命进程**（一次连接一个请求/响应） | MV3 service worker 会被回收，长连接必然断；无状态 + pidfile 才是可靠状态源（见 §4.2） |
| 状态存储 | 本机文件（`%LOCALAPPDATA%\dsh-manager\run\`）+ 端口探测 | 不依赖任何驻留进程 |
| dsh 启动方式 | `node.exe + <npm-global>/node_modules/@deepseek-ai/dsh/lib/bin.js`；**Windows 经隐藏控制台载体**（wscript + `Run(cmd,0,False)`，§6.3 第 5 步），POSIX 直接 spawn + 日志文件重定向 | 避免 `.cmd` shim 的 shell 包装与转义问题；stdout/stderr 写入日志文件；隐藏控制台让 dsh 的子进程继承（命令执行不再闪窗）且桌面无常驻窗口（§6.3 第 5 步） |
| 停止方式（v1） | `taskkill /PID <pid> /T /F` | Windows 无法从外部触发 SIGINT 处理器（F7）；数据安全由 F8 兜底 |
| 停止方式（M2，插件存在时） | `dsh-lifecycle` 插件：`POST /_lifecycle/shutdown` → 官方 dispose（F12），失败回退 taskkill | 优雅停机唯一可行路径（§7） |

### 3.3 为什么还要 dsh 插件：双层架构（评审新增）

评审问题：「这个能做成 dsh 插件吗？」答案是**部分能、而且应该**——但要先看清两种运行时各自的能力边界：

| 能力 | dsh 插件（进程内） | 浏览器扩展 + 宿主（进程外） |
|------|--------------------|------------------------------|
| **冷启动**（dsh 未运行时启动它） | ❌ 进程不存在，插件无从运行 | ✅ **唯一可行方案** |
| 优雅停止（官方 dispose 后退出） | ✅ 注入 `appExit`（F12 已核验） | ⚠️ Windows 只能 taskkill 硬杀 |
| 健康/富状态（会话数、作业、token 等） | ✅ 直接读宿主 Cordis 服务 | ⚠️ 仅端口探活 + 读状态文件 |
| 停止后的状态可见性 | ❌ 进程已死 | ✅ 文件 + 端口探测 |
| 浏览器入口 UI（popup、图标徽标） | ❌ | ✅ |
| 重启编排 | ⚠️ 能做但不该做（插件不知道自己的 profile/启动参数，见 §7.5） | ✅ 宿主持有 run 记录 cmdline，天然可重放 |

结论：

1. **「启动」在物理上不可能做成插件**——插件运行在 dsh 进程内部，dsh 没启动时插件不存在。同理，Web UI 的 client 插件（页面内 UI）也救不了：页面 JS 同样无法起本机进程，而且页面本身随进程一起消失。
2. **「优雅停止、健康状态、进程内管理面」非常适合做成插件**——这正是扩展在进程外做不到的部分（F7/F12）。
3. 因此本项目定为**双层正交架构**：浏览器扩展 + 宿主负责「进程不存在时的启动与入口 UI」，`dsh-lifecycle` 插件负责「进程活着时的优雅与状态」，两者相互独立、各自可用（没装插件扩展照常工作，没装扩展插件可被 curl 使用）。
4. 未来增强（v3+）：dsh Web UI 的 client 插件可在页面内加「停止/重启」管理面板，与浏览器扩展互补（页面内操作走 `/_lifecycle/*`）。

---

## 4. 总体架构

```
┌─────────────────────────── 浏览器 (Chrome/Edge) ───────────────────────────┐
│                                                                            │
│  Popup UI (popup.html/js/css)                                              │
│    ├─ 状态徽标/按钮 → chrome.runtime.sendMessage({type:"native", ...})     │
│    ├─ 健康探测 → fetch("http://127.0.0.1:3080/", {timeout})  ← 仅探活      │
│    └─ 打开 Web UI → chrome.tabs.create({url})                              │
│                                                                            │
│  Background Service Worker (background.js)                                 │
│    ├─ 接收 popup 消息，串行化（避免并发 native 连接）                       │
│    ├─ chrome.runtime.connectNative("com.dsh.manager")                      │
│    └─ chrome.alarms 周期刷新图标徽标                                       │
│                                                                            │
└──────────────┬─────────────────────────────────────────────────────────────┘
               │ stdio（4 字节长度前缀 + JSON，小端序）
               ▼
┌─────────────────────────── 本机 (Windows) ────────────────────────────────┐
│                                                                            │
│  Native Messaging Host (native-host/host.js, Node, 短命)                   │
│    ├─ 校验 action 白名单 → 执行一个操作 → 应答 → 随 stdin 关闭退出          │
│    ├─ start:  spawn detached dsh web（日志重定向）→ 写 run 记录 → 轮询端口 │
│    ├─ stop:   (M2 先 POST /_lifecycle/shutdown) → taskkill /T /F → 清理    │
│    └─ status: 读 run 记录 + PID 存活 + HTTP 200 探活；无记录时外部实例发现  │
│                                                                            │
│  状态文件 %LOCALAPPDATA%\dsh-manager\                                       │
│    ├─ run\dsh-web.json        # {pid, port, profile, startedAt, cmdline}   │
│    └─ logs\dsh-web.log        # dsh stdout+stderr（日志查看 + 端口解析）    │
│                                                                            │
│  dsh web 进程（detached，独立于宿主存活）                                    │
│    ├─ 监听 http://127.0.0.1:3080                                           │
│    └─ [可选] dsh-lifecycle 插件：/_lifecycle/shutdown · /_lifecycle/health │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 组件清单

| 组件 | 位置 | 责任 |
|------|------|------|
| 浏览器扩展 | `extension/` | UI、状态展示、发起 native 请求、探活、打开 UI |
| Native 宿主 | `native-host/host.js` | 命令执行、进程管理、状态判定 |
| 安装器 | `native-host/install.ps1`（Windows）/ `install.sh`（Linux/macOS，M4） | 生成宿主 manifest（自动计算扩展 ID）、注册 Native Messaging 宿主（注册表 / 用户级清单文件）、生成宿主配置 |
| 卸载器 | `native-host/uninstall.ps1` / `uninstall.sh` | 停掉 dsh、清理注册表（或浏览器清单）与状态文件 |
| **dsh 生命周期插件** | `plugin/dsh-lifecycle/` | 进程内优雅停机端点 `POST /_lifecycle/shutdown` + 健康端点 `GET /_lifecycle/health`（M2；可选安装，宿主自动降级，§7） |

### 4.2 关键设计原则

1. **宿主不驻留**：Chrome 每次 `connectNative` 拉起一个新宿主进程，处理完一个请求立即应答；stdin EOF（service worker 回收或主动断开）即退出。
2. **dsh 进程必须独立存活**：spawn 时 `detached: true`，宿主退出不影响 dsh。
3. **状态判定每次重新推导**：不信任任何内存缓存，依据 = `run\dsh-web.json`（pidfile 记录）→ PID 存活 → `GET /` 返回 200，三者综合；无有效 run 记录时额外执行外部实例发现（§6.6），检测非本扩展启动的 dsh web 及其端口。
4. **所有变更操作幂等**：start 时已 running 则返回 `ALREADY_RUNNING`；stop 时已 stopped 则返回 `ALREADY_STOPPED`；支持安全重试。
5. **并发防护**：宿主启动时以 `fs.open(lock, 'wx')` 原子抢锁，抢不到重试 3 次（间隔 300ms），再失败返回 `BUSY`。
6. **插件可选、宿主自足**：宿主全部功能不依赖 dsh-lifecycle；插件缺失时 stop 自动降级 taskkill、status 以端口探活为准（health 只作富状态补充，不作存活判定的唯一依据）。

---

## 5. 状态模型

```
                    start ack                端口 200 + PID 存活
   ┌──────────┐ ────────────────▶ ┌────────┐ ─────────────────▶ ┌─────────┐
   │ stopped  │                   │starting│                     │ running │
   └──────────┘ ◀──────────────── └────────┘                     └─────────┘
        ▲          stop ack/timeout           端口关闭             │
        │   ┌────────┐ ◀──────────────────────────────────────────┘
        └───│stopping│                    stop ack / taskkill
            └────────┘

    无 run 记录 + 发现外部 dsh（§6.6）
   ┌──────────┐ ─────────────────▶ ┌──────────┐
   │ stopped  │                    │ external │（展示 + 打开 UI + 接管 §6.7）
   └──────────┘                    └────┬─────┘
                                        │ adopt（§6.7）
                                        ▼
                                   ┌─────────┐
                                   │ running │（source=managed）
                                   └─────────┘
```

| 状态 | 判定条件（宿主 status 动作） | 典型去向 |
|------|------------------------------|----------|
| `stopped` | 无 run 记录且未发现外部实例；或 PID 不存在/已死，端口无应答（清残留） | start |
| `starting` | run 记录存在、PID 存活，但端口无应答（进程仍在加载依赖） | 轮询至 `running`（30s 超时→`error`） |
| `running` | run 记录存在、PID 存活、`GET /` 200 | stop / restart |
| `stopping` | stop 已发出、端口尚未关闭 | 轮询至 `stopped`（10s 超时→强制 taskkill） |
| `external` | 无 run 记录，但发现外部启动的 dsh web 进程（命令行含 dsh bin.js）且端口指纹探测通过（§6.6） | 展示 + 打开 UI + **接管**（adopt → running/managed，§6.7）；直接 stop/restart 返回 `EXTERNAL_UNMANAGED` |
| `error` | 启动超时 / 端口被占 / dsh 未安装 / 宿主执行异常 | 展示原因与日志尾部 |

Popup 对 `starting` / `stopping` 的处理：收到 ack 后进入轮询（每 1s 调 status），直到终态或超时；popup 关闭时轮询自然停止，下次打开重新 status 即可（无状态设计使这一点免费获得）。

---

## 6. 原生宿主设计（native-host/host.js）

### 6.1 运行形态

- 纯 Node 脚本，零第三方依赖，Node ≥ 18（复用本机 Node，即 `process.execPath`）。
- 由 Chrome 按注册表注册的宿主 manifest 拉起，与浏览器通过 stdio 通信。
- 消息帧：**4 字节小端序无符号长度前缀 + UTF-8 JSON 载荷**；宿主→浏览器单消息上限 1MB（Chrome 平台约束，本项目远小于此）。

### 6.2 请求/响应协议

请求（浏览器 → 宿主）：

```json
{
  "id": "c1f4-…",            // 扩展生成的请求号，原样回显
  "action": "status",        // ping | status | start | stop | restart | adopt | logs
  "payload": {
    "profile": "web",        // start/restart 用
    "port": 3080,            // start/restart 用；缺省 3080；0 = 动态端口（M4，OS 分配，从日志回填实际端口）；adopt 用（与 pid 一起取自 status 的 external 结果）
    "host": "127.0.0.1",     // start/restart 用；缺省 127.0.0.1（不允许 0.0.0.0）
    "extraArgs": [],         // 透传给 dsh 的额外参数白名单：见 §12.1
    "pid": 12345,            // adopt 用（取自 status 的 external 结果）
    "tailLines": 500,        // logs 用：返回的最后 N 行（1-2000，默认 500，仅尾部块生效）
    "maxBytes": 262144,      // logs 用：单块最大字节数（1KB-1MB，默认 256KB）
    "beforeByte": 1048576    // logs 用：返回结束于该偏移的前一段（「加载更早」分页；缺省为尾部块）
  }
}
```

响应（宿主 → 浏览器）：

```json
{
  "id": "c1f4-…",
  "ok": true,
  "result": {
    "state": "running",           // stopped|starting|running|stopping|external
    "source": "managed",          // managed=本扩展启动；external=外部启动；stopped 时为 null
    "pid": 12345,                 // running/starting/stopping/external 时存在
    "port": 3080,                 // managed 动态端口未回填时（--port 0 占位期）为 null
    "url": "http://127.0.0.1:3080",
    "requestedPort": 0,           // 仅 --port 0 且 port 未知时出现（0 = 端口自动分配中）
    "version": "0.1.0-rc.6",      // dsh --version，status 时返回；external 为 "unknown"
    "startedAt": 1739420000000,   // external 为 null（启动时刻未知）
    "externalCount": 2,           // 仅 external 且外部实例 >1 时出现
    "lifecycle": true,            // GET /_lifecycle/health 可达（仅 running 时探测，1.5s 超时失败静默 false）
    "health": {                   // lifecycle:true 时附带；否则 null（§7.3；不作存活判定依据）
      "ok": true, "pid": 12345, "uptimeMs": 182000, "port": 3080, "nodeVersion": "v22.16.0"
    },
    "stopMethod": null,           // 仅 stop 响应：'graceful'=优雅停止 / 'force'=taskkill；其余动作恒 null
    "logFile": "C:\\Users\\…\\AppData\\Local\\dsh-manager\\logs\\dsh-web.log"
  },
  "error": null
}
```

失败响应：`"ok": false`，`error` 携带稳定错误码：

**logs 响应**（M3 日志查看，§6.3 logs）：

```json
{
  "id": "c1f4-…",
  "ok": true,
  "result": {
    "exists": true,                // 日志文件是否存在；false 时其余字段恒为 0/空
    "path": "C:\\Users\\…\\AppData\\Local\\dsh-manager\\logs\\dsh-web.log",
    "sizeBytes": 1048576,          // 文件当前字节数
    "fromByte": 786432,            // 本块在文件中的起始字节偏移（含行边界对齐）
    "toByte": 1048576,             // 本块结束字节偏移；尾部块恒 === sizeBytes
    "hasMore": true,               // 是否还有更早内容（fromByte > 0）
    "tailLines": 500,              // 本块包含的完整行数
    "tail": "…最近日志文本…"       // 日志内容（只含完整行；跨块的不完整首/尾行被丢弃）
  },
  "error": null
}
```

块间契约：相邻块**严格衔接**（前块 `toByte` === 后块 `fromByte`），扩展按 `beforeByte = 首块 fromByte` 逐块向前翻页直至 `hasMore:false`；字节偏移按 UTF-8 精确计算。

| 错误码 | 含义 | 扩展侧提示 |
|--------|------|-----------|
| `DSH_NOT_FOUND` | 未找到 dsh 安装（npm 全局路径解析失败） | 「未检测到 dsh，请先 `npm i -g @deepseek-ai/dsh`」 |
| `PORT_BUSY` | 目标端口被非 dsh 进程占用 | 「端口 3080 已被其他程序占用」 |
| `ALREADY_RUNNING` | start 时已在运行 | 视为成功（幂等） |
| `ALREADY_STOPPED` | stop 时已停止 | 视为成功（幂等） |
| `START_TIMEOUT` | 30s 内端口未就绪 | 附日志尾部 20 行 |
| `STOP_FAILED` | taskkill 失败（无权限/进程已变） | 附 system 错误信息 |
| `EXTERNAL_UNMANAGED` | 检测到外部运行的 dsh web（非本扩展启动），拒绝停止/重启；adopt 目标不存在时亦返回 | 「检测到外部运行的 dsh web，请先接管或在其原终端停止」 |
| `BUSY` | 锁被另一宿主持有 | 「操作进行中，请稍候」 |
| `BAD_REQUEST` | action 非法 / 参数校验失败 | 开发期诊断 |
| `INTERNAL` | 宿主自身异常 | 附 stack（仅开发模式） |

### 6.3 动作实现规范

**status**

1. 读 `run\dsh-web.json`；不存在 → 执行外部实例发现（§6.6）：发现则返回 `external`（附 `source:"external"`、真实 pid/port/url 与 `externalCount`），否则 `stopped`（顺带清理孤儿 pid 文件）。
2. `process.kill(pid, 0)` 判定存活；已死 → 清理记录 → 同第 1 步执行外部实例发现。
3. 加固检查（可选开关）：用 `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"` 校验命令行包含 `dsh`，防止 PID 复用误判/误杀；校验不过 → 清理记录 → 同第 1 步。
4. HTTP 探活：`GET http://127.0.0.1:<port>/`，超时 1.5s。200 → `running`；失败但 PID 存活 → `starting`（进程在加载依赖，dsh 冷启动可达数秒）。
5. 附带 `dsh --version`（缓存到 run 记录，避免每次 status 都跑子进程）。
6. running 时探测 `GET http://127.0.0.1:<port>/_lifecycle/health`（1.5s 超时，失败静默）：可达则附带 `health` 富状态且 `lifecycle:true`；不可达则 `health:null`、`lifecycle:false`（富状态**不可作为存活判定的唯一依据**，§4.2.6）。

> 外部实例发现只在**无有效 run 记录**时执行：有 run 记录时 managed 实例优先，不做发现扫描（省去每 2s 轮询的进程枚举开销）。

**start**

1. status → `running` 则返回 `ALREADY_RUNNING`。
2. 抢锁（§4.2.5）。
3. 探测端口占用：TCP connect 到 `127.0.0.1:port`，能连上且不是我们的 run 记录 → `PORT_BUSY`（顺带做 dsh 指纹探测：若占用者就是 dsh web，错误消息明确提示「该端口已有一个外部运行的 dsh web」，引导用户在原终端停止或更换端口）。**M4：`port 0`（动态端口）跳过占用探测**——端口由 OS 分配，不存在占用。
4. 解析 dsh 启动器（见 §6.4），校验版本 ≥ 最低支持版本。
5. spawn（POSIX 直接 spawn；Windows 隐藏控制台载体，见下方 bullet）：
   ```
   node.exe <npm-global>\node_modules\@deepseek-ai\dsh\lib\bin.js
        --profile web --host 127.0.0.1 --port 3080 [extraArgs...]
   POSIX options: { detached: true, stdio: ['ignore', logFd, logFd], env: { ...process.env } }
   Windows（M5.5）：wscript.exe + launch-hidden.vbs（BASE_DIR 下运行时自生成），命令经
             环境变量 DSH_MANAGER_LAUNCH_CMD 传递，VBS 以 `cmd /d /c call` 执行并
             `1>> 日志 2>&1` 重定向；wscript 2s 内非 0 退出即载体失败（INTERNAL）
   ```
   - 日志文件先 `mkdir -p`：POSIX 用追加打开的 fd（`fs.open(..., 'a')`），宿主退出后 fd 随宿主关闭，不影响 dsh 后续写入；Windows 由 cmd 重定向追加（语义一致）。
   - **不用 pipe**：pipe 会在宿主退出后产生 EPIPE 风险；日志文件同时是 M3「查看日志」与「解析实际端口」的数据源（F5）。
   - **隐藏控制台载体（M5.5，2026-08-15 实现）**：Windows 下 `detached:true` 由 libuv 无条件加 `DETACHED_PROCESS`（子进程既不继承也不新建控制台），且受限令牌下 `CREATE_NO_WINDOW` 不可用（`STATUS_DLL_INIT_FAILED`，`@deepseek-ai/dsh-sandbox-windows-acl` README 记载）——直接 spawn 的 dsh 必然无控制台，其每次执行命令都会新建一闪而过的终端窗口。M5.5 改为**隐藏控制台载体**启动：宿主先写 `launch-hidden.vbs`（`BASE_DIR` 下，运行时自生成），再 `wscript.exe` 执行 `WScript.Shell.Run(cmd, 0, False)`——`windowStyle=0`（SW_HIDE）使 dsh 获得一个**存在但从不显示**的控制台：其命令子进程继承该控制台（不再闪窗），桌面也无常驻窗口。**必须显式 `cmd /d /c call` 执行**：`WshShell.Run` 对引号开头（exe 路径）的命令直接 CreateProcess，`1>> 日志 2>&1` 会被当成普通参数丢失（实测发现，2026-08-15）；`call` 同时避开 cmd /c 的剥引号规则；`%` 按 cmd 规则转义为 `%%`。载体进程（wscript→cmd）即刻退出，dsh 独立存活。**实测核验（EnumWindows 窗口枚举）**：载体下 dsh 控制台窗口存在但不可见（IsWindowVisible=false），其子进程零新窗口（对比直接 spawn 时子进程弹可见新终端，2026-08-15）。POSIX 无控制台概念，维持直接 spawn。若 dsh 上游修复受限令牌限制（沙箱可直接 `CREATE_NO_WINDOW`），可移除载体回归直接 spawn。
6. 写 run 记录（先写 `.tmp` 再 `rename`，内容含 pid、port、profile、startedAt、version、cmdline；M4 新增 `requestedPort` 与 `logStartBytes`（spawn 时刻日志字节偏移））。**M5.5 时序**：记录在「端口就绪 + PID 已知」后才写——Windows 载体不回传 PID，端口就绪后经端口表反查（`findPidByPort`，带 200ms 短重试）；启动期间（端口就绪前）无记录，status 显示 stopped（快速连点由第 2 步的锁兜底，见第 7 步）。失败路径（`START_TIMEOUT` / 动态端口未报告）**尽力回写**：POSIX 直接用 spawn 已知的 pid；Windows 端口已知时经端口表反查、未知时经进程表匹配 bin+`--port 0`（尽力而为）；匹配失败仅记日志——实例可能仍在运行，刷新 popup 后可按 external「接管」停止。
7. 释放锁（**M5.5：锁保持到 run 记录写入完成之后**——启动窗口内并发 start 被锁挡下，`--port 0`（无占用探测）亦被覆盖，防双开；轮询在锁内进行）；轮询端口（500ms 间隔，最长 30s）。就绪 → `running`；超时 → 返回 `START_TIMEOUT` + 日志尾部（此时**不杀进程**，交由用户查看日志后决定；进程可能仍在后台最终就绪）。
8. `unref()` child 句柄，宿主随时可安全退出。
9. **M4 动态端口（`--port 0`）**：第 7 步之前先轮询日志（仅解析 `logStartBytes` 之后的追加内容，排除历史实例干扰）匹配 `dsh web: http://127.0.0.1:<port>` URL 行（真实 dsh 绑定后打印实际端口；port 0 占位行跳过），发现后**回填 run 记录实际端口**再按常规探活；30s 未发现 → `START_TIMEOUT`。status 遇 port 0 占位记录同样尝试回填（自愈），回填前对外报 `port:null` + `requestedPort:0`、状态 `starting`。

**stop**

1. status → `stopped` 则返回 `ALREADY_STOPPED`；status → `external` 则返回 `EXTERNAL_UNMANAGED`（外部实例不属于本扩展管理范围，绝不 taskkill）。
2. 抢锁。
3. 优雅路径（dsh-lifecycle 插件存在时）：先探测 `/_lifecycle/health`（1.5s）判定插件可用；可用则 `POST http://127.0.0.1:<port>/_lifecycle/shutdown`（2s 连接超时）→ 轮询端口关闭 ≤ 3s；关闭则记为 `stopMethod:'graceful'` 并跳过第 4 步。插件不可达则直接走第 4 步（不浪费一次 POST；SPA fallback 对未匹配路径也返回 200，不能以状态码判定插件存在）。
4. 强制路径（插件缺失或优雅路径超时）：Windows 为 `taskkill /PID <pid> /T /F`；**M4 POSIX 为 SIGTERM（进程组，detached 起组）→ 3s 内未退出 SIGKILL 兜底**；均记为 `stopMethod:'force'`（语义不变：优雅仅指 lifecycle 插件路径）。PID 取自 run 记录；先做 PID 复用校验，失败则拒杀并报 `STOP_FAILED`。
5. 轮询端口关闭 ≤ 10s；仍未关闭 → `STOP_FAILED`。
6. 删除 run 记录与 pid 文件，释放锁。stop 响应的 result 附带 `stopMethod`（graceful/force）。

**restart**

- v1：stop（等待 `stopped`）→ start，宿主内部顺序执行，一次应答。
- status → `external` 时返回 `EXTERNAL_UNMANAGED`（外部实例不可由扩展直接重启，先接管，§6.7）。
- **重启参数 = 请求 payload 显式字段优先，run 记录回退（2026-08-24 修订）**：payload 显式给出的 `host`/`port`/`profile`/`extraArgs` 以 payload 为准（§6.2 声明这些字段为 start/restart 用；popup 保存设置后点重启即携带新端口——原实现完全忽略 payload，导致「改端口后重启仍起旧端口」的非预期行为；非接管 `extraArgs` 仍走 §12.1 白名单）。payload 未给出对应字段时回退 run 记录（页面内面板等空 payload 场景、旧客户端行为不变）。——重启编排权在宿主（插件不需要、也不应该知道自己的 profile/启动参数，见 §7.5）。
- 接管实例（`adopted:true`）的重启：`extraArgs` 恒以接管时解析的 argv 重放（黑名单过滤，不走 §12.1 白名单，参数源自本机进程表，见 §6.7）；生命周期参数（host/port/profile）默认记录值（`--port 0` 归一化为接管时的实际端口），payload 显式给出时以 payload 为准（且必须先通过 start 同款白名单校验）。
- **M4**：`--port 0` 启动的记录（`requestedPort===0`）按动态端口语义重放——重新以 `--port 0` 拉起并再次从日志回填实际端口（OS 重新分配）；payload 显式给出端口时以 payload 为准（用户意图优先于血统）；接管实例不受影响（仍按接管时实际端口重放）。

**adopt**（外部实例接管，§6.7）

1. payload `{pid, port}` 必须是正整数（取自 status 的 external 结果）；非法 → `BAD_REQUEST`。
2. 重新执行外部实例发现，在结果中按 **pid + port 双重精确匹配** 目标（防止 PID 复用/接错实例）；不匹配或进程已死 → `EXTERNAL_UNMANAGED`。
3. 抢锁；锁内复查目标 PID 存活与端口指纹，仍为 dsh → 解析其命令行（profile / host / 其余 argv），`binPath` 用 `resolveDshBin()` 解析（§6.4，测试可被 DSH_BIN_STUB 替换）。
4. 回写 run 记录：`{pid, port(实际端口), host, profile, startedAt(接管时刻), version(dsh --version), binPath, extraArgs(原 argv 剩余项), adopted:true, cmdline}`。
5. 返回 `running`（`source:"managed"`）。此后 stop/restart 走标准 managed 路径；restart 重放时新记录**延续 `adopted` 血统标记**（后续 restart 持续按接管 argv 重放，参数始终源自接管时的本机进程表）。

**ping** = 返回宿主版本与 dsh 路径解析结果（诊断用）。

**logs**（M3 日志查看，只读、无锁）

1. payload 校验：`tailLines` 1-2000 整数（默认 500）、`maxBytes` 1KB-1MB 整数（默认 256KB）、`beforeByte` 非负整数（可选）；非法 → `BAD_REQUEST`。
2. `stat` 日志文件：不存在 → `exists:false`；存在且为 0 字节 → `exists:true` + 空 `tail`。
3. 定位区间 `[start, end)`：`beforeByte` 缺省或 ≥ 文件大小时为**尾部块**（`end=size`，`start=size-maxBytes`）；否则为**中间块**（`end=beforeByte`，`start=end-maxBytes`）。
4. 按字节精确读取 `[start, end)`（`fs.openSync` + 循环 `readSync`，不整读大文件）。
5. 行边界对齐：`start>0` 时丢弃段首至第一个 `\n` 的不完整行；中间块在 `end<size` 时丢弃段尾最后一个不完整行（该行的前半部分在更新的块里）——保证每块只含完整行、块间严格衔接（前块 `toByte` === 后块 `fromByte`）。
6. 尾部块再按 `tailLines` 截断最早的若干行（按字节精确回算 `fromByte`）；`hasMore = fromByte > 0`。
7. 返回 `{exists, path, sizeBytes, fromByte, toByte, hasMore, tailLines, tail}`（响应恒 < 1MB，扩展 1MB 出站帧上限内）。
8. 安全：只读本机日志文件，不接受任意路径（路径固定为 `LOGS_DIR\dsh-web.log`）；`tail` 由扩展侧 `textContent` 渲染，不进入 HTML。

### 6.4 dsh 启动器解析

宿主内按序尝试，第一个成功者写入 run 记录：

1. **首选（无 shell）**：`npm prefix -g` → `<prefix>\node_modules\@deepseek-ai\dsh\lib\bin.js`，用 `process.execPath` 直接执行。无 shell 转义、无窗口闪现（有一常驻控制台，见 §6.3 第 5 步）、错误码干净。
2. 回退（含 shell）：`where dsh` 命中 `%APPDATA%\npm\dsh.cmd` → `spawn('dsh.cmd', args, { shell: true, windowsHide: true })`（Node ≥ 18.20 要求 `.cmd` 必须 `shell: true`）。
3. 都失败 → `DSH_NOT_FOUND`，响应中附排查提示（`npm root -g` 结果）。

### 6.5 状态文件布局

```
%LOCALAPPDATA%\dsh-manager\
├─ run\dsh-web.json        # 唯一权威 run 记录（JSON，原子写）
├─ run\dsh-web.pid         # 冗余纯文本 pid（供外部工具/调试读取）
├─ run\host.lock           # 跨宿主互斥锁（'wx' 原子创建）
└─ logs\dsh-web.log        # dsh stdout+stderr 追加日志
```

run 记录示例：

```json
{
  "pid": 12345,
  "port": 3080,
  "host": "127.0.0.1",
  "profile": "web",
  "startedAt": 1739420000000,
  "version": "0.1.0-rc.6",
  "binPath": "C:\\Users\\<user>\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js",
  "extraArgs": [],
  "adopted": false,
  "cmdline": "node.exe C:\\Users\\<user>\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js --profile web --port 3080"
}
```

> `adopted:true` 表示实例由外部接管而来或继承接管血统（§6.7）：restart 按其原 argv 重放；`startedAt` 为接管时刻（真实启动时刻未知）。

---

## 6.6 外部实例发现（检测现有 dsh 服务的运行端口）

**目标**：用户在终端手工运行了 `dsh web`（无 run 记录，端口未知，可能 `--port 0`）时，status 能**检测到它并报告真实端口与 URL**，popup 以 `external` 状态展示并允许一键打开 Web UI。此能力同时收编 §16 风险表「端口通但无 run 记录」与 M4「端口发现」中与外部实例相关的部分。

**触发时机**：仅当 `computeStatus` 无有效 run 记录时执行（managed 实例优先，避免每 2s 轮询都做进程枚举）。

**算法（按序，任一命令失败静默降级，绝不报错）**

1. **枚举候选进程**：`powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"`（超时 10s；失败→跳过发现）。测试钩子 `DSH_MANAGER_FAKE_PROCESSES`（JSON 数组 `[{pid,cmdline}]`）可注入假进程表（生产环境不存在该变量）。
2. **过滤 dsh 入口**：CommandLine 匹配 `@deepseek-ai\dsh\lib\bin.js`，且属于 web 实例（含 `--profile web` / 位置参数 `web` / `--port` 任一）；进程须 PID 存活。已知局限：非 npm 布局（源码 checkout 直跑）不识别，v1 可接受。
3. **解析端口**：从 CommandLine 解析 `--port <n>` 或 `--port=<n>`；`--port 0` 或缺省 → 走第 4 步。
4. **动态端口回退**：`netstat -ano -p TCP` 解析该 PID 的全部 `LISTENING` 端点（IPv4 `addr:port` 与 IPv6 `[addr]:port` 两种行格式），回环（`127.0.0.1`/`::1`/`::ffff:127.0.0.1`）与通配（`0.0.0.0`/`::`）绑定的端口作为候选。测试钩子 `DSH_MANAGER_FAKE_LISTENERS`（`[{pid,addr,port}]`）。
5. **dsh 指纹探测（误报闸门）**：对候选端口 `GET http://127.0.0.1:<port>/`（1.5s 超时），读取响应体前 8KB，须包含 `DeepSeek Harness`（真实前端 `dist/index.html` 的 `<title>`，已核验）。指纹不匹配的端口（其他 node 服务、PID 复用残留）一律不报告。
6. **报告**：第一个匹配实例作为 `external` 状态返回（pid/port/url，`startedAt:null`、`version:"unknown"`）；多个匹配时附 `externalCount`。已知局限：仅探测回环绑定，LAN 地址绑定的外部实例不在 v1 范围。

**管理边界（安全）**

- 发现动作只执行本机**只读**命令与回环 GET 探测：不写 run 记录、不 spawn、不 taskkill。
- `stop`/`restart` 对外部实例一律 `EXTERNAL_UNMANAGED`（popup 按钮亦禁用）——外部实例可能由用户终端前台运行，杀掉会破坏其终端语义；需要管理时走**显式接管**（§6.7 adopt），由用户主动授权。
- `start` 端口冲突时做指纹探测，若占用者是 dsh 则给出针对性提示（§6.3 start 第 3 步）。

---

## 6.7 外部实例接管（adopt）

**目标**：用户在 popup 对 `external` 实例点「接管」后，该实例纳入扩展管理——获得 stop / restart 能力（§6.3 adopt / restart）。

**语义与边界**

1. **显式授权**：接管是唯一的从 external 进入 managed 的路径；未经接管，任何动作都不触碰外部进程。
2. **双重匹配防误接管**：adopt 的 `{pid, port}` 必须同时命中发现结果（§6.6）；PID 复用或端口漂移导致不匹配 → `EXTERNAL_UNMANAGED`，绝不硬写记录。
3. **记录来源**：run 记录的 profile/host/extraArgs 从该进程的**真实命令行**解析（本机进程表，用户自己的进程），`binPath` 由宿主标准解析链（§6.4）现场解析；`--port 0` 归一化为接管时的实际端口。
4. **重启重放**：接管实例的 restart 用其原始 argv（去掉 profile/host/port 后以记录值归一化重放），保留用户其余参数（如 `--patch`、`--resume`、`--trusted-host`）；**该路径不走 §12.1 extraArgs 白名单**——因为参数来自本机进程表而非扩展消息。扩展输入路径（start/restart 的 payload）仍严格白名单，两条输入通道边界清晰。
5. **已知局限**：接管后环境变量为宿主当前环境（外部进程的 env 不可读）；`startedAt` 记为接管时刻；多外部实例时逐个接管（接管一个后 managed 优先，其余外部实例需在停止该实例后再次 status 发现）。

---

## 6.8 平台抽象层（M4）

宿主对平台差异的收敛点（其余逻辑平台无关）：

| 能力 | Windows | Linux | macOS |
|------|---------|-------|-------|
| 状态根目录 | `%LOCALAPPDATA%\dsh-manager` | `$XDG_CONFIG_HOME/dsh-manager` 或 `~/.config/dsh-manager` | `~/Library/Application Support/dsh-manager` |
| 强制终止 | `taskkill /PID <pid> /T /F` | `kill(-pid, SIGTERM)`（进程组）→ 3s → SIGKILL | 同 Linux（`kill(-pid, …)`） |
| 进程枚举 | powershell `Get-CimInstance Win32_Process` | **/proc 扫描（零外部依赖）**：`/proc/*/cmdline` + `comm` 过滤 node | `ps -eo pid=,args=` |
| 端口表 | `netstat -ano -p TCP` | **/proc/net/tcp(+tcp6)**（LISTEN 行 inode → `/proc/*/fd` 反查 pid，零外部依赖） | `lsof -nP -iTCP -sTCP:LISTEN` |
| PID 命令行校验 | `tasklist /FI` | `/proc/<pid>/cmdline` | `ps -p <pid> -o args=` |

实现要点：`IS_WIN`/`IS_MAC` 分支集中在上述五个函数内；`--port 0` 日志发现、锁、run 记录、HTTP 探测、优雅停链全部平台无关；测试钩子（`DSH_MANAGER_FAKE_PROCESSES` 等）优先于平台实现（假数据注入时两者都不走）。

**验证状态**（2026-08-14）：Windows 路径 M1 起生产实测；**Linux 路径经 Kali WSL（WSL2）实测通过**——smoke 场景 26（POSIX 专属）不注入任何 fake 钩子，真实 /proc 枚举 + /proc/net/tcp 端口表 + /proc PID 校验 + 指纹探测发现/接管/停止外部实例全链路通过，且 Linux 全量冒烟不再围栏（`BASE_ENV` 围栏仅 Windows 使用）；macOS 三个分支已实现但**未实测**（无 macOS 设备，`ps`/`lsof`/`~/Library` 分支待验证）。

---

## 7. dsh 生命周期插件（plugin/dsh-lifecycle，M2 已实现）

### 7.1 定位

- 独立 npm 包（包名建议 `dsh-lifecycle`），按 dsh 插件规范组织，通过 `dsh plugin --profile web add dsh-lifecycle` 安装（或用户 `cordis.patch.yml` 覆盖层挂载）。
- 与浏览器扩展**完全解耦、双向可选**：
  - 不装插件：扩展照常工作（停止降级 taskkill，状态用端口探活）。
  - 不装扩展：插件独立可用（`curl -X POST http://127.0.0.1:3080/_lifecycle/shutdown` 即可优雅停机）。
- 它解决的问题恰恰是进程外组件做不到的：**进入 dsh 自身的 dispose 生命周期**（F7/F12）。

### 7.2 接口

| 方法 | 路径 | 请求 | 响应 | 语义 |
|------|------|------|------|------|
| POST | `/_lifecycle/shutdown` | 无 body | `202 {"ok":true}`（先刷出响应，再 dispose 退出） | 优雅停止：`appExit(0)` → 整棵 fiber 树 dispose → 进程退出（F7 同路径） |
| GET | `/_lifecycle/health` | 无 | `200` JSON（见下） | 健康/富状态；供宿主与 curl 读取 |

health 响应（v1 最小集；v2 扩展会话/作业等聚合字段）：

```json
{
  "ok": true,
  "pid": 12345,
  "uptimeMs": 182000,
  "port": 3080,
  "nodeVersion": "v22.16.0"
}
```

### 7.3 实现要点（基于 F12 核验的源码契约）

1. **注入**：`inject: ['webServer', 'appExit']`——`webServer` 提供 `register({kind:'exact', path, handler})` 并返回 disposer；`appExit` 是 dsh-cmdline 提供的官方退出出口（= launcher 的 `shutdown` → `fiber.dispose()`），它**只是优雅 dispose 请求**——dispose 成功后仅设 `process.exitCode`，**不强制 `process.exit()`**，进程退出依赖事件循环自然排空；宿主以端口关闭为权威判定（§6.3 stop），并有 taskkill 回退。
2. **响应先于退出**：shutdown 处理器在 `res.end()` 完成回调后 `setImmediate(() => ctx.appExit(0))`，确保 202 刷出到 socket 再开始 dispose（避免响应被截断）。
3. **安全围栏（自管）**：插件路由不经过 `/api` 网关围栏（F9/F12），必须自行校验：
   - `req.socket.remoteAddress` 必须为回环地址；
   - Host 头必须回环；
   - **请求头 `sec-fetch-site` 为 `cross-site` 时拒绝**（与官方 `isTrustedApiRequest` 对齐）；
   - **Origin 缺失或与 Host 同源**——由此扩展页面直接 fetch（带 `chrome-extension://` Origin）被拒，而「扩展 → 宿主 → HTTP」链路（宿主请求无 Origin）天然合规；
   - 方法白名单：shutdown 仅 POST、health 仅 GET，其余 405（附 `Allow` 头）。
4. **生命周期**：两个 disposer 在插件 `apply` 返回的清理函数中统一释放（随 fiber 停止/更新自动摘除路由）。
5. **富状态聚合（v2）**：通过 `ctx.get()` 只读宿主 Cordis 服务（会话数、活动作业、token 统计等）——只取叶子字段、构造最小自有对象，绝不序列化 live 服务对象（dsh 插件规范）。

骨架示意（正式实现按 dsh 插件包规范补 Invariant/测试/README）：

```js
// plugin/dsh-lifecycle 插件骨架
export const name = 'dsh-lifecycle'
export const inject = ['webServer', 'appExit']

const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'

function allow(req) {
  if (!isLoopback(req.socket.remoteAddress ?? '')) return false
  const host = req.headers.host ?? ''
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return false
  const origin = req.headers.origin
  if (origin !== undefined) {
    try { if (new URL(origin).host !== host) return false } catch { return false }
  }
  return true
}

export function apply(ctx) {
  const dispose = [
    ctx.webServer.register({ kind: 'exact', path: '/_lifecycle/health', handler: async (req, res) => {
      if (!allow(req) || req.method !== 'GET') { res.writeHead(req.method === 'GET' ? 403 : 405); res.end(); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true, pid: process.pid,
        uptimeMs: Math.round(process.uptime() * 1000),
        port: ctx.webServer.port, nodeVersion: process.version,
      }))
    }}),
    ctx.webServer.register({ kind: 'exact', path: '/_lifecycle/shutdown', handler: async (req, res) => {
      if (!allow(req) || req.method !== 'POST') { res.writeHead(req.method === 'POST' ? 403 : 405); res.end(); return }
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }), () => setImmediate(() => ctx.appExit(0)))
    }}),
  ]
  return () => { for (const d of dispose) d() }
}
```

### 7.4 与宿主的协作分工（M2）

- **stop**：宿主先 POST `/_lifecycle/shutdown` → 轮询端口关闭 ≤ 10s → 超时回退 taskkill。
- **restart**：shutdown → 等 stopped → 用 run 记录的 `cmdline` 原样重放 spawn。插件**不自行 respawn**：插件进程内拿不到 profile 名（`cmdlineArgs` 只含 launcher 之后的内部参数，F12），而宿主恰好持有权威启动命令，职责归属清晰。
- **status**：存活判定仍以「PID 存活 + 端口探活」为权威（插件缺失不能把 running 误判为 stopped）；`health` 仅作富状态补充（§4.2.6）。

---

## 8. 浏览器扩展设计（extension/）

### 8.1 manifest.json（MV3）

```json
{
  "manifest_version": 3,
  "name": "DSH Manager",
  "version": "0.1.0",
  "key": "<固定公钥，见 §10.2，项目初始化时生成一次>",
  "permissions": ["storage", "nativeMessaging", "alarms"],
  "host_permissions": ["http://127.0.0.1/*", "http://localhost/*"],
  "action": { "default_popup": "popup.html", "default_title": "DSH Manager" },
  "background": { "service_worker": "background.js" },
  "content_scripts": [
    {
      "matches": ["http://127.0.0.1/*", "http://localhost/*"],  // 匹配模式忽略端口：任意端口生效
      "js": ["content/panel.js"],
      "run_at": "document_idle"
    }
  ],
  "icons": { "16": "icons/16.png", "48": "icons/48.png", "128": "icons/128.png" }
}
```

说明：

- `nativeMessaging`：连接宿主所必需。
- `host_permissions` 限回环：既用于 popup/SW 的 `fetch` 探活（`GET /`），也杜绝扩展对任意网络地址的访问面。
- `chrome.tabs.create` 打开 Web UI 无需任何额外权限。
- `alarms` 用于周期徽标刷新（可选功能，默认开、30s 间隔）。
- **不申请** `webRequest` / `declarativeNetRequest` / 任意文件系统权限——不需要，也避免商店审核与用户信任问题。

### 8.2 popup（popup.html/js/css，V6 侧边 Rail 导轨空间架构）

**空间架构与尺寸基线：380px 宽度 × 270px 严格物理锁定高度（零抖动）。** 采用 Master-Detail 侧边导轨架构（左侧 **46px 极窄 Rail 导轨** + 右侧 **334px 独立视口**），尺寸从 360×240px 舒展放大至 380×270px，不仅彻底根除传统单列视图在面板展开、设置切换时的尺寸拉长与跳动问题，还为多会话列表与运维操作提供了从容呼吸的视觉空间。

**视觉规范：100% 对齐 dsh Web UI 设计系统与原厂原生资产。**
1. **设计令牌与色彩**：直接内联 dsh 前端设计令牌（`--dsw-*` 变量，浅色 + 深色两套（§8.7））：主文字 `--dsw-alias-label-primary`；次要/说明文字 label-secondary / label-tertiary / label-caption；面板底 `--dsw-alias-bg-base`；模块底 `--dsw-alias-bg-module-platform`；边框 `--dsw-alias-border-l1/l2`；悬停 `--dsw-alias-interactive-bg-hover`。
2. **官方真实选中态（Active State）**：严格遵循 Web UI 真实规范——**无粗重实心反色填充，无多余黑/白外框线，采用纯净柔和的灰色圆角背景**（深色模式 `rgba(255, 255, 255, 0.14)`，浅色模式 `rgba(38, 49, 72, 0.10)`），图标与文本高亮提亮为 Primary 色。
3. **官方原生 SVG 资产库 (`dsh-assets-library.js`)**：全量接入从官方 bundle 提取的精准资产：`FishLogo`（精准 23.16:17.04 比例）、`BrandBadge`（矩形微胶囊字标）、`StateMatrix`（进行中跑马灯点阵）、`IconPanelLeftOutline16`（概览）、`IconNewChatOutline16`（会话）、`IconSettingsOutline16`（设置）、四态主题图标等。
4. **官方动效系统（Keyframes）**：
   - 小鲸鱼游弋（`dsh-fish-swim`）：悬停触发原厂 0.6s 平滑游动；
   - 面板平滑滑入（`dsh-panel-in`）：面板切换带 `translateX(6px) → 0` 0.18s 顺滑进场；
   - 进行中流光扫光（`dsh-shimmer`）：2.2s 高光渐变扫过文字；
   - 全局呼吸 Document Timeline 同步：所有指示灯以打开瞬间为零点基准，绝对同频同相呼吸；
   - 触觉按压反馈（`:active` scale 0.96）。

布局架构（V6 导轨双栏）：

```
┌─────────────────────────────────────────────────────────────┐
│ [46px Rail 导轨] │ [334px 独立视口 (高度物理锁定 270px)]      │
│                  │                                          │
│ [ ◫ 服务概览 ]   │ [FishLogo] Whalekeeper [DSH WEB]  [3080] │
│ [ 💬 会话感知 ]  │ ──────────────────────────────────────── │
│ [ ⚙ 偏好设置 ]   │  ● 运行中                           健康 │
│                  │  已运行 76m43s · PID 53844 · node v24.19 │
│                  │                                          │
│                  │  [             打开 DSH Web UI          ] │
│                  │  [ ▷ 启动 ]    [ ■ 停止 ]      [ ↻ 重启 ] │
│                  │                                          │
│ ● (常驻同频呼吸) │  优雅停机已就绪                 查看日志 │
└──────────────────┴──────────────────────────────────────────┘
```

三大面板职责与排版：

1. **面板 1：服务概览 (Dashboard)**：
   - 顶栏：悬停游弋 `FishLogo` + `Whalekeeper` + `BrandBadge[DSH WEB]` + 端口微胶囊 `[3080]`；
   - 状态卡：分层圆点 + 运行状态 + 健康度 + PID/uptime/nodeVersion 明细；
   - 主操作区：宽幅「打开 DSH Web UI」主入口 + 启动/停止/重启运维操作行（34px 舒适操作高度）；
   - 底栏：优雅停机状态感知 + 「查看日志」独立全页入口（§8.4）。
2. **面板 2：会话状态感知 (Sessions)**：
   - 顶栏：`会话状态感知` + 胶囊 `[3 活跃]` + `只读感知`；
   - **原厂无框通透平铺列表**：移除每个会话的实体外框与小卡片背景，对齐 DSH Web UI 侧栏会话风格，透明背景 + 悬停轻盈半透灰底（`var(--dsw-alias-interactive-bg-hover)`），配备 4px 极窄半透明滚动条；包含待确认（琥珀呼吸点）、进行中（`StateMatrix` 点阵 + `shimmer` 流光扫光）、已完成（柔绿呼吸点）；
   - 底部操作：宽幅「前往 Web UI 统一处理」。
3. **面板 3：首选项设置 (Settings)**：
   - 分组微卡片化结构（Section Cards）：
     - **服务运行环境**：端口（0=自动）、Profile 方案（方案 A 友好注记：*默认 web，用于指定 dsh 启动方案，一般无需修改*）、自动打开 Web UI 开关；
     - **徽标感知与外观**：刷新间隔、双徽标感知开关、4 态外观 Theme Cubes；
     - **扩展徽标与会话颜色**：待确认/进行中/已完成 3 角色单层静态柔光色盘（安静不呼吸）+「恢复默认」；
   - 底部操作栏：双按钮 `[ 保存设置 ]` 与 `[ 取消 ]`。

### 8.4 日志查看页（logs.html/js/css，M3）

popup「查看日志」打开的全页日志查看器，视觉延续同一套 `--dsw-*` 设计令牌（logs.css 与 popup.css 同源）；日志区等宽字体、纯文本渲染。

布局（自上而下）：

```
┌──────────────────────────────────────────────────────────┐
│ ● dsh web 日志      [☑自动刷新] [加载更早] [复制全部] [刷新] │
│ [错误横幅（宿主缺失/通信失败，附重试）]                     │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ <pre> 日志内容（等宽、纯文本、可滚动）                 │ │
│ └──────────────────────────────────────────────────────┘ │
│ 日志文件：…\logs\dsh-web.log · 大小 1.2 MB · 已加载 500 行 │
└──────────────────────────────────────────────────────────┘
```

行为规范：

1. 打开即经 SW 调宿主 `logs`（`tailLines:500`，默认 `maxBytes` 256KB）取尾部块；先并行拉一次 `status` 决定状态圆点颜色（running 绿 / 其余灰，仅展示用途，失败不阻塞）。
2. **加载更早**：`beforeByte = 首块 fromByte` 逐块向前翻页直至 `hasMore:false`（宿主保证行边界对齐与块间严格衔接）；`fromByte===0` 时 toast「已到日志开头」。点击「加载更早」自动**暂停自动刷新**（阅读历史与跟随互斥，toast 告知），避免新内容到来重置视图。
3. **自动刷新**（默认开，2s）：仅取尾部块；按块衔接契约合并——新尾部覆盖全部已加载内容时整视图重置，否则裁掉与尾部重叠的后缀块再追加；与最后一块之间出现缺口（日志轮转/截断）时插入视觉分隔标记。页面隐藏（`visibilitychange`）时暂停轮询，重新可见立即刷一次。用户停留在底部时新内容到达自动贴底，上翻阅读时保持位置。
4. **复制全部**：复制当前已加载的全部日志行（`navigator.clipboard` + `execCommand` 兜底，失败 toast）。
5. 错误横幅：`HOST_NOT_INSTALLED` / `NATIVE_ERROR` 等展示中文文案与重试按钮；圆点转红。
6. 安全：日志内容一律 `textContent` 渲染（含 gap 标记），绝不进入 `innerHTML`；页面仅 `127.0.0.1` 探活之外的本地扩展资源，无新权限。

### 8.3 background service worker

职责与约束：

1. **串行化 native 调用**：维护单一 `pending` promise 队列，一次只允许一个 connectNative 连接；并发请求排队（状态模型本身幂等，但串行化可消除锁竞争与 Chrome 多宿主进程）。
2. 单次 native 往返时长按动作区分：**start/restart 的「轮询到就绪」在宿主侧完成**（start ≤30s 端口轮询 + M4 `--port 0` 的 30s 端口发现；restart = stop≤10s + start≤30s 串行），SW 以更长的兜底超时等待应答（start 60s / restart 120s，§8.3.6）——start 返回的就是 `running`（或超时错误），popup 应用结果后由 2s 轮询收敛（与 §6.3 实现一致；§9 时序为早期草稿，若与本节冲突以本节与 §6.3 为准）。
3. 连接异常处理：`connectNative` 抛 `Specified native messaging host not found` → 向 popup 返回 `HOST_NOT_INSTALLED`，引导运行安装器。
4. 徽标刷新：`chrome.alarms`（30s）→ 本地 fetch 探活（不惊动宿主）→ 更新 **图标角标**（`action.setIcon`，绿点=运行/红点=错误/无点=停止，M8.1）+ title；徽标字符专职会话状态层（§8.9）。**M4：settings.port === 0（动态端口）时本地探活不可行，改经 native `status` 判定**（宿主解析实际端口）。
5. 全部 native 消息走 `chrome.runtime.sendMessage` 的 async 应答（`return true` + `sendResponse`）。
6. **兜底超时按动作区分（M1.3）**：restart 120s（宿主内 stop≤10s + start≤30s 串行执行）、start 60s、stop/adopt 45s、其余 30s——避免长操作被 30s 兜底误判为「宿主无响应」而返回 `NATIVE_ERROR`（错误信息内附实际秒数）。

### 8.5 宿主 manifest 与注册（§10 安装器生成）

宿主 manifest（`com.dsh.manager.json`）：

```json
{
  "name": "com.dsh.manager",
  "description": "DSH Manager native host — manages the dsh web process lifecycle",
  "path": "C:\\Users\\<user>\\AppData\\Local\\dsh-manager\\host\\host.cmd",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<固定扩展ID>/"],
  "allowed_extensions": ["<固定扩展ID>", "<gecko id>"]
}
```

说明：

- `path` 指向一个 `.cmd` 包装（Chrome 允许）：内容为 `@echo off` + `"<node.exe>" "<...>\host.js"`；由安装器现场生成绝对路径。
- `allowed_origins` 供 Chrome/Edge 校验；`allowed_extensions` 供 Firefox 校验（**M4 起同时含 Chrome 扩展 ID 与 manifest `browser_specific_settings.gecko.id`（`dsh-manager@local`）**，两者并存无害；Firefox 忽略 `allowed_origins`）。
- 注册表（HKCU，无需管理员权限）：
  - Chrome：`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dsh.manager` → manifest 路径
  - Edge：`HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.dsh.manager` → 同上
  - Firefox（M4）：`HKCU\Software\Mozilla\NativeMessagingHosts\com.dsh.manager` → 同上
  - （可选）Chrome Dev/Canary/Beta 同理各加一条。

### 8.6 页面内管理面板（content script，M3）

§15 M3「Web UI client 插件管理面板（页面内停止/重启）」的落地形态。**方案决策：不用 dsh client 插件**——实测核验 dsh@0.1.0-rc.6 的 Web 客户端插件机制后确认：外部插件需声明 `dsh.client` + 提供 `exports["./client"]` **预构建 bundle**（factory 形式 CJS，构建时纯化门禁，`client-modules` 缺失构建产物时报「run `pnpm run build` before launch」），即客户端插件必须走 dsh monorepo 自身构建链，社区插件作者没有独立构建路径。因此改用**扩展 content script 注入**，零 dsh 构建依赖，扩展一处安装即得，且覆盖任意端口的 dsh 页面（匹配模式忽略端口）。

行为规范（`extension/content/panel.js`，样式内联于脚本）：

1. **指纹激活**：仅当 `document.title` 匹配 `DeepSeek Harness`（与 §6.6 指纹同源）才注入面板，其余本地页面不注入；`window` 级标志防重复注入。
2. **归属验证（仅托管实例可操作）**：页面身份 ≠ 进程归属——指纹激活只说明页面是 dsh 的 UI，不说明其进程由扩展管理（终端/WSL 启动的实例同样满足指纹）。面板每轮 `status` 后做归属判定：仅当返回 `running` 且 `port` 与当前页面端口一致时，「停止/重启」才可用；`stopped`、端口不匹配、外部实例一律降级为只读——状态行显示「此实例不由本扩展管理（请在扩展 popup 中操作）」，徽章显示「未托管」，两按钮禁用（`stopped` 时不再允许「重启=启动」，防止在非本扩展实例页面上误拉起新实例）。**圆点颜色随展示语义而非原始状态**：绿仅表示「本页托管实例运行中」；外部实例（`external` 且端口匹配）为蓝；未托管/已停止/端口不匹配一律中性灰；启动/停止中为琥珀脉冲；「状态获取失败」为红（仅连续失败后，见第 4 条）。
3. **Shadow DOM 隔离**：宿主节点 + open shadow root，样式 `<style>` 内联在 shadow root 内（页面 CSS 不穿透 shadow，双向零干扰）；颜色复用经 CSS 自定义属性继承的 `--dsw-*` 令牌并带 fallback 值。**主题跟随零逻辑**：令牌值从宿主页面继承，页面切深色（`body[data-ds-dark-theme]`）时变量值变化、面板自动跟随（§8.7）；仅 box-shadow 与确认按钮前景色等少量值需兼顾两套主题。
4. **全部动作经 SW 中转 native 宿主**（复用 §8.3 既有 `{type:'native'}` 通道，面板自身不直连 `/_lifecycle`）：2s 轮询 `status`（页面隐藏时暂停）；「停止」两步确认（首次点击进入 3s 待确认态，再点才执行——面板所在页面即将随 dsh 关闭，防误触）；「重启」按宿主 restart 语义（优雅停优先 + 原参数重放，§6.3）；动作在途按钮禁用 + spinner + 内联状态文案。**状态失败容错**：单次 status 失败不立即报红——MV3 SW 休眠/唤醒竞态会让单次消息失败、下一轮即恢复，故连续 3 次失败（约 6s）才显示红色「状态获取失败」，期间保留上次成功状态；扩展在 `chrome://extensions` 重载/更新后，已打开页面里的旧内容脚本上下文失效（`chrome.runtime.id` 为空，孤儿脚本）——此时停止轮询，显示中性灰提示「扩展已重载或更新，请刷新页面恢复」（徽章「已断开」），不再永久误报红错。
5. **不读取页面内容**：面板只读 `document.title` 做指纹判断，追加自身节点，绝不修改 dsh 页面 DOM。
6. 收起态为右下角状态小徽章（圆点 + 文本），点击展开面板；**展开时胶囊位置不变**——面板体绝对定位在胶囊上方弹出（`position:absolute; bottom:calc(100%+8px)`），而非把胶囊顶上去；`prefers-reduced-motion` 关闭动画。

安全（§12.2 补充）：面板是扩展自有 content script（非页面脚本），消息只发给本扩展 SW；停止/重启走宿主全套防护（PID 复用校验、`EXTERNAL_UNMANAGED` 保护、锁、优雅降级链）；不新增任何权限与 host_permissions（回环匹配已有）。

### 8.7 主题与深色模式（M6）

**目标**：扩展全部界面（popup、日志页、页面内面板）支持深色模式，且视觉与 dsh Web UI 深色主题严格一致（同一 `--dsw-*` 令牌体系、同一渲染标记）。

#### 8.7.1 事实基础（F14）

- Web UI 主题偏好三态 `light` / `dark` / `system`（默认 system），存 dsh settings namespace `ui-theme.preference`（host 用户设置文档）。
- 实际渲染以 `body[data-ds-dark-theme]` 属性标记（浅色无属性）；`system` 偏好时由 `prefers-color-scheme` 媒体查询驱动实时翻转。
- 全部 `--dsw-*` 令牌（static / alias / specific）浅、深两套，由 `dsh-client-ui-theme` 注入；深色值驻留在 `body[data-ds-dark-theme]{…}` 块（本仓库提取存档：`tools/ui-theme/dsw-tokens-dark.css`）。
- 主题偏好经 F9/F10 围栏（Settings RPC 为 loopback-gated privileged 域），扩展不能直接读取 → 扩展只做 **DOM 镜像**，不回写 webui 偏好。

#### 8.7.2 主题模型（四态）

| 模式 | 语义 | 取值来源 |
|---|---|---|
| `follow-webui`（**默认**） | 与 webui 实际渲染一致 | storage 镜像 `webuiTheme.dark`；**从未有镜像**时回退系统（仅此一种回退）。注：webui 关闭（标签不存在）后镜像保留最后状态，本模式继续跟随最后镜像而非回退系统——保持「最后一次所见 = 当前呈现」的一致性语义 |
| `follow-system` | 与操作系统一致 | `matchMedia("(prefers-color-scheme: dark)")` + change 监听 |
| `light` / `dark` | 手动锁定 | 硬编码 |

storage 布局（chrome.storage.local）：

```
settings.theme = 'follow-webui' | 'follow-system' | 'light' | 'dark'   ← 扩展现有 settings 对象新增字段
webuiTheme    = { dark: boolean, at: timestamp, port }                 ← panel.js 只读镜像
```

#### 8.7.3 数据流

```
webui body[data-ds-dark-theme] 变化
   └─ panel.js: MutationObserver（attributes + 初始读取）→ chrome.storage.local.webuiTheme
popup / logs 页打开或 storage.onChanged 触发
   └─ theme.js applyTheme(): 解析四态 → <body data-ds-dark-theme> 设/移除 → CSS 换肤
```

- `theme.js`（新，`extension/theme.js`，约 40 行，popup.js 与 logs.js 共用）：`applyTheme()` 读 `settings.theme` + `webuiTheme` 镜像 + `matchMedia`；在 `document.body` 上设/移除 `data-ds-dark-theme`；导出 `initTheme()`（立即应用一次 + 订阅 `chrome.storage.onChanged` + `matchMedia change`）。
- panel.js 的镜像写入幂等（值未变不写），且页面隐藏时照常观察（属性变化与 visibility 无关）。
- 应用时机：popup `DOMContentLoaded` 尽早（避免浅色闪烁）；logs 页同理；主题切换即时生效（无需点「保存」，与 webui AppearanceRow 行为一致）。

#### 8.7.4 各载体行为

| 载体 | 机制 | 备注 |
|---|---|---|
| popup | theme.js 全量 | 打开即应用；open 期间 storage.onChanged 实时跟随（webui 开着时切主题，popup 即变） |
| logs 页 | 同 popup | 与 popup 同主题，无独立开关 |
| 页面内面板 | CSS 变量继承，**换肤零 JS 逻辑** | 永远跟随宿主页面；仅局部值（box-shadow、确认按钮前景色）在两套主题下取合适值（fallback 值保留）。注：panel.js 另含只读镜像 observer（§8.7.3，写 storage 供 popup/logs 消费），与换肤无关 |

#### 8.7.5 设置 UI：外观行

popup 设置面板新增「外观」行（四个互斥选项按钮），复刻 Web UI AppearanceRow 主题立方体视觉（同款令牌）。**2026-08-22 用户决策（M6 后修订）：改为 icon-only——一行 4 列网格，按钮仅显示图标（16×16 outline），hover 时以原生 `title` 弹出文案提示；为有意偏离 webui 原文案版的用户偏好（省约 40px 垂直空间），按钮的无障碍名称由 `aria-label` 提供，点选/选中态/键盘语义不变**：

- 按钮：`border: 1px solid var(--dsw-alias-border-l2)`、`border-radius: 16px`、网格 4 列（`grid-template-columns: repeat(4, 1fr)`）、`height: 32px; padding: 0`（图标水平/垂直居中）；选中态：`background: var(--dsw-alias-bg-module-platform)`（浅色 = bluish-60，深色 = bluish-800，须在两套主题中均定义）+ `border-color: var(--dsw-static-neutral-bluish-400)`。
- 键盘可访问性（radiogroup 规范）：选中项 `tabindex=0`（roving），其余 `-1`；`keydown` 处理 ArrowLeft/Right/Up/Down（循环换选）+ Home/End（首/末），换选即触发 point 即生效。
- 文案：按钮原文案（跟随 Web UI / 跟随系统 / 浅色 / 深色）移入 `title`（hover 提示）+ `aria-label`（读屏名称）；图标 16×16 outline 风格（跟随 Web UI 用鲸鱼剪影，其余用太阳/月亮/显示器，与 webui 同款提取，来源注明）。
- 点击即写 `settings.theme` 并即时应用（不改变「保存」按钮语义——保存只管 port/profile/autoOpen/badge）。
- 安全：主题值白名单校验（四态枚举），非法值落回默认。

#### 8.7.6 深色令牌落地（CSS）

1. `popup.css` / `logs.css` 各加 `body[data-ds-dark-theme]{…}` 块：深色 static + alias 令牌（取自 `tools/ui-theme/dsw-tokens-dark.css` 提取存档，值与 webui 逐字一致）＋ 该块内 `color-scheme: dark`（webui 未显式声明，浏览器默认随系统，行为等价；原生 checkbox/number spinner 在扩展页内才正确变深）。
2. `.btn.primary` 改 `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground`（浅色视觉不变；深色 = 近白底/深字，与 webui 主按钮一致；现用 `brand-primary`+`bluish-00` 在深色下会白底白字，必须修正）。
3. toast 三色变体（success/error/info）硬编码浅色背景 → 深色下换 `--dsw-alias-toast-bg` / `--dsw-alias-bg-layer-*` + 对应 state 文字色；`.error` 面板、`.field-invalid` 红系 rgba → 深色语义。
4. 固定 box-shadow（popup/panel 的 `rgba(15,17,21,…)`）统一到 `--dsw-shadow-lv1/2`（webui 浅深通用）。
5. `prefers-reduced-motion` 覆盖不动。

#### 8.7.7 验收

- `tools/verify-ui/verify-cdp.js` 新增深色断言：① popup 设 `settings.theme:'dark'` → `body[data-ds-dark-theme]` 存在 + 背景计算色为深色值；`'light'` 反之；`'follow-system'` 用 CDP `Emulation.setEmulatedMedia` 翻转系统主题断言跟随；② 镜像链路：模拟 storage `webuiTheme` 写入 → popup 跟随；③ 面板：宿主页面 body 属性翻转后 shadow 内面板计算背景同步变化（抽取自定义属性计算值或背景色比对）；④ 截图浅/深两套存档（vision 核验）与 console 零异常。
- 视觉抽查：popup 浅/深截图对照 webui 存档截图。

### 8.8 popup 排版优化（M7，方案 A：应用栏 + 状态卡 + 分组设置）

**目标**：解决 §8.2 现行排版的「平铺朴实感」——信息无分区、重量均等、按钮不突出。保持与 webui 设计系统一致（全部 `--dsw-*` 令牌，零新增色），深色随 §8.7 令牌自动适配。
**设计参考产物**：`tools/ui-theme/mockup-preview.html`（方案 A 高保真预览，浅色两状态：默认视图 + 设置面板；用 `vision_html_screenshot` 渲染核验）。

**布局（新三区结构，覆盖 §8.2 布局示意图的呈现层）**：

```
┌──────────────────────────────┐
│ 🐳 DSH Manager  [dsh web]    │  ① 应用栏：小鲸鱼 20px + 名称 15/600 + 胶囊标签
│                 [⊙刷新][⚙]   │     （右）圆形图标按钮 28px（hover 浅底）
│ ┌──────────────────────────┐ │
│ │ ● 运行中        端口 8080  │ │  ② 状态卡（焦点区）：bluish-60 底 + border-l1 + 圆角 12
│ │ 健康 · 76m43s · PID …     │ │     左：10px 分层圆点 + 状态词 13/500；右：端口 12/500 蓝
│ └──────────────────────────┘ │     第二行：次级信息 11.5px caption 色（tabular-nums）
│ [ 启动 ] [ 停止 ] [ 重启 ]    │  ③ 操作区：主操作 h32（primary/danger/outline 同现有语义）
│ [    打开 Web UI        ]    │     「打开 Web UI」全宽 ghost（bluish-60 底 + business 蓝字 500）
│ ──────────────────────────── │  ④ 底栏：border-top-l1 + 提示 11px caption + 「查看日志」link
│ 优雅停机已启用   [查看日志]    │
└──────────────────────────────┘
```

**组件规格**（数值/色值，均取自现有令牌）：
- 面板：`padding: 16px 14px 12px`；应用栏行高 28、间距 12。
- 状态卡：`background: var(--dsw-alias-bg-module-platform)`（浅=bluish-60 #f5f6f7 / 深=bluish-800）+ `border: 1px solid var(--dsw-alias-border-l1)` + 圆角 12 + `padding: 10px 12px`。
- 状态词层级：13/500 `--dsw-alias-label-primary`；端口 12/500 `--dsw-alias-state-business-primary`；次级行 11.5px（11px 与 12px 间，用 `font-size: 12px` + caption 色亦可，实施时二选一并保持三页一致）。
- 状态变体（卡片整体配色随语义）：
  - running：常规（背景如规格；绿点，**实心点呼吸 2.2s**——用户偏好（2026-08-22 反馈）：光晕太淡难观察，呼吸作用于**实心点**（opacity .5↔1 + scale .88↔1，肉眼可见的脉动），光晕同步 .08↔.16；浅深通用；`prefers-reduced-motion` 关闭；页面内面板/logs 页同源规则）；
  - stopped/未托管：圆点灰、状态词 label-secondary；
  - external：蓝点（同呼吸）、端口显示；
  - starting/stopping（含操作在途）：**琥珀圆点脉冲**（1.2s `dsh-dot-pulse`）+ 状态词琥珀 warn——webui 点阵语义为「长时进行中的会话工作」，扩展 busy 是秒级过渡态，语义不匹配（§8.8.1 已撤销，2026-08-22）；
  - error：卡片红调（`border-color: rgba(236,19,19,.25)` + 状态词 error 红），错误详情仍走既有 error 面板。
- 注（2026-08-22 用户反馈修补）：**logs 页状态点只表达 dsh 运行状态**（error/running/stopped）——页面日志请求在途（busy）不得映射到状态点（原实现把 2s 自动刷新的请求窗口映射为 dot-busy，绿点每 2s 短暂变 Matrix，观感为「点阵闪现」）；popup 状态卡与面板 chip 的 busy=真实 dsh 状态转换/操作在途（琥珀脉冲）。
- 底栏：`border-top: 1px solid var(--dsw-alias-border-l1)`；提示 11px caption；「查看日志」link 12px business 蓝（hover 浅底）。
- 设置面板（内嵌视图）：分组标题「服务」「界面」11px / 500 caption 色 + 组间距 12；表单行保持现有 `.field`；「外观」四 cube 保留（§8.7.5）；actions 在分组外底部（与现状一致）。

**§8.8.1 Matrix 动效（已撤销，2026-08-22 用户复盘；提取存档见 git 历史）**：webui 会话侧栏
「正在工作」点阵（SVG 10×10 viewBox、3×3 外圈 8 个 2×2 rect、`@keyframes dot-chase` 1s 循环、
125ms 相位差）的语义是**长时进行中的会话工作**（连续数秒至数分钟）；扩展的 busy 态
（starting/stopping/操作在途）是**秒级过渡态**，1Hz 追逐动画套在短暂状态上观感为「点阵
闪现」，语义不匹配 → **不使用**。busy 态统一用琥珀圆点脉冲（1.2s，`dsh-dot-pulse`），
与 webui「过渡中」信号一致；`.dot` 的 class 名与语义保留（`dot-busy` 不改名）。

**实施清单（文件级）**：
1. `extension/popup.html`：应用栏/状态卡结构替换（保留全部既有 id 与语义钩子：`dot`、`btn-*`、`settings-panel`、`theme-grid` 等，仅调整结构与 class）；品牌 wordmark 换 20px 鲸鱼 + 文字（鲸鱼 path 复用现有内联）。
2. `extension/popup.css`：新增 `.appbar/.brand/.statuscard/.ops/.foot/.s-group/.statuscard.error` 等样式；删除/替换原 `.status-row/.url-row/.detail/.hint-row` 的部分规则（保留接口类名不变的规则）；busy 琥珀脉冲沿用既有 `.dot-busy:after`（Matrix 已撤销，见 §8.8.1）。
3. `extension/popup.js`：结构变更后的事件绑定与 getElementById 目标核对（id 不变则基本无改动；状态卡渲染逻辑从「三处文字行」合并为卡片内两行——实现 `renderStatusCard()` 并把 `dotStateClass()` 的语义映射迁入）。
4. `extension/content/panel.js`：chip busy 态 = 琥珀脉冲（保持 `dot-*` class 语义与 10px 尺寸；Matrix 已撤销）。
5. `extension/logs.css`/`logs.js`（如有 log 页状态点 busy 态）：同上。
6. `tools/verify-ui/verify-cdp.js`：新增/更新断言——状态卡结构与文案（`.statuscard` 存在、状态词/端口/次级行文本）、busy 态琥珀脉冲（dot-busy + `:after` 动画非 none + 无 matrix）、错误态红调卡片、深色下状态卡背景翻转；截图 `popup-m7.png`。
7. `tools/ui-theme/mockup-preview.html`：已入库（本设计参考）。

**验证**：先跑基线 `verify-cdp.js`（50 PASS）→ 实施 → 全量 + 深色截图 vision 核验；`node --check` 全部受影响 JS。

**决策点默认取向**（实施时若用户无异议按此执行）：
- 「dsh web」胶囊标签：保留（指示连接目标）。
- 状态卡第二行信息：保留完整（健康/uptime/PID），窄屏溢出自适应省略。
- 错误态：红调卡片（见状态变体）。
- Matrix 动效：已撤销（2026-08-22 用户复盘——webui 点阵语义为长时进行中，扩展 busy 是秒级过渡，不适用；busy 用琥珀脉冲，见 §8.8.1）。

### 8.9 徽标提醒「该点回来看看了」（M8）+ M8.1 徽标语义重构（2026-08-22 用户决策）

**目标**：用户不长时间驻守 dsh 标签页（切去别的标签/窗口，或窗口最小化）。这时 dsh Web UI 里「一轮工作完成」或「会话正在等你拍板（批准 / 问答 / 计划审查）」应经**工具栏徽标**提醒用户回来——徽标是扩展已有的常驻信息面（§8.3），零新增权限、零持续后台占用（检测发生在已注入的 content script 里，SW 只在事件驱动的消息时唤醒）。

**M8.1 语义重构（用户决策）**：原 M8 把「实例运行状态（绿●/空白）」与「会话提醒（紫?/琥珀!）」都塞进徽标字符，两者互斥覆盖——显示「?」时看不到实例状态，且实例停止后提醒仍残留（4h TTL）。重构把两个语义层**拆分到双载体**（§8.9.1 表）：

| 载体 | 语义层 | 表达 | 说明 |
|---|---|---|---|
| **图标角标**（action.setIcon 预生成 PNG 变体） | 实例状态层 | 绿点=运行中、红点=错误/未装宿主、无点=停止 | 与徽标同屏共存，不互斥覆盖 |
| **徽标字符+色**（action badge） | 会话状态层 | 黄「?」=等你（待确认）、绿「!」=工作完成（事件提醒）、**蓝 n**=n 个会话工作中、空=安静 | 等待/完成两色均取 `settings.colorMap`（M10.1 定稿：等待黄 #f59e0b、完成绿 #22c55e——与 webui 计划面板黄及「完成=绿」同构）；工作蓝 #5686fe = webui `--dsh-state-ongoing` 同源色 |

优先级：**waiting（黄?）> done（绿!）> working（蓝 n）**；多 tab 全局聚合（working 计数求和、waiting/done 任一即有）。字符上限「9+」（徽标字符区约 2 字符）。

**独立开关**：`settings.attentionDone`（默认 true，popup「界面」分组新增「徽标：工作完成提醒（绿!）」）——done 事件可单独关闭；总开关 `settings.attention` 关闭则整个会话状态层停显（徽标空，角标照常）。**自定义语义（预设档位/每状态字符映射）——M10.1 起字符仍锁定（用户问询 emoji 后决定暂不引入，字符语义= ! / ? / n 不变；文字状态词永锁）**。

**触发信号（webui 事实基线，取自 `@deepseek-ai/dsh-client-ui-workspace` 0.1.1-rc.2 客户端包与 `dsh-web-frontend` bundle）**：会话侧栏行由 `StateDot` 渲染——**工作中** = `svg[data-state="ongoing"]`（基线为 10×10 点阵追逐动画；2026-08-22 用户实测当前版本渲染为**蓝色状态标签**（如「Deep diving…」，`--dsh-state-ongoing: --dsw-static-deepseek-450` #5686fe）；徽标蓝 n 与 webui 同源）；**等待用户**（pendingInteraction: approval / question / plan-review）= `span[data-state="warning"]`；空闲/完成 = `data-state="done"`。这组 `data-state` 值是 StateDot 的**语义 API 属性**（非 CSS-module 哈希类名），跨 webui 版本漂移风险低。

> **数据源修订（2026-08-24，徽标←→popup 会话区计数一致性）**：`data-state` 是 webui **显示态**，相对服务端事件流存在前端渲染延迟——会话完成/空闲瞬间扫描会拿到旧计数，且同实例多标签各自上报会被重复累加，产生「徽标蓝 2、popup 会话区进行中 1」的偶发不一致（2026-08-23 用户实机反馈）。**计数改为优先读服务端点** `GET /_manager/sessions`（§8.10，与 popup「会话」区同一端点、同一状态判定），`data-state` DOM 扫描仅作**回退**（插件未装/旧版/端点失败；此时 popup 会话区为降级/隐藏路径，无数字不一致的用户可见面）。同实例多标签的重复计数由 SW 聚合去重（见下第 3 条）。

**行为规范（`extension/content/panel.js` 检测段 + `extension/background.js` 双载体渲染）**：

1. **检测（panel.js，只读；2026-08-24 数据源修订）**：与面板共注入（同一指纹激活）。每 1s 取一次计数快照，**端点优先**：同源 `fetch('/_manager/sessions')`（1.5s 超时，失败静默；只读摘要元数据，与 §8.10 同口径，不读消息内容/文本）→ 统计 `items` 中 `state==='working'` / `state==='waiting'` 的数量；端点不可用（插件未装/旧版/网络失败）时**回退** DOM 扫描（`svg[data-state="ongoing"]`、`[data-state="warning"]` 两个选择器 `querySelectorAll().length`，只判定存在性并计数）。状态机：`idle → working →(稳定 1.2s 空态)→ done-fired`；`任意 → waiting-fired`（waiting 出现立即上报，优先级覆盖 done）。等待用户 outranks 工作进行中（用户侧语义：需要拍板 > 继续观察）。注：隐藏页定时器被 Chrome 节流至 1Hz，取 1s 周期与节流上限对齐；端点快取在途（超时最长 1.5s > 1s 周期）时跳过重叠 tick。
2. **触发即上报（页面隐藏时；计数签名变化才发）**：仅在 `document.hidden === true`（标签不活跃或窗口最小化）时上报；`set`: `{type:'attention', op:'set', kind:'idle'|'working'|'waiting'|'done', counts:{working,waiting}}` → SW；**waiting:0→working:0 的计数签名（`waiting:working`）变化即上报**（蓝 n 常驻概览的数据源），`done` 为工作→空闲稳定 1.2s 的事件上报；SW 侧 `sender.tab.id` 为事实键（多个 dsh 标签页各记各的）。**页面重新可见即发 `op:'clear'`**（防「用户已在看却仍挂提醒」）。
3. **SW 侧（background.js）**：`attentionMap`（storage.local，`{ [tabId]: {kind, working, waiting, at, port} }`）持久化——MV3 SW 可回收，徽标状态以 storage 为事实源；`tabs.onRemoved` 清理；**同标签导航离开 dsh（tab 未关闭）由 `tabs.onUpdated` 按 URL 判定清理（M8 修补 M2，content script 侧 pagehide 亦发 clear 双保险）**；`onStartup`/`onInstalled` 清空（浏览器重启/扩展更新后的旧提醒无意义，沿用占位即可）；4 小时 TTL 防僵尸键（兜底，不影响正常使用）。**同实例多标签去重（2026-08-24 修订）**：聚合前按条目 `port` 归并——同端口只保留 `at` 最新条目（idle 无信号条目不参与同端口竞争，保持「空=安静」语义）；无端口条目（外部/旧数据兼容）按 tab 独立参与。徽标渲染优先级：**waiting（黄「?」#f59e0b，M10.1 定稿）> done（绿「!」#22c55e，M10.1 定稿——原琥珀!随「完成」定稿改绿）> working（蓝 n #5686fe，n≥10 显示「9+」）**；文字色显式 `#ffffff`。**死提醒联动（M8.1 修补）**：refreshBadge 判定实例未运行/异常时，按条目 `port`（上报时从 tab.url 解析）清除对应端口的会话信号——此前「实例已停、黄?/绿! 仍挂 4h TTL」的误导场景。title 同步：等待/完成/工作三条文案 + 服务态（角标层）title。
4. **设置**：`settings.attention`（默认 `true`，popup 设置面板「界面」分组开关「徽标提醒（回来看看）」）——关闭后 SW 忽略 set 且清空累积条目（`handleAttention` 的 set 分支以前置判断拒绝 + storage.onChanged 在开关变 off 瞬间清空 attentionMap），否则关闭期间的条目会在重开开关时冒出一条「凭空」提醒（H1 修补；M8.1 盲审补正：清理以**本次变化的权威值**为基——单次 set 同时改 settings+attentionMap 时 onChanged 回调内 settings 分支先于 attentionMap 分支、快照条目尚未入内存，旧实现会清理扑空，且 newValue 旧快照会把已删条目恢复回内存，已加 purged 防恢复）。`settings.attentionDone`（默认 `true`，「徽标：工作完成提醒（绿!）」独立开关）——已上表的 done 事件单独可关，waiting/working 不受影响；关闭瞬间同样剔除既有 done 条目（H1 对称修补），期间 done 也不会被新写入（set 分支前置拒绝）。
5. **防误报**：① 完成判定需空态稳定 1.2s（React 重渲染/点阵属性瞬时抖动被吸收）；② 工作→空闲→再工作 可再次上报（每次真实完成都提醒，cooldown 由「见到新 working 才复位」保证——done-fired 后须再观测到 working 才可能再次 done-fired）；③ sending 失败（SW 休眠/唤醒竞态）静默吞掉（storage 缓存与下游 clear 自愈）。
6. **局限（v1 接受并记录）**：端点路径下徽标计数与 popup 会话区同源一致（2026-08-24 起）；DOM 回退路径（插件未装/旧版/端点失败）保留历史局限：会话侧栏**完全关闭**（sidebar 宽度 0，行组件卸载）时无标记可扫，检测不可用（默认布局与窄屏 rail 均渲染行，仅完全关闭受影响）；用户仅 alt-tab 到其他应用（窗口未最小化、标签仍是活动标签）时 `document.hidden` 为 false，不触发——这是浏览器页面可见性语义，无法绕过；**蓝 n 仅在至少一个 dsh 页面存在且后台时可用**（无页面=无会话信息=徽标空，∈双向分层）。
7. **安全**（§12.2 补充）：端点路径只读 `/_manager/sessions` 的**摘要元数据**（sessionId/标题/四态/时间戳，与 popup 会话区间源同口径，不读消息内容/文本——§8.10 已定「摘要」边界），仅同源请求（页面 origin = 实例 origin；插件 `allow()` 围栏对回环 + 同源放行，§12.1）；DOM 回退路径只读两个语义属性（存在性/计数判定），不读取/采集页面 DOM 内容与消息文本；上报消息只含 kind（四值枚举）+ 计数值 + 端口（从 tab.url 解析）；SW 只接受带 `sender.tab` 的上报（扩展自身页面无 tab，不可伪造他 tab），**并校验 `sender.tab.url` 为 dsh 回环页**（127.0.0.1/localhost，本扩展 host_permissions 恰好覆盖，无新增权限）；无新增权限与 host_permissions。

#### 8.9.1 三层颜色语义分层（避免跨载体混淆，2026-08-22 用户决策）

三处视觉载体属于**两个不同语义层**，颜色与字符的「主语义载体」不同，必须明确区分：

| 载体 | 层级 | 主语义载体 | 语义色表 |
|---|---|---|---|
| **图标角标**（setIcon 变体） | 实例状态层（服务生命周期） | **颜色**（角标点） | 绿=运行中、红=错误/未装宿主、无点=停止 |
| **工具栏徽标** | 会话状态层（全局聚合，任意 dsh 标签） | **字符**（`?` 等你/待确认 / `!` 完成待办 / `n` 工作中数 / 空 安静） | **黄=等待**（`#f59e0b`，M10.1 定稿）、**绿=完成**（`#22c55e`，M10.1 定稿——原琥珀「!」随「完成」定稿改绿）、**蓝=工作中**（#5686fe webui 同源）、空=安静 |
| **popup 状态卡圆点** | 状态展示层（服务生命周期） | **颜色** | 绿=运行/健康、蓝=外部实例、琥珀=启动停止过渡、红=错误、灰=已停止 |
| **页面内胶囊 chip dot** | 状态展示层（**本页**托管实例） | **颜色** | 同上 + 灰=未托管/端口不匹配、红=连续失败 |
| logs 页状态点 | 状态展示层（运行状态） | **颜色** | 绿/红/灰 |

**约定（防混淆的硬规则）**：
- **红色只属于「错误」语义**（状态层）；徽标提醒层**不使用红色**。（2026-08-22 用户决策原立「紫=等你拍板专用」；M10.1（2026-08-24）用户实机观察 Web UI **计划面板=黄色**并定稿：等待语义改琥珀黄 `#f59e0b`——**紫色退出默认色板**（不再专语义），「等你」与「完成待办」在不同载体上以字符（? / !）区分，与「琥珀=完成待办」原约定同法。）
- **琥珀**在徽标=等待（`?`）/完成待办历史配色由**绿**取代（M10.1 定稿）、在状态层=过渡态（busy）——互不同时出现视觉冲突：状态层琥珀仅在 popup/面板内；徽标层靠字符（? / !）天然区分。
- **徽标（会话层）与图标角标（实例层）双载体并存、互不覆盖**：看到徽标「?」应理解为「某个 dsh 页面有状态变化」（实例是否在跑看角标点）；实例状态卡/胶囊是**单实例视图**——具体信息请点开 popup/对应页面查看。

### 8.10 扩展面板会话状态（M9，路径 3：dsh 插件侧只读端点）

**目标（2026-08-22 用户需求 + 决策）**：把扩展管理的实例（含接管实例，§6.6/§6.7）的**运行会话状态**放进 popup——只查状态（进行中/等你拍板/已完成/空闲），不查看会话内容。用户决策：**直奔路径 3**（dsh host 插件侧新增只读端点，而非扩展侧 DOM 扫描或宿主直连官方 /api）。

**事实基线（2026-08-22 本地包核验）**：
- 官方 `POST /api/session.list`（dsh-host-apiproxy）返回 `sessionSummarySchema`：`sessionId/updatedAt/running/blank/parentSessionId/origin/cwd/agentPreset/projections`——**无 title、无 pendingInteraction**（等待语义不在列表 RPC 上；详情经按会话查询）。
- `/api` 围栏 = 只收 `application/json`（浏览器必发预检、服务器不应答 → **扩展/网页直连被拒**）；native host 是 Node fetch（无 CORS），技术上可直连——但**路径 2（宿主直连官方 API）被否决**：官方 API 无稳定性承诺（基线 0.1.0-rc.6）、等待语义取不到、宿主与 dsh 内部形状耦合加深。
- dsh-lifecycle 插件（§7）已实证：host 插件 `ctx.get('webServer')` 注册 loopback 围栏端点（`allow()`：remoteAddress 回环 + Host 回环 + sec-fetch-site 拒跨站 + Origin 同源），扩展→宿主→HTTP 链路无 Origin 天然合规。
- apiproxy 源码显示 host 侧服务面含 `workspaceRegistry / sessionQuery / sessions / sessionTitle` 等（**具名与可用性实施期 spike 确认**）。
- **M9.1 spike 结论（2026-08-23，0.1.1-rc.2 事实基线）**：主机侧全部信号均可权威读取，无需依赖 apiproxy 内部状态：
  - 会话清单：`ctx.sessions.list()`（live 会话，创建序）、`sessions.get(id)`、`sessions.flush(session)`（dsh-session 服务已核验）；
  - running：`ctx.get('agents')?.get(id)?.status === 'running'`——与 apiproxy `summarizeAttached` 同款判定；
  - title：fold 会话事件流中 `session/title` 事件（`events.findLast(e => e.type === 'session/title')?.data.title`，该事件由 session-title 服务 append，内容已归一化）；无标题事件 → 降级「会话 #<id 前 8>」。**不依赖 sessionTitle 服务本身**（事件流是唯一权威），避免服务缺挂时插件挂起；
  - waiting：事件流判定——`approval/asked`（data.id）无匹配 `approval/decided`（apiproxy 1909-1918 同款回扫逻辑）→ 等待审批；或 `tool/call`（name=`ask_user_question`，dsh-tool-ask-user 工具）无匹配 `tool/result`（callId 配对）→ 等待问答。plan-review 是 question 子类型（`question/requested` 帧内 `questions[].intent.kind === 'plan-review'`，dsh-client-runtime 7783-7787 核验）——按 §8.10 契约 4 态无需细分，统一归 `waiting`；
  - completed：events 含 `turn/end` 且非 running 非 pending（webui 侧为客户端 running 边沿推断，host 侧以 turn/end 存在性等价近似）；
  - idle：其余（blank / 无 turn/end）。
  - **范围决策**：v1 端点只返回 **live（attached）会话**——§8.10 验收 e2e 场景（start → 当前会话行 → 状态流转）即 live；冷会话（历史）状态恒为 completed/idle、title 需读持久化，价值低且增加读盘成本，留给后续增强。
  - **idle 实际存在性注记（2026-08-24 用户实机观察）**：新会话默认**不在** Web UI 会话列表；创建后才出现，但**若未发送任何内容就离开该会话，它不会存在**（不保留下落）。即"空壳会话"（blank）在 live 集合里实际不出现——idle 的典型场景进一步收窄为"已承载内容但从未完成过任意一轮"的边角情形（近零出现）；这也解释了用户"空闲没用"的直觉（Web UI 本体同样不分 idle/completed，统一 data-state=done）。倾向：若后续优化，以 popup 折叠/弱化 idle 为优先（不动契约）。
- **D1 决策（2026-08-23 定稿）**：扩展现有 `dsh-lifecycle` 包（同一安装/升级面、同一 cordis.patch.yml 挂载、单测/README 同源），不新建 `dsh-manager-sessions` 包。

**端点契约（设计定稿）**：

```
GET /_manager/sessions          （dsh 配套插件，lifecycle 同款 allow() 围栏；只读幂等）
200 → { ok: true, items: [ { sessionId, title?, state: 'working'|'waiting'|'completed'|'idle',
                             updatedAt, blank, cwd?, workspaceId?,
                             hasActiveChildren, childRuns: [ { childId, label? } ] } ] }
403 → 围栏拒绝；404 → 端点未注册（= 插件未装/版本过旧）；405 → 非 GET
```

- **契约演进（M11，2026-xx-xx 定稿）**：items 新增 `hasActiveChildren`/`childRuns`（子代理感知）——父会话事件流中 `subagent/start`（runId）无配对 `subagent/end` 即视为活动子代理（官方 dsh-subagent lifecycle 边缘写入父会话日志；配对判据权威：覆盖 cold-resume 新 epoch、孙子代链 end 延迟、中断/取消 end 照发）。`label` 折叠自子代理会话自身 `subagent/descriptor` 事件的 label 字段（无则不返回，客户端降级显示「子代理」）。**origin='subagent' 会话不单独出列**（官方 Web UI 亦隐藏；运行状态归并进父行）。**官方归档对齐**：`ctx.get('workspaceRegistry')?.archivedSessionIds` 命中即过滤；**但已归档且仍有活动子代理的会话保留**（感知优先：工作未真正结束）。workspaceRegistry 缺失部署自然降级为不过滤。

- `state` 映射：`running && pendingInteraction` → `waiting`（等待：批准/问答/计划审查）；`running` → `working`；`completed` → `completed`；其余 → `idle`。**契约仍为 4 态（后端完整语义）；M10.1（2026-08-24 用户定稿）扩展展示层只呈现 3 态**（遵循 Web UI 的区分：进行中/等待/完成——`idle` 不渲染：用户实机观察新会话默认不在列表、未发内容即离开则会话不存在，idle 在 live 集合近零出现，且 Web UI 本体也不区分 idle/completed（统一 data-state=done）；见上「idle 实际存在性注记」）。**字段缺失时降级**：title 不可得 → 会话行显示「会话 #<id 前 8>」；pendingInteraction 不可得 → `waiting` 不可判（仅 working/idle，如实标注）。**内容零读取**：端点只出摘要元数据，不读消息/事件体。
- 插件包形态：**D1 决策点**——扩展现有 `dsh-lifecycle` 包（同一安装/升级面，推荐）或新包 `dsh-manager-sessions`（语义命名更清晰，但多一个挂载/升级面）。

- **演示层（M11 定稿，UI 走查 V1 落地）**：`state` 契约仍 4 态；展示演进为 **四态感知**——`waiting`(待确认,琥珀黄) > `working`(进行中,蓝) / `completed+hasActiveChildren`(**已停止**,绿,主会话已停但子代理在跑,恒显不受时长/已读约束) > `completed` 无子代理(**已完成**,绿,仅"新鲜"显示);`idle` 不渲染。**新鲜 = 完成时刻距今 ≤ `settings.retentionMins`（默认 30，合法 5~1440，0 = 从不显示已完成）**。**已读机制（本地展示层，不触碰 dsh 数据）**：已完成行 hover 出现「已读」（原地微药丸「已读 · 撤销 3s」，倒计时结束落库 `readSessions`{sessionId:readAt} 并移除行；期内可撤销）；显示判定 `updatedAt > readAt`；会话重新活跃自动重现；再次完成后需再次已读。**子代理行**：父行下方缩进连接线 + 标签(label||「子代理」) + 「进行中」(蓝,shimmer)。排序：待确认 > 进行中/已停止 > 已完成；同组 updatedAt 降序。计数「N 活跃」= 主会话行数（子代理行不单独计数）。徽标口径：有子代理运行归入进行中（蓝 n 优先于完成提醒）。

**扩展侧**：
- host 新增只读 action `sessions`（§6.3 白名单 + SW `{type:'native'}` 通道复用，无新权限）；经宿主 fetch `http://127.0.0.1:<port>/_manager/sessions`（1.5s 超时，失败静默→会话区显示降级提示）。
- popup 新增「会话」区（状态卡下、操作区上，可折叠、默认展开）；会话行 = 标题 + **状态圆点色表（状态展示层扩展；M10 起色值走 `settings.colorMap` 语义变量；M10.1（2026-08-24）定稿三态三色：进行中=webui 蓝 #5686fe、等待=琥珀黄 #f59e0b（与 webui 计划面板黄色同构）、完成=绿 #22c55e；**idle 不渲染**（见上））**：蓝=进行中、黄=等待、绿=完成。**防混淆硬规则**：会话行**永远带文字状态词**（颜色是辅助；M10.1 定稿状态词：进行中 / **待确认** / 已完成——「等你拍板」口语祈使句正式化为「待确认」，2026-08-24 用户拍板）；「蓝=进行中」与顶层状态卡「蓝=外部实例」靠区域 + 文字区分（§8.9.1 表扩展注记）。**圆点动画与结构（2026-08-23 实机反馈补定，第二次修订，定稿）**：会话点为**分层圆点**（复刻 `.dot` 组件：外圈 10% 光晕 + 内实心——用户反馈「会话点没光晕」；**尺寸与实例点统一 10px**——M9 初版 8px 是次级元素旧尺寸，升级为同款组件后大小差不一致）；**四态全呼吸 2.2s**（用户决策：各颜色/状态都要呼吸；动画仅辅助，文字状态词仍为主语义——§8.9.1 防混淆规则不因动画弱化）；**呼吸全 popup 同步**（实例状态点 + 全部会话点同周期同相位——popup.js 以打开时刻（`BREATHE_T0`）为时钟零点，渲染时负 `animation-delay`（`--dot-align-delay`，注入元素 inline 变量，伪元素经 var() 继承）折算回零点相位，消除「CSS 动画自元素插入时起算」的天然相位差；实例点 className 不变时轮询不重设 delay（防动画重算跳变）；busy 脉冲（1.2s 秒级过渡态）不参与对齐）；`prefers-reduced-motion` 全局关闭。
- **行交互修订（2026-08-23 实机反馈，原「行点击 → 打开该实例 Web UI」撤回）**：实测发现 Web UI **无 URL 会话深链**（无 query/hash 路由，打开后恢复 localStorage 的「上次选中会话」）——行点击只能打开实例首页，落点首屏是**另一会话**（点 B 行却进 A 会话），构成误导交互。修订：**会话行为纯展示（无 role/tabindex/pointer/点击），导航交互收回给语义明确的「打开 Web UI」按钮**；「会话深链」列为后续增强（见下）。
- **会话深链（规划，属 §8.11 快速入口象限——是"带路"而非"会话内操作"）**：待 Web UI 支持 URL 定位指定会话（如 `?session=<id>` / hash 路由）后，行点击改为以 sessionId 打开指定会话的 URL；**在此之前不提供页面内模拟点击**（§8.6「页面唯一写操作=追加面板节点」与 §8.11 边界不变）。
- **降级**：插件未装/端点 404/HOST 未装 → 会话区显示中性提示「安装/升级 dsh 配套插件后可用」，不阻断其余功能（会话区隐藏而非报错）。

**验证（§14 扩展）**：插件单测（端点响应/围栏/幂等 + ctx 服务 mock）；宿主 smoke 新场景（fake-dsh 增 `/_manager/sessions` 应答；`sessions` 动作参数与超时）；verify-cdp popup 断言（mock SW 应答 → 会话区渲染 + 状态圆点 + 降级提示 + 行点击）；真实 dsh 实例 e2e（§14.2 追加步骤：start → 会话区出现当前会话行 → 状态随会话流转）。

**里程碑拆解**：M9.1 可行性 spike（临时 dsh 实例 + 探测插件打印 ctx 服务可用性与字段；确认 title/pendingInteraction 可读性）→ M9.2 插件端点 + 单测 + smoke → M9.3 host `sessions` + popup 会话区 + verify 断言 → M9.4 真实实例 e2e + §12.3 数据边界补充（会话元数据=只读摘要，不读消息体/凭据，范围不变）。

---

### 8.11 扩展能力边界（防「喧宾夺主」规范，2026-08-23）

> 本节的动机（用户提出）：扩展会随迭代膨胀——功能越加越多，就会不自觉去复制 dsh web UI 的职责，变成「第二个 dsh 客户端」；扩展应当**始终守在其专属的薄壳位置**。本节是所有新增功能（规划/实现/评审）的**强制对照表**。

**定位一句话**：DSH Manager 是 dsh web 的**管理仪表盘 + 遥控器**，不是第二个 dsh 客户端，更不是替代 web UI 的入口；「使用 dsh」永远回交 web UI，「管理 dsh 进程」才是扩展的正业。

**能力四象限（扩展应做的全部，能力地图）**：

| 象限 | 内容 | 说明 |
|---|---|---|
| ① 生命周期管理（核心专长） | start / stop / restart / adopt、端口回填、日志尾读、优雅停机链 | dsh 自身与 web UI **都不提供**的进程管理——这是本扩展存在的唯一理由 |
| ② 状态情报（摘要层） | 实例状态、健康富状态、会话四态摘要、徽标提醒 | **只做摘要、存在性、计数**；永远不做内容 |
| ③ 快速入口（薄壳） | 打开 Web UI、日志页、跳转 | 把「进一步使用」交回 web UI，扩展只负责带路 |
| ④ 安全护栏 | PID 复用校验、外部实例只读保护、跨宿主锁、回环围栏、两步确认 | 破坏性动作的护栏属于本扩展（双保险），但**绝不扩展护栏之外的权力** |

**不该做（红线，六条）**：

1. **不做会话内容体验**：不渲染会话历史 / 消息流 / 对话 UI / 附件预览——那是 web UI 的领域；扩展只出摘要行 + 跳转入口（M9 已确立「摘要粒度是上限」）。
2. **不做会话内操作**：不发起 prompt / steer / cancel / 模型选择 / 审批问答 / 计划审查等会话内动作——这些属于 dsh 客户端侧（web UI 或客户端插件生态）；扩展若做即复制 dsh client、绕过官方 `/api` 围栏并与其 UI 竞态。
3. **不替 dsh 做配置与编排**：不改 agent preset、不写 profile / settings、不代装代卸 dsh 插件（可做「检测 + 提示 + 跳转」，执行权在用户/终端/dsh 侧）。
4. **不做完整状态镜像**：完整会话列表、内容搜索、工作区浏览、冷会话历史——都留给 web UI（其本身已演进这些能力）；扩展的会话视图只限「live + 四态摘要」。
5. **不碰凭据 / 数据**：不读 `$DSH_HOME` 凭据、模型密钥、会话持久化文件、工作区内容（§12.3 数据边界，此处作为边界重申——「内容零读取」是硬线）。
6. **不越权管理任意进程 / 端口**：只管理「run 记录实例」+「指纹确认的外部 dsh」；绝不把 taskkill / 端口扫描 / 进程枚举泛化到「顺手的其他东西」（§12.1 攻击面收敛）。

**三问准则（新功能立项自检，全部通过才允许进规划）**：

1. 这是「**管理实例**」还是「**使用 dsh**」？→ 只做前者；后者一律回交 web UI。
2. 数据是「**摘要元数据**」还是「**会话内容**」？→ 只碰前者；内容零读取。
3. 缺了扩展，用户能否在 web UI / 终端完成这件事？→ 必须能（扩展是增强不是必需路径——生命周期管理除外，那是正业）；若「扩展独有才能做」且它属于使用体验 → 多半是走错了层（应下沉为 dsh 客户端插件/上游能力）。
4. （附加）破坏性动作：是否用户**显式触发** + 误触有**确认/护栏**？→ 停止两步确认、外部实例只读、PID 校验即此；新增破坏性能力必须自证满足。

**体积与权限纪律**：零依赖原生 JS、零远程请求；权限与 host_permissions 最小化，每新增一个 API 权限须在 §12 登记理由；不引入 UI 框架/图表库/图标包（内联令牌 + SVG 已覆盖）；扩展代码体量增长超阈值（功能数、约 3 年量级）时先做「哪块应下沉」的边界复核。

**演进流程**：任何新能力先在 design.md 标注**象限归属**并经本节对照；归属模糊时默认**拒收走「不下沉扩展」**（先问 dsh 侧/客户端插件生态；D1 模式——dsh 插件端点 + 扩展薄壳是既成范式）。

---

### 8.12 颜色语义自定义（颜色角色，M10 规划，2026-08-23 用户提出）

> 术语说明（2026-08-24 用户拍板）：设置面板 UI 标签为**「颜色角色」**（直观、点明"每种颜色承担一个角色"）；术语层为**语义色（semantic color）**——design token 标准语，代码 `--dsh-mgr-sem-*` / `settings.colorMap` 与本文标题沿用"颜色语义"表述。

**动机**：语义色表当前是硬编码约定（§8.9.1 / M7 / M9），用户希望可按偏好调整——典型诉求「任务结束（琥珀黄）改成绿色」。**先立规矩**：颜色永远是辅助载体，语义由字符/文字/图标承载（§8.9.1 硬规则不变）——改色不改义，把「完成」改绿后它仍是「完成」，只是表达色不同。

**规划调整（2026-08-23 用户决策）**：本表「默认色」取值均为**提案值**，**最终预设色板待 M10 自定义设置实现、用户实际体验调色后确定**——M10 先交付完整可自定义能力（`settings.colorMap` + 预设色板交互 + 恢复默认），体验阶段不改死任何默认色；定稿流程见节末。

**语义角色清单（可改 / 锁定；M10.1 定稿 2026-08-24——三态三色，遵循 Web UI 区分）**：

| 语义角色 | 承载载体 | 默认色（**定稿值**） | 可改？ |
|---|---|---|---|
| `waiting` 待确认 | 徽标「?」底、popup 会话区圆点 | **琥珀黄 `#f59e0b`**（M10.1 定稿——用户实机观察 webui 计划面板=黄色，等待语义取同色系；原紫经体验对比后放弃） | ✅（红撞色提示见下） |
| `working` 进行中 | 徽标「n」底、popup 会话区圆点 | **webui 蓝 `#5686fe`**（定稿；M10 统一双载体且经体验确认） | ✅ |
| `completed` 完成 | 徽标「!」底、popup 会话区圆点 | **绿 `#22c55e`**（定稿；**徽标完成提醒「!」随定稿改绿**——原琥珀，用户「完成是绿色，查看后不再显示绿色徽标」= 徽标完成提醒绿色 + 页面可见即清除（M8 行为不变）；`done` 事件角色并入 completed 色） | ✅ |
| ~~`done` 完成待办~~ | ~~徽标「!」底~~ | ~~琥珀 `#f59e0b`~~ | **已并入 completed**（M10.1 定稿：只显示三态；徽标「!」色取 completed；`attentionDone` 独立开关保留） |
| ~~`idle` 空闲~~ | ~~popup 会话区圆点~~ | ~~灰~~ | **已删除**（M10.1 定稿：idle 不再展示——live 集合近零出现 + Web UI 本体不区分，见 §8.10 idle 注记） |
| `error` 错误 | 全域（状态层/徽标角标/面板） | 红 `#ec1313` | 🔒 **锁定**（§8.9.1「红色只属于错误」；防语义毁坏） |
| 实例角标绿/红/无点 | 图标角标（setIcon PNG） | 绿/红 | 🔒 **v1 不改**（图标为预生成位图，改色=重生成；且绿=运行是大众语义） |
| 字符/文字（`?` `!` `n`、状态词） | 徽标字符、会话行文字 | — | 🔒 永不改（M10.1 用户问询 emoji 徽标后决定暂不引入；字符语义锁定规则维持） |

- **M10 顺带纠偏（已定稿）**：`working` 双载体默认色历史分歧（徽标蓝 `#5686fe` vs popup 会话区琥珀）→ 统一 webui 蓝，用户可改回琥珀。
- **撞色保护**：改 `waiting`/`completed` 为红色系时 toast 提示「与错误语义撞色（建议保留互斥色）」，但**允许**（主语义仍是字符/文字，颜色只是辅助；不硬拦）。

**交互形态**：popup 设置「界面」分组新增「颜色角色」子区（UI 标签；术语层=语义色 semantic color——design token 标准语，2026-08-24 用户拍板）——每个可改角色一行（M10.1：**仅 3 行**：待确认 / 进行中 / 完成）：语义标签 + 当前色块 + **预设色板**（复用 dsh 静态令牌色：蓝/琥珀/紫/绿/红/灰，圆形 swatch 点选即生效，同主题 cube 交互）；另有「恢复默认」按钮。保存进 `settings.colorMap`（`storage.local`，`DEFAULT_SETTINGS` 同步声明默认值）。

**生效范围（一处配置、全域同语义）**：
- popup 状态卡/hint、会话区圆点、面板胶囊 dot、logs 页状态点——以**语义角色 CSS 变量**（`--dsh-mgr-sem-waiting` 等）注入：`theme.js`（或新 colors.js，popup/logs 共用）读 `colorMap` 写 `:root`/`body` inline 覆盖，组件一律引用语义变量而非字面色值（M7/M9 教训：先立 token 再上色）。
- SW 徽标——`background.js` 渲染徽标时读 `colorMap`（已有 settings 读取路径，扩展 `SESSION_BADGES` 常量 → 运行时覆盖）。
- 面板（`content/panel.js`）——shadow DOM 内联样式按语义变量生成，经 storage 订阅实时同步（同 webuiTheme 镜像模式）。
- 图标角标 v1 不改（见锁定表）。

**约束**：只提供预设色板选择（不开放任意输入色值——省去对比度/深浅两套主题调优，色彩工程交给令牌体系）；预设色板保证浅/深主题均可见；**每处新用色必须走语义变量**（改色只动 `colorMap` 一处，禁止散落硬编码）。

**验收**：verify-cdp 新增断言——改色后 popup 会话区/状态卡圆点实际色变化 + 徽标 background 变化 + 面板 dot 变化 + 恢复默认还原；「改红触发撞色 toast」断言；字符语义（`?`/`!`/n/文字状态词）不受影响的回归断言。

**定稿流程（2026-08-23 用户决策；已于 2026-08-24 完成定稿——M10.1）**：M10 自定义设置交付 → 用户实际体验调色（`working` 琥珀/蓝、`done` 琥珀/绿、`waiting` 紫/黄对比）→ **用户确认最终预设色板**（2026-08-24：三态三色——进行中蓝 / 等待黄 / 完成绿；去 idle；done 并入完成色）→ 回填本表「默认色」为定稿值（已落实，见上表）→ 落实为 v1 默认（`DEFAULT_SETTINGS` / `SESSION_BADGES` 默认值）→ 新装与「恢复默认」用户即得最终色板。**定稿已完成：实现与默认值见 M10.1 交付记录（AGENTS.md 顶部）**。

**范围外（明确不做）**：字母/图标形状自定义、每会话独立配色、按主题（浅/深）分别配色、任意色值输入器。

**实施注记（M10 完成，2026-08-24；本节与实现合一后以代码为准）**：

- **生效范围取舍（关键）**：colorMap 严格按上方「语义角色清单」的**载体列**生效——`waiting`→徽标「?」底 + popup 会话区圆点、`done`→徽标「!」底、`working`→徽标「n」底 + 会话区圆点、`completed`/`idle`→会话区圆点。**状态展示层（popup 状态卡/面板胶囊 dot/logs 状态点）不随角色色改**（verify 显式断言「改色后实例圆点不变」）：§8.9.1 状态展示层的主语义载体是颜色本身（绿=运行/蓝=外部/琥珀=过渡/灰=停止/红=错误），若让会话角色色（如 idle 灰）联动实例层，用户把「空闲」改成绿色会把**已停止实例渲染成绿点**——实例层语义被用户配色毁坏，违背「改色不改义」。状态展示层继续走既有 alias 令牌（`--dsw-alias-state-*`，M6 起已是语义变量）；唯一集中化：error 红统一引用 `--dsh-mgr-sem-error`（锁定值 `#ec1313`）。「popup 状态卡/hint、面板胶囊 dot、logs 页状态点在生效范围列」按「均走语义变量（alias 令牌）」落实，不指可配色。
- **working 双载体统一（M10.1 定稿）**：默认值 = webui 蓝 `#5686fe`（`--dsw-static-deepseek-450`，徽标原值不变、popup 会话区由琥珀 `warn-label` 改蓝）——**用户体验后定稿**（2026-08-24）。
- **M10.1 定稿附加**（2026-08-24 用户拍板）：① waiting 默认色紫→琥珀黄 `#f59e0b`；② 状态词「等你拍板」→「待确认」；③ 五角色→三角色（done 并入 completed、idle 删除——popup 会话区只渲染 working/waiting/completed，idle 行不显示；`settings.colorMap` 键收敛，旧 5 键存储被 normalize 忽略）；④ verify-cdp 断言同步（M8 徽标黄?/绿!、M9 三态渲染 + idle 过滤、M10 三角色）。
- **新文件**：`extension/colors.js`（`window.DSHColors`，popup 页内联；结构同 theme.js：storage 订阅 + documentElement inline 变量 `--dsh-mgr-sem-<role>`；白名单色板，无任意输入）；`background.js` SW 侧 `normColorMap` 零依赖同口径（徽标渲染是纯字符串路径，不能引入页面脚本）。
- **验收**（verify-cdp，92/92）：改色后 popup 会话区/徽标底色实际变化 + 实例圆点不变 + 撞色 toast + 恢复默认还原（storage 键级比对）+ 字符语义（`?`/`!`/n/状态词/类名）回归。**注意：verify 默认 dsh URL 已更新为 3080**（此前 8080 为用户旧实例端口；实例在其它端口时 `VERIFY_DSH_URL` 覆盖）。

---

## 9. 关键流程时序

### 9.1 一键启动（核心体验）

> **本节为早期草稿，与 §6.3 实现有出入；以 §6.3 为准**：宿主的 start **在宿主侧轮询至就绪（≤30s）后才应答** `running`（`--port 0` 时先做 ≤30s 端口发现再探活），并非「spawn 即返回 starting」；SW 以 start 60s / restart 120s 兜底超时等待完整应答；popup 应用应答结果后以 **2s** 轮询 status 收敛（`starting` 只在应答前由 popup 乐观反馈展示）。

```
Popup                     Background SW                Native Host                 dsh
  │  点击「启动」              │                            │                        │
  ├─sendMessage(start)──────▶│                            │                        │
  │                          ├─connectNative()───────────▶│                        │
  │                          │   {action:"start"}          │                        │
  │                          │                            ├─ 抢锁/解析/校验         │
  │                          │                            ├─spawn(detached)────────▶│ 开始加载
  │                          │                            │   写 run 记录 + 日志    │
  │                          │                            ├─ 轮询探活（≤30s；       │
  │                          │                            │   --port 0 先发现端口） │
  │                          │◀─ {ok, state:"running"} ────┤◀─ GET / 200 ───────────┤
  │◀─sendResponse(running)───│                            │                        │
  │  green 状态 + tabs.create("http://127.0.0.1:3080")     │                        │
```

要点：SW 不等待超时兜底之外的轮询——轮询编排权在宿主；popup 在应答前以乐观反馈展示 `starting`（按钮转圈 + 进度条），应答后应用终态并由 2s 轮询收敛（popup 关闭也无碍——下次打开重新 status）。

### 9.2 停止

```
Popup ──▶ SW ──▶ Host {action:"stop"}
                    ├─ (M2 插件存在) POST /_lifecycle/shutdown → dsh 官方 dispose 后退出
                    │      └─ 轮询端口关闭（≤10s）
                    ├─ (v1/回退) taskkill /PID <pid> /T /F
                    ├─ 轮询端口关闭（≤10s）
                    └─ 清理 run 记录
Popup ◀── {state:"stopped"}
```

### 9.3 宿主突然死亡 / SW 被回收

- 宿主死亡 → dsh 不受影响（detached + 独立日志 fd）。
- SW 被回收 → 连接断开 → 宿主收到 stdin EOF 正常退出（应答已发或丢弃无妨，动作幂等）。
- 两者都无需恢复逻辑：状态在文件与端口上，下次 status 自动收敛。

---

## 10. 安装与注册（install.ps1 / uninstall.ps1 / install.sh / uninstall.sh）

### 10.1 install.ps1 流程（Windows）

1. 参数：`-ExtensionId <id>`（可省略；省略时从 `extension/manifest.json` 的 `key` 自动计算，见 §10.2）。
2. 检查 Node（`node -v`）与 dsh（`dsh --version`），缺失则给出安装指引并中止。
3. 创建 `%LOCALAPPDATA%\dsh-manager\{host,run,logs}`。
4. 生成 `host.cmd`（写死本机 node.exe 与 host.js 绝对路径）与 `com.dsh.manager.json`（注入扩展 ID 与 Firefox gecko id，M4）。
5. 写注册表：Chrome + Edge + Firefox 三条（HKCU，失败时提示手动导入 `.reg` 文件，安装器同时导出 `com.dsh.manager.reg` 备用）。
6. 打印验收指引：「打开扩展 popup，应显示 stopped 而非 HOST_NOT_INSTALLED」。
7. （可选）安装生命周期插件：见 `plugin/dsh-lifecycle/README.md`（本地包安装或 cordis.patch.yml 挂载）；未安装时宿主自动降级强停，功能不受影响。

### 10.1a install.sh 流程（Linux / macOS，M4）

与 install.ps1 同构，注册方式为写用户级 NativeMessagingHosts 清单文件（无需 sudo）：

1. 参数：`--extension-id <id>`（缺省自动计算）、`--dry-run`（预演）。
2. 前置检查 node 与 dsh（`command -v`，仅存在性）。
3. 创建状态根目录（Linux `$XDG_CONFIG_HOME/dsh-manager` 或 `~/.config/dsh-manager`；macOS `~/Library/Application Support/dsh-manager`）下 `{host,run,logs}`。
4. 生成 `host.sh`（`#!/bin/sh` + `exec "node" "host.js" "$@"`，写死绝对路径、chmod +x）与 `com.dsh.manager.json`（JSON 转义由 node 完成；allowed_extensions 同含 Chrome ID 与 gecko id）。
5. 写入四份浏览器注册（幂等）：
   - `~/.config/google-chrome/NativeMessagingHosts/com.dsh.manager.json`
   - `~/.config/chromium/NativeMessagingHosts/com.dsh.manager.json`
   - `~/.config/microsoft-edge/NativeMessagingHosts/com.dsh.manager.json`
   - `~/.mozilla/native-messaging-hosts/com.dsh.manager.json`（Firefox）
6. 打印验收指引（同 Windows）。

uninstall.sh 与 uninstall.ps1 同构：宿主 stop 动作（复用全套防护链）→ 删四份浏览器注册 → `--keep-logs` 可选备份 → 删状态目录。

**验证状态**：install.sh/uninstall.sh 在 Kali WSL2 **真实安装 E2E 实测通过**（tools/linux/run-e2e-linux.sh：npm i -g 真实 dsh → 安装 → 清单断言 → 经已安装 host.sh 拉起真实 dsh web start/status/指纹/stop → 卸载清理；2026-08-14）。macOS 同脚本复用（`uname -s` 分支），未实测。

### 10.2 固定扩展 ID

开发期（unpacked）扩展 ID 由 manifest 的 `key` 字段决定；不固定 key 则 ID 随绝对路径变化，宿主 manifest 会失效。初始化时生成一次并永久保留：

```js
// 一次性执行（node -e），输出 manifest "key" 与对应扩展 ID
const crypto = require('crypto');
const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = publicKey.export({ type: 'spki', format: 'der' });
const key = der.toString('base64');
const hash = crypto.createHash('sha256').update(der).digest().subarray(0, 16);
const id = Array.from(hash, b =>
  String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join('');
console.log(JSON.stringify({ key, id }, null, 2));
```

生成的 `key` 写入 manifest，`id` 写入宿主 manifest 的 `allowed_origins`。项目仓库提交 key（不是机密，仅为稳定 ID）。

### 10.3 uninstall.ps1

1. 若 run 记录存在 → 执行 stop。
2. 删除注册表项（Chrome/Edge）。
3. 删除 `%LOCALAPPDATA%\dsh-manager\`（保留日志可选，默认备份 logs 到桌面后删除）。
4. （M2）`dsh plugin --profile web remove dsh-lifecycle`（可选，询问）。

---

## 11. 目录规划（仓库 `<repo-root>`）

```
dsh-manager/
├─ AGENTS.md / README.md / CHANGELOG.md / CHROMEWEBSTORE.md / CONTRIBUTING.md
├─ docs/
│  ├─ design.md                  # 本文档
│  └─ publish.md / upstream-feedback.md / open-source-review.md …
├─ extension/                    # 浏览器扩展（可直接「加载已解压的扩展程序」）
│  ├─ manifest.json
│  ├─ background.js / popup.html / popup.css / popup.js
│  ├─ logs.html / logs.css / logs.js      # M3 日志查看页
│  ├─ content/
│  │  └─ panel.js                 # M3 页面内管理面板（content script，样式内联 + Shadow DOM）
│  ├─ scripts/keygen.js           # 扩展 ID 密钥生成工具
│  └─ icons/{16,48,128}.png
├─ native-host/
│  ├─ host.js                    # 宿主主程序（零依赖）
│  ├─ host.cmd.template / com.dsh.manager.json.template
│  ├─ compute-id.js              # 扩展 ID 计算工具
│  ├─ install.ps1 / uninstall.ps1        # Windows 安装/卸载器
│  ├─ install.sh / uninstall.sh          # Linux/macOS 安装/卸载器（M4）
│  └─ test/
│     ├─ smoke.js                # 宿主冒烟 27 场景（--req/--res 文件模式，见 §14）
│     ├─ smoke-real.js           # 真实 dsh 集成（best-effort，隔离 DSH_HOME）
│     ├─ fake-dsh.js             # 伪 dsh bin（冒烟用，支持 --port 0 / lifecycle 端点）
│     └─ manual-e2e.md / VERIFICATION.md
├─ plugin/dsh-lifecycle/         # M2 生命周期插件（独立 npm 包，dsh 侧）
├─ tools/                        # 开发期工具
│  ├─ icons/                     # 鲸鱼图标生成（headless Chrome 渲染）
│  ├─ linux/                     # WSL Linux 冒烟/E2E 验证脚本
│  ├─ publish/                   # 发布副本构建（robocopy /MIR + tar 中转）
│  ├─ verify-ui/                 # 扩展 UI 自动验收（CDP / MCP 两路径）
│  └─ visual-audit/              # 视觉审计
└─ …                             # LICENSE / NOTICE / SECURITY.md 等
```

---

## 12. 安全设计

### 12.1 攻击面收敛（宿主侧）

- **action 白名单**：仅 `ping|status|start|stop|restart`，任何其他输入拒绝。
- **参数白名单**：`extraArgs` 仅允许通过正则校验的有限集合（例如 `--patch <绝对路径>`、`--dump-config` 类无害项）；**明确禁止** `--host 0.0.0.0`（F3 本就拒绝，宿主再拦一道）、`--trusted-host`（v1）。
- 宿主拒绝执行任何 shell 字符串拼接命令（无 `exec()`、无 `shell: true` 主路径）；taskkill 参数仅由 run 记录中的数字 PID 构成。
- **外部实例发现只读**（§6.6）：仅执行本机只读命令（进程枚举、netstat 端口表）与回环 GET 探测；外部实例绝不写入 run 记录、绝不纳入 stop/restart 的 taskkill 目标（`EXTERNAL_UNMANAGED`）。
- **接管（adopt）边界**（§6.7）：仅当 pid+port 双重命中发现结果且进程仍为 dsh 时才回写 run 记录；接管实例的 restart 重放参数取自本机进程表（用户自己的命令行），**扩展消息输入的 extraArgs 仍严格白名单**——两条输入通道不可混淆。
- **PID 复用防护**：stop/status 对 pid 做命令行校验（§6.3），防误杀无关进程。
- 宿主 manifest 的 `allowed_origins` 仅含本项目固定 ID：其他扩展（甚至同一浏览器其他 profile）无法调用本宿主。
- 消息长度上限校验（读帧 > 1MB 直接断开）。
- **测试钩子门控**：所有 `DSH_MANAGER_*` 测试钩子环境变量（`DSH_MANAGER_BASE_DIR`、`DSH_BIN_STUB`、`DSH_MANAGER_NPM_PREFIX`、`DSH_MANAGER_PID_CHECK`、`DSH_MANAGER_FAKE_PROCESSES`、`DSH_MANAGER_FAKE_LISTENERS` 等）**仅当 `DSH_MANAGER_TEST_MODE=1` 时生效**；发行构建不启用这些钩子。

### 12.2 遵守 dsh 自身的安全模型

- 不调用 `/api`（Origin 围栏，F9）；探活只用 `GET /`。
- 生命周期插件端点（§7）必须自我设限：仅回环连接 + Origin 缺失或同源，**绝不注册为公开 RPC**；「扩展 → 宿主 → HTTP」链路因宿主请求无 Origin 而天然合规，扩展直连则被拒。
- 扩展 host_permissions 仅回环；不申请任何超出需求的权限。
- **页面内面板（§8.6）**：content script 只注入 dsh 指纹页面（127.0.0.1/localhost 任意端口）；面板对页面的唯一写操作是追加自身 shadow 节点，不读取/修改页面 DOM 与数据；停止/重启经 SW → 宿主全套防护（PID 校验、外部实例保护、锁），面板不持有任何特权 API（无 `/_lifecycle` 直连、无宿主角色的独立判定）。**例外（M8，§8.9；2026-08-24 扩为端点摘要）**：徽标提醒段优先**同源只读** `GET /_manager/sessions`（§8.10 摘要元数据：sessionId/标题/四态/时间戳，**不读消息体/事件内容/凭据**；仅同源回环请求）；端点不可用时回退只读存在性扫描（`svg[data-state="ongoing"]` / `[data-state="warning"]` 两个语义属性是否存在），不采集消息文本/会话内容；上报 SW 仅为两值枚举 `done|waiting` + 计数。

### 12.3 数据与凭据

- 扩展不读取、不存储 `$DSH_HOME` 下的凭据文件（`.credentials.yaml`）；状态展示仅含 pid/端口/时长/版本/健康字段。
- run 记录与日志落在 `%LOCALAPPDATA%`，仅本用户可读；日志中可能出现工作区路径，属于本机用户自身信息。
- **M9 会话元数据边界（2026-08-23）**：`/_manager/sessions` 端点只出**只读摘要元数据**（sessionId/title/state/updatedAt/blank/cwd）——title 取自 `session/title` 事件（已归一化），state 由事件流判定（`approval/asked`↔`decided`、`tool/call`(ask_user_question)↔`tool/result` 配对）；**不读消息体/事件内容/凭据**；扩展侧渲染仅用摘要，行点击只打开 Web UI 首页。§12.2 的「不调用 /api、不读页面内容」范围不变。

---

## 13. 错误处理与边界情况

| 场景 | 行为 |
|------|------|
| dsh 未安装 / npm 全局路径变化 | `DSH_NOT_FOUND`，popup 给出安装命令；ping 可诊断路径解析链 |
| 端口被其他程序占用 | `PORT_BUSY`，建议换端口（设置面板） |
| 启动 30s 未就绪 | `START_TIMEOUT` + 日志尾部；进程保留，用户可看日志决定 |
| 旧版本 dsh（缺 `--port` 等） | start 前 `dsh --version` 校验最低版本（v1 定为 0.1.0-rc.x 基线） |
| run 记录指向已死 PID（上次崩溃残留） | status 自动清理；stop 幂等 |
| 快速连点启动 ×N | 锁 + `ALREADY_RUNNING` 幂等 |
| SW 回收 / popup 中途关闭 | 无状态收敛（§9.3） |
| 宿主被 Chrome 以旧版本缓存 | 提示「重启浏览器」；安装器写入的 manifest 变化需重启浏览器生效（Chrome 平台行为） |
| 用户名/路径含空格或中文 | 全部 spawn 走数组参数（非 shell 拼接），路径引号由宿主统一处理 |
| `--port 0`（用户配置动态端口） | **M4 已支持**（本扩展启动场景）：spawn 后从日志 URL 行回填实际端口（§6.3 start 第 9 步）；外部实例的 `--port 0` 经 netstat 按 PID 解析（§6.6） |
| 用户手工运行了 dsh web（无 run 记录） | status 外部实例发现（§6.6）→ `external`：展示真实端口/URL、可打开 UI；stop/restart 返回 `EXTERNAL_UNMANAGED`，不误杀 |
| 外部实例使用 `--port 0` | netstat 按 PID 解析实际监听端口后再指纹探测（§6.6 第 4 步） |
| 发现命令不可用（PowerShell/WMI 受限、netstat 缺失、EPERM） | 静默降级：按无外部实例处理（stopped），绝不影响 start/stop 主流程 |
| 非 dsh 服务监听端口（误报面） | 指纹探测（`GET /` 前 8KB 含 DeepSeek Harness）不通过 → 不报告 external |
| 同时存在多个外部 dsh web | 报告首个实例 + `externalCount`；接管其一后 managed 优先，其余实例待该实例停止后再次发现（§6.7） |
| adopt 目标已退出 / pid 复用 / 端口漂移 | pid+port 双重匹配不命中 → `EXTERNAL_UNMANAGED`，绝不硬写记录 |
| adopt 后 stop/restart | 标准 managed 路径（优雅→taskkill）；重启按原 argv 归一化重放，`--port 0` 重放为实际端口 |
| 接管实例命令行含 `--trusted-host` 等非常规参数 | restart 原样重放（参数源自本机进程表，非扩展输入，§6.7） |
| 生命周期插件未安装 / 版本过旧 | 高概率（M1/未装用户） | stop 自动降级 taskkill（预期路径）；popup 一次性提示安装指引（§8.2.6） |
| 优雅路径 10s 未关端口（插件挂起） | 回退 taskkill 强制路径，不悬挂（§6.3 stop） |

---

## 14. 测试计划

### 14.1 宿主冒烟（不依赖浏览器）

`test/smoke.js`（27 场景，2026-08-15 计数：Windows 347 PASS + 1 SKIP / Linux 337 PASS + 1 SKIP——场景 26 POSIX 专属、场景 27 载体为 Windows 专属）：以 `--req/--res` 文件模式逐请求
拉起 `node host.js`（沙箱管道受限环境兼容），伪 dsh 由 `DSH_BIN_STUB` 指向
`test/fake-dsh.js`（含 lifecycle 端点、`--port 0`、退出立即/不打印 URL 变体），
状态目录隔离在工作区 `.smoke`，`BASE_ENV` 围栏真实进程枚举**仅 Windows 生效**（本机常驻真实 dsh web 会干扰「空目录→stopped」场景）。覆盖：ping/status
/start/stop/restart/adopt 主链路与幂等、端口占用、参数校验、锁竞争、残留清理、
START_TIMEOUT、优雅停与 force 降级、外部实例发现/接管、M2 富状态、M3 logs 分页
（行边界对齐 + 定宽行逐字节重建）、M4 `--port 0`（回填/重放/校验/超时/占位期展示）、
gecko id 与宿主模板静态断言；**场景 26（仅 POSIX）不注入任何 fake 钩子**：真实 /proc 枚举 +
/proc/net/tcp 端口表 + /proc PID 校验 + 指纹探测发现/接管/停止外部实例全链路（Windows 记 SKIP，其平台路径由 smoke-real 与生产实测覆盖）。

`test/smoke-real.js`（真实 dsh 集成，best-effort）：真实 bin.js + 隔离 DSH_HOME，
start/status/stop 全链路、`--port 0` 真机回填、外部发现生产路径（真实
powershell/netstat，只读，不接管不停止）与 `EXTERNAL_UNMANAGED` 保护。

扩展 UI：`tools/verify-ui/verify-cdp.js`（零依赖 CDP，沙箱内可用；断言数随里程碑递增，
M7 口径 63、M8 新增 5 条徽标提醒断言）——
扩展加载、popup/logs 截图与文本断言、页面内面板注入/展开/停止两步确认态、日志页
「加载更早/复制全部」交互、popup 设置校验交互、徽标三步实测、M6 主题/深色断言、
M7 状态卡断言、M8 徽标提醒分层渲染（done/waiting/清空恢复）与端到端（后台页注入等待
标记 → 红「?」→ 切回标签自动清除）、console 异常检查。

插件：`plugin/dsh-lifecycle/test/*.test.js` 单测（21 项）。

### 14.2 集成/E2E（真实 dsh）

1. 安装器一键安装 → 注册表三项（Chrome/Edge/Firefox）存在、宿主 manifest 的 allowed_origins/allowed_extensions 与扩展 ID、gecko id 一致。
2. 加载 unpacked 扩展 → popup 显示 stopped（非 HOST_NOT_INSTALLED）。
3. Start → 徽标变绿 → 自动打开 `http://127.0.0.1:3080` → 页面可交互。
4. **宿主死亡实验**：启动后 taskkill 掉宿主进程 → dsh 仍在运行 → popup status 仍为 running。
5. **SW 回收实验**：`chrome://serviceworker-internals` 手动 stop SW → dsh 不受影响 → 再次打开 popup 状态正确。
6. Stop → 进程树消失（`Get-Process node` 无残留 bin.js）→ 端口关闭 → popup 灰点。
7. Restart → 旧会话在 Web UI 中仍可继续（会话持久化 F8 验证）。
8. 异常矩阵：端口占用 / 假 DSH_HOME / 无 Node / 快速连点 / 开机后首次使用。
9. （M2）安装 dsh-lifecycle 后：stop 走优雅路径（无 taskkill 调用、会话无损）；health 返回 200 且字段正确；卸载插件后回归 M1 路径无退化。
10. （M3）打开任意 dsh Web UI 页面 → 右下角出现页面内管理面板（§8.6）：状态徽章随 status 轮询更新；展开后「停止」两步确认、「重启」走宿主语义；非 dsh 的本地页面不注入。verify-cdp.js 已自动覆盖「注入 + 渲染 + 状态文本 + 展开 + 两步确认态（首击确认/3s 还原）」。

### 14.3 验收标准（MVP）

- 安装 ≤ 2 分钟（跑一个脚本 + 浏览器加载目录）。
- Start 点击到 Web UI 打开 ≤ 15s（含 dsh 冷启动）。
- Stop/Start 各 20 次无僵尸进程、无残留 run 记录、无锁死。
- dsh 停止时，系统内无本项目任何驻留进程。

---

## 15. 分阶段路线图

| 阶段 | 内容 | 验收 |
|------|------|------|
| **M1 MVP**（本文档范围） | 扩展（popup+SW）、宿主（status/start/stop）、安装/卸载器、冒烟测试 | §14.3 全过 |
| **M1.1 外部实例检测**（§6.6） | status 发现非本扩展启动的 dsh web 及其端口（进程扫描 + netstat + HTTP 指纹），`external` 状态仅展示与打开 UI；`EXTERNAL_UNMANAGED` 保护 | smoke 场景 15-18 通过 |
| **M1.2 外部实例接管**（§6.7） | adopt 动作：pid+port 双重匹配回写 run 记录，接管后 stop/restart 可用、重启按原 argv 重放；popup「接管」按钮；popup UI 对齐 dsh Web UI 设计令牌 | smoke 场景 19 通过 |
| **M2 生命周期插件** | `dsh-lifecycle`（shutdown + health）；宿主 stop/restart 优雅链；popup 富状态与插件安装提示 | stop 走优雅路径、全程无 taskkill、会话无损；health 200 且字段正确（§14.2.9） |
| **M3 体验增强** | restart 按钮、日志查看与复制、启动后自动开 UI 开关、徽标周期刷新（alarms）；Web UI 页面内管理面板（页面内停止/重启） | 完成（2026-08-14：`logs` 动作与日志查看页 §6.3/§8.4 + 页面内管理面板 §8.6（content script 方案，替代 dsh client 插件：外部插件无独立构建路径，见 §8.6 决策）；smoke 场景 24 + verify-cdp 自动验收） |
| **M4 跨平台/跨浏览器** | macOS/Linux（SIGTERM 优雅路径、`~/.config` 状态目录、`kill` 代替 taskkill）；Firefox（`allowed_extensions` 已预留）；`--port 0` 端口发现 | 进行中：`--port 0` 已支持并对真实 dsh 实测通过（2026-08-14，§6.3 start 第 9 步 + smoke 场景 25 + smoke-real 扩展段）；Firefox Windows 宿主注册与 gecko id 已就绪（install/uninstall 含 Mozilla 注册表项，扩展运行时未实测）；**Linux 已实测通过（Kali WSL2，smoke 场景 26 真实 /proc 路径）**；macOS 与 Firefox 运行时待实测——**暂缓**（无对应设备，2026-08-14 用户决定） |
| **M5（可选）上游贡献** | 向 deepseek-harness 提 `dsh server start/stop/status` 子命令或官方 lifecycle 插件 PR，本项目宿主改为优先调用官方面 | 上游采纳或明确拒绝 |
| **M5.5 Windows 隐藏控制台载体**（2026-08-15 完成） | 消除 dsh 命令执行闪窗：wscript + `Run(cmd,0,False)` 隐藏控制台载体启动 + 端口表 PID 反查 + cmd 日志重定向（§6.3 第 5 步） | smoke 场景 27（Windows）通过；窗口实测：控制台存在但不可见、子进程零新窗口 |
| **M6 主题与深色模式**（§8.7） | 四态主题模型（follow-webui / follow-system / light / dark）+ 深色令牌内联（popup/logs）+ 外观行设置 + panel.js 镜像 → popup 实时跟随 webui 深浅切换 | verify-cdp 深色断言全过（§8.7.7）；浅/深截图与 webui 对照；`.btn.primary` 深色白底深字实测核对 |
| **M7 popup 排版优化**（§8.8，方案 A） | 应用栏 + 状态卡 + 分组设置三区结构；busy 态复刻 webui Matrix 点阵动效（三处统一）；错误态红调卡片 | 先跑 verify-cdp 50 基线 → 实施 → 全量 + 深色截图 vision 核验（§8.8 实施清单） |
| **M8 徽标提醒「该点回来看看了」**（§8.9） | dsh 页面后台时监视会话状态标记（工作完成/等待用户）→ 徽标「!」琥珀 /「?」紫；页面可见或标签关闭自动清除；`settings.attention` 开关 | verify-cdp 断言（SW 分层渲染 + 真实页面 e2e 注入等待标记 → 徽标「?」→ 切回标签自动清除）；`node --check` 全过 |
| **M9 扩展面板会话状态**（§8.10，路径 3） | dsh 配套插件新增只读端点 `/_manager/sessions`（lifecycle 同款围栏）→ 宿主 `sessions` 动作 → popup「会话」区（标题 + 状态圆点色表，只读不读内容）；降级提示 | **完成（2026-08-23）**：M9.1 spike（signal 全部 host 侧可读）→ M9.2 插件端点 + 单测 29/29 → M9.3 宿主 `sessions` action + popup 会话区 + smoke 356/0 + verify-cdp 82/0 → M9.4 真实实例 e2e 7/7（真实 dsh 0.1.1-rc.2 + 真实 profile 插件装配：端点 200/403/405、available:true、优雅停机无回归；本机插件已升级） |
| **M10 颜色语义自定义**（§8.12；M10.1 定稿 2026-08-24） | 用户可按语义角色调整展示色（如「完成」琥珀→绿）：`waiting/working/completed` 三角色预设色板，`settings.colorMap` 全域生效（popup 会话区走语义 CSS 变量、徽标 SW 读 storage）；error 红与字符语义锁定；**定稿色板：进行中=webui 蓝 #5686fe、等待=琥珀黄 #f59e0b、完成=绿 #22c55e**（去 idle、done 并入完成色；徽标完成提醒「!」随定稿改绿）；**顺带统一 working 双载体默认色** | 验收：verify-cdp 改色/恢复默认/撞色提示断言 + 字符语义不回归（**已完成 2026-08-24**） |
| **M11 项目更名**（§15.1，规划） | 一期：显示品牌（manifest 名、README、popup 品牌名、GitHub 仓库名）；二期：全量更名（native host 协议名 `com.dsh.manager`、注册表键、`%LOCALAPPDATA%\dsh-manager` 状态目录、`DSH_MANAGER_*` 测试钩子、代码/文档标识，含迁移脚本与卸载兼容）；**Chrome Web Store 上架前必须完成**（商店品牌一致性 + 图标重审准备） | 命名拍板（GitHub/npm/商店名冲突核查）→ 一期 → 二期迁移演练；§15.1 |

### 15.1 项目命名与更名规划（M11，2026-08-23 用户提出「名字太朴实」）

**现状**：`dsh-manager` / 「DSH Manager」——直白但无记忆点，且「DSH Manager」易被误读为 DeepSeek 官方产品（开源审查 🟡-4 已记录同名混淆风险，更名一并解决）。

**命名候选（最终由用户拍板；拍板前须核查 GitHub 仓库名 / npm 包名 / Chrome Web Store 可用性与冲突）**：

| 候选 | 中文副名（可选） | 理由 | 取舍 |
|---|---|---|---|
| **Whalekeeper** | 鲸守 | 与鲸鱼 logo 强呼应，「keeper」= 管理守护；品牌记忆点最好 | **✔ 已确认为候选（2026-08-23 用户认可）**；「DSH」术语不再出现在主名，混淆风险归零；最终定名前须完成冲突核查 |
| **Portwatch** | 端口守望 | 直描功能（守护 3080 端口的状态） | 技术感强、品牌联想弱；备选 |
| **Loopkeeper** | 回环守护 | 点出 127.0.0.1 回环安全模型 | 技术黑话，门外用户不解；备选 |
| （保持）dsh-manager | — | 直观、已有认知 | 被否（用户已定方向：太朴实） |

**更名范围分级（决定成本的关键）**：

- **展示品牌（轻，一期）**：`manifest.json` 的 `name`/`description`、README 标题与提及、popup 应用栏品牌名、GitHub 仓库名（旧 URL GitHub 自动重定向，风险低）。扩展 ID 由固定 `key` 生成——**换名不换 key 则 ID 不变**，宿主 `allowed_origins` 零改动，一期可无感落地。
- **协议与标识（重，二期）**：host 协议名 `com.dsh.manager`（Chrome/Firefox 注册表键 + 清单 `allowed_origins` + `host.cmd`/`host.sh` 路径）、状态目录 `%LOCALAPPDATA%\dsh-manager`（含 run/logs）、测试钩子与代码前缀 `DSH_MANAGER_*`、`DSH_MANAGER_BASE_DIR` 等、全部文档/注释/包名（`dsh-lifecycle` 插件包是否同步更名——独立决策点：包名属于 dsh 生态，改名影响安装路径；建议插件名不动或单独评估）。

**分期建议**：一期（显示品牌）独立低成本里程碑，可与 M10 同批；二期（全量更名）为单独里程碑，**必须含**：旧→新状态目录/注册表迁移脚本 + 卸载器兼容旧名清理 + 发布公告与「旧版本升级」指引（旧版扩展/宿主/插件与新名并存时的行为定义）。二期不晚于 Chrome Web Store 上架前。

**决策点**：① 命名**最终定名**（Whalekeeper 已确认为候选（2026-08-23 用户认可），Portwatch/Loopkeeper 保留备选；定名前完成 GitHub/npm/Chrome 商店名冲突核查）② 一期/二期是否分拆 ③ 中文副名「鲸守」是否采用 ④ `dsh-lifecycle` 插件包名是否跟随。

注（2026-08-14 用户决定）：**Chrome Web Store 上架与 macOS/Firefox 适配暂缓**；README 已重写为幽默风格并新增「测试环境」章节（CHROMEWEBSTORE.md 保留为将来上架素材）。

---

## 16. 风险清单

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| dsh CLI 面随版本漂移（flag/路径变化） | 中 | start 失效 | 版本基线校验（§13）；宿主解析链有回退；E2E 覆盖 |
| Windows 下无法优雅停（F7）导致会话尾部丢失 | 中 | 低（F8 兜底） | M2 生命周期插件；文案提示「停止前确认任务完成」 |
| Chrome 对 native host 缓存/注册表变更需重启浏览器 | 高 | 低 | 安装器验收指引明确写出 |
| 安全软件拦截 `.cmd` 包装的宿主 | 低 | 高 | 备用方案：pkg 编译为独立 exe（M4 评估） |
| 用户手工运行了一个 dsh web（无 run 记录） | 低 | 低（已缓解） | M1.1 外部实例发现（§6.6）：status 报告 `external` 状态与真实端口/URL；M1.2 接管（§6.7）后可管理；未接管前 stop/restart 返回 `EXTERNAL_UNMANAGED` 不误杀 |
| 多浏览器 profile / 多台机器共享 LOCALAPPDATA | 低 | 低 | run 记录含 startedAt 与 pid，冲突自愈 |
| dsh 插件 API 变化（appExit/webServer 契约） | 低 | 中 | 插件按 dsh 同版本号发布并声明 `peerDependencies`（`"@deepseek-ai/dsh": ">=0.1.0-rc.6 <0.2.0"`，已落实于 `plugin/dsh-lifecycle/package.json`）；宿主对优雅路径失败始终有 taskkill 回退 |
| 命令执行闪现终端窗口 | 低（M5.5 起已缓解） | 低（闪窗不阻塞，stdout 仍入日志文件） | M5.5 隐藏控制台载体：dsh 获得从不显示的控制台，子进程继承、不再闪窗（§6.3 第 5 步）；残留风险：wscript 不可用或载体链路失败时实例不可托管（INTERNAL 提示）；若上游修复受限令牌限制可移除载体回归直接 spawn |

---

## 17. 附录：参考链接

- dsh 仓库：https://github.com/deepseek-ai/deepseek-harness
- dsh npm 包：https://www.npmjs.com/package/@deepseek-ai/dsh
- dsh-web-app：https://www.npmjs.com/package/@deepseek-ai/dsh-web-app
- Chrome Native Messaging 文档：https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- 社区相关项目（思路佐证）：oh-dsh-desktop（macOS 桌面工作台，https://github.com/hust-open-atom-club/oh-dsh-desktop）、dsh-web-ui 插件合集（https://github.com/zhu1090093659/dsh-web-ui）
