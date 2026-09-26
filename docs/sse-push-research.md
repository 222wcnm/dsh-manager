# 会话状态推送升级研究：被动轮询 → SSE 主动推送

> 研究日期：2026-08-26　事实基线：本机真实 `@deepseek-ai/dsh@0.1.1-rc.2`
> （注：AGENTS.md 已注明事实基线从 0.1.0-rc.6 漂移到 0.1.1-rc.2；插件 README 与 design.md §2 仍标注 0.1.0-rc.6，需一并同步）

## 1. 结论先行

- **推荐方案：在 dsh-lifecycle 插件中新增 `GET /_manager/events`（Server-Sent Events 流式端点）**，
  由 dsh 宿主内部事件（`session/event` / `session/created` / `session/disposed` / `agent/status`）
  驱动即时推送。零新依赖、零轮询、真正 0 延迟（事件回调同步触发）。
- **选 SSE 而不是 WebSocket**。决定性理由：
  1. 需求方向单一（宿主 → 消费方只读推送），SSE 恰好足够；
  2. WebSocket 需要 `ws` 库（dsh 的嵌套依赖，插件无法解析）或裸实现 RFC6455（帧/掩码/关闭 ~150 行），
     SSE 用 Node `http` 响应分块即可，零依赖（与本插件现行零依赖纪律一致）；
  3. 消费者兼容性：浏览器 `EventSource` 内建自动重连；宿主 `http.get` + 行解析即可；curl 可直接排障；
  4. 官方即有此先例：`dsh-client-hmr` 的 `GET /plugins/events` 就是 SSE（index.js L114-150）；
  5. WebSocket 的唯一优势（双向）本架构用不到——生命周期操作已有 `/_lifecycle/shutdown` 通道；
  6. 扩展 popup 因 Origin 围栏**同样不能直连 WebSocket**，WS 相对 SSE 无任何消费者优势。
- **消费端分两层**：
  - 页面内面板（content/panel.js）：**同源 EventSource 直连**——这是「消除空轮询 + 0 延迟」的
    主要收益点（当前主战场是面板隐藏时 1Hz 端点轮询）；
  - popup：`chrome-extension://` Origin 被围栏拒绝，必须经宿主转发——建议一期保持 2s 轮询
    （只在 popup 打开期间发生，成本低），二期再上「storage 镜像桥」轻量方案（见 §5）。
- **官方 `/api/events.host` 通道不适合直接替代**（实测确认：无 Upgrade 的 GET 返回
  `426 upgrade required`——官方把浏览器通道钉死为 WebSocket；且 host 帧只有 `running` bool，
  四态中的 `waiting` 需 mux 帧（携带消息内容，违反 §12.2 红线）由 webui 客户端派生）。

## 2. 现状轮询清单（谁在轮、轮什么、成本）

| 消费面 | 位置 | 周期 | 请求链 | 成本 |
|---|---|---|---|---|
| popup 状态 | `extension/popup.js` L173 `setInterval(refreshStatus, 2000)` | 2s | popup → SW → `connectNative`（每次 spawn 宿主进程）→ 宿主 `computeStatus` | popup 打开期间每 2s 一次完整往返 |
| popup 会话区 | `popup.js` L314/L429 `refreshSessions()` | 2s（仅 running/external） | 同上 → 宿主 `getManagerSessions` GET `/_manager/sessions`（1.5s 超时） | 同上串行 |
| 面板（页面可见） | `content/panel.js` L482 `startPoll`（`POLL_MS=2000`） | 2s | SW → 宿主 status | 可见时 |
| **面板（页面隐藏）** | `panel.js` L533-652 `attTick`（`ATTENTION_TICK_MS=1000`） | **1s** | 每个 dsh 标签每 1s `fetch('/_manager/sessions')`（1.5s 超时 + `attBusy` 防叠）；失败回退 DOM 扫描 | **空轮询主体**：每后台标签 1 req/s，Chrome 隐藏页节流至 1Hz（设计上就是贴着节流上限打） |
| 徽标 | `background.js` L495-498 `chrome.alarms`（30s） | 30s | 探活/status | 低频；但状态变化上线 ≤ 1s＋30s |
| 日志页 | `logs.js` L333 `FOLLOW_INTERVAL_MS=2000` | 2s | native logs | 独立问题（日志尾部本就该拉取），不在本课题 |

宿主侧对应实现：`native-host/host.js` `getManagerSessions`（L436）与 `actionSessions`（L1951）。

## 3. 服务端事件源（已核源码，§8.10「M9.1 spike」的官方机制）

dsh 宿主的会话事件源是 **Cordis 事件总线**，全部可订阅：

| 事件 | 定义位置 | 负载 | 用途 |
|---|---|---|---|
| `session/event` | `@deepseek-ai/dsh-session/lib/index.js` L1443-1483（`Session.append()` 同步发布钩子；`collectSessionCallbacks` L1282-1283 = `ctx.events.dispatch`） | `(session, event)` | 每次 append 同步触发；**构造种子（回放/fork/resume）不发**（L1331-1333）——快照路径覆盖 |
| `session/created` | 同上 L1734-1760（`announce()` 发射） | `(session)` | 新会话挂载 |
| `session/disposed` | 同上 `detachEntered()` 配对发射（被 apiproxy L3584 订阅） | `(session)` | 会话释放 |
| `agent/status` | `@deepseek-ai/dsh-agent-loop/lib/index.js` L388 `this.dispatch.emit("agent/status", { status })` | `(payload)` | 运行态变化（`running` 等；apiproxy L3629 订阅解构 `{agent, status}`） |

官方消费者证据（同样的 app 级订阅模式）：`dsh-host-apiproxy` L3555（`session/event` 桥接进
mux 队列）、L3575（`session/created`）、L3584（`session/disposed`）、L3629（`agent/status`）；
`dsh-session-persistence-jsonl` L65-74、`dsh-session-title` L191 等。

**作用域结论**（可订阅性的关键）：`dsh-scope` 的 `scopeTarget`（lib/index.js L326-337）的过滤规则是
「事件只会**向上**流动——未打 scope 标签（untagged，即 app 级）的订阅者接收**所有**会话事件，
被打标签的订阅者只接收自己 scope 链的事件」。本插件经 `cordis.patch.yml` 挂载在 profile/应用层
（untagged），与 apiproxy 同构 → `ctx.on(...)` 可收到全部 live 会话的事件。这与插件当前
`ctx.get('sessions').list()` 能够列出全部 live 会话的事实互相印证。

**HTTP 层可行性**（webServer 服务，`@deepseek-ai/dsh-host-webserver/lib/index.js`）：
- `register({kind:'exact'|'prefixes', path, handler})`（L128-135），handler 收 Node `req/res`，
  回调后被 `await`（L186）——SSE 处理器可立即返回、由 `connections` 集合持有 `res` 继续写；
- dispose 时 `server.closeAllConnections()` 会**强制断开所有长连接**（L253-267）→ 插件卸载/服务
  停止即断流，消费端 `error` 自动降级；
- 官方 SSE 先例 `dsh-client-hmr`（`/plugins/events`，L114-150）：
  `res.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'})`
  → `res.write(': connected\n\n')` → 快照 → `connections.add(res)` → `res.on('close', ...)` 清理；
  心跳定时器用 `ctx.effect` + `setInterval`（L103-113，`timer.unref()`）。
- `registerUpgrade`（L142-148）与 `upgradedSockets` 追踪存在 → WebSocket 路由技术上可行
  （官方 `dsh-client-connection` L566-583 注册 `/api/events.host`、`/api/events.mux`）。
- 官方 `/api` 前缀把非 Upgrade 的 events GET 拒为 **426 "upgrade required"**
  （dsh-client-connection L538-544；本机 curl 实测一致）——官方浏览器通道是 WebSocket，
  apiproxy 内的 SSE（`toFetchHandler` L4889-4899）仅服务 in-process 客户端/测试。

**定时器**：`cordis-plugin-timer`（`dsh-base` 依赖）提供 `ctx.interval()`（fiber 自动清理）；
或沿用 `ctx.effect(() => { const t = setInterval(...); return () => clearInterval(t) })` 模式。

## 4. 推荐端点契约：`GET /_manager/events`

```
GET /_manager/events          （HTTP/1.1, text/event-stream）
```

- **围栏/方法校验**：与 `/_manager/sessions` 完全共用一个 `allow()`（loopback + Host 白名单 +
  `sec-fetch-site` + Origin 同源；403/405 语义一致）。两种合规消费路径：
  - 页面内面板（同源 `http://127.0.0.1:<port>` 页面，Origin=实例 Origin → 放行，已实测同源可 fetch）；
  - 宿主（无 Origin 头 → 放行，与现状 `/_manager/sessions` 同路径）；
  - 扩展 popup/SW（Origin=`chrome-extension://` → 拒绝，与现状一致）。
- **连接即快照**（`id` 为单调递增的连接级 seq）：
  ```
  id: 1
  event: snapshot
  data: {"ok":true,"items":[ <与 /_manager/sessions 完全相同的 summary 行> ]}
  ```
- **之后只推增量**（每帧 `id` 递增；客户端无需 Last-Event-ID 回放——重连即重新拿快照）：
  ```
  event: upsert
  data: {"session":{ <summary 行> }}

  event: removed
  data: {"sessionId":"session-xxx"}
  ```
- **心跳**：每 15s 一帧 `: ping`（防代理/网关空闲断连；Node 自身不超时）；建议帧 `retry: 3000`。
- **推送判定（关键细节，防事件风暴）**：仅当 summary 的**语义字段**变化才推送
  （`state` / `title` / `blank` / `cwd` / `childRuns`）；**`updatedAt` 不参与 diff**——否则
  `assistant/chunk` 每秒多次都会触发推送，违背"只在状态切换时推送"的目标。
- **订阅触发 → 重算 → diff → 广播**：
  - `ctx.on('session/event', (session, event))`：仅对**相关事件类型**重算该会话——
    `approval/asked`、`approval/decided`、`tool/call`（name=`ask_user_question`）、`tool/result`、
    `turn/start`、`turn/end`、`subagent/start`、`subagent/end`、`session/title`；
    其余（`assistant/chunk`、`tool/result` 非问答、`*` 杂项）直接忽略；
  - `ctx.on('session/created')` → 对该会话 upsert（子代理会话由 parent 的 `subagent/start` 事件驱动
    parent 重算，顶层仍跳过 `origin='subagent'`——与现有 `summarizeSession` 语义一致）；
  - `ctx.on('session/disposed')` → `removed` + 其 parent（若有 childRuns 引用）重算；
  - `ctx.on('agent/status')` → 对应会话重算 `running` → `state`（`working`/`completed`）；
  - 重算实现：复用现有 `summarizeSession`（盲扫 `session.events`，日志量级数百~数千，每相关事件
    O(n) 可接受）；如遇超长会话高频事件，可升级为增量索引（`approval/asked→decided` 集合、
    `tool/call→tool/result` 集合，`session/created` 时对种子折叠一次，后续 O(1)）——apiproxy
    的 `openCalls`（L3553-3566）即同款增量模式的官方先例。
  - 同会话 50ms 内的多事件合并：`ctx.debounce` / 简单 per-session 挂起标志。
- **连接管理**：`connections = new Set()`；`res.on('close', () => connections.delete(res))`；
  写前守卫 `res.writableEnded || res.destroyed`；广播失败（残连）自愈移除。
- **与 `/_manager/sessions` 的关系**：原端点**保留不动**（兼容、快照源、宿主快取、降级路径），
  新端点只是"推送面"。二者共享同一套 `summarizeSession`/`allow`/归档过滤（`workspaceRegistry.
  archivedSessionIds` + 有运行中子代理例外）与子代理标签折叠逻辑，确保两个视图口径一致。

## 5. 消费端改造

### 5.1 面板 panel.js（推荐先做，主要收益）

- 用 `new EventSource('/_manager/events')`（同源；页面 CSP 无限制——现有同源 fetch 已实测可用）替代
  `attTick` 的 1Hz 端点轮询；`snapshot` 建基线，`upsert`/`removed` 增量维护计数
  （`{working, waiting}` 与现状一致），**每次变化立即 `attSend` 上报 SW**（徽标从 ≤1s 延迟 → <100ms）
  并更新面板状态卡/会话摘要。
- `EventSource` 不可用（插件未装/旧版/重复断连超阈值）时**回退**现有 `attTick` 端点轮询 + DOM 扫描
  （现状代码保留为降级分支，不删除）。
- 状态机简化提示：`done-fired` 的 1.2s 稳定空态防抖是 DOM 扫描时代的产物（吸收 React 重渲染抖动）；
  事件驱动后可用 `turn/end` + `agent/status` 直接判定，但**需与 M8 语义对齐**（"一轮工作完成"）——
  建议保留 attPhase 状态机、仅把输入从"1Hz 快照"换成"事件流"，行为完全兼容。
- 实例状态（running/stopped）2s 轮询可保留（可见时才轮询）；也可由"SSE 连接存活/断开"推断
  （断开 = 实例停/插件卸载）——建议二期评估，一期不动。

### 5.2 popup（二期）

popup 是 `chrome-extension://` 页面，**无法直连**（Origin 围栏）。两个子方案：

- **B1 宿主长连接（协议 v2）**：SW 建立常驻 `connectNative` 端口；宿主持有 1 条 SSE、按
  "无 id 流帧" 上行推送。需要：§6.2 协议扩展（流帧语义）+ 宿主事件循环改造（SSE 与 stdio 交错）
  + SW 保活策略（MV3 SW 可被回收 → 端口断 → 宿主退 → 重连窗口期降级轮询）。改动大、风险中。
- **B2 storage 镜像桥（推荐二期先试）**：panel 的 EventSource 增量 → SW 维护
  `storage.local.sessionsSnapshot`（防抖 ~100ms）→ popup 订阅 `chrome.storage.onChanged` 即时渲染；
  native `sessions` 动作仅作兜底；**无需协议/宿主改动**（约 50 行）；代价：依赖"至少一个 dsh
  标签开着"——会话活动时该前提通常成立（会话由页面驱动，无人看页面时无推送也无所谓）。

一期：popup 保持现状 2s 轮询（只在打开时发生，成本可接受），不改协议。

## 6. 方案对比

| 方案 | 延迟 | 空轮询 | 新依赖 | 风险/成本 |
|---|---|---|---|---|
| **A 自有 SSE + 事件驱动（推荐）** | ~0（同步回调） | 0 | 零 | 依赖 Cordis 事件契约；事件流高频需 type 过滤 + diff 抑制 |
| A' SSE + 内部定时指纹（如 500ms 重算 diff、变化才推） | ≤500ms | 0（无外部网络）| 零 | 兜底方案：若某版本事件订阅不可用时的退化形态；进程内 0.5s 一次 O(n) 很轻 |
| B 官方 `/api/events.host` WS | 0 | 0 | `ws` 客户端（宿主零依赖受限）/裸实现 | 426 通道形态 + 仅 `running` bool（waiting 需 mux 帧=消息内容，**违反 §12.2 红线**）+ 官方帧协议随版本漂移；不适合 |
| C 自有 WS 端点 | 0 | 0 | `ws` 或裸 RFC6455 | 无消费者优势（popup 同样被 Origin 围栏挡）；成本高于 SSE |
| D 维持轮询 | 1-2s | 1 req/s/标签（隐藏时） | — | 现状 |

## 7. 实施步骤草稿（遵守项目约定：重大改动先改 design.md）

1. **design.md**：§8.10 增补端点契约（事件名/字段/id 语义/心跳/重连）；§12 补安全注记
   （摘要边界不变；两条合规消费路径：同源页面 & 无 Origin 宿主；popup 仍经宿主）；
   §15 路线图新增 M12「会话推送」。
2. **插件 `plugin/dsh-lifecycle`**：新增 `/_manager/events`（SSE 快照 + 增量 + 心跳 +
   事件订阅 + diff 判定 + 断连清理）；单测扩展（现有 33 项骨架 L45-70 的 `makeCtx` 增加
   `on(event, cb)` 事件捕获桩 + `ServerResponse` 流式桩，覆盖：快照首帧、相关/无关事件触发、
   diff 抑制、removed、403/405、`res.close` 清理、插件 dispose 断流）。
3. **panel.js**：EventSource 接入 + 降级保留；verify-cdp M8/M9 段改为 mock 事件源驱动的断言
   （现有 `sessionsMockProvider` 可扩展成 SSE mock 或直接调 `onmessage` 注入）。
4. **（可选二期）** popup B2 storage 镜像桥。
5. **真机验收**：真实 dsh 起两个标签 + 触发 approval → 徽标/面板在 <100ms 内变化
   （现为 ≤1s + 30s）；子代理 start/end 时父行 childRuns 即时增删。

## 8. 风险与未决问题

- **事件契约漂移**：本机已装 0.1.1-rc.2（AGENTS.md 已注明基线漂移，插件 README/design §2 待同步）。
  `agent/status` 的发射形为 `this.dispatch.emit("agent/status", { status })`（agent-loop L388），
  而 apiproxy 订阅解构 `{ agent, status }`——`dispatch` 是否注入 agent 需实现时以实机/源码再核，
  实现侧应做 `payload.agent ?? agentFromApi` 双兜底。插件 `peerDependencies` 范围建议随事实基线
  调整为 `>=0.1.1-rc.2 <0.2.0`。
- **MV3 SW 回收**：只影响 B1；一期路径（页面内 EventSource）不受影响。
- **多标签多连接**：每个 dsh 标签 1 条 SSE + 1 组事件监听。连接数 = 打开标签数（个位数）；
  事件订阅成本 N 连接 × 每秒几十个事件 × 轻量 diff——可接受；必要时做"同实例连接合并"
  （首个订阅者建流、其余复用）——一期不做。
- **事件风暴**：由 type 白名单 + diff 抑制解决；`updatedAt` 不参与 diff。
- **口径差异**：attTick 的 1.2s 稳定空态防抖 → 事件驱动可能更快触发 done；与 M8 "一轮工作完成"
  语义对齐验证（可用 `turn/end` 事件本身作为"一轮结束"锚点，替代防抖）。
- **心跳必要性**：Chrome 对活跃 EventSource 不设空闲超时，但 NAT/代理会；15s 心跳为标准防御。
- **会话区已读/保留逻辑（M11）**：全部在 popup 渲染层（`readAtOf`/`isFreshCompleted`/retentionMins），
  推送只提供原始 summary 数据流，不改动这些语义。

## 附录：本机实测记录

- `http://127.0.0.1:3080/_manager/sessions` → `200 {"ok":true,"items":[...]}`（含当前会话
  `state:"working"`——插件在本机真实 dsh 0.1.1-rc.2 上工作正常；端点返回的正是本次研究会话）。
- `curl http://127.0.0.1:3080/api/events.host`（无 Upgrade）→ `426 upgrade required`
  ——验证官方浏览器通道形态为 WebSocket，非 Upgrade 普通 GET 不可用。
