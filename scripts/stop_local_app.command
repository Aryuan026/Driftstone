#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$ROOT_DIR/tmp/local-app"
PID_FILE="$TMP_DIR/backend.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "没有找到 Hippocove 本地后端的 PID 记录。"
  exit 0
fi

PID="$(tr -d '[:space:]' < "$PID_FILE" || true)"
if [ -z "${PID:-}" ]; then
  rm -f "$PID_FILE"
  echo "PID 记录是空的，已经顺手清掉。"
  exit 0
fi

if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "已停止 Hippocove 本地后端（PID $PID）。"
else
  echo "PID $PID 已经不在运行，只清理记录。"
fi

rm -f "$PID_FILE"
