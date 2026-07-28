import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import claude_approval_hook as hook
from claude_notify_server import (
    ApprovalRequest,
    ClaudeNotifyServer,
    HttpEventBridge,
    merge_settings_json,
)


class ApprovalCorrelationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = hook.SYNC_DB_PATH
        hook.SYNC_DB_PATH = str(
            Path(self.temp_dir.name) / "approval-sync.sqlite3"
        )

    def tearDown(self) -> None:
        hook.SYNC_DB_PATH = self.original_db_path
        self.temp_dir.cleanup()

    def hook_input(self, tool_use_id: str) -> dict:
        return {
            "session_id": "session-1",
            "prompt_id": "prompt-1",
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": "echo same"},
            "tool_use_id": tool_use_id,
            "transcript_path": "/tmp/transcript.jsonl",
        }

    def test_identical_calls_claim_distinct_official_ids(self) -> None:
        tool_input = {"command": "echo same"}
        first_request = hook.record_pretooluse(
            self.hook_input("toolu_first"),
            tool_input,
        )
        second_request = hook.record_pretooluse(
            self.hook_input("toolu_second"),
            tool_input,
        )

        permission_input = {
            "session_id": "session-1",
            "prompt_id": "prompt-1",
            "tool_name": "Bash",
        }
        first_claim = hook.claim_pretooluse(
            permission_input,
            tool_input,
        )
        second_claim = hook.claim_pretooluse(
            permission_input,
            tool_input,
        )

        self.assertNotEqual(first_request, second_request)
        self.assertEqual(
            {
                first_claim["tool_use_id"],
                second_claim["tool_use_id"],
            },
            {"toolu_first", "toolu_second"},
        )
        self.assertIsNone(
            hook.claim_pretooluse(permission_input, tool_input)
        )

    def test_missing_tool_use_id_is_not_fabricated(self) -> None:
        payload = self.hook_input("")
        self.assertIsNone(
            hook.record_pretooluse(payload, payload["tool_input"])
        )


class TranscriptDetectionTests(unittest.TestCase):
    def test_finds_only_matching_tool_result(self) -> None:
        record = {
            "message": {
                "content": [
                    {"type": "tool_use", "id": "toolu_target"},
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_target",
                        "content": "User rejected tool use",
                    },
                ]
            }
        }
        self.assertTrue(
            hook.contains_tool_result(record, "toolu_target")
        )
        self.assertFalse(
            hook.contains_tool_result(record, "toolu_other")
        )

    def test_watcher_handles_partially_written_json_line(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            transcript = Path(temp_dir) / "transcript.jsonl"
            transcript.write_bytes(b"")
            stop_event = threading.Event()
            notified = threading.Event()
            original_notify = hook.notify_terminal_resolved

            def fake_notify(
                request_id: str,
                tool_use_id: str,
                watcher_stop: threading.Event,
            ) -> None:
                if (
                    request_id == "request-1"
                    and tool_use_id == "toolu_target"
                ):
                    notified.set()

            hook.notify_terminal_resolved = fake_notify
            watcher = threading.Thread(
                target=hook.watch_transcript,
                args=(
                    str(transcript),
                    "request-1",
                    "toolu_target",
                    stop_event,
                ),
            )
            watcher.start()
            try:
                with transcript.open("ab") as file:
                    file.write(
                        b'{"message":{"content":[{"type":"tool_result",'
                    )
                    file.flush()
                    time.sleep(0.3)
                    file.write(
                        b'"tool_use_id":"toolu_target"}]}}\n'
                    )
                    file.flush()
                self.assertTrue(notified.wait(2))
            finally:
                stop_event.set()
                watcher.join(2)
                hook.notify_terminal_resolved = original_notify


class ApprovalRequestTests(unittest.TestCase):
    def test_first_result_wins_under_race(self) -> None:
        request = ApprovalRequest(
            {"request_id": "request-1", "tool_name": "Bash"},
            30,
        )
        barrier = threading.Barrier(3)
        results = []

        def finish(decision: str) -> None:
            barrier.wait()
            results.append(request.finish(decision))

        first = threading.Thread(target=finish, args=("allow",))
        second = threading.Thread(target=finish, args=("cancelled",))
        first.start()
        second.start()
        barrier.wait()
        first.join()
        second.join()

        self.assertEqual(sum(results), 1)
        self.assertIn(request.decision, {"allow", "cancelled"})

    def test_server_resolves_registered_request_by_id(self) -> None:
        bridge = HttpEventBridge()
        # 不绑定端口，只构造本测试涉及的 registry 状态。
        server = object.__new__(ClaudeNotifyServer)
        server.bridge = bridge
        server.approval_lock = threading.Lock()
        server.active_approvals = {}
        request = ApprovalRequest(
            {"request_id": "request-1", "tool_name": "Bash"},
            30,
        )
        server.register_approval(request)

        self.assertEqual(
            server.resolve_from_terminal("request-1"),
            "resolved",
        )
        self.assertTrue(request.event.is_set())
        self.assertEqual(request.decision, "cancelled")
        self.assertEqual(
            server.resolve_from_terminal("request-1"),
            "already_finished",
        )


class SettingsTests(unittest.TestCase):
    def test_popup_installs_pretooluse_observer_for_all_tools(self) -> None:
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
            )
        )

        pretooluse = merged["hooks"]["PreToolUse"]
        self.assertEqual(len(pretooluse), 1)
        self.assertEqual(pretooluse[0]["matcher"], "")
        self.assertEqual(
            merged["hooks"]["PermissionRequest"][0]["matcher"],
            "",
        )


if __name__ == "__main__":
    unittest.main()

