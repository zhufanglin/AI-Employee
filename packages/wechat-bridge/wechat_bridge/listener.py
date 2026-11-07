"""独立监听/轮询线程。

HTTP 服务不负责轮询微信消息：后台线程按 WECHAT_BRIDGE_LISTEN_POLL 周期调用
后端 poll()，Mock 后端为空实现，真实后端读取 wxauto 的监听队列并写入缓存。
"""

from __future__ import annotations

import logging
import threading

from .errors import ApiError

logger = logging.getLogger(__name__)


class ListenerService:
    def __init__(self, backend, settings):
        self._backend = backend
        self._interval = max(0.5, float(settings.listen_poll_s))
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._loop, name="wechat-listen", daemon=True)
        self._thread.start()
        logger.info("监听线程已启动，轮询间隔 %.1fs", self._interval)

    def _loop(self) -> None:
        while not self._stop_event.wait(self._interval):
            try:
                self._backend.poll()
            except ApiError as exc:
                logger.warning("监听轮询返回错误：%s", exc.message)
            except Exception:  # noqa: BLE001
                logger.exception("监听轮询异常")
        logger.info("监听线程已退出")

    def stop(self) -> None:
        self._stop_event.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=5)
        logger.info("监听线程停止完成")
