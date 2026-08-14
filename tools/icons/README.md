# tools/icons — 扩展图标生成（一次性辅助，非扩展运行时组件）

把与 Web UI 同源的鲸鱼图形渲染为 `extension/icons/{16,48,128}.png`。

| 文件 | 作用 |
|------|------|
| `whale.svg` | 鲸鱼图形（路径取自 popup.html 内联 brand-logo 的鲸鱼部分，色值 `--dsw-alias-label-primary` #0F1115，viewBox 已加留白并居中） |
| `_gen-icons.js` | headless Chrome + CDP 渲染：透明背景、4x 超采样后盒式降采样（预乘 alpha）、内置 PNG 编码器，产物写入 `extension/icons/` |

## 运行

```powershell
node tools\icons\_gen-icons.js --selftest   # 纯 Node 自检（PNG 编解码/降采样，不需 Chrome）
node tools\icons\_gen-icons.js              # 生成 3 个图标（沙箱会拦截 Chrome IPC，需沙箱外/提权运行）
```

## 修改图形

编辑 `whale.svg` 后重跑 `_gen-icons.js` 即可。改色改 viewBox 都在 `whale.svg` 里做；
尺寸列表在 `_gen-icons.js` 的 `SIZE` 常量。
