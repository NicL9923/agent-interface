#!/usr/bin/env python3
"""Hash native design captures and require each image to belong to its passing run."""
import argparse
import hashlib
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="Existing screenshot artifact root")
    parser.add_argument("stage", choices=["before", "after"])
    parser.add_argument("prefix", help="Screenshot filename prefix")
    parser.add_argument("--run", nargs=2, action="append", required=True, metavar=("FOLDER", "RECEIPT"))
    parser.add_argument("--count", type=int, required=True, help="Exact expected screenshot count per run")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if Path(args.prefix).name != args.prefix or any(c in args.prefix for c in "*?[]"):
        parser.error("Prefix must be a literal filename prefix")
    evidence = {}
    for folder, receipt in args.run:
        if Path(folder).name != folder or folder in {".", ".."} or folder in evidence:
            parser.error("Run folders must be unique basenames")
        summary = Path(receipt).resolve()
        lines = summary.read_text().splitlines()
        if "exit status: 0" not in lines:
            parser.error(f"Run did not exit successfully: {summary}")
        result = json.loads(next(line for line in reversed(lines) if line.startswith("{")))
        if result["result"] != "Passed" or result["failedTests"] or result["skippedTests"]:
            parser.error(f"Run did not pass without skips: {summary}")
        fingerprint = next(line.removeprefix("ios inputs: ") for line in lines if line.startswith("ios inputs: "))
        shots = []
        for image in sorted((args.root / args.stage / folder).glob(f"{args.prefix}*.png")):
            modified = image.stat().st_mtime
            if not result["startTime"] <= modified <= result["finishTime"]:
                parser.error(f"Screenshot is outside its run window: {image}")
            shots.append({"path": str(image.resolve()), "mtime": modified,
                          "sha256": hashlib.sha256(image.read_bytes()).hexdigest()})
        if len(shots) != args.count:
            parser.error(f"Expected {args.count} images for {folder}, found {len(shots)}")
        evidence[folder] = {"summary": str(summary), "result": result,
                            "fingerprint": fingerprint, "screenshots": shots}
    encoded = json.dumps(evidence, indent=2) + "\n"
    # A failed validation leaves the previous evidence intact.
    args.output.write_text(encoded)
    print(json.dumps({folder: len(row["screenshots"]) for folder, row in evidence.items()}))


if __name__ == "__main__":
    main()
