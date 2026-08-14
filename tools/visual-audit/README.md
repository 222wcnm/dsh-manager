# visual-audit — popup 视觉审计工具（一次性辅助，非扩展运行时组件）

用 headless Chrome + CDP 代替「眼睛」做 UI 校准：渲染 popup 各状态并截图，同时把每个元素的
computed style（颜色 RGB / 字体 / 圆角 / 位置）与 dsh Web UI 参考组件的同源组件逐项对比
（若仓库根存在 dsh Web UI 存档，`_audit.js` 会一并提取；存档缺失则跳过该对比）。

## 组成

| 文件 | 作用 |
|------|------|
| `preview.html` | popup 的预览页：stub `chrome.*` API，`#hash` 控制状态（stopped / running / external / starting / error / settings-stopped / busy-restart / busy-stop / toast / m2-health / m2-noplugin） |
| `_audit.js` | 启动 headless Chrome（CDP 9333）→ 6 状态截图到 `shots\*.png` → 提取 computed style 与 Web UI 参考组件样式 → 写 `_audit.json` |
| `_report.js` | 把 `_audit.json` 打印成可读报告 |
| `_verify.js` | 断言关键指标（圆角 12px、主按钮字重 500、error 红点等） |
| `shots\*.png` | 最近一次审计的渲染截图（供人工查看） |

`busy-restart`/`busy-stop`/`toast` 三个 hash 用于快照 M1.3 的点击反馈 UI（进度条/阶段文案/完成 toast）；
沙箱内可用 `vision_html_screenshot` 渲染 `#hash` 变体（该工具不接受 URL hash，需生成
`preview-<state>.html` 副本把 `const st = '…'` 写死后渲染，用完即删）。

## 运行

```powershell
# 注意：沙箱会拦截 Chrome 进程内 IPC（mojo 拒绝访问），须在沙箱外运行
node tools\visual-audit\_audit.js
node tools\visual-audit\_verify.js
```

## 校准结论（2026-08-14）

以 Web UI 存档实测值为基准：

- 按钮圆角 12px（newSession 实测）、主按钮字重 500、设置/错误面板 12px —— 已对齐
- error 状态圆点红色 `rgb(236,19,19)`（存档中 `_dot_10orb_3[data-state=error]` 实测）—— 已修复（setError 置 state='error'）
- 图标按钮 28×28 圆形 + label-secondary、分层圆点（10% 光晕 + 内实心）—— 与 Web UI 组件实测一致
- 设计令牌 `--dsw-*` 计算值与存档解析值逐项一致（`_audit.json` tokensPreview）

## 已知局限

- 悬停态（hover）无法在无头渲染中自动触发，仅按令牌值静态对齐（hover 色值同源，风险低）。
- 如需让模型直接读取并迭代截屏，请自行接入具备图像输入能力的模型或相关视觉桥接工具。
