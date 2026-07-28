"""Platform adapters for installing the local Claude Code integration."""
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from ..application.hooks import (
    ENV_MARK_BEGIN,
    ENV_MARK_END,
    SHELL_RC_FILES,
    build_env_block,
    build_exec_hook_entry,
    build_shell_hook_entry,
    resolve_local_python,
)


class LocalIntegrationAdapter:
    """Stable port used by presentation during local Hook installation."""

    env_option_text = "同时写入本机环境变量（可选）"
    requires_shell_selection = False

    def prepare_directory(self, path: Path) -> None:
        """Apply platform-appropriate protection to a created directory."""

    def prepare_executable(self, path: Path) -> None:
        """Make an installed Hook executable when the platform requires it."""

    def protect_config(self, path: Path) -> None:
        """Protect a file containing the local Token."""

    def build_hook_entry(
        self,
        env_pairs: dict[str, Any],
        script_path: Path,
    ) -> dict[str, Any]:
        raise NotImplementedError

    def hook_description(self, hook_entry: dict[str, Any]) -> str | None:
        return None

    def verify_hook(
        self,
        script_path: Path,
        hook_entry: dict[str, Any],
    ) -> None:
        raise NotImplementedError

    def write_environment(
        self,
        token: str,
        shells: list[str],
    ) -> list[str]:
        raise NotImplementedError


class WindowsLocalIntegration(LocalIntegrationAdapter):
    env_option_text = (
        "同时将 Token 写入用户环境变量"
        "（可选；钩子默认读配置文件，环境变量仅供手动调试）"
    )

    def build_hook_entry(
        self,
        env_pairs: dict[str, Any],
        script_path: Path,
    ) -> dict[str, Any]:
        del env_pairs
        return build_exec_hook_entry(resolve_local_python(), script_path)

    def hook_description(self, hook_entry: dict[str, Any]) -> str:
        return (
            f"钩子解释器：{hook_entry['command']}"
            "（绝对路径，exec form）"
        )

    def verify_hook(
        self,
        script_path: Path,
        hook_entry: dict[str, Any],
    ) -> None:
        _run_compile_check(str(hook_entry["command"]), script_path)

    def write_environment(
        self,
        token: str,
        shells: list[str],
    ) -> list[str]:
        del shells
        subprocess.run(
            ["setx", "CLAUDE_NOTIFY_TOKEN", token],
            check=True,
            capture_output=True,
            text=True,
        )
        return [
            "已写入用户环境变量 CLAUDE_NOTIFY_TOKEN（新进程生效）。"
        ]


class PosixLocalIntegration(LocalIntegrationAdapter):
    env_option_text = (
        "同时将 Token 写入 shell 环境变量"
        "（bash/zsh/csh/fish，可选）"
    )
    requires_shell_selection = True

    def __init__(self, home: Path | None = None) -> None:
        self.home = home or Path.home()

    def prepare_directory(self, path: Path) -> None:
        path.chmod(0o700)

    def prepare_executable(self, path: Path) -> None:
        path.chmod(0o755)

    def protect_config(self, path: Path) -> None:
        path.chmod(0o600)

    def build_hook_entry(
        self,
        env_pairs: dict[str, Any],
        script_path: Path,
    ) -> dict[str, Any]:
        return build_shell_hook_entry(env_pairs, script_path)

    def verify_hook(
        self,
        script_path: Path,
        hook_entry: dict[str, Any],
    ) -> None:
        del hook_entry
        _run_compile_check("python3", script_path)

    def write_environment(
        self,
        token: str,
        shells: list[str],
    ) -> list[str]:
        messages: list[str] = []
        pattern = re.compile(
            re.escape(ENV_MARK_BEGIN)
            + r".*?"
            + re.escape(ENV_MARK_END)
            + r"\n?",
            re.S,
        )
        for shell in shells:
            info = SHELL_RC_FILES.get(shell)
            if info is None:
                continue
            shell_label, rc_rel = info
            rc_path = self.home / rc_rel
            rc_path.parent.mkdir(parents=True, exist_ok=True)
            existing = (
                rc_path.read_text(encoding="utf-8")
                if rc_path.exists()
                else ""
            )
            cleaned = pattern.sub("", existing).rstrip()
            block = build_env_block(shell, token)
            updated = (
                f"{cleaned}\n\n{block}\n"
                if cleaned
                else f"{block}\n"
            )
            rc_path.write_text(updated, encoding="utf-8")
            messages.append(
                f"已写入 {shell_label} 环境变量 → {rc_path}"
            )
        return messages


def _run_compile_check(
    python_command: str,
    script_path: Path,
) -> None:
    result = subprocess.run(
        [python_command, "-m", "py_compile", str(script_path)],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "钩子脚本编译验证失败 "
            f"exit={result.returncode}: {result.stderr[:200]}"
        )


def create_local_integration_adapter() -> LocalIntegrationAdapter:
    if sys.platform == "win32":
        return WindowsLocalIntegration()
    return PosixLocalIntegration()


LOCAL_INTEGRATION = create_local_integration_adapter()
