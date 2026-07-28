import tempfile
import unittest
from pathlib import Path
from unittest import mock

from claude_code_notify.infrastructure.local_integration import (
    PosixLocalIntegration,
    WindowsLocalIntegration,
    create_local_integration_adapter,
)


class LocalIntegrationAdapterTests(unittest.TestCase):
    def test_windows_uses_exec_form_and_needs_no_shell_selection(self) -> None:
        adapter = WindowsLocalIntegration()
        script = Path(r"C:\Users\dev\.claude\hook.py")
        with mock.patch(
            "claude_code_notify.infrastructure.local_integration."
            "resolve_local_python",
            return_value=r"C:\Python313\python.exe",
        ):
            entry = adapter.build_hook_entry({"TOKEN": "secret"}, script)

        self.assertFalse(adapter.requires_shell_selection)
        self.assertEqual(
            entry,
            {
                "type": "command",
                "command": r"C:\Python313\python.exe",
                "args": [str(script)],
            },
        )

    def test_windows_environment_update_is_delegated_to_setx(self) -> None:
        adapter = WindowsLocalIntegration()
        with mock.patch(
            "claude_code_notify.infrastructure.local_integration."
            "subprocess.run"
        ) as run:
            messages = adapter.write_environment("secret", ["bash"])

        run.assert_called_once_with(
            ["setx", "CLAUDE_NOTIFY_TOKEN", "secret"],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(len(messages), 1)

    def test_posix_uses_shell_form_and_applies_file_modes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            adapter = PosixLocalIntegration(home=root)
            script = root / "hook script.py"
            script.write_text("pass\n", encoding="utf-8")
            config = root / "config.json"
            config.write_text("{}\n", encoding="utf-8")

            with mock.patch.object(Path, "chmod") as chmod:
                adapter.prepare_directory(root)
                adapter.prepare_executable(script)
                adapter.protect_config(config)

            chmod.assert_has_calls(
                [
                    mock.call(0o700),
                    mock.call(0o755),
                    mock.call(0o600),
                ]
            )
            entry = adapter.build_hook_entry(
                {"TOKEN": "with space"},
                script,
            )

            self.assertTrue(adapter.requires_shell_selection)
            self.assertIn("TOKEN='with space'", entry["command"])
            self.assertIn(
                f"'{script}'",
                entry["command"],
            )

    def test_posix_environment_update_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            rc_path = root / ".bashrc"
            rc_path.write_text("export KEEP=1\n", encoding="utf-8")
            adapter = PosixLocalIntegration(home=root)

            adapter.write_environment("first", ["bash"])
            messages = adapter.write_environment("second", ["bash"])
            updated = rc_path.read_text(encoding="utf-8")

            self.assertEqual(updated.count("# >>> claude-notify >>>"), 1)
            self.assertNotIn("first", updated)
            self.assertIn("second", updated)
            self.assertIn("export KEEP=1", updated)
            self.assertEqual(len(messages), 1)

    def test_factory_selects_platform_adapter(self) -> None:
        with mock.patch(
            "claude_code_notify.infrastructure.local_integration."
            "sys.platform",
            "win32",
        ):
            self.assertIsInstance(
                create_local_integration_adapter(),
                WindowsLocalIntegration,
            )
        with mock.patch(
            "claude_code_notify.infrastructure.local_integration."
            "sys.platform",
            "darwin",
        ):
            self.assertIsInstance(
                create_local_integration_adapter(),
                PosixLocalIntegration,
            )


if __name__ == "__main__":
    unittest.main()
