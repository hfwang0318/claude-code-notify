import io
import json
import os
import tempfile
import threading
import unittest
import urllib.request
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import claude_approval_hook as hook
from claude_code_notify.application.hooks import merge_settings_json
from claude_code_notify.infrastructure.http_server import (
    ClaudeNotifyHandler,
    ClaudeNotifyServer,
    HttpEventBridge,
)
from claude_code_notify.presentation.main_window import MainWindow
from PySide6.QtWidgets import QApplication


class PermissionDeniedStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = hook.SYNC_DB_PATH
        hook.SYNC_DB_PATH = str(
            Path(self.temp_dir.name) / "approval-sync.sqlite3"
        )

    def tearDown(self) -> None:
        hook.SYNC_DB_PATH = self.original_db_path
        self.temp_dir.cleanup()

    def denied_input(self, command: str = "rm -rf build") -> dict:
        return {
            "hook_event_name": "PermissionDenied",
            "session_id": "session-1",
            "prompt_id": "prompt-1",
            "tool_name": "Bash",
            "tool_use_id": "toolu-1",
            "tool_input": {"command": command},
            "reason": "Potentially destructive command",
        }

    def test_second_identical_denial_escalates_only_once(self) -> None:
        hook_input = self.denied_input()
        first = hook.record_permission_denial(
            hook_input,
            hook_input["tool_input"],
        )
        second = hook.record_permission_denial(
            hook_input,
            hook_input["tool_input"],
        )
        third = hook.record_permission_denial(
            hook_input,
            hook_input["tool_input"],
        )

        self.assertEqual(first["count"], 1)
        self.assertFalse(first["should_ask"])
        self.assertEqual(second["count"], 2)
        self.assertTrue(second["should_ask"])
        self.assertEqual(third["count"], 3)
        self.assertFalse(third["should_ask"])

    def test_fingerprint_ignores_whitespace_only_changes(self) -> None:
        first_input = self.denied_input("rm   -rf   build")
        second_input = self.denied_input("rm -rf build")
        first = hook.record_permission_denial(
            first_input,
            first_input["tool_input"],
        )
        second = hook.record_permission_denial(
            second_input,
            second_input["tool_input"],
        )
        self.assertEqual(first["fingerprint"], second["fingerprint"])
        self.assertTrue(second["should_ask"])

    def test_successful_same_tool_marks_denial_recovered(self) -> None:
        hook_input = self.denied_input()
        denied = hook.record_permission_denial(
            hook_input,
            hook_input["tool_input"],
        )
        self.assertIsNotNone(hook.denial_risk_summary("session-1"))

        recovered = hook.recover_permission_denials(
            {
                "session_id": "session-1",
                "tool_name": "Bash",
            }
        )
        self.assertEqual(recovered[0]["fingerprint"], denied["fingerprint"])
        self.assertIsNone(hook.denial_risk_summary("session-1"))

    def test_retry_output_uses_permission_denied_protocol(self) -> None:
        output = io.StringIO()
        with redirect_stdout(output):
            hook.emit_permission_denied_retry()
        self.assertEqual(
            json.loads(output.getvalue()),
            {
                "hookSpecificOutput": {
                    "hookEventName": "PermissionDenied",
                    "retry": True,
                }
            },
        )


class PermissionDeniedSettingsTests(unittest.TestCase):
    def test_popup_mode_installs_denial_and_recovery_hooks(self) -> None:
        handler = {
            "type": "command",
            "command": "python3 ~/.claude/claude_approval_hook.py",
        }
        merged = json.loads(
            merge_settings_json(
                "",
                mode="popup",
                hook_entry=handler,
                question_entry=handler,
                stage_entry=handler,
            )
        )
        self.assertIn("PermissionDenied", merged["hooks"])
        self.assertIn("PostToolUse", merged["hooks"])
        self.assertEqual(
            merged["hooks"]["PermissionDenied"][0]["hooks"][0]["timeout"],
            300,
        )
        self.assertEqual(
            merged["hooks"]["PostToolUse"][0]["hooks"][0]["timeout"],
            15,
        )

    def test_notify_mode_does_not_install_denial_intervention(self) -> None:
        handler = {
            "type": "command",
            "command": "python3 ~/.claude/claude_notify_hook.py",
        }
        merged = json.loads(
            merge_settings_json(
                "",
                mode="notify",
                hook_entry=handler,
                stage_entry=handler,
            )
        )
        self.assertNotIn("PermissionDenied", merged["hooks"])
        self.assertNotIn("PostToolUse", merged["hooks"])


class PermissionDeniedServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def test_authenticated_endpoint_forwards_denial_event(self) -> None:
        bridge = HttpEventBridge()
        received = []
        bridge.denial_received.connect(received.append)
        server = ClaudeNotifyServer(
            ("127.0.0.1", 0),
            ClaudeNotifyHandler,
            bridge,
            "test-token",
        )
        thread = threading.Thread(
            target=server.serve_forever,
            daemon=True,
        )
        thread.start()
        try:
            request = urllib.request.Request(
                (
                    f"http://127.0.0.1:{server.server_port}"
                    "/claude-denial"
                ),
                data=json.dumps(
                    {
                        "status": "denied",
                        "session_id": "session-1",
                        "fingerprint": "fingerprint-1",
                        "tool_name": "Bash",
                        "count": 1,
                    }
                ).encode("utf-8"),
                headers={
                    "Authorization": "Bearer test-token",
                    "Content-Type": "application/json",
                },
            )
            with urllib.request.urlopen(request, timeout=3) as response:
                self.assertEqual(response.status, 200)
            self.app.processEvents()
            self.assertEqual(len(received), 1)
            self.assertEqual(received[0]["fingerprint"], "fingerprint-1")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(3)


class PermissionDeniedPresentationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def make_window(self) -> MainWindow:
        with patch.object(MainWindow, "start_server", return_value=None):
            return MainWindow()

    def close_window(self, window: MainWindow) -> None:
        window.dismiss_all_stage_completion_popups()
        window.denial_stats_popup.close()
        window.approval_stats_popup.close()
        window.tray_icon.hide()
        window.close()

    def test_denial_updates_count_and_detail_record(self) -> None:
        window = self.make_window()
        try:
            with patch.object(window, "show_tray_notification") as notify:
                window.on_denial_received(
                    {
                        "status": "denied",
                        "session_id": "session-1",
                        "fingerprint": "fingerprint-1",
                        "tool_name": "Bash",
                        "detail": "rm -rf build",
                        "reason": "destructive",
                        "count": 2,
                        "escalated": True,
                    }
                )
            self.assertEqual(window.denial_count, 1)
            self.assertEqual(window.denial_stat_value.text(), "1")
            self.assertTrue(
                window.denial_records["fingerprint-1"]["escalated"]
            )
            notify.assert_called_once()
        finally:
            self.close_window(window)

    def test_unresolved_denial_risk_shows_even_when_stage_option_off(self) -> None:
        window = self.make_window()
        try:
            window.stage_completion_enabled = False
            window.on_stage_status_received(
                {
                    "status": "completed",
                    "session_id": "session-risk",
                    "cwd": "/work/project",
                    "denial_risk": {
                        "count": 2,
                        "last_tool_name": "Bash",
                        "last_reason": "destructive",
                    },
                }
            )
            self.assertIn(
                "session-risk",
                window.stage_completion_popups,
            )
            popup = window.stage_completion_popups["session-risk"]
            self.assertTrue(popup.denial_risk)
        finally:
            self.close_window(window)


if __name__ == "__main__":
    unittest.main()
