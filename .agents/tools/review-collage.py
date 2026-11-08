#!/usr/bin/env python3
"""Combine labeled screenshots without cropping. Requires Pillow 10.1 or newer."""
import argparse
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", type=Path)
parser.add_argument("panels", nargs="+", help="Label=path to each screenshot")
parser.add_argument("--height", type=int, default=720)
args = parser.parse_args()
if args.height < 100:
    parser.error("Panel height must be at least 100 pixels")
label_size = max(16, round(args.height / 75))
label_font = ImageFont.load_default(size=label_size)
header_height = max(44, label_size + 20)
panels = []
for item in args.panels:
    label, separator, path = item.partition("=")
    if not separator:
        parser.error("Each panel needs Label=path")
    with Image.open(path) as original:
        width = round(original.width * args.height / original.height)
        panels.append((label, original.convert("RGB").resize(
            (width, args.height), Image.Resampling.LANCZOS)))
canvas = Image.new("RGB", (sum(im.width for _, im in panels) + 16 * (len(panels) + 1), args.height + header_height + 16), "#eeeeee")
draw = ImageDraw.Draw(canvas)
x = 16
for label, panel in panels:
    draw.text((x, 10), label, font=label_font, fill="#222222")
    canvas.paste(panel, (x, header_height))
    x += panel.width + 16
args.output.parent.mkdir(parents=True, exist_ok=True)
canvas.save(args.output)
