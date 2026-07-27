#!/usr/bin/env python3
"""
Claude Code Notify - 跨平台托盘通知服务（审批弹窗版）

后端能力：
- POST /claude-notify    单向通知（系统通知/托盘气泡，与原版本兼容）
- POST /claude-approval  双向审批：HTTP 请求保持挂起，弹出置顶小窗等待
                         用户点击按钮后才返回 {"decision": ...}，
                         供服务器端 PreToolUse 钩子回传 permissionDecision
- POST /claude-approval-resolved
                         hook 观察到终端已处理后，关闭对应桌面弹窗
- POST /claude-stage-status
                         Stop 时显示阶段完成置顶提醒，
                         UserPromptSubmit 时关闭同会话提醒
- GET  /health           健康检查

数据目录 ~/.claude-notify/ 沿用（Token 不变，服务器端配置无需改动）。

界面：
- 深色现代主题、状态胶囊、通知计数、服务启停、远程部署 + 本机接入
- 审批弹窗：无边框置顶、右下角弹出、按钮由请求方 options 决定、
  倒计时进度条、超时自动回退、可拖拽、多条请求排队处理
"""

import glob
import json
import os
import re
import secrets
import select
import shlex
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional

from PySide6.QtCore import (
    QEvent,
    QObject,
    QPoint,
    Qt,
    QThread,
    QTimer,
    Signal,
    Slot,
)
from PySide6.QtGui import (
    QAction,
    QCloseEvent,
    QCursor,
    QGuiApplication,
    QIcon,
    QMouseEvent,
    QPixmap,
    QShowEvent,
)
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QDialog,
    QFileDialog,
    QFormLayout,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMenu,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QScrollArea,
    QSystemTrayIcon,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)


# ============================================================================
# 基础配置
# ============================================================================

APP_NAME = "Claude Code Notify"

HOST = "0.0.0.0"
PORT = 18765

NOTIFY_PATH = "/claude-notify"
APPROVAL_PATH = "/claude-approval"
APPROVAL_RESOLVED_PATH = "/claude-approval-resolved"
STAGE_STATUS_PATH = "/claude-stage-status"
HEALTH_PATH = "/health"

MAX_REQUEST_SIZE = 1024 * 1024
DEDUP_SECONDS = 3

DEFAULT_APPROVAL_TIMEOUT = 50  # 秒，应小于钩子脚本自身的超时
MAX_APPROVAL_TIMEOUT = 600

USER_HOME = Path.home()
APP_DATA_DIR = USER_HOME / ".claude-notify"

TOKEN_FILE = APP_DATA_DIR / "token"
LOG_FILE = APP_DATA_DIR / "claude-notify.log"
UI_CONFIG_FILE = APP_DATA_DIR / "ui_config.json"

APP_DATA_DIR.mkdir(parents=True, exist_ok=True)


# ============================================================================
# 深色主题样式表
# ============================================================================


# 界面字体栈：拉丁字符优先用各平台英文 UI 字体，中文自动回退到中文字体
FONT_UI = (
    '"Segoe UI", "PingFang SC", "Microsoft YaHei UI", '
    '"Noto Sans CJK SC", sans-serif'
)
# 等宽场景（日志/地址/徽章）：英文等宽优先，中文回退中文字体
FONT_MONO = (
    '"Cascadia Code", "SF Mono", Menlo, Consolas, '
    '"Microsoft YaHei UI", "PingFang SC", monospace'
)

STYLE_SHEET = """
/* 最终合并方案：冷色深色底 + Claude coral 重点色 + 1px hairline */
QMainWindow, QWidget {
    background-color: #101216;
    color: #F5F7FA;
    font-family: __FONT_UI__;
    font-size: 14px;
}

QFrame#card {
    background-color: #16191F;
    border: 1px solid #2A2F38;
    border-radius: 12px;
}

QLabel#cardTitle {
    color: #A7AEB8;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 1px;
}
QLabel { background-color: transparent; }

QLabel#h1 { font-size: 19px; font-weight: 800; letter-spacing: -0.2px; }
QLabel#subtitle { color: #6B7280; font-size: 12px; font-family: __FONT_MONO__; letter-spacing: 1px; }
QLabel#fieldLabel { color: #6B7280; font-size: 13px; }
QLabel#hint { color: #6B7280; font-size: 12px; }
QLabel#kbd {
    color: #A7AEB8; border: 1px solid #3A414D; border-radius: 5px; padding: 1px 6px;
    font-family: __FONT_MONO__; font-size: 12px;
}

QLabel#statValue { color: #F5F7FA; font-size: 20px; font-weight: 800; font-family: __FONT_MONO__; }
QLabel#statLabel { color: #6B7280; font-size: 12px; }
QPushButton#approvalStatValue {
    min-height: 26px;
    color: #F5F7FA;
    font-size: 20px;
    font-weight: 800;
    font-family: __FONT_MONO__;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 0 8px;
}
QPushButton#approvalStatValue:hover {
    color: #E98A6B;
    background-color: rgba(217, 119, 87, 0.08);
    border-color: rgba(217, 119, 87, 0.40);
}
QPushButton#approvalStatValue:pressed {
    background-color: rgba(217, 119, 87, 0.14);
}
QLabel#statusK { color: #6B7280; font-size: 12px; }
QLabel#statusV { color: #F5F7FA; font-size: 15px; font-weight: 750; font-family: __FONT_MONO__; }
QLabel#statusOk { color: #43B581; }
QLabel#statusInfo { color: #6FA8C7; }

QLabel#pillRunning {
    background-color: rgba(67, 181, 129, 0.10);
    color: #8FE0B6;
    border: 1px solid rgba(67, 181, 129, 0.42);
    border-radius: 15px;
    padding: 5px 14px;
    font-family: __FONT_MONO__;
    font-size: 12px;
    font-weight: 700;
}
QLabel#pillStopped {
    background-color: rgba(167, 174, 184, 0.08);
    color: #A7AEB8;
    border: 1px solid #3A414D;
    border-radius: 15px;
    padding: 5px 14px;
    font-family: __FONT_MONO__;
    font-size: 12px;
    font-weight: 700;
}

QLineEdit {
    background-color: #0C0E12;
    border: 1px solid #2A2F38;
    border-radius: 8px;
    padding: 7px 10px;
    color: #F5F7FA;
    font-family: __FONT_MONO__;
    font-size: 13px;
    selection-background-color: #D97757;
}
QLineEdit:read-only {
    background-color: transparent;
    border: none;
    color: #C7CDD6;
    padding-left: 0;
    padding-right: 0;
}
QLineEdit:read-only:focus { border: none; }
QLineEdit:focus, QTextEdit:focus, QPushButton:focus {
    border-color: #E98A6B;
    outline: none;
}

QPushButton {
    min-height: 34px;
    background-color: transparent;
    border: 1px solid #3A414D;
    border-radius: 9px;
    padding: 6px 14px;
    color: #A7AEB8;
}
QPushButton:hover { background-color: rgba(167, 174, 184, 0.08); border-color: #46505D; color: #F5F7FA; }
QPushButton:pressed { background-color: rgba(167, 174, 184, 0.14); }
QPushButton:disabled { color: #5E564F; border-color: #232730; }
QPushButton#primaryButton, QPushButton#approveAllow {
    min-height: 42px;
    background-color: #D97757;
    border-color: #D97757;
    color: #2A140E;
    font-weight: 850;
}
QPushButton#primaryButton:hover, QPushButton#approveAllow:hover { background-color: #E98A6B; border-color: #E98A6B; }
QPushButton#mini { min-height: 28px; padding: 3px 11px; font-size: 12px; border-radius: 7px; }
QPushButton#miniDanger { min-height: 28px; padding: 3px 11px; font-size: 12px; border-radius: 7px; color: #F0A096; border-color: rgba(216, 92, 70, 0.55); }
QPushButton#miniDanger:hover { background-color: rgba(216, 92, 70, 0.12); }
QPushButton#dangerSolid { color: #F0A096; border-color: rgba(216, 92, 70, 0.60); }
QPushButton#dangerSolid:hover { background-color: rgba(216, 92, 70, 0.14); }
QPushButton#tab {
    min-height: 28px; background-color: transparent; border: 1px solid #2A2F38; color: #6B7280;
    border-radius: 7px; padding: 3px 12px; font-size: 12px; font-family: __FONT_MONO__;
}
QPushButton#tab:checked { background-color: rgba(167, 174, 184, 0.10); border-color: #46505D; color: #F5F7FA; }

QTextEdit#log, QTextEdit#approvalDetail {
    background-color: #0C0E12;
    border: 1px solid #2A2F38;
    border-radius: 9px;
    padding: 7px 10px;
    color: #C7CDD6;
    font-family: __FONT_MONO__;
    font-size: 13px;
}
QLabel#toast {
    background-color: #1B1F26; border: 1px solid #3A414D; border-radius: 9px;
    padding: 9px 18px; color: #F5F7FA; font-size: 13px;
}
QLabel#deploySummary {
    background-color: transparent; border: none; padding: 0;
    color: #A7AEB8; font-family: __FONT_MONO__; font-size: 12px;
}

/* ---------------- 审批弹窗 ---------------- */
QWidget#approvalPopupRoot { background: transparent; }
QFrame#approvalCard {
    background-color: rgba(28, 25, 23, 0.98);
    border: 1px solid #3A414D;
    border-left: 3px solid #D97757;
    border-radius: 14px;
}
QLabel#approvalKicker {
    color: #E98A6B; font-family: __FONT_MONO__; font-size: 11px; font-weight: 700; letter-spacing: 2px;
}
QLabel#approvalTitle { color: #F5F7FA; font-size: 20px; font-weight: 850; letter-spacing: -0.2px; }
QLabel#approvalDesc { color: #A7AEB8; font-size: 13px; }
QLabel#approvalProject { color: #6B7280; font-size: 13px; }
QLabel#toolBadge {
    background-color: transparent; color: #A7AEB8; border: 1px solid #3A414D; border-radius: 999px;
    padding: 4px 10px; font-family: __FONT_MONO__; font-size: 11px;
}
QLabel#approvalMessage { color: #F5F7FA; font-size: 14px; }
QLabel#countdownLabel { color: #A7AEB8; font-size: 12px; font-family: __FONT_MONO__; }
QProgressBar#countdownBar { background-color: #20242B; border: none; border-radius: 3px; max-height: 5px; min-height: 5px; }
QProgressBar#countdownBar::chunk { background-color: #D97757; border-radius: 3px; }
QProgressBar#countdownBar[expired="true"]::chunk { background-color: #D85C46; }
QLabel#approvalTitle[expired="true"] { color: #F0A096; }
QLabel#approvalKicker[expired="true"] { color: #F0A096; }
QLabel#approvalDesc[expired="true"] { color: #6B7280; }
QLabel#expiredHint { color: #F0BE78; font-size: 13px; font-weight: 650; }
QPushButton#suggestionButton {
    min-height: 42px; background-color: rgba(217, 119, 87, 0.08);
    color: #E98A6B; border: 1px solid rgba(217, 119, 87, 0.45);
    border-radius: 9px; padding: 7px 14px; font-weight: 700; text-align: left;
}
QPushButton#suggestionButton:hover { background-color: rgba(217, 119, 87, 0.16); border-color: #E98A6B; }
QPushButton#confirmButton {
    min-height: 42px; background-color: #D97757; border-color: #D97757;
    color: #2A140E; font-weight: 850; padding: 8px 18px;
}
QPushButton#confirmButton:hover { background-color: #E98A6B; border-color: #E98A6B; }
QPushButton#otherToggle {
    min-height: 30px; border: 1px dashed #46505D; color: #A7AEB8;
    border-radius: 8px; padding: 4px 12px; font-size: 12px; text-align: left;
}
QPushButton#otherToggle:hover { color: #E5E9EF; border-color: #5A6472; background: transparent; }
QFrame#optionRow {
    background-color: #14171D; border: 1px solid #343B46; border-radius: 9px;
}
QFrame#optionRow:hover { border-color: #4A5462; background-color: #181C23; }
QFrame#optionRow[checked="true"] {
    border-color: #D97757; background-color: rgba(217, 119, 87, 0.14);
}
QFrame#optionRow:disabled { border-color: #232730; background-color: #101216; }
QLabel#optionRowTitle[expired="true"], QLabel#optionRowDesc[expired="true"] { color: #4A515B; }
QLabel#optionRowTitle { color: #F5F7FA; font-size: 13px; font-weight: 700; }
QLabel#optionRowDesc { color: #B4BCC7; font-size: 12px; }
QScrollArea#optionScroll, QWidget#optionContainer { background: transparent; border: none; }
QPushButton#approveDisabled {
    min-height: 42px; background-color: #1B1F26; color: #59616C;
    border: 1px solid #262C35; font-weight: 750; padding: 8px 18px;
}
QPushButton#approveDeny {
    min-height: 42px; background-color: transparent; color: #F0A096; border: 1px solid rgba(216, 92, 70, 0.65);
    font-weight: 750; padding: 8px 18px;
}
QPushButton#approveDeny:hover { background-color: rgba(216, 92, 70, 0.12); }
QPushButton#approveTerminal { border-color: transparent; color: #6B7280; text-decoration: underline; }
QPushButton#approveTerminal:hover { color: #A7AEB8; background: transparent; }
QPushButton#popupClose { background-color: transparent; border: none; color: #6B7280; font-size: 15px; padding: 2px 8px; }
QPushButton#popupClose:hover { color: #F0A096; background: transparent; }

/* ---------------- 审批统计浮层 ---------------- */
QFrame#approvalStatsPopup {
    background-color: #1B1F26;
    border: 1px solid #3A414D;
    border-radius: 10px;
}
QLabel#approvalStatsTitle {
    color: #F5F7FA;
    font-size: 14px;
    font-weight: 750;
}
QLabel#approvalStatsTotal {
    color: #E98A6B;
    font-size: 12px;
    font-family: __FONT_MONO__;
}
QScrollArea#approvalStatsScroll,
QWidget#approvalStatsContainer {
    background: transparent;
    border: none;
}
QFrame#approvalStatsRow {
    background-color: #14171D;
    border: 1px solid #2A2F38;
    border-radius: 7px;
}
QLabel#approvalStatsTool {
    color: #C7CDD6;
    font-size: 12px;
    font-family: __FONT_MONO__;
}
QLabel#approvalStatsCount {
    color: #F5F7FA;
    font-size: 12px;
    font-weight: 750;
    font-family: __FONT_MONO__;
}
QLabel#approvalStatsEmpty {
    color: #6B7280;
    font-size: 12px;
}

/* ---------------- 阶段完成提醒 ---------------- */
QWidget#stageCompletionPopupRoot { background: transparent; }
QFrame#stageCompletionCard {
    background-color: rgba(28, 25, 23, 0.98);
    border: 1px solid #3A414D;
    border-left: 3px solid #43B581;
    border-radius: 14px;
}
QLabel#stageCompletionKicker {
    color: #8FE0B6;
    font-family: __FONT_MONO__;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 2px;
}
QLabel#stageCompletionTitle {
    color: #F5F7FA;
    font-size: 20px;
    font-weight: 850;
}
QLabel#stageCompletionDesc {
    color: #A7AEB8;
    font-size: 13px;
}
QLabel#stageCompletionProject {
    color: #6B7280;
    font-size: 12px;
    font-family: __FONT_MONO__;
}

/* ---------------- 通用 ---------------- */
QMenu { background-color: #16191F; border: 1px solid #2A2F38; border-radius: 9px; padding: 4px; }
QMenu::item { padding: 6px 24px; border-radius: 5px; color: #A7AEB8; }
QMenu::item:selected { background-color: #3A414D; color: #F5F7FA; }
QMenu::separator { height: 1px; background: #2A2F38; margin: 4px 8px; }
QMessageBox QLabel { color: #F5F7FA; }
QToolTip { background-color: #1B1F26; color: #F5F7FA; border: 1px solid #3A414D; padding: 4px 8px; }
QScrollBar:vertical { background: transparent; width: 8px; margin: 2px; }
QScrollBar::handle:vertical { background: #3A332E; border-radius: 4px; min-height: 30px; }
QScrollBar::handle:vertical:hover { background: #3A414D; }
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical { background: none; }
"""
STYLE_SHEET = STYLE_SHEET.replace("__FONT_UI__", FONT_UI).replace(
    "__FONT_MONO__", FONT_MONO
)

LOG_COLORS = {
    "info": "#9CC6D8",
    "notify": "#E98A6B",
    "warn": "#F0BE78",
    "error": "#F0A096",
}

MAX_LOG_LINES = 500


# ============================================================================
# 工具函数
# ============================================================================

def resource_path(relative_path: str) -> Path:
    """获取开发环境或 PyInstaller 打包后的资源路径。"""
    if hasattr(sys, "_MEIPASS"):
        base_path = Path(getattr(sys, "_MEIPASS"))
    else:
        base_path = Path(__file__).resolve().parent

    return base_path / relative_path



def load_or_create_token() -> str:
    """Token 文件存在时复用，不存在时创建。"""
    if TOKEN_FILE.exists():
        token = TOKEN_FILE.read_text(encoding="utf-8").strip()

        if token:
            return token

    token = secrets.token_urlsafe(32)
    TOKEN_FILE.write_text(token + "\n", encoding="utf-8")

    return token


def regenerate_token() -> str:
    token = secrets.token_urlsafe(32)
    TOKEN_FILE.write_text(token + "\n", encoding="utf-8")
    return token


def get_local_ip() -> str:
    """获取默认路由对应的本机 IPv4 地址。"""
    probe_addresses = [
        ("8.8.8.8", 80),
        ("1.1.1.1", 80),
        ("223.5.5.5", 80),
    ]

    for address in probe_addresses:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.connect(address)
                ip = sock.getsockname()[0]

                if ip and not ip.startswith("127."):
                    return ip
        except OSError:
            continue

    try:
        hostname = socket.gethostname()

        for result in socket.getaddrinfo(
            hostname,
            None,
            socket.AF_INET,
            socket.SOCK_DGRAM,
        ):
            ip = result[4][0]

            if ip and not ip.startswith("127."):
                return ip
    except OSError:
        pass

    return "127.0.0.1"


def safe_string(value: Any) -> str:
    if value is None:
        return ""

    if isinstance(value, str):
        return value

    try:
        return json.dumps(value, ensure_ascii=False, indent=2)
    except Exception:
        return str(value)


NON_COMPLETED_APPROVAL_DECISIONS = frozenset(
    {"ask", "dismissed", "timeout", "cancelled"}
)


def is_completed_approval_decision(decision: str) -> bool:
    """是否为 GUI 中已实际提交的审批/问答结果。"""
    return bool(decision) and decision not in NON_COMPLETED_APPROVAL_DECISIONS


def format_approval_type_counts(counts: dict[str, int]) -> str:
    """按首次出现顺序格式化权限类型明细。"""
    parts = [
        f"{tool_name} x{count}"
        for tool_name, count in counts.items()
        if count > 0
    ]
    return "，".join(parts) if parts else "暂无审批记录"


def escape_html(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


# ============================================================================
# 服务器部署（钩子命令构建 + settings.json 幂等合并）
# ============================================================================

APPROVAL_SCRIPT_NAME = "claude_approval_hook.py"
NOTIFY_SCRIPT_NAME = "claude_notify_hook.py"
HOOK_CONFIG_NAME = "claude_notify_config.json"
ALL_HOOK_SCRIPTS = (APPROVAL_SCRIPT_NAME, NOTIFY_SCRIPT_NAME)

SETTINGS_REMOTE_PATH = "$HOME/.claude/settings.json"
DEPLOY_CACHE_FILE = APP_DATA_DIR / "deploy_config.json"

DEPLOY_MODES = {
    "popup": "应用置顶弹窗（可快速审批）",
    "notify": "系统通知中心（仅提醒）",
}


def load_deploy_cache() -> dict[str, Any]:
    """读取部署/服务器测试共用的本地缓存。"""
    try:
        if DEPLOY_CACHE_FILE.exists():
            data = json.loads(
                DEPLOY_CACHE_FILE.read_text(encoding="utf-8")
            )
            if isinstance(data, dict):
                return data
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def save_deploy_cache(cache: dict[str, Any]) -> None:
    """写入部署/服务器测试共用的本地缓存。"""
    try:
        DEPLOY_CACHE_FILE.write_text(
            json.dumps(cache, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except OSError:
        pass


def build_hook_command(
    env_pairs: dict[str, Any],
    script_name: str,
) -> str:
    """
    生成写入 settings.json 的钩子命令。
    环境变量直接内联在命令里，服务器端无需额外配置。
    """
    parts = [f"{key}='{value}'" for key, value in env_pairs.items()]
    parts.append(f"python3 $HOME/.claude/{script_name}")
    return " ".join(parts)


def merge_settings_json(
    existing_text: str,
    mode: str,
    hook_entry: dict[str, Any],
    hook_timeout: int = 300,
    matcher: str = "",
    question_entry: Optional[dict[str, Any]] = None,
    stage_entry: Optional[dict[str, Any]] = None,
) -> str:
    """
    把所选模式的钩子合并进现有 settings.json（幂等）：
    - PreToolUse、PermissionRequest、Notification、Stop、UserPromptSubmit
      分区里，凡引用我们两种钩子脚本的条目全部移除
    - 再按所选模式追加最新配置：
      popup  → PermissionRequest（只在真正弹权限框时触发，误判少）
      notify → Notification（单向提醒）
    - popup 模式且提供 question_entry 时，额外向 PreToolUse 写入
      matcher="" 的关联/代答钩子：普通工具只记录官方 tool_use_id 后退出，
      AskUserQuestion 则继续走桌面代答
    - 提供 stage_entry 时，无论通知方式如何，都向 Stop 与
      UserPromptSubmit 写入阶段状态钩子
    - 其他钩子与设置原样保留

    hook_entry / question_entry 是不含 timeout 的 handler 字典，支持两种形态：
    - shell form：{"type": "command", "command": "<shell 命令串>"}
    - exec form：{"type": "command", "command": "<可执行文件>", "args": [...]}
      （无 shell 参与、不依赖 PATH，Windows 本机接入使用）
    """
    try:
        settings = json.loads(existing_text) if existing_text.strip() else {}
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"服务器上现有 settings.json 不是合法 JSON：{exc}"
        ) from exc

    if not isinstance(settings, dict):
        raise ValueError("服务器上现有 settings.json 根节点必须是对象")

    hooks = settings.setdefault("hooks", {})

    def is_ours(entry: Any) -> bool:
        serialized = json.dumps(entry, ensure_ascii=False)
        return any(
            script in serialized for script in ALL_HOOK_SCRIPTS
        )

    # 清除两种脚本在所有相关分区里的旧配置
    for section_name in (
        "PreToolUse",
        "PermissionRequest",
        "Notification",
        "Stop",
        "UserPromptSubmit",
    ):
        entries = hooks.get(section_name)
        if isinstance(entries, list):
            cleaned = [e for e in entries if not is_ours(e)]
            if cleaned:
                hooks[section_name] = cleaned
            else:
                hooks.pop(section_name, None)

    # 按所选模式追加
    entry = dict(hook_entry)
    entry["timeout"] = hook_timeout if mode == "popup" else 30

    section_name = "PermissionRequest" if mode == "popup" else "Notification"
    section = hooks.setdefault(section_name, [])
    section.append({"matcher": matcher, "hooks": [entry]})

    # popup 模式：所有工具先经 PreToolUse 记录 tool_use_id；
    # 普通工具立即退出，AskUserQuestion 才会等待桌面回答。
    if mode == "popup" and question_entry is not None:
        q_entry = dict(question_entry)
        q_entry["timeout"] = hook_timeout
        pre_section = hooks.setdefault("PreToolUse", [])
        pre_section.append(
            {"matcher": "", "hooks": [q_entry]}
        )

    if stage_entry is not None:
        for stage_section_name in ("Stop", "UserPromptSubmit"):
            status_entry = dict(stage_entry)
            status_entry["timeout"] = 15
            stage_section = hooks.setdefault(stage_section_name, [])
            stage_section.append(
                {"matcher": "", "hooks": [status_entry]}
            )

    return json.dumps(settings, ensure_ascii=False, indent=2) + "\n"


# ============================================================================
# 本机 Claude Code 接入（同一台机器既是客户端又是服务端）
# ============================================================================

def local_claude_dir() -> Path:
    return Path.home() / ".claude"


def local_python_command() -> str:
    """POSIX shell form 用的解释器命令名（Windows 不再使用，见 resolve_local_python）。"""
    return "python3"


def resolve_local_python() -> str:
    """
    解析本机可用的 Python 解释器绝对路径（仅 Windows 调用）。

    背景：Claude Code 派生的 shell（Git Bash 缺失时是 PowerShell）PATH 与
    交互式终端不一致，py/python 这类命令名经常解析不到；exec form 又会
    绕过 shell 直接生成进程。因此必须给出验证过能运行的绝对路径。
    """
    candidates: list[list[str]] = []

    # 源码运行时，当前解释器最可靠；PyInstaller 打包后 sys.executable 是
    # 应用自身，不能用
    if not getattr(sys, "frozen", False):
        candidates.append([sys.executable])

    py_launcher = shutil.which("py")
    if py_launcher:
        candidates.append([py_launcher, "-3"])

    for name in ("python", "python3"):
        found = shutil.which(name)
        if found:
            candidates.append([found])

    # 常见安装位置兜底（PATH 被精简时 shutil.which 找不到）
    search_roots = [
        os.environ.get("LOCALAPPDATA", ""),
        os.environ.get("ProgramFiles", ""),
        os.environ.get("ProgramFiles(x86)", ""),
        "C:\\",
    ]
    for root in search_roots:
        if not root:
            continue
        pattern = str(Path(root) / "Programs" / "Python" / "Python*" / "python.exe")
        if root == "C:\\":
            pattern = r"C:\Python*\python.exe"
        for path in sorted(glob.glob(pattern), reverse=True):
            candidates.append([path])

    seen: set[str] = set()
    for cmd in candidates:
        key = " ".join(cmd)
        if key in seen:
            continue
        seen.add(key)
        try:
            result = subprocess.run(
                cmd + ["-c", "import sys; print(sys.executable)"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if result.returncode != 0:
            continue
        lines = result.stdout.strip().splitlines()
        if lines and Path(lines[0]).exists():
            return lines[0]

    raise RuntimeError(
        "未找到可用的 Python 解释器（已尝试 py/python 与常见安装目录）。"
        "请先安装 Python 3.9+，再重新接入本机。"
    )


def build_local_hook_entry(
    env_pairs: dict[str, Any],
    script_path: Path,
) -> dict[str, Any]:
    """
    生成本机 settings.json 钩子 handler（不含 timeout，merge 时补充）。

    Windows：exec form——command 为解释器绝对路径，args 传脚本路径。
    Claude Code 直接生成进程、不经过 shell，彻底避开 py/python 找不到、
    PowerShell 引号规则等问题；Token/URL 由钩子读同目录
    claude_notify_config.json（deploy_local 负责写入）。
    POSIX：shell form，环境变量直接内联，Claude Code 从任何目录启动都能读到。
    """
    if sys.platform == "win32":
        return {
            "type": "command",
            "command": resolve_local_python(),
            "args": [str(script_path)],
        }

    parts = [
        f"{key}={shlex.quote(str(value))}"
        for key, value in env_pairs.items()
    ]
    parts.append(
        f"{local_python_command()} {shlex.quote(str(script_path))}"
    )
    return {"type": "command", "command": " ".join(parts)}


def detect_local_deploy() -> Optional[str]:
    """返回本机已接入的模式（popup/notify），未接入返回 None。"""
    settings_path = local_claude_dir() / "settings.json"
    if not settings_path.exists():
        return None
    try:
        text = settings_path.read_text(encoding="utf-8")
    except OSError:
        return None
    if APPROVAL_SCRIPT_NAME in text:
        return "popup"
    if NOTIFY_SCRIPT_NAME in text:
        return "notify"
    return None


# ============================================================================
# Windows DPAPI：本地密码加密（只有当前 Windows 用户可解密）
# ============================================================================

def dpapi_available() -> bool:
    """DPAPI 仅在 Windows 上可用。"""
    import ctypes

    return hasattr(ctypes, "windll")


def _dpapi_protect(data: bytes, protect: bool) -> bytes:
    import ctypes
    import ctypes.wintypes as wintypes

    class DataBlob(ctypes.Structure):
        _fields_ = [
            ("cbData", wintypes.DWORD),
            ("pbData", ctypes.POINTER(ctypes.c_char)),
        ]

    buffer_in = ctypes.create_string_buffer(data, len(data))
    blob_in = DataBlob(
        len(data),
        ctypes.cast(buffer_in, ctypes.POINTER(ctypes.c_char)),
    )
    blob_out = DataBlob()

    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32

    if protect:
        ok = crypt32.CryptProtectData(
            ctypes.byref(blob_in),
            None,
            None,
            None,
            None,
            0,
            ctypes.byref(blob_out),
        )
    else:
        ok = crypt32.CryptUnprotectData(
            ctypes.byref(blob_in),
            None,
            None,
            None,
            None,
            0,
            ctypes.byref(blob_out),
        )

    if not ok:
        raise RuntimeError("DPAPI 调用失败")

    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(blob_out.pbData)


def dpapi_encrypt_text(plain_text: str) -> str:
    """加密文本，返回 base64 字符串（可安全写入 JSON 文件）。"""
    import base64

    encrypted = _dpapi_protect(plain_text.encode("utf-8"), True)
    return base64.b64encode(encrypted).decode("ascii")


def dpapi_decrypt_text(encrypted_b64: str) -> str:
    """解密 dpapi_encrypt_text 的产物。"""
    import base64

    encrypted = base64.b64decode(encrypted_b64)
    return _dpapi_protect(encrypted, False).decode("utf-8")


# ============================================================================
# 本地密钥存储抽象（Windows DPAPI / macOS Keychain / 其他平台禁用）
# ============================================================================

class SecretStore:
    """本地免密存储策略接口：只负责把一段文本安全地放到当前用户密钥库。"""

    label = "当前平台不可用"

    def available(self) -> bool:
        return False

    def encrypt_text(self, plain_text: str) -> str:
        raise RuntimeError("当前平台没有可用的本地密钥存储")

    def decrypt_text(self, encrypted: str) -> str:
        raise RuntimeError("当前平台没有可用的本地密钥存储")


class WindowsSecretStore(SecretStore):
    label = "Windows DPAPI"

    def available(self) -> bool:
        return dpapi_available()

    def encrypt_text(self, plain_text: str) -> str:
        return dpapi_encrypt_text(plain_text)

    def decrypt_text(self, encrypted: str) -> str:
        return dpapi_decrypt_text(encrypted)


class MacKeychainSecretStore(SecretStore):
    """
    使用 macOS 自带 security CLI 写入登录钥匙串。
    缓存文件里只保存 keychain:// 标记，真正的密码留在 Keychain。
    """

    label = "macOS Keychain"
    service = "ClaudeCodeNotify"
    account = "deploy-password"
    marker = "keychain://deploy-password"

    def available(self) -> bool:
        return (
            sys.platform == "darwin"
            and shutil.which("security") is not None
        )

    def encrypt_text(self, plain_text: str) -> str:
        if not self.available():
            raise RuntimeError("macOS Keychain 不可用")
        subprocess.run(
            [
                "security",
                "add-generic-password",
                "-U",
                "-s",
                self.service,
                "-a",
                self.account,
                "-w",
                plain_text,
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        return self.marker

    def decrypt_text(self, encrypted: str) -> str:
        if encrypted != self.marker:
            raise RuntimeError("不是 macOS Keychain 密文标记")
        result = subprocess.run(
            [
                "security",
                "find-generic-password",
                "-s",
                self.service,
                "-a",
                self.account,
                "-w",
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        return result.stdout.rstrip("\n")


class NullSecretStore(SecretStore):
    pass


def create_secret_store() -> SecretStore:
    if sys.platform == "win32":
        return WindowsSecretStore()
    if sys.platform == "darwin":
        return MacKeychainSecretStore()
    return NullSecretStore()


SECRET_STORE = create_secret_store()


# ============================================================================
# 服务器 Shell 环境变量写入
# ============================================================================

ENV_MARK_BEGIN = "# >>> claude-notify >>>"
ENV_MARK_END = "# <<< claude-notify <<<"

# shell 标识 -> (显示名, rc 文件相对路径)
SHELL_RC_FILES: dict[str, tuple[str, str]] = {
    "bash": ("Bash", ".bashrc"),
    "zsh": ("Zsh", ".zshrc"),
    "csh": ("Csh/Tcsh", ".cshrc"),
    "fish": ("Fish", ".config/fish/config.fish"),
}


def build_env_block(shell: str, token: str) -> str:
    """生成带幂等标记的环境变量初始化块。"""
    if shell == "csh":
        line = f"setenv CLAUDE_NOTIFY_TOKEN '{token}'"
    elif shell == "fish":
        line = f"set -x CLAUDE_NOTIFY_TOKEN '{token}'"
    else:  # bash / zsh
        line = f"export CLAUDE_NOTIFY_TOKEN='{token}'"

    return f"{ENV_MARK_BEGIN}\n{line}\n{ENV_MARK_END}"


# ============================================================================
# 审批请求对象（HTTP 线程与 GUI 线程之间共享）
# ============================================================================

class ApprovalRequest:
    """
    HTTP 处理线程创建后通过信号交给 GUI 线程展示，
    然后阻塞在 event 上等待用户点击按钮或超时。
    """

    def __init__(
        self,
        payload: dict[str, Any],
        timeout_seconds: int,
    ) -> None:
        self.payload = payload
        self.timeout_seconds = timeout_seconds
        self.event = threading.Event()
        self.decision: Optional[str] = None
        # 结构化回传的附加字段：suggestion → {"index": N}；
        # answer → {"answers": [...]}；其余决策为空
        self.extra: dict[str, Any] = {}
        self._finish_lock = threading.Lock()

    # ---- 便捷访问 ----

    @property
    def tool_name(self) -> str:
        return safe_string(self.payload.get("tool_name")) or "未知工具"

    @property
    def project_name(self) -> str:
        cwd = safe_string(self.payload.get("cwd"))
        if not cwd:
            return "未知项目"
        normalized = cwd.rstrip("/\\")
        return os.path.basename(normalized) or normalized

    @property
    def message(self) -> str:
        return (
            safe_string(self.payload.get("message"))
            or f"工具 {self.tool_name} 请求权限审批"
        )

    @property
    def detail(self) -> str:
        tool_input = self.payload.get("tool_input")
        if tool_input in (None, "", {}, []):
            return ""
        text = safe_string(tool_input)
        return text[:2000]

    @property
    def options(self) -> list[dict[str, str]]:
        """
        请求方提供的可选按钮：[{"id": "allow", "label": "允许"}, ...]
        未提供时使用默认的 允许 / 拒绝。
        """
        raw = self.payload.get("options")
        options: list[dict[str, str]] = []

        if isinstance(raw, list):
            for item in raw:
                if not isinstance(item, dict):
                    continue
                option_id = safe_string(item.get("id"))
                label = safe_string(item.get("label"))
                if option_id and label:
                    options.append(
                        {"id": option_id, "label": label}
                    )

        if not options:
            options = [
                {"id": "allow", "label": "允许"},
                {"id": "deny", "label": "拒绝"},
            ]

        return options[:6]  # 最多 6 个按钮，防止弹窗过宽

    @property
    def kind(self) -> str:
        """permission（权限审批）或 question（AskUserQuestion 提问）。"""
        kind = safe_string(self.payload.get("kind"))
        return kind if kind in {"permission", "question"} else "permission"

    @property
    def suggestions(self) -> list[dict[str, Any]]:
        """
        Claude 给出的 permission_suggestions（不透明转发）。
        弹窗只负责展示标签，选中后由 hook 原样 echo 回 updatedPermissions。
        按对象内容去重：Claude 偶发会在数组里放重复条目，
        不去重弹窗会出现两个一模一样的“始终允许”按钮。
        """
        raw = self.payload.get("suggestions")
        if not isinstance(raw, list):
            return []
        seen: set[str] = set()
        result: list[dict[str, Any]] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            key = json.dumps(item, sort_keys=True, ensure_ascii=False)
            if key in seen:
                continue
            seen.add(key)
            result.append(item)
        return result[:6]

    @property
    def questions(self) -> list[dict[str, Any]]:
        """AskUserQuestion 的 questions 数组（kind=question 时有值）。"""
        raw = self.payload.get("questions")
        if not isinstance(raw, list):
            return []
        return [q for q in raw if isinstance(q, dict)][:4]

    def finish(
        self,
        decision: str,
        extra: Optional[dict[str, Any]] = None,
    ) -> bool:
        """只接受第一个完成结果，避免桌面点击与终端处理互相覆盖。"""
        with self._finish_lock:
            if self.event.is_set():
                return False
            self.decision = decision
            if extra:
                self.extra = extra
            self.event.set()
            return True

    @property
    def request_id(self) -> str:
        return safe_string(self.payload.get("request_id"))


# suggestion destination / mode 的人类可读标签（best-effort；
# 不认识的值原样显示，不认识的类型用通用文案，功能不受影响）。
# 类型全集见官方文档 Permission update entries：
# addRules / replaceRules / removeRules / setMode /
# addDirectories / removeDirectories
SUGGESTION_DEST_LABELS = {
    "session": "本次会话",
    "localSettings": "本项目",
    "projectSettings": "项目共享配置",
    "userSettings": "所有项目",
}
SUGGESTION_MODE_LABELS = {
    "acceptEdits": "自动接受编辑",
    "bypassPermissions": "跳过所有权限询问",
    "plan": "切换到计划模式",
    "default": "切换回默认模式",
    "manual": "切换回默认模式",
    "auto": "自动批准低风险操作",
    "dontAsk": "不再询问",
}
SUGGESTION_BEHAVIOR_LABELS = {
    "allow": "允许",
    "deny": "拒绝",
    "ask": "询问",
}


def describe_rule_entries(rules: Any, limit: int = 3) -> str:
    """
    把 rules 数组渲染为「Bash(git status:*)、Write」式摘要。
    官方字段名为 toolName / ruleContent（ruleContent 缺省匹配整个工具）；
    同时兼容早期猜测写法 tool / rule / prompt，防协议变动。
    """
    parts: list[str] = []
    if isinstance(rules, list):
        for rule in rules[:limit]:
            if not isinstance(rule, dict):
                continue
            tool = (
                safe_string(rule.get("toolName"))
                or safe_string(rule.get("tool"))
                or "?"
            )
            pattern = (
                safe_string(rule.get("ruleContent"))
                or safe_string(rule.get("rule"))
                or safe_string(rule.get("prompt"))
            )
            parts.append(f"{tool}({pattern})" if pattern else tool)
    detail = "、".join(parts)
    if isinstance(rules, list) and len(rules) > limit:
        detail += "…"
    return detail


def describe_suggestion(suggestion: dict[str, Any]) -> str:
    """
    为 permission_suggestion 生成显示标签。
    只影响显示——选中后 echo 的是原始对象，与标签无关。
    """
    stype = safe_string(suggestion.get("type"))
    dest = SUGGESTION_DEST_LABELS.get(
        safe_string(suggestion.get("destination")),
        safe_string(suggestion.get("destination")) or "默认范围",
    )

    if stype == "setMode":
        mode = safe_string(suggestion.get("mode"))
        mode_label = SUGGESTION_MODE_LABELS.get(mode, mode or "切换模式")
        return f"{dest}内{mode_label}"

    if stype in {"addRules", "replaceRules", "removeRules"}:
        behavior = safe_string(suggestion.get("behavior")) or "allow"
        behavior_label = SUGGESTION_BEHAVIOR_LABELS.get(behavior, behavior)
        detail = describe_rule_entries(suggestion.get("rules"))
        if stype == "addRules":
            verb = {"allow": "始终允许", "deny": "始终拒绝", "ask": "始终询问"}.get(
                behavior, behavior
            )
        elif stype == "replaceRules":
            verb = f"将{behavior_label}规则替换为"
        else:
            verb = "移除匹配规则"
        return f"{verb} {detail}（{dest}）" if detail else f"{verb}（{dest}）"

    if stype in {"addDirectories", "removeDirectories"}:
        directories = suggestion.get("directories")
        dirs = (
            [safe_string(d) for d in directories if safe_string(d)][:2]
            if isinstance(directories, list)
            else []
        )
        detail = "、".join(dirs)
        if isinstance(directories, list) and len(directories) > 2:
            detail += "…"
        verb = "允许访问目录" if stype == "addDirectories" else "移除工作目录"
        if detail:
            return f"{verb} {detail}（{dest}）"
        return f"{verb}（{dest}）"

    if stype:
        return f"始终允许（{dest}，细则见终端）"
    return "始终允许（细则见终端）"


def unknown_suggestion_types(suggestions: list[dict[str, Any]]) -> list[str]:
    """返回没见过的 suggestion 类型（用于可观测性 warn 日志）。"""
    known = {
        "setMode",
        "addRules",
        "replaceRules",
        "removeRules",
        "addDirectories",
        "removeDirectories",
    }
    return sorted(
        {
            safe_string(s.get("type")) or "<missing>"
            for s in suggestions
        }
        - known
    )


# ============================================================================
# HTTP 服务
# ============================================================================

class HttpEventBridge(QObject):
    notification_received = Signal(str, str)
    log_received = Signal(str, str)  # level, message
    approval_received = Signal(object)  # ApprovalRequest
    approval_cancelled = Signal(object)  # ApprovalRequest（终端先作答/断连）
    stage_status_received = Signal(object)  # completed / resumed
    service_state_changed = Signal(bool, str)


class ClaudeNotifyServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(
        self,
        server_address: tuple[str, int],
        handler_class: type[BaseHTTPRequestHandler],
        bridge: HttpEventBridge,
        token: str,
    ) -> None:
        super().__init__(server_address, handler_class)

        self.bridge = bridge
        self.token = token

        self.last_notifications: dict[str, float] = {}
        self.notification_lock = threading.Lock()
        self.approval_lock = threading.Lock()
        self.active_approvals: dict[str, ApprovalRequest] = {}

    def update_token(self, token: str) -> None:
        self.token = token

    def register_approval(self, request: ApprovalRequest) -> None:
        if not request.request_id:
            return
        with self.approval_lock:
            self.active_approvals[request.request_id] = request

    def unregister_approval(self, request: ApprovalRequest) -> None:
        if not request.request_id:
            return
        with self.approval_lock:
            current = self.active_approvals.get(request.request_id)
            if current is request:
                self.active_approvals.pop(request.request_id, None)

    def resolve_from_terminal(self, request_id: str) -> str:
        with self.approval_lock:
            request = self.active_approvals.get(request_id)
        if request is None:
            return "not_found"
        if not request.finish("cancelled"):
            return "already_finished"
        self.bridge.approval_cancelled.emit(request)
        self.bridge.log_received.emit(
            "info",
            "终端侧已处理，弹窗同步关闭："
            f"request={request_id[:12]}, tool={request.tool_name}",
        )
        return "resolved"

    def should_notify(self, data: dict[str, Any]) -> bool:
        session_id = (
            safe_string(data.get("session_id"))
            or "unknown-session"
        )

        notification_type = (
            safe_string(data.get("notification_type"))
            or safe_string(data.get("matcher"))
            or "permission_prompt"
        )

        dedup_key = f"{session_id}:{notification_type}"
        now = time.monotonic()

        with self.notification_lock:
            previous = self.last_notifications.get(dedup_key, 0.0)

            if now - previous < DEDUP_SECONDS:
                return False

            self.last_notifications[dedup_key] = now

            expired_before = now - 3600

            expired_keys = [
                key
                for key, timestamp in self.last_notifications.items()
                if timestamp < expired_before
            ]

            for key in expired_keys:
                self.last_notifications.pop(key, None)

        return True


class ClaudeNotifyHandler(BaseHTTPRequestHandler):
    server_version = "ClaudeNotifyServer/2.2"

    @property
    def notify_server(self) -> ClaudeNotifyServer:
        return self.server  # type: ignore[return-value]

    # ------------------------------------------------------------------
    # 基础响应
    # ------------------------------------------------------------------

    def send_json(
        self,
        status_code: int,
        payload: dict[str, Any],
    ) -> None:
        body = json.dumps(
            payload,
            ensure_ascii=False,
        ).encode("utf-8")

        self.send_response(status_code)
        self.send_header(
            "Content-Type",
            "application/json; charset=utf-8",
        )
        self.send_header(
            "Content-Length",
            str(len(body)),
        )
        self.end_headers()

        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def authenticate(self) -> bool:
        authorization = self.headers.get("Authorization", "")
        expected = f"Bearer {self.notify_server.token}"

        if secrets.compare_digest(authorization, expected):
            return True

        self.notify_server.bridge.log_received.emit(
            "warn",
            "认证失败："
            f"remote={self.client_address[0]}, "
            f"received_length={len(authorization)}, "
            f"expected_length={len(expected)}",
        )

        self.send_json(401, {"error": "unauthorized"})
        return False

    def client_gone(self) -> bool:
        """
        非阻塞探测客户端连接是否已断开，作为 transcript 同步之外的
        异常退出补充路径。
        """
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
        except (OSError, ValueError):
            return True
        if not readable:
            return False  # 无数据可读：连接空闲但存活
        try:
            peeked = self.connection.recv(1, socket.MSG_PEEK)
        except BlockingIOError:
            return False  # 竞态：select 与 recv 之间状态变化
        except OSError:
            return True  # ConnectionResetError 等：对端已重置
        # 读到数据属异常（钩子不会二次发送），视为存活、不消费
        return peeked == b""

    def read_json_body(self) -> Optional[dict[str, Any]]:
        """解析请求体。出错时已发送错误响应，返回 None。"""
        content_length_text = self.headers.get("Content-Length")

        if content_length_text is None:
            self.send_json(411, {"error": "content_length_required"})
            return None

        try:
            content_length = int(content_length_text)
        except ValueError:
            self.send_json(400, {"error": "invalid_content_length"})
            return None

        if content_length <= 0:
            self.send_json(400, {"error": "empty_request_body"})
            return None

        if content_length > MAX_REQUEST_SIZE:
            self.send_json(413, {"error": "request_too_large"})
            return None

        try:
            raw_body = self.rfile.read(content_length)
            data = json.loads(raw_body.decode("utf-8"))
        except UnicodeDecodeError:
            self.send_json(400, {"error": "body_must_be_utf8"})
            return None
        except json.JSONDecodeError as exc:
            self.send_json(
                400,
                {"error": "invalid_json", "detail": str(exc)},
            )
            return None

        if not isinstance(data, dict):
            self.send_json(400, {"error": "json_root_must_be_object"})
            return None

        return data

    # ------------------------------------------------------------------
    # 路由
    # ------------------------------------------------------------------

    def do_GET(self) -> None:
        if self.path == HEALTH_PATH:
            self.send_json(
                200,
                {
                    "status": "ok",
                    "service": "claude-notify",
                    "port": PORT,
                },
            )
            return

        self.send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:
        if self.path == NOTIFY_PATH:
            if not self.authenticate():
                return
            data = self.read_json_body()
            if data is not None:
                self.handle_notification(data)
            return

        if self.path == APPROVAL_PATH:
            if not self.authenticate():
                return
            data = self.read_json_body()
            if data is not None:
                self.handle_approval(data)
            return

        if self.path == APPROVAL_RESOLVED_PATH:
            if not self.authenticate():
                return
            data = self.read_json_body()
            if data is not None:
                self.handle_approval_resolved(data)
            return

        if self.path == STAGE_STATUS_PATH:
            if not self.authenticate():
                return
            data = self.read_json_body()
            if data is not None:
                self.handle_stage_status(data)
            return

        self.send_json(404, {"error": "not_found"})

    # ------------------------------------------------------------------
    # 单向通知（保持原行为）
    # ------------------------------------------------------------------

    def handle_notification(self, data: dict[str, Any]) -> None:
        notification_type = (
            safe_string(data.get("notification_type"))
            or safe_string(data.get("matcher"))
            or "unknown"
        )

        session_id = (
            safe_string(data.get("session_id"))
            or "unknown"
        )

        self.notify_server.bridge.log_received.emit(
            "info",
            "收到通知："
            f"remote={self.client_address[0]}, "
            f"type={notification_type}, "
            f"session={session_id[:16]}",
        )

        if self.notify_server.should_notify(data):
            title, message = self.build_notification(data)

            self.notify_server.bridge.notification_received.emit(
                title,
                message,
            )
        else:
            self.notify_server.bridge.log_received.emit(
                "info",
                "忽略短时间内重复通知",
            )

        self.send_json(200, {"status": "ok"})

    def build_notification(
        self,
        data: dict[str, Any],
    ) -> tuple[str, str]:
        cwd = safe_string(data.get("cwd"))
        session_id = safe_string(data.get("session_id"))
        message = safe_string(data.get("message"))
        notification_type = safe_string(
            data.get("notification_type")
        )

        if cwd:
            normalized_cwd = cwd.rstrip("/\\")
            project_name = (
                os.path.basename(normalized_cwd)
                or normalized_cwd
            )
        else:
            project_name = "未知项目"

        title = f"Claude Code 等待权限审批 · {project_name}"

        body_parts: list[str] = []

        if message:
            body_parts.append(message)
        else:
            body_parts.append(
                "Claude Code 正在等待权限审批。"
            )

        if cwd:
            body_parts.append(f"目录：{cwd}")

        if notification_type:
            body_parts.append(f"类型：{notification_type}")

        if session_id:
            body_parts.append(
                f"会话：{session_id[:16]}"
            )

        return title, "\n".join(body_parts)

    # ------------------------------------------------------------------
    # 阶段完成提醒（始终由独立置顶弹窗展示）
    # ------------------------------------------------------------------

    def handle_stage_status(self, data: dict[str, Any]) -> None:
        status = safe_string(data.get("status"))
        session_id = safe_string(data.get("session_id"))
        if status not in {"completed", "resumed"}:
            self.send_json(400, {"error": "invalid_stage_status"})
            return
        if not session_id:
            self.send_json(400, {"error": "session_id_required"})
            return

        payload = dict(data)
        payload["status"] = status
        payload["session_id"] = session_id
        self.notify_server.bridge.stage_status_received.emit(payload)
        self.notify_server.bridge.log_received.emit(
            "notify" if status == "completed" else "info",
            "阶段状态："
            f"status={status}, session={session_id[:16]}, "
            f"remote={self.client_address[0]}",
        )
        self.send_json(200, {"status": "ok"})

    # ------------------------------------------------------------------
    # 双向审批（长轮询：挂起请求直到用户点击或超时）
    # ------------------------------------------------------------------

    def handle_approval_resolved(self, data: dict[str, Any]) -> None:
        request_id = safe_string(data.get("request_id"))
        if not request_id:
            self.send_json(400, {"error": "request_id_required"})
            return
        status = self.notify_server.resolve_from_terminal(request_id)
        if status == "not_found":
            self.send_json(404, {"status": status})
            return
        self.send_json(200, {"status": status})

    def handle_approval(self, data: dict[str, Any]) -> None:
        remote = self.client_address[0]

        raw_timeout = data.get("timeout_seconds")
        try:
            timeout_seconds = int(raw_timeout)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            timeout_seconds = DEFAULT_APPROVAL_TIMEOUT
        timeout_seconds = max(
            5,
            min(timeout_seconds, MAX_APPROVAL_TIMEOUT),
        )

        request = ApprovalRequest(data, timeout_seconds)

        self.notify_server.bridge.log_received.emit(
            "notify",
            "收到审批请求："
            f"remote={remote}, tool={request.tool_name}, "
            f"kind={request.kind}, "
            f"project={request.project_name}, "
            f"suggestions={len(request.suggestions)}, "
            f"timeout={timeout_seconds}s",
        )

        # 可观测性：没见过的 suggestion 类型照渲染照 echo，
        # 但打 warn 让新版本协议变化第一时间可见
        unknown = unknown_suggestion_types(request.suggestions)
        if unknown:
            self.notify_server.bridge.log_received.emit(
                "warn",
                f"未知 suggestion 类型 {unknown}，将用通用标签显示并原样回传",
            )

        # 交给 GUI 线程弹窗，本线程挂起等待。终端先作答时，hook 会从
        # transcript 观察到对应 tool_result 并调用 resolved 端点；
        # 连接断开检测仅作为进程异常退出时的补充快速路径。
        self.notify_server.register_approval(request)
        self.notify_server.bridge.approval_received.emit(request)

        deadline = time.monotonic() + timeout_seconds + 5
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                if request.event.wait(min(0.5, remaining)):
                    break
                if self.client_gone():
                    if request.finish("cancelled"):
                        self.notify_server.bridge.approval_cancelled.emit(
                            request
                        )
                        self.notify_server.bridge.log_received.emit(
                            "info",
                            "审批客户端已断开，弹窗同步关闭："
                            f"request={request.request_id[:12]}, "
                            f"tool={request.tool_name}",
                        )
                    break
        finally:
            self.notify_server.unregister_approval(request)

        # finish() 总是先写 decision 再置 event，直接读 decision 即可
        decision = request.decision or "timeout"

        self.notify_server.bridge.log_received.emit(
            "notify" if decision in ("allow", "deny") else "warn",
            f"审批结果：tool={request.tool_name}, "
            f"decision={decision}",
        )

        response: dict[str, Any] = {
            "status": "ok",
            "decision": decision,
        }
        # suggestion → {"index": N}；answer → {"answers": [...]}
        response.update(request.extra)
        try:
            self.send_json(200, response)
        except OSError:
            pass  # 客户端（钩子进程）已被回收，响应无处投递属正常

    def log_message(
        self,
        format_string: str,
        *args: Any,
    ) -> None:
        self.notify_server.bridge.log_received.emit(
            "info",
            f"HTTP {self.client_address[0]} "
            f"{format_string % args}",
        )


# ============================================================================
# HTTP 线程
# ============================================================================

class ServerWorker(QObject):
    started = Signal()
    stopped = Signal()
    failed = Signal(str)

    def __init__(
        self,
        bridge: HttpEventBridge,
        token: str,
    ) -> None:
        super().__init__()

        self.bridge = bridge
        self.token = token
        self.server: Optional[ClaudeNotifyServer] = None

    @Slot()
    def run(self) -> None:
        try:
            self.server = ClaudeNotifyServer(
                (HOST, PORT),
                ClaudeNotifyHandler,
                self.bridge,
                self.token,
            )

            self.started.emit()
            self.server.serve_forever()

        except Exception:
            self.failed.emit(traceback.format_exc())

        finally:
            if self.server is not None:
                self.server.server_close()

            self.stopped.emit()

    @Slot()
    def stop(self) -> None:
        if self.server is not None:
            self.server.shutdown()

    def update_token(self, token: str) -> None:
        self.token = token

        if self.server is not None:
            self.server.update_token(token)


# ============================================================================
# 审批弹窗（无边框置顶小窗）
# ============================================================================

# 弹窗出现屏幕的策略
POPUP_SCREEN_MODES: dict[str, str] = {
    "primary": "主屏幕",
    "cursor": "鼠标所在屏幕",
    "focus": "焦点窗口所在屏幕",
}


def foreground_window_screen() -> Any:
    """
    Windows 实现：通过 Win32 获取前台窗口（任意应用）所在的屏幕。
    非 Windows 或获取失败时返回 None；跨平台调用请走 PLATFORM。
    """
    try:
        import ctypes
        import ctypes.wintypes as wintypes

        user32 = ctypes.windll.user32
    except (AttributeError, OSError):
        return None

    try:
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return None

        rect = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return None

        center_x = (rect.left + rect.right) // 2
        center_y = (rect.top + rect.bottom) // 2

        return QGuiApplication.screenAt(QPoint(center_x, center_y))
    except Exception:
        return None


# ============================================================================
# 平台服务外观（Strategy + Facade）：UI 只依赖 PLATFORM，不直接碰 Win32/macOS API
# ============================================================================

class PlatformServices:
    name = "generic"
    supports_focus_screen = False

    def __init__(self, secret_store: SecretStore) -> None:
        self.secret_store = secret_store

    def open_path(self, path: Path) -> bool:
        return False

    def foreground_window_screen(self) -> Any:
        return None

    def follow_active_space(self, window: Any) -> bool:
        """让窗口在切换桌面/工作区时保持可见（仅 macOS 需要实现）。"""
        return False

    def watch_active_space(self, window: Any) -> bool:
        """监听桌面/工作区切换（仅 macOS 需要实现）。"""
        return False


class WindowsServices(PlatformServices):
    name = "windows"
    supports_focus_screen = True

    def open_path(self, path: Path) -> bool:
        try:
            os.startfile(str(path))  # type: ignore[attr-defined]
            return True
        except (AttributeError, OSError):
            return False

    def foreground_window_screen(self) -> Any:
        return foreground_window_screen()


MAC_COLLECTION_CAN_JOIN_ALL_SPACES = 1 << 0
MAC_COLLECTION_MOVE_TO_ACTIVE_SPACE = 1 << 1
MAC_COLLECTION_FULL_SCREEN_AUXILIARY = 1 << 8


def mac_popup_collection_behavior(current: int) -> int:
    """保留 Qt 行为，同时让激活的弹窗迁入当前 Space。"""
    return (
        current & ~MAC_COLLECTION_CAN_JOIN_ALL_SPACES
    ) | (
        MAC_COLLECTION_MOVE_TO_ACTIVE_SPACE
        | MAC_COLLECTION_FULL_SCREEN_AUXILIARY
    )


_MAC_SPACE_CALLBACKS: dict[int, Any] = {}
_MAC_SPACE_OBSERVER_CLASS: Optional[int] = None
_MAC_SPACE_OBSERVER_IMP: Any = None


def _mac_space_notification_callback(
    observer: int,
    _selector: int,
    _notification: int,
) -> None:
    callback = _MAC_SPACE_CALLBACKS.get(int(observer))
    if callback is None:
        return
    try:
        callback()
    except Exception:
        traceback.print_exc()


class MacServices(PlatformServices):
    name = "macos"

    def __init__(self, secret_store: SecretStore) -> None:
        super().__init__(secret_store)
        self._space_observers: dict[int, tuple[Any, ...]] = {}

    def open_path(self, path: Path) -> bool:
        if shutil.which("open") is None:
            return False
        result = subprocess.run(
            ["open", str(path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return result.returncode == 0

    def follow_active_space(self, window: Any) -> bool:
        """
        macOS：让审批弹窗迁入当前 Space，并支持全屏应用所在 Space。
        可在首次 show 前预配置；窗口可见时会激活并迁移原生 NSWindow。
        通过 ctypes 调 Objective-C runtime，失败静默（不影响弹窗本身）。
        """
        app = QGuiApplication.instance()
        if app is None or app.platformName().lower() != "cocoa":
            # offscreen 等 Qt 后端的 winId() 可能只是占位值（例如 1），
            # 不能把它作为 Objective-C 对象指针传给 objc_msgSend。
            return False

        try:
            import ctypes

            objc = ctypes.CDLL("/usr/lib/libobjc.dylib")
            objc.sel_registerName.restype = ctypes.c_void_p
            objc.sel_registerName.argtypes = [ctypes.c_char_p]
            objc.objc_getClass.restype = ctypes.c_void_p
            objc.objc_getClass.argtypes = [ctypes.c_char_p]
            # winId() 返回 NSView*，取其 window 得 NSWindow*
            view = ctypes.c_void_p(int(window.winId()))
            objc.objc_msgSend.restype = ctypes.c_void_p
            objc.objc_msgSend.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
            ns_window = objc.objc_msgSend(
                view, objc.sel_registerName(b"window")
            )
            if not ns_window:
                return False

            # MoveToActiveSpace 与 CanJoinAllSpaces 互斥。静态加入所有
            # Spaces 在部分 Qt/macOS 组合上不会随切换刷新，因此改为
            # 收到 Space 通知后主动激活并迁移窗口。
            objc.objc_msgSend.restype = ctypes.c_ulonglong
            objc.objc_msgSend.argtypes = [
                ctypes.c_void_p,
                ctypes.c_void_p,
            ]
            current = int(
                objc.objc_msgSend(
                    ns_window,
                    objc.sel_registerName(b"collectionBehavior"),
                )
            )
            behavior = mac_popup_collection_behavior(current)

            objc.objc_msgSend.restype = None
            objc.objc_msgSend.argtypes = [
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_ulonglong,
            ]
            objc.objc_msgSend(
                ns_window,
                objc.sel_registerName(b"setCollectionBehavior:"),
                behavior,
            )

            # Qt.Tool 在应用失焦时可能隐藏；权限提示必须继续可见。
            objc.objc_msgSend.argtypes = [
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_bool,
            ]
            objc.objc_msgSend(
                ns_window,
                objc.sel_registerName(b"setHidesOnDeactivate:"),
                False,
            )

            # 构造阶段会在首次 show 前预配置 NSWindow，不能因此把隐藏
            # 窗口提前显示；showEvent 及 Space 通知才负责激活并迁移。
            if window.isVisible():
                ns_app_class = objc.objc_getClass(b"NSApplication")
                objc.objc_msgSend.restype = ctypes.c_void_p
                objc.objc_msgSend.argtypes = [
                    ctypes.c_void_p,
                    ctypes.c_void_p,
                ]
                ns_app = objc.objc_msgSend(
                    ns_app_class,
                    objc.sel_registerName(b"sharedApplication"),
                )
                objc.objc_msgSend.argtypes = [
                    ctypes.c_void_p,
                    ctypes.c_void_p,
                    ctypes.c_bool,
                ]
                objc.objc_msgSend(
                    ns_app,
                    objc.sel_registerName(b"activateIgnoringOtherApps:"),
                    True,
                )
                objc.objc_msgSend.argtypes = [
                    ctypes.c_void_p,
                    ctypes.c_void_p,
                    ctypes.c_void_p,
                ]
                objc.objc_msgSend(
                    ns_window,
                    objc.sel_registerName(b"makeKeyAndOrderFront:"),
                    None,
                )
            return True
        except Exception:
            return False

    def watch_active_space(self, window: Any) -> bool:
        """
        监听 NSWorkspaceActiveSpaceDidChangeNotification。Space 改变后，
        重新激活审批窗；配合 MoveToActiveSpace 将其迁入当前 Space。
        """
        app = QGuiApplication.instance()
        if app is None or app.platformName().lower() != "cocoa":
            return False

        key = id(window)
        if key in self._space_observers:
            return True

        try:
            import ctypes

            global _MAC_SPACE_OBSERVER_CLASS
            global _MAC_SPACE_OBSERVER_IMP

            objc = ctypes.CDLL("/usr/lib/libobjc.dylib")
            appkit = ctypes.CDLL(
                "/System/Library/Frameworks/AppKit.framework/AppKit"
            )
            objc.sel_registerName.restype = ctypes.c_void_p
            objc.sel_registerName.argtypes = [ctypes.c_char_p]
            objc.objc_getClass.restype = ctypes.c_void_p
            objc.objc_getClass.argtypes = [ctypes.c_char_p]

            if _MAC_SPACE_OBSERVER_CLASS is None:
                class_name = b"ClaudeNotifySpaceObserver"
                observer_class = objc.objc_getClass(class_name)
                if not observer_class:
                    superclass = objc.objc_getClass(b"NSObject")
                    objc.objc_allocateClassPair.restype = ctypes.c_void_p
                    objc.objc_allocateClassPair.argtypes = [
                        ctypes.c_void_p,
                        ctypes.c_char_p,
                        ctypes.c_size_t,
                    ]
                    observer_class = objc.objc_allocateClassPair(
                        superclass,
                        class_name,
                        0,
                    )
                    callback_type = ctypes.CFUNCTYPE(
                        None,
                        ctypes.c_void_p,
                        ctypes.c_void_p,
                        ctypes.c_void_p,
                    )
                    _MAC_SPACE_OBSERVER_IMP = callback_type(
                        _mac_space_notification_callback
                    )
                    objc.class_addMethod.restype = ctypes.c_bool
                    objc.class_addMethod.argtypes = [
                        ctypes.c_void_p,
                        ctypes.c_void_p,
                        ctypes.c_void_p,
                        ctypes.c_char_p,
                    ]
                    added = objc.class_addMethod(
                        observer_class,
                        objc.sel_registerName(
                            b"activeSpaceDidChange:"
                        ),
                        ctypes.cast(
                            _MAC_SPACE_OBSERVER_IMP,
                            ctypes.c_void_p,
                        ),
                        b"v@:@",
                    )
                    if not added:
                        return False
                    objc.objc_registerClassPair.argtypes = [
                        ctypes.c_void_p
                    ]
                    objc.objc_registerClassPair(observer_class)
                _MAC_SPACE_OBSERVER_CLASS = int(observer_class)

            objc.objc_msgSend.restype = ctypes.c_void_p
            objc.objc_msgSend.argtypes = [
                ctypes.c_void_p,
                ctypes.c_void_p,
            ]
            observer = objc.objc_msgSend(
                _MAC_SPACE_OBSERVER_CLASS,
                objc.sel_registerName(b"alloc"),
            )
            observer = objc.objc_msgSend(
                observer,
                objc.sel_registerName(b"init"),
            )
            workspace_class = objc.objc_getClass(b"NSWorkspace")
            workspace = objc.objc_msgSend(
                workspace_class,
                objc.sel_registerName(b"sharedWorkspace"),
            )
            center = objc.objc_msgSend(
                workspace,
                objc.sel_registerName(b"notificationCenter"),
            )
            notification_name = ctypes.c_void_p.in_dll(
                appkit,
                "NSWorkspaceActiveSpaceDidChangeNotification",
            ).value

            def on_space_change() -> None:
                if window.isVisible():
                    self.follow_active_space(window)

            _MAC_SPACE_CALLBACKS[int(observer)] = on_space_change
            objc.objc_msgSend.restype = None
            objc.objc_msgSend.argtypes = [
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_void_p,
            ]
            objc.objc_msgSend(
                center,
                objc.sel_registerName(
                    b"addObserver:selector:name:object:"
                ),
                observer,
                objc.sel_registerName(b"activeSpaceDidChange:"),
                notification_name,
                workspace,
            )
            self._space_observers[key] = (
                objc,
                observer,
                center,
                notification_name,
                workspace,
            )
            window.destroyed.connect(
                lambda *_args, observer_key=key: self._stop_space_watch(
                    observer_key
                )
            )
            return True
        except Exception:
            return False

    def _stop_space_watch(self, key: int) -> None:
        import ctypes

        state = self._space_observers.pop(key, None)
        if state is None:
            return
        objc, observer, center, notification_name, workspace = state
        _MAC_SPACE_CALLBACKS.pop(int(observer), None)
        try:
            objc.objc_msgSend.restype = None
            objc.objc_msgSend.argtypes = [
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_void_p,
            ]
            objc.objc_msgSend(
                center,
                objc.sel_registerName(
                    b"removeObserver:name:object:"
                ),
                observer,
                notification_name,
                workspace,
            )
            objc.objc_msgSend.argtypes = [
                ctypes.c_void_p,
                ctypes.c_void_p,
            ]
            objc.objc_msgSend(
                observer,
                objc.sel_registerName(b"release"),
            )
        except Exception:
            pass


class LinuxServices(PlatformServices):
    name = "linux"

    def open_path(self, path: Path) -> bool:
        opener = shutil.which("xdg-open")
        if opener is None:
            return False
        result = subprocess.run(
            [opener, str(path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return result.returncode == 0


def create_platform_services() -> PlatformServices:
    if sys.platform == "win32":
        return WindowsServices(SECRET_STORE)
    if sys.platform == "darwin":
        return MacServices(SECRET_STORE)
    return LinuxServices(SECRET_STORE)


PLATFORM = create_platform_services()


def pick_popup_screen(mode: str) -> Any:
    """
    按策略选择弹窗目标屏幕，带回退链：
    focus → cursor → primary；cursor → primary。
    """
    if mode == "focus":
        screen = PLATFORM.foreground_window_screen()
        if screen is not None:
            return screen
        mode = "cursor"  # 回退：焦点窗口获取失败时跟随鼠标

    if mode == "cursor":
        screen = QGuiApplication.screenAt(QCursor.pos())
        if screen is not None:
            return screen

    return QGuiApplication.primaryScreen()


class OptionRow(QFrame):
    """
    选项行：标题 + 可选描述小字，可点击、可勾选。
    用于 AskUserQuestion 选项与自由输入入口——QPushButton 单行文本
    无法表达「label + description」两行结构，所以用 QFrame 自绘。
    """

    clicked = Signal()

    def __init__(
        self,
        label: str,
        description: str = "",
        parent: Optional[QWidget] = None,
    ) -> None:
        super().__init__(parent)
        self.setObjectName("optionRow")
        self.setProperty("checked", False)
        self.setCursor(Qt.PointingHandCursor)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 8, 12, 8)
        layout.setSpacing(2)

        title = QLabel(label)
        title.setObjectName("optionRowTitle")
        title.setWordWrap(True)
        layout.addWidget(title)

        if description:
            desc = QLabel(description)
            desc.setObjectName("optionRowDesc")
            desc.setWordWrap(True)
            layout.addWidget(desc)

    def isChecked(self) -> bool:
        return bool(self.property("checked"))

    def setChecked(self, checked: bool) -> None:
        self.setProperty("checked", checked)
        self.style().unpolish(self)
        self.style().polish(self)

    def mouseReleaseEvent(self, event) -> None:
        if event.button() == Qt.LeftButton:
            self.clicked.emit()
        super().mouseReleaseEvent(event)


class ApprovalPopup(QWidget):
    decided = Signal(object, str)  # ApprovalRequest, decision_id
    expired = Signal(object)  # ApprovalRequest
    acknowledged = Signal(object)  # ApprovalRequest

    def __init__(
        self,
        request: ApprovalRequest,
        queued_count: int = 0,
        screen_mode: str = "primary",
    ) -> None:
        super().__init__(
            None,
            Qt.FramelessWindowHint
            | Qt.WindowStaysOnTopHint
            | Qt.Tool,
        )

        self.request = request
        self.remaining_ms = request.timeout_seconds * 1000
        self.expired_mode = False
        self.drag_position = QPoint()
        self.screen_mode = screen_mode

        self.setObjectName("approvalPopupRoot")
        self.setAttribute(Qt.WA_DeleteOnClose)
        # 透明背景：否则无边框窗口的圆角外会露出黑色直角
        self.setAttribute(Qt.WA_TranslucentBackground)
        # 应用模态：服务器端测试时部署对话框是模态的，
        # 弹窗必须也是模态才能压在它之上接收鼠标输入
        self.setWindowModality(Qt.ApplicationModal)
        self.setFixedWidth(500)
        self.setAccessibleName("权限审批弹窗")

        self.build_ui(request, queued_count)
        self.move_to_corner()

        # macOS 必须在 NSWindow 第一次显示、被归入当前 Space 之前设置
        # collectionBehavior。showEvent 中还会再次配置，以防 Qt 在显示
        # 过程中重建或调整原生窗口。
        PLATFORM.follow_active_space(self)
        PLATFORM.watch_active_space(self)

        # 倒计时
        self.countdown_timer = QTimer(self)
        self.countdown_timer.setInterval(100)
        self.countdown_timer.timeout.connect(self.tick)
        self.countdown_timer.start()

        # 提示音 + 闪烁提醒
        QApplication.beep()

    def build_ui(
        self,
        request: ApprovalRequest,
        queued_count: int,
    ) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)

        card = QFrame()
        card.setObjectName("approvalCard")

        layout = QVBoxLayout(card)
        layout.setContentsMargins(16, 12, 16, 14)
        layout.setSpacing(8)

        is_question = request.kind == "question"
        self.allow_button = None

        # ---- 顶部：紧急度标记 + 关闭 ----
        kicker_row = QHBoxLayout()
        kicker = QLabel(
            "QUESTION FROM CLAUDE" if is_question else "PERMISSION REQUIRED"
        )
        kicker.setObjectName("approvalKicker")
        kicker_row.addWidget(kicker)

        if queued_count > 0:
            queued = QLabel(f"还有 {queued_count} 条")
            queued.setObjectName("approvalProject")
            kicker_row.addWidget(queued)

        kicker_row.addStretch()

        close_button = QPushButton("✕")
        close_button.setObjectName("popupClose")
        close_button.setToolTip("关闭（交给终端处理）")
        close_button.setAccessibleName("关闭审批弹窗")
        close_button.clicked.connect(
            lambda: self.decide("dismissed")
        )
        kicker_row.addWidget(close_button)
        layout.addLayout(kicker_row)

        title = QLabel(
            "Claude 想问你一个问题" if is_question else "Claude 请求执行权限"
        )
        title.setObjectName("approvalTitle")
        layout.addWidget(title)

        desc = QLabel(
            "选择选项作答 · Esc 交给终端；超时未处理将自动返回终端。"
            if is_question
            else "Enter 允许 · Esc 交给终端；超时未处理将自动返回终端。"
        )
        desc.setObjectName("approvalDesc")
        layout.addWidget(desc)

        # ---- 项目 + 工具 ----
        meta_row = QHBoxLayout()

        project = QLabel(f"项目：{request.project_name}")
        project.setObjectName("approvalProject")
        meta_row.addWidget(project)
        meta_row.addStretch()

        tool_badge = QLabel(request.tool_name)
        tool_badge.setObjectName("toolBadge")
        meta_row.addWidget(tool_badge)

        layout.addLayout(meta_row)

        # ---- 消息（提问场景即问题文本） ----
        message = QLabel(request.message)
        message.setObjectName("approvalMessage")
        message.setWordWrap(True)
        layout.addWidget(message)

        # ---- 工具调用详情（提问场景不展示 JSON） ----
        detail_text = "" if is_question else request.detail
        if detail_text:
            detail = QTextEdit()
            detail.setObjectName("approvalDetail")
            detail.setReadOnly(True)
            detail.setPlainText(detail_text)
            detail.setMaximumHeight(160)
            layout.addWidget(detail)

        # ---- 倒计时 ----
        countdown_row = QHBoxLayout()

        self.countdown_bar = QProgressBar()
        self.countdown_bar.setObjectName("countdownBar")
        self.countdown_bar.setRange(0, self.remaining_ms)
        self.countdown_bar.setValue(self.remaining_ms)
        self.countdown_bar.setTextVisible(False)
        countdown_row.addWidget(self.countdown_bar, stretch=1)

        self.countdown_label = QLabel(
            f"{request.timeout_seconds}s"
        )
        self.countdown_label.setObjectName("countdownLabel")
        countdown_row.addWidget(self.countdown_label)

        layout.addLayout(countdown_row)

        # ---- 已回退提示（默认隐藏，超时后显示在按钮正上方） ----
        self.expired_hint = QLabel(
            "这条审批不会再由弹窗提交。\n"
            "请在 Claude 终端继续处理，确认后点击下方「我知道了」关闭。"
        )
        self.expired_hint.setObjectName("expiredHint")
        self.expired_hint.setWordWrap(True)
        self.expired_hint.setVisible(False)
        layout.addWidget(self.expired_hint)

        # ---- 决策区：按场景分流 ----
        if is_question:
            self.build_question_options(layout, request)
        else:
            self.build_permission_options(layout, request)

        outer.addWidget(card)

        if self.allow_button is not None:
            self.allow_button.setFocus()

    # ------------------------------------------------------------------
    # 权限审批：基础按钮 + Claude 提供的「始终允许」建议
    # ------------------------------------------------------------------

    def build_permission_options(
        self,
        layout: QVBoxLayout,
        request: ApprovalRequest,
    ) -> None:
        options = request.options
        has_suggestions = bool(request.suggestions)

        if not has_suggestions:
            buttons = [
                self.make_permission_button(option)
                for option in options
            ]

            if len(buttons) <= 2:
                # 1–2 项：等宽横排，保留常见允许/拒绝的快速扫视。
                button_row = QHBoxLayout()
                button_row.setSpacing(8)
                for button in buttons:
                    button_row.addWidget(button, stretch=1)
                layout.addLayout(button_row)
            else:
                # 3–6 项：全宽纵排。macOS 原生按钮有额外阴影和最小
                # 宽度，继续横排会与相邻按钮发生视觉重叠。
                for button in buttons:
                    layout.addWidget(button)

            self.add_terminal_footer(layout)
            return

        # 有建议时，顺序与终端权限对话框一致且全部整行等宽：
        # 允许 → 始终允许建议 → 拒绝 →（交给终端降为底部小链接）
        allow_option = next(
            (o for o in options if o["id"] == "allow"), None
        )

        # ---- 允许（整行主按钮，对齐终端的 yes） ----
        if allow_option is not None:
            allow_button = QPushButton(allow_option["label"])
            allow_button.setObjectName("approveAllow")
            allow_button.setDefault(True)
            allow_button.setAutoDefault(True)
            allow_button.setAccessibleName(
                f"审批选项：{allow_option['label']}"
            )
            allow_button.clicked.connect(
                lambda checked=False: self.decide("allow")
            )
            self.allow_button = allow_button
            layout.addWidget(allow_button)

        # ---- 「始终允许」类选项（permission_suggestions，不透明 echo） ----
        # 对象去重在 ApprovalRequest.suggestions 已做；
        # 这里再按显示标签去重——不同对象可能渲染出相同文案
        seen_labels: set[str] = set()
        for index, suggestion in enumerate(request.suggestions):
            label = describe_suggestion(suggestion)
            if label in seen_labels:
                continue
            seen_labels.add(label)
            button = QPushButton(label)
            button.setObjectName("suggestionButton")
            button.setToolTip(
                "等价于终端权限对话框中的对应选项；原始规则：\n"
                + json.dumps(suggestion, ensure_ascii=False)
            )
            button.setAccessibleName(f"权限建议：{label}")
            button.clicked.connect(
                lambda checked=False, i=index: self.decide(
                    "suggestion", {"index": i}
                )
            )
            layout.addWidget(button)

        # ---- 拒绝 / 其他自定义选项（同样整行） ----
        for option in options:
            if option["id"] == "allow":
                continue  # 已在顶部渲染
            button = QPushButton(option["label"])
            button.setAccessibleName(f"审批选项：{option['label']}")
            if option["id"] == "deny":
                button.setObjectName("approveDeny")

            decision_id = option["id"]
            button.clicked.connect(
                lambda checked=False, d=decision_id: self.decide(d)
            )
            layout.addWidget(button)

        # ---- 交给终端：底部右对齐小链接，不与决策按钮抢视觉 ----
        self.add_terminal_footer(layout)

    def make_permission_button(
        self,
        option: dict[str, str],
    ) -> QPushButton:
        button = QPushButton(option["label"])
        button.setAccessibleName(f"审批选项：{option['label']}")
        if option["id"] == "allow":
            button.setObjectName("approveAllow")
            button.setDefault(True)
            button.setAutoDefault(True)
            self.allow_button = button
        elif option["id"] == "deny":
            button.setObjectName("approveDeny")

        decision_id = option["id"]
        button.clicked.connect(
            lambda checked=False, d=decision_id: self.decide(d)
        )
        return button

    def add_terminal_footer(self, layout: QVBoxLayout) -> None:
        footer_row = QHBoxLayout()
        footer_row.addStretch()
        footer_row.addWidget(self.make_terminal_button())
        layout.addLayout(footer_row)

    # ------------------------------------------------------------------
    # AskUserQuestion：选项行 + 自由输入 + 多选
    # ------------------------------------------------------------------

    def build_question_options(
        self,
        layout: QVBoxLayout,
        request: ApprovalRequest,
    ) -> None:
        questions = request.questions or [{}]
        multi_question = len(questions) > 1

        # 单问题 + 单选：点选项立即提交（快速路径）；
        # 多问题或多选：勾选后点「确认回答」
        first = questions[0] if questions else {}
        self.fast_path_question = (
            not multi_question and not bool(first.get("multiSelect"))
        )

        self.question_state: list[dict[str, Any]] = []

        scroll = QScrollArea()
        scroll.setObjectName("optionScroll")
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        scroll.setMaximumHeight(320)

        container = QWidget()
        container.setObjectName("optionContainer")
        box = QVBoxLayout(container)
        box.setContentsMargins(0, 0, 4, 0)
        box.setSpacing(6)

        for qi, question in enumerate(questions):
            qtext = str(question.get("question") or request.message)
            multi = bool(question.get("multiSelect"))
            raw_options = question.get("options")
            options = (
                [o for o in raw_options if isinstance(o, dict)][:8]
                if isinstance(raw_options, list)
                else []
            )

            if multi_question:
                q_label = QLabel(f"问题 {qi + 1}：{qtext}")
                q_label.setObjectName("approvalMessage")
                q_label.setWordWrap(True)
                box.addWidget(q_label)

            state: dict[str, Any] = {
                "question": qtext,
                "multi": multi,
                "rows": [],
                "other_edit": None,
            }

            for opt in options:
                label = str(opt.get("label") or "?")
                description = str(opt.get("description") or "")
                row = OptionRow(label, description)
                row.setProperty("optLabel", label)
                row.setAccessibleName(f"选项：{label}")
                row.clicked.connect(
                    lambda s=state, r=row: self.on_question_row(s, r)
                )
                state["rows"].append((row, label))
                box.addWidget(row)

            # ---- 其他（自由输入） ----
            other_edit = QLineEdit()
            other_edit.setObjectName("approvalInput")
            other_edit.setPlaceholderText("其他：输入你自己的回答，Enter 确认")
            other_edit.setVisible(False)
            state["other_edit"] = other_edit

            other_toggle = QPushButton("其他（自己输入）…")
            other_toggle.setObjectName("otherToggle")
            other_toggle.clicked.connect(
                lambda checked=False, e=other_edit: self.toggle_other(e)
            )
            box.addWidget(other_toggle)
            box.addWidget(other_edit)

            other_edit.returnPressed.connect(self.submit_answers)

            self.question_state.append(state)

        # 滚动区只有内容超高时才占高度
        scroll.setWidget(container)
        layout.addWidget(scroll)

        # ---- 底部：确认回答（非快速路径）+ 交给终端 ----
        bottom_row = QHBoxLayout()
        bottom_row.setSpacing(8)

        self.confirm_button = QPushButton("确认回答")
        self.confirm_button.setObjectName("confirmButton")
        self.confirm_button.setAccessibleName("确认回答")
        self.confirm_button.clicked.connect(self.submit_answers)
        self.confirm_button.setVisible(not self.fast_path_question)
        bottom_row.addWidget(self.confirm_button)

        bottom_row.addStretch()
        bottom_row.addWidget(self.make_terminal_button())
        layout.addLayout(bottom_row)

    def make_terminal_button(self) -> QPushButton:
        self.terminal_button = QPushButton("交给终端")
        self.terminal_button.setObjectName("approveTerminal")
        self.terminal_button.setToolTip("不做决定，回到终端正常提示")
        self.terminal_button.setAccessibleName("交给终端处理")
        self.terminal_button.clicked.connect(
            lambda: self.decide("ask")
        )
        return self.terminal_button

    def toggle_other(self, edit: QLineEdit) -> None:
        edit.setVisible(not edit.isVisible())
        if edit.isVisible():
            edit.setFocus()
        self.move_to_corner()

    def on_question_row(
        self,
        state: dict[str, Any],
        row: OptionRow,
    ) -> None:
        if self.fast_path_question:
            # 单问题单选：点击即提交
            label = str(row.property("optLabel") or "")
            self.decide(
                "answer",
                {
                    "answers": [
                        {
                            "question": state["question"],
                            "selected": [label],
                            "text": "",
                        }
                    ]
                },
            )
            return

        if state["multi"]:
            row.setChecked(not row.isChecked())
        else:
            # 组内单选互斥
            for r, _label in state["rows"]:
                r.setChecked(r is row)

    def submit_answers(self) -> None:
        answers: list[dict[str, Any]] = []
        for state in self.question_state:
            selected = [
                label
                for row, label in state["rows"]
                if row.isChecked()
            ]
            edit = state.get("other_edit")
            text = edit.text().strip() if edit is not None else ""
            if selected or text:
                answers.append(
                    {
                        "question": state["question"],
                        "selected": selected,
                        "text": text,
                    }
                )

        if not answers:
            # 什么都没选/没填：闪烁提示，不提交空答案
            QApplication.beep()
            return

        self.decide("answer", {"answers": answers})

    def move_to_corner(self) -> None:
        self.adjustSize()

        screen = pick_popup_screen(self.screen_mode)
        if screen is None:
            return

        geometry = screen.availableGeometry()
        x = geometry.right() - self.width() - 16
        y = geometry.bottom() - self.height() - 16
        self.move(x, y)

    def showEvent(self, event: QShowEvent) -> None:
        super().showEvent(event)
        # winId()/NSWindow 在 showEvent 后才稳定可用。每次重新显示都
        # 幂等配置，以便弹窗出现在用户当前使用的 Space。
        QTimer.singleShot(
            0,
            lambda: PLATFORM.follow_active_space(self),
        )

    # ------------------------------------------------------------------
    # 倒计时
    # ------------------------------------------------------------------

    def tick(self) -> None:
        self.remaining_ms -= 100

        if self.remaining_ms <= 0:
            self.mark_expired()
            self.expired.emit(self.request)
            return

        self.countdown_bar.setValue(self.remaining_ms)
        self.countdown_label.setText(
            f"{self.remaining_ms // 1000}s"
        )

    # ------------------------------------------------------------------
    # 决定
    # ------------------------------------------------------------------

    def mark_expired(self) -> None:
        if self.expired_mode:
            return
        self.expired_mode = True
        self.countdown_timer.stop()
        self.countdown_bar.setValue(0)
        self.countdown_bar.setProperty("expired", True)
        self.countdown_label.setText("已回退终端")

        for label in self.findChildren(QLabel):
            name = label.objectName()
            if name in {"approvalKicker", "approvalTitle", "approvalDesc"}:
                label.setProperty("expired", True)
                label.style().unpolish(label)
                label.style().polish(label)
            if name == "approvalKicker":
                label.setText("RETURNED TO TERMINAL")
            elif name == "approvalTitle":
                label.setText("审批已回退终端")
            elif name == "approvalDesc":
                label.setText("超时未处理，弹窗已不再提交决定。")

        # 提示放到「我知道了」正上方，比顶部描述更醒目
        self.expired_hint.setVisible(True)

        # 所有决策控件失效：基础按钮 / suggestion / 确认回答 / 其他输入
        for button in self.findChildren(QPushButton):
            name = button.objectName()
            if name in {
                "approveAllow",
                "approveDeny",
                "suggestionButton",
                "confirmButton",
                "otherToggle",
            }:
                # 置灰并取消 coral/danger 重点色，换中性样式
                button.setObjectName("approveDisabled")
                button.setEnabled(False)
                button.setDefault(False)
                button.setAutoDefault(False)
                button.style().unpolish(button)
                button.style().polish(button)

        for row in self.findChildren(OptionRow):
            row.setEnabled(False)
            # Qt QSS 怪癖：`QFrame#x:disabled QLabel` 会无视伪状态恒命中；
            # 祖先属性选择器也不会级联刷新后代，文字置灰直接打在标签上
            row.setProperty("expired", True)
            row.style().unpolish(row)
            row.style().polish(row)
            for label in row.findChildren(QLabel):
                label.setProperty("expired", True)
                label.style().unpolish(label)
                label.style().polish(label)
        for edit in self.findChildren(QLineEdit):
            edit.setEnabled(False)

        # 「我知道了」升级为 coral 主按钮，视觉焦点移到唯一可操作项
        self.terminal_button.setObjectName("primaryButton")
        self.terminal_button.setText("我知道了")
        self.terminal_button.setToolTip("确认已知晓该审批已回退终端")
        self.terminal_button.setAccessibleName("我知道了，关闭弹窗")
        self.terminal_button.setDefault(True)
        self.terminal_button.setAutoDefault(True)
        self.terminal_button.style().unpolish(self.terminal_button)
        self.terminal_button.style().polish(self.terminal_button)
        self.terminal_button.setFocus()

        self.countdown_bar.style().unpolish(self.countdown_bar)
        self.countdown_bar.style().polish(self.countdown_bar)

        # 提示出现后高度变化，重新贴回屏幕角落
        self.move_to_corner()

    def decide(
        self,
        decision_id: str,
        extra: Optional[dict[str, Any]] = None,
    ) -> None:
        if self.expired_mode:
            if decision_id in {"ask", "dismissed", "timeout"}:
                self.acknowledged.emit(self.request)
                self.close()
            return

        self.countdown_timer.stop()
        if extra is not None:
            # suggestion → {"index": N}；answer → {"answers": [...]}
            self.request.extra = extra
        self.decided.emit(self.request, decision_id)
        self.close()

    # ------------------------------------------------------------------
    # 键盘
    # ------------------------------------------------------------------

    def keyPressEvent(self, event) -> None:
        if event.key() == Qt.Key_Escape:
            self.decide("ask")
            return
        super().keyPressEvent(event)

    # ------------------------------------------------------------------
    # 拖拽移动
    # ------------------------------------------------------------------

    def mousePressEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.LeftButton:
            self.drag_position = (
                event.globalPosition().toPoint()
                - self.frameGeometry().topLeft()
            )
            event.accept()

    def mouseMoveEvent(self, event: QMouseEvent) -> None:
        if event.buttons() & Qt.LeftButton:
            self.move(
                event.globalPosition().toPoint()
                - self.drag_position
            )
            event.accept()


# ============================================================================
# 服务器部署线程
# ============================================================================

class DeployWorker(QObject):
    progress = Signal(str, str)  # level, message
    finished = Signal(bool, str)  # success, summary

    def __init__(self, config: dict[str, Any]) -> None:
        super().__init__()
        self.config = config

    def log(self, message: str, level: str = "info") -> None:
        self.progress.emit(level, message)

    @Slot()
    def run(self) -> None:
        try:
            self.deploy()
        except Exception as exc:
            self.log(f"部署失败：{exc}", "error")
            self.finished.emit(False, str(exc))

    def deploy(self) -> None:
        try:
            import paramiko
        except ImportError:
            raise RuntimeError(
                "缺少 paramiko 依赖，请先执行：pip install paramiko"
            )

        cfg = self.config
        host = cfg["host"]
        port = cfg["ssh_port"]
        username = cfg["username"]

        # ---- 1. 建立 SSH 连接 ----
        self.log(f"连接服务器 {username}@{host}:{port} …")

        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(
            paramiko.AutoAddPolicy()
        )

        connect_kwargs: dict[str, Any] = {
            "hostname": host,
            "port": port,
            "username": username,
            "timeout": 15,
            "banner_timeout": 15,
            "auth_timeout": 15,
        }

        if cfg["auth_method"] == "password":
            connect_kwargs["password"] = cfg["password"]
        else:
            connect_kwargs["key_filename"] = cfg["key_path"]
            if cfg["key_passphrase"]:
                connect_kwargs["passphrase"] = cfg["key_passphrase"]

        client.connect(**connect_kwargs)
        self.log("SSH 连接成功")

        try:
            self.deploy_via_ssh(client)
        finally:
            client.close()

    def deploy_via_ssh(self, client: Any) -> None:
        cfg = self.config

        def exec_cmd(
            command: str,
            timeout: int = 30,
        ) -> tuple[int, str, str]:
            _, stdout, stderr = client.exec_command(
                command,
                timeout=timeout,
            )
            out = stdout.read().decode("utf-8", "replace")
            err = stderr.read().decode("utf-8", "replace")
            return stdout.channel.recv_exit_status(), out, err

        # ---- 2. 解析 HOME 并创建目录 ----
        code, home, _ = exec_cmd("echo $HOME")
        home = home.strip()
        if code != 0 or not home:
            raise RuntimeError("无法获取服务器上的 $HOME")

        claude_dir = f"{home}/.claude"
        self.log(f"创建目录 {claude_dir}")
        exec_cmd(f"mkdir -p {claude_dir} && chmod 700 {claude_dir}")

        # ---- 3. 上传所选模式的钩子脚本，删除未选模式的脚本 ----
        mode = cfg["mode"]  # popup | notify

        if mode == "popup":
            script_name = APPROVAL_SCRIPT_NAME
            removed_script = NOTIFY_SCRIPT_NAME
        else:
            script_name = NOTIFY_SCRIPT_NAME
            removed_script = APPROVAL_SCRIPT_NAME

        local_script = resource_path(script_name)
        if not local_script.exists():
            raise RuntimeError(
                f"找不到本地钩子脚本 {local_script}，"
                "请确认它与主程序放在同一目录"
            )

        script_content = local_script.read_text(encoding="utf-8")
        remote_script = f"{claude_dir}/{script_name}"

        mode_label = DEPLOY_MODES.get(mode, mode)
        self.log(f"通知方式：{mode_label}")
        self.log(f"上传钩子脚本 → {remote_script}")

        sftp = client.open_sftp()
        try:
            with sftp.open(remote_script, "w") as remote_file:
                remote_file.write(script_content)
            sftp.chmod(remote_script, 0o755)
        finally:
            sftp.close()

        # 删除未选择模式的脚本，避免残留
        exec_cmd(f"rm -f {claude_dir}/{removed_script}")

        # ---- 4. 备份并合并 settings.json ----
        settings_path = f"{claude_dir}/settings.json"
        code, existing, _ = exec_cmd(
            f"cat {settings_path} 2>/dev/null || true"
        )

        if existing.strip():
            backup_path = (
                f"{settings_path}.bak."
                f"{time.strftime('%Y%m%d-%H%M%S')}"
            )
            exec_cmd(f"cp {settings_path} {backup_path}")
            self.log(f"已备份现有配置 → {backup_path}")

        base_url = (
            f"http://{cfg['callback_ip']}:{cfg['callback_port']}"
        )

        if mode == "popup":
            env_pairs: dict[str, Any] = {
                "CLAUDE_NOTIFY_TOKEN": cfg["token"],
                "CLAUDE_APPROVAL_URL": f"{base_url}{APPROVAL_PATH}",
                "CLAUDE_STAGE_URL": f"{base_url}{STAGE_STATUS_PATH}",
                "CLAUDE_APPROVAL_TIMEOUT": cfg["approval_timeout"],
                # PreToolUse 记录 tool_use_id；AskUserQuestion 同时走代答
                "CLAUDE_ASKUSER_CHANNEL": "pretooluse",
            }
            if cfg["tool_matcher"]:
                env_pairs["CLAUDE_APPROVAL_MATCHER"] = (
                    cfg["tool_matcher"]
                )
        else:
            env_pairs = {
                "CLAUDE_NOTIFY_TOKEN": cfg["token"],
                "CLAUDE_NOTIFY_URL": f"{base_url}{NOTIFY_PATH}",
                "CLAUDE_STAGE_URL": f"{base_url}{STAGE_STATUS_PATH}",
            }

        hook_command = build_hook_command(env_pairs, script_name)

        self.log("合并钩子配置（清除未选模式的残留）…")
        merged = merge_settings_json(
            existing,
            mode=mode,
            hook_entry={"type": "command", "command": hook_command},
            hook_timeout=cfg["hook_timeout"],
            # 同一脚本按 hook_event_name 区分事件，代答钩子复用同一命令
            question_entry={"type": "command", "command": hook_command},
            stage_entry={"type": "command", "command": hook_command},
        )

        sftp = client.open_sftp()
        try:
            with sftp.open(settings_path, "w") as remote_file:
                remote_file.write(merged)
        finally:
            sftp.close()
        self.log(f"已写入 {settings_path}")

        # ---- 4.5 可选：把 Token 写入服务器 Shell 环境变量 ----
        env_shells = cfg.get("env_shells") or []
        if env_shells:
            self.apply_env_import(exec_cmd, home, env_shells)

        # ---- 5. 验证钩子脚本语法可执行 ----
        self.log("验证钩子脚本 …")
        code, _, err = exec_cmd(
            f"echo '{{}}' | timeout 10 "
            f"python3 {remote_script} >/dev/null 2>&1; "
            "echo $?"
        )
        if code != 0 or err.strip():
            self.log(
                f"钩子脚本验证异常（exit={code}）：{err.strip()[:200]}",
                "warn",
            )
        else:
            self.log("钩子脚本验证通过")

        # ---- 6. 测试服务器 → Windows 连通性 ----
        health_url = (
            f"http://{cfg['callback_ip']}:"
            f"{cfg['callback_port']}{HEALTH_PATH}"
        )
        self.log(f"测试服务器到本机的连通性 {health_url} …")
        code, out, err = exec_cmd(
            f"curl -s -m 5 {health_url} "
            "|| wget -q -T 5 -O- " + health_url,
            timeout=15,
        )

        if '"status": "ok"' in out or '"status":"ok"' in out:
            self.log("连通性测试通过 ✓", "notify")
            self.finished.emit(
                True,
                "部署完成！Claude Code 的权限审批将推送到本机。",
            )
        else:
            self.log(
                "连通性测试失败：服务器无法访问本机。"
                "请检查 Windows 防火墙是否放行端口 "
                f"{cfg['callback_port']}，以及回调 IP 是否正确。",
                "warn",
            )
            self.finished.emit(
                True,
                "部署已写入，但连通性测试未通过，请检查防火墙。",
            )

    def apply_env_import(
        self,
        exec_cmd: Any,
        home: str,
        env_shells: list[str],
    ) -> None:
        """
        把 CLAUDE_NOTIFY_TOKEN 以幂等标记块写入所选 shell 的 rc 文件。
        重复部署不会产生重复行。
        """
        token = self.config["token"]

        for shell in env_shells:
            info = SHELL_RC_FILES.get(shell)
            if info is None:
                continue

            display_name, rc_relative = info
            rc_file = f"{home}/{rc_relative}"
            block = build_env_block(shell, token)

            self.log(f"写入环境变量 → {rc_file}（{display_name}）")

            # 1) 确保父目录与文件存在  2) 备份一次
            # 3) sed 删除旧标记块  4) 追加新块
            quoted_block_lines = " ".join(
                f"'{line}'" for line in block.split("\n")
            )

            commands = [
                f"mkdir -p $(dirname {rc_file})",
                f"touch {rc_file}",
                f"cp {rc_file} {rc_file}.claude-notify-bak",
                (
                    f"sed -i '/{ENV_MARK_BEGIN}/,"
                    f"/{ENV_MARK_END}/d' {rc_file}"
                ),
                (
                    f"printf '%s\\n' {quoted_block_lines}"
                    f" >> {rc_file}"
                ),
            ]

            code, _, err = exec_cmd(" && ".join(commands))
            if code != 0:
                self.log(
                    f"写入 {rc_file} 失败：{err.strip()[:200]}",
                    "warn",
                )


# ============================================================================
# Shell 环境变量多选对话框
# ============================================================================

class EnvShellDialog(QDialog):
    """选择要把 Token 写入哪些 shell 的配置文件。"""

    def __init__(
        self,
        parent: QWidget,
        pre_checked: Optional[list[str]] = None,
    ) -> None:
        super().__init__(parent)

        self.setWindowTitle("选择 Shell")
        self.setModal(True)
        self.setMinimumWidth(320)

        layout = QVBoxLayout(self)
        layout.setSpacing(10)

        title = QLabel("将 CLAUDE_NOTIFY_TOKEN 写入以下 shell 的配置文件：")
        title.setWordWrap(True)
        layout.addWidget(title)

        self.checkboxes: dict[str, QCheckBox] = {}
        pre = set(pre_checked or ["bash"])

        for shell, (display_name, rc_path) in SHELL_RC_FILES.items():
            checkbox = QCheckBox(f"{display_name}（~/{rc_path}）")
            checkbox.setChecked(shell in pre)
            self.checkboxes[shell] = checkbox
            layout.addWidget(checkbox)

        button_row = QHBoxLayout()
        button_row.addStretch()

        ok_button = QPushButton("确定")
        cancel_button = QPushButton("取消")
        ok_button.clicked.connect(self.accept)
        cancel_button.clicked.connect(self.reject)

        button_row.addWidget(ok_button)
        button_row.addWidget(cancel_button)
        layout.addLayout(button_row)

    def selected_shells(self) -> list[str]:
        return [
            shell
            for shell, checkbox in self.checkboxes.items()
            if checkbox.isChecked()
        ]


# ============================================================================
# 服务器部署对话框
# ============================================================================

# ============================================================================
# 少量选项分段控件（兼容原下拉接口，避免原生弹层遮挡当前项）
# ============================================================================

class OptionSegment(QWidget):
    currentIndexChanged = Signal(int)

    def __init__(self) -> None:
        super().__init__()
        self._buttons: list[QPushButton] = []
        self._data: list[object] = []
        self._current_index = -1

        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(6)
        self._layout = layout

    def addItem(self, text: str, userData=None) -> None:
        # 重新排布时先去掉旧的 stretch，保证按钮在左、拉伸在右
        while self._layout.count() > len(self._buttons):
            item = self._layout.takeAt(self._layout.count() - 1)
            if item is not None:
                del item

        button = QPushButton(text)
        button.setObjectName("tab")
        button.setCheckable(True)
        button.setMinimumHeight(34)

        index = len(self._buttons)
        button.clicked.connect(
            lambda checked=False, i=index: self.setCurrentIndex(i)
        )
        self._buttons.append(button)
        self._data.append(userData)
        self._layout.addWidget(button)
        self._layout.addStretch(1)

        if self._current_index == -1:
            self._set_current(0, emit=False)

    def addItems(self, texts: list[str]) -> None:
        for text in texts:
            self.addItem(text)

    def count(self) -> int:
        return len(self._buttons)

    def currentIndex(self) -> int:
        return self._current_index

    def itemData(self, index: int):
        if 0 <= index < len(self._data):
            return self._data[index]
        return None

    def currentData(self):
        return self.itemData(self._current_index)

    def findData(self, data) -> int:
        try:
            return self._data.index(data)
        except ValueError:
            return -1

    def setCurrentIndex(self, index: int) -> None:
        self._set_current(index, emit=True)

    def _set_current(self, index: int, emit: bool) -> None:
        if not (0 <= index < len(self._buttons)):
            return
        changed = index != self._current_index
        self._current_index = index
        for i, button in enumerate(self._buttons):
            button.setChecked(i == index)
        if changed and emit:
            self.currentIndexChanged.emit(index)

    def setEnabled(self, enabled: bool) -> None:
        super().setEnabled(enabled)
        for button in self._buttons:
            button.setEnabled(enabled)


class LocalDeployDialog(QDialog):
    """本机 Claude Code 接入：选通知方式与是否写入环境变量。"""

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle("接入本机 Claude Code")
        self.setModal(True)
        self.setMinimumWidth(520)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(18, 16, 18, 16)
        layout.setSpacing(12)

        hint = QLabel(
            "把钩子脚本和 settings.json 写入本机 ~/.claude；"
            "回调地址固定为 http://127.0.0.1:18765。"
        )
        hint.setObjectName("hint")
        hint.setWordWrap(True)
        layout.addWidget(hint)

        mode_label = QLabel("通知方式")
        mode_label.setObjectName("fieldLabel")
        layout.addWidget(mode_label)
        self.mode_combo = OptionSegment()
        self.mode_combo.addItem(DEPLOY_MODES["popup"], "popup")
        self.mode_combo.addItem(DEPLOY_MODES["notify"], "notify")
        layout.addWidget(self.mode_combo)

        if sys.platform == "win32":
            env_text = "同时将 Token 写入用户环境变量（可选；钩子默认读配置文件，setx 仅供手动调试）"
        else:
            env_text = "同时将 Token 写入 shell 环境变量（bash/zsh/csh/fish，可选）"
        self.env_check = QCheckBox(env_text)
        self.env_check.setChecked(False)
        layout.addWidget(self.env_check)

        button_row = QHBoxLayout()
        button_row.addStretch()
        cancel_button = QPushButton("取消")
        ok_button = QPushButton("接入本机")
        ok_button.setObjectName("primaryButton")
        ok_button.setDefault(True)
        button_row.addWidget(cancel_button)
        button_row.addWidget(ok_button)
        layout.addLayout(button_row)

        cancel_button.clicked.connect(self.reject)
        ok_button.clicked.connect(self.accept)

    def mode(self) -> str:
        return str(self.mode_combo.currentData() or "popup")

    def write_env(self) -> bool:
        return self.env_check.isChecked()


class DeployDialog(QDialog):
    request_deploy = Signal()

    def __init__(
        self,
        parent: QWidget,
        token: str,
        callback_ip: str,
        callback_port: int,
    ) -> None:
        super().__init__(parent)

        self.token = token
        self.deploy_thread: Optional[QThread] = None
        self.deploy_worker: Optional[DeployWorker] = None
        self.cached_env_shells: list[str] = ["bash"]

        self.setWindowTitle("部署审批服务到服务器")
        self.setMinimumWidth(560)
        self.setModal(True)

        layout = QVBoxLayout(self)
        layout.setSpacing(12)

        # ---- 表单 ----
        form = QFormLayout()
        form.setSpacing(8)

        self.mode_combo = OptionSegment()
        self.mode_combo.addItem(DEPLOY_MODES["popup"], "popup")
        self.mode_combo.addItem(DEPLOY_MODES["notify"], "notify")

        self.host_edit = QLineEdit()
        self.host_edit.setPlaceholderText("例如 192.168.1.20 或 dev.example.com")

        self.ssh_port_edit = QLineEdit("22")

        self.username_edit = QLineEdit()
        self.username_edit.setPlaceholderText("SSH 登录用户名")

        self.auth_combo = OptionSegment()
        self.auth_combo.addItems(["密码认证", "私钥认证"])

        self.password_edit = QLineEdit()
        self.password_edit.setEchoMode(QLineEdit.Password)

        key_row = QHBoxLayout()
        self.key_path_edit = QLineEdit()
        self.key_path_edit.setPlaceholderText(
            "例如 C:\\Users\\you\\.ssh\\id_rsa"
        )
        self.browse_key_button = QPushButton("浏览…")
        self.browse_key_button.setObjectName("mini")
        self.browse_key_button.clicked.connect(self.browse_key)
        key_row.addWidget(self.key_path_edit, stretch=1)
        key_row.addWidget(self.browse_key_button)

        key_container = QWidget()
        key_container.setLayout(key_row)
        key_row.setContentsMargins(0, 0, 0, 0)

        self.key_passphrase_edit = QLineEdit()
        self.key_passphrase_edit.setEchoMode(QLineEdit.Password)
        self.key_passphrase_edit.setPlaceholderText("私钥密码（没有则留空）")

        self.callback_ip_edit = QLineEdit(callback_ip)
        self.callback_port_edit = QLineEdit(str(callback_port))

        self.hook_timeout_edit = QLineEdit("300")
        self.hook_timeout_edit.setToolTip(
            "Claude Code 等待钩子的最长秒数，"
            "审批等待时间会自动取该值减 60"
        )

        self.matcher_edit = QLineEdit()
        self.matcher_edit.setPlaceholderText(
            "留空 = 全部工具；多个用逗号分隔，如 Bash,Edit,Write"
        )

        # 表单控件统一尺寸：避免端口/超时等短输入框破坏对齐
        uniform_fields = [
            self.mode_combo,
            self.host_edit,
            self.ssh_port_edit,
            self.username_edit,
            self.auth_combo,
            self.password_edit,
            key_container,
            self.key_passphrase_edit,
            self.callback_ip_edit,
            self.callback_port_edit,
            self.hook_timeout_edit,
            self.matcher_edit,
        ]
        for field in uniform_fields:
            field.setMinimumWidth(420)
            field.setMinimumHeight(34)

        # ---- 可选功能 ----
        self.remember_password_check = QCheckBox(
            f"记住密码（{SECRET_STORE.label}）"
        )
        self.remember_password_check.setToolTip(
            f"使用当前平台的安全存储（{SECRET_STORE.label}）保存密码；"
            "缓存文件只保存密文或密钥库标记，服务器密码不以明文落盘。"
        )
        if not SECRET_STORE.available():
            self.remember_password_check.setEnabled(False)
            self.remember_password_check.setToolTip(
                "当前平台没有可用的本地安全存储，无法记住密码。"
            )

        self.env_import_check = QCheckBox(
            "将 Token 写入服务器 Shell 环境变量"
        )
        self.env_import_check.setToolTip(
            "部署时在所选 shell 的配置文件（如 ~/.bashrc）中"
            "追加 CLAUDE_NOTIFY_TOKEN 初始化块，"
            "带幂等标记，重复部署不会重复。"
        )

        form.addRow("通知方式：", self.mode_combo)
        form.addRow("服务器地址：", self.host_edit)
        form.addRow("SSH 端口：", self.ssh_port_edit)
        form.addRow("用户名：", self.username_edit)
        form.addRow("认证方式：", self.auth_combo)
        form.addRow("密码：", self.password_edit)
        form.addRow("私钥文件：", key_container)
        form.addRow("私钥密码：", self.key_passphrase_edit)
        form.addRow("回调 IP：", self.callback_ip_edit)
        form.addRow("回调端口：", self.callback_port_edit)
        form.addRow("审批超时(秒)：", self.hook_timeout_edit)
        form.addRow("工具过滤：", self.matcher_edit)
        form.addRow("可选项：", self.remember_password_check)
        form.addRow("", self.env_import_check)

        layout.addLayout(form)

        hint = QLabel(
            "回调 IP 是服务器访问本机的地址，已按本机当前 IP 预填；"
            "若服务器在其他网段请改成它可达的地址。"
        )
        hint.setObjectName("hint")
        hint.setWordWrap(True)
        layout.addWidget(hint)

        # ---- 部署日志 ----
        log_title = QLabel("部署过程")
        log_title.setObjectName("cardTitle")
        layout.addWidget(log_title)

        self.log_edit = QTextEdit()
        self.log_edit.setObjectName("log")
        self.log_edit.setReadOnly(True)
        self.log_edit.setMaximumHeight(160)
        layout.addWidget(self.log_edit)

        # ---- 按钮 ----
        button_row = QHBoxLayout()
        button_row.addStretch()

        self.server_test_button = QPushButton("服务器端测试")
        self.server_test_button.setToolTip(
            "在服务器上真实执行已部署的钩子脚本，"
            "端到端验证整条链路（会先检测部署状态）"
        )
        self.deploy_button = QPushButton("开始部署")
        self.close_button = QPushButton("关闭")

        button_row.addWidget(self.server_test_button)
        button_row.addWidget(self.deploy_button)
        button_row.addWidget(self.close_button)
        layout.addLayout(button_row)

        # ---- 信号 ----
        self.auth_combo.currentIndexChanged.connect(
            self.on_auth_changed
        )
        self.deploy_button.clicked.connect(self.start_deploy)
        self.server_test_button.clicked.connect(
            self.start_server_test
        )
        self.close_button.clicked.connect(self.reject)

        self.mode_combo.currentIndexChanged.connect(
            self.on_mode_changed
        )

        self.on_auth_changed(0)
        self.on_mode_changed(0)
        self.load_cached_config()

    def on_mode_changed(self, _index: int) -> None:
        """审批超时和工具过滤只在置顶弹窗模式下有意义。"""
        is_popup = self.mode_combo.currentData() == "popup"
        self.hook_timeout_edit.setEnabled(is_popup)
        self.matcher_edit.setEnabled(is_popup)

    # ------------------------------------------------------------------
    # 配置缓存（密码与私钥密码不缓存）
    # ------------------------------------------------------------------

    CACHEABLE_FIELDS = (
        "mode",
        "host",
        "ssh_port",
        "username",
        "auth_method",
        "key_path",
        "callback_ip",
        "callback_port",
        "hook_timeout",
        "tool_matcher",
        "remember_password",
        "env_import",
        "env_shells",
    )

    def load_cached_config(self) -> None:
        cache = load_deploy_cache()
        if not cache:
            return

        if cache.get("mode") in DEPLOY_MODES:
            index = self.mode_combo.findData(cache["mode"])
            if index >= 0:
                self.mode_combo.setCurrentIndex(index)

        if cache.get("host"):
            self.host_edit.setText(str(cache["host"]))
        if cache.get("ssh_port"):
            self.ssh_port_edit.setText(str(cache["ssh_port"]))
        if cache.get("username"):
            self.username_edit.setText(str(cache["username"]))
        if cache.get("auth_method") == "key":
            self.auth_combo.setCurrentIndex(1)
        if cache.get("key_path"):
            self.key_path_edit.setText(str(cache["key_path"]))
        if cache.get("callback_ip"):
            self.callback_ip_edit.setText(str(cache["callback_ip"]))
        if cache.get("callback_port"):
            self.callback_port_edit.setText(
                str(cache["callback_port"])
            )
        if cache.get("hook_timeout"):
            self.hook_timeout_edit.setText(
                str(cache["hook_timeout"])
            )
        if cache.get("tool_matcher"):
            self.matcher_edit.setText(str(cache["tool_matcher"]))

        # 记住密码：只有勾选过且存在密文时才尝试解密填充
        if cache.get("remember_password"):
            self.remember_password_check.setChecked(True)
            encrypted = cache.get("password_encrypted")
            if encrypted and SECRET_STORE.available():
                try:
                    self.password_edit.setText(
                        SECRET_STORE.decrypt_text(str(encrypted))
                    )
                except Exception:
                    pass  # 解密失败（如换了 Windows 用户）则留空

        if cache.get("env_import"):
            self.env_import_check.setChecked(True)

        cached_shells = cache.get("env_shells")
        if isinstance(cached_shells, list):
            self.cached_env_shells = [
                str(s) for s in cached_shells
            ]

    def save_cached_config(self, config: dict[str, Any]) -> None:
        """
        缓存非敏感字段。密码仅在勾选"记住密码"时写入当前平台
        安全存储（Windows DPAPI / macOS Keychain），明文与私钥密码绝不落盘。
        """
        cache: dict[str, Any] = {
            key: config[key]
            for key in self.CACHEABLE_FIELDS
            if key in config
        }

        if config.get("remember_password") and config.get("password"):
            try:
                cache["password_encrypted"] = SECRET_STORE.encrypt_text(
                    config["password"]
                )
            except Exception as exc:
                self.append_log(
                    "warn",
                    f"密码加密失败，本次不保存密码：{exc}",
                )
                cache["remember_password"] = False

        save_deploy_cache(cache)

    def browse_key(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self,
            "选择私钥文件",
            str(USER_HOME / ".ssh"),
        )
        if path:
            self.key_path_edit.setText(path)

    def on_auth_changed(self, index: int) -> None:
        use_password = index == 0
        self.password_edit.setEnabled(use_password)
        self.key_path_edit.setEnabled(not use_password)
        self.browse_key_button.setEnabled(not use_password)
        self.key_passphrase_edit.setEnabled(not use_password)
        # 记住密码只在密码认证模式下有意义
        self.remember_password_check.setEnabled(
            use_password and SECRET_STORE.available()
        )

    def append_log(self, level: str, message: str) -> None:
        timestamp = time.strftime("%H:%M:%S")
        color = LOG_COLORS.get(level, LOG_COLORS["info"])
        self.log_edit.append(
            f'<span style="color:#565d6b;">[{timestamp}]</span> '
            f'<span style="color:{color};">'
            f"{escape_html(message)}</span>"
        )
        scrollbar = self.log_edit.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())

    def validate_config(self) -> Optional[dict[str, Any]]:
        host = self.host_edit.text().strip()
        username = self.username_edit.text().strip()

        if not host:
            self.show_validation_error("请填写服务器地址")
            return None
        if not username:
            self.show_validation_error("请填写用户名")
            return None

        try:
            ssh_port = int(self.ssh_port_edit.text().strip())
            callback_port = int(
                self.callback_port_edit.text().strip()
            )
            hook_timeout = int(
                self.hook_timeout_edit.text().strip()
            )
        except ValueError:
            self.show_validation_error("端口和超时必须是数字")
            return None

        if hook_timeout < 70:
            self.show_validation_error("审批超时建议不小于 70 秒")
            return None

        use_password = self.auth_combo.currentIndex() == 0

        if use_password and not self.password_edit.text():
            self.show_validation_error("请输入密码")
            return None
        if not use_password and not self.key_path_edit.text().strip():
            self.show_validation_error("请选择私钥文件")
            return None

        return {
            "mode": self.mode_combo.currentData(),
            "host": host,
            "ssh_port": ssh_port,
            "username": username,
            "auth_method": (
                "password" if use_password else "key"
            ),
            "password": self.password_edit.text(),
            "key_path": self.key_path_edit.text().strip(),
            "key_passphrase": self.key_passphrase_edit.text(),
            "callback_ip": self.callback_ip_edit.text().strip(),
            "callback_port": callback_port,
            "hook_timeout": hook_timeout,
            "approval_timeout": hook_timeout - 60,
            "tool_matcher": self.matcher_edit.text().strip(),
            "remember_password": (
                self.remember_password_check.isChecked()
            ),
            "env_import": self.env_import_check.isChecked(),
            "env_shells": [],
            "token": self.token,
        }

    def show_validation_error(self, message: str) -> None:
        QMessageBox.warning(self, "配置不完整", message)

    def start_deploy(self) -> None:
        config = self.validate_config()
        if config is None:
            return

        # 勾选"写入环境变量"时先弹出 shell 多选
        if config["env_import"]:
            shell_dialog = EnvShellDialog(
                self,
                pre_checked=self.cached_env_shells,
            )
            if shell_dialog.exec() == QDialog.Accepted:
                selected = shell_dialog.selected_shells()
                if selected:
                    config["env_shells"] = selected
                    self.cached_env_shells = selected
                else:
                    config["env_import"] = False
            else:
                config["env_import"] = False

        # 校验通过后即缓存，下次打开自动填充
        # （密码仅在勾选"记住密码"时以 DPAPI 加密保存）
        self.save_cached_config(config)

        self.deploy_button.setEnabled(False)
        self.deploy_button.setText("部署中…")
        self.server_test_button.setEnabled(False)

        self.deploy_thread = QThread(self)
        self.deploy_worker = DeployWorker(config)
        self.deploy_worker.moveToThread(self.deploy_thread)

        self.deploy_thread.started.connect(
            self.deploy_worker.run
        )
        self.deploy_worker.progress.connect(self.append_log)
        self.deploy_worker.finished.connect(
            self.on_deploy_finished
        )
        self.deploy_worker.finished.connect(
            self.deploy_thread.quit
        )
        self.deploy_thread.finished.connect(
            self.deploy_thread.deleteLater
        )

        self.deploy_thread.start()

    def start_server_test(self) -> None:
        """服务器端测试：按当前选择的通知方式执行对应钩子。"""
        config = self.validate_config()
        if config is None:
            return

        self.save_cached_config(config)

        test_config = dict(config)
        test_config["test_type"] = (
            "approval" if config["mode"] == "popup" else "notify"
        )

        self.set_buttons_busy(True, "测试中…")

        self.test_thread = QThread(self)
        self.test_worker = ServerTestWorker(test_config)
        self.test_worker.moveToThread(self.test_thread)

        self.test_thread.started.connect(self.test_worker.run)
        self.test_worker.progress.connect(self.append_log)
        self.test_worker.not_deployed.connect(
            self.on_test_not_deployed
        )
        self.test_worker.finished.connect(self.on_test_finished)
        self.test_worker.finished.connect(self.test_thread.quit)
        self.test_thread.finished.connect(
            self.test_thread.deleteLater
        )

        self.test_thread.start()

    def set_buttons_busy(self, busy: bool, text: str = "") -> None:
        self.deploy_button.setEnabled(not busy)
        self.server_test_button.setEnabled(not busy)
        self.server_test_button.setText(
            text if busy else "服务器端测试"
        )

    @Slot(str)
    def on_test_not_deployed(self, detail: str) -> None:
        QMessageBox.warning(
            self,
            "尚未部署",
            f"检测到服务器侧未部署完成（缺少：{detail}）。\n\n"
            "请先点击「开始部署」完成配置，再执行服务器端测试。",
        )

    @Slot(bool, str)
    def on_test_finished(self, success: bool, summary: str) -> None:
        self.set_buttons_busy(False)
        self.deploy_button.setText("开始部署")
        self.append_log("notify" if success else "error", summary)

    @Slot(bool, str)
    def on_deploy_finished(
        self,
        success: bool,
        summary: str,
    ) -> None:
        self.deploy_button.setEnabled(True)
        self.deploy_button.setText("开始部署")
        self.server_test_button.setEnabled(True)

        self.append_log(
            "notify" if success else "error",
            summary,
        )

        if success:
            self.show_toast_parent(summary)

    def show_toast_parent(self, message: str) -> None:
        parent = self.parent()
        if isinstance(parent, MainWindow):
            parent.show_toast(message)


# ============================================================================
# 服务器端测试（SSH 远程执行已部署的钩子脚本，端到端验证）
# ============================================================================

class ServerTestWorker(QObject):
    progress = Signal(str, str)  # level, message
    finished = Signal(bool, str)  # success, summary
    not_deployed = Signal(str)  # 缺失项描述（服务器尚未部署完成）

    def __init__(self, config: dict[str, Any]) -> None:
        super().__init__()
        self.config = config

    def log(self, message: str, level: str = "info") -> None:
        self.progress.emit(level, message)

    @Slot()
    def run(self) -> None:
        try:
            self.execute()
        except Exception as exc:
            self.log(f"测试失败：{exc}", "error")
            self.finished.emit(False, str(exc))

    def execute(self) -> None:
        try:
            import paramiko
        except ImportError:
            raise RuntimeError(
                "缺少 paramiko 依赖，请先执行：pip install paramiko"
            )

        cfg = self.config

        self.log(
            f"连接服务器 {cfg['username']}@{cfg['host']}"
            f":{cfg['ssh_port']} …"
        )

        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(
            paramiko.AutoAddPolicy()
        )

        connect_kwargs: dict[str, Any] = {
            "hostname": cfg["host"],
            "port": cfg["ssh_port"],
            "username": cfg["username"],
            "timeout": 15,
            "banner_timeout": 15,
            "auth_timeout": 15,
        }

        if cfg["auth_method"] == "password":
            connect_kwargs["password"] = cfg["password"]
        else:
            connect_kwargs["key_filename"] = cfg["key_path"]
            if cfg["key_passphrase"]:
                connect_kwargs["passphrase"] = cfg["key_passphrase"]

        client.connect(**connect_kwargs)
        self.log("SSH 连接成功")

        try:
            self.run_remote_test(client)
        finally:
            client.close()

    def run_remote_test(self, client: Any) -> None:
        cfg = self.config
        test_type = cfg["test_type"]

        def exec_cmd(
            command: str,
            timeout: int = 30,
        ) -> tuple[int, str, str]:
            _, stdout, stderr = client.exec_command(
                command,
                timeout=timeout,
            )
            out = stdout.read().decode("utf-8", "replace")
            err = stderr.read().decode("utf-8", "replace")
            return stdout.channel.recv_exit_status(), out, err

        code, home, _ = exec_cmd("echo $HOME")
        home = home.strip()
        if code != 0 or not home:
            raise RuntimeError("无法获取服务器上的 $HOME")

        base_url = (
            f"http://{cfg['callback_ip']}:{cfg['callback_port']}"
        )

        if test_type == "approval":
            script_name = APPROVAL_SCRIPT_NAME
            hook_env = (
                f"CLAUDE_NOTIFY_TOKEN='{cfg['token']}' "
                f"CLAUDE_APPROVAL_URL='{base_url}{APPROVAL_PATH}' "
                "CLAUDE_APPROVAL_TIMEOUT='120'"
            )
            hook_input = {
                "session_id": "server-test-approval",
                "cwd": home,
                "tool_name": "Bash",
                "tool_input": {
                    "command": "echo claude-notify 服务器端测试",
                },
                "message": "服务器端测试：Claude Code 想要执行 echo 命令",
                "options": [
                    {"id": "allow", "label": "允许"},
                    {"id": "deny", "label": "拒绝"},
                ],
                "timeout_seconds": 110,
            }
            wait_seconds = 140
        else:
            script_name = NOTIFY_SCRIPT_NAME
            hook_env = (
                f"CLAUDE_NOTIFY_TOKEN='{cfg['token']}' "
                f"CLAUDE_NOTIFY_URL='{base_url}{NOTIFY_PATH}'"
            )
            hook_input = {
                "session_id": "server-test-notify",
                "cwd": home,
                "message": "服务器端测试通知",
                "notification_type": "server_test",
                "hook_event_name": "Notification",
            }
            wait_seconds = 30

        remote_script = f"{home}/.claude/{script_name}"

        # ---- 测试前先检测服务器侧是否部署完成 ----
        missing: list[str] = []

        code, out, _ = exec_cmd(
            f"test -f {remote_script} && echo OK"
        )
        if "OK" not in out:
            missing.append(f"钩子脚本 {remote_script}")

        section_name = (
            "PermissionRequest"
            if test_type == "approval"
            else "Notification"
        )
        code, settings_text, _ = exec_cmd(
            f"cat {home}/.claude/settings.json 2>/dev/null || true"
        )
        if script_name not in settings_text:
            missing.append(
                f"settings.json 中的 {section_name} 钩子配置"
            )

        if missing:
            detail = "、".join(missing)
            self.log(f"检测到服务器侧未部署完成：缺少 {detail}", "warn")
            self.not_deployed.emit(detail)
            self.finished.emit(
                False,
                "服务器尚未完成部署，请先执行「开始部署」。",
            )
            return

        self.log("部署状态检查通过")

        input_json = json.dumps(hook_input, ensure_ascii=False)
        self.log(f"执行钩子脚本 {script_name} …")

        if test_type == "approval":
            self.log(
                "等待 Windows 端弹窗上的操作（最长 120 秒）…",
                "notify",
            )

        # heredoc 模拟 Claude Code 把 JSON 写入钩子 stdin
        command = (
            f"{hook_env} timeout {wait_seconds - 10} "
            f"python3 {remote_script} <<'CCN_EOF'\n"
            f"{input_json}\n"
            "CCN_EOF"
        )

        code, out, err = exec_cmd(command, timeout=wait_seconds)

        if err.strip():
            self.log(f"钩子 stderr：{err.strip()[:300]}", "warn")

        if test_type == "approval":
            if out.strip():
                self.log(f"钩子输出：{out.strip()}", "notify")
                self.finished.emit(
                    True,
                    "端到端测试完成：钩子已正确输出审批决定。",
                )
            else:
                self.log(
                    "钩子无输出（超时/放弃时属正常，"
                    "Claude Code 会回退到终端提示）",
                    "warn",
                )
                self.finished.emit(
                    True,
                    "测试结束：钩子未输出决定（可能超时或被关闭）。",
                )
        else:
            if code == 0:
                self.log("通知钩子执行完成", "notify")
                self.finished.emit(
                    True,
                    "服务器端测试完成：通知应已推送到本机。",
                )
            else:
                self.log(f"钩子退出码异常：{code}", "warn")
                self.finished.emit(
                    False,
                    f"钩子退出码 {code}，详见日志。",
                )


# ============================================================================


class ApprovalStatsPopup(QFrame):
    """点击审批总数后显示的明细浮层；失焦或点击外部时自动关闭。"""

    MAX_HEIGHT = 360

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(
            parent,
            Qt.Popup | Qt.FramelessWindowHint,
        )
        self.setObjectName("approvalStatsPopup")
        self.setFixedWidth(320)
        self.setMaximumHeight(self.MAX_HEIGHT)
        self.setFocusPolicy(Qt.StrongFocus)
        self.setAccessibleName("已审批权限详细统计")

        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 12, 12, 12)
        layout.setSpacing(8)

        header = QHBoxLayout()
        header.setSpacing(8)

        title = QLabel("已审批权限")
        title.setObjectName("approvalStatsTitle")
        header.addWidget(title)
        header.addStretch(1)

        self.total_label = QLabel("共 0 次")
        self.total_label.setObjectName("approvalStatsTotal")
        header.addWidget(self.total_label)
        layout.addLayout(header)

        self.scroll = QScrollArea()
        self.scroll.setObjectName("approvalStatsScroll")
        self.scroll.setWidgetResizable(True)
        self.scroll.setHorizontalScrollBarPolicy(
            Qt.ScrollBarAlwaysOff
        )

        self.container = QWidget()
        self.container.setObjectName("approvalStatsContainer")
        self.detail_layout = QVBoxLayout(self.container)
        self.detail_layout.setContentsMargins(0, 0, 0, 0)
        self.detail_layout.setSpacing(6)
        self.scroll.setWidget(self.container)
        layout.addWidget(self.scroll)

        self.update_stats(0, {})

    def update_stats(
        self,
        total: int,
        counts: dict[str, int],
    ) -> None:
        self.total_label.setText(f"共 {total} 次")

        while self.detail_layout.count():
            item = self.detail_layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.setParent(None)
                widget.deleteLater()

        visible_counts = [
            (tool_name, count)
            for tool_name, count in counts.items()
            if count > 0
        ]

        if not visible_counts:
            empty = QLabel("暂无审批记录")
            empty.setObjectName("approvalStatsEmpty")
            empty.setAlignment(Qt.AlignCenter)
            self.detail_layout.addWidget(empty)
        else:
            for tool_name, count in visible_counts:
                row = QFrame()
                row.setObjectName("approvalStatsRow")
                row_layout = QHBoxLayout(row)
                row_layout.setContentsMargins(10, 7, 10, 7)
                row_layout.setSpacing(10)

                tool_label = QLabel(tool_name)
                tool_label.setObjectName("approvalStatsTool")
                tool_label.setToolTip(tool_name)
                row_layout.addWidget(tool_label, stretch=1)

                count_label = QLabel(f"x{count}")
                count_label.setObjectName("approvalStatsCount")
                row_layout.addWidget(count_label)
                self.detail_layout.addWidget(row)

        self.detail_layout.addStretch(1)
        row_count = max(1, len(visible_counts))
        self.setFixedHeight(
            min(self.MAX_HEIGHT, 82 + row_count * 36)
        )

    def event(self, event: QEvent) -> bool:
        if (
            event.type() == QEvent.WindowDeactivate
            and self.isVisible()
        ):
            self.close()
        return super().event(event)


class StageCompletionPopup(QWidget):
    dismissed = Signal(str)

    def __init__(
        self,
        session_id: str,
        cwd: str = "",
        screen_mode: str = "primary",
    ) -> None:
        super().__init__(
            None,
            Qt.FramelessWindowHint
            | Qt.WindowStaysOnTopHint
            | Qt.Tool,
        )
        self.session_id = session_id
        self.cwd = cwd
        self.screen_mode = screen_mode

        self.setObjectName("stageCompletionPopupRoot")
        self.setAttribute(Qt.WA_DeleteOnClose)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setFixedWidth(460)
        self.setAccessibleName("Claude 阶段完成提醒")
        self.build_ui()

        # 与审批弹窗保持一致：在 macOS 首次显示前预配置原生窗口，
        # 并在切换 Space 后主动迁入当前桌面。
        PLATFORM.follow_active_space(self)
        PLATFORM.watch_active_space(self)
        QApplication.beep()

    @property
    def project_name(self) -> str:
        if not self.cwd:
            return "未知项目"
        normalized = self.cwd.rstrip("/\\")
        return os.path.basename(normalized) or normalized

    def build_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)

        card = QFrame()
        card.setObjectName("stageCompletionCard")
        layout = QVBoxLayout(card)
        layout.setContentsMargins(18, 14, 16, 16)
        layout.setSpacing(9)

        top_row = QHBoxLayout()
        kicker = QLabel("STAGE COMPLETED")
        kicker.setObjectName("stageCompletionKicker")
        top_row.addWidget(kicker)
        top_row.addStretch()

        close_button = QPushButton("✕")
        close_button.setObjectName("popupClose")
        close_button.setToolTip("关闭提醒")
        close_button.setAccessibleName("关闭阶段完成提醒")
        close_button.clicked.connect(self.close)
        top_row.addWidget(close_button)
        layout.addLayout(top_row)

        title = QLabel("Claude 已完成当前阶段的工作")
        title.setObjectName("stageCompletionTitle")
        title.setWordWrap(True)
        layout.addWidget(title)

        desc = QLabel("请回到终端查看结果并继续处理。开始下一轮对话后，本提醒会自动关闭。")
        desc.setObjectName("stageCompletionDesc")
        desc.setWordWrap(True)
        layout.addWidget(desc)

        project = QLabel(
            f"{self.project_name} · 会话 {self.session_id[:16]}"
        )
        project.setObjectName("stageCompletionProject")
        project.setToolTip(self.cwd or self.session_id)
        layout.addWidget(project)

        outer.addWidget(card)

    def move_to_corner(self, stack_index: int = 0) -> None:
        self.adjustSize()
        screen = pick_popup_screen(self.screen_mode)
        if screen is None:
            return
        geometry = screen.availableGeometry()
        x = geometry.right() - self.width() - 16
        y = geometry.bottom() - self.height() - 16
        y -= stack_index * (self.height() + 12)
        self.move(x, max(geometry.top() + 16, y))

    def showEvent(self, event: QShowEvent) -> None:
        super().showEvent(event)
        QTimer.singleShot(
            0,
            lambda: PLATFORM.follow_active_space(self),
        )

    def closeEvent(self, event: QCloseEvent) -> None:
        self.dismissed.emit(self.session_id)
        super().closeEvent(event)


class MainWindow(QMainWindow):
    request_server_stop = Signal()

    def __init__(self) -> None:
        super().__init__()

        self.force_exit = False
        self.server_running = False
        self.notification_count = 0
        self.approval_count = 0
        self.approval_type_counts: dict[str, int] = {}
        self.token_visible = False
        ui_config = self.load_ui_config()
        self.popup_screen_mode = str(
            ui_config.get("popup_screen", "primary")
        )
        self.stage_completion_enabled = bool(
            ui_config.get("stage_completion_enabled", False)
        )

        self.token = load_or_create_token()
        self.local_ip = get_local_ip()

        self.bridge = HttpEventBridge()

        self.server_thread: Optional[QThread] = None
        self.server_worker: Optional[ServerWorker] = None

        # 审批队列
        self.pending_approvals: deque[ApprovalRequest] = deque()
        self.active_popup: Optional[ApprovalPopup] = None
        self.missed_approvals = 0
        self.stage_completion_popups: dict[str, StageCompletionPopup] = {}

        self.setWindowTitle(APP_NAME)
        self.resize(1200, 800)
        self.setMinimumSize(920, 660)

        icon_path = resource_path("app.ico")

        if icon_path.exists():
            self.app_icon = QIcon(str(icon_path))
            self.setWindowIcon(self.app_icon)
        else:
            self.app_icon = self.style().standardIcon(
                self.style().StandardPixmap.SP_ComputerIcon
            )

        self.build_ui()
        self.build_tray()
        self.connect_signals()
        self.setup_accessibility()
        self.refresh_display()
        self.start_server()

    # ------------------------------------------------------------------
    # 本地界面配置（弹窗位置等）
    # ------------------------------------------------------------------

    def load_ui_config(self) -> dict[str, Any]:
        try:
            if UI_CONFIG_FILE.exists():
                config = json.loads(
                    UI_CONFIG_FILE.read_text(encoding="utf-8")
                )
                if isinstance(config, dict):
                    mode = config.get("popup_screen")
                    if mode not in POPUP_SCREEN_MODES:
                        config["popup_screen"] = "primary"
                    return config
        except (OSError, json.JSONDecodeError):
            pass
        return {
            "popup_screen": "primary",
            "stage_completion_enabled": False,
        }

    def save_ui_config(self) -> None:
        try:
            UI_CONFIG_FILE.write_text(
                json.dumps(
                    {
                        "popup_screen": self.popup_screen_mode,
                        "stage_completion_enabled": (
                            self.stage_completion_enabled
                        ),
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
        except OSError:
            pass

    @Slot(int)
    def on_popup_screen_changed(self, index: int) -> None:
        mode = self.popup_screen_combo.itemData(index)
        if mode not in POPUP_SCREEN_MODES:
            return

        self.popup_screen_mode = mode
        self.save_ui_config()
        self.show_toast(
            f"审批弹窗将出现在：{POPUP_SCREEN_MODES[mode]}"
        )
        self.reposition_stage_completion_popups()

    @Slot(bool)
    def on_stage_completion_toggled(self, enabled: bool) -> None:
        self.stage_completion_enabled = enabled
        self.save_ui_config()
        if not enabled:
            self.dismiss_all_stage_completion_popups()
        self.show_toast(
            "已开启阶段完成置顶提醒"
            if enabled
            else "已关闭阶段完成置顶提醒"
        )

    # ------------------------------------------------------------------
    # 界面构建
    # ------------------------------------------------------------------

    def build_ui(self) -> None:
        root = QWidget()
        root_layout = QVBoxLayout(root)
        root_layout.setContentsMargins(18, 14, 18, 14)
        root_layout.setSpacing(12)

        root_layout.addLayout(self.build_header())
        root_layout.addWidget(self.build_status_strip())

        content = QHBoxLayout()
        content.setSpacing(12)

        left_col = QWidget()
        left_layout = QVBoxLayout(left_col)
        left_layout.setContentsMargins(0, 0, 0, 0)
        left_layout.setSpacing(12)
        left_layout.addWidget(self.build_connection_card())
        left_layout.addWidget(self.build_command_card())
        left_layout.addStretch(1)
        left_col.setFixedWidth(460)
        content.addWidget(left_col)

        right_col = QWidget()
        right_layout = QVBoxLayout(right_col)
        right_layout.setContentsMargins(0, 0, 0, 0)
        right_layout.setSpacing(12)
        right_layout.addWidget(self.build_log_card(), stretch=1)
        content.addWidget(right_col, stretch=1)

        root_layout.addLayout(content, stretch=1)
        self.setCentralWidget(root)

        # Toast 提示（浮动在窗口底部中央）
        self.toast_label = QLabel("", root)
        self.toast_label.setObjectName("toast")
        self.toast_label.setVisible(False)

    def build_status_strip(self) -> QFrame:
        strip = QFrame()
        strip.setObjectName("card")
        row = QHBoxLayout(strip)
        row.setContentsMargins(14, 10, 14, 10)
        row.setSpacing(18)

        def cell(label_text: str) -> tuple[QVBoxLayout, QLabel]:
            box = QVBoxLayout()
            box.setSpacing(3)
            label = QLabel(label_text)
            label.setObjectName("statusK")
            value = QLabel("-")
            value.setObjectName("statusV")
            box.addWidget(label)
            box.addWidget(value)
            return box, value

        service_cell, self.service_value = cell("服务")
        pending_cell, self.pending_value = cell("处理中")
        missed_cell, self.missed_value = cell("已回退")
        deploy_cell, self.deploy_value = cell("服务器")
        row.addLayout(service_cell, stretch=1)
        row.addLayout(pending_cell, stretch=1)
        row.addLayout(missed_cell, stretch=1)
        row.addLayout(deploy_cell, stretch=1)
        return strip

    def refresh_deploy_status(self) -> None:
        if DEPLOY_CACHE_FILE.exists():
            self.deploy_value.setText("已部署")
            self.deploy_value.setProperty("state", "info")
        else:
            self.deploy_value.setText("未部署")
            self.deploy_value.setProperty("state", "")
        self.deploy_value.style().unpolish(self.deploy_value)
        self.deploy_value.style().polish(self.deploy_value)

    def refresh_deploy_summary(self) -> None:
        parts: list[str] = []

        cache = load_deploy_cache()
        if cache:
            host = cache.get("host", "")
            port = cache.get("port", 22)
            username = cache.get("username", "deploy")
            parts.append(f"远程 {username}@{host}:{port} 已缓存")

        local_mode = detect_local_deploy()
        if local_mode:
            parts.append(f"本机已接入（{DEPLOY_MODES[local_mode]}）")
        else:
            parts.append("本机未接入")

        self.deploy_summary.setText(" · ".join(parts) if parts else "未部署")

    def update_pending_count(self) -> None:
        count = len(self.pending_approvals) + (1 if self.active_popup is not None else 0)
        self.pending_value.setText(str(count))
        self.missed_value.setText(str(self.missed_approvals))

    def build_header(self) -> QHBoxLayout:
        header = QHBoxLayout()
        header.setSpacing(12)

        icon_label = QLabel()
        pixmap = self.app_icon.pixmap(40, 40)
        if pixmap.isNull():
            pixmap = QPixmap(40, 40)
        icon_label.setPixmap(pixmap)
        header.addWidget(icon_label)

        title_box = QVBoxLayout()
        title_box.setSpacing(2)

        title = QLabel(APP_NAME)
        title.setObjectName("h1")

        subtitle = QLabel("权限审批通知桥接服务")
        subtitle.setObjectName("subtitle")

        title_box.addWidget(title)
        title_box.addWidget(subtitle)
        header.addLayout(title_box)
        header.addStretch()

        # 通知计数
        stat_box = QVBoxLayout()
        stat_box.setSpacing(0)

        self.stat_value = QLabel("0")
        self.stat_value.setObjectName("statValue")
        self.stat_value.setAlignment(Qt.AlignCenter)

        stat_label = QLabel("已推送通知")
        stat_label.setObjectName("statLabel")
        stat_label.setAlignment(Qt.AlignCenter)

        stat_box.addWidget(self.stat_value)
        stat_box.addWidget(stat_label)
        header.addLayout(stat_box)
        header.addSpacing(16)

        # 已完成审批计数；点击数字后在浮层中查看权限类型明细。
        approval_stat_box = QVBoxLayout()
        approval_stat_box.setSpacing(0)

        self.approval_stat_value = QPushButton("0")
        self.approval_stat_value.setObjectName("approvalStatValue")
        self.approval_stat_value.setCursor(Qt.PointingHandCursor)
        self.approval_stat_value.setToolTip("点击查看详细统计")

        approval_stat_label = QLabel("已审批权限")
        approval_stat_label.setObjectName("statLabel")
        approval_stat_label.setAlignment(Qt.AlignCenter)

        approval_stat_box.addWidget(self.approval_stat_value)
        approval_stat_box.addWidget(approval_stat_label)
        header.addLayout(approval_stat_box)
        header.addSpacing(10)

        self.approval_stats_popup = ApprovalStatsPopup(self)
        self.approval_stat_value.clicked.connect(
            self.toggle_approval_stats_popup
        )

        # 状态胶囊
        self.status_pill = QLabel("● 正在启动")
        self.status_pill.setObjectName("pillStopped")
        header.addWidget(self.status_pill)
        header.addSpacing(6)

        self.toggle_server_button = QPushButton("停止服务")
        self.toggle_server_button.setEnabled(False)
        header.addWidget(self.toggle_server_button)

        self.hide_button = QPushButton("隐藏到托盘")
        self.exit_button = QPushButton("退出")
        self.exit_button.setObjectName("dangerSolid")
        header.addWidget(self.hide_button)
        header.addWidget(self.exit_button)

        return header

    def make_card(self, title_text: str) -> tuple[QFrame, QVBoxLayout]:
        card = QFrame()
        card.setObjectName("card")

        layout = QVBoxLayout(card)
        layout.setContentsMargins(16, 14, 16, 14)
        layout.setSpacing(10)

        title = QLabel(title_text)
        title.setObjectName("cardTitle")
        layout.addWidget(title)

        return card, layout

    def build_connection_card(self) -> QFrame:
        card, layout = self.make_card("连接与凭证")

        # 通知接口
        endpoint_row = QHBoxLayout()
        endpoint_row.addWidget(self.make_field_label("通知接口"))

        self.endpoint_edit = self.make_readonly_edit()
        endpoint_row.addWidget(self.endpoint_edit, stretch=1)

        self.copy_endpoint_button = self.make_mini_button("复制")
        endpoint_row.addWidget(self.copy_endpoint_button)

        layout.addLayout(endpoint_row)

        # IP + 端口
        ip_port_row = QHBoxLayout()
        ip_port_row.setSpacing(16)

        ip_port_row.addWidget(self.make_field_label("本机 IP"))
        self.ip_edit = self.make_readonly_edit()
        ip_port_row.addWidget(self.ip_edit, stretch=1)

        ip_port_row.addWidget(self.make_field_label("端口"))
        self.port_edit = self.make_readonly_edit(str(PORT))
        self.port_edit.setMaximumWidth(120)
        ip_port_row.addWidget(self.port_edit, stretch=1)

        layout.addLayout(ip_port_row)

        # Token
        token_row = QHBoxLayout()
        token_row.addWidget(self.make_field_label("Token"))

        self.token_edit = self.make_readonly_edit()
        self.token_edit.setEchoMode(QLineEdit.Password)
        token_row.addWidget(self.token_edit, stretch=1)

        self.show_token_button = self.make_mini_button("显示")
        self.copy_token_button = self.make_mini_button("复制")
        self.regenerate_token_button = QPushButton("重新生成")
        self.regenerate_token_button.setObjectName("miniDanger")

        token_row.addWidget(self.show_token_button)
        token_row.addWidget(self.copy_token_button)
        token_row.addWidget(self.regenerate_token_button)

        layout.addLayout(token_row)

        # 弹窗位置（多显示器时避免遗漏审批）
        screen_row = QHBoxLayout()
        screen_row.addWidget(self.make_field_label("弹窗位置"))

        self.popup_screen_combo = OptionSegment()
        for mode_key, mode_label in POPUP_SCREEN_MODES.items():
            # macOS / Linux 暂未实现前台窗口定位，隐藏该选项而不是给出无效承诺
            if mode_key == "focus" and not PLATFORM.supports_focus_screen:
                continue
            self.popup_screen_combo.addItem(mode_label, mode_key)

        current_index = self.popup_screen_combo.findData(
            self.popup_screen_mode
        )
        self.popup_screen_combo.setCurrentIndex(
            max(current_index, 0)
        )
        self.popup_screen_combo.setToolTip(
            "选择审批弹窗出现在哪台显示器上。\n"
            "焦点窗口所在屏幕：弹在您正在操作的窗口所在屏幕，"
            "最不容易遗漏；获取失败时自动回退到鼠标所在屏幕。"
        )
        screen_row.addWidget(self.popup_screen_combo, stretch=1)
        layout.addLayout(screen_row)

        self.stage_completion_check = QCheckBox(
            "Claude 完成当前阶段时显示置顶提醒"
        )
        self.stage_completion_check.setChecked(
            self.stage_completion_enabled
        )
        self.stage_completion_check.setToolTip(
            "该提醒独立于“系统通知中心/权限审批弹窗”的通知方式，"
            "会一直置顶显示，直到手动关闭或在终端开始下一轮对话。"
        )
        layout.addWidget(self.stage_completion_check)

        test_row = QHBoxLayout()
        self.test_notification_button = QPushButton("测试通知")
        self.test_approval_button = QPushButton("测试审批弹窗")
        test_row.addWidget(self.test_notification_button)
        test_row.addWidget(self.test_approval_button)
        test_row.addStretch(1)
        layout.addLayout(test_row)

        return card

    def build_command_card(self) -> QFrame:
        """部署入口卡：只保留自动部署入口。"""
        card, layout = self.make_card("部署")
        layout.setContentsMargins(14, 12, 14, 12)
        layout.setSpacing(10)

        summary_row = QHBoxLayout()
        self.deploy_summary = QLabel()
        self.deploy_summary.setObjectName("deploySummary")
        self.deploy_summary.setText("未部署")
        summary_row.addWidget(self.deploy_summary, stretch=1)
        layout.addLayout(summary_row)

        button_row = QHBoxLayout()
        self.deploy_button = QPushButton("部署到服务器")
        self.deploy_button.setObjectName("primaryButton")
        self.local_deploy_button = QPushButton("接入本机 Claude Code")
        # 与「部署到服务器」同级：两个部署入口都是主操作，统一 coral 风格
        self.local_deploy_button.setObjectName("primaryButton")
        button_row.addWidget(self.deploy_button)
        button_row.addWidget(self.local_deploy_button)
        button_row.addStretch(1)
        layout.addLayout(button_row)

        return card

    def build_log_card(self) -> QFrame:
        card, layout = self.make_card("")

        title_row = QHBoxLayout()

        title = QLabel("实时日志")
        title.setObjectName("cardTitle")
        title_row.addWidget(title)
        title_row.addStretch()

        self.open_log_button = self.make_mini_button("打开日志目录")
        title_row.addWidget(self.open_log_button)
        self.clear_log_button = self.make_mini_button("清空")
        title_row.addWidget(self.clear_log_button)

        layout.itemAt(0).widget().deleteLater()
        layout.insertLayout(0, title_row)

        self.log_edit = QTextEdit()
        self.log_edit.setObjectName("log")
        self.log_edit.setReadOnly(True)
        layout.addWidget(self.log_edit)

        return card

    def make_field_label(self, text: str) -> QLabel:
        label = QLabel(text)
        label.setObjectName("fieldLabel")
        label.setFixedWidth(64)
        return label

    def make_readonly_edit(self, text: str = "") -> QLineEdit:
        edit = QLineEdit(text)
        edit.setReadOnly(True)
        return edit

    def make_mini_button(self, text: str) -> QPushButton:
        button = QPushButton(text)
        button.setObjectName("mini")
        return button

    def setup_accessibility(self) -> None:
        self.endpoint_edit.setAccessibleName("通知接口地址")
        self.token_edit.setAccessibleName("访问 Token")
        self.popup_screen_combo.setAccessibleName("审批弹窗屏幕策略")
        self.stage_completion_check.setAccessibleName(
            "Claude 阶段完成置顶提醒"
        )
        self.deploy_button.setAccessibleName("部署到服务器")
        self.local_deploy_button.setAccessibleName("接入本机 Claude Code")
        self.test_approval_button.setAccessibleName("测试审批弹窗")
        self.toggle_server_button.setAccessibleName("启动或停止本地服务")
        for widget in (
            self.copy_endpoint_button,
            self.show_token_button,
            self.copy_token_button,
            self.regenerate_token_button,
            self.popup_screen_combo,
            self.stage_completion_check,
            self.deploy_button,
            self.local_deploy_button,
            self.test_notification_button,
            self.test_approval_button,
            self.open_log_button,
            self.clear_log_button,
            self.hide_button,
            self.exit_button,
        ):
            widget.setFocusPolicy(Qt.StrongFocus)
        self.setTabOrder(self.copy_endpoint_button, self.show_token_button)
        self.setTabOrder(self.show_token_button, self.copy_token_button)
        self.setTabOrder(self.copy_token_button, self.regenerate_token_button)
        self.setTabOrder(self.regenerate_token_button, self.popup_screen_combo)
        self.setTabOrder(
            self.popup_screen_combo,
            self.stage_completion_check,
        )
        self.setTabOrder(
            self.stage_completion_check,
            self.deploy_button,
        )
        self.setTabOrder(self.deploy_button, self.local_deploy_button)
        self.setTabOrder(self.local_deploy_button, self.test_notification_button)
        self.setTabOrder(self.test_notification_button, self.test_approval_button)
        self.setTabOrder(self.test_approval_button, self.open_log_button)
        self.setTabOrder(self.open_log_button, self.clear_log_button)
        self.setTabOrder(self.clear_log_button, self.hide_button)
        self.setTabOrder(self.hide_button, self.exit_button)

    # ------------------------------------------------------------------
    # 托盘
    # ------------------------------------------------------------------

    def build_tray(self) -> None:
        self.tray_icon = QSystemTrayIcon(self.app_icon, self)

        tray_menu = QMenu(self)

        show_action = QAction("显示主窗口", self)
        copy_token_action = QAction("复制 Token", self)
        test_action = QAction("测试通知", self)
        exit_action = QAction("退出", self)

        show_action.triggered.connect(self.show_window)
        copy_token_action.triggered.connect(self.copy_token)
        test_action.triggered.connect(
            self.show_test_notification
        )
        exit_action.triggered.connect(self.exit_application)

        tray_menu.addAction(show_action)
        tray_menu.addSeparator()
        tray_menu.addAction(copy_token_action)
        tray_menu.addAction(test_action)
        tray_menu.addSeparator()
        tray_menu.addAction(exit_action)

        self.tray_icon.setContextMenu(tray_menu)
        self.tray_icon.setToolTip(APP_NAME)

        self.tray_icon.activated.connect(
            self.on_tray_activated
        )

        self.tray_icon.show()

    # ------------------------------------------------------------------
    # 信号连接
    # ------------------------------------------------------------------

    def connect_signals(self) -> None:
        self.toggle_server_button.clicked.connect(
            self.toggle_server
        )

        self.copy_endpoint_button.clicked.connect(
            lambda: self.copy_with_feedback(
                self.copy_endpoint_button,
                self.endpoint_edit.text(),
                "接口地址已复制",
            )
        )

        self.show_token_button.clicked.connect(
            self.toggle_token_visibility
        )
        self.copy_token_button.clicked.connect(
            self.copy_token
        )
        self.regenerate_token_button.clicked.connect(
            self.regenerate_token
        )

        self.clear_log_button.clicked.connect(
            self.log_edit.clear
        )

        self.popup_screen_combo.currentIndexChanged.connect(
            self.on_popup_screen_changed
        )
        self.stage_completion_check.toggled.connect(
            self.on_stage_completion_toggled
        )

        self.test_notification_button.clicked.connect(
            self.show_test_notification
        )
        self.test_approval_button.clicked.connect(
            self.show_test_approval
        )
        self.deploy_button.clicked.connect(
            self.open_deploy_dialog
        )
        self.local_deploy_button.clicked.connect(
            self.open_local_deploy_dialog
        )
        self.open_log_button.clicked.connect(
            self.open_log_directory
        )
        self.hide_button.clicked.connect(self.hide)
        self.exit_button.clicked.connect(
            self.confirm_exit
        )

        self.bridge.notification_received.connect(
            self.show_tray_notification
        )
        self.bridge.log_received.connect(self.append_log)
        self.bridge.approval_received.connect(
            self.enqueue_approval
        )
        self.bridge.approval_cancelled.connect(
            self.on_approval_cancelled
        )
        self.bridge.stage_status_received.connect(
            self.on_stage_status_received
        )

    # ------------------------------------------------------------------
    # 显示刷新
    # ------------------------------------------------------------------

    def refresh_display(self) -> None:
        endpoint = (
            f"http://{self.local_ip}:"
            f"{PORT}{NOTIFY_PATH}"
        )

        self.ip_edit.setText(self.local_ip)
        self.endpoint_edit.setText(endpoint)
        self.token_edit.setText(self.token)
        self.refresh_deploy_status()
        self.refresh_deploy_summary()
        self.update_pending_count()
        self.update_approval_count()

    def update_status_pill(self) -> None:
        if self.server_running:
            self.status_pill.setText("● LISTENING")
            self.status_pill.setObjectName("pillRunning")
            self.toggle_server_button.setText("暂停服务")
            self.service_value.setText("HTTP · OK")
        else:
            self.status_pill.setText("● STOPPED")
            self.status_pill.setObjectName("pillStopped")
            self.toggle_server_button.setText("启动服务")
            self.service_value.setText("HTTP · STOP")

        # objectName 变化后需要刷新样式
        self.status_pill.style().unpolish(self.status_pill)
        self.status_pill.style().polish(self.status_pill)
        self.toggle_server_button.setEnabled(True)

    def update_notification_count(self) -> None:
        self.stat_value.setText(
            str(self.notification_count)
        )

    def update_approval_count(self) -> None:
        self.approval_stat_value.setText(str(self.approval_count))
        detail = format_approval_type_counts(
            self.approval_type_counts
        )
        self.approval_stat_value.setAccessibleName(
            f"{self.approval_count} 已审批权限，点击查看详细统计"
        )
        self.approval_stat_value.setToolTip(
            f"点击查看详细统计：{detail}"
        )
        self.approval_stats_popup.update_stats(
            self.approval_count,
            self.approval_type_counts,
        )

    @Slot()
    def toggle_approval_stats_popup(self) -> None:
        popup = self.approval_stats_popup
        if popup.isVisible():
            popup.close()
            return

        popup.update_stats(
            self.approval_count,
            self.approval_type_counts,
        )

        anchor = self.approval_stat_value.mapToGlobal(
            QPoint(
                self.approval_stat_value.width(),
                self.approval_stat_value.height() + 6,
            )
        )
        screen = QGuiApplication.screenAt(anchor) or self.screen()
        available = screen.availableGeometry()

        x = anchor.x() - popup.width()
        y = anchor.y()
        x = max(
            available.left(),
            min(x, available.right() - popup.width() + 1),
        )
        if y + popup.height() > available.bottom() + 1:
            above = self.approval_stat_value.mapToGlobal(
                QPoint(0, -popup.height() - 6)
            )
            y = above.y()
        y = max(
            available.top(),
            min(y, available.bottom() - popup.height() + 1),
        )

        popup.move(x, y)
        popup.show()
        popup.raise_()
        popup.activateWindow()
        popup.setFocus(Qt.PopupFocusReason)

    # ------------------------------------------------------------------
    # 服务控制
    # ------------------------------------------------------------------

    def start_server(self) -> None:
        self.server_thread = QThread(self)
        self.server_worker = ServerWorker(
            self.bridge,
            self.token,
        )

        self.server_worker.moveToThread(
            self.server_thread
        )

        self.server_thread.started.connect(
            self.server_worker.run
        )

        self.server_worker.started.connect(
            self.on_server_started
        )
        self.server_worker.failed.connect(
            self.on_server_failed
        )
        self.server_worker.stopped.connect(
            self.on_server_stopped
        )

        self.request_server_stop.connect(
            self.server_worker.stop
        )

        self.server_worker.stopped.connect(
            self.server_thread.quit
        )
        self.server_thread.finished.connect(
            self.server_thread.deleteLater
        )

        self.server_thread.start()

    def stop_local_server(self, timeout_ms: int = 6000) -> bool:
        """停止本地 HTTP 服务；返回服务线程是否已真正结束。"""
        worker = self.server_worker
        if worker is not None and worker.server is not None:
            try:
                # BaseServer.shutdown() 是线程安全的，必须从 serve_forever 所在线程之外调用
                worker.server.shutdown()
            except Exception:
                self.append_log(
                    "warn",
                    "服务停止时 shutdown 调用异常，继续等待线程退出。",
                )

        if self.server_thread is None:
            return True

        self.server_thread.quit()
        finished = self.server_thread.wait(timeout_ms)
        if not finished:
            self.append_log("error", "服务线程未在预期时间内停止。")
        return finished

    @Slot()
    def toggle_server(self) -> None:
        self.toggle_server_button.setEnabled(False)

        if self.server_running:
            self.append_log("info", "正在停止服务…")
            self.stop_local_server()
        else:
            self.append_log("info", "正在启动服务…")
            self.start_server()

    @Slot()
    def on_server_started(self) -> None:
        self.server_running = True
        self.update_status_pill()
        self.append_log(
            "info",
            f"服务已启动：http://{HOST}:{PORT}",
        )

    @Slot(str)
    def on_server_failed(self, error: str) -> None:
        self.server_running = False
        self.update_status_pill()
        self.append_log("error", error)

        QMessageBox.critical(
            self,
            "服务启动失败",
            f"无法监听端口 {PORT}。\n\n{error}",
        )

    @Slot()
    def on_server_stopped(self) -> None:
        self.server_running = False
        self.update_status_pill()
        self.append_log("info", "HTTP 服务已停止")

    # ------------------------------------------------------------------
    # 阶段完成置顶提醒
    # ------------------------------------------------------------------

    @Slot(object)
    def on_stage_status_received(self, payload: object) -> None:
        if not isinstance(payload, dict):
            return
        status = safe_string(payload.get("status"))
        session_id = safe_string(payload.get("session_id"))
        if not session_id:
            return

        if status == "resumed":
            popup = self.stage_completion_popups.pop(
                session_id,
                None,
            )
            if popup is not None:
                popup.close()
                self.reposition_stage_completion_popups()
                self.append_log(
                    "info",
                    "用户已回到终端继续对话，阶段完成提醒自动关闭："
                    f"session={session_id[:16]}",
                )
            return

        if status != "completed":
            return
        if not self.stage_completion_enabled:
            self.append_log(
                "info",
                "阶段完成提醒未开启，本次不弹窗："
                f"session={session_id[:16]}",
            )
            return

        existing = self.stage_completion_popups.get(session_id)
        if existing is not None:
            existing.show()
            existing.raise_()
            existing.activateWindow()
            return

        popup = StageCompletionPopup(
            session_id=session_id,
            cwd=safe_string(payload.get("cwd")),
            screen_mode=self.popup_screen_mode,
        )
        popup.dismissed.connect(self.on_stage_popup_dismissed)
        self.stage_completion_popups[session_id] = popup
        self.reposition_stage_completion_popups()
        popup.show()
        popup.raise_()
        popup.activateWindow()
        self.append_log(
            "notify",
            "Claude 已完成当前阶段，已显示置顶提醒："
            f"session={session_id[:16]}, project={popup.project_name}",
        )

    @Slot(str)
    def on_stage_popup_dismissed(self, session_id: str) -> None:
        popup = self.sender()
        current = self.stage_completion_popups.get(session_id)
        if current is popup:
            self.stage_completion_popups.pop(session_id, None)
            self.reposition_stage_completion_popups()

    def reposition_stage_completion_popups(self) -> None:
        for index, popup in enumerate(
            self.stage_completion_popups.values()
        ):
            popup.screen_mode = self.popup_screen_mode
            popup.move_to_corner(index)

    def dismiss_all_stage_completion_popups(self) -> None:
        popups = list(self.stage_completion_popups.values())
        self.stage_completion_popups.clear()
        for popup in popups:
            popup.close()

    # ------------------------------------------------------------------
    # 审批弹窗队列
    # ------------------------------------------------------------------

    @Slot(object)
    def enqueue_approval(self, request: ApprovalRequest) -> None:
        self.pending_approvals.append(request)
        self.update_pending_count()
        self.show_next_approval()

    def show_next_approval(self) -> None:
        if self.active_popup is not None:
            return

        if not self.pending_approvals:
            return

        request = self.pending_approvals.popleft()

        popup = ApprovalPopup(
            request,
            queued_count=len(self.pending_approvals),
            screen_mode=self.popup_screen_mode,
        )
        popup.decided.connect(self.on_approval_decided)
        popup.expired.connect(self.on_approval_expired)
        popup.acknowledged.connect(self.on_approval_acknowledged)

        self.active_popup = popup
        self.update_pending_count()
        popup.show()
        popup.raise_()
        popup.activateWindow()

    @Slot(object)
    def on_approval_expired(self, request: ApprovalRequest) -> None:
        if self.active_popup is None or self.active_popup.request is not request:
            return
        self.missed_approvals += 1
        self.update_pending_count()
        self.append_log(
            "warn",
            f"审批超时已回退终端：{request.tool_name} · {request.project_name}",
        )
        self.tray_icon.showMessage(
            APP_NAME,
            "一条审批已超时并回退终端，请在 Claude 中继续处理。",
            QSystemTrayIcon.Warning,
            5000,
        )

    @Slot(object)
    def on_approval_acknowledged(self, request: ApprovalRequest) -> None:
        if self.active_popup is None or self.active_popup.request is not request:
            return
        if not request.event.is_set():
            request.finish("timeout")
        self.active_popup = None
        self.update_pending_count()
        QTimer.singleShot(200, self.show_next_approval)

    @Slot(object, str)
    def on_approval_decided(
        self,
        request: ApprovalRequest,
        decision: str,
    ) -> None:
        # 终端可能已先作答（broker 已 finish cancelled），避免覆盖
        completed_here = (
            not request.event.is_set()
            and request.finish(decision)
        )
        if (
            completed_here
            and is_completed_approval_decision(decision)
        ):
            self.approval_count += 1
            tool_name = request.tool_name
            self.approval_type_counts[tool_name] = (
                self.approval_type_counts.get(tool_name, 0) + 1
            )
            self.update_approval_count()
        self.active_popup = None
        self.update_pending_count()

        # 处理队列中的下一条
        QTimer.singleShot(200, self.show_next_approval)

    @Slot(object)
    def on_approval_cancelled(self, request: ApprovalRequest) -> None:
        """
        终端侧已先作答（钩子连接断开，broker 已 finish("cancelled")），
        同步清理弹窗/队列，不让弹窗滞留到超时。
        """
        if self.active_popup is not None and self.active_popup.request is request:
            popup = self.active_popup
            self.active_popup = None
            popup.countdown_timer.stop()
            popup.close()
        else:
            try:
                self.pending_approvals.remove(request)
            except ValueError:
                return
        self.update_pending_count()
        QTimer.singleShot(200, self.show_next_approval)

    @Slot()
    def open_deploy_dialog(self) -> None:
        dialog = DeployDialog(
            self,
            token=self.token,
            callback_ip=self.local_ip,
            callback_port=PORT,
        )
        dialog.exec()
        self.refresh_deploy_status()
        self.refresh_deploy_summary()

    @Slot()
    def open_local_deploy_dialog(self) -> None:
        dialog = LocalDeployDialog(self)
        if dialog.exec() != QDialog.Accepted:
            return

        mode = dialog.mode()
        write_env = dialog.write_env()
        env_shells: list[str] = []

        if write_env and sys.platform != "win32":
            env_dialog = EnvShellDialog(self)
            if env_dialog.exec() != QDialog.Accepted:
                return
            env_shells = env_dialog.selected_shells()
            if not env_shells:
                return

        try:
            self.deploy_local(mode, env_shells, write_env)
        except Exception as exc:
            self.append_log("error", f"本机接入失败：{exc}")
            QMessageBox.warning(self, APP_NAME, f"本机接入失败：{exc}")
            return

        self.refresh_deploy_status()
        self.refresh_deploy_summary()
        QMessageBox.information(
            self,
            APP_NAME,
            "本机接入完成。请重启 Claude Code（以及对应终端）让钩子与环境变量生效。",
        )

    def deploy_local(
        self,
        mode: str,
        env_shells: list[str],
        write_env: bool,
    ) -> None:
        claude_dir = local_claude_dir()
        claude_dir.mkdir(parents=True, exist_ok=True)
        if sys.platform != "win32":
            claude_dir.chmod(0o700)

        if mode == "popup":
            script_name = APPROVAL_SCRIPT_NAME
            removed_script = NOTIFY_SCRIPT_NAME
        else:
            script_name = NOTIFY_SCRIPT_NAME
            removed_script = APPROVAL_SCRIPT_NAME

        source = resource_path(script_name)
        if not source.exists():
            raise RuntimeError(f"找不到内置钩子脚本 {source}")

        script_path = claude_dir / script_name
        script_path.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
        if sys.platform != "win32":
            script_path.chmod(0o755)
        (claude_dir / removed_script).unlink(missing_ok=True)
        self.append_log("info", f"本机钩子脚本已写入 {script_path}")

        settings_path = claude_dir / "settings.json"
        existing = ""
        if settings_path.exists():
            existing = settings_path.read_text(encoding="utf-8")
            backup_path = settings_path.with_name(
                settings_path.name
                + f".bak.{time.strftime('%Y%m%d-%H%M%S')}"
            )
            backup_path.write_text(existing, encoding="utf-8")
            self.append_log("info", f"已备份本机配置 → {backup_path}")

        base_url = f"http://127.0.0.1:{PORT}"
        if mode == "popup":
            env_pairs: dict[str, Any] = {
                "CLAUDE_NOTIFY_TOKEN": self.token,
                "CLAUDE_APPROVAL_URL": f"{base_url}{APPROVAL_PATH}",
                "CLAUDE_STAGE_URL": f"{base_url}{STAGE_STATUS_PATH}",
                "CLAUDE_APPROVAL_TIMEOUT": 240,
                # 标记 AskUserQuestion 走 PreToolUse 代答通道，
                # 钩子在 PermissionRequest 事件下会对该工具让位
                "CLAUDE_ASKUSER_CHANNEL": "pretooluse",
            }
        else:
            env_pairs = {
                "CLAUDE_NOTIFY_TOKEN": self.token,
                "CLAUDE_NOTIFY_URL": f"{base_url}{NOTIFY_PATH}",
                "CLAUDE_STAGE_URL": f"{base_url}{STAGE_STATUS_PATH}",
            }

        # Windows 用 exec form（解释器绝对路径 + args），不经过 shell、
        # 不依赖 PATH；POSIX 用 shell form 内联环境变量
        hook_entry = build_local_hook_entry(env_pairs, script_path)
        merged = merge_settings_json(
            existing,
            mode=mode,
            hook_entry=hook_entry,
            hook_timeout=300,
            # 同一脚本按事件区分关联 observer 与审批/代答
            question_entry=hook_entry,
            stage_entry=hook_entry,
        )
        settings_path.write_text(merged, encoding="utf-8")
        self.append_log("notify", f"本机 settings.json 已合并（{DEPLOY_MODES[mode]}）")
        if sys.platform == "win32":
            self.append_log(
                "info",
                f"钩子解释器：{hook_entry['command']}（绝对路径，exec form）",
            )

        # 配置文件：钩子启动时读取 Token/URL，立即生效。
        # Windows 上尤其关键——不依赖 setx，无需重启 Claude Code/终端。
        config_path = claude_dir / HOOK_CONFIG_NAME
        config_path.write_text(
            json.dumps(env_pairs, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        if sys.platform != "win32":
            config_path.chmod(0o600)
        self.append_log("info", f"钩子配置已写入 {config_path}")

        # 语法验证：用 py_compile 只编译、不执行。
        # 历史教训：此前直接执行钩子做验证，钩子会读到 Token（环境变量或
        # 配置文件）并对 "{}" 输入发起真实审批请求——弹出幽灵弹窗，用户
        # 还没来得及点，10 秒超时就把钩子杀掉，部署被误判为失败。
        # 只编译不执行则零副作用，且与钩子脚本新旧版本无关。
        if sys.platform == "win32":
            # 与 settings.json 里 exec form 用的是同一个解释器
            verify_python = hook_entry["command"]
        else:
            verify_python = local_python_command()
        result = subprocess.run(
            [verify_python, "-m", "py_compile", str(script_path)],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"钩子脚本编译验证失败 exit={result.returncode}: {result.stderr[:200]}"
            )

        if write_env:
            self.apply_local_env_import(env_shells)

        self.append_log(
            "notify",
            "本机接入完成 ✓ 钩子读取配置文件，无需重启 Claude Code 即可生效",
        )

    def apply_local_env_import(self, env_shells: list[str]) -> None:
        if sys.platform == "win32":
            subprocess.run(
                ["setx", "CLAUDE_NOTIFY_TOKEN", self.token],
                check=True,
                capture_output=True,
                text=True,
            )
            self.append_log(
                "info",
                "已用 setx 写入用户环境变量 CLAUDE_NOTIFY_TOKEN（新进程生效）。",
            )
            return

        home = Path.home()
        for shell in env_shells:
            if shell not in SHELL_RC_FILES:
                continue
            shell_label, rc_rel = SHELL_RC_FILES[shell]
            rc_path = home / rc_rel
            rc_path.parent.mkdir(parents=True, exist_ok=True)

            existing = ""
            if rc_path.exists():
                existing = rc_path.read_text(encoding="utf-8")

            pattern = re.compile(
                re.escape(ENV_MARK_BEGIN)
                + r".*?"
                + re.escape(ENV_MARK_END)
                + r"\n?",
                re.S,
            )
            cleaned = pattern.sub("", existing).rstrip()
            block = build_env_block(shell, self.token)
            updated = f"{cleaned}\n\n{block}\n" if cleaned else f"{block}\n"
            rc_path.write_text(updated, encoding="utf-8")
            self.append_log("info", f"已写入 {shell_label} 环境变量 → {rc_path}")

    @Slot()
    def show_test_approval(self) -> None:
        fake_payload = {
            "tool_name": "Bash",
            "cwd": r"D:\code\my-project",
            "session_id": "test-session-0001",
            "message": "Claude Code 想要执行 Bash 命令",
            "tool_input": {
                "command": "rm -rf ./build && npm run build",
                "description": "清理构建目录并重新构建",
            },
            "options": [
                {"id": "allow", "label": "允许"},
                {"id": "deny", "label": "拒绝"},
            ],
            "timeout_seconds": 30,
        }

        request = ApprovalRequest(fake_payload, 30)
        self.append_log("notify", "测试审批弹窗（本地模拟）")
        self.enqueue_approval(request)

        # 测试请求没有 HTTP 线程在等待，结果仅记录日志
        def log_test_result() -> None:
            request.event.wait(35)
            self.bridge.log_received.emit(
                "notify",
                f"测试审批结果：decision={request.decision}",
            )

        threading.Thread(
            target=log_test_result,
            daemon=True,
        ).start()

    def dismiss_all_approvals(self) -> None:
        """退出前唤醒所有等待中的审批请求，避免服务器钩子挂起。"""
        if self.active_popup is not None:
            request = self.active_popup.request
            request.finish("dismissed")
            self.active_popup.close()
            self.active_popup = None

        while self.pending_approvals:
            request = self.pending_approvals.popleft()
            request.finish("dismissed")

    # ------------------------------------------------------------------
    # 日志与通知
    # ------------------------------------------------------------------

    @Slot(str, str)
    def append_log(self, level: str, message: str) -> None:
        timestamp = time.strftime("%H:%M:%S")
        color = LOG_COLORS.get(level, LOG_COLORS["info"])

        self.log_edit.append(
            f'<span style="color:#565d6b;">[{timestamp}]</span> '
            f'<span style="color:{color};">'
            f"{escape_html(message)}</span>"
        )

        # 限制最大行数，防止长时间运行内存膨胀
        document = self.log_edit.document()
        while document.blockCount() > MAX_LOG_LINES:
            cursor = self.log_edit.textCursor()
            cursor.movePosition(cursor.Start)
            cursor.select(cursor.BlockUnderCursor)
            cursor.removeSelectedText()
            cursor.deleteChar()

        scrollbar = self.log_edit.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())

        full_timestamp = time.strftime("%Y-%m-%d %H:%M:%S")

        try:
            with LOG_FILE.open(
                "a",
                encoding="utf-8",
            ) as file:
                file.write(
                    f"[{full_timestamp}] [{level}] {message}\n"
                )
        except OSError:
            pass

    @Slot(str, str)
    def show_tray_notification(
        self,
        title: str,
        message: str,
    ) -> None:
        self.notification_count += 1
        self.update_notification_count()

        self.append_log("notify", f"桌面通知：{title}")

        self.tray_icon.showMessage(
            title,
            message,
            QSystemTrayIcon.Information,
            10000,
        )

    @Slot()
    def show_test_notification(self) -> None:
        self.show_tray_notification(
            APP_NAME,
            "本地通知功能正常。",
        )

    # ------------------------------------------------------------------
    # 复制与 Token
    # ------------------------------------------------------------------

    def copy_with_feedback(
        self,
        button: QPushButton,
        text: str,
        toast_message: str,
    ) -> None:
        QApplication.clipboard().setText(text)

        original_text = button.text()
        button.setText("已复制")
        button.setEnabled(False)

        QTimer.singleShot(
            1200,
            lambda: (
                button.setText(original_text),
                button.setEnabled(True),
            ),
        )

        self.show_toast(toast_message)

    def show_toast(self, message: str) -> None:
        self.toast_label.setText(message)
        self.toast_label.adjustSize()

        parent = self.centralWidget()
        x = (parent.width() - self.toast_label.width()) // 2
        y = parent.height() - self.toast_label.height() - 70
        self.toast_label.move(max(x, 0), max(y, 0))
        self.toast_label.setVisible(True)
        self.toast_label.raise_()

        QTimer.singleShot(
            1800,
            lambda: self.toast_label.setVisible(False),
        )

    @Slot()
    def toggle_token_visibility(self) -> None:
        self.token_visible = not self.token_visible

        if self.token_visible:
            self.token_edit.setEchoMode(QLineEdit.Normal)
            self.show_token_button.setText("隐藏")
        else:
            self.token_edit.setEchoMode(QLineEdit.Password)
            self.show_token_button.setText("显示")

    @Slot()
    def copy_token(self) -> None:
        self.copy_with_feedback(
            self.copy_token_button,
            self.token,
            "Token 已复制到剪贴板",
        )

    @Slot()
    def regenerate_token(self) -> None:
        answer = QMessageBox.question(
            self,
            "重新生成 Token",
            "重新生成后，服务器上的旧 Token 将立即失效。"
            "\n是否继续？",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )

        if answer != QMessageBox.Yes:
            return

        self.token = regenerate_token()

        if self.server_worker is not None:
            self.server_worker.update_token(self.token)

        self.refresh_display()
        self.append_log(
            "warn",
            "Token 已重新生成，旧 Token 立即失效",
        )

        # 若之前部署过服务器：settings.json 的钩子命令和 shell rc
        # 环境变量里嵌的还是旧 Token，必须重新部署才能同步。
        if DEPLOY_CACHE_FILE.exists():
            answer = QMessageBox.question(
                self,
                "需要重新部署",
                "Token 已重新生成。\n\n"
                "服务器上的钩子配置和 Shell 环境变量里仍是旧 Token，"
                "重新部署前审批推送会认证失败。\n\n"
                "是否现在打开部署窗口同步到新 Token？",
                QMessageBox.Yes | QMessageBox.No,
                QMessageBox.Yes,
            )

            if answer == QMessageBox.Yes:
                self.open_deploy_dialog()
        else:
            self.show_toast("Token 已重新生成")

    # ------------------------------------------------------------------
    # 窗口与退出
    # ------------------------------------------------------------------

    @Slot()
    def open_log_directory(self) -> None:
        if not PLATFORM.open_path(APP_DATA_DIR):
            self.append_log(
                "warn",
                f"当前平台无法自动打开目录：{APP_DATA_DIR}",
            )

    @Slot()
    def show_window(self) -> None:
        self.showNormal()
        self.raise_()
        self.activateWindow()

    @Slot(QSystemTrayIcon.ActivationReason)
    def on_tray_activated(
        self,
        reason: QSystemTrayIcon.ActivationReason,
    ) -> None:
        if reason in (
            QSystemTrayIcon.Trigger,
            QSystemTrayIcon.DoubleClick,
        ):
            self.show_window()

    @Slot()
    def confirm_exit(self) -> None:
        answer = QMessageBox.question(
            self,
            "退出",
            "确定要退出吗？退出后将不再接收通知。",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )

        if answer == QMessageBox.Yes:
            self.exit_application()

    @Slot()
    def exit_application(self) -> None:
        self.force_exit = True
        self.hide()

        # 唤醒所有挂起的审批请求，避免服务器钩子长时间等待
        self.dismiss_all_approvals()
        self.dismiss_all_stage_completion_popups()

        app = QApplication.instance()
        stopped = self.stop_local_server(timeout_ms=6000)
        if not stopped:
            # 宁愿不退出，也不能在 QThread 仍运行时销毁 QCoreApplication
            self.force_exit = False
            self.show()
            self.append_log("error", "退出已取消：本地服务线程仍未停止。")
            return

        QTimer.singleShot(0, app.quit)

    def closeEvent(self, event: QCloseEvent) -> None:
        if self.force_exit:
            event.accept()
            return

        event.ignore()
        self.hide()

        self.tray_icon.showMessage(
            APP_NAME,
            "程序仍在后台运行，可通过系统托盘重新打开。",
            QSystemTrayIcon.Information,
            3000,
        )


# ============================================================================
# 主程序
# ============================================================================

def main() -> int:
    def write_crash_log(text: str) -> None:
        try:
            APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
            (APP_DATA_DIR / "startup-crash.log").write_text(
                text,
                encoding="utf-8",
            )
        except Exception:
            pass

    def excepthook(exc_type, exc_value, exc_tb) -> None:
        write_crash_log(
            "".join(
                traceback.format_exception(
                    exc_type,
                    exc_value,
                    exc_tb,
                )
            )
        )
        sys.__excepthook__(exc_type, exc_value, exc_tb)

    sys.excepthook = excepthook

    app = QApplication(sys.argv)

    # 关闭最后一个窗口时不退出，继续驻留托盘。
    app.setQuitOnLastWindowClosed(False)
    app.setApplicationName(APP_NAME)
    app.setStyleSheet(STYLE_SHEET)

    if not QSystemTrayIcon.isSystemTrayAvailable():
        QMessageBox.critical(
            None,
            APP_NAME,
            "当前系统不可用系统托盘。",
        )
        return 1

    try:
        window = MainWindow()
        window.show()
    except Exception:
        write_crash_log(traceback.format_exc())
        raise

    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
