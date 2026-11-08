#!/usr/bin/env python3
"""Render numbered pointers and matching before/after notes from a JSON specification."""
import argparse
import json
import math
from pathlib import Path
import textwrap
from PIL import Image, ImageDraw, ImageFont


def font(size, bold=False):
    candidates = [
        '/System/Library/Fonts/Supplemental/Arial Bold.ttf' if bold else '/System/Library/Fonts/Supplemental/Arial.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ]
    for candidate in candidates:
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default(size=size)


def render(spec, output):
    panels = []
    for side, color in [('before', '#A33C32'), ('after', '#246F59')]:
        info = spec[side]
        shot = Image.open(info['image']).convert('RGB')
        width = shot.width
        scale = max(1, width / 900)
        size = round(18 * scale)
        pad = round(24 * scale)
        title_font = font(round(24 * scale), True)
        title_lines = []
        line = ''
        for word in f"{side.capitalize()}  |  {spec['title']}".split():
            candidate = f'{line} {word}'.strip()
            if line and title_font.getlength(candidate) > width - 2 * pad:
                title_lines.append(line)
                line = word
            else:
                line = candidate
        title_lines.append(line)
        title_spacing = round(6 * scale)
        header = max(round(72 * scale), 2 * pad + len(title_lines) * (title_font.size + title_spacing))
        legend = []
        chars = max(30, int((width - 2 * pad) / (size * .54)))
        for number, note in enumerate(info['notes'], 1):
            legend.extend(textwrap.wrap(f"{number}. {note['text']}", chars))
            legend.append('')
        panel = Image.new('RGB', (width, header + shot.height + pad + (size + 8) * len(legend)), '#FFFFFF')
        panel.paste(shot, (0, header))
        draw = ImageDraw.Draw(panel)
        draw.text((pad, round(16 * scale)), '\n'.join(title_lines), font=title_font, spacing=title_spacing, fill='#202A24')
        for number, note in enumerate(info['notes'], 1):
            x, y = note['point'] if 'point' in note else (note['fraction'][0] * width, note['fraction'][1] * shot.height)
            y += header
            dx, dy = note.get('offset', [30 * scale, -26 * scale])
            cx, cy = x + dx, y + dy
            radius = round(13 * scale)
            draw.line((cx, cy, x, y), fill=color, width=round(3 * scale))
            angle = math.atan2(cy - y, cx - x)
            arrow = 8 * scale
            draw.polygon([(x, y), (x + arrow * math.cos(angle + .5), y + arrow * math.sin(angle + .5)), (x + arrow * math.cos(angle - .5), y + arrow * math.sin(angle - .5))], fill=color)
            draw.ellipse((cx-radius, cy-radius, cx+radius, cy+radius), fill=color, outline='#FFFFFF', width=round(2 * scale))
            draw.text((cx, cy), str(number), font=font(round(15 * scale), True), fill='#FFFFFF', anchor='mm')
        draw.text((pad, header + shot.height + pad), '\n'.join(legend), font=font(size), fill='#202A24', spacing=8)
        panels.append(panel)
    gap = 24
    canvas = Image.new('RGB', (sum(p.width for p in panels) + gap, max(p.height for p in panels)), '#EBEEE9')
    x = 0
    for panel in panels:
        canvas.paste(panel, (x, 0))
        x += panel.width + gap
    canvas.save(output, optimize=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('spec', type=Path)
    parser.add_argument('output', type=Path, nargs='?')
    parser.add_argument('--batch', action='store_true', help='Render an explicit manifest of relative spec/output paths')
    args = parser.parse_args()
    if args.batch:
        if args.output is not None:
            parser.error('A batch manifest supplies its output paths')
        root = args.spec.resolve().parent
        rows = json.loads(args.spec.read_text())
        if not isinstance(rows, list) or not rows:
            parser.error('A batch manifest must contain a nonempty list')
        jobs = []
        for row in rows:
            source, output = ((root / row[key]).resolve() for key in ('spec', 'output'))
            if not source.is_relative_to(root) or not output.is_relative_to(root):
                parser.error('Batch paths must stay inside the manifest directory')
            spec = json.loads(source.read_text())
            for side in ('before', 'after'):
                if not Path(spec[side]['image']).is_file():
                    parser.error(f"Missing {side} image in {source}")
            jobs.append((spec, output))
    else:
        if args.output is None:
            parser.error('Supply an output image, or use --batch')
        jobs = [(json.loads(args.spec.read_text()), args.output)]
    for spec, output in jobs:
        output.parent.mkdir(parents=True, exist_ok=True)
        render(spec, output)


if __name__ == '__main__':
    main()
