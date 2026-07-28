"""Authenticated HTTP transport adapter."""
import json
import os
import select
import secrets
import socket
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional
from PySide6.QtCore import QObject, Signal, Slot
from ..config import (
    APPROVAL_PATH, APPROVAL_RESOLVED_PATH, DEDUP_SECONDS,
    DEFAULT_APPROVAL_TIMEOUT, DENIAL_PATH, HEALTH_PATH, HOST,
    MAX_APPROVAL_TIMEOUT, MAX_REQUEST_SIZE, NOTIFY_PATH, PORT,
    STAGE_STATUS_PATH,
)
from ..core import safe_string
from ..domain.approval import ApprovalRequest, unknown_suggestion_types

class HttpEventBridge(QObject):
    notification_received = Signal(str, str)
    log_received = Signal(str, str)  # level, message
    approval_received = Signal(object)  # ApprovalRequest
    approval_cancelled = Signal(object)  # ApprovalRequest（终端先作答/断连）
    denial_received = Signal(object)  # Auto mode denied / recovered
    stage_status_received = Signal(object)  # completed / resumed
    service_state_changed = Signal(bool, str)


class ClaudeNotifyServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(
        self,
        server_address: tuple[str, int],
        handler_class: type[BaseHTTPRequestHandler],
        bridge: HttpEventBridge,
        token: str,
    ) -> None:
        super().__init__(server_address, handler_class)

        self.bridge = bridge
        self.token = token

        self.last_notifications: dict[str, float] = {}
        self.notification_lock = threading.Lock()
        self.approval_lock = threading.Lock()
        self.active_approvals: dict[str, ApprovalRequest] = {}

    def update_token(self, token: str) -> None:
        self.token = token

    def register_approval(self, request: ApprovalRequest) -> None:
        if not request.request_id:
            return
        with self.approval_lock:
            self.active_approvals[request.request_id] = request

    def unregister_approval(self, request: ApprovalRequest) -> None:
        if not request.request_id:
            return
        with self.approval_lock:
            current = self.active_approvals.get(request.request_id)
            if current is request:
                self.active_approvals.pop(request.request_id, None)

    def resolve_from_terminal(self, request_id: str) -> str:
        with self.approval_lock:
            request = self.active_approvals.get(request_id)
        if request is None:
            return "not_found"
        if not request.finish("cancelled"):
            return "already_finished"
        self.bridge.approval_cancelled.emit(request)
        self.bridge.log_received.emit(
            "info",
            "终端侧已处理，弹窗同步关闭："
            f"request={request_id[:12]}, tool={request.tool_name}",
        )
        return "resolved"

    def should_notify(self, data: dict[str, Any]) -> bool:
        session_id = (
            safe_string(data.get("session_id"))
            or "unknown-session"
        )

        notification_type = (
            safe_string(data.get("notification_type"))
            or safe_string(data.get("matcher"))
            or "permission_prompt"
        )

        dedup_key = f"{session_id}:{notification_type}"
        now = time.monotonic()

        with self.notification_lock:
            previous = self.last_notifications.get(dedup_key, 0.0)

            if now - previous < DEDUP_SECONDS:
                return False

            self.last_notifications[dedup_key] = now

            expired_before = now - 3600

            expired_keys = [
                key
                for key, timestamp in self.last_notifications.items()
                if timestamp < expired_before
            ]

            for key in expired_keys:
                self.last_notifications.pop(key, None)

        return True


class ClaudeNotifyHandler(BaseHTTPRequestHandler):
    server_version = "ClaudeNotifyServer/2.2"

    @property
    def notify_server(self) -> ClaudeNotifyServer:
        return self.server  # type: ignore[return-value]

    # ------------------------------------------------------------------
    # 基础响应
    # ------------------------------------------------------------------

    def send_json(
        self,
        status_code: int,
        payload: dict[str, Any],
    ) -> None:
        body = json.dumps(
            payload,
            ensure_ascii=False,
        ).encode("utf-8")

        self.send_response(status_code)
        self.send_header(
            "Content-Type",
            "application/json; charset=utf-8",
        )
        self.send_header(
            "Content-Length",
            str(len(body)),
        )
        self.end_headers()

        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def authenticate(self) -> bool:
        authorization = self.headers.get("Authorization", "")
        expected = f"Bearer {self.notify_server.token}"

        if secrets.compare_digest(authorization, expected):
            return True

        self.notify_server.bridge.log_received.emit(
            "warn",
            "认证失败："
            f"remote={self.client_address[0]}, "
            f"received_length={len(authorization)}, "
            f"expected_length={len(expected)}",
        )

        self.send_json(401, {"error": "unauthorized"})
        return False

    def client_gone(self) -> bool:
        """
        非阻塞探测客户端连接是否已断开，作为 transcript 同步之外的
        异常退出补充路径。
        """
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
        except (OSError, ValueError):
            return True
        if not readable:
            return False  # 无数据可读：连接空闲但存活
        try:
            peeked = self.connection.recv(1, socket.MSG_PEEK)
        except BlockingIOError:
            return False  # 竞态：select 与 recv 之间状态变化
        except OSError:
            return True  # ConnectionResetError 等：对端已重置
        # 读到数据属异常（钩子不会二次发送），视为存活、不消费
        return peeked == b""

    def read_json_body(self) -> Optional[dict[str, Any]]:
        """解析请求体。出错时已发送错误响应，返回 None。"""
        content_length_text = self.headers.get("Content-Length")

        if content_length_text is None:
            self.send_json(411, {"error": "content_length_required"})
            return None

        try:
            content_length = int(content_length_text)
        except ValueError:
            self.send_json(400, {"error": "invalid_content_length"})
            return None

        if content_length <= 0:
            self.send_json(400, {"error": "empty_request_body"})
            return None

        if content_length > MAX_REQUEST_SIZE:
            self.send_json(413, {"error": "request_too_large"})
            return None

        try:
            raw_body = self.rfile.read(content_length)
            data = json.loads(raw_body.decode("utf-8"))
        except UnicodeDecodeError:
            self.send_json(400, {"error": "body_must_be_utf8"})
            return None
        except json.JSONDecodeError as exc:
            self.send_json(
                400,
                {"error": "invalid_json", "detail": str(exc)},
            )
            return None

        if not isinstance(data, dict):
            self.send_json(400, {"error": "json_root_must_be_object"})
            return None

        return data

    # ------------------------------------------------------------------
    # 路由
    # ------------------------------------------------------------------

    def do_GET(self) -> None:
        if self.path == HEALTH_PATH:
            self.send_json(
                200,
                {
                    "status": "ok",
                    "service": "claude-notify",
                    "port": PORT,
                },
            )
            return

        self.send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:
        if self.path == NOTIFY_PATH:
            if not self.authenticate():
                return
            data = self.read_json_body()
            if data is not None:
                self.handle_notification(data)
            return

        if self.path == APPROVAL_PATH:
            if not self.authenticate():
                return
            data = self.read_json_body()
            if data is not None:
                self.handle_approval(data)
            return

        if self.path == APPROVAL_RESOLVED_PATH:
            if not self.authenticate():
                return
            data = self.read_json_body()
            if data is not None:
                self.handle_approval_resolved(data)
            return

        if self.path == DENIAL_PATH:
            if not self.authenticate():
                return
            data = self.read_json_body()
            if data is not None:
                self.handle_denial(data)
            return

        if self.path == STAGE_STATUS_PATH:
            if not self.authenticate():
                return
            data = self.read_json_body()
            if data is not None:
                self.handle_stage_status(data)
            return

        self.send_json(404, {"error": "not_found"})

    # ------------------------------------------------------------------
    # 单向通知（保持原行为）
    # ------------------------------------------------------------------

    def handle_notification(self, data: dict[str, Any]) -> None:
        notification_type = (
            safe_string(data.get("notification_type"))
            or safe_string(data.get("matcher"))
            or "unknown"
        )

        session_id = (
            safe_string(data.get("session_id"))
            or "unknown"
        )

        self.notify_server.bridge.log_received.emit(
            "info",
            "收到通知："
            f"remote={self.client_address[0]}, "
            f"type={notification_type}, "
            f"session={session_id[:16]}",
        )

        if self.notify_server.should_notify(data):
            title, message = self.build_notification(data)

            self.notify_server.bridge.notification_received.emit(
                title,
                message,
            )
        else:
            self.notify_server.bridge.log_received.emit(
                "info",
                "忽略短时间内重复通知",
            )

        self.send_json(200, {"status": "ok"})

    def build_notification(
        self,
        data: dict[str, Any],
    ) -> tuple[str, str]:
        cwd = safe_string(data.get("cwd"))
        session_id = safe_string(data.get("session_id"))
        message = safe_string(data.get("message"))
        notification_type = safe_string(
            data.get("notification_type")
        )

        if cwd:
            normalized_cwd = cwd.rstrip("/\\")
            project_name = (
                os.path.basename(normalized_cwd)
                or normalized_cwd
            )
        else:
            project_name = "未知项目"

        title = f"Claude Code 等待权限审批 · {project_name}"

        body_parts: list[str] = []

        if message:
            body_parts.append(message)
        else:
            body_parts.append(
                "Claude Code 正在等待权限审批。"
            )

        if cwd:
            body_parts.append(f"目录：{cwd}")

        if notification_type:
            body_parts.append(f"类型：{notification_type}")

        if session_id:
            body_parts.append(
                f"会话：{session_id[:16]}"
            )

        return title, "\n".join(body_parts)

    # ------------------------------------------------------------------
    # Auto mode 拒绝事件（即时通知与会话统计）
    # ------------------------------------------------------------------

    def handle_denial(self, data: dict[str, Any]) -> None:
        status = safe_string(data.get("status"))
        session_id = safe_string(data.get("session_id"))
        fingerprint = safe_string(data.get("fingerprint"))
        if status not in {"denied", "recovered"}:
            self.send_json(400, {"error": "invalid_denial_status"})
            return
        if not session_id:
            self.send_json(400, {"error": "session_id_required"})
            return
        if not fingerprint:
            self.send_json(400, {"error": "fingerprint_required"})
            return

        payload = dict(data)
        payload["status"] = status
        payload["session_id"] = session_id
        payload["fingerprint"] = fingerprint
        self.notify_server.bridge.denial_received.emit(payload)
        self.notify_server.bridge.log_received.emit(
            "warn" if status == "denied" else "info",
            "Auto mode 拒绝状态："
            f"status={status}, "
            f"tool={safe_string(data.get('tool_name')) or 'unknown'}, "
            f"count={data.get('count', 0)}, "
            f"session={session_id[:16]}",
        )
        self.send_json(200, {"status": "ok"})

    # ------------------------------------------------------------------
    # 阶段完成提醒（始终由独立置顶弹窗展示）
    # ------------------------------------------------------------------

    def handle_stage_status(self, data: dict[str, Any]) -> None:
        status = safe_string(data.get("status"))
        session_id = safe_string(data.get("session_id"))
        if status not in {"completed", "resumed"}:
            self.send_json(400, {"error": "invalid_stage_status"})
            return
        if not session_id:
            self.send_json(400, {"error": "session_id_required"})
            return

        payload = dict(data)
        payload["status"] = status
        payload["session_id"] = session_id
        self.notify_server.bridge.stage_status_received.emit(payload)
        self.notify_server.bridge.log_received.emit(
            "notify" if status == "completed" else "info",
            "阶段状态："
            f"status={status}, session={session_id[:16]}, "
            f"remote={self.client_address[0]}",
        )
        self.send_json(200, {"status": "ok"})

    # ------------------------------------------------------------------
    # 双向审批（长轮询：挂起请求直到用户点击或超时）
    # ------------------------------------------------------------------

    def handle_approval_resolved(self, data: dict[str, Any]) -> None:
        request_id = safe_string(data.get("request_id"))
        if not request_id:
            self.send_json(400, {"error": "request_id_required"})
            return
        status = self.notify_server.resolve_from_terminal(request_id)
        if status == "not_found":
            self.send_json(404, {"status": status})
            return
        self.send_json(200, {"status": status})

    def handle_approval(self, data: dict[str, Any]) -> None:
        remote = self.client_address[0]

        raw_timeout = data.get("timeout_seconds")
        try:
            timeout_seconds = int(raw_timeout)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            timeout_seconds = DEFAULT_APPROVAL_TIMEOUT
        timeout_seconds = max(
            5,
            min(timeout_seconds, MAX_APPROVAL_TIMEOUT),
        )

        request = ApprovalRequest(data, timeout_seconds)

        self.notify_server.bridge.log_received.emit(
            "notify",
            "收到审批请求："
            f"remote={remote}, tool={request.tool_name}, "
            f"kind={request.kind}, "
            f"project={request.project_name}, "
            f"suggestions={len(request.suggestions)}, "
            f"timeout={timeout_seconds}s",
        )

        # 可观测性：没见过的 suggestion 类型照渲染照 echo，
        # 但打 warn 让新版本协议变化第一时间可见
        unknown = unknown_suggestion_types(request.suggestions)
        if unknown:
            self.notify_server.bridge.log_received.emit(
                "warn",
                f"未知 suggestion 类型 {unknown}，将用通用标签显示并原样回传",
            )

        # 交给 GUI 线程弹窗，本线程挂起等待。终端先作答时，hook 会从
        # transcript 观察到对应 tool_result 并调用 resolved 端点；
        # 连接断开检测仅作为进程异常退出时的补充快速路径。
        self.notify_server.register_approval(request)
        self.notify_server.bridge.approval_received.emit(request)

        deadline = time.monotonic() + timeout_seconds + 5
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                if request.event.wait(min(0.5, remaining)):
                    break
                if self.client_gone():
                    if request.finish("cancelled"):
                        self.notify_server.bridge.approval_cancelled.emit(
                            request
                        )
                        self.notify_server.bridge.log_received.emit(
                            "info",
                            "审批客户端已断开，弹窗同步关闭："
                            f"request={request.request_id[:12]}, "
                            f"tool={request.tool_name}",
                        )
                    break
        finally:
            self.notify_server.unregister_approval(request)

        # finish() 总是先写 decision 再置 event，直接读 decision 即可
        decision = request.decision or "timeout"

        self.notify_server.bridge.log_received.emit(
            "notify" if decision in ("allow", "deny") else "warn",
            f"审批结果：tool={request.tool_name}, "
            f"decision={decision}",
        )

        response: dict[str, Any] = {
            "status": "ok",
            "decision": decision,
        }
        # suggestion → {"index": N}；answer → {"answers": [...]}
        response.update(request.extra)
        try:
            self.send_json(200, response)
        except OSError:
            pass  # 客户端（钩子进程）已被回收，响应无处投递属正常

    def log_message(
        self,
        format_string: str,
        *args: Any,
    ) -> None:
        self.notify_server.bridge.log_received.emit(
            "info",
            f"HTTP {self.client_address[0]} "
            f"{format_string % args}",
        )


# ============================================================================
# HTTP 线程
# ============================================================================

class ServerWorker(QObject):
    started = Signal()
    stopped = Signal()
    failed = Signal(str)

    def __init__(
        self,
        bridge: HttpEventBridge,
        token: str,
    ) -> None:
        super().__init__()

        self.bridge = bridge
        self.token = token
        self.server: Optional[ClaudeNotifyServer] = None

    @Slot()
    def run(self) -> None:
        try:
            self.server = ClaudeNotifyServer(
                (HOST, PORT),
                ClaudeNotifyHandler,
                self.bridge,
                self.token,
            )

            self.started.emit()
            self.server.serve_forever()

        except Exception:
            self.failed.emit(traceback.format_exc())

        finally:
            if self.server is not None:
                self.server.server_close()

            self.stopped.emit()

    @Slot()
    def stop(self) -> None:
        if self.server is not None:
            self.server.shutdown()

    def update_token(self, token: str) -> None:
        self.token = token

        if self.server is not None:
            self.server.update_token(token)
