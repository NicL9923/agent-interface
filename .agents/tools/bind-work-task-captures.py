#!/usr/bin/env python3
"""Bind passed W2a native PNGs to a released run. No runtime or device operations."""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path


def bind(receipt_path: Path, repo: Path) -> dict:
    receipt = json.loads(receipt_path.read_text())
    if (receipt.get('cleanup', {}).get('errors') != []
            or receipt.get('ownedXcodebuildProcesses') != []
            or not receipt.get('verifiedReleaseObservedAt')
            or not receipt.get('withinDeadline')
            or not receipt.get('verificationWithinDeadline')
            or receipt.get('lockProbe') != 'free'
            or receipt.get('childExitCode') is None
            or not receipt.get('verifiedOwnedDevices')
            or any(device['state'] != 'Shutdown' for device in receipt['verifiedOwnedDevices'])
            or receipt.get('sourceChangedDuringRun')):
        raise ValueError('A clean verified release and unchanged source are required.')
    start = datetime.fromisoformat(receipt['admittedAt']).timestamp()
    end = datetime.fromisoformat(receipt['releasedObservedAt']).timestamp()
    root = receipt_path.parent
    shots, excluded = [], []
    for run in receipt['runs']:
        validation = run.get('validation')
        if run.get('returncode') != 0 or not validation:
            excluded.append({'variant': run['variants'], 'reason': 'No passing validation'})
            continue
        names = validation['screenshots']
        if not names:
            continue
        summary = Path(validation['summary'])
        if not summary.is_absolute():
            summary = repo / summary
        lines = summary.read_text().splitlines()
        result = json.loads(next(line for line in reversed(lines) if line.startswith('{')))
        if (result.get('result') != 'Passed' or result.get('passedTests') != 1
                or result.get('failedTests') != 0 or result.get('skippedTests') != 0
                or 'ios inputs: ' + receipt['source'] not in lines):
            raise ValueError('The XCTest summary does not prove this source passed without skips.')
        marker = f"DESIGN_WORK_W2A_AFTER_VARIANT {run['variants']} complete"
        if marker not in Path(run['log']).read_text():
            raise ValueError('Missing completed AFTER variant marker.')
        device = {'iphone': 'ios', 'ipad': 'ipad'}[run['device']]
        folder = root / ('work-native-' + run['phase'] + '-captures') / 'after' / device
        if {p.stem for p in folder.glob('task-*.png')} != set(names):
            raise ValueError('Actual PNG names differ from the validated variant.')
        for name in names:
            path = folder / (name + '.png')
            stamp = path.stat().st_mtime
            if not start <= stamp <= end:
                raise ValueError('A PNG timestamp falls outside the admitted run.')
            shots.append({'name': name, 'path': str(path),
                          'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                          'mtime': stamp, 'summary': str(summary), 'variant': run['variants']})
    if not shots:
        raise ValueError('No passed screenshot variants to bind.')
    return {'source': receipt['source'], 'fixtureSHA256': receipt['workFixtureSHA256'],
            'bindingToolSHA256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'receipt': str(receipt_path), 'screenshots': shots, 'freshCount': len(shots),
            'uniqueImageCount': len({shot['sha256'] for shot in shots}),
            'excludedRuns': excluded, 'manualInspection': 'Pending',
            'rootAdditions': 'Inspection notes, collage paths and scope may be appended after binding; original proof fields must remain unchanged.',
            'accepted': False, 'score': None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('receipt', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    result = bind(args.receipt.resolve(), Path(__file__).resolve().parents[2])
    with args.output.open('x') as output:
        json.dump(result, output, indent=2)
        output.write('\n')
    print(f"Bound {result['freshCount']} PNG records, {result['uniqueImageCount']} unique images. Visual review pending.")


if __name__ == '__main__':
    main()
