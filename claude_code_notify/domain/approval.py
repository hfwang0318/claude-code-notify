"""Approval request lifecycle and protocol description helpers."""
import json
import os
import threading
from typing import Any, Optional
from ..core import safe_string

class ApprovalRequest:
    """
    HTTP 处理线程创建后通过信号交给 GUI 线程展示，
    然后阻塞在 event 上等待用户点击按钮或超时。
    """

    def __init__(
        self,
        payload: dict[str, Any],
        timeout_seconds: int,
    ) -> None:
        self.payload = payload
        self.timeout_seconds = timeout_seconds
        self.event = threading.Event()
        self.decision: Optional[str] = None
        # 结构化回传的附加字段：suggestion → {"index": N}；
        # answer → {"answers": [...]}；其余决策为空
        self.extra: dict[str, Any] = {}
        self._finish_lock = threading.Lock()

    # ---- 便捷访问 ----

    @property
    def tool_name(self) -> str:
        return safe_string(self.payload.get("tool_name")) or "未知工具"

    @property
    def project_name(self) -> str:
        cwd = safe_string(self.payload.get("cwd"))
        if not cwd:
            return "未知项目"
        normalized = cwd.rstrip("/\\")
        return os.path.basename(normalized) or normalized

    @property
    def message(self) -> str:
        return (
            safe_string(self.payload.get("message"))
            or f"工具 {self.tool_name} 请求权限审批"
        )

    @property
    def detail(self) -> str:
        tool_input = self.payload.get("tool_input")
        if tool_input in (None, "", {}, []):
            return ""
        text = safe_string(tool_input)
        return text[:2000]

    @property
    def options(self) -> list[dict[str, str]]:
        """
        请求方提供的可选按钮：[{"id": "allow", "label": "允许"}, ...]
        未提供时使用默认的 允许 / 拒绝。
        """
        raw = self.payload.get("options")
        options: list[dict[str, str]] = []

        if isinstance(raw, list):
            for item in raw:
                if not isinstance(item, dict):
                    continue
                option_id = safe_string(item.get("id"))
                label = safe_string(item.get("label"))
                if option_id and label:
                    options.append(
                        {"id": option_id, "label": label}
                    )

        if not options:
            options = [
                {"id": "allow", "label": "允许"},
                {"id": "deny", "label": "拒绝"},
            ]

        return options[:6]  # 最多 6 个按钮，防止弹窗过宽

    @property
    def kind(self) -> str:
        """permission（权限审批）或 question（AskUserQuestion 提问）。"""
        kind = safe_string(self.payload.get("kind"))
        return kind if kind in {"permission", "question"} else "permission"

    @property
    def suggestions(self) -> list[dict[str, Any]]:
        """
        Claude 给出的 permission_suggestions（不透明转发）。
        弹窗只负责展示标签，选中后由 hook 原样 echo 回 updatedPermissions。
        按对象内容去重：Claude 偶发会在数组里放重复条目，
        不去重弹窗会出现两个一模一样的“始终允许”按钮。
        """
        raw = self.payload.get("suggestions")
        if not isinstance(raw, list):
            return []
        seen: set[str] = set()
        result: list[dict[str, Any]] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            key = json.dumps(item, sort_keys=True, ensure_ascii=False)
            if key in seen:
                continue
            seen.add(key)
            result.append(item)
        return result[:6]

    @property
    def questions(self) -> list[dict[str, Any]]:
        """AskUserQuestion 的 questions 数组（kind=question 时有值）。"""
        raw = self.payload.get("questions")
        if not isinstance(raw, list):
            return []
        return [q for q in raw if isinstance(q, dict)][:4]

    def finish(
        self,
        decision: str,
        extra: Optional[dict[str, Any]] = None,
    ) -> bool:
        """只接受第一个完成结果，避免桌面点击与终端处理互相覆盖。"""
        with self._finish_lock:
            if self.event.is_set():
                return False
            self.decision = decision
            if extra:
                self.extra = extra
            self.event.set()
            return True

    @property
    def request_id(self) -> str:
        return safe_string(self.payload.get("request_id"))


# suggestion destination / mode 的人类可读标签（best-effort；
# 不认识的值原样显示，不认识的类型用通用文案，功能不受影响）。
# 类型全集见官方文档 Permission update entries：
# addRules / replaceRules / removeRules / setMode /
# addDirectories / removeDirectories
SUGGESTION_DEST_LABELS = {
    "session": "本次会话",
    "localSettings": "本项目",
    "projectSettings": "项目共享配置",
    "userSettings": "所有项目",
}
SUGGESTION_MODE_LABELS = {
    "acceptEdits": "自动接受编辑",
    "bypassPermissions": "跳过所有权限询问",
    "plan": "切换到计划模式",
    "default": "切换回默认模式",
    "manual": "切换回默认模式",
    "auto": "自动批准低风险操作",
    "dontAsk": "不再询问",
}
SUGGESTION_BEHAVIOR_LABELS = {
    "allow": "允许",
    "deny": "拒绝",
    "ask": "询问",
}


def describe_rule_entries(rules: Any, limit: int = 3) -> str:
    """
    把 rules 数组渲染为「Bash(git status:*)、Write」式摘要。
    官方字段名为 toolName / ruleContent（ruleContent 缺省匹配整个工具）；
    同时兼容早期猜测写法 tool / rule / prompt，防协议变动。
    """
    parts: list[str] = []
    if isinstance(rules, list):
        for rule in rules[:limit]:
            if not isinstance(rule, dict):
                continue
            tool = (
                safe_string(rule.get("toolName"))
                or safe_string(rule.get("tool"))
                or "?"
            )
            pattern = (
                safe_string(rule.get("ruleContent"))
                or safe_string(rule.get("rule"))
                or safe_string(rule.get("prompt"))
            )
            parts.append(f"{tool}({pattern})" if pattern else tool)
    detail = "、".join(parts)
    if isinstance(rules, list) and len(rules) > limit:
        detail += "…"
    return detail


def describe_suggestion(suggestion: dict[str, Any]) -> str:
    """
    为 permission_suggestion 生成显示标签。
    只影响显示——选中后 echo 的是原始对象，与标签无关。
    """
    stype = safe_string(suggestion.get("type"))
    dest = SUGGESTION_DEST_LABELS.get(
        safe_string(suggestion.get("destination")),
        safe_string(suggestion.get("destination")) or "默认范围",
    )

    if stype == "setMode":
        mode = safe_string(suggestion.get("mode"))
        mode_label = SUGGESTION_MODE_LABELS.get(mode, mode or "切换模式")
        return f"{dest}内{mode_label}"

    if stype in {"addRules", "replaceRules", "removeRules"}:
        behavior = safe_string(suggestion.get("behavior")) or "allow"
        behavior_label = SUGGESTION_BEHAVIOR_LABELS.get(behavior, behavior)
        detail = describe_rule_entries(suggestion.get("rules"))
        if stype == "addRules":
            verb = {"allow": "始终允许", "deny": "始终拒绝", "ask": "始终询问"}.get(
                behavior, behavior
            )
        elif stype == "replaceRules":
            verb = f"将{behavior_label}规则替换为"
        else:
            verb = "移除匹配规则"
        return f"{verb} {detail}（{dest}）" if detail else f"{verb}（{dest}）"

    if stype in {"addDirectories", "removeDirectories"}:
        directories = suggestion.get("directories")
        dirs = (
            [safe_string(d) for d in directories if safe_string(d)][:2]
            if isinstance(directories, list)
            else []
        )
        detail = "、".join(dirs)
        if isinstance(directories, list) and len(directories) > 2:
            detail += "…"
        verb = "允许访问目录" if stype == "addDirectories" else "移除工作目录"
        if detail:
            return f"{verb} {detail}（{dest}）"
        return f"{verb}（{dest}）"

    if stype:
        return f"始终允许（{dest}，细则见终端）"
    return "始终允许（细则见终端）"


def unknown_suggestion_types(suggestions: list[dict[str, Any]]) -> list[str]:
    """返回没见过的 suggestion 类型（用于可观测性 warn 日志）。"""
    known = {
        "setMode",
        "addRules",
        "replaceRules",
        "removeRules",
        "addDirectories",
        "removeDirectories",
    }
    return sorted(
        {
            safe_string(s.get("type")) or "<missing>"
            for s in suggestions
        }
        - known
    )
