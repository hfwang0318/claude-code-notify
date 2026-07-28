"""Approval popup view."""
import json
from typing import Any, Optional
from PySide6.QtCore import QPoint, Qt, QTimer, Signal
from PySide6.QtGui import QMouseEvent, QShowEvent
from PySide6.QtWidgets import (
    QApplication, QFrame, QHBoxLayout, QLabel, QLineEdit, QProgressBar,
    QPushButton, QScrollArea, QTextEdit, QVBoxLayout, QWidget,
)
from ..domain.approval import ApprovalRequest, describe_suggestion
from ..infrastructure.platform import PLATFORM, pick_popup_screen

class OptionRow(QFrame):
    """
    选项行：标题 + 可选描述小字，可点击、可勾选。
    用于 AskUserQuestion 选项与自由输入入口——QPushButton 单行文本
    无法表达「label + description」两行结构，所以用 QFrame 自绘。
    """

    clicked = Signal()

    def __init__(
        self,
        label: str,
        description: str = "",
        parent: Optional[QWidget] = None,
    ) -> None:
        super().__init__(parent)
        self.setObjectName("optionRow")
        self.setProperty("checked", False)
        self.setCursor(Qt.PointingHandCursor)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 8, 12, 8)
        layout.setSpacing(2)

        title = QLabel(label)
        title.setObjectName("optionRowTitle")
        title.setWordWrap(True)
        layout.addWidget(title)

        if description:
            desc = QLabel(description)
            desc.setObjectName("optionRowDesc")
            desc.setWordWrap(True)
            layout.addWidget(desc)

    def isChecked(self) -> bool:
        return bool(self.property("checked"))

    def setChecked(self, checked: bool) -> None:
        self.setProperty("checked", checked)
        self.style().unpolish(self)
        self.style().polish(self)

    def mouseReleaseEvent(self, event) -> None:
        if event.button() == Qt.LeftButton:
            self.clicked.emit()
        super().mouseReleaseEvent(event)


class ApprovalPopup(QWidget):
    decided = Signal(object, str)  # ApprovalRequest, decision_id
    expired = Signal(object)  # ApprovalRequest
    acknowledged = Signal(object)  # ApprovalRequest

    def __init__(
        self,
        request: ApprovalRequest,
        queued_count: int = 0,
        screen_mode: str = "primary",
    ) -> None:
        super().__init__(
            None,
            Qt.FramelessWindowHint
            | Qt.WindowStaysOnTopHint
            | Qt.Tool,
        )

        self.request = request
        self.remaining_ms = request.timeout_seconds * 1000
        self.expired_mode = False
        self.drag_position = QPoint()
        self.screen_mode = screen_mode

        self.setObjectName("approvalPopupRoot")
        self.setAttribute(Qt.WA_DeleteOnClose)
        # 透明背景：否则无边框窗口的圆角外会露出黑色直角
        self.setAttribute(Qt.WA_TranslucentBackground)
        # 应用模态：服务器端测试时部署对话框是模态的，
        # 弹窗必须也是模态才能压在它之上接收鼠标输入
        self.setWindowModality(Qt.ApplicationModal)
        self.setFixedWidth(500)
        self.setAccessibleName("权限审批弹窗")

        self.build_ui(request, queued_count)
        self.move_to_corner()

        # macOS 必须在 NSWindow 第一次显示、被归入当前 Space 之前设置
        # collectionBehavior。showEvent 中还会再次配置，以防 Qt 在显示
        # 过程中重建或调整原生窗口。
        PLATFORM.follow_active_space(self)
        PLATFORM.watch_active_space(self)

        # 倒计时
        self.countdown_timer = QTimer(self)
        self.countdown_timer.setInterval(100)
        self.countdown_timer.timeout.connect(self.tick)
        self.countdown_timer.start()

        # 提示音 + 闪烁提醒
        QApplication.beep()

    def build_ui(
        self,
        request: ApprovalRequest,
        queued_count: int,
    ) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)

        card = QFrame()
        card.setObjectName("approvalCard")

        layout = QVBoxLayout(card)
        layout.setContentsMargins(16, 12, 16, 14)
        layout.setSpacing(8)

        is_question = request.kind == "question"
        is_denial = request.kind == "denial"
        self.allow_button = None

        # ---- 顶部：紧急度标记 + 关闭 ----
        kicker_row = QHBoxLayout()
        kicker = QLabel(
            "QUESTION FROM CLAUDE"
            if is_question
            else (
                "AUTO MODE BLOCKED"
                if is_denial
                else "PERMISSION REQUIRED"
            )
        )
        kicker.setObjectName("approvalKicker")
        kicker_row.addWidget(kicker)

        if queued_count > 0:
            queued = QLabel(f"还有 {queued_count} 条")
            queued.setObjectName("approvalProject")
            kicker_row.addWidget(queued)

        kicker_row.addStretch()

        close_button = QPushButton("✕")
        close_button.setObjectName("popupClose")
        close_button.setToolTip("关闭（交给终端处理）")
        close_button.setAccessibleName("关闭审批弹窗")
        close_button.clicked.connect(
            lambda: self.decide("dismissed")
        )
        kicker_row.addWidget(close_button)
        layout.addLayout(kicker_row)

        title = QLabel(
            "Claude 想问你一个问题"
            if is_question
            else (
                "Auto mode 重复阻止了这项操作"
                if is_denial
                else "Claude 请求执行权限"
            )
        )
        title.setObjectName("approvalTitle")
        layout.addWidget(title)

        desc = QLabel(
            "选择选项作答 · Esc 交给终端；超时未处理将自动返回终端。"
            if is_question
            else (
                "允许后仅恢复 Agent 重试，操作仍会重新经过 Auto mode 检查。"
                if is_denial
                else "Enter 允许 · Esc 交给终端；超时未处理将自动返回终端。"
            )
        )
        desc.setObjectName("approvalDesc")
        layout.addWidget(desc)

        # ---- 项目 + 工具 ----
        meta_row = QHBoxLayout()

        project = QLabel(f"项目：{request.project_name}")
        project.setObjectName("approvalProject")
        meta_row.addWidget(project)
        meta_row.addStretch()

        tool_badge = QLabel(request.tool_name)
        tool_badge.setObjectName("toolBadge")
        meta_row.addWidget(tool_badge)

        layout.addLayout(meta_row)

        # ---- 消息（提问场景即问题文本） ----
        message = QLabel(request.message)
        message.setObjectName("approvalMessage")
        message.setWordWrap(True)
        layout.addWidget(message)

        # ---- 工具调用详情（提问场景不展示 JSON） ----
        detail_text = "" if is_question else request.detail
        if detail_text:
            detail = QTextEdit()
            detail.setObjectName("approvalDetail")
            detail.setReadOnly(True)
            detail.setPlainText(detail_text)
            detail.setMaximumHeight(160)
            layout.addWidget(detail)

        # ---- 倒计时 ----
        countdown_row = QHBoxLayout()

        self.countdown_bar = QProgressBar()
        self.countdown_bar.setObjectName("countdownBar")
        self.countdown_bar.setRange(0, self.remaining_ms)
        self.countdown_bar.setValue(self.remaining_ms)
        self.countdown_bar.setTextVisible(False)
        countdown_row.addWidget(self.countdown_bar, stretch=1)

        self.countdown_label = QLabel(
            f"{request.timeout_seconds}s"
        )
        self.countdown_label.setObjectName("countdownLabel")
        countdown_row.addWidget(self.countdown_label)

        layout.addLayout(countdown_row)

        # ---- 已回退提示（默认隐藏，超时后显示在按钮正上方） ----
        self.expired_hint = QLabel(
            "这条审批不会再由弹窗提交。\n"
            "请在 Claude 终端继续处理，确认后点击下方「我知道了」关闭。"
        )
        self.expired_hint.setObjectName("expiredHint")
        self.expired_hint.setWordWrap(True)
        self.expired_hint.setVisible(False)
        layout.addWidget(self.expired_hint)

        # ---- 决策区：按场景分流 ----
        if is_question:
            self.build_question_options(layout, request)
        else:
            self.build_permission_options(layout, request)

        outer.addWidget(card)

        if self.allow_button is not None:
            self.allow_button.setFocus()

    # ------------------------------------------------------------------
    # 权限审批：基础按钮 + Claude 提供的「始终允许」建议
    # ------------------------------------------------------------------

    def build_permission_options(
        self,
        layout: QVBoxLayout,
        request: ApprovalRequest,
    ) -> None:
        options = request.options
        has_suggestions = bool(request.suggestions)

        if not has_suggestions:
            buttons = [
                self.make_permission_button(option)
                for option in options
            ]

            if len(buttons) <= 2:
                # 1–2 项：等宽横排，保留常见允许/拒绝的快速扫视。
                button_row = QHBoxLayout()
                button_row.setSpacing(8)
                for button in buttons:
                    button_row.addWidget(button, stretch=1)
                layout.addLayout(button_row)
            else:
                # 3–6 项：全宽纵排。macOS 原生按钮有额外阴影和最小
                # 宽度，继续横排会与相邻按钮发生视觉重叠。
                for button in buttons:
                    layout.addWidget(button)

            self.add_terminal_footer(layout)
            return

        # 有建议时，顺序与终端权限对话框一致且全部整行等宽：
        # 允许 → 始终允许建议 → 拒绝 →（交给终端降为底部小链接）
        allow_option = next(
            (o for o in options if o["id"] == "allow"), None
        )

        # ---- 允许（整行主按钮，对齐终端的 yes） ----
        if allow_option is not None:
            allow_button = QPushButton(allow_option["label"])
            allow_button.setObjectName("approveAllow")
            allow_button.setDefault(True)
            allow_button.setAutoDefault(True)
            allow_button.setAccessibleName(
                f"审批选项：{allow_option['label']}"
            )
            allow_button.clicked.connect(
                lambda checked=False: self.decide("allow")
            )
            self.allow_button = allow_button
            layout.addWidget(allow_button)

        # ---- 「始终允许」类选项（permission_suggestions，不透明 echo） ----
        # 对象去重在 ApprovalRequest.suggestions 已做；
        # 这里再按显示标签去重——不同对象可能渲染出相同文案
        seen_labels: set[str] = set()
        for index, suggestion in enumerate(request.suggestions):
            label = describe_suggestion(suggestion)
            if label in seen_labels:
                continue
            seen_labels.add(label)
            button = QPushButton(label)
            button.setObjectName("suggestionButton")
            button.setToolTip(
                "等价于终端权限对话框中的对应选项；原始规则：\n"
                + json.dumps(suggestion, ensure_ascii=False)
            )
            button.setAccessibleName(f"权限建议：{label}")
            button.clicked.connect(
                lambda checked=False, i=index: self.decide(
                    "suggestion", {"index": i}
                )
            )
            layout.addWidget(button)

        # ---- 拒绝 / 其他自定义选项（同样整行） ----
        for option in options:
            if option["id"] == "allow":
                continue  # 已在顶部渲染
            button = QPushButton(option["label"])
            button.setAccessibleName(f"审批选项：{option['label']}")
            if option["id"] == "deny":
                button.setObjectName("approveDeny")

            decision_id = option["id"]
            button.clicked.connect(
                lambda checked=False, d=decision_id: self.decide(d)
            )
            layout.addWidget(button)

        # ---- 交给终端：底部右对齐小链接，不与决策按钮抢视觉 ----
        self.add_terminal_footer(layout)

    def make_permission_button(
        self,
        option: dict[str, str],
    ) -> QPushButton:
        button = QPushButton(option["label"])
        button.setAccessibleName(f"审批选项：{option['label']}")
        if option["id"] == "allow":
            button.setObjectName("approveAllow")
            button.setDefault(True)
            button.setAutoDefault(True)
            self.allow_button = button
        elif option["id"] == "deny":
            button.setObjectName("approveDeny")

        decision_id = option["id"]
        button.clicked.connect(
            lambda checked=False, d=decision_id: self.decide(d)
        )
        return button

    def add_terminal_footer(self, layout: QVBoxLayout) -> None:
        footer_row = QHBoxLayout()
        footer_row.addStretch()
        footer_row.addWidget(self.make_terminal_button())
        layout.addLayout(footer_row)

    # ------------------------------------------------------------------
    # AskUserQuestion：选项行 + 自由输入 + 多选
    # ------------------------------------------------------------------

    def build_question_options(
        self,
        layout: QVBoxLayout,
        request: ApprovalRequest,
    ) -> None:
        questions = request.questions or [{}]
        multi_question = len(questions) > 1

        # 单问题 + 单选：点选项立即提交（快速路径）；
        # 多问题或多选：勾选后点「确认回答」
        first = questions[0] if questions else {}
        self.fast_path_question = (
            not multi_question and not bool(first.get("multiSelect"))
        )

        self.question_state: list[dict[str, Any]] = []

        scroll = QScrollArea()
        scroll.setObjectName("optionScroll")
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        scroll.setMaximumHeight(320)

        container = QWidget()
        container.setObjectName("optionContainer")
        box = QVBoxLayout(container)
        box.setContentsMargins(0, 0, 4, 0)
        box.setSpacing(6)

        for qi, question in enumerate(questions):
            qtext = str(question.get("question") or request.message)
            multi = bool(question.get("multiSelect"))
            raw_options = question.get("options")
            options = (
                [o for o in raw_options if isinstance(o, dict)][:8]
                if isinstance(raw_options, list)
                else []
            )

            if multi_question:
                q_label = QLabel(f"问题 {qi + 1}：{qtext}")
                q_label.setObjectName("approvalMessage")
                q_label.setWordWrap(True)
                box.addWidget(q_label)

            state: dict[str, Any] = {
                "question": qtext,
                "multi": multi,
                "rows": [],
                "other_edit": None,
            }

            for opt in options:
                label = str(opt.get("label") or "?")
                description = str(opt.get("description") or "")
                row = OptionRow(label, description)
                row.setProperty("optLabel", label)
                row.setAccessibleName(f"选项：{label}")
                row.clicked.connect(
                    lambda s=state, r=row: self.on_question_row(s, r)
                )
                state["rows"].append((row, label))
                box.addWidget(row)

            # ---- 其他（自由输入） ----
            other_edit = QLineEdit()
            other_edit.setObjectName("approvalInput")
            other_edit.setPlaceholderText("其他：输入你自己的回答，Enter 确认")
            other_edit.setVisible(False)
            state["other_edit"] = other_edit

            other_toggle = QPushButton("其他（自己输入）…")
            other_toggle.setObjectName("otherToggle")
            other_toggle.clicked.connect(
                lambda checked=False, e=other_edit: self.toggle_other(e)
            )
            box.addWidget(other_toggle)
            box.addWidget(other_edit)

            other_edit.returnPressed.connect(self.submit_answers)

            self.question_state.append(state)

        # 滚动区只有内容超高时才占高度
        scroll.setWidget(container)
        layout.addWidget(scroll)

        # ---- 底部：确认回答（非快速路径）+ 交给终端 ----
        bottom_row = QHBoxLayout()
        bottom_row.setSpacing(8)

        self.confirm_button = QPushButton("确认回答")
        self.confirm_button.setObjectName("confirmButton")
        self.confirm_button.setAccessibleName("确认回答")
        self.confirm_button.clicked.connect(self.submit_answers)
        self.confirm_button.setVisible(not self.fast_path_question)
        bottom_row.addWidget(self.confirm_button)

        bottom_row.addStretch()
        bottom_row.addWidget(self.make_terminal_button())
        layout.addLayout(bottom_row)

    def make_terminal_button(self) -> QPushButton:
        self.terminal_button = QPushButton("交给终端")
        self.terminal_button.setObjectName("approveTerminal")
        self.terminal_button.setToolTip("不做决定，回到终端正常提示")
        self.terminal_button.setAccessibleName("交给终端处理")
        self.terminal_button.clicked.connect(
            lambda: self.decide("ask")
        )
        return self.terminal_button

    def toggle_other(self, edit: QLineEdit) -> None:
        edit.setVisible(not edit.isVisible())
        if edit.isVisible():
            edit.setFocus()
        self.move_to_corner()

    def on_question_row(
        self,
        state: dict[str, Any],
        row: OptionRow,
    ) -> None:
        if self.fast_path_question:
            # 单问题单选：点击即提交
            label = str(row.property("optLabel") or "")
            self.decide(
                "answer",
                {
                    "answers": [
                        {
                            "question": state["question"],
                            "selected": [label],
                            "text": "",
                        }
                    ]
                },
            )
            return

        if state["multi"]:
            row.setChecked(not row.isChecked())
        else:
            # 组内单选互斥
            for r, _label in state["rows"]:
                r.setChecked(r is row)

    def submit_answers(self) -> None:
        answers: list[dict[str, Any]] = []
        for state in self.question_state:
            selected = [
                label
                for row, label in state["rows"]
                if row.isChecked()
            ]
            edit = state.get("other_edit")
            text = edit.text().strip() if edit is not None else ""
            if selected or text:
                answers.append(
                    {
                        "question": state["question"],
                        "selected": selected,
                        "text": text,
                    }
                )

        if not answers:
            # 什么都没选/没填：闪烁提示，不提交空答案
            QApplication.beep()
            return

        self.decide("answer", {"answers": answers})

    def move_to_corner(self) -> None:
        self.adjustSize()

        screen = pick_popup_screen(self.screen_mode)
        if screen is None:
            return

        geometry = screen.availableGeometry()
        x = geometry.right() - self.width() - 16
        y = geometry.bottom() - self.height() - 16
        self.move(x, y)

    def showEvent(self, event: QShowEvent) -> None:
        super().showEvent(event)
        # winId()/NSWindow 在 showEvent 后才稳定可用。每次重新显示都
        # 幂等配置，以便弹窗出现在用户当前使用的 Space。
        QTimer.singleShot(
            0,
            lambda: PLATFORM.follow_active_space(self),
        )

    # ------------------------------------------------------------------
    # 倒计时
    # ------------------------------------------------------------------

    def tick(self) -> None:
        self.remaining_ms -= 100

        if self.remaining_ms <= 0:
            self.mark_expired()
            self.expired.emit(self.request)
            return

        self.countdown_bar.setValue(self.remaining_ms)
        self.countdown_label.setText(
            f"{self.remaining_ms // 1000}s"
        )

    # ------------------------------------------------------------------
    # 决定
    # ------------------------------------------------------------------

    def mark_expired(self) -> None:
        if self.expired_mode:
            return
        self.expired_mode = True
        self.countdown_timer.stop()
        self.countdown_bar.setValue(0)
        self.countdown_bar.setProperty("expired", True)
        self.countdown_label.setText("已回退终端")

        for label in self.findChildren(QLabel):
            name = label.objectName()
            if name in {"approvalKicker", "approvalTitle", "approvalDesc"}:
                label.setProperty("expired", True)
                label.style().unpolish(label)
                label.style().polish(label)
            if name == "approvalKicker":
                label.setText("RETURNED TO TERMINAL")
            elif name == "approvalTitle":
                label.setText("审批已回退终端")
            elif name == "approvalDesc":
                label.setText("超时未处理，弹窗已不再提交决定。")

        # 提示放到「我知道了」正上方，比顶部描述更醒目
        self.expired_hint.setVisible(True)

        # 所有决策控件失效：基础按钮 / suggestion / 确认回答 / 其他输入
        for button in self.findChildren(QPushButton):
            name = button.objectName()
            if name in {
                "approveAllow",
                "approveDeny",
                "suggestionButton",
                "confirmButton",
                "otherToggle",
            }:
                # 置灰并取消 coral/danger 重点色，换中性样式
                button.setObjectName("approveDisabled")
                button.setEnabled(False)
                button.setDefault(False)
                button.setAutoDefault(False)
                button.style().unpolish(button)
                button.style().polish(button)

        for row in self.findChildren(OptionRow):
            row.setEnabled(False)
            # Qt QSS 怪癖：`QFrame#x:disabled QLabel` 会无视伪状态恒命中；
            # 祖先属性选择器也不会级联刷新后代，文字置灰直接打在标签上
            row.setProperty("expired", True)
            row.style().unpolish(row)
            row.style().polish(row)
            for label in row.findChildren(QLabel):
                label.setProperty("expired", True)
                label.style().unpolish(label)
                label.style().polish(label)
        for edit in self.findChildren(QLineEdit):
            edit.setEnabled(False)

        # 「我知道了」升级为 coral 主按钮，视觉焦点移到唯一可操作项
        self.terminal_button.setObjectName("primaryButton")
        self.terminal_button.setText("我知道了")
        self.terminal_button.setToolTip("确认已知晓该审批已回退终端")
        self.terminal_button.setAccessibleName("我知道了，关闭弹窗")
        self.terminal_button.setDefault(True)
        self.terminal_button.setAutoDefault(True)
        self.terminal_button.style().unpolish(self.terminal_button)
        self.terminal_button.style().polish(self.terminal_button)
        self.terminal_button.setFocus()

        self.countdown_bar.style().unpolish(self.countdown_bar)
        self.countdown_bar.style().polish(self.countdown_bar)

        # 提示出现后高度变化，重新贴回屏幕角落
        self.move_to_corner()

    def decide(
        self,
        decision_id: str,
        extra: Optional[dict[str, Any]] = None,
    ) -> None:
        if self.expired_mode:
            if decision_id in {"ask", "dismissed", "timeout"}:
                self.acknowledged.emit(self.request)
                self.close()
            return

        self.countdown_timer.stop()
        if extra is not None:
            # suggestion → {"index": N}；answer → {"answers": [...]}
            self.request.extra = extra
        self.decided.emit(self.request, decision_id)
        self.close()

    # ------------------------------------------------------------------
    # 键盘
    # ------------------------------------------------------------------

    def keyPressEvent(self, event) -> None:
        if event.key() == Qt.Key_Escape:
            self.decide("ask")
            return
        super().keyPressEvent(event)

    # ------------------------------------------------------------------
    # 拖拽移动
    # ------------------------------------------------------------------

    def mousePressEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.LeftButton:
            self.drag_position = (
                event.globalPosition().toPoint()
                - self.frameGeometry().topLeft()
            )
            event.accept()

    def mouseMoveEvent(self, event: QMouseEvent) -> None:
        if event.buttons() & Qt.LeftButton:
            self.move(
                event.globalPosition().toPoint()
                - self.drag_position
            )
            event.accept()
