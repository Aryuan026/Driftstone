#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="$ROOT_DIR/server"
TMP_DIR="$ROOT_DIR/tmp/local-app"
PID_FILE="$TMP_DIR/backend.pid"
LOG_FILE="$TMP_DIR/backend.log"
APP_URL="http://127.0.0.1:3460/"

mkdir -p "$TMP_DIR"

open_app() {
  open "$APP_URL" >/dev/null 2>&1 || true
}

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "这台机器还没装 Node.js / npm，所以 Hippocove 还点不起来。"
  echo "请先安装 Node.js 20+，再双击一次这个启动脚本。"
  exit 1
fi

if curl -sf "$APP_URL" >/dev/null 2>&1; then
  echo "Hippocove 已经在跑，正在打开页面…"
  open_app
  exit 0
fi

if [ ! -d "$SERVER_DIR/node_modules" ]; then
  echo "首次启动，正在安装后端依赖…"
  (cd "$SERVER_DIR" && npm install)
fi

if [ -f "$PID_FILE" ]; then
  EXISTING_PID="$(tr -d '[:space:]' < "$PID_FILE" || true)"
  if [ -n "${EXISTING_PID:-}" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "检测到旧后端进程 $EXISTING_PID，继续复用。"
  else
    rm -f "$PID_FILE"
  fi
fi

if [ ! -f "$PID_FILE" ]; then
  echo "正在启动 Hippocove 本地后端…"
  (
    cd "$SERVER_DIR"
    nohup npm run start >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
  )
fi

for _ in {1..25}; do
  if curl -sf "$APP_URL" >/dev/null 2>&1; then
    echo "Hippocove 已就绪，正在打开前台。"
    echo "旧实验台地址：${APP_URL}legacy/index.html"
    open_app
    exit 0
  fi
  sleep 1
done

echo "后端已尝试启动，但浏览器还没等到它回应。"
echo "你可以手动打开：$APP_URL"
open_app
exit 0
