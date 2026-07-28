"""SSH deployment and deployed-hook verification adapters."""
import json
import time
from typing import Any
from PySide6.QtCore import QObject, Signal, Slot
from ..application.hooks import (
    APPROVAL_SCRIPT_NAME, DEPLOY_MODES, ENV_MARK_BEGIN, ENV_MARK_END,
    NOTIFY_SCRIPT_NAME, SHELL_RC_FILES, build_env_block,
    build_hook_command, merge_settings_json,
)
from ..config import APPROVAL_PATH, HEALTH_PATH, NOTIFY_PATH, STAGE_STATUS_PATH
from ..core import resource_path

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
