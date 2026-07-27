"""Application visual theme. No business behavior belongs here."""

# 深色主题样式表
# ============================================================================


# 界面字体栈：拉丁字符优先用各平台英文 UI 字体，中文自动回退到中文字体
FONT_UI = (
    '"Segoe UI", "PingFang SC", "Microsoft YaHei UI", '
    '"Noto Sans CJK SC", sans-serif'
)
# 等宽场景（日志/地址/徽章）：英文等宽优先，中文回退中文字体
FONT_MONO = (
    '"Cascadia Code", "SF Mono", Menlo, Consolas, '
    '"Microsoft YaHei UI", "PingFang SC", monospace'
)

STYLE_SHEET = """
/* 最终合并方案：冷色深色底 + Claude coral 重点色 + 1px hairline */
QMainWindow, QWidget {
    background-color: #101216;
    color: #F5F7FA;
    font-family: __FONT_UI__;
    font-size: 14px;
}

QFrame#card {
    background-color: #16191F;
    border: 1px solid #2A2F38;
    border-radius: 12px;
}

QLabel#cardTitle {
    color: #A7AEB8;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 1px;
}
QLabel { background-color: transparent; }

QLabel#h1 { font-size: 19px; font-weight: 800; letter-spacing: -0.2px; }
QLabel#subtitle { color: #6B7280; font-size: 12px; font-family: __FONT_MONO__; letter-spacing: 1px; }
QLabel#fieldLabel { color: #6B7280; font-size: 13px; }
QLabel#hint { color: #6B7280; font-size: 12px; }
QLabel#kbd {
    color: #A7AEB8; border: 1px solid #3A414D; border-radius: 5px; padding: 1px 6px;
    font-family: __FONT_MONO__; font-size: 12px;
}

QLabel#statValue { color: #F5F7FA; font-size: 20px; font-weight: 800; font-family: __FONT_MONO__; }
QLabel#statLabel { color: #6B7280; font-size: 12px; }
QPushButton#approvalStatValue {
    min-height: 26px;
    color: #F5F7FA;
    font-size: 20px;
    font-weight: 800;
    font-family: __FONT_MONO__;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 0 8px;
}
QPushButton#approvalStatValue:hover {
    color: #E98A6B;
    background-color: rgba(217, 119, 87, 0.08);
    border-color: rgba(217, 119, 87, 0.40);
}
QPushButton#approvalStatValue:pressed {
    background-color: rgba(217, 119, 87, 0.14);
}
QLabel#statusK { color: #6B7280; font-size: 12px; }
QLabel#statusV { color: #F5F7FA; font-size: 15px; font-weight: 750; font-family: __FONT_MONO__; }
QLabel#statusOk { color: #43B581; }
QLabel#statusInfo { color: #6FA8C7; }

QLabel#pillRunning {
    background-color: rgba(67, 181, 129, 0.10);
    color: #8FE0B6;
    border: 1px solid rgba(67, 181, 129, 0.42);
    border-radius: 15px;
    padding: 5px 14px;
    font-family: __FONT_MONO__;
    font-size: 12px;
    font-weight: 700;
}
QLabel#pillStopped {
    background-color: rgba(167, 174, 184, 0.08);
    color: #A7AEB8;
    border: 1px solid #3A414D;
    border-radius: 15px;
    padding: 5px 14px;
    font-family: __FONT_MONO__;
    font-size: 12px;
    font-weight: 700;
}

QLineEdit {
    background-color: #0C0E12;
    border: 1px solid #2A2F38;
    border-radius: 8px;
    padding: 7px 10px;
    color: #F5F7FA;
    font-family: __FONT_MONO__;
    font-size: 13px;
    selection-background-color: #D97757;
}
QLineEdit:read-only {
    background-color: transparent;
    border: none;
    color: #C7CDD6;
    padding-left: 0;
    padding-right: 0;
}
QLineEdit:read-only:focus { border: none; }
QLineEdit:focus, QTextEdit:focus, QPushButton:focus {
    border-color: #E98A6B;
    outline: none;
}

QPushButton {
    min-height: 34px;
    background-color: transparent;
    border: 1px solid #3A414D;
    border-radius: 9px;
    padding: 6px 14px;
    color: #A7AEB8;
}
QPushButton:hover { background-color: rgba(167, 174, 184, 0.08); border-color: #46505D; color: #F5F7FA; }
QPushButton:pressed { background-color: rgba(167, 174, 184, 0.14); }
QPushButton:disabled { color: #5E564F; border-color: #232730; }
QPushButton#primaryButton, QPushButton#approveAllow {
    min-height: 42px;
    background-color: #D97757;
    border-color: #D97757;
    color: #2A140E;
    font-weight: 850;
}
QPushButton#primaryButton:hover, QPushButton#approveAllow:hover { background-color: #E98A6B; border-color: #E98A6B; }
QPushButton#mini { min-height: 28px; padding: 3px 11px; font-size: 12px; border-radius: 7px; }
QPushButton#miniDanger { min-height: 28px; padding: 3px 11px; font-size: 12px; border-radius: 7px; color: #F0A096; border-color: rgba(216, 92, 70, 0.55); }
QPushButton#miniDanger:hover { background-color: rgba(216, 92, 70, 0.12); }
QPushButton#dangerSolid { color: #F0A096; border-color: rgba(216, 92, 70, 0.60); }
QPushButton#dangerSolid:hover { background-color: rgba(216, 92, 70, 0.14); }
QPushButton#tab {
    min-height: 28px; background-color: transparent; border: 1px solid #2A2F38; color: #6B7280;
    border-radius: 7px; padding: 3px 12px; font-size: 12px; font-family: __FONT_MONO__;
}
QPushButton#tab:checked { background-color: rgba(167, 174, 184, 0.10); border-color: #46505D; color: #F5F7FA; }

QTextEdit#log, QTextEdit#approvalDetail {
    background-color: #0C0E12;
    border: 1px solid #2A2F38;
    border-radius: 9px;
    padding: 7px 10px;
    color: #C7CDD6;
    font-family: __FONT_MONO__;
    font-size: 13px;
}
QLabel#toast {
    background-color: #1B1F26; border: 1px solid #3A414D; border-radius: 9px;
    padding: 9px 18px; color: #F5F7FA; font-size: 13px;
}
QLabel#deploySummary {
    background-color: transparent; border: none; padding: 0;
    color: #A7AEB8; font-family: __FONT_MONO__; font-size: 12px;
}

/* ---------------- 审批弹窗 ---------------- */
QWidget#approvalPopupRoot { background: transparent; }
QFrame#approvalCard {
    background-color: rgba(28, 25, 23, 0.98);
    border: 1px solid #3A414D;
    border-left: 3px solid #D97757;
    border-radius: 14px;
}
QLabel#approvalKicker {
    color: #E98A6B; font-family: __FONT_MONO__; font-size: 11px; font-weight: 700; letter-spacing: 2px;
}
QLabel#approvalTitle { color: #F5F7FA; font-size: 20px; font-weight: 850; letter-spacing: -0.2px; }
QLabel#approvalDesc { color: #A7AEB8; font-size: 13px; }
QLabel#approvalProject { color: #6B7280; font-size: 13px; }
QLabel#toolBadge {
    background-color: transparent; color: #A7AEB8; border: 1px solid #3A414D; border-radius: 999px;
    padding: 4px 10px; font-family: __FONT_MONO__; font-size: 11px;
}
QLabel#approvalMessage { color: #F5F7FA; font-size: 14px; }
QLabel#countdownLabel { color: #A7AEB8; font-size: 12px; font-family: __FONT_MONO__; }
QProgressBar#countdownBar { background-color: #20242B; border: none; border-radius: 3px; max-height: 5px; min-height: 5px; }
QProgressBar#countdownBar::chunk { background-color: #D97757; border-radius: 3px; }
QProgressBar#countdownBar[expired="true"]::chunk { background-color: #D85C46; }
QLabel#approvalTitle[expired="true"] { color: #F0A096; }
QLabel#approvalKicker[expired="true"] { color: #F0A096; }
QLabel#approvalDesc[expired="true"] { color: #6B7280; }
QLabel#expiredHint { color: #F0BE78; font-size: 13px; font-weight: 650; }
QPushButton#suggestionButton {
    min-height: 42px; background-color: rgba(217, 119, 87, 0.08);
    color: #E98A6B; border: 1px solid rgba(217, 119, 87, 0.45);
    border-radius: 9px; padding: 7px 14px; font-weight: 700; text-align: left;
}
QPushButton#suggestionButton:hover { background-color: rgba(217, 119, 87, 0.16); border-color: #E98A6B; }
QPushButton#confirmButton {
    min-height: 42px; background-color: #D97757; border-color: #D97757;
    color: #2A140E; font-weight: 850; padding: 8px 18px;
}
QPushButton#confirmButton:hover { background-color: #E98A6B; border-color: #E98A6B; }
QPushButton#otherToggle {
    min-height: 30px; border: 1px dashed #46505D; color: #A7AEB8;
    border-radius: 8px; padding: 4px 12px; font-size: 12px; text-align: left;
}
QPushButton#otherToggle:hover { color: #E5E9EF; border-color: #5A6472; background: transparent; }
QFrame#optionRow {
    background-color: #14171D; border: 1px solid #343B46; border-radius: 9px;
}
QFrame#optionRow:hover { border-color: #4A5462; background-color: #181C23; }
QFrame#optionRow[checked="true"] {
    border-color: #D97757; background-color: rgba(217, 119, 87, 0.14);
}
QFrame#optionRow:disabled { border-color: #232730; background-color: #101216; }
QLabel#optionRowTitle[expired="true"], QLabel#optionRowDesc[expired="true"] { color: #4A515B; }
QLabel#optionRowTitle { color: #F5F7FA; font-size: 13px; font-weight: 700; }
QLabel#optionRowDesc { color: #B4BCC7; font-size: 12px; }
QScrollArea#optionScroll, QWidget#optionContainer { background: transparent; border: none; }
QPushButton#approveDisabled {
    min-height: 42px; background-color: #1B1F26; color: #59616C;
    border: 1px solid #262C35; font-weight: 750; padding: 8px 18px;
}
QPushButton#approveDeny {
    min-height: 42px; background-color: transparent; color: #F0A096; border: 1px solid rgba(216, 92, 70, 0.65);
    font-weight: 750; padding: 8px 18px;
}
QPushButton#approveDeny:hover { background-color: rgba(216, 92, 70, 0.12); }
QPushButton#approveTerminal { border-color: transparent; color: #6B7280; text-decoration: underline; }
QPushButton#approveTerminal:hover { color: #A7AEB8; background: transparent; }
QPushButton#popupClose { background-color: transparent; border: none; color: #6B7280; font-size: 15px; padding: 2px 8px; }
QPushButton#popupClose:hover { color: #F0A096; background: transparent; }

/* ---------------- 审批统计浮层 ---------------- */
QFrame#approvalStatsPopup {
    background-color: #1B1F26;
    border: 1px solid #3A414D;
    border-radius: 10px;
}
QLabel#approvalStatsTitle {
    color: #F5F7FA;
    font-size: 14px;
    font-weight: 750;
}
QLabel#approvalStatsTotal {
    color: #E98A6B;
    font-size: 12px;
    font-family: __FONT_MONO__;
}
QScrollArea#approvalStatsScroll,
QWidget#approvalStatsContainer {
    background: transparent;
    border: none;
}
QFrame#approvalStatsRow {
    background-color: #14171D;
    border: 1px solid #2A2F38;
    border-radius: 7px;
}
QLabel#approvalStatsTool {
    color: #C7CDD6;
    font-size: 12px;
    font-family: __FONT_MONO__;
}
QLabel#approvalStatsCount {
    color: #F5F7FA;
    font-size: 12px;
    font-weight: 750;
    font-family: __FONT_MONO__;
}
QLabel#approvalStatsEmpty {
    color: #6B7280;
    font-size: 12px;
}

/* ---------------- 阶段完成提醒 ---------------- */
QWidget#stageCompletionPopupRoot { background: transparent; }
QFrame#stageCompletionCard {
    background-color: rgba(28, 25, 23, 0.98);
    border: 1px solid #3A414D;
    border-left: 3px solid #43B581;
    border-radius: 14px;
}
QLabel#stageCompletionKicker {
    color: #8FE0B6;
    font-family: __FONT_MONO__;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 2px;
}
QLabel#stageCompletionTitle {
    color: #F5F7FA;
    font-size: 20px;
    font-weight: 850;
}
QLabel#stageCompletionDesc {
    color: #A7AEB8;
    font-size: 13px;
}
QLabel#stageCompletionProject {
    color: #6B7280;
    font-size: 12px;
    font-family: __FONT_MONO__;
}

/* ---------------- 通用 ---------------- */
QMenu { background-color: #16191F; border: 1px solid #2A2F38; border-radius: 9px; padding: 4px; }
QMenu::item { padding: 6px 24px; border-radius: 5px; color: #A7AEB8; }
QMenu::item:selected { background-color: #3A414D; color: #F5F7FA; }
QMenu::separator { height: 1px; background: #2A2F38; margin: 4px 8px; }
QMessageBox QLabel { color: #F5F7FA; }
QToolTip { background-color: #1B1F26; color: #F5F7FA; border: 1px solid #3A414D; padding: 4px 8px; }
QScrollBar:vertical { background: transparent; width: 8px; margin: 2px; }
QScrollBar::handle:vertical { background: #3A332E; border-radius: 4px; min-height: 30px; }
QScrollBar::handle:vertical:hover { background: #3A414D; }
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical { background: none; }
"""
STYLE_SHEET = STYLE_SHEET.replace("__FONT_UI__", FONT_UI).replace(
    "__FONT_MONO__", FONT_MONO
)

LOG_COLORS = {
    "info": "#9CC6D8",
    "notify": "#E98A6B",
    "warn": "#F0BE78",
    "error": "#F0A096",
}

MAX_LOG_LINES = 500
