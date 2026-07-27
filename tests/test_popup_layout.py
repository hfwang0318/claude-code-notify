import os
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication, QPushButton

import claude_notify_server as server


class PopupLayoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])
        cls.app.setStyleSheet(server.STYLE_SHEET)
        cls.original_platform = server.PLATFORM
        server.PLATFORM = server.PlatformServices(server.SECRET_STORE)

    @classmethod
    def tearDownClass(cls) -> None:
        server.PLATFORM = cls.original_platform

    def create_popup(self, option_count: int) -> server.ApprovalPopup:
        options = [
            {"id": "allow", "label": "允许"},
            {"id": "always", "label": "始终允许此命令"},
            {"id": "deny", "label": "拒绝"},
            {"id": "custom", "label": "使用自定义规则"},
            {"id": "sandbox", "label": "仅在沙箱中允许"},
            {"id": "session", "label": "本次会话允许"},
        ][:option_count]
        request = server.ApprovalRequest(
            {
                "tool_name": "Bash",
                "cwd": "/tmp/project",
                "message": "执行命令",
                "options": options,
            },
            30,
        )
        popup = server.ApprovalPopup(request)
        popup.setWindowModality(Qt.NonModal)
        popup.show()
        self.app.processEvents()
        self.addCleanup(popup.close)
        return popup

    def test_three_options_put_terminal_action_on_separate_row(self) -> None:
        popup = self.create_popup(3)
        buttons = popup.findChildren(QPushButton)
        terminal = next(
            button
            for button in buttons
            if button.objectName() == "approveTerminal"
        )
        decisions = [
            button
            for button in buttons
            if button.objectName()
            not in {"popupClose", "approveTerminal"}
        ]

        decision_bottom = max(
            button.geometry().bottom() for button in decisions
        )
        self.assertGreater(
            terminal.geometry().top(),
            decision_bottom,
            "三项及以上时，终端操作必须独占下一行，避免挤压/重叠",
        )

    def test_decision_buttons_never_overlap_for_one_to_six_options(
        self,
    ) -> None:
        for count in range(1, 7):
            with self.subTest(count=count):
                popup = self.create_popup(count)
                decisions = [
                    button
                    for button in popup.findChildren(QPushButton)
                    if button.objectName()
                    not in {"popupClose", "approveTerminal"}
                ]
                for index, left in enumerate(decisions):
                    for right in decisions[index + 1 :]:
                        self.assertFalse(
                            left.geometry().intersects(right.geometry()),
                            f"{count} 个选项时按钮发生重叠",
                        )

    def test_three_to_six_options_use_separate_terminal_row(self) -> None:
        for count in range(3, 7):
            with self.subTest(count=count):
                popup = self.create_popup(count)
                buttons = popup.findChildren(QPushButton)
                terminal = next(
                    button
                    for button in buttons
                    if button.objectName() == "approveTerminal"
                )
                decisions = [
                    button
                    for button in buttons
                    if button.objectName()
                    not in {"popupClose", "approveTerminal"}
                ]
                self.assertGreater(
                    terminal.geometry().top(),
                    max(
                        button.geometry().bottom()
                        for button in decisions
                    ),
                )


class MacSpaceBehaviorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def test_popup_configures_space_behavior_before_first_show(self) -> None:
        class RecordingPlatform(server.PlatformServices):
            def __init__(self) -> None:
                super().__init__(server.SECRET_STORE)
                self.visibility: list[bool] = []
                self.watch_visibility: list[bool] = []

            def follow_active_space(self, window) -> bool:
                self.visibility.append(window.isVisible())
                return True

            def watch_active_space(self, window) -> bool:
                self.watch_visibility.append(window.isVisible())
                return True

        original_platform = server.PLATFORM
        platform = RecordingPlatform()
        server.PLATFORM = platform
        popup = None
        try:
            request = server.ApprovalRequest(
                {
                    "tool_name": "Bash",
                    "cwd": "/tmp/project",
                    "message": "执行命令",
                },
                30,
            )
            popup = server.ApprovalPopup(request)

            self.assertEqual(platform.visibility, [False])
            self.assertEqual(platform.watch_visibility, [False])

            popup.show()
            self.app.processEvents()
            self.assertIn(True, platform.visibility)
        finally:
            if popup is not None:
                popup.close()
            server.PLATFORM = original_platform

    def test_popup_moves_to_active_and_fullscreen_space(self) -> None:
        unrelated_behavior = 1 << 4
        current = (
            unrelated_behavior
            | server.MAC_COLLECTION_CAN_JOIN_ALL_SPACES
        )

        result = server.mac_popup_collection_behavior(current)

        self.assertTrue(
            result & server.MAC_COLLECTION_MOVE_TO_ACTIVE_SPACE
        )
        self.assertTrue(
            result & server.MAC_COLLECTION_FULL_SCREEN_AUXILIARY
        )
        self.assertTrue(result & unrelated_behavior)
        self.assertFalse(
            result & server.MAC_COLLECTION_CAN_JOIN_ALL_SPACES
        )


if __name__ == "__main__":
    unittest.main()

