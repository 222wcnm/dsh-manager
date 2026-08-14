# tools/linux — WSL Linux 验证（M4）

`verify-linux.ps1`：在 WSL 发行版（默认 **kali-linux**）内实测 host.js 的 POSIX 平台层
（design §6.8）——`~/.config` 状态目录、SIGTERM→SIGKILL 终止、/proc 进程枚举与
端口表、/proc PID 校验。脚本在发行版用户目录准备**便携 Node**（官方 linux-x64
tarball，免 sudo/apt），以 Linux Node 直接运行仓库的 `native-host/test/smoke.js`
（仓库经 `/mnt/<盘>/` 挂载，`.smoke` 产物落仓库工作区，gitignore 已覆盖）。

Linux 下冒烟**不设进程枚举围栏**：smoke 场景 26 不注入任何 fake 钩子，以真实
/proc 枚举 + /proc/net/tcp 端口表 + /proc PID 校验 + HTTP 指纹完成外部实例
发现/接管/停止全链路（Windows 该场景记 SKIP，围栏仅 Windows 使用——本机常驻
真实 dsh web 会干扰「空目录→stopped」场景）。

## 用法

```powershell
# 首次：安装 WSL 发行版（一次性，数百 MB 下载）
wsl --install -d kali-linux --no-launch

# 运行验证（自动准备 Node + 跑完整冒烟）
powershell -ExecutionPolicy Bypass -File tools\linux\verify-linux.ps1

# 冒烟通过后再跑「真实安装」E2E（发行版内 npm i -g 真实 dsh + install.sh 安装 +
# 经已安装宿主 start/status/指纹/stop + uninstall.sh 清理）
powershell -ExecutionPolicy Bypass -File tools\linux\verify-linux.ps1 -E2E
```

参数：`-Distro`（默认 kali-linux）、`-NodeVersion`（默认 22.16.0）、`-E2E`（追加真实安装 E2E）。

## 说明

- 冒烟验证宿主 POSIX 平台层（进程/网络/终止路径）；`-E2E` 追加验证
  `native-host/install.sh` / `uninstall.sh` 安装链路（用户级浏览器清单注册、
  清单内容、真实 dsh 全链路）。E2E 会在发行版内 npm i -g 真实 dsh——其依赖
  node-pty 需本地编译，脚本自动补装 build-essential/python3（幂等）。
- 浏览器扩展（popup 等 UI）仍以 Windows 侧 verify-cdp.js 覆盖；Linux 桌面浏览器的
  扩展运行时未实测（WSL 无桌面浏览器）。
- macOS 仍无验证环境（无 macOS 设备）：install.sh 的 `uname -s` 分支与宿主
  `ps`/`lsof` 分支代码已写但未实测，设计文档如实标注。
