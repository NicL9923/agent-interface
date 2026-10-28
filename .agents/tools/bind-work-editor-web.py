#!/usr/bin/env python3
"""Bind Work editor web images to a passing, released capture run. Requires Pillow."""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
from PIL import Image


def bind(receipt_path: Path, report_path: Path, count: int = 16) -> dict:
    receipt = json.loads(receipt_path.read_text())
    runs = receipt.get('runs', [])
    if (receipt.get('status') != 0 or not receipt.get('withinDeadline')
            or receipt.get('cleanup', {}).get('exitCode') != 0
            or receipt.get('previewExitCode') is None
            or receipt.get('previewPort3044Closed') is not True
            or receipt.get('lockProbe') != 'free' or receipt.get('lockInode') != 17430620
            or not receipt.get('verifiedReleaseObservedAt')
            or [run.get('name') for run in runs] != ['build', 'capture']
            or any(run.get('exitCode') != 0 for run in runs)):
        raise ValueError('A passing build/capture and verified scoped release are required.')
    start = datetime.fromisoformat(receipt['admittedAt']).timestamp()
    end = datetime.fromisoformat(receipt['releasedObservedAt']).timestamp()
    verified = datetime.fromisoformat(receipt['verifiedReleaseObservedAt']).timestamp()
    if not start <= end <= verified <= receipt['cleanupDeadline']:
        raise ValueError('Release and scoped verification must finish within the original deadline.')
    report = json.loads(report_path.read_text())
    paths, geometry = report['paths'], report['geometry']
    resolved_paths = [Path(path).resolve() for path in paths]
    if (report.get('taskGate') != 'b' or report.get('workCase') != 'tasks'
            or report.get('browserErrors') != [] or len(paths) != count
            or len(geometry) != count or len(set(resolved_paths)) != count):
        raise ValueError('A complete, clean gate-b report with unique paths is required.')
    folder = report_path.with_suffix('').resolve()
    if {p.resolve() for p in folder.glob('*.png')} != set(resolved_paths):
        raise ValueError('The report must name exactly the PNGs in its own output folder.')
    shots = []
    for image, row in zip(resolved_paths, geometry, strict=True):
        if image.parent.resolve() != folder or image.stem != 'web-work-' + row['name']:
            raise ValueError('A screenshot name or folder does not match its geometry.')
        if not start <= image.stat().st_mtime <= end:
            raise ValueError('A screenshot falls outside the admitted run window.')
        if row['overflow'] or any(row['editorOverflow'].values()):
            raise ValueError('Editor overflow must be absent.')
        landing = row.get('editorLanding')
        if landing and not (landing['focused'] and landing['fullyVisible']):
            raise ValueError('A result landing must have visible focus.')
        with Image.open(image) as pixels:
            dimensions = list(pixels.size)
        if dimensions != [row['width'], row['height']]:
            raise ValueError('Screenshot dimensions do not match the report.')
        shots.append({'path': str(image), 'sha256': hashlib.sha256(image.read_bytes()).hexdigest(),
                      'mtime': image.stat().st_mtime, 'dimensions': dimensions, 'geometry': row})
    return {'source': receipt['source'], 'fixtureSHA256': receipt['fixtureSHA256'],
            'receipt': str(receipt_path), 'report': str(report_path), 'screenshots': shots,
            'freshCount': count, 'uniqueImageHashes': len({shot['sha256'] for shot in shots}),
            'bindingToolSHA256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'browserErrors': [], 'overflow': False, 'accepted': False, 'score': None,
            'manualInspection': 'Pending',
            'disclosure': '200% is root font scaling, not browser zoom. Native evidence is separate.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('receipt', type=Path)
    parser.add_argument('report', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    result = bind(args.receipt.resolve(), args.report.resolve())
    with args.output.open('x') as output:
        json.dump(result, output, indent=2)
        output.write('\n')
    print(f"Bound {result['freshCount']} editor images. Visual review pending.")


if __name__ == '__main__':
    main()
