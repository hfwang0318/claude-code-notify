#!/usr/bin/env python3
"""
Claude Code Notification 钩子：把通知单向 POST 到 Windows 托盘应用。

与 claude_approval_hook.py 的区别：这是"通知中心模式"——
只把 Claude Code 的通知转发到 Windows 通知中心做提醒，
不等待用户决定、不干预审批流程（审批仍在终端里完成）。

任何失败都安静退出，不影响 Claude Code 正常运行。
失败原因会写到 stderr，可用 claude --debug 查看。

配置来源（优先级从高到低）：
    1. 环境变量（远程部署的 settings.json 会把 Token 内联进 hook 命令）
    2. 脚本同目录的 claude_notify_config.json（本机接入时由部署功能写入）

环境变量 / 配置文件键：
    CLAUDE_NOTIFY_TOKEN   必填，Windows 端显示的 Token
    CLAUDE_NOTIFY_URL     可选，默认 http://localhost:18765/claude-notify
"""

import json
import os
import re
import socket
import sys
import urllib.request

CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "claude_notify_config.json",
)


def load_config() -> dict:
    """读取脚本同目录的配置文件（本机接入时写入），不存在则返回空。"""
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as file:
            data = json.load(file)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


CONFIG = load_config()
HOOK_VERSION = "9"
TASK_MAX_CHARS = 60
TASK_TAIL_BYTES = 256 * 1024


# Keep these four helpers in sync with claude_approval_hook.py. The two hooks
# are deployed as standalone files, so they cannot share a module.
def _clean_task_text(text: str) -> str:
    text = re.sub(
        r"<system-reminder>.*?</system-reminder>", " ", text, flags=re.S | re.I
    )
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"<[^>]{1,120}>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text.lstrip("#>-* ").strip()


def _is_noise_prompt(text: str) -> bool:
    probe = text.lstrip()
    return (
        not probe
        or probe.startswith("<")
        or probe.startswith("Caveat:")
        or probe.startswith("[Request interrupted")
        or probe.startswith("This session is being continued")
        or "<command-name>" in probe[:400]
        or "<local-command-stdout>" in probe[:400]
    )


# Keep in sync with claude_approval_hook.py: a bare "继续/ok" is a bad title.
_CONFIRMATION_PROMPTS = {
    "继续",
    "继续吧",
    "继续执行",
    "继续做",
    "接着",
    "好的",
    "好的继续",
    "好",
    "好继续",
    "可以",
    "可以继续",
    "行",
    "嗯",
    "嗯嗯",
    "对",
    "是",
    "是的",
    "没问题",
    "辛苦了",
    "谢谢",
    "ok",
    "okay",
    "sure",
    "yes",
    "y",
    "go",
    "go on",
    "continue",
    "proceed",
    "run it",
    "do it",
    "sounds good",
    "lgtm",
}


def _is_confirmation_prompt(text: str) -> bool:
    probe = re.sub(r"[!！。,.，?？~～、；;：:]+", "", text)
    probe = re.sub(r"\s+", " ", probe).strip().lower()
    return probe in _CONFIRMATION_PROMPTS


def task_summary(transcript_path: str) -> str:
    if not transcript_path:
        return ""
    try:
        size = os.path.getsize(transcript_path)
        with open(transcript_path, "rb") as file:
            if size > TASK_TAIL_BYTES:
                file.seek(size - TASK_TAIL_BYTES)
            data = file.read().decode("utf-8", "ignore")
    except (OSError, ValueError):
        return ""
    for raw_line in reversed(data.splitlines()):
        try:
            entry = json.loads(raw_line)
        except (TypeError, ValueError):
            continue
        if not isinstance(entry, dict):
            continue
        if entry.get("type") == "last-prompt":
            prompt = entry.get("lastPrompt")
            if (
                isinstance(prompt, str)
                and not _is_noise_prompt(prompt)
                and not _is_confirmation_prompt(prompt)
            ):
                cleaned = _clean_task_text(prompt)
                if cleaned:
                    return cleaned[:TASK_MAX_CHARS]
            continue
        if entry.get("type") != "user":
            continue
        if entry.get("isMeta") or entry.get("isSidechain"):
            continue
        message = entry.get("message")
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if (
            not isinstance(content, str)
            or _is_noise_prompt(content)
            or _is_confirmation_prompt(content)
        ):
            continue
        cleaned = _clean_task_text(content)
        if cleaned:
            return cleaned[:TASK_MAX_CHARS]
    return ""


def _read_git_head(head_path: str) -> str:
    try:
        with open(head_path, "r", encoding="utf-8", errors="ignore") as file:
            head = file.read(300).strip()
    except OSError:
        return ""
    if head.startswith("ref:"):
        ref = head[len("ref:") :].strip()
        if ref.startswith("refs/heads/"):
            return ref[len("refs/heads/") :]
        return ref.rsplit("/", 1)[-1]
    return head[:8]


def git_branch(cwd: str) -> str:
    if not cwd:
        return ""
    try:
        directory = os.path.abspath(os.path.expanduser(cwd))
    except (TypeError, ValueError):
        return ""
    for _ in range(8):
        dotgit = os.path.join(directory, ".git")
        try:
            if os.path.isdir(dotgit):
                return _read_git_head(os.path.join(dotgit, "HEAD"))
            if os.path.isfile(dotgit):
                with open(dotgit, "r", encoding="utf-8", errors="ignore") as file:
                    content = file.read(300).strip()
                if content.startswith("gitdir:"):
                    gitdir = content[len("gitdir:") :].strip()
                    if not os.path.isabs(gitdir):
                        gitdir = os.path.normpath(os.path.join(directory, gitdir))
                    return _read_git_head(os.path.join(gitdir, "HEAD"))
        except OSError:
            return ""
        parent = os.path.dirname(directory)
        if parent == directory:
            break
        directory = parent
    return ""


def cfg(name: str, default: str = "") -> str:
    """环境变量优先，配置文件兜底。"""
    value = os.environ.get(name)
    if value:
        return value
    return str(CONFIG.get(name, default))


WINDOWS_URL = cfg(
    "CLAUDE_NOTIFY_URL",
    "http://localhost:18765/claude-notify",
)
TOKEN = cfg("CLAUDE_NOTIFY_TOKEN")
TIMEOUT = 10


def note(message: str) -> None:
    """诊断信息写 stderr：不污染 stdout 协议输出，claude --debug 可见。"""
    print(f"[claude-notify-hook] {message}", file=sys.stderr)


def main() -> None:
    try:
        hook_input = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        note("stdin 不是合法 JSON，跳过本次通知")
        sys.exit(0)

    if not TOKEN:
        note(
            "缺少 CLAUDE_NOTIFY_TOKEN（环境变量与 "
            f"{CONFIG_PATH} 均未配置），跳过本次通知"
        )
        sys.exit(0)

    term = os.environ.get("TERM", "")
    if term.lower() in ("dumb", "unknown"):
        term = ""
    terminal = (
        os.environ.get("TERM_PROGRAM")
        or ("Windows Terminal" if os.environ.get("WT_SESSION") else "")
        or ("tmux" if os.environ.get("TMUX") else "")
        or term
    )
    tty = (
        os.environ.get("TTY")
        or os.environ.get("SSH_TTY")
        or os.environ.get("TMUX_PANE")
        or os.environ.get("TERM_SESSION_ID")
        or os.environ.get("WT_SESSION")
        or ""
    )
    payload = {
        "session_id": hook_input.get("session_id"),
        "origin": (os.environ.get("CLAUDE_NOTIFY_ORIGIN") or CONFIG.get("CLAUDE_NOTIFY_ORIGIN") or socket.gethostname() or "远程"),
        "terminal": terminal,
        "tty": tty[5:] if tty.startswith("/dev/") else tty,
        "hook_version": HOOK_VERSION,
        "cwd": hook_input.get("cwd"),
        "transcript_path": hook_input.get("transcript_path"),
        "task": task_summary(str(hook_input.get("transcript_path") or "")),
        "branch": git_branch(str(hook_input.get("cwd") or "")),
        "message": hook_input.get("message"),
        "notification_type": (
            hook_input.get("notification_type")
            or hook_input.get("hook_event_name")
            or "notification"
        ),
        "matcher": hook_input.get("hook_event_name"),
    }

    request = urllib.request.Request(
        WINDOWS_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT):
            pass
    except Exception as exc:
        note(f"请求 {WINDOWS_URL} 失败：{exc}")
        # 单向通知，失败不影响 Claude Code

    sys.exit(0)


if __name__ == "__main__":
    main()
