#!/usr/bin/env python3
"""Minimal guarded WeChat Official Account API adapter."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


API_ROOT = "https://api.weixin.qq.com"


def emit(data: object) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2))


def credentials() -> tuple[str, str]:
    app_id = os.environ.get("WECHAT_APP_ID", "").strip()
    app_secret = os.environ.get("WECHAT_APP_SECRET", "").strip()
    if not app_id or not app_secret:
        raise RuntimeError("未配置WECHAT_APP_ID或WECHAT_APP_SECRET")
    return app_id, app_secret


def get_json(url: str) -> dict:
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {body}") from exc


def post_json(url: str, payload: dict) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json; charset=utf-8"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {error_body}") from exc
    if result.get("errcode") not in (None, 0):
        raise RuntimeError(f"微信接口错误：{json.dumps(result, ensure_ascii=False)}")
    return result


def access_token() -> str:
    app_id, app_secret = credentials()
    query = urllib.parse.urlencode({"grant_type": "client_credential", "appid": app_id, "secret": app_secret})
    result = get_json(f"{API_ROOT}/cgi-bin/token?{query}")
    if result.get("errcode") not in (None, 0) or not result.get("access_token"):
        raise RuntimeError(f"获取access_token失败：{json.dumps(result, ensure_ascii=False)}")
    return str(result["access_token"])


def check(_: argparse.Namespace) -> int:
    app_id = bool(os.environ.get("WECHAT_APP_ID", "").strip())
    app_secret = bool(os.environ.get("WECHAT_APP_SECRET", "").strip())
    emit({
        "ready_for_api": app_id and app_secret,
        "WECHAT_APP_ID": "configured" if app_id else "missing",
        "WECHAT_APP_SECRET": "configured" if app_secret else "missing",
        "next": "还需在公众号后台确认IP白名单和草稿/发布接口权限",
    })
    return 0


def token(_: argparse.Namespace) -> int:
    value = access_token()
    emit({"ok": True, "access_token_received": True, "preview": value[:6] + "..."})
    return 0


def load_article(path_text: str) -> tuple[dict, dict]:
    path = Path(path_text).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"article.json不存在：{path}")
    spec = json.loads(path.read_text(encoding="utf-8"))
    html_path = Path(str(spec.get("content_html_file", ""))).expanduser().resolve()
    if not html_path.is_file():
        raise FileNotFoundError(f"正文HTML不存在：{html_path}")
    required = ("title", "thumb_media_id")
    missing = [key for key in required if not str(spec.get(key, "")).strip()]
    if missing:
        raise ValueError("article.json缺少字段：" + ", ".join(missing))
    article = {
        "title": str(spec["title"]).strip(),
        "author": str(spec.get("author", "")).strip(),
        "digest": str(spec.get("digest", "")).strip(),
        "content": html_path.read_text(encoding="utf-8"),
        "content_source_url": str(spec.get("content_source_url", "")).strip(),
        "thumb_media_id": str(spec["thumb_media_id"]).strip(),
        "need_open_comment": int(spec.get("need_open_comment", 0)),
        "only_fans_can_comment": int(spec.get("only_fans_can_comment", 0)),
    }
    return spec, article


def draft(args: argparse.Namespace) -> int:
    spec, article = load_article(args.article)
    preview = {
        "action": "create_draft",
        "title": article["title"],
        "author": article["author"],
        "digest": article["digest"],
        "content_html_file": spec.get("content_html_file"),
        "thumb_media_id": article["thumb_media_id"],
    }
    if args.confirm != "DRAFT":
        emit({"ok": False, "confirmation_required": True, "preview": preview, "next": "确认后增加 --confirm DRAFT"})
        return 2
    token_value = access_token()
    result = post_json(f"{API_ROOT}/cgi-bin/draft/add?access_token={urllib.parse.quote(token_value)}", {"articles": [article]})
    emit({"ok": True, "action": "draft_created", "result": result})
    return 0


def publish(args: argparse.Namespace) -> int:
    if args.confirm != "PUBLISH":
        emit({"ok": False, "confirmation_required": True, "media_id": args.media_id, "next": "确认后增加 --confirm PUBLISH"})
        return 2
    token_value = access_token()
    result = post_json(
        f"{API_ROOT}/cgi-bin/freepublish/submit?access_token={urllib.parse.quote(token_value)}",
        {"media_id": args.media_id},
    )
    emit({"ok": True, "action": "publish_submitted", "result": result})
    return 0


def status(args: argparse.Namespace) -> int:
    token_value = access_token()
    result = post_json(
        f"{API_ROOT}/cgi-bin/freepublish/get?access_token={urllib.parse.quote(token_value)}",
        {"publish_id": args.publish_id},
    )
    emit({"ok": True, "action": "publish_status", "result": result})
    return 0


def build_parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="公众号草稿与发布CLI适配器")
    sub = root.add_subparsers(dest="command", required=True)
    p_check = sub.add_parser("check")
    p_check.set_defaults(func=check)
    p_token = sub.add_parser("token")
    p_token.set_defaults(func=token)
    p_draft = sub.add_parser("draft")
    p_draft.add_argument("--article", required=True)
    p_draft.add_argument("--confirm")
    p_draft.set_defaults(func=draft)
    p_publish = sub.add_parser("publish")
    p_publish.add_argument("--media-id", required=True)
    p_publish.add_argument("--confirm")
    p_publish.set_defaults(func=publish)
    p_status = sub.add_parser("status")
    p_status.add_argument("--publish-id", required=True)
    p_status.set_defaults(func=status)
    return root


def main() -> int:
    try:
        args = build_parser().parse_args()
        return int(args.func(args))
    except (FileNotFoundError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        emit({"ok": False, "error": str(exc)})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
