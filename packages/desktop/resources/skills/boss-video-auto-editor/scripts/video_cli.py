#!/usr/bin/env python3
"""Safe FFmpeg adapter for boss-video-auto-editor.

Uses only the Python standard library. It never overwrites existing outputs.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path


def command_path(name: str) -> str | None:
    return shutil.which(name)


def parse_time(value: object) -> float:
    if isinstance(value, (int, float)):
        seconds = float(value)
    else:
        text = str(value).strip()
        if re.fullmatch(r"\d+(?:\.\d+)?", text):
            seconds = float(text)
        else:
            parts = text.split(":")
            if len(parts) not in (2, 3):
                raise ValueError(f"无法识别时间：{value}")
            nums = [float(part) for part in parts]
            if len(nums) == 2:
                seconds = nums[0] * 60 + nums[1]
            else:
                seconds = nums[0] * 3600 + nums[1] * 60 + nums[2]
    if seconds < 0:
        raise ValueError("时间不能为负数")
    return seconds


def safe_name(value: str, index: int) -> str:
    name = Path(value).name
    stem = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff._-]+", "-", Path(name).stem).strip("-._")
    return f"{stem or f'clip-{index:02d}'}.mp4"


def run(cmd: list[str], dry_run: bool = False) -> None:
    if dry_run:
        print(json.dumps({"command": cmd}, ensure_ascii=False))
        return
    subprocess.run(cmd, check=True)


def check_dependencies(_: argparse.Namespace) -> int:
    found = {name: command_path(name) for name in ("ffmpeg", "ffprobe", "whisper", "auto-editor")}
    result = {
        "ready_for_render": bool(found["ffmpeg"] and found["ffprobe"]),
        "ready_for_transcription": bool(found["whisper"]),
        "ready_for_auto_cut": bool(found["auto-editor"]),
        "commands": found,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def ensure_input(path_text: str) -> Path:
    path = Path(path_text).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"输入文件不存在：{path}")
    return path


def probe(args: argparse.Namespace) -> int:
    ffprobe = command_path("ffprobe")
    if not ffprobe:
        raise RuntimeError("未找到ffprobe，请先按references/cli-setup.md配置")
    source = ensure_input(args.input)
    cmd = [ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(source)]
    completed = subprocess.run(cmd, check=True, capture_output=True, text=True)
    print(completed.stdout)
    return 0


def video_filter(fmt: str, subtitles: str | None) -> str | None:
    filters: list[str] = []
    if fmt == "vertical":
        filters.append("scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black")
    elif fmt == "horizontal":
        filters.append("scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black")
    if subtitles:
        subtitle_path = str(Path(subtitles).expanduser().resolve())
        if not Path(subtitle_path).is_file():
            raise FileNotFoundError(f"字幕文件不存在：{subtitle_path}")
        escaped = subtitle_path.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
        filters.append(f"subtitles='{escaped}'")
    return ",".join(filters) if filters else None


def render_segments(args: argparse.Namespace) -> int:
    ffmpeg = command_path("ffmpeg") or ("ffmpeg" if args.dry_run else None)
    if not ffmpeg:
        raise RuntimeError("未找到ffmpeg，请先按references/cli-setup.md配置")
    source = ensure_input(args.input)
    segment_file = ensure_input(args.segments)
    segments = json.loads(segment_file.read_text(encoding="utf-8"))
    if not isinstance(segments, list) or not segments:
        raise ValueError("segments.json必须是非空数组")

    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    vf = video_filter(args.format, args.subtitles)
    manifest: list[dict[str, object]] = []

    for index, segment in enumerate(segments, start=1):
        if not isinstance(segment, dict):
            raise ValueError(f"第{index}个片段不是对象")
        start = parse_time(segment.get("start", 0))
        end = parse_time(segment.get("end"))
        if end <= start:
            raise ValueError(f"第{index}个片段结束时间必须晚于开始时间")
        output_name = safe_name(str(segment.get("output") or segment.get("title") or ""), index)
        output = output_dir / output_name
        if output.exists():
            raise FileExistsError(f"拒绝覆盖已有文件：{output}")
        cmd = [
            ffmpeg, "-n", "-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", str(source),
        ]
        if vf:
            cmd.extend(["-vf", vf])
        cmd.extend([
            "-c:v", "libx264", "-preset", args.preset, "-crf", str(args.crf),
            "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(output),
        ])
        run(cmd, args.dry_run)
        manifest.append({
            "index": index,
            "title": segment.get("title", ""),
            "start": start,
            "end": end,
            "duration": round(end - start, 3),
            "output": str(output),
            "rendered": not args.dry_run,
        })

    manifest_path = output_dir / "render-manifest.json"
    if manifest_path.exists() and not args.dry_run:
        raise FileExistsError(f"拒绝覆盖已有清单：{manifest_path}")
    if not args.dry_run:
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"clips": manifest, "manifest": str(manifest_path)}, ensure_ascii=False, indent=2))
    return 0


def transcribe(args: argparse.Namespace) -> int:
    whisper = command_path("whisper") or ("whisper" if args.dry_run else None)
    if not whisper:
        raise RuntimeError("未找到whisper，请先按references/cli-setup.md配置")
    source = ensure_input(args.input)
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    cmd = [whisper, str(source), "--model", args.model, "--language", args.language, "--output_dir", str(output_dir), "--output_format", "all"]
    run(cmd, args.dry_run)
    return 0


def auto_cut(args: argparse.Namespace) -> int:
    auto_editor = command_path("auto-editor") or ("auto-editor" if args.dry_run else None)
    if not auto_editor:
        raise RuntimeError("未找到auto-editor，请先按references/cli-setup.md配置")
    source = ensure_input(args.input)
    output = Path(args.output).expanduser().resolve()
    if output.exists():
        raise FileExistsError(f"拒绝覆盖已有文件：{output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    cmd = [auto_editor, str(source), "--margin", args.margin, "--output", str(output)]
    run(cmd, args.dry_run)
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="老板AI短视频剪辑CLI适配器")
    sub = root.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check")
    check.set_defaults(func=check_dependencies)

    inspect = sub.add_parser("probe")
    inspect.add_argument("--input", required=True)
    inspect.set_defaults(func=probe)

    render = sub.add_parser("render-segments")
    render.add_argument("--input", required=True)
    render.add_argument("--segments", required=True)
    render.add_argument("--output-dir", required=True)
    render.add_argument("--format", choices=("original", "vertical", "horizontal"), default="vertical")
    render.add_argument("--subtitles")
    render.add_argument("--preset", default="medium")
    render.add_argument("--crf", type=int, default=21)
    render.add_argument("--dry-run", action="store_true")
    render.set_defaults(func=render_segments)

    speech = sub.add_parser("transcribe")
    speech.add_argument("--input", required=True)
    speech.add_argument("--output-dir", required=True)
    speech.add_argument("--model", default="small")
    speech.add_argument("--language", default="zh")
    speech.add_argument("--dry-run", action="store_true")
    speech.set_defaults(func=transcribe)

    cut = sub.add_parser("auto-cut")
    cut.add_argument("--input", required=True)
    cut.add_argument("--output", required=True)
    cut.add_argument("--margin", default="0.2sec")
    cut.add_argument("--dry-run", action="store_true")
    cut.set_defaults(func=auto_cut)
    return root


def main() -> int:
    try:
        args = parser().parse_args()
        return int(args.func(args))
    except (FileNotFoundError, FileExistsError, ValueError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
