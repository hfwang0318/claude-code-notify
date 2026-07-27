#!/usr/bin/env python3
"""
Claude Code Notify 兼容入口。

实际实现位于 ``claude_code_notify`` 包中。保留本模块是为了兼容既有启动命令、
PyInstaller 配置、第三方导入和旧版测试；新代码应直接依赖所属分层模块。
"""

import sys
from types import ModuleType

from claude_code_notify.app import main
from claude_code_notify.application.hooks import *
from claude_code_notify.config import *
from claude_code_notify.core import *
from claude_code_notify.domain.approval import *
from claude_code_notify.infrastructure.deployment import *
from claude_code_notify.infrastructure.http_server import *
from claude_code_notify.infrastructure.platform import *
from claude_code_notify.infrastructure.secrets import *
from claude_code_notify.presentation.approval_popup import *
from claude_code_notify.presentation.components import *
from claude_code_notify.presentation.dialogs import *
from claude_code_notify.presentation.main_window import *
from claude_code_notify.presentation.stage_popup import *
from claude_code_notify.presentation.theme import *

import claude_code_notify.config as _config_module
import claude_code_notify.infrastructure.platform as _platform_module
import claude_code_notify.presentation.approval_popup as _approval_popup_module
import claude_code_notify.presentation.main_window as _main_window_module
import claude_code_notify.presentation.stage_popup as _stage_popup_module


class _CompatibilityModule(ModuleType):
    """把旧入口上的测试替身同步到真实模块，维持历史 monkeypatch 行为。"""

    def __setattr__(self, name, value):
        super().__setattr__(name, value)
        if name == "PLATFORM":
            _platform_module.PLATFORM = value
            _approval_popup_module.PLATFORM = value
            _stage_popup_module.PLATFORM = value
            _main_window_module.PLATFORM = value
        elif name == "UI_CONFIG_FILE":
            _config_module.UI_CONFIG_FILE = value
            _main_window_module.UI_CONFIG_FILE = value


sys.modules[__name__].__class__ = _CompatibilityModule


if __name__ == "__main__":
    raise SystemExit(main())
