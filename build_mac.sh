#!/usr/bin/env bash
# Claude Code Notify - macOS one-click build script
# Put this file next to claude_notify_server.py, the two hook scripts and app.icns,
# then run: bash build_mac.sh
set -euo pipefail

cd "$(dirname "$0")"

echo "[1/3] Installing dependencies..."
python3 -m pip install --upgrade pip
python3 -m pip install PySide6 paramiko pyinstaller

# 注意：macOS 自带 bash 3.2 在 set -u 下展开空数组会报 unbound variable。
# 所以基础参数永远非空，图标参数只在 app.icns 存在时追加。
PYINSTALLER_ARGS=(
  --noconfirm
  --clean
  --windowed
  --name ClaudeCodeNotify
)

if [[ -f app.icns ]]; then
  PYINSTALLER_ARGS+=(--icon app.icns --add-data "app.icns:.")
else
  echo "warn: app.icns not found, using default app icon"
fi

PYINSTALLER_ARGS+=(
  --add-data "claude_approval_hook.py:."
  --add-data "claude_notify_hook.py:."
)

# 先保证能启动；确认无误后再用 LEAN=1 bash build_mac.sh 排除未用重型 Qt 模块压缩体积
if [[ "${LEAN:-0}" == "1" ]]; then
  PYINSTALLER_ARGS+=(
    --exclude-module PySide6.QtWebEngineCore
    --exclude-module PySide6.QtWebEngineWidgets
    --exclude-module PySide6.QtQuick
    --exclude-module PySide6.QtQml
    --exclude-module PySide6.QtMultimedia
    --exclude-module PySide6.QtSql
    --exclude-module PySide6.QtTest
    --exclude-module PySide6.QtCharts
    --exclude-module PySide6.QtDataVisualization
    --exclude-module PySide6.Qt3DCore
  )
fi

echo "[2/3] Building ClaudeCodeNotify.app ..."
python3 -m PyInstaller "${PYINSTALLER_ARGS[@]}" claude_notify_server.py

echo "[3/3] Done."
echo "Output: dist/ClaudeCodeNotify.app"
echo "Note: for distribution to other Macs, sign with Developer ID and notarize; for local use, right-click Open on first launch if Gatekeeper warns."
