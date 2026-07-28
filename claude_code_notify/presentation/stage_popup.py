"""Stage-completion popup view."""
from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtGui import QCloseEvent, QShowEvent
from PySide6.QtWidgets import QApplication, QFrame, QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget
from ..infrastructure.platform import PLATFORM, pick_popup_screen

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
        return normalized.replace("\\", "/").rsplit("/", 1)[-1] or normalized

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
