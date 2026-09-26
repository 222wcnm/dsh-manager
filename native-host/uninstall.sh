#!/bin/sh
# Whalekeeper 卸载脚本（Linux / macOS）：停止 dsh、移除浏览器宿主注册、清理数据目录。
#
# 与 uninstall.ps1 同构：
#   1. 若有 run 记录，经宿主 stop 动作停止 dsh web（复用全套防护链：
#      PID 校验 / lifecycle 优雅停 / SIGTERM 降级；失败忽略）
#   2. 删除 Chrome / Chromium / Edge / Firefox 的四份 NativeMessagingHosts 清单
#   3. --keep-logs 时先把 logs 目录备份到桌面
#   4. 删除数据目录（$XDG_CONFIG_HOME/dsh-manager 或 macOS 对应目录）
#
# 用法：sh native-host/uninstall.sh [--keep-logs]
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HOST_JS="$SCRIPT_DIR/host.js"

if [ "$(uname -s 2>/dev/null || true)" = "Darwin" ]; then
  BASE_DIR="$HOME/Library/Application Support/dsh-manager"
else
  BASE_DIR=${XDG_CONFIG_HOME:-"$HOME/.config"}/dsh-manager
fi

KEEP_LOGS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --keep-logs) KEEP_LOGS=1 ;;
    -h|--help) echo "用法：sh uninstall.sh [--keep-logs]"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done

echo "================================================"
echo " Whalekeeper 卸载脚本（Linux/macOS）"
echo " 数据目录：$BASE_DIR"
if [ "$KEEP_LOGS" = 1 ]; then echo " 模式：保留日志（先备份到桌面再删除）"; fi
echo "================================================"

# ---------------------------------------------------------------
# 第 1 步：停止 dsh web 进程（复用宿主 stop 全套防护链，失败忽略）
# ---------------------------------------------------------------
echo ""
echo "== 第 1 步 / 停止 dsh web 进程 =="

NODE=$(command -v node || true)
if [ -n "$NODE" ] && [ -f "$HOST_JS" ] && [ -f "$BASE_DIR/run/dsh-web.json" ]; then
  REQ=$(mktemp) || REQ=""
  RES=$(mktemp) || RES=""
  if [ -n "$REQ" ] && [ -n "$RES" ]; then
    printf '%s\n' '{"id":"uninstall","action":"stop","payload":{}}' > "$REQ"
    if "$NODE" "$HOST_JS" --req "$REQ" --res "$RES" >/dev/null 2>&1; then
      STATE=$("$NODE" -e 'try{process.stdout.write(require(process.argv[1]).result?require(process.argv[1]).result.state:"")}catch(e){process.stdout.write("")}' "$RES" 2>/dev/null || true)
      echo "  [完成] 宿主 stop 返回：${STATE:-（无状态）}"
    else
      echo "  [忽略] 宿主 stop 执行失败，继续卸载（可稍后手动停止 dsh）。"
    fi
    rm -f "$REQ" "$RES"
  fi
else
  echo "  未发现 run 记录或宿主不可用，跳过停止步骤。"
fi

# ---------------------------------------------------------------
# 第 2 步：删除浏览器宿主注册
# ---------------------------------------------------------------
echo ""
echo "== 第 2 步 / 删除浏览器 Native Messaging 宿主注册 =="

for dir in \
  "$HOME/.config/google-chrome/NativeMessagingHosts" \
  "$HOME/.config/chromium/NativeMessagingHosts" \
  "$HOME/.config/microsoft-edge/NativeMessagingHosts" \
  "$HOME/.mozilla/native-messaging-hosts"; do
  if [ -f "$dir/com.dsh.manager.json" ]; then
    rm -f "$dir/com.dsh.manager.json" && echo "  [完成] 已删除：$dir/com.dsh.manager.json"
  else
    echo "  [跳过] 不存在：$dir/com.dsh.manager.json"
  fi
done

# ---------------------------------------------------------------
# 第 3 步：备份日志（可选）
# ---------------------------------------------------------------
if [ "$KEEP_LOGS" = 1 ] && [ -d "$BASE_DIR/logs" ]; then
  echo ""
  echo "== 第 3 步 / 备份日志到桌面 =="
  BACKUP="$HOME/Desktop/dsh-manager-logs-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP" && cp -a "$BASE_DIR/logs/." "$BACKUP"/ \
    && echo "  [完成] 日志已备份：$BACKUP" \
    || echo "  [警告] 日志备份失败，继续卸载。"
fi

# ---------------------------------------------------------------
# 第 4 步：删除数据目录
# ---------------------------------------------------------------
echo ""
echo "== 第 4 步 / 删除数据目录 =="
rm -rf "$BASE_DIR" && echo "  [完成] 已删除：$BASE_DIR" || echo "  [警告] 删除失败（可手动删除）：$BASE_DIR"

echo ""
echo "卸载完成。浏览器扩展本体请到 chrome://extensions 中手动移除。"
