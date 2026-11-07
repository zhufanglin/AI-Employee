"""Minimal Windows WeChat coordinate/visual bridge.

The current WeChat MMUI renderer does not expose standard UIA controls. This
bridge therefore requires a visible, logged-in main window and verifies that
the window geometry is stable before sending. It never claims contact/message
read support until a selector or OCR strategy is configured.
"""
import ctypes
import hashlib
import os
import time
from ctypes import wintypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
import json

try:
    from PIL import ImageGrab
except Exception:
    ImageGrab = None

user32 = ctypes.windll.user32
try:
    user32.SetProcessDPIAware()
except Exception:
    pass
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
VK_RETURN = 0x0D
KEYEVENTF_UNICODE = 0x0004
KEYEVENTF_KEYUP = 0x0002


def window_handle():
    return user32.FindWindowW(None, "微信")


def window_rect(hwnd):
    rect = wintypes.RECT()
    if not hwnd or not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return None
    return {"left": rect.left, "top": rect.top, "right": rect.right, "bottom": rect.bottom,
            "width": rect.right - rect.left, "height": rect.bottom - rect.top}


def snapshot(rect):
    if not ImageGrab or not rect:
        return None
    # Hash the composer and latest-message area only; clocks and side-list badges
    # elsewhere in the window may animate without a send having occurred.
    left = rect["left"] + int(rect["width"] * 0.15)
    top = rect["top"] + int(rect["height"] * 0.62)
    right = rect["right"] - 8
    bottom = rect["bottom"] - 8
    image = ImageGrab.grab((left, top, right, bottom)).convert("RGB")
    pixels = list(image.getdata())
    mean = sum((r + g + b) / 3 for r, g, b in pixels) / max(1, len(pixels))
    green = sum(1 for r, g, b in pixels if g > 90 and g > r * 1.2 and g > b * 1.1)
    return {"hash": hashlib.sha256(image.tobytes()).hexdigest(), "mean": mean, "green": green}


def send_unicode(text):
    for char in text:
        code = ord(char)
        user32.keybd_event(0, 0, KEYEVENTF_UNICODE, code)
        user32.keybd_event(0, 0, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, code)


def send_current_chat(name, message):
    if name != os.getenv("WECHAT_UIA_CURRENT_CHAT", ""):
        raise ValueError("WECHAT_UIA_TARGET_NOT_VERIFIED")
    hwnd = window_handle()
    rect = window_rect(hwnd)
    if not rect or rect["width"] < 700 or rect["height"] < 500:
        raise ValueError("WECHAT_UIA_WINDOW_NOT_READY")
    if os.getenv("WECHAT_UIA_ALLOW_UNVERIFIED_CURRENT_CHAT", "false").lower() != "true":
        raise ValueError("WECHAT_UIA_TARGET_NOT_VERIFIED")
    user32.ShowWindowAsync(hwnd, 9)
    user32.SetForegroundWindow(hwnd)
    before = snapshot(rect)
    if not before or before["mean"] > 80:
        raise ValueError("WECHAT_UIA_CHAT_COMPOSER_NOT_VISIBLE")
    # Current WeChat layout: composer is in the lower 18% and right 85%.
    x = rect["left"] + int(rect["width"] * 0.58)
    y = rect["top"] + int(rect["height"] * 0.86)
    user32.SetCursorPos(x, y)
    user32.mouse_event(2, 0, 0, 0, 0)
    user32.mouse_event(4, 0, 0, 0, 0)
    send_unicode(message)
    user32.keybd_event(VK_RETURN, 0, 0, 0)
    user32.keybd_event(VK_RETURN, 0, KEYEVENTF_KEYUP, 0)
    time.sleep(0.5)
    after = snapshot(rect)
    verified = bool(after and after["green"] > before["green"] + 500)
    if not verified:
        # The Enter key has already been sent. Never report a retryable failure:
        # the caller must inspect the chat manually before attempting again.
        return {"success": False, "verified": False, "sent_unknown": True, "error": "WECHAT_UIA_MESSAGE_BUBBLE_NOT_VERIFIED", "window": rect}
    return {"success": True, "verified": True, "sent_unknown": False, "window": rect}


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, body):
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/v1/bot/status":
            hwnd = window_handle(); rect = window_rect(hwnd)
            self.send_json(200, {"success": True, "data": {"running": bool(hwnd), "window": rect, "mode": "coordinate_visual"}, "error": None})
        elif path == "/api/v1/memory/list":
            self.send_json(200, {"success": False, "data": None, "error": "联系人读取尚未配置安全选择器", "error_code": "CONTACT_SELECTOR_UNAVAILABLE"})
        else:
            self.send_json(404, {"success": False, "data": None, "error": "Not found"})

    def do_POST(self):
        length = int(self.headers.get("content-length", "0")); body = self.rfile.read(length) if length else b"{}"
        try: payload = json.loads(body.decode("utf-8"))
        except Exception: payload = {}
        path = urlparse(self.path).path
        if path == "/api/v1/chat/send":
            try: self.send_json(200, {"success": True, "data": send_current_chat(payload.get("name"), payload.get("msg")), "error": None})
            except ValueError as exc: self.send_json(409, {"success": False, "data": None, "error": str(exc), "error_code": str(exc)})
        else:
            self.send_json(501, {"success": False, "data": None, "error": "当前 bridge 尚未实现该动作", "error_code": "NOT_IMPLEMENTED"})

    def log_message(self, *_args):
        return


if __name__ == "__main__":
    port = int(os.getenv("WECHAT_UIA_PORT", "18990"))
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
