"""Main application window and orchestration of presentation use cases."""
import json
import re
import subprocess
import sys
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Optional
from PySide6.QtCore import QPoint, Qt, QThread, QTimer, Signal, Slot
from PySide6.QtGui import QAction, QCloseEvent, QGuiApplication, QIcon, QPixmap
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QDialog, QFrame, QHBoxLayout, QLabel, QLineEdit,
    QMainWindow, QMenu, QMessageBox, QPushButton, QSystemTrayIcon,
    QTextEdit, QVBoxLayout, QWidget,
)
from ..application.hooks import (
    APPROVAL_SCRIPT_NAME, DEPLOY_CACHE_FILE, DEPLOY_MODES, ENV_MARK_BEGIN,
    ENV_MARK_END, HOOK_CONFIG_NAME, NOTIFY_SCRIPT_NAME, SHELL_RC_FILES,
    build_env_block, build_local_hook_entry, detect_local_deploy,
    load_deploy_cache, local_claude_dir, local_python_command, merge_settings_json,
)
from ..config import (
    APP_DATA_DIR, APP_NAME, APPROVAL_PATH, HOST, LOG_FILE, NOTIFY_PATH, PORT,
    STAGE_STATUS_PATH, UI_CONFIG_FILE,
)
from ..core import (
    escape_html, format_approval_type_counts, get_local_ip,
    is_completed_approval_decision, load_or_create_token, regenerate_token,
    resource_path, safe_string,
)
from ..domain.approval import ApprovalRequest
from ..infrastructure.http_server import HttpEventBridge, ServerWorker
from ..infrastructure.platform import PLATFORM, POPUP_SCREEN_MODES
from .approval_popup import ApprovalPopup
from .components import ApprovalStatsPopup, OptionSegment
from .dialogs import DeployDialog, EnvShellDialog, LocalDeployDialog
from .stage_popup import StageCompletionPopup
from .theme import LOG_COLORS, MAX_LOG_LINES

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
            UI_CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
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
