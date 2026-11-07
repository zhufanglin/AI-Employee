"""真实模式：微信 PC 客户端多后端驱动（wechatauto / wxauto4 / wxauto）。

后端选择（WECHAT_BRIDGE_BACKEND=auto|wechatauto|wxauto4|wxauto，默认 auto）：
- wechatauto：wechatauto-replica，GUI 自动化 + 屏幕 OCR（不依赖 UIA 主窗口结构），
  **兼容微信 4.1.15**，需要 Python 3.12 —— 2026-11 实测唯一能驱动 4.1.15.56 的免费后端；
- wxauto4：纯 UIA，微信 4.x **≤4.1.8.107**（4.1.15 起主窗口 UIA 树为空，会报
  「未找到已登录的客户端主窗口」），**只支持 Python 3.12（<3.14）**，发行包是编译版 .pyd；
- wxauto：微信 3.9.x（旧库，仅作回退保留；微信 3.9.x 已无法登录）。

设计要点：
1. 所有 UI 操作串行化：threading.Lock + 可配置超时（WECHAT_BRIDGE_UI_TIMEOUT）；
2. 失败重试 WECHAT_BRIDGE_UI_RETRY 次（默认 2，即最多 3 次），仍失败返回 503
   {code:"WECHAT_UI_BUSY"}；
3. humanize=true：每次发送前随机停顿 0.3–1.2 秒；长文本按标点分段发送；
4. 监听：wxauto4 是回调式（AddListenChat(nickname, callback)，回调可能在线程池里
   执行），回调只负责把消息塞进内存队列（加锁），poll() 由监听线程 drain 进缓存；
   wxauto 旧库走 GetListenMessage 轮询。
5. 微信未登录 → 503 WECHAT_NOT_LOGGED_IN；没装后端 → 503 *_MISSING。
"""

from __future__ import annotations

import hashlib
import inspect
import logging
import os
import random
import shutil
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

from .config import Settings
from .errors import ApiError
from .humanize import random_pause, split_text

logger = logging.getLogger(__name__)

_MAX_SEGMENT_CHARS = 120
_DOWNLOAD_TIMEOUT_S = 30
# 自动探测顺序：wechatauto（wechatauto-replica，GUI+OCR，兼容微信 4.1.x）
# 优先，其次 wxauto4（纯 UIA，微信 4.x ≤4.1.8.107），最后旧 wxauto（微信 3.9.x）。
_BACKEND_CHOICES = ("wechatauto", "wxauto4", "wxauto")
_NOT_LOGGED_IN_MARKERS = (
    "未找到已登录的客户端主窗口",
    "未找到已登录",
    "未找到微信窗口",
    "未登录",
    "请先登录",
)
_NOT_LOGGED_IN_HINT = "微信未登录或主窗口被关闭，请用专用小号登录微信 4.x 并保持主窗口打开"
_NICKNAME_KEYS = ("nickname", "nick_name", "nickName", "name", "昵称", "微信昵称")
_WXID_KEYS = ("wxid", "wx_id", "wxId", "Wxid", "微信号", "alias", "account", "account_id")
# 非文本消息的展示占位符：wechatauto/wxauto4 的 content 常常是原始 XML，
# 直接回给上层会把一大段 <img aeskey=...> 当正文塞进模型上下文，必须归一。
_KIND_PLACEHOLDERS = (
    (("image", "img", "picture", "photo", "图片"), "[图片]"),
    (("file", "document", "附件", "文件"), "[文件]"),
    (("video", "shortvideo", "视频"), "[视频]"),
    (("voice", "audio", "sound", "语音"), "[语音]"),
    (("emoji", "sticker", "gif", "表情"), "[表情]"),
    (("location", "位置"), "[位置]"),
    (("link", "url", "链接"), "[链接]"),
    (("card", "contact_card", "名片"), "[名片]"),
    (("mini", "miniprogram", "app", "小程序"), "[小程序]"),
    (("redpacket", "red_packet", "transfer", "红包/转账"), "[红包/转账]"),
)


def _looks_like_xml(text: str) -> bool:
    head = text.lstrip()[:64].lower()
    return head.startswith("<?xml") or head.startswith("<msg") or head.startswith("<msgsys")


def _placeholder_for(kind: str, content: Any) -> str | None:
    """非文本消息返回占位符；文本消息返回 None（调用方保留原文）。"""
    text = "" if content is None else str(content)
    lowered = (kind or "").strip().lower()
    if lowered in {"text", "self", "me", "我", "friend_self", ""}:
        return "[非文本消息]" if _looks_like_xml(text) else None
    for keys, placeholder in _KIND_PLACEHOLDERS:
        if any(key in lowered for key in keys):
            return placeholder
    if _looks_like_xml(text):
        return "[非文本消息]"
    return None


def _attr(obj: Any, *names: str) -> Any:
    """兼容 wxauto / wxauto4 不同版本：对象既可能是属性对象，也可能是 dict。"""
    for name in names:
        try:
            value = obj.get(name) if isinstance(obj, dict) else getattr(obj, name)
        except Exception:
            continue
        if value:
            return value
    return None


def _lookup_mapping(info: dict, keys: tuple[str, ...]) -> Any:
    """从 GetMyInfo() 返回的 dict 里按候选键（大小写不敏感）取值。"""
    for key in keys:
        value = info.get(key)
        if value:
            return value
    lowered = {str(key).strip().lower(): value for key, value in info.items()}
    for key in keys:
        value = lowered.get(key.lower())
        if value:
            return value
    return None


def _response_ok(response: Any) -> bool:
    """wxauto4 的 WxResponse 是 dict 子类（有 is_success / status='成功'）。"""
    if response is None:
        # 旧版 wxauto 的 SendMsg/SendFiles 无返回值，按成功处理。
        return True
    is_success = getattr(response, "is_success", None)
    if isinstance(is_success, bool):
        return is_success
    if isinstance(response, dict):
        if "status" in response:
            return str(response.get("status")) == "成功"
        return bool(response)
    return bool(response)


def _response_text(response: Any) -> str:
    if isinstance(response, dict):
        for key in ("message", "msg", "status", "code"):
            value = response.get(key)
            if value:
                return str(value)
        return str(dict(response))
    return str(response) if response is not None else ""


def _supports_kwarg(fn: Callable[..., Any], name: str) -> bool:
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False
    if name in params:
        return True
    return any(param.kind == inspect.Parameter.VAR_KEYWORD for param in params.values())


def _call_with_optional_who(fn: Callable[..., Any], value: Any, who: str | None) -> Any:
    """兼容 SendMsg(value, who=...)、SendFiles(path, who=...) 等不同签名。"""
    if _supports_kwarg(fn, "who"):
        try:
            return fn(value, who=who)
        except TypeError:
            pass
    return fn(value)


class WeChatUIAdapter:
    def __init__(
        self,
        settings: Settings,
        backend: str | None = None,
        client_factory: Callable[[], Any] | None = None,
    ):
        self.settings = settings
        self._ui_lock = threading.Lock()
        self._cache_lock = threading.RLock()
        self._wx: Any = None
        self._following: list[str] = []
        self._cache: dict[str, list[dict[str, Any]]] = {}
        self._rng = random.Random()
        self._version: str | None = None
        self._version_checked = False
        # 后端探测结果 / 显式覆盖（backend 参数或 env 配置）
        self._backend_name: str | None = None
        self._backend_override = (str(backend).strip().lower() if backend else "") or None
        # 测试注入：selftest 用假 WeChat 对象验证五条链路，不需要真微信。
        self._client_factory = client_factory
        # wxauto4 回调式监听：回调在内部线程池执行，加锁塞队列，poll() 再 drain。
        self._pending_lock = threading.Lock()
        self._pending: list[tuple[str, dict[str, Any]]] = []

    # ---------- 后端选择 ----------
    @property
    def backend_name(self) -> str:
        """当前（或期望）使用的真实后端名，供 /bot/status 的 backend 字段使用。"""
        if self._backend_name:
            return self._backend_name
        preferred = self._preferred_backend()
        return preferred if preferred in _BACKEND_CHOICES else "auto"

    def _preferred_backend(self) -> str:
        raw = self._backend_override or getattr(self.settings, "backend", "auto") or "auto"
        return str(raw).strip().lower() or "auto"

    @staticmethod
    def _import_backend(name: str) -> Any:
        if name == "wechatauto":
            try:
                from wechatauto import WeChat  # type: ignore
            except Exception as exc:  # noqa: BLE001
                raise ApiError(
                    503,
                    "WECHAT_WECHATAUTO_MISSING",
                    "未安装或无法加载 wechatauto-replica（微信 4.1.x 真实模式依赖，需要 Python 3.12）："
                    f"{exc}",
                ) from exc
            return WeChat
        if name == "wxauto4":
            try:
                from wxauto4 import WeChat  # type: ignore
            except Exception as exc:  # noqa: BLE001
                raise ApiError(
                    503,
                    "WECHAT_WXAUTO4_MISSING",
                    "未安装或无法加载 wxauto4（微信 4.x 真实模式依赖，需要 Python 3.12 <3.14）："
                    f"{exc}",
                ) from exc
            return WeChat
        if name == "wxauto":
            try:
                from wxauto import WeChat  # type: ignore
            except Exception as exc:  # noqa: BLE001
                raise ApiError(
                    503,
                    "WECHAT_WXAUTO_MISSING",
                    f"未安装 wxauto（微信 3.9.x 真实模式依赖）：{exc}",
                ) from exc
            return WeChat
        raise ApiError(500, "INTERNAL_ERROR", f"未知微信后端：{name}")

    def _select_backend(self) -> str:
        if self._backend_name:
            return self._backend_name
        preferred = self._preferred_backend()
        if preferred in _BACKEND_CHOICES:
            self._backend_name = preferred
            logger.info("wechat-bridge 使用真实后端（配置指定）：%s", preferred)
            return preferred
        if self._client_factory is not None:
            # 测试注入的假客户端默认按 wxauto4 语义走。
            self._backend_name = "wxauto4"
            return "wxauto4"

        errors: list[str] = []
        for name in _BACKEND_CHOICES:
            try:
                self._import_backend(name)
            except ApiError as exc:
                errors.append(exc.message)
                continue
            self._backend_name = name
            logger.info("wechat-bridge 自动探测到真实后端：%s", name)
            return name
        raise ApiError(
            503,
            "WECHAT_BRIDGE_NO_BACKEND",
            "未安装可用的微信自动化后端：需要 wxauto4（微信 4.x，要求 Python 3.12）"
            "或 wxauto（微信 3.9.x）。详情：" + "；".join(errors),
        )

    def _client_alive(self) -> bool | None:
        """微信 PC 客户端进程是否还在跑。

        只为了区分「缓存里那个已登录客户端」和「微信已经被关掉/升级后自己退出」：
        返回 None 表示无法判断（没有 psutil），调用方应保持原行为。
        """
        try:
            import psutil  # 随 wxauto4 / wechatauto-replica 一起装好
        except Exception:  # noqa: BLE001
            return None
        try:
            for proc in psutil.process_iter(["name"]):
                name = (proc.info.get("name") or "").lower()
                if name in ("weixin.exe", "wechat.exe"):
                    return True
        except Exception:  # noqa: BLE001
            return None
        return False

    def _restore_window(self) -> None:
        """把微信主窗口从最小化恢复出来。

        wechatauto-replica 走 GUI 截图 + OCR，窗口最小化时截图尺寸为 0，
        表现为「height and width must be > 0」这种看不懂的报错，所以每次 UI 操作前先恢复。
        """
        try:
            import win32gui
        except Exception:  # noqa: BLE001
            return
        targets: list[int] = []

        def collect(hwnd: int, _acc: Any) -> None:  # noqa: ANN001
            try:
                if win32gui.IsIconic(hwnd):
                    targets.append(hwnd)
            except Exception:  # noqa: BLE001
                pass

        try:
            win32gui.EnumWindows(collect, None)
            for hwnd in targets:
                title = win32gui.GetWindowText(hwnd) or ""
                cls = win32gui.GetClassName(hwnd) or ""
                if title in ("微信", "WeChat") or "WeChatMainWnd" in cls:
                    win32gui.ShowWindow(hwnd, 9)  # SW_RESTORE
                    logger.info("微信主窗口已最小化，已自动恢复：hwnd=%s", hwnd)
        except Exception as exc:  # noqa: BLE001
            logger.debug("恢复微信窗口失败（忽略）：%s", exc)

    def _connect_error(self, name: str, exc: BaseException) -> ApiError:
        text = str(exc) or exc.__class__.__name__
        if any(marker in text for marker in _NOT_LOGGED_IN_MARKERS):
            return ApiError(
                503,
                "WECHAT_NOT_LOGGED_IN",
                f"{_NOT_LOGGED_IN_HINT}（后端 {name}，原始错误：{text}）",
            )
        return ApiError(
            503,
            "WECHAT_NOT_READY",
            f"无法连接微信 PC 客户端（后端 {name}，请确认已登录且主窗口未最小化）：{text}",
        )

    def _ensure_client(self) -> Any:
        if self._wx is not None:
            # 微信被关掉/自动升级后自己退出时，缓存的客户端仍能返回旧昵称，
            # 会让 /bot/status 假装「已登录」，直到真正发消息才炸。这里先确认进程还在。
            if self._client_alive() is False:
                logger.warning("微信 PC 客户端进程已不存在，丢弃缓存的客户端")
                self._wx = None
            else:
                return self._wx
        name = self._select_backend()
        if self._client_factory is not None:
            try:
                client = self._client_factory()
            except Exception as exc:  # noqa: BLE001
                raise self._connect_error(name, exc) from exc
            if client is None:
                raise ApiError(503, "WECHAT_NOT_READY", "测试注入的微信客户端为空")
            self._wx = client
            return client
        wechat_cls = self._import_backend(name)
        try:
            if name == "wxauto4":
                # ads=False 关掉免费版横幅，避免污染网桥日志；旧版无该参数时回退默认构造。
                try:
                    client = wechat_cls(ads=False)
                except TypeError:
                    client = wechat_cls()
            elif name == "wechatauto":
                # wechatauto-replica 走 GUI + OCR（不依赖 UIA 主窗口结构），
                # AddListenChat 注册的回调由库内部监听器派发，构造时即启动。
                # 该库解析消息时递归较深，默认 1000 会 RecursionError。
                if sys.getrecursionlimit() < 12000:
                    sys.setrecursionlimit(12000)
                try:
                    client = wechat_cls(start_listener=True)
                except TypeError:
                    client = wechat_cls()
            else:
                client = wechat_cls()
        except Exception as exc:  # noqa: BLE001
            raise self._connect_error(name, exc) from exc
        self._wx = client
        return client

    def _execute(self, label: str, operation: Callable[[], Any], retry: bool = True) -> Any:
        """加锁 + 超时 + 重试。任何 UI 异常最终都收敛成 503 WECHAT_UI_BUSY。

        retry=False 用于「发送」这类非幂等操作：点击可能已经生效，只是读回执失败，
        重试就会把同一条消息发两遍（生产上真的出现过重复的 1500 字长文）。
        """
        attempts = (1 + max(0, int(self.settings.ui_retry))) if retry else 1
        last_error: BaseException | None = None
        # GUI 后端截图对最小化窗口会报「height and width must be > 0」，先尽量恢复窗口。
        self._restore_window()
        for attempt in range(1, attempts + 1):
            acquired = self._ui_lock.acquire(timeout=self.settings.ui_timeout_s)
            if not acquired:
                last_error = TimeoutError(
                    f"{label} 等待 UI 互斥锁超过 {self.settings.ui_timeout_s:.1f}s"
                )
                logger.warning("UI 操作等待锁超时：%s（第 %d/%d 次）", label, attempt, attempts)
            else:
                try:
                    return operation()
                except ApiError:
                    # 参数错误 / 未安装 / 未登录等立即上抛，不做无意义重试。
                    raise
                except Exception as exc:  # noqa: BLE001
                    last_error = exc
                    logger.warning(
                        "UI 操作失败：%s（第 %d/%d 次）：%s", label, attempt, attempts, exc
                    )
                finally:
                    self._ui_lock.release()
            if attempt < attempts:
                time.sleep(0.2 * attempt)

        raise ApiError(
            503,
            "WECHAT_UI_BUSY",
            f"{label} 连续失败 {attempts} 次，最后一次错误：{last_error}",
        )

    # ---------- 状态 ----------
    def status(self) -> dict[str, Any]:
        """状态查询也走 UI 互斥锁 + 超时，但不因微信未启动而让 HTTP 失败。"""
        try:
            return self._execute("读取微信状态", self._status_operation)
        except ApiError as exc:
            # 微信未登录 / 未安装 / UI 正忙：状态接口仍返回 200，只标记未登录，
            # 避免上游把「暂时读不到状态」误判成网桥整体不可用。
            logger.warning("读取微信状态失败（降级为未登录）：%s", exc.message)
            return {
                "logged_in": False,
                "nickname": None,
                "wxid": None,
                "wechat_version": self._detect_version(),
                "backend": self.backend_name,
            }

    def _status_operation(self) -> dict[str, Any]:
        name = self._select_backend()
        wx = self._ensure_client()
        if name == "wechatauto":
            return self._status_wechatauto(wx)
        if name == "wxauto4":
            return self._status_wxauto4(wx)
        return self._status_wxauto_legacy(wx)

    def _status_wxauto4(self, wx: Any) -> dict[str, Any]:
        nickname = _attr(wx, "nickname", "nickName", "NickName")
        info: Any = _attr(wx, "myinfo")
        if not isinstance(info, dict):
            fn = getattr(wx, "GetMyInfo", None)
            if callable(fn):
                try:
                    info = fn()
                except Exception as exc:  # noqa: BLE001
                    logger.debug("wxauto4 GetMyInfo() 失败：%s", exc)
                    info = None
        wxid = None
        if isinstance(info, dict):
            nickname = nickname or _lookup_mapping(info, _NICKNAME_KEYS)
            wxid = _lookup_mapping(info, _WXID_KEYS)
        wxid = wxid or _attr(wx, "wxid", "wxId", "Wxid")

        online: bool | None = None
        is_online = getattr(wx, "IsOnline", None)
        if callable(is_online):
            try:
                online = bool(is_online())
            except Exception as exc:  # noqa: BLE001
                logger.debug("wxauto4 IsOnline() 失败：%s", exc)
                online = None
        if online is None:
            # 41.1.x 有 IsOnline()；更早的 40.x 没有，退化成 bool(nickname)。
            online = bool(nickname)

        return {
            "logged_in": bool(online),
            "nickname": str(nickname) if nickname else None,
            "wxid": str(wxid) if wxid else None,
            "wechat_version": self._detect_version(),
            "backend": "wxauto4",
        }

    def _status_wechatauto(self, wx: Any) -> dict[str, Any]:
        """wechatauto-replica：WeChat().nickname 即当前登录昵称（未登录为 None）。"""
        nickname = _attr(wx, "nickname", "nickName", "NickName")
        wxid = _attr(wx, "wxid", "wxId", "Wxid")
        # nickname 在实例上，wxid 通常只在 GetMyInfo() 里，两者都要试。
        fn = getattr(wx, "GetMyInfo", None)
        if callable(fn) and (not nickname or not wxid):
            try:
                info = fn()
            except Exception as exc:  # noqa: BLE001
                logger.debug("wechatauto GetMyInfo() 失败：%s", exc)
                info = None
            if isinstance(info, dict):
                nickname = nickname or _lookup_mapping(info, _NICKNAME_KEYS)
                wxid = wxid or _lookup_mapping(info, _WXID_KEYS)
        return {
            "logged_in": bool(nickname),
            "nickname": str(nickname) if nickname else None,
            "wxid": str(wxid) if wxid else None,
            "wechat_version": self._detect_version(),
            "backend": "wechatauto",
        }

    def _status_wxauto_legacy(self, wx: Any) -> dict[str, Any]:
        nickname = None
        wxid = None
        nickname = _attr(wx, "nickname", "nickName", "NickName")
        info = None
        for method in ("GetMyInfo", "GetSelfInfo", "GetMyInfoDict"):
            fn = getattr(wx, method, None)
            if callable(fn):
                try:
                    info = fn()
                    break
                except Exception:  # noqa: BLE001
                    info = None
        if isinstance(info, dict):
            nickname = nickname or _attr(info, "nickname", "name", "NickName", "nick_name")
            wxid = wxid or _attr(info, "wxid", "wxId", "Wxid", "wx_id")
        wxid = wxid or _attr(wx, "wxid", "wxId", "Wxid")
        return {
            "logged_in": bool(nickname),
            "nickname": str(nickname) if nickname else None,
            "wxid": str(wxid) if wxid else None,
            "wechat_version": self._detect_version(),
            "backend": "wxauto",
        }

    def _detect_version(self) -> str | None:
        if self._version_checked:
            return self._version
        self._version_checked = True
        self._version = _detect_wechat_version()
        return self._version

    # ---------- 会话 / 联系人 ----------
    def _session_names(self, wx: Any) -> list[str]:
        raw = None
        # wxauto4：GetSession() -> list[SessionElement]（element.name 为会话名，
        # 40.x 里 name 是 content 的首行）；旧 wxauto：GetSessionList/GetSessionListName。
        for method in ("GetSession", "GetSessionList", "GetSessionListName"):
            fn = getattr(wx, method, None)
            if callable(fn):
                try:
                    raw = fn()
                    break
                except Exception as exc:  # noqa: BLE001
                    logger.debug("调用 %s 失败：%s", method, exc)
        if raw is None:
            raise RuntimeError("当前微信后端不支持 GetSession()/GetSessionList()")
        names: list[str] = []
        for item in raw or []:
            if isinstance(item, str):
                name: Any = item
            else:
                name = _attr(
                    item, "name", "nickname", "NickName", "title", "content", "who"
                )
            if name:
                text = str(name).strip()
                if text and text not in names:
                    names.append(text)
        return names

    def contacts(self, limit: int, offset: int) -> tuple[list[dict[str, Any]], int]:
        def operation() -> tuple[list[dict[str, Any]], int]:
            wx = self._ensure_client()
            names = self._session_names(wx)
            items: list[dict[str, Any]] = []
            with self._cache_lock:
                for name in names:
                    cached = self._cache.get(name) or []
                    last_at = cached[-1]["ts"] if cached else None
                    items.append(
                        {"wxid": None, "name": name, "remark": None, "last_msg_at": last_at}
                    )
            items.sort(key=lambda item: item["last_msg_at"] or 0, reverse=True)
            total = len(items)
            return [dict(item) for item in items[offset : offset + limit]], total

        return self._execute("读取会话列表", operation)

    # ---------- 消息 ----------
    def _chat_with(self, wx: Any, chat_name: str) -> None:
        fn = getattr(wx, "ChatWith", None)
        if not callable(fn):
            raise RuntimeError("当前微信后端不支持 ChatWith()")
        fn(chat_name)

    def _current_chat(self, wx: Any) -> str | None:
        """读取当前聊天对象名；读不到返回 None。

        wxauto4 用 ChatBox.who；wechatauto-replica 用 ChatInfo()["chat_name"]。
        """
        box = _attr(wx, "ChatBox")
        if box is not None:
            value = _attr(box, "who", "nickname", "name")
            if value:
                return str(value).strip()
        info_fn = getattr(wx, "ChatInfo", None)
        if callable(info_fn):
            try:
                info = info_fn()
            except Exception as exc:  # noqa: BLE001
                logger.debug("ChatInfo() 失败：%s", exc)
                return None
            if isinstance(info, dict):
                value = info.get("chat_name") or info.get("who") or info.get("name")
                if value:
                    return str(value).strip()
        return None

    def _get_all_messages(self, wx: Any) -> list[Any]:
        fn = getattr(wx, "GetAllMessage", None)
        if not callable(fn):
            raise RuntimeError("当前微信后端不支持 GetAllMessage()")
        for kwargs in ({"savepic": False}, {}):
            try:
                return list(fn(**kwargs) or [])
            except TypeError:
                continue
        return list(fn() or [])

    def _normalize_message(
        self, chat_name: str, raw: Any, index: int, fallback_ts: int
    ) -> dict[str, Any]:
        raw_type = str(_attr(raw, "type", "msg_type") or "text")
        kind = raw_type.strip().lower()
        # wxauto4 的 Message.type 是 text/image/file 等，发送方方向在 attr
        # （self/friend/system/time/recall）；旧 wxauto 则把方向塞进 type。
        placement = str(_attr(raw, "attr", "direction", "is_self") or "").strip().lower()
        content = _attr(raw, "content", "text", "msg", "message")
        if content is None:
            content = str(raw)
        sender = _attr(raw, "sender", "from", "nickname", "name")

        from_self = placement in {"self", "me", "我", "right"} or kind in {
            "self",
            "me",
            "我",
            "friend_self",
        }
        system_like = placement in {"system", "sys", "time", "recall", "系统"} or kind in {
            "sys",
            "system",
            "time",
            "recall",
            "系统",
        }
        if kind in {"time", "recall", "sys", "system", "note"}:
            # 系统类行（时间分割/撤回提示）统一标记，前端按 type 过滤。
            system_like = True
        if from_self:
            who = "我"
            message_type = "text" if kind in {"self", "me", "我", "friend_self"} else kind
        elif system_like:
            who = "系统"
            message_type = kind
        else:
            who = str(sender) if sender else chat_name
            message_type = kind or "text"

        ts = _parse_timestamp(_attr(raw, "time", "create_time", "ts"), fallback_ts)
        raw_id = _attr(raw, "id", "msg_id", "MsgId")
        text = _placeholder_for(kind, content)
        if text is None:
            text = str(content)
        digest = hashlib.sha1(str(content).encode("utf-8", errors="replace")).hexdigest()[:8]
        message_id = str(raw_id) if raw_id else f"wx-{chat_name}-{ts}-{index}-{digest}"
        return {
            "id": message_id,
            "from": who,
            "text": text,
            "ts": ts,
            "type": message_type,
        }

    def messages(self, chat_name: str, wx_id: str | None = None) -> list[dict[str, Any]]:
        def operation() -> list[dict[str, Any]]:
            wx = self._ensure_client()
            self._chat_with(wx, chat_name)
            raw_items = self._get_all_messages(wx)
            now = int(time.time())
            base = now - max(0, len(raw_items) - 1)
            items = [
                self._normalize_message(chat_name, raw, index, base + index)
                for index, raw in enumerate(raw_items)
            ]
            items.sort(key=lambda item: (item["ts"], item["id"]))
            items = items[-self.settings.max_messages :]
            with self._cache_lock:
                self._cache[chat_name] = [dict(item) for item in items]
            return items

        return self._execute("读取聊天记录", operation)

    def _merge_cache(self, chat_name: str, items: list[dict[str, Any]]) -> None:
        with self._cache_lock:
            rows = self._cache.setdefault(chat_name, [])
            known = {row["id"] for row in rows}
            for item in items:
                if item["id"] not in known:
                    rows.append(dict(item))
                    known.add(item["id"])
            rows.sort(key=lambda item: (item["ts"], item["id"]))
            self._cache[chat_name] = rows[-self.settings.max_messages :]

    def _append_outgoing_cache(self, chat_name: str, text: str, kind: str, ts: int) -> None:
        digest = hashlib.sha1(text.encode("utf-8", errors="replace")).hexdigest()[:8]
        item = {
            "id": f"local-{chat_name}-{ts}-{digest}",
            "from": "我",
            "text": text,
            "ts": ts,
            "type": kind,
        }
        self._merge_cache(chat_name, [item])

    # ---------- 发送 ----------
    def _send_text_wxauto4(
        self, wx: Any, fn: Callable[..., Any], name: str, text: str
    ) -> None:
        """wxauto4 发送顺序：先带 who 直接发；失败再 ChatWith 打开会话，
        确认当前会话确实是目标对象后才补发（避免误发给刚才打开的其他人）。"""
        response = _call_with_optional_who(fn, text, name)
        if _response_ok(response):
            return
        first_error = _response_text(response)
        chat_with = getattr(wx, "ChatWith", None)
        if callable(chat_with):
            try:
                chat_with(name)
            except Exception as exc:  # noqa: BLE001
                raise RuntimeError(
                    f"打开会话 {name} 失败：{exc}（首次发送返回：{first_error}）"
                ) from exc
            current = self._current_chat(wx)
            if current and current == name.strip():
                response = _call_with_optional_who(fn, text, None)
                if _response_ok(response):
                    return
        raise RuntimeError(
            f"发送消息失败：{_response_text(response) or first_error or '未知错误'}"
        )

    def send(self, name: str, msg: str, humanize: bool = False) -> int:
        segments = split_text(msg, _MAX_SEGMENT_CHARS) if humanize else [msg]
        state = {"sent": 0}

        def operation() -> None:
            wx = self._ensure_client()
            backend = self._select_backend()
            fn = getattr(wx, "SendMsg", None)
            if not callable(fn):
                raise RuntimeError("当前微信后端不支持 SendMsg()")
            for index in range(state["sent"], len(segments)):
                if humanize:
                    random_pause(self.settings.humanize_min_s, self.settings.humanize_max_s, self._rng)
                if backend in ("wxauto4", "wechatauto"):
                    self._send_text_wxauto4(wx, fn, name, segments[index])
                else:
                    if state["sent"] == 0:
                        self._chat_with(wx, name)
                    _call_with_optional_who(fn, segments[index], name)
                state["sent"] = index + 1
            sent_at = int(time.time())
            self._append_outgoing_cache(name, msg, "text", sent_at)

        self._execute("发送消息", operation, retry=False)
        return int(time.time())

    def _resolve_file(self, file_path: str | None, file_url: str | None) -> str:
        if file_path:
            path = Path(file_path).expanduser()
            if not path.is_absolute():
                path = (Path.cwd() / path).resolve()
            if not path.is_file():
                raise ApiError(400, "FILE_NOT_FOUND", f"file_path 不存在或不是文件：{path}")
            return str(path)

        url = (file_url or "").strip()
        if not url.lower().startswith(("http://", "https://")):
            raise ApiError(400, "FILE_URL_INVALID", "file_url 必须是 http(s) 地址")
        parsed = urllib.parse.urlparse(url)
        suffix = Path(parsed.path).suffix[:12]
        fd, temp_path = tempfile.mkstemp(prefix="wechat-bridge-", suffix=suffix)
        os.close(fd)
        try:
            request = urllib.request.Request(
                url, headers={"User-Agent": "fcmediaagent-wechat-bridge/1.0"}
            )
            with urllib.request.urlopen(request, timeout=_DOWNLOAD_TIMEOUT_S) as response:
                with open(temp_path, "wb") as target:
                    shutil.copyfileobj(response, target)
        except Exception as exc:  # noqa: BLE001
            try:
                os.unlink(temp_path)
            except OSError:
                pass
            raise ApiError(502, "FILE_DOWNLOAD_FAILED", f"下载 file_url 失败：{exc}") from exc
        return temp_path

    def _send_file_wxauto4(
        self, wx: Any, fn: Callable[..., Any], name: str, local_path: str
    ) -> None:
        response = _call_with_optional_who(fn, local_path, name)
        if _response_ok(response):
            return
        first_error = _response_text(response)
        chat_with = getattr(wx, "ChatWith", None)
        if callable(chat_with):
            try:
                chat_with(name)
            except Exception as exc:  # noqa: BLE001
                raise RuntimeError(
                    f"打开会话 {name} 失败：{exc}（首次发送返回：{first_error}）"
                ) from exc
            current = self._current_chat(wx)
            if current and current == name.strip():
                response = _call_with_optional_who(fn, local_path, None)
                if _response_ok(response):
                    return
        raise RuntimeError(
            f"发送文件失败：{_response_text(response) or first_error or '未知错误'}"
        )

    def send_file(
        self, name: str, file_path: str | None, file_url: str | None, humanize: bool = False
    ) -> tuple[str, int]:
        local_path = self._resolve_file(file_path, file_url)

        def operation() -> None:
            wx = self._ensure_client()
            backend = self._select_backend()
            if humanize:
                random_pause(self.settings.humanize_min_s, self.settings.humanize_max_s, self._rng)
            fn = getattr(wx, "SendFiles", None)
            if not callable(fn):
                raise RuntimeError("当前微信后端不支持 SendFiles()")
            if backend in ("wxauto4", "wechatauto"):
                self._send_file_wxauto4(wx, fn, name, local_path)
            else:
                _call_with_optional_who(fn, local_path, name)
            self._append_outgoing_cache(name, local_path, "file", int(time.time()))

        self._execute("发送文件", operation, retry=False)
        return local_path, int(time.time())

    # ---------- 监听 ----------
    def _make_listen_callback(self, target: str) -> Callable[..., None]:
        """wxauto4 回调可能在内部线程池里执行：只做加锁入队，不做 UI 操作。"""

        def _callback(message: Any, chat: Any = None) -> None:
            try:
                chat_name = _attr(chat, "who", "nickname", "name")
                name = str(chat_name).strip() if chat_name else target
                now = int(time.time())
                item = self._normalize_message(name, message, 0, now)
                with self._pending_lock:
                    self._pending.append((name, item))
            except Exception:  # noqa: BLE001
                logger.exception("wxauto4 监听回调处理失败")

        return _callback

    def listen_list(self, wxid: str | None, nickname: str | None) -> list[str]:
        target = (nickname or "").strip() or (wxid or "").strip()
        if not target:
            raise ApiError(400, "TARGET_REQUIRED", "wxid 或 nickname 至少填写一项")

        def operation() -> None:
            wx = self._ensure_client()
            backend = self._select_backend()
            fn = getattr(wx, "AddListenChat", None)
            if not callable(fn):
                logger.warning("当前微信后端无 AddListenChat()，监听列表仅做登记")
                return
            if backend in ("wxauto4", "wechatauto"):
                callback = self._make_listen_callback(target)
                try:
                    response = fn(target, callback)
                except TypeError:
                    response = fn(target, callback=callback)
                if not _response_ok(response):
                    text = _response_text(response)
                    if "已监听" not in text and "已添加" not in text:
                        raise RuntimeError(f"注册监听失败：{text}")
                self._start_listening(wx)
                return
            try:
                if _supports_kwarg(fn, "who"):
                    fn(who=target)
                else:
                    fn(target)
            except TypeError:
                fn(target)

        self._execute(f"注册监听会话 {target}", operation)
        if target not in self._following:
            self._following.append(target)
        return list(self._following)

    def _start_listening(self, wx: Any) -> None:
        fn = getattr(wx, "StartListening", None)
        if callable(fn):
            try:
                fn()
            except Exception as exc:  # noqa: BLE001
                # 已在监听 / 监听线程已启动时会报错，属于正常情况。
                logger.debug("wxauto4 StartListening() 跳过错：%s", exc)

    def _drain_pending(self) -> None:
        with self._pending_lock:
            if not self._pending:
                return
            pending, self._pending = self._pending, []
        grouped: dict[str, list[dict[str, Any]]] = {}
        for chat_name, item in pending:
            grouped.setdefault(chat_name, []).append(item)
        for chat_name, items in grouped.items():
            self._merge_cache(chat_name, items)

    def poll(self) -> None:
        """监听线程调用：把新消息合并进本地缓存。

        wxauto4 是回调式：回调只入队，这里统一 drain；不需要 UI 锁。
        wxauto 旧库是拉取式：只尝试 0.5 秒拿 UI 锁，拿不到就跳过本轮，不做重试，
        避免轮询长期占用互斥锁导致发送接口排队。
        """
        self._drain_pending()
        if self._backend_name in ("wxauto4", "wechatauto"):
            return
        if not self._following:
            return
        if not self._ui_lock.acquire(timeout=0.5):
            logger.debug("UI 正忙，跳过本轮监听轮询")
            return
        try:
            wx = self._ensure_client()
            fn = getattr(wx, "GetListenMessage", None)
            if not callable(fn):
                return
            payload = fn()
            if not isinstance(payload, dict):
                return
            for chat_name, raw_items in payload.items():
                items = list(raw_items or [])
                now = int(time.time())
                base = now - max(0, len(items) - 1)
                normalized = [
                    self._normalize_message(str(chat_name), raw, index, base + index)
                    for index, raw in enumerate(items)
                ]
                self._merge_cache(str(chat_name), normalized)
        except ApiError as exc:
            logger.warning("监听轮询失败：%s", exc.message)
        except Exception:  # noqa: BLE001
            logger.exception("监听轮询异常")
        finally:
            self._ui_lock.release()

    def close(self) -> None:
        wx = self._wx
        stop = getattr(wx, "StopListening", None)
        if callable(stop):
            try:
                stop(remove=True)
            except TypeError:
                try:
                    stop()
                except Exception:  # noqa: BLE001
                    logger.debug("StopListening() 失败", exc_info=True)
            except Exception:  # noqa: BLE001
                logger.debug("StopListening() 失败", exc_info=True)
        return None


# ---------- 时间 / 版本工具 ----------
def _parse_timestamp(value: Any, fallback: int) -> int:
    """把 wxauto 的 "12:34" / "2026-11-06 12:34:56" / 数字转成 Unix 秒。"""
    if value is None:
        return int(fallback)
    if isinstance(value, (int, float)):
        number = int(value)
        if number > 10**12:  # 毫秒
            number //= 1000
        return number
    text = str(value).strip()
    if not text:
        return int(fallback)
    if text.isdigit():
        number = int(text)
        if number > 10**12:
            number //= 1000
        return number
    formats = (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y/%m/%d %H:%M:%S",
        "%Y/%m/%d %H:%M",
        "%m-%d %H:%M:%S",
        "%m-%d %H:%M",
        "%H:%M:%S",
        "%H:%M",
    )
    for fmt in formats:
        try:
            parsed = time.strptime(text, fmt)
        except ValueError:
            continue
        now = time.localtime()
        year = now.tm_year if "%Y" not in fmt else parsed.tm_year
        if "%m" not in fmt:
            month = now.tm_mon
        else:
            month = parsed.tm_mon
        if "%d" not in fmt:
            day = now.tm_mday
        else:
            day = parsed.tm_mday
        try:
            return int(time.mktime((year, month, day, parsed.tm_hour, parsed.tm_min, parsed.tm_sec, 0, 0, -1)))
        except (OverflowError, ValueError):
            return int(fallback)
    return int(fallback)


def _candidate_executable(candidate: str) -> Path | None:
    """注册表里可能给目录，也可能给 exe；兼容 3.x（WeChat.exe）和 4.x（Weixin.exe）。"""
    path = Path(candidate)
    if path.is_file():
        return path
    if path.is_dir():
        for name in ("Weixin.exe", "WeChat.exe"):
            exe = path / name
            if exe.is_file():
                return exe
    return None


def _detect_wechat_version() -> str | None:
    """从注册表 / 默认安装目录找微信可执行文件，再读文件版本；失败返回 None。

    微信 3.9.x 是 WeChat.exe（Program Files (x86)\\Tencent\\WeChat），
    微信 4.x 是 Weixin.exe（Program Files\\Tencent\\Weixin）。
    """
    if os.name != "nt":
        return None
    try:
        import winreg
    except Exception:  # noqa: BLE001
        return None

    candidates: list[str] = []
    keys = (
        (winreg.HKEY_CURRENT_USER, r"Software\Tencent\Weixin", "File"),
        (winreg.HKEY_CURRENT_USER, r"Software\Tencent\Weixin", "InstallPath"),
        (winreg.HKEY_CURRENT_USER, r"Software\Tencent\WeChat", "File"),
        (winreg.HKEY_CURRENT_USER, r"Software\Tencent\WeChat", "InstallPath"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Tencent\Weixin", "InstallPath"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Tencent\Weixin", "InstallPath"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Tencent\WeChat", "InstallPath"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Tencent\WeChat", "InstallPath"),
    )
    for hive, key, value_name in keys:
        try:
            with winreg.OpenKey(hive, key) as handle:
                value, _ = winreg.QueryValueEx(handle, value_name)
            if value:
                candidates.append(str(value))
        except OSError:
            continue

    for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
        if not base:
            continue
        candidates.append(str(Path(base) / "Tencent" / "Weixin"))
        candidates.append(str(Path(base) / "Tencent" / "WeChat"))

    for candidate in candidates:
        path = _candidate_executable(candidate)
        if path is None:
            continue
        version = _windows_file_version(str(path))
        if version:
            return version
    return None


def _windows_file_version(executable: str) -> str | None:
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        version_dll = ctypes.windll.version
        size = version_dll.GetFileVersionInfoSizeW(executable, None)
        if not size:
            return None
        buffer = ctypes.create_string_buffer(size)
        if not version_dll.GetFileVersionInfoW(executable, 0, size, buffer):
            return None
        pointer = ctypes.c_void_p()
        length = wintypes.UINT()
        if not version_dll.VerQueryValueW(
            buffer, "\\", ctypes.byref(pointer), ctypes.byref(length)
        ):
            return None
        if not pointer.value:
            return None

        class VS_FIXEDFILEINFO(ctypes.Structure):
            _fields_ = [
                ("dwSignature", wintypes.DWORD),
                ("dwStrucVersion", wintypes.DWORD),
                ("dwFileVersionMS", wintypes.DWORD),
                ("dwFileVersionLS", wintypes.DWORD),
                ("dwProductVersionMS", wintypes.DWORD),
                ("dwProductVersionLS", wintypes.DWORD),
                ("dwFileFlagsMask", wintypes.DWORD),
                ("dwFileFlags", wintypes.DWORD),
                ("dwFileOS", wintypes.DWORD),
                ("dwFileType", wintypes.DWORD),
                ("dwFileSubtype", wintypes.DWORD),
                ("dwFileDateMS", wintypes.DWORD),
                ("dwFileDateLS", wintypes.DWORD),
            ]

        info = ctypes.cast(pointer, ctypes.POINTER(VS_FIXEDFILEINFO)).contents
        ms = info.dwFileVersionMS
        ls = info.dwFileVersionLS
        return f"{ms >> 16}.{ms & 0xFFFF}.{ls >> 16}.{ls & 0xFFFF}"
    except Exception:  # noqa: BLE001
        return None
