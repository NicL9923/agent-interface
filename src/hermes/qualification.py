"""Exact private qualification receipts shared by the updater and Hermes add-on."""

import argparse
import hashlib
import json
import os
import re
import shlex
import stat
import subprocess
from pathlib import Path

# Shared with the app. Include the manifest itself so list changes invalidate receipts.
INTEGRATION_FILES = tuple(
    json.loads(
        (
            Path(__file__).resolve().parents[1] / "shared/qualification-inputs.json"
        ).read_text()
    )
)

# The live Hermes checkout is a promisor partial clone. On the host's git 2.43, repacking it
# dropped objects that promisor objects link to, on Oct 14 and again on Nov 9, 2026. Any fetch,
# a lazy one included, can start that repack through automatic gc or maintenance. These local
# settings turn both off: (key, type git normalizes the value to, required value).
CLONE_PROTECTION = (("gc.auto", "int", "0"), ("maintenance.auto", "bool", "false"))
# Git reads that can neither fetch a missing object nor take an optional lock.
OFFLINE_GIT = {
    "GIT_NO_LAZY_FETCH": "1",
    "GIT_OPTIONAL_LOCKS": "0",
    "GIT_TERMINAL_PROMPT": "0",
}
LIVE_CHECKOUT_DOCS = 'docs/HermesUpgradeLinux.md, "Live checkout objects"'


def protect_clone(source, environment):
    """Turn off automatic gc and maintenance in this checkout's own configuration."""
    for key, _, value in CLONE_PROTECTION:
        subprocess.run(
            ["git", "-C", str(source), "config", "--local", key, value],
            env={**environment, **OFFLINE_GIT},
            capture_output=True,
            check=True,
            timeout=60,
        )


def live_clone_refusals(source, environment):
    """Why qualification must not start from this live checkout; empty when it may.

    Read-only, and it walks no history: one listing of HEAD's tree with lazy fetch and
    optional locks off. git 2.43 prints a missing tree or blob as a `?` line here and exits 0,
    unlike an object lookup, which dies in a promisor clone when lazy fetch is off.
    """
    environment = {**environment, **OFFLINE_GIT}

    def read(*args):
        return subprocess.run(
            ["git", "-C", str(source), *args],
            env=environment,
            capture_output=True,
            text=True,
            check=False,
            timeout=600,
        )

    refusals = []
    if any(
        read("config", "--local", "--type=" + kind, "--get", key).stdout.strip()
        != value
        for key, kind, value in CLONE_PROTECTION
    ):
        # The leading newline ends a last line that has none, which would otherwise swallow `[gc]`.
        fix = (
            "printf '\\n[gc]\\n\\tauto = 0\\n[maintenance]\\n\\tauto = false\\n' >> "
            + shlex.quote(str(Path(source) / ".git/config"))
        )
        refusals.append(
            f"The live Hermes checkout {source} allows automatic gc or maintenance, and a repack "
            f"drops objects from this promisor clone. Turn both off, without running git there: {fix}"
        )
    listing = read("rev-list", "--objects", "--missing=print", "--no-walk", "HEAD")
    if listing.returncode:
        refusals.append(
            f"Could not list HEAD's objects in the live Hermes checkout {source}: "
            f"{listing.stderr.strip()[-300:]}. See {LIVE_CHECKOUT_DOCS}."
        )
    elif missing := sum(line.startswith("?") for line in listing.stdout.splitlines()):
        refusals.append(
            f"The live Hermes checkout {source} lacks {missing} object(s) of HEAD's tree, at least: a missing "
            f"tree hides the objects under it. Restore them before qualifying, as {LIVE_CHECKOUT_DOCS} describes."
        )
    return refusals


def integration_digest(app_root):
    root = Path(app_root).resolve()
    rows = [
        name + "\0" + hashlib.sha256((root / name).read_bytes()).hexdigest()
        for name in sorted(INTEGRATION_FILES)
    ]
    return hashlib.sha256("\n".join(rows).encode()).hexdigest()


def computer_probe_browser(requested):
    """Bind an explicitly selected host browser, never a launcher or discovered fallback."""
    if requested is None:
        return None
    if (
        not isinstance(requested, str)
        or "\0" in requested
        or not Path(requested).is_absolute()
    ):
        raise ValueError("Computer probe browser must be an absolute host path")
    try:
        executable = Path(requested).resolve(strict=True)
        if not executable.is_file() or not os.access(executable, os.X_OK):
            raise ValueError(
                "Computer probe browser must be an executable regular file"
            )
        with executable.open("rb") as stream:
            if stream.read(4) != b"\x7fELF":
                raise ValueError(
                    "Use the browser's direct ELF executable, not a launcher script"
                )
            stream.seek(0)
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
    except (OSError, RuntimeError) as error:
        raise ValueError(
            "Computer probe browser path is unavailable: " + requested
        ) from error
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
    if (
        not isinstance(descriptor, dict)
        or set(descriptor) != {"requested", "executable", "sha256"}
        or any(
            not isinstance(descriptor.get(key), str)
            or "\0" in descriptor[key]
            or not Path(descriptor[key]).is_absolute()
            for key in ("requested", "executable")
        )
        or not isinstance(descriptor.get("sha256"), str)
        or not re.fullmatch(r"[0-9a-f]{64}", descriptor["sha256"])
    ):
        raise ValueError(
            "Qualification receipt has malformed computer probe browser metadata"
        )
    if not rebind:
        return descriptor
    current = computer_probe_browser(descriptor["requested"])
    if current["executable"] != descriptor["executable"]:
        raise ValueError("Computer probe browser resolved path changed since selection")
    return current


def computer_probe_environment(environment, descriptor):
    return {
        **environment,
        **(
            {"HERMES_COMPUTER_PROBE_BROWSER": descriptor["executable"]}
            if descriptor
            else {}
        ),
    }


def read_receipt(path, app_root):
    path = Path(path)
    if not path.is_absolute() or path.is_symlink():
        raise ValueError("Qualification receipt must be a private absolute file.")
    # Not private_fs.owner_private: tools run this file from other release trees with runpy.
    info = path.stat()
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
        or info.st_size > 8192
    ):
        raise ValueError(
            "Qualification receipt must be owner-only and owned by this runtime."
        )
    receipt = json.loads(path.read_text())
    if not isinstance(receipt, dict):
        raise ValueError("Qualification receipt must be an object.")
    receipt_computer_probe_browser(receipt)
    checks = receipt.get("checks")
    if (
        receipt.get("schemaVersion") != 1
        or not re.fullmatch(r"[0-9a-f]{40}", str(receipt.get("revision", "")))
        or receipt.get("trackedPatchSha256") is not None
        and not re.fullmatch(r"[0-9a-f]{64}", str(receipt.get("trackedPatchSha256")))
        or receipt.get("integrationDigest") != integration_digest(app_root)
        or not isinstance(checks, dict)
        or set(checks) != {"realIntegration", "hostRegressions"}
        or checks.get("realIntegration") is not True
        or checks.get("hostRegressions") is not True
        or not isinstance(receipt.get("qualifiedAt"), str)
    ):
        raise ValueError("Qualification receipt does not match the tested integration.")
    return receipt


def provisional_revision():
    """Permit a probe-only candidate, never a normal supervised dashboard."""
    revision = os.environ.get("HERMES_AGENT_INTERFACE_QUALIFICATION_REVISION", "")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        return None
    home = Path(os.environ.get("HERMES_HOME", ""))
    marker = home / ".agent-interface-isolated"
    if (
        not home.is_absolute()
        or os.environ.get("HERMES_SERVE_HEADLESS") != "1"
        or not marker.is_file()
        or marker.read_text() != "agent-interface-disposable-spike"
    ):
        raise ValueError(
            "Provisional qualification requires a marked disposable headless home."
        )
    return revision


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--digest", type=Path, required=True)
    print(integration_digest(parser.parse_args().digest))
