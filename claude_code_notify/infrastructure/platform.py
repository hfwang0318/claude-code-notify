"""Operating-system services behind a stable facade."""
import os
import shutil
import subprocess
import sys
import traceback
from pathlib import Path
from typing import Any, Optional
from PySide6.QtCore import QPoint
from PySide6.QtGui import QCursor, QGuiApplication
from .secrets import SECRET_STORE, SecretStore

POPUP_SCREEN_MODES: dict[str, str] = {
    "primary": "主屏幕",
    "cursor": "鼠标所在屏幕",
    "focus": "焦点窗口所在屏幕",
}

def foreground_window_screen() -> Any:
    """
    Windows 实现：通过 Win32 获取前台窗口（任意应用）所在的屏幕。
    非 Windows 或获取失败时返回 None；跨平台调用请走 PLATFORM。
    """
    try:
        import ctypes
        import ctypes.wintypes as wintypes

        user32 = ctypes.windll.user32
    except (AttributeError, OSError):
        return None

    try:
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return None

        rect = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return None

        center_x = (rect.left + rect.right) // 2
        center_y = (rect.top + rect.bottom) // 2

        return QGuiApplication.screenAt(QPoint(center_x, center_y))
    except Exception:
        return None


# ============================================================================
# 平台服务外观（Strategy + Facade）：UI 只依赖 PLATFORM，不直接碰 Win32/macOS API
# ============================================================================

class PlatformServices:
    name = "generic"
    supports_focus_screen = False

    def __init__(self, secret_store: SecretStore) -> None:
        self.secret_store = secret_store

    def open_path(self, path: Path) -> bool:
        return False

    def foreground_window_screen(self) -> Any:
        return None

    def follow_active_space(self, window: Any) -> bool:
        """让窗口在切换桌面/工作区时保持可见（仅 macOS 需要实现）。"""
        return False

    def watch_active_space(self, window: Any) -> bool:
        """监听桌面/工作区切换（仅 macOS 需要实现）。"""
        return False


class WindowsServices(PlatformServices):
    name = "windows"
    supports_focus_screen = True

    def open_path(self, path: Path) -> bool:
        try:
            os.startfile(str(path))  # type: ignore[attr-defined]
            return True
        except (AttributeError, OSError):
            return False

    def foreground_window_screen(self) -> Any:
        return foreground_window_screen()


MAC_COLLECTION_CAN_JOIN_ALL_SPACES = 1 << 0
MAC_COLLECTION_MOVE_TO_ACTIVE_SPACE = 1 << 1
MAC_COLLECTION_FULL_SCREEN_AUXILIARY = 1 << 8


def mac_popup_collection_behavior(current: int) -> int:
    """保留 Qt 行为，同时让激活的弹窗迁入当前 Space。"""
    return (
        current & ~MAC_COLLECTION_CAN_JOIN_ALL_SPACES
    ) | (
        MAC_COLLECTION_MOVE_TO_ACTIVE_SPACE
        | MAC_COLLECTION_FULL_SCREEN_AUXILIARY
    )


_MAC_SPACE_CALLBACKS: dict[int, Any] = {}
_MAC_SPACE_OBSERVER_CLASS: Optional[int] = None
_MAC_SPACE_OBSERVER_IMP: Any = None


def _mac_space_notification_callback(
    observer: int,
    _selector: int,
    _notification: int,
) -> None:
    callback = _MAC_SPACE_CALLBACKS.get(int(observer))
    if callback is None:
        return
    try:
        callback()
    except Exception:
        traceback.print_exc()


class MacServices(PlatformServices):
    name = "macos"

    def __init__(self, secret_store: SecretStore) -> None:
        super().__init__(secret_store)
        self._space_observers: dict[int, tuple[Any, ...]] = {}

    def open_path(self, path: Path) -> bool:
        if shutil.which("open") is None:
            return False
        result = subprocess.run(
            ["open", str(path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return result.returncode == 0

    def follow_active_space(self, window: Any) -> bool:
        """
        macOS：让审批弹窗迁入当前 Space，并支持全屏应用所在 Space。
        可在首次 show 前预配置；窗口可见时会激活并迁移原生 NSWindow。
        通过 ctypes 调 Objective-C runtime，失败静默（不影响弹窗本身）。
        """
        app = QGuiApplication.instance()
        if app is None or app.platformName().lower() != "cocoa":
            # offscreen 等 Qt 后端的 winId() 可能只是占位值（例如 1），
            # 不能把它作为 Objective-C 对象指针传给 objc_msgSend。
            return False

        try:
            import ctypes

            objc = ctypes.CDLL("/usr/lib/libobjc.dylib")
            objc.sel_registerName.restype = ctypes.c_void_p
            objc.sel_registerName.argtypes = [ctypes.c_char_p]
            objc.objc_getClass.restype = ctypes.c_void_p
            objc.objc_getClass.argtypes = [ctypes.c_char_p]
            # winId() 返回 NSView*，取其 window 得 NSWindow*
            view = ctypes.c_void_p(int(window.winId()))
            objc.objc_msgSend.restype = ctypes.c_void_p
            objc.objc_msgSend.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
            ns_window = objc.objc_msgSend(
                view, objc.sel_registerName(b"window")
            )
            if not ns_window:
                return False

            # MoveToActiveSpace 与 CanJoinAllSpaces 互斥。静态加入所有
            # Spaces 在部分 Qt/macOS 组合上不会随切换刷新，因此改为
            # 收到 Space 通知后主动激活并迁移窗口。
            objc.objc_msgSend.restype = ctypes.c_ulonglong
            objc.objc_msgSend.argtypes = [
                ctypes.c_void_p,
                ctypes.c_void_p,
            ]
            current = int(
                objc.objc_msgSend(
                    ns_window,
                    objc.sel_registerName(b"collectionBehavior"),
                )
            )
            behavior = mac_popup_collection_behavior(current)

            objc.objc_msgSend.restype = None
            objc.objc_msgSend.argtypes = [
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_ulonglong,
            ]
            objc.objc_msgSend(
                ns_window,
                objc.sel_registerName(b"setCollectionBehavior:"),
                behavior,
            )

            # Qt.Tool 在应用失焦时可能隐藏；权限提示必须继续可见。
            objc.objc_msgSend.argtypes = [
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_bool,
            ]
            objc.objc_msgSend(
                ns_window,
                objc.sel_registerName(b"setHidesOnDeactivate:"),
                False,
            )

            # 构造阶段会在首次 show 前预配置 NSWindow，不能因此把隐藏
            # 窗口提前显示；showEvent 及 Space 通知才负责激活并迁移。
            if window.isVisible():
                ns_app_class = objc.objc_getClass(b"NSApplication")
                objc.objc_msgSend.restype = ctypes.c_void_p
                objc.objc_msgSend.argtypes = [
                    ctypes.c_void_p,
                    ctypes.c_void_p,
                ]
                ns_app = objc.objc_msgSend(
                    ns_app_class,
                    objc.sel_registerName(b"sharedApplication"),
                )
                objc.objc_msgSend.argtypes = [
                    ctypes.c_void_p,
                    ctypes.c_void_p,
                    ctypes.c_bool,
                ]
                objc.objc_msgSend(
                    ns_app,
                    objc.sel_registerName(b"activateIgnoringOtherApps:"),
                    True,
                )
                objc.objc_msgSend.argtypes = [
                    ctypes.c_void_p,
                    ctypes.c_void_p,
                    ctypes.c_void_p,
                ]
                objc.objc_msgSend(
                    ns_window,
                    objc.sel_registerName(b"makeKeyAndOrderFront:"),
                    None,
                )
            return True
        except Exception:
            return False

    def watch_active_space(self, window: Any) -> bool:
        """
        监听 NSWorkspaceActiveSpaceDidChangeNotification。Space 改变后，
        重新激活审批窗；配合 MoveToActiveSpace 将其迁入当前 Space。
        """
        app = QGuiApplication.instance()
        if app is None or app.platformName().lower() != "cocoa":
            return False

        key = id(window)
        if key in self._space_observers:
            return True

        try:
            import ctypes

            global _MAC_SPACE_OBSERVER_CLASS
            global _MAC_SPACE_OBSERVER_IMP

            objc = ctypes.CDLL("/usr/lib/libobjc.dylib")
            appkit = ctypes.CDLL(
                "/System/Library/Frameworks/AppKit.framework/AppKit"
            )
            objc.sel_registerName.restype = ctypes.c_void_p
            objc.sel_registerName.argtypes = [ctypes.c_char_p]
            objc.objc_getClass.restype = ctypes.c_void_p
            objc.objc_getClass.argtypes = [ctypes.c_char_p]

            if _MAC_SPACE_OBSERVER_CLASS is None:
                class_name = b"ClaudeNotifySpaceObserver"
                observer_class = objc.objc_getClass(class_name)
                if not observer_class:
                    superclass = objc.objc_getClass(b"NSObject")
                    objc.objc_allocateClassPair.restype = ctypes.c_void_p
                    objc.objc_allocateClassPair.argtypes = [
                        ctypes.c_void_p,
                        ctypes.c_char_p,
                        ctypes.c_size_t,
                    ]
                    observer_class = objc.objc_allocateClassPair(
                        superclass,
                        class_name,
                        0,
                    )
                    callback_type = ctypes.CFUNCTYPE(
                        None,
                        ctypes.c_void_p,
                        ctypes.c_void_p,
                        ctypes.c_void_p,
                    )
                    _MAC_SPACE_OBSERVER_IMP = callback_type(
                        _mac_space_notification_callback
                    )
                    objc.class_addMethod.restype = ctypes.c_bool
                    objc.class_addMethod.argtypes = [
                        ctypes.c_void_p,
                        ctypes.c_void_p,
                        ctypes.c_void_p,
                        ctypes.c_char_p,
                    ]
                    added = objc.class_addMethod(
                        observer_class,
                        objc.sel_registerName(
                            b"activeSpaceDidChange:"
                        ),
                        ctypes.cast(
                            _MAC_SPACE_OBSERVER_IMP,
                            ctypes.c_void_p,
                        ),
                        b"v@:@",
                    )
                    if not added:
                        return False
                    objc.objc_registerClassPair.argtypes = [
                        ctypes.c_void_p
                    ]
                    objc.objc_registerClassPair(observer_class)
                _MAC_SPACE_OBSERVER_CLASS = int(observer_class)

            objc.objc_msgSend.restype = ctypes.c_void_p
            objc.objc_msgSend.argtypes = [
                ctypes.c_void_p,
                ctypes.c_void_p,
            ]
            observer = objc.objc_msgSend(
                _MAC_SPACE_OBSERVER_CLASS,
                objc.sel_registerName(b"alloc"),
            )
            observer = objc.objc_msgSend(
                observer,
                objc.sel_registerName(b"init"),
            )
            workspace_class = objc.objc_getClass(b"NSWorkspace")
            workspace = objc.objc_msgSend(
                workspace_class,
                objc.sel_registerName(b"sharedWorkspace"),
            )
            center = objc.objc_msgSend(
                workspace,
                objc.sel_registerName(b"notificationCenter"),
            )
            notification_name = ctypes.c_void_p.in_dll(
                appkit,
                "NSWorkspaceActiveSpaceDidChangeNotification",
            ).value

            def on_space_change() -> None:
                if window.isVisible():
                    self.follow_active_space(window)

            _MAC_SPACE_CALLBACKS[int(observer)] = on_space_change
            objc.objc_msgSend.restype = None
            objc.objc_msgSend.argtypes = [
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_void_p,
            ]
            objc.objc_msgSend(
                center,
                objc.sel_registerName(
                    b"addObserver:selector:name:object:"
                ),
                observer,
                objc.sel_registerName(b"activeSpaceDidChange:"),
                notification_name,
                workspace,
            )
            self._space_observers[key] = (
                objc,
                observer,
                center,
                notification_name,
                workspace,
            )
            window.destroyed.connect(
                lambda *_args, observer_key=key: self._stop_space_watch(
                    observer_key
                )
            )
            return True
        except Exception:
            return False

    def _stop_space_watch(self, key: int) -> None:
        import ctypes

        state = self._space_observers.pop(key, None)
        if state is None:
            return
        objc, observer, center, notification_name, workspace = state
        _MAC_SPACE_CALLBACKS.pop(int(observer), None)
        try:
            objc.objc_msgSend.restype = None
            objc.objc_msgSend.argtypes = [
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_void_p,
            ]
            objc.objc_msgSend(
                center,
                objc.sel_registerName(
                    b"removeObserver:name:object:"
                ),
                observer,
                notification_name,
                workspace,
            )
            objc.objc_msgSend.argtypes = [
                ctypes.c_void_p,
                ctypes.c_void_p,
            ]
            objc.objc_msgSend(
                observer,
                objc.sel_registerName(b"release"),
            )
        except Exception:
            pass


class LinuxServices(PlatformServices):
    name = "linux"

    def open_path(self, path: Path) -> bool:
        opener = shutil.which("xdg-open")
        if opener is None:
            return False
        result = subprocess.run(
            [opener, str(path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return result.returncode == 0


def create_platform_services() -> PlatformServices:
    if sys.platform == "win32":
        return WindowsServices(SECRET_STORE)
    if sys.platform == "darwin":
        return MacServices(SECRET_STORE)
    return LinuxServices(SECRET_STORE)


PLATFORM = create_platform_services()


def pick_popup_screen(mode: str) -> Any:
    """
    按策略选择弹窗目标屏幕，带回退链：
    focus → cursor → primary；cursor → primary。
    """
    if mode == "focus":
        screen = PLATFORM.foreground_window_screen()
        if screen is not None:
            return screen
        mode = "cursor"  # 回退：焦点窗口获取失败时跟随鼠标

    if mode == "cursor":
        screen = QGuiApplication.screenAt(QCursor.pos())
        if screen is not None:
            return screen

    return QGuiApplication.primaryScreen()
