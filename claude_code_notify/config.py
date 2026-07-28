"""Stable application and protocol configuration."""
from pathlib import Path

APP_NAME = "Claude Code Notify"
HOST = "0.0.0.0"
PORT = 18765
NOTIFY_PATH = "/claude-notify"
APPROVAL_PATH = "/claude-approval"
APPROVAL_RESOLVED_PATH = "/claude-approval-resolved"
STAGE_STATUS_PATH = "/claude-stage-status"
HEALTH_PATH = "/health"
MAX_REQUEST_SIZE = 1024 * 1024
DEDUP_SECONDS = 3
DEFAULT_APPROVAL_TIMEOUT = 50
MAX_APPROVAL_TIMEOUT = 600
USER_HOME = Path.home()
APP_DATA_DIR = USER_HOME / ".claude-notify"
TOKEN_FILE = APP_DATA_DIR / "token"
LOG_FILE = APP_DATA_DIR / "claude-notify.log"
UI_CONFIG_FILE = APP_DATA_DIR / "ui_config.json"
