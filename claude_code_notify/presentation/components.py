"""Reusable presentation components."""
from typing import Optional
from PySide6.QtCore import QEvent, Qt, Signal
from PySide6.QtWidgets import (
    QFrame, QHBoxLayout, QLabel, QPushButton, QScrollArea,
    QVBoxLayout, QWidget,
)

class OptionSegment(QWidget):
    currentIndexChanged = Signal(int)

    def __init__(self) -> None:
        super().__init__()
        self._buttons: list[QPushButton] = []
        self._data: list[object] = []
        self._current_index = -1

        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(6)
        self._layout = layout

    def addItem(self, text: str, userData=None) -> None:
        # 重新排布时先去掉旧的 stretch，保证按钮在左、拉伸在右
        while self._layout.count() > len(self._buttons):
            item = self._layout.takeAt(self._layout.count() - 1)
            if item is not None:
                del item

        button = QPushButton(text)
        button.setObjectName("tab")
        button.setCheckable(True)
        button.setMinimumHeight(34)

        index = len(self._buttons)
        button.clicked.connect(
            lambda checked=False, i=index: self.setCurrentIndex(i)
        )
        self._buttons.append(button)
        self._data.append(userData)
        self._layout.addWidget(button)
        self._layout.addStretch(1)

        if self._current_index == -1:
            self._set_current(0, emit=False)

    def addItems(self, texts: list[str]) -> None:
        for text in texts:
            self.addItem(text)

    def count(self) -> int:
        return len(self._buttons)

    def currentIndex(self) -> int:
        return self._current_index

    def itemData(self, index: int):
        if 0 <= index < len(self._data):
            return self._data[index]
        return None

    def currentData(self):
        return self.itemData(self._current_index)

    def findData(self, data) -> int:
        try:
            return self._data.index(data)
        except ValueError:
            return -1

    def setCurrentIndex(self, index: int) -> None:
        self._set_current(index, emit=True)

    def _set_current(self, index: int, emit: bool) -> None:
        if not (0 <= index < len(self._buttons)):
            return
        changed = index != self._current_index
        self._current_index = index
        for i, button in enumerate(self._buttons):
            button.setChecked(i == index)
        if changed and emit:
            self.currentIndexChanged.emit(index)

    def setEnabled(self, enabled: bool) -> None:
        super().setEnabled(enabled)
        for button in self._buttons:
            button.setEnabled(enabled)


class ApprovalStatsPopup(QFrame):
    """点击审批总数后显示的明细浮层；失焦或点击外部时自动关闭。"""

    MAX_HEIGHT = 360

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(
            parent,
            Qt.Popup | Qt.FramelessWindowHint,
        )
        self.setObjectName("approvalStatsPopup")
        self.setFixedWidth(320)
        self.setMaximumHeight(self.MAX_HEIGHT)
        self.setFocusPolicy(Qt.StrongFocus)
        self.setAccessibleName("已审批权限详细统计")

        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 12, 12, 12)
        layout.setSpacing(8)

        header = QHBoxLayout()
        header.setSpacing(8)

        title = QLabel("已审批权限")
        title.setObjectName("approvalStatsTitle")
        header.addWidget(title)
        header.addStretch(1)

        self.total_label = QLabel("共 0 次")
        self.total_label.setObjectName("approvalStatsTotal")
        header.addWidget(self.total_label)
        layout.addLayout(header)

        self.scroll = QScrollArea()
        self.scroll.setObjectName("approvalStatsScroll")
        self.scroll.setWidgetResizable(True)
        self.scroll.setHorizontalScrollBarPolicy(
            Qt.ScrollBarAlwaysOff
        )

        self.container = QWidget()
        self.container.setObjectName("approvalStatsContainer")
        self.detail_layout = QVBoxLayout(self.container)
        self.detail_layout.setContentsMargins(0, 0, 0, 0)
        self.detail_layout.setSpacing(6)
        self.scroll.setWidget(self.container)
        layout.addWidget(self.scroll)

        self.update_stats(0, {})

    def update_stats(
        self,
        total: int,
        counts: dict[str, int],
    ) -> None:
        self.total_label.setText(f"共 {total} 次")

        while self.detail_layout.count():
            item = self.detail_layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.setParent(None)
                widget.deleteLater()

        visible_counts = [
            (tool_name, count)
            for tool_name, count in counts.items()
            if count > 0
        ]

        if not visible_counts:
            empty = QLabel("暂无审批记录")
            empty.setObjectName("approvalStatsEmpty")
            empty.setAlignment(Qt.AlignCenter)
            self.detail_layout.addWidget(empty)
        else:
            for tool_name, count in visible_counts:
                row = QFrame()
                row.setObjectName("approvalStatsRow")
                row_layout = QHBoxLayout(row)
                row_layout.setContentsMargins(10, 7, 10, 7)
                row_layout.setSpacing(10)

                tool_label = QLabel(tool_name)
                tool_label.setObjectName("approvalStatsTool")
                tool_label.setToolTip(tool_name)
                row_layout.addWidget(tool_label, stretch=1)

                count_label = QLabel(f"x{count}")
                count_label.setObjectName("approvalStatsCount")
                row_layout.addWidget(count_label)
                self.detail_layout.addWidget(row)

        self.detail_layout.addStretch(1)
        row_count = max(1, len(visible_counts))
        self.setFixedHeight(
            min(self.MAX_HEIGHT, 82 + row_count * 36)
        )

    def event(self, event: QEvent) -> bool:
        if (
            event.type() == QEvent.WindowDeactivate
            and self.isVisible()
        ):
            self.close()
        return super().event(event)


class DenialStatsPopup(QFrame):
    """Auto mode 拒绝明细；按拒绝指纹聚合并展示恢复状态。"""

    MAX_HEIGHT = 420

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(
            parent,
            Qt.Popup | Qt.FramelessWindowHint,
        )
        self.setObjectName("approvalStatsPopup")
        self.setFixedWidth(420)
        self.setMaximumHeight(self.MAX_HEIGHT)
        self.setFocusPolicy(Qt.StrongFocus)
        self.setAccessibleName("Auto mode 拒绝详细统计")

        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 12, 12, 12)
        layout.setSpacing(8)

        header = QHBoxLayout()
        title = QLabel("Auto mode 拒绝")
        title.setObjectName("approvalStatsTitle")
        header.addWidget(title)
        header.addStretch(1)
        self.total_label = QLabel("共 0 次")
        self.total_label.setObjectName("approvalStatsTotal")
        header.addWidget(self.total_label)
        layout.addLayout(header)

        self.scroll = QScrollArea()
        self.scroll.setObjectName("approvalStatsScroll")
        self.scroll.setWidgetResizable(True)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.container = QWidget()
        self.container.setObjectName("approvalStatsContainer")
        self.detail_layout = QVBoxLayout(self.container)
        self.detail_layout.setContentsMargins(0, 0, 0, 0)
        self.detail_layout.setSpacing(6)
        self.scroll.setWidget(self.container)
        layout.addWidget(self.scroll)
        self.update_stats(0, [])

    def update_stats(
        self,
        total: int,
        records: list[dict],
    ) -> None:
        self.total_label.setText(f"共 {total} 次")
        while self.detail_layout.count():
            item = self.detail_layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.setParent(None)
                widget.deleteLater()

        if not records:
            empty = QLabel("暂无拒绝记录")
            empty.setObjectName("approvalStatsEmpty")
            empty.setAlignment(Qt.AlignCenter)
            self.detail_layout.addWidget(empty)
        else:
            for record in records:
                row = QFrame()
                row.setObjectName("approvalStatsRow")
                row_layout = QVBoxLayout(row)
                row_layout.setContentsMargins(10, 7, 10, 7)
                row_layout.setSpacing(3)

                top = QHBoxLayout()
                tool = QLabel(str(record.get("tool_name") or "未知工具"))
                tool.setObjectName("approvalStatsTool")
                top.addWidget(tool, stretch=1)
                status = (
                    "已恢复"
                    if record.get("recovered")
                    else (
                        "已询问"
                        if record.get("escalated")
                        else "Agent 调整中"
                    )
                )
                count = QLabel(f"x{record.get('count', 1)} · {status}")
                count.setObjectName("approvalStatsCount")
                top.addWidget(count)
                row_layout.addLayout(top)

                detail = str(record.get("detail") or "").strip()
                reason = str(record.get("reason") or "").strip()
                summary = detail or reason
                if summary:
                    label = QLabel(summary[:240])
                    label.setObjectName("approvalStatsEmpty")
                    label.setWordWrap(True)
                    label.setToolTip(
                        "\n".join(part for part in (detail, reason) if part)
                    )
                    row_layout.addWidget(label)
                self.detail_layout.addWidget(row)

        self.detail_layout.addStretch(1)
        row_count = max(1, len(records))
        self.setFixedHeight(
            min(self.MAX_HEIGHT, 82 + row_count * 78)
        )

    def event(self, event: QEvent) -> bool:
        if (
            event.type() == QEvent.WindowDeactivate
            and self.isVisible()
        ):
            self.close()
        return super().event(event)
