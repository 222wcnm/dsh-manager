# 贡献指南（CONTRIBUTING）

感谢关注 DSH Manager！本文帮助新贡献者了解项目、搭建环境并安全地提交改动。

## 项目是什么

DSH Manager 是一个 Chrome/Edge 浏览器扩展 + Native Messaging 原生宿主，用于管理
DeepSeek Harness（dsh）的 Web 服务生命周期——在浏览器里一键启动 / 停止 / 重启
`dsh web`（默认 `http://127.0.0.1:3080`），免开终端。M2 起附 `dsh-lifecycle` 插件：
安装后停止走官方 dispose 优雅停机（`POST /_lifecycle/shutdown`），并提供
`GET /_lifecycle/health` 健康端点。

> 本项目是**非官方**社区工具，与 DeepSeek（深度求索）无隶属、无背书关系。详见
> [NOTICE](../NOTICE) 与 [README](../README.md) 文末免责声明。

## 权威文档（改动前必读）

- `docs/design.md` — 唯一规格：架构决策、dsh 事实基线（基于 `@deepseek-ai/dsh@0.1.0-rc.6`
  逐条核验）、宿主协议、安全模型、路线图
- `native-host/test/VERIFICATION.md` — M1–M2 验收报告与已知偏差清单
- `native-host/test/manual-e2e.md` — 人工验证清单

**约定：重大改动先改 `docs/design.md` 再改代码；扩展与宿主之间的协议变更必须同步设计文档与两处实现；改宿主必须补跑/新增冒烟场景。**

## 目录结构

- `extension/` — Chrome MV3 扩展（原生 JS 零依赖）：`manifest.json`（含固定 key，决定扩展 ID；
  `browser_specific_settings.gecko.id` 决定 Firefox 附加组件 ID）、`background.js`
  （串行 native 调用 + 徽标 + 按 action 区分超时）、`popup.html/css/js`
  （点击反馈 / 动效 / 状态面板）、`logs.html/css/js`（M3 日志查看页）、
  `content/panel.js`（M3 页面内管理面板，content script + Shadow DOM）、`icons/`
  （鲸鱼 logo，由 `tools/icons` 生成）
- `native-host/` — `host.js`（零依赖 Node CJS 宿主；stdio 4 字节帧协议 + `--req/--res`
  文件测试模式；health 探测 + 优雅停 + `stopMethod` + `logs` 动作 + `--port 0` 动态端口）、
  `install.ps1` / `uninstall.ps1`（注册 Chrome/Edge/Firefox 宿主，UTF-8 带 BOM）、
  模板、`test/`（`smoke.js`、`fake-dsh.js`、`smoke-real.js`）
- `plugin/dsh-lifecycle/` — M2 插件包（ESM/Cordis，`dsh.bundle` + `cordis.patch.yml` 挂载）
- `tools/` — `icons`（图标生成器）、`visual-audit`（popup 视觉审计 / 预览）、
  `verify-ui`（扩展 UI 自动验收：`verify-cdp.js` 沙箱内可用、`verify-ui.js` MCP 路径需沙箱外）
- `docs/` — 设计文档

## 环境要求

- Node ≥ 18；dsh 0.1.0-rc.6 全局安装；默认端口 3080
- 宿主安装位置 `%LOCALAPPDATA%\dsh-manager\host\`（`host.cmd` 内为绝对路径，**项目移动后必须重跑 `install.ps1`**）；注册表 HKCU：Chrome/Edge 的 `NativeMessagingHosts\com.dsh.manager`

## 常用命令

```powershell
node --check native-host/host.js                     # 宿主语法检查
node native-host/test/smoke.js                       # 冒烟测试（fake-dsh，默认围栏真实进程枚举）
node native-host/test/smoke-real.js                  # 真实 dsh 集成（需 DSH_MANAGER_NPM_PREFIX=%APPDATA%\npm）
node --test "plugin\dsh-lifecycle\test\*.test.js"    # dsh-lifecycle 插件单测
node tools\icons\_gen-icons.js --selftest            # 图标生成器自检（生成需沙箱外/提权）
powershell -ExecutionPolicy Bypass -File native-host\install.ps1 -DryRun   # 安装预演
```

- 扩展改动 → `chrome://extensions` 重新加载
- 宿主或安装器改动 → 重跑 `install.ps1` 并**完全重启浏览器**（native host 注册只在浏览器启动时读取）

## 下一步路线（docs/design.md §15）

- M3：体验增强（日志查看与复制、Web UI 页面内管理面板）—— 已完成
- M4：跨平台（macOS/Linux SIGTERM 优雅停、Firefox 运行时验证、`--port 0` 已支持）
- M5：向上游 deepseek-harness 提 lifecycle 子命令 PR（官方暂不接受外部 PR，走 Discussions）

## 安全报告

发现安全或隐私问题请走 [SECURITY.md](SECURITY.md) 所述渠道，**勿**提交至 DeepSeek 官方。
