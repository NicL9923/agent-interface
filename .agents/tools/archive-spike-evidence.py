#!/usr/bin/env python3
"""Archive successful disposable spike receipts without replacing prior evidence."""
import argparse
import hashlib
import json
import re
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", type=Path)
parser.add_argument("destination", type=Path)
parser.add_argument("--isolated-host-home", type=Path, help="Redact the disposable HOME used by staged qualification")
args = parser.parse_args()
if args.isolated_host_home and (not args.isolated_host_home.is_absolute() or len(args.isolated_host_home.parts) < 3):
    parser.error("The isolated host home must be a specific absolute directory")
names = ["app-probe.json", "hermes-environment.json", "hermes-extension-probe.json",
         "hermes-native-probe.json", "hermes-routine-probe.json",
         "hermes-maintenance-guard-probe.json", "hermes-integrations-probe.json"]
environment = json.loads((args.source / "hermes-environment.json").read_text())
service_name = "hermes-service-probe-upgrade-route-" + environment["revision"][:3] + ".json"
names.append(service_name)
for optional in ("hermes-managed-python-probe.json", "qualification-probe.json", "hermes-computer-probe.json", "hermes-experience-probe.json"):
    if (args.source / optional).is_file():
        names.append(optional)
receipts = {name: json.loads((args.source / name).read_text()) for name in names}
app = receipts["app-probe.json"]
environment = receipts["hermes-environment.json"]
guard = receipts["hermes-maintenance-guard-probe.json"]
if (environment.get("production_access") is not False
        or app.get("codeStateStable") is not True
        or app.get("sourceDigestStart") != app.get("sourceDigest")
        or app.get("hermesRevision") != environment.get("revision")
        or app.get("trackedPatchSha256") != environment.get("tracked_patch_sha256")
        or not app.get("checks") or any(check.get("passed") is not True for check in app["checks"].values())
        or not guard.get("checks") or any(value is not True for value in guard["checks"].values())):
    parser.error("Receipts must describe a stable successful disposable run of the same source.")
for name in ("hermes-integrations-probe.json", service_name, *(name for name in ("hermes-computer-probe.json", "hermes-experience-probe.json") if name in receipts)):
    checks = receipts[name].get("checks")
    if (receipts[name].get("revision") != environment.get("revision")
            or not checks or any(value is not True for value in checks.values())):
        parser.error("Integration, experience and service receipts must match the revision and contain successful checks: " + name)
if receipts[service_name].get("tracked_patch_sha256") != environment.get("tracked_patch_sha256"):
    parser.error("Service receipt must match the environment's tracked patch.")
def public_value(value, name):
    if isinstance(value, str):
        if args.isolated_host_home:
            value = value.replace(str(args.isolated_host_home), "<isolated-host-home>")
        if re.search(r"/(?:home|Users)/", value):
            parser.error("Unsanitized home path in " + name + "; provide --isolated-host-home for the disposable HOME")
        return value
    if isinstance(value, list):
        return [public_value(item, name) for item in value]
    if isinstance(value, dict):
        return {public_value(key, name): public_value(item, name) for key, item in value.items()}
    return value

files = {}
for name in names:
    public = public_value(receipts[name], name)
    files[name] = ((json.dumps(public, indent=2) + "\n").encode() if public != receipts[name]
                   else (args.source / name).read_bytes())
manifest = {"revision": environment["revision"], "trackedPatchSha256": environment["tracked_patch_sha256"],
            "appSourceDigest": app["sourceDigest"], "productionAccess": False,
            "files": {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}}
files["manifest.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
# Check every existing target before writing anything. Historical receipts must
# never quietly become evidence for a later run.
for name, data in files.items():
    path = args.destination / name
    if path.exists() and path.read_bytes() != data:
        parser.error("Destination already contains different evidence: " + name)
args.destination.mkdir(parents=True, exist_ok=True)
for name, data in files.items():
    path = args.destination / name
    if not path.exists():
        with path.open("xb") as output:
            output.write(data)
print(f"Archived {len(names)} receipts for {environment['revision']}.")
