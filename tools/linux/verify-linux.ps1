<#
.SYNOPSIS
    DSH Manager — 在 WSL Linux 发行版内跑宿主冒烟测试（tools/linux/verify-linux.ps1）

.DESCRIPTION
    M4 跨平台验证：用 WSL 发行版（默认 kali-linux）实测 host.js 的 POSIX 平台层
    （~/.config 状态目录、SIGTERM→SIGKILL 终止、/proc 进程枚举与端口表、/proc PID
    校验）。本脚本是薄封装：发行版内的一切工作（xz-utils 准备、便携 Node 下载、
    冒烟运行与日志落盘）都由仓库内 tools/linux/run-smoke-linux.sh 完成，两处逻辑
    不重复；冒烟输出重定向到仓库 .linux-smoke.log（规避 PS 5.1 下 wsl.exe UTF-16
    管道乱码），脚本以退出码驱动成败判定。

    注意：不设全局 $ErrorActionPreference='Stop'——wsl.exe 的 stderr 警告（如
    .wslconfig 中的过时选项提示）在 PS 5.1 下会变成 NativeCommandError 异常。

.PARAMETER Distro
    WSL 发行版名（默认 kali-linux）。

.PARAMETER NodeVersion
    便携 Node 版本（默认 22.16.0），经 NODE_VERSION 环境变量传给发行版内脚本。

.PARAMETER E2E
    冒烟通过后追加运行 run-e2e-linux.sh：发行版内真实安装 dsh + install.sh +
    经已安装宿主拉起/停止真实 dsh web + uninstall.sh 清理（输出到 .linux-e2e.log）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\linux\verify-linux.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\linux\verify-linux.ps1 -E2E
#>
[CmdletBinding()]
param(
    [string]$Distro = 'kali-linux',
    [string]$NodeVersion = '22.16.0',
    [switch]$E2E
)

$repoWin = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$repoWsl = ($repoWin -replace '^([A-Za-z]):', '/mnt/$1').ToLowerInvariant() -replace '\\', '/'

Write-Host '================================================'
Write-Host (' DSH Manager — WSL Linux 冒烟验证（' + $Distro + '）')
Write-Host (' 仓库（WSL 路径）: ' + $repoWsl)
Write-Host (' Node 版本        : ' + $NodeVersion)
Write-Host '================================================'

# 前置：发行版已安装（不做文本解析，用退出码判定「能否执行命令」）
& wsl -d $Distro -- true 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host ('错误：未找到 WSL 发行版 "' + $Distro + '"（或无法启动）。先执行：wsl --install -d ' + $Distro) -ForegroundColor Red
    exit 1
}

# 委托发行版内脚本（内部幂等：缺 xz-utils 自动 apt 装、缺 Node 自动下载）
$env:NODE_VERSION = $NodeVersion
& wsl -d $Distro -- bash "$repoWsl/tools/linux/run-smoke-linux.sh"
$runCode = $LASTEXITCODE
Remove-Item Env:\NODE_VERSION -ErrorAction SilentlyContinue

if ($runCode -eq 0) {
    Write-Host 'WSL Linux 冒烟验证通过（明细见 .linux-smoke.log）' -ForegroundColor Green
} else {
    Write-Host ('WSL Linux 冒烟验证失败（exit=' + $runCode + '，明细见 .linux-smoke.log）') -ForegroundColor Red
    exit $runCode
}

if ($E2E) {
    & wsl -d $Distro -- bash "$repoWsl/tools/linux/run-e2e-linux.sh"
    $e2eCode = $LASTEXITCODE
    if ($e2eCode -eq 0) {
        Write-Host 'WSL Linux 真实安装 E2E 通过（明细见 .linux-e2e.log）' -ForegroundColor Green
    } else {
        Write-Host ('WSL Linux 真实安装 E2E 失败（exit=' + $e2eCode + '，明细见 .linux-e2e.log）') -ForegroundColor Red
    }
    exit $e2eCode
}
exit 0
