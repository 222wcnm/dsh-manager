#!/usr/bin/env bash
# run-smoke-linux.sh — 在 WSL Linux 发行版内跑 dsh-manager 宿主冒烟（tools/linux/）
# 由 verify-linux.ps1 或手工调用：wsl -d <distro> -- bash <repo>/tools/linux/run-smoke-linux.sh
# 幂等：缺少 xz-utils 时自动 apt 安装（Kali 精简镜像不带）；缺少便携 Node 时下载。
set -u
export HOME=/root   # Windows 的 HOME 透传会污染 bash（C:Users...），强制 root 家目录
NODE_VERSION="${NODE_VERSION:-22.16.0}"
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="$REPO_DIR/.linux-smoke.log"
: > "$LOG"

# 0) xz-utils（tar -xJ 依赖；Kali 精简镜像缺）
if ! command -v xz >/dev/null 2>&1; then
  echo "[setup] installing xz-utils (apt)..." | tee -a "$LOG"
  (apt-get update -qq && apt-get install -y -qq xz-utils) >> "$LOG" 2>&1 || { echo "[setup] xz-utils 安装失败" | tee -a "$LOG"; exit 3; }
fi

# 1) 便携 Node（幂等）
NODE_ROOT="$HOME/dsh-manager-linux/node"
if [ ! -x "$NODE_ROOT/bin/node" ]; then
  echo "[setup] downloading node v$NODE_VERSION ..." | tee -a "$LOG"
  mkdir -p "$HOME/dsh-manager-linux"
  (curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" -o /tmp/dsh-node.tar.xz \
    || wget -q "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" -O /tmp/dsh-node.tar.xz) >> "$LOG" 2>&1 \
    || { echo "[setup] node 下载失败" | tee -a "$LOG"; exit 4; }
  mkdir -p "$NODE_ROOT"
  tar -xJf /tmp/dsh-node.tar.xz -C "$NODE_ROOT" --strip-components=1 >> "$LOG" 2>&1 \
    || { echo "[setup] node 解压失败" | tee -a "$LOG"; exit 5; }
  rm -f /tmp/dsh-node.tar.xz
fi
echo "[setup] node: $($NODE_ROOT/bin/node --version)" | tee -a "$LOG"

# 2) 冒烟（Linux 平台层实测）
export PATH="$NODE_ROOT/bin:$PATH"
cd "$REPO_DIR"
rm -rf .smoke
echo "[smoke] running..." | tee -a "$LOG"
node native-host/test/smoke.js >> "$LOG" 2>&1
SMOKE_EXIT=$?
echo "[smoke] exit=$SMOKE_EXIT" | tee -a "$LOG"
exit $SMOKE_EXIT
