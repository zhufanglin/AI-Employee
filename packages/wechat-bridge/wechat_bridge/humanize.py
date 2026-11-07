"""拟人化发送：随机停顿 + 长文本分段。

只影响真实模式的实际发送节奏；Mock 模式为保持自检速度不做真实等待。
"""

from __future__ import annotations

import random
import time

# 优先在这些字符后断开，避免把一句话切得莫名其妙。
_BREAK_CHARS = "。！？!?；;\n，,、"


def split_text(text: str, limit: int = 120) -> list[str]:
    """把长文本切成不超过 limit 字符的分段，尽量在标点处断开。"""
    if limit <= 0 or len(text) <= limit:
        return [text]
    segments: list[str] = []
    start = 0
    total = len(text)
    while start < total:
        end = min(start + limit, total)
        if end < total:
            floor = start + max(1, limit // 2)
            cut = -1
            for index in range(end, floor - 1, -1):
                if text[index - 1] in _BREAK_CHARS:
                    cut = index
                    break
            if cut > start:
                end = cut
        piece = text[start:end].strip()
        if piece:
            segments.append(piece)
        start = end
    return segments or [text]


def random_pause(min_s: float, max_s: float, rng: random.Random | None = None) -> float:
    """返回本次拟人化停顿秒数，并真正 sleep。"""
    generator = rng or random
    low = max(0.0, min(min_s, max_s))
    high = max(0.0, max(min_s, max_s))
    seconds = generator.uniform(low, high) if high > low else low
    if seconds > 0:
        time.sleep(seconds)
    return seconds
