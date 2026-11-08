#!/bin/bash
# Print the UDID of the newest-runtime iPhone simulator on a CI image; both iOS CI jobs use it.
set -euo pipefail
xcrun simctl list devices available --json | python3 -c '
import json, sys
devices = json.load(sys.stdin)["devices"]
version = lambda runtime: [int(part) for part in runtime.rsplit("iOS-", 1)[1].split("-")]
runtimes = sorted((runtime for runtime in devices if ".iOS-" in runtime), key=version, reverse=True)
print(next(device["udid"] for runtime in runtimes for device in devices[runtime] if device["name"].startswith("iPhone")))
'
