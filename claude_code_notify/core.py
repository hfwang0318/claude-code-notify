"""Dependency-light shared utilities."""
import json
import secrets
import socket
import sys
from pathlib import Path
from typing import Any
from .config import TOKEN_FILE

def resource_path(relative_path: str) -> Path:
    """获取开发环境或 PyInstaller 打包后的资源路径。"""
    if hasattr(sys, "_MEIPASS"):
        base_path = Path(getattr(sys, "_MEIPASS"))
    else:
        base_path = Path(__file__).resolve().parent.parent

    return base_path / relative_path



def load_or_create_token() -> str:
    """Token 文件存在时复用，不存在时创建。"""
    if TOKEN_FILE.exists():
        token = TOKEN_FILE.read_text(encoding="utf-8").strip()

        if token:
            return token

    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    TOKEN_FILE.write_text(token + "\n", encoding="utf-8")

    return token


def regenerate_token() -> str:
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
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
