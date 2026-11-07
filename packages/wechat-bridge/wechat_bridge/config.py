"""运行配置：全部来自环境变量，便于计划任务 / nssm 注入。"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

APP_NAME = "fcmediaagent-wechat-bridge"


def _env_bool(name: str, default: bool = False) -> bool:
    """解析 1/true/yes/on 这类布尔环境变量。"""
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int, minimum: int = 0) -> int:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(minimum, value)


def _env_float(name: str, default: float, minimum: float = 0.0) -> float:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return max(minimum, value)


def _env_choice(name: str, default: str, choices: set[str]) -> str:
    """解析枚举型环境变量；非法值回退默认值。"""
    raw = os.getenv(name, "").strip().lower()
    return raw if raw in choices else default


def default_data_dir() -> Path:
    """默认运行数据目录：Windows 用 LOCALAPPDATA，其它平台回退到用户目录。"""
    base = os.getenv("LOCALAPPDATA") or os.getenv("XDG_DATA_HOME")
    if base:
        return Path(base) / "FCMediaAgent" / "wechat-bridge"
    return Path.home() / ".fcmediaagent-wechat-bridge"


@dataclass(frozen=True)
class Settings:
    """一次进程生命周期内不可变的配置快照。"""

    mock: bool
    token: str
    host: str
    port: int
    lock_file: Path
    log_dir: Path
    ui_timeout_s: float
    ui_retry: int
    humanize_min_s: float
    humanize_max_s: float
    listen_poll_s: float
    max_messages: int
    idempotency_window_s: float
    request_timeout_s: float
    access_log: bool = False
    # 真实模式后端：auto（自动探测，优先 wechatauto）
    # wechatauto（wechatauto-replica，GUI+OCR，微信 4.1.x）/ wxauto4（纯 UIA，微信 ≤4.1.8.107）/ wxauto（微信 3.9.x）
    backend: str = "auto"

    @classmethod
    def from_env(cls) -> "Settings":
        data_dir = default_data_dir()
        lock_file = Path(os.getenv("WECHAT_BRIDGE_LOCK_FILE") or (data_dir / "bridge.lock"))
        log_dir = Path(os.getenv("WECHAT_BRIDGE_LOG_DIR") or (data_dir / "logs"))
        humanize_min = _env_float("WECHAT_BRIDGE_HUMANIZE_MIN", 0.3)
        humanize_max = _env_float("WECHAT_BRIDGE_HUMANIZE_MAX", 1.2)
        if humanize_max < humanize_min:
            humanize_min, humanize_max = humanize_max, humanize_min
        return cls(
            mock=_env_bool("WECHAT_BRIDGE_MOCK", False),
            token=os.getenv("WECHAT_BRIDGE_TOKEN", "").strip(),
            host=os.getenv("WECHAT_BRIDGE_HOST", "127.0.0.1").strip() or "127.0.0.1",
            port=_env_int("WECHAT_BRIDGE_PORT", 18990, minimum=1),
            lock_file=lock_file,
            log_dir=log_dir,
            ui_timeout_s=_env_float("WECHAT_BRIDGE_UI_TIMEOUT", 30.0, minimum=1.0),
            ui_retry=_env_int("WECHAT_BRIDGE_UI_RETRY", 2, minimum=0),
            humanize_min_s=humanize_min,
            humanize_max_s=humanize_max,
            listen_poll_s=_env_float("WECHAT_BRIDGE_LISTEN_POLL", 2.0, minimum=0.5),
            max_messages=_env_int("WECHAT_BRIDGE_MAX_MESSAGES", 200, minimum=1),
            idempotency_window_s=_env_float("WECHAT_BRIDGE_IDEMPOTENCY_WINDOW", 5.0, minimum=0.0),
            request_timeout_s=_env_float("WECHAT_BRIDGE_REQUEST_TIMEOUT", 30.0, minimum=1.0),
            access_log=_env_bool("WECHAT_BRIDGE_ACCESS_LOG", False),
            backend=_env_choice(
                "WECHAT_BRIDGE_BACKEND",
                "auto",
                {"auto", "wechatauto", "wxauto4", "wxauto"},
            ),
        )

    def describe(self) -> str:
        """启动日志用的一行摘要（不输出 token 明文）。"""
        token_state = "已启用" if self.token else "空（本地调试放行）"
        return (
            f"mock={self.mock} host={self.host} port={self.port} "
            f"token={token_state} lock={self.lock_file} logs={self.log_dir} "
            f"backend={self.backend}"
        )
