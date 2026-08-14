# dsh-lifecycle

给 DeepSeek Harness（dsh）web 面提供进程内生命周期能力的可选插件：一个回环围栏保护的
**优雅停机端点** 与一个 **健康端点**。它解决的是进程外组件（浏览器扩展 + Native 宿主）
做不到的事 —— 进入 dsh 自身的 dispose 生命周期，从而在 Windows 上也能优雅停止（否则只能
`taskkill` 硬杀）。

## 功能

| 方法 | 路径 | 响应 | 语义 |
|------|------|------|------|
| `POST` | `/_lifecycle/shutdown` | `202 {"ok":true}`（重复请求 `409`） | 先刷出响应，再 `appExit(0)`：优雅 dispose 请求（触发 dsh 官方 fiber dispose，端口随之关闭）；进程退出依赖事件循环自然排空，**不保证必然退出**；DSH Manager 宿主以端口关闭为判定权威，必要时 taskkill 回退 |
| `GET`  | `/_lifecycle/health`    | `200` JSON | 健康/富状态（下见示例） |

health 响应：

```json
{
  "ok": true,
  "pid": 12345,
  "uptimeMs": 182000,
  "port": 3080,
  "nodeVersion": "v22.16.0"
}
```

## 端点用法（curl 示例）

```bash
# 健康检查
curl http://127.0.0.1:3080/_lifecycle/health
# → {"ok":true,"pid":12345,"uptimeMs":182000,"port":3080,"nodeVersion":"v22.16.0"}

# 优雅停机（返回 202 后 dsh 开始 dispose；重复 POST 返回 409 Conflict）
curl -i -X POST http://127.0.0.1:3080/_lifecycle/shutdown
# → HTTP/1.1 202 Accepted
#   {"ok":true}
```

## 安装（实测语法，勿臆测）

本插件基于本机安装的 `@deepseek-ai/dsh@0.1.0-rc.6` 源码逐条核验。核心事实：

- `dsh plugin --profile <name> <args...>` 是 **pnpm 转发器**：先初始化 profile，再在 profile
  目录里执行 `pnpm <args...>`，随后调用 `reconcilePlugins` 把装了「`dsh.bundle.patch`」声明的
  依赖加入 `dsh.profile.bundles` 层栈。
- **只有当包的 `package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`
  且随包附带该 `cordis.patch.yml`（内含 `- insert: [{id, name}]` 挂载行）时，包才会真正挂载为
  插件层。** 否则它只作为普通依赖安装，并打印
  `dsh: warning: <pkg> declares no dsh.bundle — installed as a plain dependency, not a profile layer`，
  插件不生效。本包已在 `package.json` 声明 `dsh.bundle` 并附带 `cordis.patch.yml`。
- 相对路径 spec（`./`、`../xxx`、`file:`/`link:` 形式）会以**你执行 `dsh` 的目录**为锚点解析
  （`anchorPathSpec` 用 `resolve(cwd, path)`），不会被 profile 目录吞掉。

### ⚠️ Windows 跨盘符陷阱（2026-08-14 实测）

**当插件仓库与 profile 目录不在同一盘符时（本机：仓库在 `D:\`、profile 在 `C:\`），
`dsh plugin add` 会失败**——pnpm v10 把 `D:\...` 当相对路径段处理：`link:` 装出坏 junction
（target 变成 `...\profiles\web\D:\...`，dsh 读不到 package.json，reconcile 报
`declares no dsh.bundle`），`file:` 与 `file:///` 形式直接
`ENOENT: scandir '...\web\D:\...'`。这是 pnpm 侧缺陷，与插件无关。**同盘符**（例如仓库也放
C 盘）时 `dsh plugin --profile web add ./plugin/dsh-lifecycle` 可直接用（仓库根执行）。

### 方式 A（本机验证通过）：复制到 `.dsh\plugins` + 相对路径 link

> **注意：`.dsh\plugins` 是本项目自选的本地目录，不是 dsh 官方插件目录约定。**
> dsh 官方只认 `dsh.profile.bundles` + `dsh.bundle.patch` 双锚点解析；`link:` 的落点目录可
> 任意自选（只要相对路径能指到包所在位置）。这里选 `.dsh\plugins` 仅为方便统一管理。

```powershell
# 1) 把插件复制到 profile 同级插件目录
Copy-Item -Recurse -Force <repo-root>\plugin\dsh-lifecycle `
  C:\Users\<user>\.dsh\plugins\dsh-lifecycle

# 2) 在 profile 目录内以相对路径 link 安装（cwd 必须是 profile 目录）
Set-Location C:\Users\<user>\.dsh\profiles\web
pnpm add link:..\..\plugins\dsh-lifecycle

# 3) 重新 reconcile：把已安装的 bundle 依赖刷进 dsh.profile.bundles
#    （若 pnpm add 后已自动 reconcile，此步可省略）
dsh plugin --profile web install
```

验证：profile 的 `package.json` 中 `dependencies` 含 `dsh-lifecycle`（link 形式）且
`dsh.profile.bundles` 含 `dsh-lifecycle`。重启 `dsh web` 后生效。
以后升级插件：更新 `C:\Users\<user>\.dsh\plugins\dsh-lifecycle` 文件后重启 dsh 即可（link 实时生效）。

### 方式 B：`cordis.patch.yml` 手动挂载（不装 pnpm）

在 profile 目录（`%DSH_HOME%\profiles\web\cordis.patch.yml`）里插入本插件行，并把本包
放到 Node 可解析的位置：

```yaml
# %DSH_HOME%\profiles\web\cordis.patch.yml
- insert:
    - id: dsh-lifecycle
      name: 'dsh-lifecycle'   # 或本包 checkout 的绝对路径
```

## 安全围栏

插件路由**不经过** `/api` 网关的 trusted-host 围栏，由本插件自行校验（以下任一不满足即 403，
方法不符即 405）：

1. `req.socket.remoteAddress` 必须为回环：`127.0.0.1` / `::1` / `::ffff:127.0.0.1`；
2. `Host` 头必须匹配 `/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/`；
3. `sec-fetch-site` 头**存在且为 `cross-site`** 时直接拒绝（与官方 `/api` 围栏
   `isTrustedApiRequest` 对齐）；
4. `Origin` 头**存在时**，其 host 必须与 `Host` 的 host 相等（异源拒绝；无 `Origin` 放行）。

由此：浏览器扩展页面直接 `fetch`（带 `chrome-extension://` Origin）会被拒；而「扩展 → 宿主 →
HTTP」链路（宿主请求不带 Origin）天然合规。`shutdown` 仅 `POST`，`health` 仅 `GET`。

## 与浏览器扩展的关系（DSH Manager）

- **双层正交、双向可选**：装了插件 → 宿主 stop 先 `POST /_lifecycle/shutdown` 优雅停（3s 内
  端口关闭；`appExit` 不保证进程退出，端口未关或进程残留时宿主 taskkill 回退）；没装插件 →
  宿主自动降级 `taskkill /T /F`，状态用端口探活，功能不受影响。
- 插件不自己 respawn：进程内拿不到启动参数，重启编排权在宿主（持有 run 记录的 `cmdline`）。

## 开发 / 测试

```powershell
node --check index.js
node --test test/
```

零运行时依赖（只依赖 dsh 注入的 `webServer` / `appExit` 服务）；`package.json` 以
`peerDependencies: { "@deepseek-ai/dsh": ">=0.1.0-rc.6 <0.2.0" }` 声明与 dsh 的兼容范围
（仅语义声明，不随包安装依赖）。
