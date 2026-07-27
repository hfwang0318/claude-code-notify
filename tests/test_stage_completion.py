import json
import os
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication

import claude_approval_hook
import claude_notify_hook
import claude_notify_server
from claude_notify_server import (
    ClaudeNotifyHandler,
    ClaudeNotifyServer,
    HttpEventBridge,
    MainWindow,
    StageCompletionPopup,
    merge_settings_json,
)


class SettingsTests(unittest.TestCase):
    def test_both_modes_install_stage_lifecycle_hooks(self) -> None:
        for mode, script in (
            ("popup", "claude_approval_hook.py"),
            ("notify", "claude_notify_hook.py"),
        ):
            with self.subTest(mode=mode):
                handler = {
                    "type": "command",
                    "command": f"python3 ~/.claude/{script}",
                }
                merged = json.loads(
                    merge_settings_json(
                        "",
                        mode=mode,
                        hook_entry=handler,
                        question_entry=(
                            handler if mode == "popup" else None
                        ),
                        stage_entry=handler,
                    )
                )

                self.assertIn("Stop", merged["hooks"])
                self.assertIn(
                    "UserPromptSubmit",
                    merged["hooks"],
                )
                for event in ("Stop", "UserPromptSubmit"):
                    stage_hook = merged["hooks"][event][0]
                    self.assertEqual(stage_hook["matcher"], "")
                    self.assertEqual(
                        stage_hook["hooks"][0]["timeout"],
                        15,
                    )

    def test_redeploy_removes_old_stage_hooks(self) -> None:
        old = {
            "hooks": {
                "Stop": [
                    {
                        "matcher": "",
                        "hooks": [
                            {
                                "type": "command",
                                "command": (
                                    "python3 ~/.claude/"
                                    "claude_notify_hook.py"
                                ),
                            }
                        ],
                    },
                    {
                        "matcher": "",
                        "hooks": [
                            {
                                "type": "command",
                                "command": "python3 other_hook.py",
                            }
                        ],
                    },
                ]
            }
        }
        handler = {
            "type": "command",
            "command": "python3 ~/.claude/claude_approval_hook.py",
        }
        merged = json.loads(
            merge_settings_json(
                json.dumps(old),
                mode="popup",
                hook_entry=handler,
                question_entry=handler,
                stage_entry=handler,
            )
        )

        stop_entries = merged["hooks"]["Stop"]
        self.assertEqual(len(stop_entries), 2)
        serialized = json.dumps(stop_entries)
        self.assertIn("other_hook.py", serialized)
        self.assertIn("claude_approval_hook.py", serialized)
        self.assertNotIn("claude_notify_hook.py", serialized)


class HookPayloadTests(unittest.TestCase):
    def test_both_hook_scripts_send_the_same_stage_payload(self) -> None:
        hook_input = {
            "session_id": "session-1",
            "cwd": "/work/project",
            "transcript_path": "/tmp/transcript.jsonl",
        }

        for module in (claude_approval_hook, claude_notify_hook):
            captured = {}

            class Response:
                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    return False

            def fake_urlopen(request, timeout):
                captured["url"] = request.full_url
                captured["timeout"] = timeout
                captured["payload"] = json.loads(
                    request.data.decode("utf-8")
                )
                return Response()

            with self.subTest(module=module.__name__), patch.object(
                module.urllib.request,
                "urlopen",
                side_effect=fake_urlopen,
            ):
                module.notify_stage_status(
                    hook_input,
                    "completed",
                )

            self.assertTrue(
                captured["url"].endswith("/claude-stage-status")
            )
            self.assertEqual(
                captured["payload"],
                {
                    "status": "completed",
                    "session_id": "session-1",
                    "cwd": "/work/project",
                    "transcript_path": "/tmp/transcript.jsonl",
                },
            )


class StageStatusServerTests(unittest.TestCase):
    def test_authenticated_endpoint_forwards_stage_status(self) -> None:
        bridge = HttpEventBridge()
        received = []
        bridge.stage_status_received.connect(received.append)
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
            payload = json.dumps(
                {
                    "status": "completed",
                    "session_id": "session-1",
                    "cwd": "/work/project",
                }
            ).encode("utf-8")
            request = urllib.request.Request(
                (
                    f"http://127.0.0.1:{server.server_port}"
                    "/claude-stage-status"
                ),
                data=payload,
                headers={
                    "Authorization": "Bearer test-token",
                    "Content-Type": "application/json",
                },
            )
            with urllib.request.urlopen(request, timeout=3) as response:
                self.assertEqual(response.status, 200)

            app = QApplication.instance()
            if app is not None:
                app.processEvents()
            self.assertEqual(len(received), 1)
            self.assertEqual(received[0]["status"], "completed")
            self.assertEqual(received[0]["session_id"], "session-1")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(3)


class StageCompletionPopupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def make_window(self, config_path: Path) -> MainWindow:
        with patch.object(
            claude_notify_server,
            "UI_CONFIG_FILE",
            config_path,
        ), patch.object(
            MainWindow,
            "start_server",
            return_value=None,
        ):
            return MainWindow()

    def test_popup_is_topmost_and_closes_when_session_resumes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            window = self.make_window(
                Path(temp_dir) / "ui_config.json"
            )
            try:
                window.stage_completion_check.setChecked(True)
                payload = {
                    "status": "completed",
                    "session_id": "session-1",
                    "cwd": "/work/project",
                }
                window.on_stage_status_received(payload)
                self.app.processEvents()

                popup = window.stage_completion_popups["session-1"]
                self.assertIsInstance(popup, StageCompletionPopup)
                self.assertTrue(popup.isVisible())
                self.assertTrue(
                    bool(
                        popup.windowFlags()
                        & Qt.WindowStaysOnTopHint
                    )
                )

                window.on_stage_status_received(
                    {
                        "status": "resumed",
                        "session_id": "session-1",
                    }
                )
                self.app.processEvents()

                self.assertNotIn(
                    "session-1",
                    window.stage_completion_popups,
                )
            finally:
                window.dismiss_all_stage_completion_popups()
                window.tray_icon.hide()
                window.close()

    def test_disabled_option_does_not_show_popup(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            window = self.make_window(
                Path(temp_dir) / "ui_config.json"
            )
            try:
                self.assertFalse(window.stage_completion_enabled)
                window.on_stage_status_received(
                    {
                        "status": "completed",
                        "session_id": "session-1",
                    }
                )
                self.app.processEvents()
                self.assertEqual(
                    window.stage_completion_popups,
                    {},
                )
            finally:
                window.tray_icon.hide()
                window.close()


if __name__ == "__main__":
    unittest.main()
