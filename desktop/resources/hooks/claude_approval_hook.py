#!/usr/bin/env python3
"""
Claude Code PermissionRequest 钩子：把权限审批转发到 Windows 桌面。

为什么用 PermissionRequest 而不是 PreToolUse：
PreToolUse 在每次工具调用时都触发（包括不需要审批的调用），误判多、
打扰频繁；PermissionRequest 只在 Claude Code 真正要弹权限对话框时
才触发，时机精确。

工作流程：
1. Claude Code 触发 PermissionRequest 钩子时，把工具调用信息以 JSON
   写入本脚本 stdin
2. 本脚本 POST 到 Windows 机器的 /claude-approval，HTTP 连接保持挂起
3. Windows 端弹出置顶小窗，用户点击按钮后 HTTP 响应返回 decision
4. 本脚本把 decision 转成 hookSpecificOutput.decision.behavior 输出给
   Claude Code

任何失败（网络不通、超时、用户关闭弹窗）都安静退出、不在 stdout 输出
任何内容，Claude Code 会按默认流程在终端里正常弹出权限提示 —— 绝不卡死。
失败原因会写到 stderr，可用 claude --debug 查看。

配置（服务器 ~/.claude/settings.json，由 Windows 端部署功能自动写入）：

    {
      "hooks": {
        "PermissionRequest": [
          {
            "matcher": "",
            "hooks": [
              {
                "type": "command",
                "command": "python3 ~/.claude/claude_approval_hook.py",
                "timeout": 300
              }
            ]
          }
        ]
      }
    }

本脚本同时服务两个钩子事件（按 stdin 的 hook_event_name 区分）：
    - PermissionRequest：权限审批（含 suggestion 动态选项）
    - PreToolUse：普通工具只记录官方 tool_use_id 后立即退出，用于把
      PermissionRequest 与 transcript 中的终端处理结果关联；
      AskUserQuestion 仍走桌面代答，回答经 allow + updatedInput(answers)
      返回，工具不再弹交互 UI
配置来源（优先级从高到低）：
    1. 环境变量（远程部署的 settings.json 会把 Token 内联进 hook 命令）
    2. 脚本同目录的 claude_notify_config.json（本机接入时由部署功能写入，
       Windows 上 setx 环境变量需要重启进程才生效，配置文件则立即生效）

环境变量 / 配置文件键：
    CLAUDE_NOTIFY_TOKEN      必填，Windows 端显示的 Token
    CLAUDE_APPROVAL_URL      可选，默认 http://localhost:18765/claude-approval
                             （与 Claude Code 同机时；远程时填 Windows 的 IP）
    CLAUDE_APPROVAL_RESOLUTION_URL
                             可选，默认与审批 URL 同主机的
                             /claude-approval-resolved
    CLAUDE_APPROVAL_TIMEOUT  可选，秒，默认 240（须小于钩子的 timeout）
    CLAUDE_APPROVAL_MATCHER  可选，逗号分隔的工具名，只对匹配的工具转发；
                             默认全部转发。例：Bash,Edit,Write

探测开关（仅排障/协议调研用）：
    环境变量 CLAUDE_NOTIFY_HOOK_DUMP=1 或配置文件加 "hook_dump": true 时，
    每次钩子输入原样追加到 ~/.claude-notify/hook-stdin.jsonl（每行一条
    JSON），用于确认 permission_suggestions 真实结构、某工具是否触发
    PermissionRequest 等。平时保持关闭。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
import uuid
from contextlib import contextmanager
from typing import Optional

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


def cfg(name: str, default: str = "") -> str:
    """环境变量优先，配置文件兜底。"""
    value = os.environ.get(name)
    if value:
        return value
    return str(CONFIG.get(name, default))


WINDOWS_URL = cfg(
    "CLAUDE_APPROVAL_URL",
    "http://localhost:18765/claude-approval",
)
RESOLUTION_URL = cfg(
    "CLAUDE_APPROVAL_RESOLUTION_URL",
    WINDOWS_URL.rsplit("/", 1)[0] + "/claude-approval-resolved",
)
TOKEN = cfg("CLAUDE_NOTIFY_TOKEN")
TIMEOUT = int(cfg("CLAUDE_APPROVAL_TIMEOUT", "240"))
# The popup countdown can be paused for long typing; keep the HTTP request
# alive longer than the initial approval window. The Claude Code hook timeout
# in settings.json gets the same budget added by the deploy code.
PAUSE_BUDGET_SEC = 600
SOCKET_TIMEOUT = TIMEOUT + PAUSE_BUDGET_SEC + 30
HOOK_VERSION = "9"
CURRENT_EVENT = ""

TASK_MAX_CHARS = 60
INTENT_MAX_CHARS = 160
TASK_TAIL_BYTES = 256 * 1024


def _clean_task_text(text: str) -> str:
    """把一条用户输入压成适合弹窗单行展示的摘要。"""
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


# "继续/ok" is a real user message, but a terrible task title: the popup would
# say the session is working on "继续". Skip confirmation-only prompts and keep
# scanning for the last substantive request instead.
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


def _read_transcript_lines(transcript_path: str) -> list[str]:
    if not transcript_path:
        return []
    try:
        size = os.path.getsize(transcript_path)
        with open(transcript_path, "rb") as file:
            if size > TASK_TAIL_BYTES:
                file.seek(size - TASK_TAIL_BYTES)
            data = file.read().decode("utf-8", "ignore")
    except (OSError, ValueError):
        return []
    return data.splitlines()


def task_summary(transcript_path: str) -> str:
    """从 transcript 末尾取最近一条真实用户输入，作为“这个会话在做什么”。"""
    # Claude Code 会在 transcript 末尾写一条 last-prompt；它比原始 user 消息
    # 更靠近文件尾部，不会被大量 tool_result/api-request 挤出读取窗口。
    # 找不到时再退回最后一条字符串 content 的 user 消息。
    for raw_line in reversed(_read_transcript_lines(transcript_path)):
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


def assistant_intent(transcript_path: str) -> str:
    """最近一条 assistant 文本，作为“为什么现在要做这次操作”的说明。

    只看最后一条 assistant 消息：更早的 assistant 文本属于上一轮，拿来当
    当前审批的背景会误导用户。没有文本（只有 tool_use）时返回空。
    """
    for raw_line in reversed(_read_transcript_lines(transcript_path)):
        try:
            entry = json.loads(raw_line)
        except (TypeError, ValueError):
            continue
        if not isinstance(entry, dict) or entry.get("type") != "assistant":
            continue
        if entry.get("isMeta") or entry.get("isSidechain"):
            continue
        message = entry.get("message")
        if not isinstance(message, dict):
            return ""
        content = message.get("content")
        texts: list[str] = []
        if isinstance(content, str):
            texts.append(content)
        elif isinstance(content, list):
            for block in content:
                if (
                    isinstance(block, dict)
                    and block.get("type") == "text"
                    and isinstance(block.get("text"), str)
                ):
                    texts.append(block["text"])
        cleaned = _clean_task_text(" ".join(texts))
        if cleaned and not _is_noise_prompt(cleaned):
            return cleaned[:INTENT_MAX_CHARS]
        return ""
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
    """读取工作目录的当前分支；直接读 .git，避免每个审批都启动 git 进程。"""
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


def session_environment() -> dict:
    """尽量在不依赖外部命令的情况下识别终端，便于多会话区分。"""
    import socket

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
    if tty and tty.startswith("/dev/"):
        tty = tty[5:]
    origin = cfg("CLAUDE_NOTIFY_ORIGIN") or socket.gethostname() or "远程"
    return {"origin": origin, "terminal": terminal, "tty": tty}

MATCHER_RAW = cfg("CLAUDE_APPROVAL_MATCHER")
MATCHED_TOOLS = {
    name.strip() for name in MATCHER_RAW.split(",") if name.strip()
}


def note(message: str) -> None:
    """诊断信息写 stderr：不污染 stdout 协议输出，claude --debug 可见。"""
    print(f"[claude-approval-hook] {message}", file=sys.stderr)


def _ensure_private_dir(path: str) -> None:
    os.makedirs(path, mode=0o700, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


def data_dir() -> str:
    """返回稳定的本机状态目录；Windows 不受 Git Bash HOME 影响。"""
    override = os.environ.get("CLAUDE_NOTIFY_DATA_DIR")
    if override:
        _ensure_private_dir(override)
        return override
    if os.name == "nt":
        home = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    else:
        home = os.path.expanduser("~")
    path = os.path.join(home, ".claude-notify")
    _ensure_private_dir(path)
    return path


SYNC_JOURNAL_PATH = os.path.join(data_dir(), "approval-sync.jsonl")
SYNC_LOCK_PATH = os.path.join(data_dir(), "approval-sync.lock")
SYNC_MAX_BYTES = 512 * 1024
SYNC_RETENTION_SEC = 3600


def tool_input_hash(tool_input: dict) -> str:
    canonical = json.dumps(
        tool_input,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _read_journal() -> list:
    entries = []
    try:
        with open(SYNC_JOURNAL_PATH, "r", encoding="utf-8") as file:
            for line in file:
                try:
                    entry = json.loads(line)
                except (TypeError, ValueError):
                    continue
                if isinstance(entry, dict) and entry.get("request_id"):
                    entries.append(entry)
    except OSError:
        return []
    return entries


def _write_journal(entries: list) -> None:
    temp = f"{SYNC_JOURNAL_PATH}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    with open(temp, "w", encoding="utf-8") as file:
        for entry in entries:
            file.write(json.dumps(entry, ensure_ascii=False) + "\n")
    try:
        os.chmod(temp, 0o600)
    except OSError:
        pass
    os.replace(temp, SYNC_JOURNAL_PATH)


@contextmanager
def journal_lock():
    """Cross-platform exclusive lock; the journal is only touched on approval events."""
    deadline = time.time() + 2
    while True:
        try:
            fd = os.open(SYNC_LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(fd)
            break
        except FileExistsError:
            try:
                if time.time() - os.path.getmtime(SYNC_LOCK_PATH) > 5:
                    os.unlink(SYNC_LOCK_PATH)
                    continue
            except OSError:
                pass
            if time.time() >= deadline:
                yield False
                return
            time.sleep(0.02)
    try:
        yield True
    finally:
        try:
            os.unlink(SYNC_LOCK_PATH)
        except OSError:
            pass


def _compact_journal(entries: list) -> list:
    cutoff = time.time() - SYNC_RETENTION_SEC
    return [
        entry
        for entry in entries
        if float(entry.get("created_at") or 0) >= cutoff
    ]


def record_pretooluse(hook_input: dict, tool_input: dict) -> Optional[str]:
    """Append the official tool_use_id to a tiny journal; no sqlite dependency."""
    tool_use_id = str(hook_input.get("tool_use_id") or "").strip()
    if not tool_use_id:
        note(
            "PreToolUse 输入缺少 tool_use_id；需要 Claude Code 2.0.43+，"
            "本次审批无法自动同步关闭"
        )
        return None

    request_id = uuid.uuid4().hex
    entry = {
        "request_id": request_id,
        "session_id": str(hook_input.get("session_id") or ""),
        "prompt_id": str(hook_input.get("prompt_id") or ""),
        "tool_name": str(hook_input.get("tool_name") or ""),
        "input_hash": tool_input_hash(tool_input),
        "tool_use_id": tool_use_id,
        "transcript_path": str(hook_input.get("transcript_path") or ""),
        "created_at": time.time(),
    }
    try:
        try:
            if os.path.getsize(SYNC_JOURNAL_PATH) > SYNC_MAX_BYTES:
                with journal_lock() as locked:
                    if locked:
                        _write_journal(_compact_journal(_read_journal()))
        except OSError:
            pass
        fd = os.open(
            SYNC_JOURNAL_PATH,
            os.O_APPEND | os.O_CREAT | os.O_WRONLY,
            0o600,
        )
        with os.fdopen(fd, "a", encoding="utf-8") as file:
            file.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError as exc:
        note(f"保存 tool_use_id 关联失败：{exc}")
        return None
    return request_id


def claim_pretooluse(hook_input: dict, tool_input: dict) -> Optional[dict]:
    """Atomically claim the newest matching PreToolUse record."""
    session_id = str(hook_input.get("session_id") or "")
    prompt_id = str(hook_input.get("prompt_id") or "")
    tool_name = str(hook_input.get("tool_name") or "")
    input_hash = tool_input_hash(tool_input)
    cutoff = time.time() - 120

    try:
        with journal_lock() as locked:
            if not locked:
                note("关联日志被占用，本次审批按 unmatched 处理")
                return None
            entries = _read_journal()
            candidates = [
                entry
                for entry in entries
                if entry.get("session_id") == session_id
                and entry.get("tool_name") == tool_name
                and entry.get("input_hash") == input_hash
                and float(entry.get("created_at") or 0) >= cutoff
                and (
                    entry.get("prompt_id") == prompt_id
                    or entry.get("prompt_id") == ""
                )
            ]
            if not candidates:
                _write_journal(_compact_journal(entries))
                return None
            candidates.sort(
                key=lambda entry: (
                    entry.get("prompt_id") == prompt_id,
                    float(entry.get("created_at") or 0),
                ),
                reverse=True,
            )
            chosen = candidates[0]
            remaining = [
                entry for entry in entries if entry.get("request_id") != chosen.get("request_id")
            ]
            _write_journal(_compact_journal(remaining))
            return {
                "request_id": chosen.get("request_id"),
                "tool_use_id": chosen.get("tool_use_id"),
                "transcript_path": chosen.get("transcript_path"),
            }
    except OSError as exc:
        note(f"读取 tool_use_id 关联失败：{exc}")
        return None


def delete_correlation(request_id: str) -> None:
    if not request_id:
        return
    try:
        with journal_lock() as locked:
            if not locked:
                return
            entries = _read_journal()
            remaining = [
                entry for entry in entries if entry.get("request_id") != request_id
            ]
            if len(remaining) != len(entries):
                _write_journal(remaining)
    except OSError:
        pass


def contains_tool_result(value, tool_use_id: str) -> bool:
    """递归识别 transcript 消息中的目标 tool_result block。"""
    if isinstance(value, dict):
        if (
            value.get("type") == "tool_result"
            and value.get("tool_use_id") == tool_use_id
        ):
            return True
        return any(
            contains_tool_result(child, tool_use_id)
            for child in value.values()
        )
    if isinstance(value, list):
        return any(
            contains_tool_result(child, tool_use_id)
            for child in value
        )
    return False


def notify_terminal_resolved(
    request_id: str,
    tool_use_id: str,
    stop_event,
) -> None:
    """通知桌面端关闭对应弹窗；注册竞态时短暂重试。"""
    import urllib.error
    import urllib.request

    payload = json.dumps(
        {
            "request_id": request_id,
            "tool_use_id": tool_use_id,
            "source": "terminal",
        }
    ).encode("utf-8")
    for _ in range(20):
        if stop_event.is_set():
            return
        request = urllib.request.Request(
            RESOLUTION_URL,
            data=payload,
            headers={
                "Authorization": f"Bearer {TOKEN}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                if 200 <= response.status < 300:
                    return
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                return
        except Exception:
            pass
        stop_event.wait(0.25)


def watch_transcript(
    transcript_path: str,
    request_id: str,
    tool_use_id: str,
    stop_event,
) -> None:
    """监听当前调用的 tool_result；终端允许和拒绝都会产生该 block。"""
    if not transcript_path or not tool_use_id:
        return
    position = 0
    try:
        position = os.path.getsize(transcript_path)
    except OSError:
        pass
    buffered = b""

    while not stop_event.wait(0.2):
        try:
            size = os.path.getsize(transcript_path)
            if size < position:
                position = 0
                buffered = b""
            if size == position:
                continue
            with open(transcript_path, "rb") as file:
                file.seek(position)
                chunk = file.read()
                position = file.tell()
        except OSError:
            continue

        lines = (buffered + chunk).split(b"\n")
        buffered = lines.pop()
        for raw_line in lines:
            try:
                record = json.loads(raw_line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if contains_tool_result(record, tool_use_id):
                notify_terminal_resolved(
                    request_id,
                    tool_use_id,
                    stop_event,
                )
                return


def maybe_dump(hook_input: dict) -> None:
    """
    探测开关：env CLAUDE_NOTIFY_HOOK_DUMP=1 或配置文件 "hook_dump": true 时，
    把每次钩子输入追加到 ~/.claude-notify/hook-stdin.jsonl。
    放在 Token/Matcher 检查之前调用，保证任何触发都能被记录；
    任何失败都静默，绝不影响主流程。
    """
    enabled = os.environ.get("CLAUDE_NOTIFY_HOOK_DUMP") or CONFIG.get(
        "hook_dump"
    )
    if not enabled:
        return
    try:
        # Windows 上 expanduser("~") 优先读 HOME；Claude Code 若从
        # Git Bash 等启动会继承不同的 HOME，导致文件落到意外位置。
        # 固定用 USERPROFILE 保证路径确定。
        dump_dir = data_dir()
        record = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "event": hook_input.get("hook_event_name"),
            "tool": hook_input.get("tool_name"),
            "raw": hook_input,
        }
        dump_path = os.path.join(dump_dir, "hook-stdin.jsonl")
        fd = os.open(dump_path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as file:
            file.write(json.dumps(record, ensure_ascii=False) + "\n")
        note(f"dump → {dump_path}")
    except Exception:
        pass


def event_matches(expected: str) -> bool:
    """只允许返回本次 hook 实际收到的事件名，避免 Claude 报 event name 不匹配。"""
    if CURRENT_EVENT and CURRENT_EVENT != expected:
        note(f"skip {expected} output: current event is {CURRENT_EVENT}")
        return False
    return True


def emit_allow(
    updated_permissions: Optional[list] = None,
    updated_input: Optional[dict] = None,
) -> None:
    """
    按 PermissionRequest 钩子协议输出允许决定。
    updated_permissions 为用户选择的 permission_suggestion 原对象
    （不透明 echo，等价于用户在终端对话框点对应“始终允许”）。
    """
    if not event_matches("PermissionRequest"):
        return
    decision: dict = {"behavior": "allow"}
    if updated_input is not None:
        decision["updatedInput"] = updated_input
    if updated_permissions:
        decision["updatedPermissions"] = updated_permissions
    output = {
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": decision,
        }
    }
    print(json.dumps(output, ensure_ascii=False))


def emit_deny(reason: str) -> None:
    """按 PermissionRequest 钩子协议输出拒绝决定。"""
    if not event_matches("PermissionRequest"):
        return
    output = {
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": {
                "behavior": "deny",
                "message": reason,
            },
        }
    }
    print(json.dumps(output, ensure_ascii=False))


def build_options(tool_name: str) -> list[dict[str, str]]:
    """基础弹窗按钮：允许/拒绝。suggestion 选项由弹窗另行渲染。"""
    return [
        {"id": "allow", "label": "允许"},
        {"id": "deny", "label": "拒绝"},
    ]


def format_answer_message(answers: list) -> str:
    """
    AskUserQuestion 的答案通过 deny.message 回传（协议没有“代答”通道）。
    措辞必须让 Claude 明确：这是用户的答案，直接采纳继续，不要再次询问。
    """
    lines = [
        "用户已通过桌面弹窗直接回答了这个问题。"
        "请把以下内容当作用户本人的答案，直接采纳并继续，"
        "不要再次调用 AskUserQuestion 询问同一问题：",
    ]
    for item in answers:
        if not isinstance(item, dict):
            continue
        question = str(item.get("question") or "").strip()
        selected = item.get("selected") or []
        text = str(item.get("text") or "").strip()
        parts = [str(s) for s in selected if s]
        if text:
            parts.append(text)
        answer = "、".join(parts) if parts else "（用户未作答）"
        if question:
            lines.append(f"问：{question}")
        lines.append(f"答：{answer}")
    return "\n".join(lines)


def handle_result(
    result: dict,
    suggestions: list,
    tool_name: str = "",
    tool_input: Optional[dict] = None,
) -> None:
    """把桌面端的决定映射为 PermissionRequest 协议输出。"""
    decision = result.get("decision")

    if decision == "allow":
        if tool_name == "ExitPlanMode":
            # Claude Code 2.1.28x requires updatedInput for human-gated tools;
            # bare allow leaves the plan dialog open. setMode leaves plan mode.
            emit_allow(
                updated_permissions=[
                    {"type": "setMode", "mode": "default", "destination": "session"}
                ],
                updated_input=tool_input if isinstance(tool_input, dict) else {},
            )
        else:
            emit_allow()
    elif decision == "deny":
        reason = result.get("reason")
        message = (
            "用户在桌面通知端拒绝了此操作。用户说明："
            + str(reason).strip()
            if isinstance(reason, str) and reason.strip()
            else "用户在桌面通知端拒绝了此操作"
        )
        emit_deny(message[:2000])
    elif decision == "suggestion":
        # 用户点了某个“始终允许”：原样 echo 对应 suggestion
        index = result.get("index")
        if (
            isinstance(index, int)
            and 0 <= index < len(suggestions)
        ):
            emit_allow(updated_permissions=[suggestions[index]])
        else:
            note(f"suggestion 索引越界：{index!r}，回退终端")
        # 索引非法时不输出 → 回退终端
    elif decision == "answer":
        answers = result.get("answers")
        if isinstance(answers, list) and answers:
            emit_deny(format_answer_message(answers))
        # 空答案时不输出 → 回退终端
    # ask / timeout / dismissed / 其他：不输出，回退到终端正常提示


def emit_pretooluse_answer(questions: list, answers: list) -> None:
    """
    PreToolUse 代答输出：allow + updatedInput。
    官方约定：echo 原 questions 数组并附 answers 对象（问题文本 →
    选项 label；多选 label 逗号连接；自由文本直接作为值），工具收到
    后直接执行、不再弹任何交互 UI。
    """
    if not event_matches("PreToolUse"):
        return
    answer_map: dict = {}
    for item in answers:
        if not isinstance(item, dict):
            continue
        question = str(item.get("question") or "").strip()
        if not question:
            continue
        selected = item.get("selected") or []
        text = str(item.get("text") or "").strip()
        parts = [str(s) for s in selected if s]
        if text:
            parts.append(text)
        if parts:
            answer_map[question] = ", ".join(parts)

    if not answer_map:
        return  # 无有效答案 → 不输出，走正常交互流程

    output = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": "用户已通过桌面弹窗作答",
            "updatedInput": {
                "questions": questions,
                "answers": answer_map,
            },
        }
    }
    print(json.dumps(output, ensure_ascii=False))


def handle_result_pretooluse(result: dict, questions: list) -> None:
    """PreToolUse 通道的结果映射：只有 answer 有输出，其余静默。"""
    if result.get("decision") == "answer":
        answers = result.get("answers")
        if isinstance(answers, list) and answers:
            emit_pretooluse_answer(questions, answers)
    # ask / timeout / dismissed：不输出 → 正常交互流程（终端接管）


def bypasses_permission_prompt(hook_input: dict) -> bool:
    """判断当前 Claude Code 权限模式是否根本不需要审批弹窗。

    bypassPermissions（以及等价的 dontAsk）下 Claude Code 可能仍然触发
    PermissionRequest 钩子，但工具已经直接执行；此时再弹窗只会产生幽灵审批。
    """
    mode = str(
        hook_input.get("permission_mode")
        or hook_input.get("permissionMode")
        or ""
    )
    normalized = mode.replace("_", "").replace("-", "").lower()
    return normalized in {"bypasspermissions", "bypass", "dontask"}


def main() -> None:
    # ---- 读取钩子输入 ----
    try:
        hook_input = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        note("stdin 不是合法 JSON，交给终端处理")
        sys.exit(0)  # 解析失败 → 交给终端

    # 探测记录：在 Matcher/Token 检查之前，任何触发都留痕
    maybe_dump(hook_input)

    event = hook_input.get("hook_event_name") or ""
    global CURRENT_EVENT
    CURRENT_EVENT = event
    tool_name = hook_input.get("tool_name") or ""

    if event == "PermissionRequest" and bypasses_permission_prompt(hook_input):
        note(
            "permission_mode="
            f"{hook_input.get('permission_mode')}，无需审批，跳过桌面弹窗"
        )
        sys.exit(0)

    # PermissionRequest 通道下 AskUserQuestion 让位给 PreToolUse 代答
    # （部署时 PreToolUse observer 以 CLAUDE_ASKUSER_CHANNEL 标记）——
    # 否则用户在 PreToolUse 弹窗点「交给终端」后会再弹出第二个弹窗
    if (
        event == "PermissionRequest"
        and tool_name == "AskUserQuestion"
        and cfg("CLAUDE_ASKUSER_CHANNEL") == "pretooluse"
    ):
        note("AskUserQuestion 已由 PreToolUse 通道处理，本事件忽略")
        sys.exit(0)

    # 只转发匹配的工具（未配置 MATCHER 时全部转发）
    if MATCHED_TOOLS and tool_name not in MATCHED_TOOLS:
        sys.exit(0)

    if not TOKEN:
        note(
            "缺少 CLAUDE_NOTIFY_TOKEN（环境变量与 "
            f"{CONFIG_PATH} 均未配置），交给终端处理"
        )
        sys.exit(0)  # 未配置 Token → 交给终端

    tool_input = hook_input.get("tool_input")
    if not isinstance(tool_input, dict):
        tool_input = {}

    # 普通 PreToolUse 只记录官方 tool_use_id，绝不做审批决定。
    # AskUserQuestion 保留原有桌面代答流程。
    if event == "PreToolUse" and tool_name != "AskUserQuestion":
        record_pretooluse(hook_input, tool_input)
        sys.exit(0)

    # Heavy imports stay off the per-tool PreToolUse path; approvals are rare
    # enough that a few extra milliseconds here are irrelevant.
    import threading
    import urllib.error
    import urllib.request

    # ---- 场景识别：AskUserQuestion 提问 vs 普通权限审批 ----
    suggestions = hook_input.get("permission_suggestions")
    if not isinstance(suggestions, list):
        suggestions = []

    questions = tool_input.get("questions")
    if tool_name == "AskUserQuestion" and isinstance(questions, list):
        kind = "question"
        first = questions[0] if questions else {}
        if isinstance(first, dict):
            message = str(first.get("question") or "Claude 想问你一个问题")
        else:
            message = "Claude 想问你一个问题"
    else:
        kind = "permission"
        questions = []
        command = tool_input.get("command") or ""
        message = f"Claude Code 想要使用工具 {tool_name}"
        if command:
            message = f"Claude Code 想要执行：{command[:120]}"

    if event == "PreToolUse":
        correlation = {
            "request_id": uuid.uuid4().hex,
            "tool_use_id": str(hook_input.get("tool_use_id") or ""),
            "transcript_path": str(
                hook_input.get("transcript_path") or ""
            ),
        }
    else:
        correlation = claim_pretooluse(hook_input, tool_input) or {
            "request_id": uuid.uuid4().hex,
            "tool_use_id": "",
            "transcript_path": str(
                hook_input.get("transcript_path") or ""
            ),
        }
        if not correlation["tool_use_id"]:
            note(
                "未找到匹配的 PreToolUse/tool_use_id，"
                "本次审批保留原超时回退行为"
            )

    session_env = session_environment()
    transcript_path = str(
        correlation.get("transcript_path")
        or hook_input.get("transcript_path")
        or ""
    )
    cwd = str(hook_input.get("cwd") or "")
    payload = {
        "request_id": correlation["request_id"],
        "session_id": hook_input.get("session_id"),
        "prompt_id": hook_input.get("prompt_id"),
        "tool_use_id": correlation["tool_use_id"],
        "cwd": cwd,
        "transcript_path": transcript_path,
        # 多会话区分：任务摘要 + 分支，全部在钩子侧生成，只有短文本过网。
        "task": task_summary(transcript_path),
        "intent": assistant_intent(transcript_path),
        "branch": git_branch(cwd),
        "tool_name": tool_name,
        "tool_input": tool_input,
        "message": message,
        "options": build_options(tool_name),
        "timeout_seconds": TIMEOUT - 10,
        "kind": kind,
        "origin": session_env["origin"],
        "terminal": session_env["terminal"],
        "tty": session_env["tty"],
        "hook_version": HOOK_VERSION,
        "correlation": "exact" if correlation["tool_use_id"] else "unmatched",
        # 不透明转发：弹窗展示标签，选中后由本脚本原样 echo
        "suggestions": suggestions,
        "questions": questions,
    }

    request = urllib.request.Request(
        WINDOWS_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
        },
    )

    stop_watcher = threading.Event()
    watcher = threading.Thread(
        target=watch_transcript,
        args=(
            correlation["transcript_path"],
            correlation["request_id"],
            correlation["tool_use_id"],
            stop_watcher,
        ),
        daemon=True,
    )
    watcher.start()

    # ---- 等待 Windows 端的用户决定 ----
    try:
        with urllib.request.urlopen(
            request,
            timeout=SOCKET_TIMEOUT,
        ) as response:
            result = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        note(f"请求 {WINDOWS_URL} 失败：{exc}，交给终端处理")
        sys.exit(0)  # 网络失败/超时 → 交给终端
    finally:
        stop_watcher.set()
        watcher.join(timeout=1)
        delete_correlation(correlation["request_id"])

    # ---- 按事件通道映射输出 ----
    if not isinstance(result, dict):
        note("桌面端响应不是合法 JSON 对象，交给终端处理")
        sys.exit(0)

    if event == "PreToolUse":
        handle_result_pretooluse(result, questions)
    else:
        handle_result(result, suggestions, tool_name, tool_input)

    sys.exit(0)


if __name__ == "__main__":
    main()
