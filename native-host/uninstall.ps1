<#
.SYNOPSIS
    DSH Manager 卸载脚本：停止 dsh、删除注册表项、清理数据目录。

.DESCRIPTION
    1. 若存在 %LOCALAPPDATA%\dsh-manager\run\dsh-web.json，读取 pid 并执行
       taskkill /PID <pid> /T /F 停止 dsh web 进程（失败忽略）。
    2. 删除 Chrome、Edge 与 Firefox 的三条 NativeMessagingHosts 注册表项（失败忽略）。
    3. -KeepLogs 时先把 logs 目录备份到桌面。
    4. 删除 %LOCALAPPDATA%\dsh-manager。

.PARAMETER KeepLogs
    指定时先把 logs 目录备份到桌面再删除数据目录；缺省直接删除。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\native-host\uninstall.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\native-host\uninstall.ps1 -KeepLogs
#>
[CmdletBinding()]
param(
    [switch]$KeepLogs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Base = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'dsh-manager'

Write-Host '================================================' -ForegroundColor Cyan
Write-Host ' DSH Manager 卸载脚本' -ForegroundColor Cyan
Write-Host (' 数据目录：' + $Base)
if ($KeepLogs) {
    Write-Host ' 模式：保留日志（先备份到桌面再删除）' -ForegroundColor Yellow
}
Write-Host '================================================' -ForegroundColor Cyan

# ---------------------------------------------------------------
# 第 1 步：停止 dsh web 进程
# ---------------------------------------------------------------
Write-Host ''
Write-Host '== 第 1 步 / 停止 dsh web 进程 ==' -ForegroundColor Cyan

$runJson = Join-Path $Base 'run\dsh-web.json'
$dshPid = $null

if (Test-Path $runJson) {
    try {
        $run = Get-Content -Raw -Encoding UTF8 $runJson | ConvertFrom-Json
        # PID 强转 + 校验 >0（防 run 记录被篡改/损坏导致误杀无关进程）
        $dshPid = [int]$run.pid
        if ($dshPid -le 0) {
            $dshPid = $null
            Write-Host '  [警告] run 记录 pid 非法（非正整数），跳过停止步骤，绝不 taskkill。' -ForegroundColor Yellow
        }
    }
    catch {
        Write-Host '  [忽略] run 记录读取失败（文件可能损坏），跳过停止步骤。' -ForegroundColor Yellow
    }
}
else {
    Write-Host '  未发现 run 记录（dsh 未由本管理器启动），跳过停止步骤。'
}

if ($dshPid) {
    # 命令行校验：确认该 PID 确实是 dsh/bin.js 进程，否则跳过强杀（PID 复用防护，
    # 与 host.js pidLooksLikeDsh 同款）。校验失败绝不动 taskkill。
    $isDsh = $false
    try {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$dshPid" -ErrorAction Stop
        if ($proc -and $proc.CommandLine) {
            $cl = $proc.CommandLine.ToLowerInvariant()
            if ($cl.Contains('dsh') -or $cl.Contains('bin.js') -or $cl.Contains('@deepseek-ai\dsh')) {
                $isDsh = $true
            }
        }
    }
    catch {
        $isDsh = $false
    }

    if (-not $isDsh) {
        Write-Host ('  [警告] PID ' + $dshPid + ' 的命令行不含 dsh/bin.js 关键字（疑似 PID 被复用），跳过强杀，绝不 taskkill 无关进程。') -ForegroundColor Yellow
    }
    else {
        Write-Host ('  正在停止 dsh web 进程（PID ' + $dshPid + '）…')
        try {
            & taskkill /PID $dshPid /T /F 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Write-Host '  [忽略] taskkill 返回非零（进程可能已退出或无权限），继续卸载。' -ForegroundColor Yellow
            }
            else {
                Write-Host '  [完成] 已执行 taskkill 停止进程树。'
            }
        }
        catch {
            Write-Host ('  [忽略] taskkill 执行失败：' + $_.Exception.Message) -ForegroundColor Yellow
        }
    }
}

# ---------------------------------------------------------------
# 第 2 步：删除注册表项
# ---------------------------------------------------------------
Write-Host ''
Write-Host '== 第 2 步 / 删除注册表项 ==' -ForegroundColor Cyan

$registryTargets = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.dsh.manager',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.dsh.manager',
    'HKCU:\Software\Mozilla\NativeMessagingHosts\com.dsh.manager'
)

foreach ($key in $registryTargets) {
    try {
        if (Test-Path $key) {
            Remove-Item -Path $key -Recurse -Force
            Write-Host ('  [完成] 已删除注册表项：' + $key)
        }
        else {
            Write-Host ('  [忽略] 注册表项不存在（跳过）：' + $key)
        }
    }
    catch {
        Write-Host ('  [忽略] 删除注册表项失败：' + $key + ' → ' + $_.Exception.Message) -ForegroundColor Yellow
        Write-Host '          可手动在 regedit 中删除对应项。' -ForegroundColor Yellow
    }
}

# ---------------------------------------------------------------
# 第 3 步：日志备份（可选）
# ---------------------------------------------------------------
Write-Host ''
Write-Host '== 第 3 步 / 处理日志 ==' -ForegroundColor Cyan

$logsDir = Join-Path $Base 'logs'
if ($KeepLogs -and (Test-Path $logsDir)) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupDir = Join-Path $desktop ('dsh-manager-logs-' + $stamp)
    try {
        Copy-Item -Path $logsDir -Destination $backupDir -Recurse -Force
        Write-Host ('  [完成] 日志已备份到：' + $backupDir)
    }
    catch {
        Write-Host ('  [警告] 日志备份失败：' + $_.Exception.Message) -ForegroundColor Yellow
        Write-Host '          继续执行删除。' -ForegroundColor Yellow
    }
}
elseif ($KeepLogs) {
    Write-Host '  [忽略] 未发现 logs 目录，无日志可备份。'
}
else {
    Write-Host '  未指定 -KeepLogs，日志随数据目录一并删除。'
}

# ---------------------------------------------------------------
# 第 4 步：删除数据目录
# ---------------------------------------------------------------
Write-Host ''
Write-Host '== 第 4 步 / 删除数据目录 ==' -ForegroundColor Cyan

if (Test-Path $Base) {
    try {
        Remove-Item -Path $Base -Recurse -Force
        Write-Host ('  [完成] 已删除：' + $Base)
    }
    catch {
        Write-Host ('  [警告] 删除失败：' + $_.Exception.Message) -ForegroundColor Yellow
        Write-Host '          请关闭正在使用该目录的进程（如日志查看器）后重试。' -ForegroundColor Yellow
    }
}
else {
    Write-Host '  [忽略] 数据目录不存在（无需删除）。'
}

Write-Host ''
Write-Host '卸载完成。' -ForegroundColor Green
Write-Host '如需重新安装，运行 native-host\install.ps1；浏览器中的扩展目录可保留。'
Write-Host ''
