import os
import unittest
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QEvent
from PySide6.QtWidgets import QApplication, QLabel, QPushButton

from claude_notify_server import (
    ApprovalStatsPopup,
    MainWindow,
    format_approval_type_counts,
    is_completed_approval_decision,
)


class ApprovalStatsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def test_formats_all_tool_types_in_first_seen_order(self) -> None:
        counts = {
            "AskUserQuestion": 2,
            "Bash": 3,
        }

        self.assertEqual(
            format_approval_type_counts(counts),
            "AskUserQuestion x2，Bash x3",
        )

    def test_empty_counts_have_clear_placeholder(self) -> None:
        self.assertEqual(
            format_approval_type_counts({}),
            "暂无审批记录",
        )

    def test_only_gui_completed_decisions_are_counted(self) -> None:
        for decision in (
            "allow",
            "deny",
            "suggestion",
            "answer",
        ):
            with self.subTest(decision=decision):
                self.assertTrue(
                    is_completed_approval_decision(decision)
                )

        for decision in (
            "",
            "ask",
            "dismissed",
            "timeout",
            "cancelled",
        ):
            with self.subTest(decision=decision):
                self.assertFalse(
                    is_completed_approval_decision(decision)
                )

    def test_popup_lists_all_types_without_growing_past_limit(self) -> None:
        popup = ApprovalStatsPopup()
        counts = {f"Tool{index}": index + 1 for index in range(20)}

        popup.update_stats(sum(counts.values()), counts)
        self.app.processEvents()

        tool_labels = popup.findChildren(QLabel, "approvalStatsTool")
        self.assertEqual(
            [label.text() for label in tool_labels],
            list(counts),
        )
        self.assertLessEqual(
            popup.height(),
            ApprovalStatsPopup.MAX_HEIGHT,
        )
        popup.close()

    def test_popup_closes_when_window_loses_focus(self) -> None:
        popup = ApprovalStatsPopup()
        popup.show()
        self.app.processEvents()
        self.assertTrue(popup.isVisible())

        QApplication.sendEvent(
            popup,
            QEvent(QEvent.WindowDeactivate),
        )
        self.app.processEvents()

        self.assertFalse(popup.isVisible())

    def test_main_window_uses_clickable_count_and_opens_popup(self) -> None:
        with patch.object(MainWindow, "start_server", return_value=None):
            window = MainWindow()
        try:
            self.assertIsInstance(
                window.approval_stat_value,
                QPushButton,
            )
            window.approval_count = 5
            window.approval_type_counts = {
                "AskUserQuestion": 2,
                "Bash": 3,
            }
            window.update_approval_count()
            window.show()
            self.app.processEvents()

            window.approval_stat_value.click()
            self.app.processEvents()

            self.assertTrue(window.approval_stats_popup.isVisible())
            self.assertEqual(
                window.approval_stats_popup.total_label.text(),
                "共 5 次",
            )
            self.assertEqual(
                [
                    label.text()
                    for label in window.approval_stats_popup.findChildren(
                        QLabel,
                        "approvalStatsTool",
                    )
                ],
                ["AskUserQuestion", "Bash"],
            )
        finally:
            window.approval_stats_popup.close()
            window.tray_icon.hide()
            window.close()


if __name__ == "__main__":
    unittest.main()
