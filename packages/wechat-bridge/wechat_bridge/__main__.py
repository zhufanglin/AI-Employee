"""命令行入口：python -m wechat_bridge [--mock] [--port 18990]。"""

from __future__ import annotations

import argparse
import os
import sys


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m wechat_bridge",
        description="FCMediaAgent 个人微信固定窗口环境本地网桥（FastAPI）",
    )
    parser.add_argument("--host", help="监听地址，默认读 WECHAT_BRIDGE_HOST（127.0.0.1）")
    parser.add_argument("--port", type=int, help="监听端口，默认读 WECHAT_BRIDGE_PORT（18990）")
    parser.add_argument(
        "--mock", action="store_true", help="强制 Mock 模式（等价 WECHAT_BRIDGE_MOCK=1）"
    )
    parser.add_argument(
        "--log-level",
        default=os.getenv("WECHAT_BRIDGE_LOG_LEVEL", "info"),
        choices=["critical", "error", "warning", "info", "debug", "trace"],
        help="uvicorn 日志级别",
    )
    parser.add_argument("--access-log", action="store_true", help="打印每个 HTTP 请求")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.mock:
        os.environ["WECHAT_BRIDGE_MOCK"] = "1"
    if args.host:
        os.environ["WECHAT_BRIDGE_HOST"] = args.host
    if args.port:
        os.environ["WECHAT_BRIDGE_PORT"] = str(args.port)

    from .config import Settings
    from .app import create_app

    settings = Settings.from_env()
    app = create_app(settings)
    try:
        import uvicorn
    except Exception as exc:  # noqa: BLE001
        print(f"缺少 uvicorn：{exc}。请先 pip install -r requirements-mock.txt", file=sys.stderr)
        return 1

    print(
        f"[wechat-bridge] 启动：http://{settings.host}:{settings.port} "
        f"mock={settings.mock} token={'已启用' if settings.token else '空(调试放行)'}",
        flush=True,
    )
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        log_level=args.log_level,
        access_log=args.access_log or settings.access_log,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
