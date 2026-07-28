"""Deployment and local-connection dialogs."""
import time
from typing import Any, Optional
from PySide6.QtCore import QThread, Signal, Slot
from PySide6.QtWidgets import (
    QCheckBox, QDialog, QFileDialog, QFormLayout, QHBoxLayout, QLabel,
    QLineEdit, QMessageBox, QPushButton, QTextEdit, QVBoxLayout, QWidget,
)
from ..application.hooks import (
    DEPLOY_MODES, SHELL_RC_FILES, load_deploy_cache, save_deploy_cache,
)
from ..core import escape_html
from ..config import USER_HOME
from ..infrastructure.deployment import DeployWorker, ServerTestWorker
from ..infrastructure.local_integration import (
    LOCAL_INTEGRATION,
    LocalIntegrationAdapter,
)
from ..infrastructure.secrets import SECRET_STORE
from .components import OptionSegment
from .theme import LOG_COLORS

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
class LocalDeployDialog(QDialog):
    """本机 Claude Code 接入：选通知方式与是否写入环境变量。"""

    def __init__(
        self,
        parent=None,
        integration: LocalIntegrationAdapter = LOCAL_INTEGRATION,
    ) -> None:
        super().__init__(parent)
        self.integration = integration
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

        self.env_check = QCheckBox(integration.env_option_text)
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
        if parent is not None and hasattr(parent, "show_toast"):
            parent.show_toast(message)
