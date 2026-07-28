import os
import subprocess
import sys
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


class MacPlatformServicesTests(unittest.TestCase):
    def test_follow_active_space_ignores_offscreen_window_handle(self) -> None:
        script = """
from PySide6.QtWidgets import QApplication, QWidget
import claude_notify_server as server

app = QApplication([])
window = QWidget()
window.show()
server.MacServices(server.SECRET_STORE).follow_active_space(window)
"""
        env = os.environ.copy()
        env["QT_QPA_PLATFORM"] = "offscreen"
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=PROJECT_ROOT,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(
            result.returncode,
            0,
            msg=f"stderr:\n{result.stderr}",
        )

    def test_watch_active_space_ignores_offscreen_window_handle(self) -> None:
        script = """
from PySide6.QtWidgets import QApplication, QWidget
import claude_notify_server as server

app = QApplication([])
window = QWidget()
window.show()
result = server.MacServices(
    server.SECRET_STORE
).watch_active_space(window)
assert result is False
"""
        env = os.environ.copy()
        env["QT_QPA_PLATFORM"] = "offscreen"
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=PROJECT_ROOT,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(
            result.returncode,
            0,
            msg=f"stderr:\n{result.stderr}",
        )


if __name__ == "__main__":
    unittest.main()

