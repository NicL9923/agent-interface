"""Exact private qualification receipts shared by the updater and Hermes add-on."""
import argparse
import hashlib
import json
import os
import re
import stat
from pathlib import Path

INTEGRATION_FILES = (
    "src/shared/collaboration.ts", "src/server/collaboration.ts",
  "src/shared/discovery.ts", "src/server/discovery.ts",
    "src/hermes/vault.py", "src/server/vault.ts", "src/shared/vault.ts", "scripts/spike/vault_probe.py",
    "src/hermes/experience.py", "src/hermes/extension.py", "src/hermes/service_auth.py",
    "src/hermes/dashboard.py", "src/hermes/qualification.py", "src/hermes/gateway_guard.py", "src/hermes/integrations.py", "src/hermes/computer.py", "src/hermes/computer_host.py",
    "src/server/store.ts", "src/server/experience.ts", "src/server/voice.ts", "src/server/hermes.ts", "src/server/hermes-qualification.ts", "src/server/integrations.ts",
    "src/server/app.ts", "src/server/config.ts", "src/server/upgrades.ts", "src/server/computer.ts", "src/server/terminal.ts", "src/server/terminal-host.py",
    "src/shared/experience.ts", "src/shared/reply-cards.ts", "src/shared/routine-presets.ts", "src/shared/voice.ts", "src/shared/types.ts", "src/shared/upgrades.ts", "src/shared/integrations.ts", "src/shared/computer.ts",
    "scripts/spike/run.py", "scripts/spike/probe.py",
    "scripts/spike/extension_probe.py", "scripts/spike/routine_probe.py",
    "scripts/spike/app-probe.mjs", "scripts/spike/requirements.lock.txt",
    "scripts/spike/provider.py",
    "scripts/spike/maintenance_guard_probe.py",
    "scripts/spike/service_probe.py",
    "scripts/spike/experience_probe.py", "scripts/spike/integrations_probe.py",
    "scripts/spike/computer_probe.py",
    "scripts/spike/computer_acceptance.py",
    "scripts/hermes-upgrade-worker.py", "scripts/hermes-upgrade-linux.py", "scripts/hermes-qualified-python.py",
    "package-lock.json",
)


def integration_digest(app_root):
    root = Path(app_root).resolve()
    rows = [name + "\0" + hashlib.sha256((root / name).read_bytes()).hexdigest()
            for name in sorted(INTEGRATION_FILES)]
    return hashlib.sha256("\n".join(rows).encode()).hexdigest()


def read_receipt(path, app_root):
    path = Path(path)
    if not path.is_absolute() or path.is_symlink():
        raise ValueError("Qualification receipt must be a private absolute file.")
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 8192:
        raise ValueError("Qualification receipt must be owner-only and owned by this runtime.")
    receipt = json.loads(path.read_text())
    if not isinstance(receipt, dict):
        raise ValueError("Qualification receipt must be an object.")
    checks = receipt.get("checks")
    if (receipt.get("schemaVersion") != 1
            or not re.fullmatch(r"[0-9a-f]{40}", str(receipt.get("revision", "")))
            or receipt.get("trackedPatchSha256") is not None
            and not re.fullmatch(r"[0-9a-f]{64}", str(receipt.get("trackedPatchSha256")))
            or receipt.get("integrationDigest") != integration_digest(app_root)
            or not isinstance(checks, dict) or set(checks) != {"realIntegration", "hostRegressions"}
            or checks.get("realIntegration") is not True or checks.get("hostRegressions") is not True
            or not isinstance(receipt.get("qualifiedAt"), str)):
        raise ValueError("Qualification receipt does not match the tested integration.")
    return receipt


def provisional_revision():
    """Permit a probe-only candidate, never a normal supervised dashboard."""
    revision = os.environ.get("HERMES_AGENT_INTERFACE_QUALIFICATION_REVISION", "")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        return None
    home = Path(os.environ.get("HERMES_HOME", ""))
    marker = home / ".agent-interface-isolated"
    if (not home.is_absolute() or os.environ.get("HERMES_SERVE_HEADLESS") != "1"
            or not marker.is_file() or marker.read_text() != "agent-interface-disposable-spike"):
        raise ValueError("Provisional qualification requires a marked disposable headless home.")
    return revision


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--digest", type=Path, required=True)
    print(integration_digest(parser.parse_args().digest))
