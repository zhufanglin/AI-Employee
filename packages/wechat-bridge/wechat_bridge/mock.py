"""Mock 后端：不依赖微信客户端，用内存假数据实现全部 6 个契约。

用途：没装微信的机器上端到端联调、CI 自检。
- 预置联系人：Stu / Amy / 文件传输助手
- 任意 chat_name 首次读取时都会生成 5 条预置消息（时间升序）
- send / send-file 会追加到对应会话
- 相同 (name, msg) 在 WECHAT_BRIDGE_IDEMPOTENCY_WINDOW（默认 5 秒）内重复提交
  视为幂等重试：不重复追加，返回第一次的 sent_at
"""

from __future__ import annotations

import hashlib
import threading
import time
from typing import Any

PRESET_CONTACTS: list[dict[str, Any]] = [
    {"wxid": "wxid_mock_stu", "name": "Stu", "remark": None},
    {"wxid": "wxid_mock_amy", "name": "Amy", "remark": "客户-Amy"},
    {"wxid": "wxid_mock_helper", "name": "文件传输助手", "remark": None},
]

_PRESET_TEXTS = [
    "你好，这是 Mock 预置消息 1/5，用来联调读取链路。",
    "收到，这是第 2 条（我发出的）。",
    "第 3 条：确认消息顺序按时间升序返回。",
    "第 4 条（我发出的）：发送接口落库后会追加一条。",
    "第 5 条：Mock 模式无需安装微信客户端。",
]


def _short_hash(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:8]


class MockBackend:
    """线程安全的内存后端；接口形状与真实 WxAutoBackend 完全一致。"""

    def __init__(self, idempotency_window_s: float = 5.0, max_messages: int = 200):
        self._lock = threading.RLock()
        self._messages: dict[str, list[dict[str, Any]]] = {}
        self._following: list[str] = []
        self._dedupe: dict[tuple[str, str], tuple[float, int]] = {}
        self._counter = 0
        self._idempotency_window_s = max(0.0, float(idempotency_window_s))
        self._max_messages = max(1, int(max_messages))
        self._started_at = time.time()

    # ---------- 内部 ----------
    def _seed_chat(self, chat_name: str) -> None:
        now = int(time.time())
        base = now - 300
        rows: list[dict[str, Any]] = []
        for index, text in enumerate(_PRESET_TEXTS):
            from_self = index in {1, 3}
            rows.append(
                {
                    "id": f"mock-{_short_hash(chat_name)}-seed-{index + 1}",
                    "from": "我" if from_self else chat_name,
                    "text": text,
                    "ts": base + index * 60,
                    "type": "text",
                }
            )
        self._messages[chat_name] = rows

    def _ensure_chat(self, chat_name: str) -> list[dict[str, Any]]:
        rows = self._messages.get(chat_name)
        if rows is None:
            self._seed_chat(chat_name)
            rows = self._messages[chat_name]
        return rows

    def _append(self, chat_name: str, text: str, kind: str, dedupe_key: tuple[str, str]) -> int:
        """追加一条消息；窗口内重复提交直接返回首次 sent_at。"""
        now = time.time()
        previous = self._dedupe.get(dedupe_key)
        if previous and self._idempotency_window_s > 0:
            first_at, first_sent_at = previous
            if now - first_at <= self._idempotency_window_s:
                return first_sent_at

        rows = self._ensure_chat(chat_name)
        self._counter += 1
        sent_at = int(now)
        rows.append(
            {
                "id": f"mock-{_short_hash(chat_name)}-{self._counter}",
                "from": "我",
                "text": text,
                "ts": sent_at,
                "type": kind,
            }
        )
        rows.sort(key=lambda item: item["ts"])
        self._messages[chat_name] = rows[-self._max_messages :]
        self._dedupe[dedupe_key] = (now, sent_at)
        return sent_at

    # ---------- 与真实后端一致的接口 ----------
    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "logged_in": True,
                "nickname": "微信桥接-Mock",
                "wxid": "wxid_mock_bridge",
                "wechat_version": "3.9.12.0-mock",
                "backend": "mock",
            }

    def contacts(self, limit: int, offset: int) -> tuple[list[dict[str, Any]], int]:
        with self._lock:
            items: list[dict[str, Any]] = []
            for contact in PRESET_CONTACTS:
                rows = self._ensure_chat(contact["name"])
                last_at = rows[-1]["ts"] if rows else None
                items.append(
                    {
                        "wxid": contact["wxid"],
                        "name": contact["name"],
                        "remark": contact["remark"],
                        "last_msg_at": last_at,
                    }
                )
            items.sort(key=lambda item: item["last_msg_at"] or 0, reverse=True)
            total = len(items)
            return [dict(item) for item in items[offset : offset + limit]], total

    def messages(self, chat_name: str, wx_id: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._ensure_chat(chat_name)
            return [dict(item) for item in rows[-self._max_messages :]]

    def send(self, name: str, msg: str, humanize: bool = False) -> int:
        with self._lock:
            return self._append(name, msg, "text", (name, f"text:{msg}"))

    def send_file(
        self, name: str, file_path: str | None, file_url: str | None, humanize: bool = False
    ) -> tuple[str, int]:
        with self._lock:
            file_value = file_path or file_url or ""
            sent_at = self._append(name, file_value, "file", (name, f"file:{file_value}"))
            return file_value, sent_at

    def listen_list(self, wxid: str | None, nickname: str | None) -> list[str]:
        with self._lock:
            target = self._resolve_target(wxid, nickname)
            if target and target not in self._following:
                self._following.append(target)
            return list(self._following)

    def poll(self) -> None:
        """Mock 没有外部消息源，空实现；保留统一接口。"""
        return None

    def close(self) -> None:
        return None

    def _resolve_target(self, wxid: str | None, nickname: str | None) -> str | None:
        if nickname:
            return nickname.strip() or None
        if wxid:
            for contact in PRESET_CONTACTS:
                if contact["wxid"] == wxid:
                    return contact["name"]
            return wxid
        return None
