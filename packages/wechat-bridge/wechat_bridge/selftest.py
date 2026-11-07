"""自检：用 Mock 模式拉起临时服务，断言 6 个接口 + 401 分支。

运行：
    cd packages/wechat-bridge
    python -m wechat_bridge.selftest

成功最终输出一行 SELFTEST OK，退出码 0；任何断言失败退出码 1。
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from wechat_bridge.config import Settings
from wechat_bridge.errors import ApiError
from wechat_bridge.wechat_ui import WeChatUIAdapter, _placeholder_for

# Windows 重定向到管道时默认用 GBK，会导致中文日志乱码；统一按 UTF-8 输出。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

TOKEN = "selftest-token"
PACKAGE_ROOT = Path(__file__).resolve().parent.parent


def _maybe_json(raw: str):
    text = (raw or "").strip()
    if not text:
        return ""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def _request(method: str, url: str, payload=None, token: str | None = None, timeout: float = 10.0):
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        request.add_header("content-type", "application/json; charset=utf-8")
    if token:
        request.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, _maybe_json(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        return exc.code, _maybe_json(exc.read().decode("utf-8", "replace"))
    except urllib.error.URLError as exc:
        raise RuntimeError(f"请求 {url} 失败：{exc}") from exc


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _read_log(log_path: Path) -> str:
    return _read_text(log_path)[-4000:] or "(无法读取服务日志)"


def _wait_health(base_url: str, process: subprocess.Popen, log_path: Path, timeout: float = 30.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if process.poll() is not None:
            raise RuntimeError(
                f"网桥进程提前退出（code={process.returncode}）：\n{_read_log(log_path)}"
            )
        try:
            status, body = _request("GET", base_url + "/healthz", timeout=2.0)
            if status == 200 and str(body).strip() == "ok":
                return
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.2)
    raise RuntimeError(f"等待 /healthz 超时：\n{_read_log(log_path)}")


# ---------- wxauto4 双后端：无真微信的桩自测 ----------
class _StubResponse(dict):
    """模拟 wxauto4.param.WxResponse（dict 子类 + is_success）。"""

    def __init__(self, status: str = "成功", message: str = ""):
        super().__init__(status=status, message=message)

    @property
    def is_success(self) -> bool:
        return self["status"] == "成功"


class _StubChatBox:
    def __init__(self, who: str):
        self.who = who


class _StubSession:
    def __init__(self, name: str):
        self.name = name


class _StubMessage:
    """模拟 wxauto4 Message：type 是消息类型，attr 是方向（self/friend/system）。"""

    def __init__(self, content: str, attr: str = "friend", mtype: str = "text", mid: str = "", sender: str = ""):
        self.content = content
        self.attr = attr
        self.type = mtype
        self.id = mid or f"stub-{attr}-{content}"
        self.sender = sender or None


class _StubChat:
    def __init__(self, who: str):
        self.who = who


class _StubWeChat:
    """wxauto4 WeChat 的最小桩：覆盖 status/sessions/send/send_file/listen 五条链路。"""

    def __init__(self) -> None:
        self.nickname = "桩测试号"
        self.logged_in = True
        self.sent: list[tuple[str, str]] = []
        self.files: list[tuple[str, str]] = []
        self.listeners: dict[str, object] = {}
        self.listening = False
        self.sessions = ["张三", "李四"]
        self.current = "张三"
        self.history = [
            _StubMessage("你好", attr="friend", sender="张三"),
            _StubMessage("收到", attr="self"),
            _StubMessage("系统提示", attr="system", mtype="system"),
        ]
        self.fail_send_once = False

    @property
    def ChatBox(self) -> _StubChatBox:
        return _StubChatBox(self.current)

    def IsOnline(self) -> bool:
        return self.logged_in

    def GetMyInfo(self) -> dict[str, str]:
        return {"nickname": "桩测试号", "wxid": "wxid_stub"}

    def GetSession(self) -> list[_StubSession]:
        return [_StubSession(name) for name in self.sessions]

    def ChatWith(self, who, exact=True, force=False, force_wait=0.5):
        self.current = who
        return None

    def GetAllMessage(self):
        return list(self.history)

    def SendMsg(self, msg, who=None, clear=True, at=None, exact=False):
        if self.fail_send_once:
            self.fail_send_once = False
            return _StubResponse("失败", "桩：故意失败一次")
        target = who or self.current
        self.sent.append((str(target), msg))
        return _StubResponse()

    def SendFiles(self, filepath, who=None, exact=False):
        target = who or self.current
        self.files.append((str(target), filepath))
        return _StubResponse()

    def AddListenChat(self, nickname, callback=None):
        if callback is None:
            return _StubResponse("失败", "桩：缺少回调")
        self.listeners[nickname] = callback
        return _StubResponse()

    def StartListening(self):
        self.listening = True

    def StopListening(self, remove=False):
        self.listening = False


def _stub_settings() -> Settings:
    return Settings(
        mock=False,
        token="",
        host="127.0.0.1",
        port=1,
        lock_file=Path("stub.lock"),
        log_dir=Path("stub-logs"),
        ui_timeout_s=5.0,
        ui_retry=0,
        humanize_min_s=0.0,
        humanize_max_s=0.0,
        listen_poll_s=0.5,
        max_messages=200,
        idempotency_window_s=5.0,
        request_timeout_s=30.0,
        access_log=False,
        backend="wxauto4",
    )


def _run_ui_stub_checks(check, temp_dir: Path, backend: str = "wxauto4") -> None:
    """用桩验证 wxauto4 / wechatauto 分支五条链路，不需要真实微信客户端。"""
    label = f"{backend} 桩"
    settings = _stub_settings()
    client = _StubWeChat()
    adapter = WeChatUIAdapter(settings, backend=backend, client_factory=lambda: client)

    # 1) status
    data = adapter.status()
    check(
        f"{label}：status 读取昵称/wxid/在线状态",
        data.get("backend") == backend
        and data.get("logged_in") is True
        and data.get("nickname") == "桩测试号"
        and data.get("wxid") == "wxid_stub",
        str(data),
    )

    # 2) sessions
    items, total = adapter.contacts(10, 0)
    check(
        f"{label}：GetSession 会话列表可用",
        total == 2 and [item["name"] for item in items] == ["张三", "李四"],
        f"{total} {items}",
    )

    # 3) send（单条 + 失败后 ChatWith 回退 + humanize 分段）
    adapter.send("张三", "桩测试消息", humanize=False)
    check(
        f"{label}：SendMsg(who=) 发送成功",
        client.sent[-1] == ("张三", "桩测试消息"),
        str(client.sent),
    )
    client.sent.clear()
    client.fail_send_once = True
    adapter.send("张三", "失败回退", humanize=False)
    check(
        f"{label}：SendMsg 失败后经 ChatWith 回退成功",
        client.sent == [("张三", "失败回退")],
        str(client.sent),
    )
    client.sent.clear()
    long_text = "拟人化分段：" + "这是用于验证分段发送的内容。" * 12
    adapter.send("张三", long_text, humanize=True)
    check(
        f"{label}：humanize 长文本分段发送",
        len(client.sent) >= 2 and "".join(text for _, text in client.sent) == long_text,
        f"segments={len(client.sent)}",
    )

    # 4) send_file
    upload = temp_dir / "stub-upload.txt"
    upload.write_text("wxauto4 stub file\n", encoding="utf-8")
    local_path, _sent_at = adapter.send_file("张三", str(upload), None)
    check(
        f"{label}：SendFiles(who=) 发送文件成功",
        client.files[-1] == ("张三", local_path),
        str(client.files),
    )

    # 5) listen + poll（回调跨线程语义：入队后由 poll 统一 drain）
    following = adapter.listen_list(None, "张三")
    callback = client.listeners.get("张三")
    check(
        f"{label}：AddListenChat 注册监听",
        following == ["张三"] and callable(callback) and client.listening is True,
        f"{following} listeners={list(client.listeners)}",
    )
    if callable(callback):
        callback(_StubMessage("监听收到的新消息", attr="friend", sender="张三"), _StubChat("张三"))
    adapter.poll()
    cached = list(adapter._cache.get("张三") or [])
    check(
        f"{label}：监听回调入队后 poll 合并进缓存",
        any(row["text"] == "监听收到的新消息" for row in cached),
        str(cached[-2:]),
    )

    # 6) 未登录错误映射
    def _boom():
        raise RuntimeError(
            "未找到已登录的客户端主窗口，请尝试：1. 检查是否关闭了主窗口 "
            "2. 退出重新登录后重试"
        )

    unlogged = WeChatUIAdapter(settings, backend=backend, client_factory=_boom)
    error_code = None
    try:
        unlogged.send("张三", "x")
    except ApiError as exc:  # noqa: PERF203
        error_code = exc.code
    degraded = unlogged.status()
    check(
        f"{label}：未登录映射 503 WECHAT_NOT_LOGGED_IN 且 status 降级",
        error_code == "WECHAT_NOT_LOGGED_IN"
        and degraded.get("logged_in") is False
        and degraded.get("backend") == backend,
        f"error_code={error_code} status={degraded}",
    )


def _run_placeholder_checks(check) -> None:
    """非文本消息占位符：图片/文件 XML 不能当正文回给上层。"""
    img_xml = '<?xml version="1.0"?>\n<msg>\n\t<img aeskey="abc" length="1" />\n</msg>'
    check(
        "占位符：图片 XML → [图片]",
        _placeholder_for("image", img_xml) == "[图片]",
        str(_placeholder_for("image", img_xml)),
    )
    check(
        "占位符：file/voice/video 各自归一",
        _placeholder_for("file", "<msg/>") == "[文件]"
        and _placeholder_for("voice", "x") == "[语音]"
        and _placeholder_for("video", "x") == "[视频]",
        "",
    )
    check(
        "占位符：纯文本原样保留（返回 None）",
        _placeholder_for("text", "你好") is None,
        str(_placeholder_for("text", "你好")),
    )
    check(
        "占位符：text 类型但内容是 XML → [非文本消息]",
        _placeholder_for("text", img_xml) == "[非文本消息]",
        str(_placeholder_for("text", img_xml)),
    )


def main() -> int:
    temp_dir = Path(tempfile.mkdtemp(prefix="wechat-bridge-selftest-"))
    port = _free_port()
    base_url = f"http://127.0.0.1:{port}"
    log_path = temp_dir / "server.log"
    failures: list[str] = []
    checks = 0

    def check(name: str, condition: bool, detail: str = "") -> None:
        nonlocal checks
        checks += 1
        if condition:
            print(f"[PASS] {name}")
        else:
            message = f"[FAIL] {name}"
            if detail:
                message += f" | {detail}"
            print(message)
            failures.append(name)

    _run_ui_stub_checks(check, temp_dir, "wxauto4")
    _run_ui_stub_checks(check, temp_dir, "wechatauto")
    _run_placeholder_checks(check)

    env = os.environ.copy()
    env.update(
        {
            "WECHAT_BRIDGE_MOCK": "1",
            "WECHAT_BRIDGE_TOKEN": TOKEN,
            "WECHAT_BRIDGE_HOST": "127.0.0.1",
            "WECHAT_BRIDGE_PORT": str(port),
            "WECHAT_BRIDGE_LOCK_FILE": str(temp_dir / "bridge.lock"),
            "WECHAT_BRIDGE_LOG_DIR": str(temp_dir / "logs"),
            "WECHAT_BRIDGE_IDEMPOTENCY_WINDOW": "30",
            "PYTHONUNBUFFERED": "1",
            "PYTHONUTF8": "1",
        }
    )
    existing_pythonpath = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = str(PACKAGE_ROOT) + (os.pathsep + existing_pythonpath if existing_pythonpath else "")

    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    process: subprocess.Popen | None = None
    try:
        with open(log_path, "w", encoding="utf-8") as log_file:
            process = subprocess.Popen(
                [sys.executable, "-m", "wechat_bridge"],
                cwd=str(PACKAGE_ROOT),
                env=env,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                creationflags=creationflags,
            )
            _wait_health(base_url, process, log_path)

            # ---- 1. healthz：不鉴权 ----
            status, body = _request("GET", base_url + "/healthz")
            check("GET /healthz 无需鉴权返回 200 ok", status == 200 and str(body) == "ok", repr(body))

            # ---- 2. 401 分支 ----
            status, body = _request("GET", base_url + "/api/v1/bot/status")
            check(
                "无 token 访问受保护接口返回 401 + UNAUTHORIZED",
                status == 401 and isinstance(body, dict) and body.get("ok") is False
                and body.get("code") == "UNAUTHORIZED",
                f"{status} {body}",
            )
            status, body = _request(
                "GET", base_url + "/api/v1/bot/status", token="wrong-token"
            )
            check(
                "错误 token 返回 401 + UNAUTHORIZED",
                status == 401 and isinstance(body, dict) and body.get("code") == "UNAUTHORIZED",
                f"{status} {body}",
            )

            # ---- 3. bot/status ----
            status, body = _request(
                "GET", base_url + "/api/v1/bot/status", token=TOKEN
            )
            check(
                "GET /api/v1/bot/status 契约完整",
                status == 200
                and isinstance(body, dict)
                and body.get("ok") is True
                and body.get("logged_in") is True
                and body.get("mock") is True
                and isinstance(body.get("nickname"), str)
                and isinstance(body.get("wxid"), str)
                and isinstance(body.get("wechat_version"), str)
                and isinstance(body.get("uptime_s"), (int, float))
                and body.get("uptime_s") >= 0,
                f"{status} {body}",
            )

            # ---- 4. memory/list ----
            status, body = _request(
                "GET", base_url + "/api/v1/memory/list?limit=2&offset=0", token=TOKEN
            )
            items = body.get("items", []) if isinstance(body, dict) else []
            check(
                "GET /api/v1/memory/list 分页与字段正确",
                status == 200
                and isinstance(body, dict)
                and body.get("ok") is True
                and isinstance(body.get("total"), int)
                and body.get("total") >= 3
                and len(items) == 2
                and all(
                    set(item.keys()) == {"wxid", "name", "remark", "last_msg_at"}
                    for item in items
                ),
                f"{status} {body}",
            )

            # ---- 5. chat/messages 预置 5 条，时间升序 ----
            status, body = _request(
                "GET",
                base_url + "/api/v1/chat/messages?chat_name=Stu",
                token=TOKEN,
            )
            items = body.get("items", []) if isinstance(body, dict) else []
            timestamps = [item.get("ts") for item in items]
            check(
                "GET /api/v1/chat/messages 返回预置 5 条且升序",
                status == 200
                and isinstance(body, dict)
                and body.get("ok") is True
                and body.get("chat_name") == "Stu"
                and len(items) == 5
                and timestamps == sorted(timestamps)
                and all(set(item.keys()) == {"id", "from", "text", "ts", "type"} for item in items),
                f"{status} {body}",
            )

            # ---- 6. chat/send：追加 + 幂等 ----
            status, sent = _request(
                "POST",
                base_url + "/api/v1/chat/send",
                {"name": "Stu", "msg": "selftest-hello"},
                TOKEN,
            )
            check(
                "POST /api/v1/chat/send 契约完整",
                status == 200
                and isinstance(sent, dict)
                and sent.get("ok") is True
                and sent.get("name") == "Stu"
                and sent.get("msg") == "selftest-hello"
                and isinstance(sent.get("sent_at"), int),
                f"{status} {sent}",
            )
            send_at = sent.get("sent_at") if isinstance(sent, dict) else None

            status, duplicate = _request(
                "POST",
                base_url + "/api/v1/chat/send",
                {"name": "Stu", "msg": "selftest-hello"},
                TOKEN,
            )
            check(
                "重复 send 在幂等窗口内不重复追加",
                status == 200
                and isinstance(duplicate, dict)
                and duplicate.get("sent_at") == send_at,
                f"{status} {duplicate}",
            )

            status, body = _request(
                "GET",
                base_url + "/api/v1/chat/messages?chat_name=Stu",
                token=TOKEN,
            )
            items = body.get("items", []) if isinstance(body, dict) else []
            check(
                "send 后消息追加到会话末尾",
                status == 200 and len(items) == 6 and items[-1].get("text") == "selftest-hello",
                f"{status} len={len(items)} last={items[-1] if items else None}",
            )

            # ---- 7. humanize 长文本 ----
            long_text = "拟人化长文本：" + "这是用于验证分段发送的内容。" * 12
            status, sent = _request(
                "POST",
                base_url + "/api/v1/chat/send",
                {"name": "Stu", "msg": long_text, "humanize": True},
                TOKEN,
            )
            check(
                "POST /api/v1/chat/send humanize=true 可用",
                status == 200 and isinstance(sent, dict) and sent.get("ok") is True,
                f"{status} {sent}",
            )

            # ---- 8. chat/send-file ----
            upload = temp_dir / "selftest-upload.txt"
            upload.write_text("wechat bridge selftest file\n", encoding="utf-8")
            status, sent_file = _request(
                "POST",
                base_url + "/api/v1/chat/send-file",
                {"name": "Stu", "file_path": str(upload)},
                TOKEN,
            )
            check(
                "POST /api/v1/chat/send-file 契约完整",
                status == 200
                and isinstance(sent_file, dict)
                and sent_file.get("ok") is True
                and sent_file.get("name") == "Stu"
                and sent_file.get("file") == str(upload)
                and isinstance(sent_file.get("sent_at"), int),
                f"{status} {sent_file}",
            )
            status, body = _request(
                "GET",
                base_url + "/api/v1/chat/messages?chat_name=Stu",
                token=TOKEN,
            )
            items = body.get("items", []) if isinstance(body, dict) else []
            check(
                "send-file 后会话末尾出现 file 类型消息",
                status == 200 and len(items) == 8 and items[-1].get("type") == "file",
                f"{status} len={len(items)} last={items[-1] if items else None}",
            )

            # ---- 9. chat/listen-list ----
            status, body = _request(
                "POST",
                base_url + "/api/v1/chat/listen-list",
                {"nickname": "Stu"},
                TOKEN,
            )
            check(
                "POST /api/v1/chat/listen-list 返回 following",
                status == 200
                and isinstance(body, dict)
                and body.get("ok") is True
                and body.get("following") == ["Stu"],
                f"{status} {body}",
            )
            status, body = _request(
                "POST",
                base_url + "/api/v1/chat/listen-list",
                {"wxid": "wxid_mock_stu"},
                TOKEN,
            )
            check(
                "listen-list 按 wxid 解析昵称且不重复",
                status == 200 and isinstance(body, dict) and body.get("following") == ["Stu"],
                f"{status} {body}",
            )

            # ---- 10. 错误分支 ----
            status, body = _request(
                "POST", base_url + "/api/v1/chat/send", {"name": "Stu", "msg": ""}, TOKEN
            )
            check(
                "空 msg 返回 400 MESSAGE_REQUIRED",
                status == 400 and isinstance(body, dict) and body.get("code") == "MESSAGE_REQUIRED",
                f"{status} {body}",
            )
            status, body = _request(
                "POST", base_url + "/api/v1/chat/send-file", {"name": "Stu"}, TOKEN
            )
            check(
                "缺少文件参数返回 400 FILE_REQUIRED",
                status == 400 and isinstance(body, dict) and body.get("code") == "FILE_REQUIRED",
                f"{status} {body}",
            )
            status, body = _request(
                "POST", base_url + "/api/v1/chat/listen-list", {}, TOKEN
            )
            check(
                "缺少监听目标返回 400 TARGET_REQUIRED",
                status == 400 and isinstance(body, dict) and body.get("code") == "TARGET_REQUIRED",
                f"{status} {body}",
            )
            status, body = _request(
                "GET", base_url + "/api/v1/chat/messages", token=TOKEN
            )
            check(
                "缺少 chat_name 返回 400 且错误体统一",
                status == 400
                and isinstance(body, dict)
                and body.get("ok") is False
                and body.get("code") == "CHAT_NAME_REQUIRED",
                f"{status} {body}",
            )
            status, body = _request(
                "GET", base_url + "/api/v1/does-not-exist", token=TOKEN
            )
            check(
                "未知路由返回 404 且错误体统一",
                status == 404
                and isinstance(body, dict)
                and body.get("ok") is False
                and body.get("code") == "NOT_FOUND",
                f"{status} {body}",
            )

            # ---- 11. 单实例锁：第二个进程必须被拒绝 ----
            # 故意换端口/日志目录，只共用锁文件，确保失败原因只能是单实例锁。
            second_env = env.copy()
            second_env["WECHAT_BRIDGE_PORT"] = str(_free_port())
            second_env["WECHAT_BRIDGE_LOG_DIR"] = str(temp_dir / "second-logs")
            second_log_path = temp_dir / "second.log"
            with open(second_log_path, "w", encoding="utf-8") as second_log:
                second = subprocess.Popen(
                    [sys.executable, "-m", "wechat_bridge"],
                    cwd=str(PACKAGE_ROOT),
                    env=second_env,
                    stdout=second_log,
                    stderr=subprocess.STDOUT,
                    creationflags=creationflags,
                )
                try:
                    second_rc = second.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    second.kill()
                    second.wait(timeout=5)
                    second_rc = -1
            second_text = _read_text(second_log_path)
            check(
                "第二个网桥进程被单实例锁拒绝",
                second_rc != 0 and "单实例锁" in second_text,
                f"exit={second_rc} log={second_text[-500:]}",
            )

            # ---- 12. 空 token：启动打印警告，但接口放行（仅本机调试） ----
            no_token_env = env.copy()
            no_token_env["WECHAT_BRIDGE_TOKEN"] = ""
            no_token_port = _free_port()
            no_token_base = f"http://127.0.0.1:{no_token_port}"
            no_token_env["WECHAT_BRIDGE_PORT"] = str(no_token_port)
            no_token_env["WECHAT_BRIDGE_LOCK_FILE"] = str(temp_dir / "no-token.lock")
            no_token_env["WECHAT_BRIDGE_LOG_DIR"] = str(temp_dir / "no-token-logs")
            no_token_log_path = temp_dir / "no-token.log"
            no_token_proc: subprocess.Popen | None = None
            try:
                with open(no_token_log_path, "w", encoding="utf-8") as no_token_log:
                    no_token_proc = subprocess.Popen(
                        [sys.executable, "-m", "wechat_bridge"],
                        cwd=str(PACKAGE_ROOT),
                        env=no_token_env,
                        stdout=no_token_log,
                        stderr=subprocess.STDOUT,
                        creationflags=creationflags,
                    )
                _wait_health(no_token_base, no_token_proc, no_token_log_path)
                status, body = _request(
                    "GET", no_token_base + "/api/v1/bot/status"
                )
                no_token_text = _read_text(no_token_log_path)
                check(
                    "WECHAT_BRIDGE_TOKEN 为空时启动警告但放行",
                    status == 200
                    and isinstance(body, dict)
                    and body.get("ok") is True
                    and "接口不鉴权" in no_token_text,
                    f"{status} {body} log={no_token_text[-500:]}",
                )
            finally:
                if no_token_proc is not None and no_token_proc.poll() is None:
                    no_token_proc.terminate()
                    try:
                        no_token_proc.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        no_token_proc.kill()
                        no_token_proc.wait(timeout=5)
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] 自检执行异常：{exc}")
        failures.append("自检执行异常")
        print("---- 服务日志尾部 ----")
        print(_read_log(log_path))
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        shutil.rmtree(temp_dir, ignore_errors=True)

    if failures:
        print(f"自检失败：{len(failures)}/{checks} 项未通过", file=sys.stderr)
        return 1
    print("SELFTEST OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())