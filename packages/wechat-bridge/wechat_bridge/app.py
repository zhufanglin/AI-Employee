"""FastAPI 应用：严格实现 6 个契约接口 + /healthz。"""

from __future__ import annotations

import logging
import logging.handlers
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import APIRouter, Depends, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

from .auth import require_bearer
from .config import Settings
from .errors import ApiError
from .instance_lock import InstanceAlreadyRunning, InstanceLock
from .listener import ListenerService
from .mock import MockBackend
from .wechat_ui import WeChatUIAdapter

logger = logging.getLogger("wechat_bridge")


class SendRequest(BaseModel):
    name: str = ""
    msg: str = ""
    humanize: bool = False


class SendFileRequest(BaseModel):
    name: str = ""
    file_path: str | None = None
    file_url: str | None = None
    humanize: bool = False


class ListenRequest(BaseModel):
    wxid: str | None = None
    nickname: str | None = None


def _json_error(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"ok": False, "code": code, "message": message},
    )


def _configure_logging(settings: Settings) -> None:
    root = logging.getLogger()
    if getattr(root, "_wechat_bridge_configured", False):
        return
    root.setLevel(logging.INFO)
    formatter = logging.Formatter(
        "%(asctime)s | %(levelname)-7s | %(name)s | %(message)s", "%Y-%m-%d %H:%M:%S"
    )
    stream = logging.StreamHandler()
    stream.setFormatter(formatter)
    root.addHandler(stream)

    try:
        settings.log_dir.mkdir(parents=True, exist_ok=True)
        file_handler = logging.handlers.RotatingFileHandler(
            settings.log_dir / "bridge.log",
            maxBytes=5 * 1024 * 1024,
            backupCount=5,
            encoding="utf-8",
        )
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)
    except OSError as exc:
        logger.warning("无法创建日志目录 %s：%s", settings.log_dir, exc)

    root._wechat_bridge_configured = True  # type: ignore[attr-defined]


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings: Settings = app.state.settings
    _configure_logging(settings)
    logger.info("个人微信网桥启动参数：%s", settings.describe())
    if not settings.token:
        logger.warning(
            "WECHAT_BRIDGE_TOKEN 为空：接口不鉴权，任何人都能调用，仅限本机调试！"
        )

    lock = InstanceLock(settings.lock_file)
    try:
        lock.acquire()
    except InstanceAlreadyRunning as exc:
        logger.error("%s", exc)
        raise RuntimeError(str(exc)) from exc

    app.state.lock = lock
    backend: Any
    if settings.mock:
        backend = MockBackend(
            idempotency_window_s=settings.idempotency_window_s,
            max_messages=settings.max_messages,
        )
        logger.info("当前为 Mock 模式：不连接微信，使用内存假数据")
    else:
        backend = WeChatUIAdapter(settings)
        logger.info(
            "当前为真实模式：微信 PC 自动化后端配置为 %s（auto=优先 wxauto4[微信 4.x]，回退 wxauto[微信 3.9.x]）",
            settings.backend,
        )

    app.state.backend = backend
    app.state.started_monotonic = time.monotonic()
    listener = ListenerService(backend, settings)
    listener.start()
    app.state.listener = listener
    logger.info("网桥就绪：http://%s:%s", settings.host, settings.port)

    try:
        yield
    finally:
        logger.info("个人微信网桥正在停止……")
        listener.stop()
        try:
            backend.close()
        except Exception:  # noqa: BLE001
            logger.exception("关闭后端时异常")
        lock.release()
        logger.info("个人微信网桥已停止")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    app = FastAPI(
        title="FCMediaAgent 个人微信本地网桥",
        version="1.0.0",
        lifespan=lifespan,
    )
    app.state.settings = settings

    @app.exception_handler(ApiError)
    async def _api_error_handler(_request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content=exc.payload())

    @app.exception_handler(RequestValidationError)
    async def _validation_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
        parts: list[str] = []
        for error in exc.errors()[:3]:
            location = ".".join(
                str(part) for part in error.get("loc", []) if part not in ("body", "query", "path")
            )
            message = str(error.get("msg", "参数不合法"))
            parts.append(f"{location}: {message}" if location else message)
        return _json_error(400, "VALIDATION_ERROR", "参数校验失败：" + "；".join(parts))

    @app.exception_handler(StarletteHTTPException)
    async def _http_error_handler(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
        if exc.status_code == 404:
            return _json_error(404, "NOT_FOUND", "接口不存在")
        if exc.status_code == 405:
            return _json_error(405, "METHOD_NOT_ALLOWED", "请求方法不允许")
        return _json_error(exc.status_code, "HTTP_ERROR", str(exc.detail))

    @app.exception_handler(Exception)
    async def _unhandled_handler(_request: Request, exc: Exception) -> JSONResponse:
        logger.exception("未处理异常：%s", exc)
        return _json_error(500, "INTERNAL_ERROR", "网桥内部错误，请查看日志")

    @app.get("/healthz", include_in_schema=False)
    def healthz() -> PlainTextResponse:
        return PlainTextResponse("ok")

    router = APIRouter(prefix="/api/v1", dependencies=[Depends(require_bearer)])

    @router.get("/bot/status")
    def bot_status(request: Request) -> dict[str, Any]:
        settings = request.app.state.settings
        data = request.app.state.backend.status()
        return {
            "ok": True,
            "logged_in": bool(data.get("logged_in")),
            "nickname": data.get("nickname"),
            "wxid": data.get("wxid"),
            "wechat_version": data.get("wechat_version"),
            "mock": bool(settings.mock),
            # 真实后端名：wxauto4 / wxauto；Mock 模式为 mock。新增字段，不改动既有字段。
            "backend": data.get("backend")
            or getattr(request.app.state.backend, "backend_name", None)
            or ("mock" if settings.mock else None),
            "uptime_s": round(
                max(0.0, time.monotonic() - request.app.state.started_monotonic), 3
            ),
        }

    @router.get("/memory/list")
    def memory_list(
        request: Request,
        limit: int = Query(50, ge=1, le=500),
        offset: int = Query(0, ge=0),
    ) -> dict[str, Any]:
        items, total = request.app.state.backend.contacts(limit, offset)
        return {"ok": True, "items": items, "total": int(total)}

    @router.get("/chat/messages")
    def chat_messages(
        request: Request,
        chat_name: str | None = Query(None),
        wx_id: str | None = Query(None),
    ) -> dict[str, Any]:
        name = (chat_name or "").strip()
        if not name:
            raise ApiError(400, "CHAT_NAME_REQUIRED", "chat_name 不能为空")
        items = request.app.state.backend.messages(name, wx_id)
        return {"ok": True, "chat_name": name, "items": items}

    @router.post("/chat/send")
    def chat_send(request: Request, payload: SendRequest) -> dict[str, Any]:
        name = payload.name.strip()
        if not name:
            raise ApiError(400, "NAME_REQUIRED", "name 不能为空")
        if not payload.msg or not payload.msg.strip():
            raise ApiError(400, "MESSAGE_REQUIRED", "msg 不能为空")
        sent_at = request.app.state.backend.send(name, payload.msg, bool(payload.humanize))
        return {"ok": True, "name": name, "msg": payload.msg, "sent_at": sent_at}

    @router.post("/chat/send-file")
    def chat_send_file(request: Request, payload: SendFileRequest) -> dict[str, Any]:
        name = payload.name.strip()
        if not name:
            raise ApiError(400, "NAME_REQUIRED", "name 不能为空")
        file_path = payload.file_path.strip() if payload.file_path else None
        file_url = payload.file_url.strip() if payload.file_url else None
        if not file_path and not file_url:
            raise ApiError(400, "FILE_REQUIRED", "缺少 file_path 或 file_url")
        file_value, sent_at = request.app.state.backend.send_file(
            name, file_path, file_url, bool(payload.humanize)
        )
        return {"ok": True, "name": name, "file": file_value, "sent_at": sent_at}

    @router.post("/chat/listen-list")
    def chat_listen_list(request: Request, payload: ListenRequest) -> dict[str, Any]:
        wxid = payload.wxid.strip() if payload.wxid else None
        nickname = payload.nickname.strip() if payload.nickname else None
        if not wxid and not nickname:
            raise ApiError(400, "TARGET_REQUIRED", "wxid 或 nickname 至少填写一项")
        following = request.app.state.backend.listen_list(wxid, nickname)
        return {"ok": True, "following": list(following)}

    app.include_router(router)
    return app


app = create_app()
