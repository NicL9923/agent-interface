#!/bin/bash
# Print the UDID of the newest-runtime iPhone simulator on a CI image; both iOS CI jobs use it.
set -euo pipefail
xcrun simctl list devices available --json | node -e '
const fs = require("node:fs");
const devices = JSON.parse(fs.readFileSync(0, "utf8")).devices;
const version = (runtime) => runtime.split("iOS-").pop().split("-").map(Number);
const cmp = (a, b) => {
  const va = version(a), vb = version(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const diff = (vb[i] || 0) - (va[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
};
const runtimes = Object.keys(devices).filter((r) => r.includes(".iOS-")).sort(cmp);
for (const runtime of runtimes) {
  const device = devices[runtime].find((d) => d.name.startsWith("iPhone"));
  if (device) { console.log(device.udid); process.exit(0); }
}
process.exit(1);
'
