# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

> 发布仓库只携带面向使用者的正式版本条目；开发期迭代流水账见开发仓库（不随发布物分发）。

## [0.1.0] - 2026-08-14

首个公开版本：把 `dsh web` 的开关装进浏览器。

### 新增

- 一键启动 / 停止 / 重启 `dsh web`；停止自动走 `dsh-lifecycle` 优雅停机，插件缺失时强制降级
- 外部实例检测与接管：识别终端手工启动的 dsh web（任意端口，含 `--port 0`），「接管」后即可停止 / 重启
- 状态徽标与 popup 面板（stopped / starting / running / stopping / external），与 dsh Web UI 同款视觉
- 日志查看页：自动刷新尾部、逐块加载更早、一键复制全部
- dsh Web UI 页面内管理面板：右下角徽章，两步确认停止、一键重启
- 端口设为 `0` 自动分配动态端口，启动后自动回填实际端口
- 可选插件 `plugin/dsh-lifecycle`：`POST /_lifecycle/shutdown` 优雅停机 + `GET /_lifecycle/health` 健康端点
- 平台：Windows 10/11 + Chrome / Edge 生产实测；Linux 平台层与安装器（install.sh）实测通过（Kali WSL2）；Firefox 宿主注册就绪（运行时未实测）；macOS 已实现未实测

### 安全

- 仅 127.0.0.1 回环通信；不读取、不存储 dsh 凭据；宿主仅接受本扩展固定 ID

### 已知限制

- macOS 与 Firefox 运行时未实测（无对应设备验证环境）
- 未安装 `dsh-lifecycle` 时停止走强制终止，可能丢失最近数秒会话状态
- 尚未上架 Chrome Web Store，需以「开发者模式」加载 `extension/` 目录
