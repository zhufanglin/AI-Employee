#!/usr/bin/env python3
"""本地语音转写 CLI（faster-whisper CPU），供服务端 transcribe 能力调用。

用法：
  python transcribe_cli.py --input <音频/视频> --out <结果.json> [--model small] [--language zh]
输出 JSON：{"ok":true,"text":"...","segments":[{"start":0.0,"end":1.2,"text":"..."}],"durationSec":12.3,"model":"small","language":"zh","elapsedMs":1234}
失败时输出 {"ok":false,"error":"..."} 并且退出码非 0。
"""
import argparse
import json
import sys
import time


def emit(path, payload):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="small")
    ap.add_argument("--model-dir", default="/opt/fcmediaagent/asr/models")
    ap.add_argument("--language", default="zh")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--max-seconds", type=float, default=0.0)
    args = ap.parse_args()

    started = time.time()
    try:
        from faster_whisper import WhisperModel  # 延迟导入，失败时给出可读错误
    except Exception as exc:  # noqa: BLE001
        emit(args.out, {"ok": False, "error": "faster-whisper 未安装：%s" % exc})
        return 2

    try:
        model = WhisperModel(
            args.model,
            device="cpu",
            compute_type="int8",
            download_root=args.model_dir,
            cpu_threads=max(1, args.threads),
        )
        lang = None if args.language in ("", "auto", "None") else args.language
        segments, info = model.transcribe(
            args.input,
            language=lang,
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
            without_timestamps=False,
        )
        items = []
        for seg in segments:
            text = (seg.text or "").strip()
            if not text:
                continue
            items.append({"start": round(float(seg.start), 2), "end": round(float(seg.end), 2), "text": text})
    except Exception as exc:  # noqa: BLE001
        emit(args.out, {"ok": False, "error": "转写失败：%s" % exc})
        return 3

    joiner = "" if (lang or "").startswith("zh") else " "
    full_text = joiner.join(x["text"] for x in items).strip()
    duration = float(getattr(info, "duration", 0.0) or 0.0)
    emit(args.out, {
        "ok": True,
        "text": full_text,
        "segments": items,
        "durationSec": round(duration, 2),
        "model": args.model,
        "language": (getattr(info, "language", None) or lang or "auto"),
        "elapsedMs": int((time.time() - started) * 1000),
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
