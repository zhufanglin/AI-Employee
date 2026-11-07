"""Bearer Token 鉴权。

WECHAT_BRIDGE_TOKEN 为空时：启动阶段打印警告并放行（只用于本机调试）。
非空时：Authorization 必须严格等于 "Bearer <token>"，否则 401。
"""

from __future__ import annotations

import hmac

from fastapi import Request

from .errors import ApiError


async def require_bearer(request: Request) -> None:
    settings = request.app.state.settings
    expected = settings.token
    if not expected:
        return

    header = request.headers.get("authorization", "")
    scheme, _, value = header.partition(" ")
    supplied = value.strip()
    if scheme.lower() != "bearer" or not supplied:
        raise ApiError(401, "UNAUTHORIZED", "缺少 Bearer Token")
    if not hmac.compare_digest(supplied, expected):
        raise ApiError(401, "UNAUTHORIZED", "Bearer Token 无效")
