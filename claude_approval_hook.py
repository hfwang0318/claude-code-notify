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
    - PreToolUse（matcher=AskUserQuestion）：Claude 提问代答，
      回答经 allow + updatedInput(answers) 返回，工具不再弹交互 UI；
      此场景下 PermissionRequest 不会再触发（无对话框）
配置来源（优先级从高到低）：
    1. 环境变量（远程部署的 settings.json 会把 Token 内联进 hook 命令）
    2. 脚本同目录的 claude_notify_config.json（本机接入时由部署功能写入，
       Windows 上 setx 环境变量需要重启进程才生效，配置文件则立即生效）

环境变量 / 配置文件键：
    CLAUDE_NOTIFY_TOKEN      必填，Windows 端显示的 Token
    CLAUDE_APPROVAL_URL      可选，默认 http://localhost:18765/claude-approval
                             （与 Claude Code 同机时；远程时填 Windows 的 IP）
    CLAUDE_APPROVAL_TIMEOUT  可选，秒，默认 240（须小于钩子的 timeout）
    CLAUDE_APPROVAL_MATCHER  可选，逗号分隔的工具名，只对匹配的工具转发；
                             默认全部转发。例：Bash,Edit,Write

探测开关（仅排障/协议调研用）：
    环境变量 CLAUDE_NOTIFY_HOOK_DUMP=1 或配置文件加 "hook_dump": true 时，
    每次钩子输入原样追加到 ~/.claude-notify/hook-stdin.jsonl（每行一条
    JSON），用于确认 permission_suggestions 真实结构、某工具是否触发
    PermissionRequest 等。平时保持关闭。
"""

import json
import os
import sys
import time
import urllib.request
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
TOKEN = cfg("CLAUDE_NOTIFY_TOKEN")
TIMEOUT = int(cfg("CLAUDE_APPROVAL_TIMEOUT", "240"))

MATCHER_RAW = cfg("CLAUDE_APPROVAL_MATCHER")
MATCHED_TOOLS = {
    name.strip() for name in MATCHER_RAW.split(",") if name.strip()
}


def note(message: str) -> None:
    """诊断信息写 stderr：不污染 stdout 协议输出，claude --debug 可见。"""
    print(f"[claude-approval-hook] {message}", file=sys.stderr)


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
        if os.name == "nt":
            home = os.environ.get("USERPROFILE") or os.path.expanduser("~")
        else:
            home = os.path.expanduser("~")
        dump_dir = os.path.join(home, ".claude-notify")
        os.makedirs(dump_dir, exist_ok=True)
        record = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "event": hook_input.get("hook_event_name"),
            "tool": hook_input.get("tool_name"),
            "raw": hook_input,
        }
        dump_path = os.path.join(dump_dir, "hook-stdin.jsonl")
        with open(dump_path, "a", encoding="utf-8") as file:
            file.write(json.dumps(record, ensure_ascii=False) + "\n")
        note(f"dump → {dump_path}")
    except Exception:
        pass


def emit_allow(updated_permissions: Optional[list] = None) -> None:
    """
    按 PermissionRequest 钩子协议输出允许决定。
    updated_permissions 为用户选择的 permission_suggestion 原对象
    （不透明 echo，等价于用户在终端对话框点对应“始终允许”）。
    """
    decision: dict = {"behavior": "allow"}
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
) -> None:
    """把桌面端的决定映射为 PermissionRequest 协议输出。"""
    decision = result.get("decision")

    if decision == "allow":
        emit_allow()
    elif decision == "deny":
        emit_deny("用户在桌面通知端拒绝了此操作")
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
    tool_name = hook_input.get("tool_name") or ""

    # PermissionRequest 通道下 AskUserQuestion 让位给 PreToolUse 代答
    # （部署时两条通道一起配置并以 CLAUDE_ASKUSER_CHANNEL 标记）——
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

    payload = {
        "session_id": hook_input.get("session_id"),
        "cwd": hook_input.get("cwd"),
        "tool_name": tool_name,
        "tool_input": tool_input,
        "message": message,
        "options": build_options(tool_name),
        "timeout_seconds": TIMEOUT - 10,
        "kind": kind,
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

    # ---- 等待 Windows 端的用户决定 ----
    try:
        with urllib.request.urlopen(
            request,
            timeout=TIMEOUT,
        ) as response:
            result = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        note(f"请求 {WINDOWS_URL} 失败：{exc}，交给终端处理")
        sys.exit(0)  # 网络失败/超时 → 交给终端

    # ---- 按事件通道映射输出 ----
    if not isinstance(result, dict):
        note("桌面端响应不是合法 JSON 对象，交给终端处理")
        sys.exit(0)

    if event == "PreToolUse":
        handle_result_pretooluse(result, questions)
    else:
        handle_result(result, suggestions)

    sys.exit(0)


if __name__ == "__main__":
    main()
