"""Process bootstrap and crash boundary."""
import sys
import traceback
from PySide6.QtWidgets import QApplication, QMessageBox, QSystemTrayIcon
from .config import APP_DATA_DIR, APP_NAME
from .presentation.main_window import MainWindow
from .presentation.theme import STYLE_SHEET

def main() -> int:
    def write_crash_log(text: str) -> None:
        try:
            APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
            (APP_DATA_DIR / "startup-crash.log").write_text(
                text,
                encoding="utf-8",
            )
        except Exception:
            pass

    def excepthook(exc_type, exc_value, exc_tb) -> None:
        write_crash_log(
            "".join(
                traceback.format_exception(
                    exc_type,
                    exc_value,
                    exc_tb,
                )
            )
        )
        sys.__excepthook__(exc_type, exc_value, exc_tb)

    sys.excepthook = excepthook

    app = QApplication(sys.argv)

    # 关闭最后一个窗口时不退出，继续驻留托盘。
    app.setQuitOnLastWindowClosed(False)
    app.setApplicationName(APP_NAME)
    app.setStyleSheet(STYLE_SHEET)

    if not QSystemTrayIcon.isSystemTrayAvailable():
        QMessageBox.critical(
            None,
            APP_NAME,
            "当前系统不可用系统托盘。",
        )
        return 1

    try:
        window = MainWindow()
        window.show()
    except Exception:
        write_crash_log(traceback.format_exc())
        raise

    return app.exec()
