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
| dsh 启动方式 | `node.exe + <npm-global>/node_modules/@deepseek-ai/dsh/lib/bin.js`，detached + `windowsHide` | 避免 `.cmd` shim 的 shell 包装与转义问题；无控制台窗口闪现 |
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
5. spawn：
   ```
   node.exe <npm-global>\node_modules\@deepseek-ai\dsh\lib\bin.js
        --profile web --host 127.0.0.1 --port 3080 [extraArgs...]
   options: { detached: true, windowsHide: true,
              stdio: ['ignore', logFd, logFd],  // stdout+stderr 追加写日志文件
              env: { ...process.env } }          // 透传 DSH_HOME 等；host 不注入 0.0.0.0
   ```
   - 日志文件先 `mkdir -p` 并追加打开（`fs.open(..., 'a')`），宿主退出后 fd 随宿主关闭，不影响 dsh 后续写入。
   - **不用 `stdio:'ignore'` 也不用 pipe**：pipe 会在宿主退出后产生 EPIPE 风险；日志文件同时是 M3「查看日志」与「解析实际端口」的数据源（F5）。
6. 写 run 记录（先写 `.tmp` 再 `rename`，内容含 pid、port、profile、startedAt、version、cmdline；M4 新增 `requestedPort` 与 `logStartBytes`（spawn 时刻日志字节偏移））。
7. 释放锁；轮询端口（500ms 间隔，最长 30s）。就绪 → `running`；超时 → 返回 `START_TIMEOUT` + 日志尾部（此时**不杀进程**，交由用户查看日志后决定；进程可能仍在后台最终就绪）。
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
- M2：stop 自动走优雅路径（插件存在时），随后用 **run 记录里的 cmdline 原样重放** spawn——重启编排权在宿主（插件不需要、也不应该知道自己的 profile/启动参数，见 §7.5）。
- 接管实例（`adopted:true`）的重启：以接管时解析的 argv 原样重放（lifecycle 参数 profile/host/port 归一化为记录值；`--port 0` 归一化为接管时的实际端口），不走 §12.1 的 extraArgs 白名单（参数源自本机进程表，非扩展输入，见 §6.7）。
- **M4**：`--port 0` 启动的记录（`requestedPort===0`）按动态端口语义重放——重新以 `--port 0` 拉起并再次从日志回填实际端口（OS 重新分配）；接管实例不受影响（仍按接管时实际端口重放）。

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

1. **首选（无 shell）**：`npm prefix -g` → `<prefix>\node_modules\@deepseek-ai\dsh\lib\bin.js`，用 `process.execPath` 直接执行。无 shell 转义、无窗口、错误码干净。
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

### 8.2 popup（popup.html/js/css）

**视觉规范：与 dsh Web UI 设计系统对齐。** popup.css 直接内联 dsh 前端的设计令牌（`--dsw-*` 变量，浅色主题，与 Web GUI 一致）：字体栈 `-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", …`；主文字 `--dsw-alias-label-primary`（近黑 `rgb(15,17,21)`）；次要/说明文字 label-secondary / label-tertiary / label-caption；面板底 `--dsw-alias-bg-base`（白）；边框 `--dsw-alias-border-l1/l2`（`rgba(0,0,0,.04/.1)`）；悬停 `--dsw-alias-interactive-bg-hover`（`rgba(38,49,72,.06)`）；主按钮品牌黑底（`--dsw-alias-brand-primary`）白字、悬停 `--dsw-alias-button-primary-hover`；状态色 success `rgb(34,197,94)` / warn `rgb(245,158,11)` / error `rgb(236,19,19)` / business 蓝 `rgb(65,118,230)`；状态圆点复刻 Web UI 的分层圆点组件（外圈 10% 透明度光晕 + 内实心，忙碌态脉冲，error 红色）；按钮与面板圆角 12px、输入框 6px（均取自 Web UI 组件实测值，见 tools/visual-audit）。**图标与 Web UI 同源**：状态行左侧的 DeepSeek 鲸鱼 logo（182×24，侧栏左上角原样内联）与右侧的设置齿轮图标（16×16，侧栏左下角设置项原样内联，含 clipPath）。令牌值与图标均取自 dsh 前端产物（本仓库 `5f6ed241-…htm` 存档核验）。

布局（自上而下）：

```
┌──────────────────────────────┐
│ [鲸鱼logo] ● dsh web     [⚙] │   ← 分层圆点：灰 stopped / 琥珀脉冲 starting·stopping /
│ http://127.0.0.1:3080        │       绿 running / 蓝 external / 红 error；logo 与 ⚙ 图标
│                              │       与 Web UI 同源（侧栏左上 logo / 左下设置齿轮）
│                              │
│ [ 启动 ]  [ 停止 ]  [ 重启 ] │   ← 启动=黑底主按钮；停止=红字描边；重启=描边
│ [ 接管 ]  [ 打开 Web UI ]    │   ← 接管仅 external 时显示（黑底主按钮）
│                              │
│ 状态：running · PID 12345    │   ← M2：插件存在时追加 uptime/会话数等富状态
│ 日志尾部（异常时）           │
│ 提示文案      [查看日志]     │   ← M3：底部提示行右侧常驻「查看日志」入口
└──────────────────────────────┘
```

行为规范：

1. 打开即调 `status`，随后每 2s 轮询一次探活/status（popup 关闭自动停止）。
2. 所有 native 请求经 SW 中转（§8.3），popup 不直接 `connectNative`（避免 popup 关闭瞬间断开连接、杀死宿主中断操作）。
3. `starting` 成功后自动 `chrome.tabs.create` 打开 Web UI（可在设置关闭）。
4. 错误态展示错误码对应文案（§6.2 表）+「复制日志」按钮（日志内容由宿主在错误响应中带回尾部 20 行）。
5. 设置面板（popup 内二级视图）：port（默认 3080，**0 = 自动分配动态端口**，M4）、profile（默认 web）、host（固定 127.0.0.1，不可改，v1）、自动打开 UI 开关、徽标刷新间隔。存储于 `chrome.storage.local`（本机相关，不用 sync）。
6. popup 富状态与提示（M2）：status 返回 `lifecycle:true` 时明细行展示 `health` 富状态（uptime 格式化 + nodeVersion），底部提示「优雅停机已启用（dsh-lifecycle）」；`lifecycle:false` 时提示「安装 dsh-lifecycle 插件可优雅停机」；stop 完成 toast 按 `stopMethod` 区分「已优雅停止 / 已强制停止（未检测到插件或优雅超时）」。
7. `external` 状态（§6.6）：蓝点 + 「外部运行」；「接管」与「打开 Web UI」可用（启动/停止/重启禁用）；URL 行展示实际地址；明细行展示 PID 与「外部启动，点击接管后由扩展管理」；`externalCount > 1` 时追加实例数提示。
8. 「接管」（§6.7）：以 status 结果中的 `{pid, port}` 调 `adopt`；成功 → 立即刷新为 running/managed，按钮恢复标准三键；失败按错误码展示（`EXTERNAL_UNMANAGED` 提示实例已变化，重新打开 popup 刷新）。
9. **点击反馈（操作确认，M1.3/M2）**：任何操作点击后**立即乐观更新**——全部生命周期按钮禁用、被点按钮转圈 + 「…中」文案、出现不定进度条 + 阶段说明 + 已耗时（每秒刷新），随后由应答/轮询收敛到终态并弹 **toast 确认**：启动完成 / 已优雅停止或已强制停止（按 stopMethod）/ 重启完成 / 接管成功；restart 分两阶段可见（「正在重启：停止旧进程」→「新进程启动中，等待端口就绪」→「重启完成」）；失败弹红色 toast + 错误面板；`ALREADY_RUNNING`/`ALREADY_STOPPED` 幂等成功同样弹确认。操作请求在途（native ack 前）**暂停轮询**，避免 status 在 SW 串行队列后堆积；「复制日志」「设置保存」亦弹 toast。**举一反三**：手动刷新按钮（点击转圈到本次 status 返回）、设置表单无效输入红边框 + 抖动 + 聚焦、复制日志失败 toast、无操作时的状态漂移通知（外部实例出现/退出、意外停止、错误恢复），全部有明确反馈。
10. **动效与图标（M1.3）**：按钮按压缩放（`:active` scale 0.96，图标按钮 0.9）、面板/URL 行淡入、状态点颜色过渡、忙碌脉冲、按钮内 spinner 与不定进度条；`prefers-reduced-motion: reduce` 下全部动画关闭。扩展图标（16/48/128）由占位图替换为**与 Web UI 同源的鲸鱼图形**（路径 = 侧栏 logo 的鲸鱼部分，`--dsw-alias-label-primary` 色 #0F1115、透明底，`tools/icons/_gen-icons.js` 以 headless Chrome 4x 超采样 + 盒式降采样渲染生成）。
11. **日志入口（M3）**：底部提示行右侧常驻「查看日志」按钮 → `chrome.tabs.create(chrome.runtime.getURL('logs.html'))` 打开日志查看页（§8.4）。

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
4. 徽标刷新：`chrome.alarms`（30s）→ 本地 fetch 探活（不惊动宿主）→ 更新 `action.setBadgeText`（绿点/空白）与 title。**M4：settings.port === 0（动态端口）时本地探活不可行，改经 native `status` 判定**（宿主解析实际端口）。
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
2. **Shadow DOM 隔离**：宿主节点 + open shadow root，样式 `<style>` 内联在 shadow root 内（页面 CSS 不穿透 shadow，双向零干扰）；颜色复用经 CSS 自定义属性继承的 `--dsw-*` 令牌并带 fallback 值。
3. **全部动作经 SW 中转 native 宿主**（复用 §8.3 既有 `{type:'native'}` 通道，面板自身不直连 `/_lifecycle`）：2s 轮询 `status`（页面隐藏时暂停）；「停止」两步确认（首次点击进入 3s 待确认态，再点才执行——面板所在页面即将随 dsh 关闭，防误触）；「重启」按宿主 restart 语义（优雅停优先 + 原参数重放，§6.3）；动作在途按钮禁用 + spinner + 内联状态文案。
4. **不读取页面内容**：面板只读 `document.title` 做指纹判断，追加自身节点，绝不修改 dsh 页面 DOM。
5. 收起态为右下角状态小徽章（圆点 + 文本），点击展开面板；`prefers-reduced-motion` 关闭动画。

安全（§12.2 补充）：面板是扩展自有 content script（非页面脚本），消息只发给本扩展 SW；停止/重启走宿主全套防护（PID 复用校验、`EXTERNAL_UNMANAGED` 保护、锁、优雅降级链）；不新增任何权限与 host_permissions（回环匹配已有）。

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
├─ docs/
│  └─ design.md                  # 本文档
├─ extension/                    # 浏览器扩展（可直接「加载已解压的扩展程序」）
│  ├─ manifest.json
│  ├─ background.js
│  ├─ popup.html
│  ├─ popup.css
│  ├─ popup.js
│  ├─ logs.html                   # M3 日志查看页
│  ├─ logs.css
│  ├─ logs.js
│  ├─ content/
│  │  └─ panel.js                 # M3 页面内管理面板（content script，样式内联 + Shadow DOM）
│  └─ icons/{16,48,128}.png
├─ native-host/
│  ├─ host.js                    # 宿主主程序（零依赖）
│  ├─ host.cmd.template          # 安装器生成 .cmd 的模板
│  ├─ com.dsh.manager.json.template
│  ├─ install.ps1
│  ├─ uninstall.ps1
│  ├─ install.sh                  # Linux/macOS 安装器（M4，用户级 NativeMessagingHosts 清单）
│  ├─ uninstall.sh                # Linux/macOS 卸载器（M4）
│  └─ test/
│     └─ smoke.ps1               # 离线冒烟：直接管道喂 JSON 测宿主（见 §14）
├─ plugin/                       # M2 生命周期插件（独立 npm 包，dsh 侧）
│  └─ dsh-lifecycle/ …
├─ README.md                     # 用户安装/使用指引
└─ CHANGELOG.md
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
- **页面内面板（§8.6）**：content script 只注入 dsh 指纹页面（127.0.0.1/localhost 任意端口）；面板对页面的唯一写操作是追加自身 shadow 节点，不读取/修改页面 DOM 与数据；停止/重启经 SW → 宿主全套防护（PID 校验、外部实例保护、锁），面板不持有任何特权 API（无 `/_lifecycle` 直连、无宿主角色的独立判定）。

### 12.3 数据与凭据

- 扩展不读取、不存储 `$DSH_HOME` 下的凭据文件（`.credentials.yaml`）；状态展示仅含 pid/端口/时长/版本/健康字段。
- run 记录与日志落在 `%LOCALAPPDATA%`，仅本用户可读；日志中可能出现工作区路径，属于本机用户自身信息。

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

`test/smoke.js`（26 场景，2026-08-14 计数：Windows 339 PASS + 1 SKIP / Linux 346 PASS）：以 `--req/--res` 文件模式逐请求
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

扩展 UI：`tools/verify-ui/verify-cdp.js`（28 断言，零依赖 CDP，沙箱内可用）——
扩展加载、popup/logs 截图与文本断言、页面内面板注入/展开/停止两步确认态、日志页
「加载更早/复制全部」交互、popup 设置校验交互、徽标三步实测、console 异常检查。

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

---

## 17. 附录：参考链接

- dsh 仓库：https://github.com/deepseek-ai/deepseek-harness
- dsh npm 包：https://www.npmjs.com/package/@deepseek-ai/dsh
- dsh-web-app：https://www.npmjs.com/package/@deepseek-ai/dsh-web-app
- Chrome Native Messaging 文档：https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- 社区相关项目（思路佐证）：oh-dsh-desktop（macOS 桌面工作台，https://github.com/hust-open-atom-club/oh-dsh-desktop）、dsh-web-ui 插件合集（https://github.com/zhu1090093659/dsh-web-ui）
