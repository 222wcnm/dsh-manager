#!/bin/sh
# Whalekeeper 安装脚本（Linux / macOS）：生成 Native Messaging 宿主清单并注册
# Chrome / Chromium / Edge / Firefox（用户级，无需 sudo）。
#
# 与 install.ps1 同构：
#   1. 前置检查 node 与 dsh（仅存在性；版本校验由宿主 ping 负责）
#   2. 解析扩展 ID（compute-id.js 自动计算）与 Firefox gecko id
#   3. 创建 $XDG_CONFIG_HOME/dsh-manager/{host,run,logs}（macOS 为
#      ~/Library/Application Support/dsh-manager）
#   4. 生成 host.sh（Node 启动包装）与 com.dsh.manager.json（宿主清单）
#   5. 写入四个浏览器的用户级 NativeMessagingHosts 目录（幂等，可重复运行）
#
# 用法：sh native-host/install.sh [--dry-run] [--extension-id <32位a-p>]
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HOST_JS="$SCRIPT_DIR/host.js"
EXT_MANIFEST="$SCRIPT_DIR/../extension/manifest.json"

# 状态根目录与 host.js defaultBaseDir() 保持同构（design §6.8）
if [ "$(uname -s 2>/dev/null || true)" = "Darwin" ]; then
  BASE_DIR="$HOME/Library/Application Support/dsh-manager"
else
  BASE_DIR=${XDG_CONFIG_HOME:-"$HOME/.config"}/dsh-manager
fi

DRY=0
EXT_ID=""

usage() {
  echo "用法：sh install.sh [--dry-run] [--extension-id <id>]"
  echo "  --dry-run        预演：只打印，不写任何文件"
  echo "  --extension-id   手动指定 32 位扩展 ID（a-p）；缺省自动计算"
}

die() {
  echo "错误：$1" >&2
  exit 1
}

step() { echo ""; echo "== $1 =="; }
ok()   { echo "  [完成] $1"; }
warn() { echo "  [警告] $1"; }
dry()  { echo "  [预演] $1"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --extension-id) EXT_ID="${2:-}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage; exit 2 ;;
  esac
  shift
done

echo "================================================"
echo " Whalekeeper 安装脚本（Linux/macOS）"
echo " 脚本目录：$SCRIPT_DIR"
echo " 数据目录：$BASE_DIR"
if [ "$DRY" = 1 ]; then echo " 运行模式：预演（DryRun）—— 仅打印，不执行任何安装写入"; fi
echo "================================================"

# ---------------------------------------------------------------
# 第 1 步：前置检查（node / dsh）
# ---------------------------------------------------------------
step "第 1 步 / 前置检查（node、dsh）"

NODE=$(command -v node || true)
[ -n "$NODE" ] || die "未找到 node。请先安装 Node.js（https://nodejs.org）并确保 node 在 PATH 中，然后重试。"
ok "node 已就绪：$NODE"

DSH_LAUNCHER=$(command -v dsh || true)
[ -n "$DSH_LAUNCHER" ] || die "未找到 dsh。请先执行：npm i -g @deepseek-ai/dsh"
ok "dsh 已就绪：$DSH_LAUNCHER（仅检查存在性；版本校验由宿主 ping 负责）"

# ---------------------------------------------------------------
# 第 2 步：解析扩展 ID
# ---------------------------------------------------------------
step "第 2 步 / 解析扩展 ID"

if [ -z "$EXT_ID" ]; then
  echo "  未提供 --extension-id，调用 compute-id.js 从 extension/manifest.json 的 key 自动计算…"
  (cd "$SCRIPT_DIR" && "$NODE" compute-id.js) || die "compute-id.js 执行失败，无法计算扩展 ID。请确认 extension/manifest.json 已存在且包含 key 字段。"
  EXT_ID=$("$NODE" -e 'try{process.stdout.write(require(process.argv[1]).extensionId||"")}catch(e){process.stdout.write("")}' "$SCRIPT_DIR/.extension-id.json")
  [ -n "$EXT_ID" ] || die "无法从 $SCRIPT_DIR/.extension-id.json 读取扩展 ID（缺少 extensionId 字段）。"
  ok "已自动计算扩展 ID：$EXT_ID"
else
  printf '%s' "$EXT_ID" | grep -Eq '^[a-p]{32}$' || die "扩展 ID 格式不正确：\"$EXT_ID\" 应为 32 位小写字母（字符范围 a-p）。"
  ok "使用手动指定的扩展 ID：$EXT_ID"
fi

# Firefox（M4）：allowed_extensions 必须同时含 Chrome 扩展 ID 与 gecko id
# （Firefox 用 allowed_extensions 校验、忽略 allowed_origins，design §8.5）
GECKO_ID=""
if [ -f "$EXT_MANIFEST" ]; then
  GECKO_ID=$("$NODE" -e 'try{const j=require(process.argv[1]);process.stdout.write((j.browser_specific_settings&&j.browser_specific_settings.gecko&&j.browser_specific_settings.gecko.id)||"")}catch(e){process.stdout.write("")}' "$EXT_MANIFEST")
fi
if [ -n "$GECKO_ID" ]; then
  printf '%s' "$GECKO_ID" | grep -Eq '^[A-Za-z0-9_.@-]+$' || die "Firefox gecko id 格式不正确：\"$GECKO_ID\""
  ok "Firefox 附加组件 ID（gecko）：$GECKO_ID"
else
  warn "未在 manifest 中解析到 browser_specific_settings.gecko.id（Firefox 支持将仅含 Chrome 扩展 ID）。"
fi

# ---------------------------------------------------------------
# 第 3 步：创建数据目录
# ---------------------------------------------------------------
step "第 3 步 / 创建数据目录：$BASE_DIR"

for dir in host run logs; do
  dir_path="$BASE_DIR/$dir"
  if [ "$DRY" = 1 ]; then
    dry "将创建目录：$dir_path"
  else
    mkdir -p "$dir_path" || die "创建目录失败：$dir_path"
    ok "目录就绪（不存在则创建）：$dir_path"
  fi
done

# ---------------------------------------------------------------
# 第 4 步：生成 host.sh
# ---------------------------------------------------------------
step "第 4 步 / 生成 host.sh（Node 启动包装）"

[ -f "$HOST_JS" ] || warn "未找到 $HOST_JS（宿主主程序由并行工程提供）。安装可继续，但宿主需在 host.js 就位后才能工作。"

# 预检：安装路径不得含双引号（会破坏 shell 解析与 JSON 转义边界）
for p in "$NODE" "$HOST_JS" "$SCRIPT_DIR" "$BASE_DIR"; do
  case "$p" in
    *\"*) die "安装路径不得包含双引号字符，请更换安装目录后重试：$p" ;;
  esac
done

HOST_SH="$BASE_DIR/host/host.sh"
MANIFEST_PATH="$BASE_DIR/host/com.dsh.manager.json"

if [ "$DRY" = 1 ]; then
  dry "将写入文件：$HOST_SH"
  dry "  内容：#!/bin/sh + exec \"$NODE\" \"$HOST_JS\" \"\$@\""
else
  {
    printf '%s\n' '#!/bin/sh'
    printf 'exec "%s" "%s" "$@"\n' "$NODE" "$HOST_JS"
  } > "$HOST_SH" || die "写入失败：$HOST_SH"
  chmod +x "$HOST_SH" || die "设置可执行权限失败：$HOST_SH"
  ok "已生成：$HOST_SH"
fi

# ---------------------------------------------------------------
# 第 5 步：生成宿主清单 com.dsh.manager.json
# ---------------------------------------------------------------
step "第 5 步 / 生成宿主清单 com.dsh.manager.json"

# JSON 转义交给 node（路径可能含空格等特殊字符）
MANIFEST_JSON=$("$NODE" -e '
const [hostSh, chromeId, geckoId] = process.argv.slice(1);
const allowed = geckoId ? [chromeId, geckoId] : [chromeId];
const m = {
  name: "com.dsh.manager",
  description: "Whalekeeper native host — manages the dsh web process lifecycle",
  path: hostSh,
  type: "stdio",
  allowed_origins: ["chrome-extension://" + chromeId + "/"],
  allowed_extensions: allowed,
};
process.stdout.write(JSON.stringify(m, null, 2) + "\n");
' "$HOST_SH" "$EXT_ID" "$GECKO_ID") || die "清单生成失败"

if [ "$DRY" = 1 ]; then
  dry "将写入文件：$MANIFEST_PATH"
  dry "内容预览："
  printf '%s\n' "$MANIFEST_JSON" | sed 's/^/      /'
else
  printf '%s\n' "$MANIFEST_JSON" > "$MANIFEST_PATH" || die "写入失败：$MANIFEST_PATH"
  ok "已生成：$MANIFEST_PATH"
fi

# ---------------------------------------------------------------
# 第 6 步：注册浏览器 Native Messaging 宿主（用户级，无需 sudo）
# ---------------------------------------------------------------
step "第 6 步 / 注册 Native Messaging 宿主（用户级：Chrome / Chromium / Edge / Firefox）"

# 用位置参数承载目录列表：避免 $HOME 含空格时 for 列表断词
set -- \
  "$HOME/.config/google-chrome/NativeMessagingHosts" \
  "$HOME/.config/chromium/NativeMessagingHosts" \
  "$HOME/.config/microsoft-edge/NativeMessagingHosts" \
  "$HOME/.mozilla/native-messaging-hosts"

for dir in "$@"; do
  if [ "$DRY" = 1 ]; then
    dry "将写入清单副本：$dir/com.dsh.manager.json"
  else
    mkdir -p "$dir" || warn "创建目录失败：$dir（跳过）"
    if printf '%s\n' "$MANIFEST_JSON" > "$dir/com.dsh.manager.json" 2>/dev/null; then
      ok "已注册：$dir/com.dsh.manager.json"
    else
      warn "写入失败（跳过）：$dir/com.dsh.manager.json"
    fi
  fi
done

# ---------------------------------------------------------------
# 完成：验收指引
# ---------------------------------------------------------------
step "安装流程结束"

if [ "$DRY" = 1 ]; then
  echo "  （预演结束：未创建目录、未写任何文件）"
fi

echo ""
echo "验收指引："
echo "  1. 打开 chrome://extensions（或 edge://extensions），开启「开发者模式」，"
echo "     点击「加载已解压的扩展程序」，选择本仓库的 extension 目录。"
echo "  2. 若浏览器已在运行，请完全退出并重新启动浏览器"
echo "     （Native Messaging 宿主清单变更需重启浏览器后才生效）。"
echo "  3. 点击扩展图标打开 popup：应显示 stopped（而非 HOST_NOT_INSTALLED）。"
echo ""
echo "  扩展 ID：$EXT_ID"
echo "  宿主清单：$MANIFEST_PATH"
echo "  日志目录：$BASE_DIR/logs"
echo "  卸载命令：sh $SCRIPT_DIR/uninstall.sh"
echo ""
