"""Claude Code hook installation and settings merge use cases."""
import glob
import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional
from ..config import APP_DATA_DIR

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
        DEPLOY_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
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
        return build_exec_hook_entry(
            resolve_local_python(),
            script_path,
        )
    return build_shell_hook_entry(
        env_pairs,
        script_path,
        local_python_command(),
    )


def build_exec_hook_entry(
    python_executable: str,
    script_path: Path,
) -> dict[str, Any]:
    """生成不经过 shell 的本机 Hook handler。"""
    return {
        "type": "command",
        "command": python_executable,
        "args": [str(script_path)],
    }


def build_shell_hook_entry(
    env_pairs: dict[str, Any],
    script_path: Path,
    python_command: str = "python3",
) -> dict[str, Any]:
    """生成 POSIX shell form 的本机 Hook handler。"""
    parts = [
        f"{key}={shlex.quote(str(value))}"
        for key, value in env_pairs.items()
    ]
    parts.append(
        f"{python_command} {shlex.quote(str(script_path))}"
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
