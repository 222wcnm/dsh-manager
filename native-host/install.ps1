<#
.SYNOPSIS
    Whalekeeper 安装脚本：生成 Native Messaging 宿主清单并注册 Chrome / Edge / Firefox。

.DESCRIPTION
    1. 前置检查 node 与 dsh 是否可用（仅存在性检查；版本检查留给宿主 ping，
       如需版本检查请用 try/catch 包裹，避免本环境管道受限问题）。
    2. 解析扩展 ID：-ExtensionId 未提供时调用 compute-id.js，
       从 extension\manifest.json 的 key（base64 SPKI DER 公钥）自动计算固定扩展 ID；
       同时解析 browser_specific_settings.gecko.id（Firefox 附加组件 ID，M4）。
    3. 创建 %LOCALAPPDATA%\dsh-manager\{host,run,logs}。
    4. 生成 host.cmd（Node 启动包装）与 com.dsh.manager.json（宿主清单，
       allowed_extensions 同时含 Chrome 扩展 ID 与 Firefox gecko id）。
    5. 写注册表：HKCU 下 Chrome、Edge 与 Firefox 的 NativeMessagingHosts 项
       （无需管理员），失败时提示手动导入 .reg。
    6. 导出 native-host\com.dsh.manager.reg 备用。

    脚本幂等，可重复运行。

.PARAMETER ExtensionId
    可选。手动指定 32 位扩展 ID（字符范围 a-p）；缺省时自动计算。

.PARAMETER DryRun
    预演模式：只打印将要执行的操作，不创建目录、不写文件、不写注册表。
    （解析扩展 ID 时 compute-id.js 照常运行，会写出仓库内的 .extension-id.json 计算产物。）

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\native-host\install.ps1 -DryRun
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\native-host\install.ps1
#>
[CmdletBinding()]
param(
    [string]$ExtensionId,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
$Base = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'dsh-manager'

function Write-Step {
    param([string]$Message)
    Write-Host ''
    Write-Host ('== ' + $Message + ' ==') -ForegroundColor Cyan
}
function Write-OK {
    param([string]$Message)
    Write-Host ('  [完成] ' + $Message) -ForegroundColor Green
}
function Write-Dry {
    param([string]$Message)
    Write-Host ('  [预演] ' + $Message) -ForegroundColor DarkGray
}
function Write-Warn {
    param([string]$Message)
    Write-Host ('  [警告] ' + $Message) -ForegroundColor Yellow
}
function Fail {
    param([string]$Message)
    Write-Host ''
    Write-Host ('错误：' + $Message) -ForegroundColor Red
    exit 1
}

# 可靠的 JSON 字符串转义：对 `"` `\` 与控制字符转义。
# 用于生成清单 JSON 的 path 字段，避免路径含特殊字符时产出非法 JSON。
function ConvertTo-JsonString {
    param([string]$Value)
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append([char]0x22)
    foreach ($ch in $Value.ToCharArray()) {
        $code = [int]$ch
        if ($code -eq 0x22) { [void]$sb.Append([char]0x5C); [void]$sb.Append([char]0x22); continue }
        if ($code -eq 0x5C) { [void]$sb.Append([char]0x5C); [void]$sb.Append([char]0x5C); continue }
        if ($code -eq 0x08) { [void]$sb.Append('\b'); continue }
        if ($code -eq 0x0C) { [void]$sb.Append('\f'); continue }
        if ($code -eq 0x0A) { [void]$sb.Append('\n'); continue }
        if ($code -eq 0x0D) { [void]$sb.Append('\r'); continue }
        if ($code -eq 0x09) { [void]$sb.Append('\t'); continue }
        if ($code -lt 0x20) { [void]$sb.Append(('\u' + $code.ToString('x4'))); continue }
        [void]$sb.Append($ch)
    }
    [void]$sb.Append([char]0x22)
    return $sb.ToString()
}

Write-Host '================================================' -ForegroundColor Cyan
Write-Host ' Whalekeeper 安装脚本' -ForegroundColor Cyan
Write-Host (' 脚本目录：' + $ScriptDir)
Write-Host (' 数据目录：' + $Base)
if ($DryRun) {
    Write-Host ' 运行模式：预演（DryRun）—— 仅打印，不执行任何安装写入' -ForegroundColor Yellow
}
Write-Host '================================================' -ForegroundColor Cyan

# ---------------------------------------------------------------
# 第 1 步：前置检查（node / dsh）
# ---------------------------------------------------------------
Write-Step '第 1 步 / 前置检查（node、dsh）'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    Fail '未找到 node。请先安装 Node.js（https://nodejs.org）并确保 node 在 PATH 中，然后重试。'
}
Write-OK ('node 已就绪：' + $node)

$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dshCmd) {
    Fail '未找到 dsh。请先执行：npm i -g @deepseek-ai/dsh'
}
Write-OK ('dsh 已就绪：' + $dshCmd.Source + '（仅检查存在性；版本校验由宿主 ping 负责）')

# ---------------------------------------------------------------
# 第 2 步：解析扩展 ID
# ---------------------------------------------------------------
Write-Step '第 2 步 / 解析扩展 ID'

if (-not $ExtensionId) {
    Write-Host '  未提供 -ExtensionId，调用 compute-id.js 从 extension\manifest.json 的 key 自动计算…'
    $idJson = Join-Path $ScriptDir '.extension-id.json'
    Push-Location $ScriptDir
    try {
        & $node 'compute-id.js'
        if ($LASTEXITCODE -ne 0) {
            Fail 'compute-id.js 执行失败，无法计算扩展 ID。请确认 extension\manifest.json 已存在且包含 key 字段。'
        }
    }
    catch {
        Fail ('执行 compute-id.js 出错：' + $_.Exception.Message)
    }
    finally {
        Pop-Location
    }
    if (-not (Test-Path $idJson)) {
        Fail ('未找到计算产物 ' + $idJson + '，无法读取扩展 ID。')
    }
    $ExtensionId = (Get-Content -Raw -Encoding UTF8 $idJson | ConvertFrom-Json).extensionId
    if (-not $ExtensionId) {
        Fail ('无法从 ' + $idJson + ' 读取扩展 ID（缺少 extensionId 字段）。')
    }
    Write-OK ('已自动计算扩展 ID：' + $ExtensionId)
}
else {
    if ($ExtensionId -notmatch '^[a-p]{32}$') {
        Fail ('扩展 ID 格式不正确："' + $ExtensionId + '" 应为 32 位小写字母（字符范围 a-p）。')
    }
    Write-OK ('使用手动指定的扩展 ID：' + $ExtensionId)
}

# Firefox（M4）：从 manifest 的 browser_specific_settings.gecko.id 解析附加组件 ID。
# 宿主的 allowed_extensions 必须同时包含 Chrome 扩展 ID 与 Firefox 附加组件 ID，
# Firefox 用 allowed_extensions 校验、忽略 allowed_origins（design §8.5）。
$GeckoId = $null
$extManifestPath = Join-Path $ScriptDir '..\extension\manifest.json'
if (Test-Path $extManifestPath) {
    $extManifest = Get-Content -Raw -Encoding UTF8 $extManifestPath | ConvertFrom-Json
    $GeckoId = $extManifest.browser_specific_settings.gecko.id
}
if ($GeckoId) {
    if ($GeckoId -notmatch '^[A-Za-z0-9_.@-]+$') {
        Fail ('Firefox gecko id 格式不正确："' + $GeckoId + '"')
    }
    Write-OK ('Firefox 附加组件 ID（gecko）：' + $GeckoId)
}
else {
    Write-Warn '未在 manifest 中解析到 browser_specific_settings.gecko.id（Firefox 支持将仅含 Chrome 扩展 ID）。'
}

# ---------------------------------------------------------------
# 第 3 步：创建数据目录
# ---------------------------------------------------------------
Write-Step ('第 3 步 / 创建数据目录：' + $Base)

foreach ($dir in @('host', 'run', 'logs')) {
    $dirPath = Join-Path $Base $dir
    if ($DryRun) {
        Write-Dry ('将创建目录：' + $dirPath)
    }
    else {
        try {
            New-Item -ItemType Directory -Path $dirPath -Force | Out-Null
            Write-OK ('目录就绪（不存在则创建）：' + $dirPath)
        }
        catch {
            Fail ('创建目录失败：' + $dirPath + ' → ' + $_.Exception.Message)
        }
    }
}

# ---------------------------------------------------------------
# 第 4 步：生成 host.cmd
# ---------------------------------------------------------------
Write-Step '第 4 步 / 生成 host.cmd（Node 启动包装）'

$hostJs = Join-Path $ScriptDir 'host.js'
if (-not (Test-Path $hostJs)) {
    Write-Warn ('未找到 ' + $hostJs + '（宿主主程序由并行工程提供）。安装可继续，但宿主需在 host.js 就位后才能工作。')
}

$hostCmdPath = Join-Path $Base 'host\host.cmd'
$manifestPath = Join-Path $Base 'host\com.dsh.manager.json'

# 预检：安装路径不得含双引号 `"`（会破坏 cmd 解析与 JSON/注册表转义边界）。
foreach ($p in @($node, $hostJs, $hostCmdPath, $manifestPath, $ScriptDir)) {
    if ($p -and $p.Contains('"')) {
        Fail ('安装路径不得包含双引号字符，请更换安装目录后重试：' + $p)
    }
}

$cmdLines = @(
    '@echo off',
    ('"' + $node + '" "' + $hostJs + '" %*')
)

if ($DryRun) {
    Write-Dry ('将写入文件：' + $hostCmdPath)
    Write-Dry '内容预览：'
    foreach ($line in $cmdLines) {
        Write-Host ('      ' + $line) -ForegroundColor DarkGray
    }
}
else {
    $cmdContent = ($cmdLines -join "`r`n") + "`r`n"
    [System.IO.File]::WriteAllText($hostCmdPath, $cmdContent, (New-Object System.Text.UTF8Encoding($false)))
    Write-OK ('已生成：' + $hostCmdPath)
}

# ---------------------------------------------------------------
# 第 5 步：生成宿主清单 com.dsh.manager.json
# ---------------------------------------------------------------
Write-Step '第 5 步 / 生成宿主清单 com.dsh.manager.json'

# allowed_extensions 必须同时含 Chrome 扩展 ID 与 Firefox 附加组件 ID
# （Firefox 用 allowed_extensions 校验、忽略 allowed_origins；PS 5.1 不支持 (if) 表达式，先算出行）
$allowedExtensionsLine = if ($GeckoId) {
    '  "allowed_extensions": ["' + $ExtensionId + '", "' + $GeckoId + '"]'
} else {
    '  "allowed_extensions": ["' + $ExtensionId + '"]'
}

$manifestLines = @(
    '{',
    '  "name": "com.dsh.manager",',
    '  "description": "Whalekeeper native host — manages the dsh web process lifecycle",',
    ('  "path": ' + (ConvertTo-JsonString $hostCmdPath) + ','),
    '  "type": "stdio",',
    ('  "allowed_origins": ["chrome-extension://' + $ExtensionId + '/"],'),
    $allowedExtensionsLine,
    '}'
)

if ($DryRun) {
    Write-Dry ('将写入文件：' + $manifestPath)
    Write-Dry '内容预览：'
    foreach ($line in $manifestLines) {
        Write-Host ('      ' + $line) -ForegroundColor DarkGray
    }
}
else {
    $manifestContent = ($manifestLines -join "`r`n") + "`r`n"
    [System.IO.File]::WriteAllText($manifestPath, $manifestContent, (New-Object System.Text.UTF8Encoding($false)))
    Write-OK ('已生成：' + $manifestPath)
}

# ---------------------------------------------------------------
# 第 6 步：写注册表（Chrome + Edge + Firefox，HKCU 无需管理员）
# ---------------------------------------------------------------
Write-Step '第 6 步 / 注册 Native Messaging 宿主（HKCU：Chrome / Edge / Firefox）'

$registryTargets = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.dsh.manager',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.dsh.manager',
    'HKCU:\Software\Mozilla\NativeMessagingHosts\com.dsh.manager'
)

foreach ($key in $registryTargets) {
    if ($DryRun) {
        Write-Dry ('将写入注册表项：' + $key)
        Write-Dry ('  默认值 = ' + $manifestPath)
    }
    else {
        try {
            New-Item -Path $key -Force | Out-Null
            Set-ItemProperty -Path $key -Name '(Default)' -Value $manifestPath
            Write-OK ('已注册：' + $key)
        }
        catch {
            Write-Warn ('注册表写入失败：' + $key + ' → ' + $_.Exception.Message)
            Write-Warn '可手动双击导入同目录下导出的 com.dsh.manager.reg，或以管理员身份重新运行本脚本。'
        }
    }
}

# ---------------------------------------------------------------
# 第 7 步：导出备用 .reg 文件
# ---------------------------------------------------------------
Write-Step '第 7 步 / 导出备用注册表文件 com.dsh.manager.reg'

$regPath = Join-Path $ScriptDir 'com.dsh.manager.reg'
$regLines = @(
    'Windows Registry Editor Version 5.00',
    '',
    '[HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.dsh.manager]',
    ('@="' + $manifestPath.Replace('\', '\\') + '"'),
    '',
    '[HKEY_CURRENT_USER\Software\Microsoft\Edge\NativeMessagingHosts\com.dsh.manager]',
    ('@="' + $manifestPath.Replace('\', '\\') + '"'),
    '',
    '[HKEY_CURRENT_USER\Software\Mozilla\NativeMessagingHosts\com.dsh.manager]',
    ('@="' + $manifestPath.Replace('\', '\\') + '"')
)

if ($DryRun) {
    Write-Dry ('将导出文件：' + $regPath)
    Write-Dry '内容预览：'
    foreach ($line in $regLines) {
        Write-Host ('      ' + $line) -ForegroundColor DarkGray
    }
}
else {
    $regContent = ($regLines -join "`r`n") + "`r`n"
    # 统一 UTF-8 无 BOM 写入（避免提交本机路径/用户名；regedit 可直接双击导入）
    [System.IO.File]::WriteAllText($regPath, $regContent, (New-Object System.Text.UTF8Encoding($false)))
    Write-OK ('已导出：' + $regPath)
}

# ---------------------------------------------------------------
# 完成：验收指引
# ---------------------------------------------------------------
Write-Step '安装流程结束'

if ($DryRun) {
    Write-Host '  （预演结束：未写注册表、未创建 %LOCALAPPDATA% 目录与文件）' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '验收指引：' -ForegroundColor Green
Write-Host '  1. 打开 chrome://extensions（或 edge://extensions），开启「开发者模式」，'
Write-Host '     点击「加载已解压的扩展程序」，选择本仓库的 extension 目录。'
Write-Host '  2. 若浏览器已在运行，请完全退出并重新启动浏览器'
Write-Host '     （Native Messaging 宿主清单变更需重启浏览器后才生效）。'
Write-Host '  3. 点击扩展图标打开 popup：应显示 stopped（而非 HOST_NOT_INSTALLED）。'
Write-Host ''
Write-Host ('  扩展 ID：' + $ExtensionId)
Write-Host ('  宿主清单：' + $manifestPath)
Write-Host ('  日志目录：' + (Join-Path $Base 'logs'))
Write-Host ('  卸载命令：' + (Join-Path $ScriptDir 'uninstall.ps1'))
Write-Host ''
