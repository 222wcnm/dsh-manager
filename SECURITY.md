# 安全策略（SECURITY）

## 数据与凭据

- 本扩展**不读取、不存储** dsh 的凭据文件（`$DSH_HOME` 下的 `.credentials.yaml` 等）。
  状态展示仅含 pid / 端口 / 时长 / 版本 / 健康字段。
- 扩展与宿主的通信仅限 `127.0.0.1` 回环；宿主清单的 `allowed_origins` 仅含本项目固定扩展 ID。
- 状态文件与日志位于 `%LOCALAPPDATA%\dsh-manager\`，仅当前用户可读。

## 漏洞报告

- 请通过**本仓库的 Issue** 提交漏洞或安全疑虑。
- 本仓库是**非官方**社区工具，与 DeepSeek（深度求索）无隶属、无背书关系——**请勿**将本工具
  的漏洞提交至 DeepSeek 官方渠道。

## 本机进程管理工具的风险边界

本项目是一个本机进程管理工具，其安全边界与固有风险包括：

- 扩展以 `taskkill /T /F` 强制终止 dsh 进程（安装 `dsh-lifecycle` 插件后自动改用官方优雅停机），
  **可能丢失最近数秒会话状态**。
- 安装器会写入 HKCU 注册表（Chrome/Edge 的 `NativeMessagingHosts\com.dsh.manager`），仅当前用户、无需管理员权限。
- 宿主以当前用户身份启动/停止进程，不提升权限、不执行 shell 字符串拼接命令。

请仅在可信环境中自行安装，并在使用前阅读 [README](README.md) 文末免责声明。
