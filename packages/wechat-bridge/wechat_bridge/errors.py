"""统一错误：{ ok: false, code, message } + HTTP 4xx/5xx。"""

from __future__ import annotations

from typing import Any, Optional


class ApiError(Exception):
    """业务错误。HTTP 状态码与错误码在构造时确定，禁止在路由里另造格式。"""

    def __init__(self, status_code: int, code: str, message: str, detail: Optional[Any] = None):
        super().__init__(message)
        self.status_code = int(status_code)
        self.code = str(code)
        self.message = str(message)
        self.detail = detail

    def payload(self) -> dict[str, Any]:
        body: dict[str, Any] = {"ok": False, "code": self.code, "message": self.message}
        if self.detail is not None:
            body["detail"] = self.detail
        return body


def bad_request(code: str, message: str) -> ApiError:
    return ApiError(400, code, message)


def not_found(code: str, message: str) -> ApiError:
    return ApiError(404, code, message)


def service_unavailable(code: str, message: str) -> ApiError:
    return ApiError(503, code, message)
