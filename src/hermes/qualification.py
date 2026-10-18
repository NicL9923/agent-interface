"""Exact private qualification receipts shared by the updater and Hermes add-on."""
import argparse
import hashlib
import json
import os
import re
import stat
from pathlib import Path

# Shared with the app. Include the manifest itself so list changes invalidate receipts.
INTEGRATION_FILES = tuple(json.loads(
    (Path(__file__).resolve().parents[1] / "shared/qualification-inputs.json").read_text()))


def integration_digest(app_root):
    root = Path(app_root).resolve()
    rows = [name + "\0" + hashlib.sha256((root / name).read_bytes()).hexdigest()
            for name in sorted(INTEGRATION_FILES)]
    return hashlib.sha256("\n".join(rows).encode()).hexdigest()


def computer_probe_browser(requested):
    """Bind an explicitly selected host browser, never a launcher or discovered fallback."""
    if requested is None:
        return None
    if not isinstance(requested, str) or "\0" in requested or not Path(requested).is_absolute():
        raise ValueError("Computer probe browser must be an absolute host path")
    try:
        executable = Path(requested).resolve(strict=True)
        if not executable.is_file() or not os.access(executable, os.X_OK):
            raise ValueError("Computer probe browser must be an executable regular file")
        with executable.open("rb") as stream:
            if stream.read(4) != b"\x7fELF":
                raise ValueError("Use the browser's direct ELF executable, not a launcher script")
            stream.seek(0)
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
    except (OSError, RuntimeError) as error:
        raise ValueError("Computer probe browser path is unavailable: " + requested) from error
    return dict(requested=requested, executable=str(executable), sha256=digest)


def receipt_computer_probe_browser(receipt, *, rebind=False):
    """Validate optional receipt metadata; a new run permits a browser content update only.

    Keep receipt reads independent of the current host binary. A receipt attests a past
    run; the updater freshly binds its canonical executable for each new qualification.
    """
    if not isinstance(receipt, dict):
        raise ValueError("Qualification receipt must be an object.")
    if "computerProbeBrowser" not in receipt:
        return None
    descriptor = receipt["computerProbeBrowser"]
    if (not isinstance(descriptor, dict) or set(descriptor) != {"requested", "executable", "sha256"}
            or any(not isinstance(descriptor.get(key), str) or "\0" in descriptor[key]
                   or not Path(descriptor[key]).is_absolute() for key in ("requested", "executable"))
            or not isinstance(descriptor.get("sha256"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", descriptor["sha256"])):
        raise ValueError("Qualification receipt has malformed computer probe browser metadata")
    if not rebind:
        return descriptor
    current = computer_probe_browser(descriptor["requested"])
    if current["executable"] != descriptor["executable"]:
        raise ValueError("Computer probe browser resolved path changed since selection")
    return current


def computer_probe_environment(environment, descriptor):
    return {**environment, **({"HERMES_COMPUTER_PROBE_BROWSER": descriptor["executable"]} if descriptor else {})}


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
    receipt_computer_probe_browser(receipt)
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
