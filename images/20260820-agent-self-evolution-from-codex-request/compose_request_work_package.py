#!/usr/bin/env python3
"""图 01 的确定性排版层：背景只提供纹理，所有结构、连线与中文由本文件控制。

预防规则：
- 先画连线，再画节点，线不可能盖住文字；
- 所有节点使用固定网格与安全边距；
- 标签以 textbbox 测量，超出盒宽立即 fail；
- 连线经过预先分配的通道，运行时校验不得穿过任一节点。
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw, ImageFont

W, H = 1536, 1024
FONT_BOLD = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
FONT_REG = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
SC_INDEX = 2

NAVY = (15, 29, 47, 232)
PANEL = (16, 36, 59, 218)
TEXT = (241, 247, 252, 255)
MUTED = (191, 211, 226, 255)
BLUE = (86, 166, 245, 255)
AMBER = (245, 184, 91, 255)
CYAN = (67, 211, 203, 255)
GREEN = (117, 204, 140, 255)
WHITE = (255, 255, 255, 255)

# 内容盒的坐标来自 12 列网格；所有连线只能走节点之间的空白通道。
BOXES = {
    "task": (72, 250, 390, 380),
    "rules": (72, 444, 390, 574),
    "tools": (72, 638, 390, 768),
    "history": (72, 832, 390, 962),
    "package": (560, 352, 930, 680),
    "model": (1088, 352, 1402, 548),
    "execute": (1088, 720, 1402, 890),
}


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size, index=SC_INDEX)


def inset(box: tuple[int, int, int, int], n: int) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = box
    return x0 + n, y0 + n, x1 - n, y1 - n


def center(box: tuple[int, int, int, int]) -> tuple[int, int]:
    x0, y0, x1, y1 = box
    return (x0 + x1) // 2, (y0 + y1) // 2


def text_fits(draw: ImageDraw.ImageDraw, text: str, f: ImageFont.FreeTypeFont,
              box: tuple[int, int, int, int], pad_x: int = 16, pad_y: int = 6) -> None:
    left, top, right, bottom = draw.textbbox((0, 0), text, font=f)
    width, height = right - left, bottom - top
    x0, y0, x1, y1 = box
    if width + 2 * pad_x > x1 - x0 or height + 2 * pad_y > y1 - y0:
        raise ValueError(f"label does not fit: {text!r} in {box}")


def segment_hits_box(a: tuple[int, int], b: tuple[int, int], box: tuple[int, int, int, int]) -> bool:
    """轴对齐连线与矩形严格相交才返回真；端点接触不算穿越。"""
    x0, y0, x1, y1 = box
    ax, ay = a
    bx, by = b
    if ax == bx:
        return x0 < ax < x1 and max(min(ay, by), y0) < min(max(ay, by), y1)
    if ay == by:
        return y0 < ay < y1 and max(min(ax, bx), x0) < min(max(ax, bx), x1)
    raise ValueError("only orthogonal segments are allowed")


def route_is_clear(points: list[tuple[int, int]], allowed: Iterable[str] = ()) -> None:
    allowed_boxes = {BOXES[name] for name in allowed}
    for a, b in zip(points, points[1:]):
        for box in BOXES.values():
            if box not in allowed_boxes and segment_hits_box(a, b, box):
                raise ValueError(f"route {points} intersects protected box {box}")


def arrow(draw: ImageDraw.ImageDraw, points: list[tuple[int, int]], color: tuple[int, int, int, int], width: int = 6) -> None:
    route_is_clear(points)
    draw.line(points, fill=color, width=width, joint="curve")
    (x0, y0), (x1, y1) = points[-2], points[-1]
    angle = math.atan2(y1 - y0, x1 - x0)
    length = 15
    p1 = (x1 + length * math.cos(angle + math.radians(150)), y1 + length * math.sin(angle + math.radians(150)))
    p2 = (x1 + length * math.cos(angle - math.radians(150)), y1 + length * math.sin(angle - math.radians(150)))
    draw.polygon([(x1, y1), p1, p2], fill=color)


def panel(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], color: tuple[int, int, int, int]) -> None:
    draw.rounded_rectangle(box, radius=24, fill=PANEL, outline=color, width=3)
    draw.rounded_rectangle(inset(box, 10), radius=17, outline=(255, 255, 255, 38), width=1)


def label(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], text: str,
          f: ImageFont.FreeTypeFont, color: tuple[int, int, int, int]) -> None:
    text_fits(draw, text, f, box)
    x, y = center(box)
    draw.text((x, y), text, font=f, fill=TEXT, anchor="mm", stroke_width=1, stroke_fill=(5, 12, 22, 220))
    # 颜色短线是语义提示，不是箭头，也不干扰标签扫描。
    draw.rounded_rectangle((x - 38, y + 31, x + 38, y + 35), radius=2, fill=color)


def source_icon(draw: ImageDraw.ImageDraw, cx: int, cy: int, kind: str, color: tuple[int, int, int, int]) -> None:
    """每类来源使用一个简单可辨识的、无文字矢量图标。"""
    if kind == "task":
        draw.ellipse((cx - 23, cy - 23, cx + 23, cy + 23), outline=color, width=4)
        draw.ellipse((cx - 5, cy - 5, cx + 5, cy + 5), fill=color)
    elif kind == "rules":
        draw.rounded_rectangle((cx - 25, cy - 20, cx + 25, cy + 20), radius=8, outline=color, width=4)
        draw.line((cx - 12, cy, cx - 3, cy + 10, cx + 15, cy - 12), fill=color, width=4)
    elif kind == "tools":
        draw.line((cx - 22, cy + 20, cx + 18, cy - 20), fill=color, width=6)
        draw.ellipse((cx + 10, cy - 28, cx + 30, cy - 8), outline=color, width=5)
    elif kind == "history":
        draw.arc((cx - 26, cy - 26, cx + 26, cy + 26), start=40, end=325, fill=color, width=5)
        draw.polygon([(cx - 27, cy - 11), (cx - 5, cy - 15), (cx - 18, cy + 3)], fill=color)


def compose(background: Path, output: Path, guides: bool) -> None:
    base = Image.open(background).convert("RGB").resize((W, H), Image.Resampling.LANCZOS)
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer, "RGBA")
    f_title = font(FONT_BOLD, 46)
    f_label = font(FONT_BOLD, 26)
    f_small = font(FONT_REG, 18)

    # 保证所有文字都有同一暗底，不依赖模型恰好留下空白。
    d.rectangle((0, 0, W, H), fill=(4, 13, 24, 86))
    d.rounded_rectangle((52, 42, 1484, 174), radius=28, fill=NAVY, outline=(107, 162, 205, 180), width=2)
    d.text((768, 92), "一轮请求，模型看到了什么？", font=f_title, fill=WHITE, anchor="mm")
    d.text((768, 142), "消息、规则、工具与结果按轮组装；工具结果回流为下一轮事实", font=f_small, fill=MUTED, anchor="mm")

    # 连线始终在面板前绘制，避免线条盖住标签；每根线均有独立竖向通道。
    package = BOXES["package"]
    input_ports = [(package[0], 404), (package[0], 468), (package[0], 532), (package[0], 596)]
    for key, port, color in zip(("task", "rules", "tools", "history"), input_ports, (BLUE, AMBER, CYAN, GREEN)):
        src = BOXES[key]
        y = center(src)[1]
        arrow(d, [(src[2], y), (470, y), (470, port[1]), port], color, width=5)
    arrow(d, [(package[2], 516), (1018, 516), (1018, 450), (BOXES["model"][0], 450)], BLUE, width=7)
    arrow(d, [(center(BOXES["model"])[0], BOXES["model"][3]), (1245, 650), (1245, BOXES["execute"][1])], CYAN, width=7)
    # 反馈路径走底部通道，终点允许贴到 history 面板边缘。
    feedback = [(center(BOXES["execute"])[0], BOXES["execute"][3]), (1245, 946), (454, 946), (454, center(BOXES["history"])[1]), (BOXES["history"][2], center(BOXES["history"])[1])]
    route_is_clear(feedback, allowed=("execute", "history"))
    d.line(feedback, fill=GREEN, width=7, joint="curve")
    d.polygon([(BOXES["history"][2], center(BOXES["history"])[1]), (BOXES["history"][2] - 17, center(BOXES["history"])[1] - 10), (BOXES["history"][2] - 17, center(BOXES["history"])[1] + 10)], fill=GREEN)

    for key, color in (("task", BLUE), ("rules", AMBER), ("tools", CYAN), ("history", GREEN)):
        panel(d, BOXES[key], color)
        x0, y0, x1, y1 = BOXES[key]
        source_icon(d, x0 + 62, (y0 + y1) // 2, key, color)
    panel(d, BOXES["package"], BLUE)
    panel(d, BOXES["model"], (126, 152, 236, 255))
    panel(d, BOXES["execute"], CYAN)

    # 中心胶囊的五层薄片，固定间距，不使用 AI 绘制的虚构框线。
    for i, alpha in enumerate((70, 85, 100, 85, 70)):
        x0, y0, x1, y1 = inset(BOXES["package"], 42 + i * 8)
        d.rounded_rectangle((x0, y0 + i * 12, x1, y1 + i * 12), radius=18, outline=(124, 203, 255, alpha), width=2)
    # 模型棱镜与执行闸门是边界符号，精确位置由 overlay 控制。
    mx, my = center(BOXES["model"])
    d.polygon([(mx, my - 46), (mx + 48, my), (mx, my + 46), (mx - 48, my)], outline=(160, 182, 255, 255), fill=(60, 86, 154, 100), width=3)
    d.rounded_rectangle((1193, 658, 1297, 690), radius=8, fill=(10, 39, 47, 235), outline=CYAN, width=3)
    for x in (1216, 1245, 1274):
        d.line((x, 665, x, 683), fill=CYAN, width=2)

    label(d, (164, 268, 352, 320), "当前任务", f_label, BLUE)
    label(d, (164, 462, 352, 514), "稳定约束", f_label, AMBER)
    label(d, (164, 656, 352, 708), "工具与边界", f_label, CYAN)
    label(d, (164, 850, 352, 902), "历史与结果", f_label, GREEN)
    label(d, (606, 475, 884, 535), "本轮工作包", f_label, BLUE)
    label(d, (1130, 378, 1360, 430), "模型推理", f_label, (126, 152, 236, 255))
    label(d, (1130, 746, 1360, 798), "受控执行", f_label, CYAN)
    d.text((768, 988), "机制示意：执行结果更新状态，再进入下一轮工作包", font=f_small, fill=MUTED, anchor="mm")

    if guides:
        gd = ImageDraw.Draw(layer, "RGBA")
        for box in BOXES.values():
            gd.rectangle(box, outline=(255, 0, 255, 180), width=1)
        for x in range(0, W + 1, 128):
            gd.line((x, 0, x, H), fill=(255, 0, 255, 55), width=1)

    Image.alpha_composite(base.convert("RGBA"), layer).convert("RGB").save(output)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bg", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--guides", action="store_true")
    args = parser.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    compose(args.bg, args.out, args.guides)
    print(f"saved: {args.out}")


if __name__ == "__main__":
    main()
