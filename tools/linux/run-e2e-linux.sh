#!/usr/bin/env bash
# run-e2e-linux.sh — 在 WSL Linux 发行版内做 dsh-manager 的「真实安装」端到端验证
# 由 verify-linux.ps1 -E2E 或手工调用。
# 流程：便携 Node 就绪检查 → npm i -g 真实 @deepseek-ai/dsh → install.sh 安装
# → 清单/注册断言 → 经已安装的 host.sh 拉起真实 dsh web（start/status/指纹/stop）
# → uninstall.sh 卸载并断言清理。全程输出重定向到仓库 .linux-e2e.log。
set -u
export HOME=/root   # Windows 的 HOME 透传会污染 bash（C:Users...），强制 root 家目录

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="$REPO_DIR/.linux-e2e.log"
: > "$LOG"
FAILS=0

note() { echo "[e2e] $*" | tee -a "$LOG"; }
check() { # check <名称> <条件(1=通过)>
  if [ "${2:-0}" = 1 ]; then note "PASS $1"; else note "FAIL $1"; FAILS=$((FAILS+1)); fi
}

NODE_ROOT="$HOME/dsh-manager-linux/node"
if [ ! -x "$NODE_ROOT/bin/node" ]; then
  note "未找到便携 Node，请先运行 run-smoke-linux.sh"
  exit 3
fi
export PATH="$NODE_ROOT/bin:$PATH"
cd "$REPO_DIR"

# ---------------------------------------------------------------
# 1) 真实 dsh（幂等）
# ---------------------------------------------------------------
# dsh 依赖 node-pty（需本地编译）：Kali 精简镜像缺 make/gcc/python3，自动补装（幂等）
if ! command -v make >/dev/null 2>&1 || ! command -v gcc >/dev/null 2>&1; then
  note "installing build-essential python3 (node-pty 编译依赖)..."
  apt-get update -qq && apt-get install -y -qq build-essential python3 >> "$LOG" 2>&1 \
    || { note "构建工具安装失败（见 .linux-e2e.log）"; exit 4; }
fi

BIN="$NODE_ROOT/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
if [ ! -f "$BIN" ]; then
  note "installing @deepseek-ai/dsh (npm i -g)..."
  if ! npm i -g @deepseek-ai/dsh >> "$LOG" 2>&1; then
    note "dsh 安装失败（见 .linux-e2e.log）"
    exit 5
  fi
fi
note "dsh: $("$NODE_ROOT/bin/node" "$BIN" --version 2>/dev/null | head -n1 | sed 's/\r$//')"

# ---------------------------------------------------------------
# 2) install.sh（DryRun 先跑一遍，再正式安装）
# ---------------------------------------------------------------
note "install.sh --dry-run..."
sh native-host/install.sh --dry-run >> "$LOG" 2>&1 || { note "install.sh --dry-run 失败"; exit 5; }
note "install.sh 正式安装..."
sh native-host/install.sh >> "$LOG" 2>&1 || { note "install.sh 失败"; exit 6; }

BASE="$HOME/.config/dsh-manager"
check "host.sh 存在且可执行" "$([ -x "$BASE/host/host.sh" ] && echo 1)"
check "宿主清单存在" "$([ -f "$BASE/host/com.dsh.manager.json" ] && echo 1)"
check "chrome 注册" "$([ -f "$HOME/.config/google-chrome/NativeMessagingHosts/com.dsh.manager.json" ] && echo 1)"
check "chromium 注册" "$([ -f "$HOME/.config/chromium/NativeMessagingHosts/com.dsh.manager.json" ] && echo 1)"
check "edge 注册" "$([ -f "$HOME/.config/microsoft-edge/NativeMessagingHosts/com.dsh.manager.json" ] && echo 1)"
check "firefox 注册" "$([ -f "$HOME/.mozilla/native-messaging-hosts/com.dsh.manager.json" ] && echo 1)"

EXT_ID=$("$NODE_ROOT/bin/node" -e 'process.stdout.write(require("./native-host/.extension-id.json").extensionId)')
"$NODE_ROOT/bin/node" -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const [base, extId] = process.argv.slice(2);
const ok = j.name === "com.dsh.manager" && j.type === "stdio"
  && j.path === base + "/host/host.sh"
  && Array.isArray(j.allowed_origins) && j.allowed_origins[0] === "chrome-extension://" + extId + "/"
  && Array.isArray(j.allowed_extensions) && j.allowed_extensions.includes(extId)
  && j.allowed_extensions.includes("dsh-manager@local");
process.exit(ok ? 0 : 1);
' "$BASE/host/com.dsh.manager.json" "$BASE" "$EXT_ID" >> "$LOG" 2>&1
check "清单内容（path/allowed_origins/allowed_extensions）" "$([ $? -eq 0 ] && echo 1)"

# ---------------------------------------------------------------
# 3) 真实 dsh E2E：经已安装的 host.sh（生产路径，无任何测试钩子）
# ---------------------------------------------------------------
PORT=31928
req() { # req <action> <payload-json>（默认 {}；勿用 "${2:-{}}"——嵌套花括号会被 shell 提前截断，拼出坏 JSON）
  payload="$2"
  [ -n "$payload" ] || payload="{}"
  printf '{"id":"e2e","action":"%s","payload":%s}' "$1" "$payload" > /tmp/dsh-e2e-req.json
  "$BASE/host/host.sh" --req /tmp/dsh-e2e-req.json --res /tmp/dsh-e2e-res.json >> "$LOG" 2>&1
}
res_state() { "$NODE_ROOT/bin/node" -e 'try{process.stdout.write(require("/tmp/dsh-e2e-res.json").result.state)}catch(e){process.stdout.write("ERR")}'; }

note "start 真实 dsh（--port $PORT）..."
req start "{\"port\":$PORT}"
check "start -> running" "$([ "$(res_state)" = running ] && echo 1)"
sleep 2
req status "{}"
check "status -> running 且端口一致" "$("$NODE_ROOT/bin/node" -e '
try{const r=require("/tmp/dsh-e2e-res.json").result;process.stdout.write((r.state==="running"&&r.port==='"$PORT"')?"1":"0")}catch(e){process.stdout.write("0")}')"

# curl 显式 --noproxy：WSL 环境常透传 Windows 的 http_proxy（127.0.0.1:50888），
# 走代理会把「端口已关闭」误判为 200；指纹截断给足 32KB（__DSH_BOOT__ 内联 JSON 很大，
# 标题在 2000 字节截断之外）。
CODE=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null || printf '000')
BODY=$(curl -s --noproxy '*' --max-time 5 "http://127.0.0.1:$PORT/" 2>/dev/null | head -c 32768 || true)
printf 'HTTP_CODE=%s BODY_HEAD=%s\n' "$CODE" "$(printf '%s' "$BODY" | head -c 120 | tr '\n' ' ')" >> "$LOG"
check "HTTP 指纹 DeepSeek Harness（真实 dsh 页面）" "$(printf '%s' "$BODY" | grep -q 'DeepSeek Harness' && echo 1)"

req stop "{}"
check "stop -> stopped" "$([ "$(res_state)" = stopped ] && echo 1)"
sleep 1
check "端口已关闭" "$(curl -s --noproxy '*' -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/" 2>/dev/null; [ $? -ne 0 ] && echo 1)"

# ---------------------------------------------------------------
# 4) uninstall.sh
# ---------------------------------------------------------------
note "uninstall.sh..."
sh native-host/uninstall.sh >> "$LOG" 2>&1 || { note "uninstall.sh 失败"; exit 7; }
check "数据目录已删除" "$([ ! -e "$BASE" ] && echo 1)"
check "chrome 注册已删除" "$([ ! -f "$HOME/.config/google-chrome/NativeMessagingHosts/com.dsh.manager.json" ] && echo 1)"
check "firefox 注册已删除" "$([ ! -f "$HOME/.mozilla/native-messaging-hosts/com.dsh.manager.json" ] && echo 1)"

rm -f /tmp/dsh-e2e-req.json /tmp/dsh-e2e-res.json

if [ "$FAILS" -eq 0 ]; then
  note "=== E2E 全部通过 ==="
  exit 0
else
  note "=== E2E 失败 $FAILS 项 ==="
  exit 1
fi
