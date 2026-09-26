<#
.SYNOPSIS
    Whalekeeper — 重建发布副本（tools/publish/build-publish.ps1）

.DESCRIPTION
    按「内容镜像 + 增量提交」方案（docs/publish.md）重建发布目录：
      1. 在临时目录构建干净快照（git archive HEAD，仅入库文件）；
      2. 用 tools/publish/release-changelog.md 覆盖发布物的 CHANGELOG.md
         （发布物只带面向使用者的正式版本条目，开发流水账留在开发仓库）；
      3. robocopy /MIR 把临时目录镜像进发布目录（/XD .git 排除——发布仓库的
         提交历史与 remote 单独管理，绝不被内容镜像清掉；不删除发布目录本身——
         实测环境对目录节点的删除/重命名会被外部句柄拦截，内容级镜像不受影响）；
      4. 提交：发布目录已存在 .git 时**保留历史与 remote**，只做 git add -A +
         增量提交（每次发布在历史之上叠加一条新提交）；不存在 .git 时才
         git init + 初始提交（首次发布）。
    不推送任何远程；推送步骤见 docs/publish.md。

.PARAMETER PublishDir
    发布目录（默认仓库同级的 dsh-manager-publish）。

.PARAMETER Version
    版本号（默认 0.1.0），写入提交信息前缀（v<版本>）。

.PARAMETER CommitMessage
    提交信息正文（默认「浏览器一键管理 dsh web（Chrome MV3 扩展 + Native
    Messaging 宿主 + dsh-lifecycle 插件）」）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\publish\build-publish.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\publish\build-publish.ps1 -Version 0.1.1 -CommitMessage "页面内管理面板体验修复（重载提示/圆点语义/展开布局）"
#>
[CmdletBinding()]
param(
    [string]$PublishDir,
    [string]$Version = '0.1.0',
    [string]$CommitMessage = '浏览器一键管理 dsh web（Chrome MV3 扩展 + Native Messaging 宿主 + dsh-lifecycle 插件）'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $PublishDir) {
    $PublishDir = Join-Path (Split-Path -Parent $repoRoot) 'dsh-manager-publish'
}
$tempDir = $PublishDir + '.tmp'
$publishGit = Join-Path $PublishDir '.git'

Write-Host ('开发仓库：' + $repoRoot)
Write-Host ('发布目录：' + $PublishDir)
Write-Host ('版本：' + $Version)
Write-Host ('发布历史：' + $(if (Test-Path $publishGit) { '保留（增量提交）' } else { '无（首次 git init + 初始提交）' }))

Push-Location $repoRoot
try {
    if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }

    Write-Host '1/4 在临时目录构建干净快照（git archive HEAD）...'
    New-Item -ItemType Directory -Path $tempDir | Out-Null
    # 经 tar 文件中转而非管道：PS 5.1 会把管道中的二进制流按文本解码，损坏 tar 格式
    $archive = Join-Path $env:TEMP ('dsh-publish-' + [guid]::NewGuid().ToString('N') + '.tar')
    try {
        git archive -o $archive HEAD
        tar -xf $archive -C $tempDir
    }
    finally {
        Remove-Item $archive -Force -ErrorAction SilentlyContinue
    }

    Write-Host '2/4 替换为发布版 CHANGELOG...'
    Copy-Item (Join-Path $PSScriptRoot 'release-changelog.md') (Join-Path $tempDir 'CHANGELOG.md') -Force

    # 内部过程文档与开发期素材不出现在公开仓库（约定见开发仓库 docs/publish.md）
    foreach ($f in @(
        'docs/open-source-review.md',
        'docs/upstream-feedback.md',
        'docs/publish.md',
        'CHROMEWEBSTORE.md',
        'tools/icons/_user-whale-smooth.svg',            # 开发期备选素材（鲸鱼平滑剪影），不入发布版
        'tools/ui-theme/_popup-icons-data.js'            # 开发期图标提取中间数据（下划线前缀=内部），不入发布版
    )) {
        Remove-Item (Join-Path $tempDir $f) -Force -ErrorAction SilentlyContinue
    }

    Write-Host '3/4 内容级镜像到发布目录（robocopy /MIR，/XD .git 保留发布历史）...'
    robocopy $tempDir $PublishDir /MIR /XD .git /NFL /NDL /NJH | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw ('robocopy 失败，退出码 ' + $LASTEXITCODE)
    }
    Remove-Item $tempDir -Recurse -Force

    Write-Host '4/4 提交发布版本（保留历史/remote 时仅增量提交）...'
    Push-Location $PublishDir
    try {
        if (-not (Test-Path $publishGit)) {
            git init -b main | Out-Null
        }
        git add -A
        git -c user.name='Whalekeeper' -c user.email='dsh-manager@local' commit -m ('v' + $Version + '：' + $CommitMessage) | Out-Null
        $fileCount = (git ls-files).Count
        $commitCount = (git log --oneline | Measure-Object -Line).Lines
        $branchInfo = git rev-parse --abbrev-ref HEAD
        Write-Host ('完成：' + $fileCount + ' 个文件 / ' + $commitCount + ' 条提交 / 分支 ' + $branchInfo)
        Write-Host '推送前自查清单见开发仓库 docs/publish.md（冒烟/verify-cdp/敏感文件检查）。'
    }
    finally {
        Pop-Location
    }
}
finally {
    Pop-Location
}
