#!/usr/bin/env python3
"""Qualify a staged app release in disposable native homes, without cutover.

Uses the installed source and approved repair, a separate PM generation and the
installer's private shared-OAuth/Google fixtures. Prints only receipt metadata.
Run before release-app.py prepare --qualification when integration inputs change.

Each run leaves about 3 GB of disposable checkout and runtime. The run removes its
own when it ends, and earlier stages that were interrupted more than a day ago,
keeping receipts, logs and native probe evidence.
"""
import argparse
import importlib.util
import json
from pathlib import Path

PRUNE = r'''
import time
STALE_STAGE_SECONDS = 24 * 3600


def remove_tree(path):
    # Native caches can contain read-only directories; restore owner access first.
    for root, directories, _ in os.walk(path):
        for name in directories:
            child = os.path.join(root, name)
            if not os.path.islink(child):
                os.chmod(child, 0o700)
    shutil.rmtree(path)


def prune_stage(stage):
    """Remove a finished stage's disposable checkout and runtime.

    Keeps the receipt, step logs, PM logs and probe scratch evidence that
    archive-app-qualification.py reads. Returns False when removal failed.
    """
    marker = stage / ".agent-interface-upgrade-stage"
    try:
        disposable = [stage / "source"]
        pm_home = stage / "pm-home"
        if pm_home.is_dir() and not pm_home.is_symlink():
            for child in pm_home.iterdir():
                if child.name == "cache" and child.is_dir() and not child.is_symlink():
                    disposable += [item for item in child.iterdir() if item.name != "scratch"]
                elif child.name != "logs":
                    disposable.append(child)
        for path in disposable:
            if path.is_symlink() or path.is_file():
                path.unlink()
            elif path.is_dir():
                remove_tree(path)
        state = json.loads(marker.read_text())
        marker.write_text(json.dumps({**state, "state": "completed"}))
        return True
    except OSError as error:
        print(f"Could not prune {stage}: {error}", file=sys.stderr)
        return False


def sweep_stale_stages(operations, now):
    """Prune earlier qualification stages whose run ended without cleanup."""
    for marker in operations.glob("*/qualification-*/.agent-interface-upgrade-stage"):
        stage = marker.parent
        if stage.is_symlink() or stage.parent.is_symlink():
            continue
        try:
            state = json.loads(marker.read_text()).get("state")
        except (OSError, ValueError):
            continue
        if state == "active" and now - marker.stat().st_mtime > STALE_STAGE_SECONDS:
            prune_stage(stage)
'''

REMOTE = PRUNE + r'''
import datetime, importlib.util, stat, types, uuid
base = Path(PAYLOAD["appBase"])
release = Path(PAYLOAD["release"])
ops = Path(PAYLOAD["operationDir"])
assert release.parent == base / "releases" and ops.parent == base / "operations"
assert release.is_dir() and not release.is_symlink()
assert sha(ops / "release.tar.gz") == PAYLOAD["archiveSha256"]
# Probes call `node` by name from the runtime's directory, so it must be the runtime the stage
# recorded and no other. Checked before anything is staged.
node_path = str(Path(PAYLOAD["node"]).parent) + ":" + os.environ.get("PATH", "/usr/bin:/bin")
assert os.path.realpath(shutil.which("node", path=node_path) or "") == os.path.realpath(PAYLOAD["node"]), "node on the qualification PATH is not " + PAYLOAD["node"]
assert os.path.realpath(PAYLOAD["node"]) == PAYLOAD.get("nodeRealpath", os.path.realpath(PAYLOAD["node"])), PAYLOAD["node"] + " is no longer the runtime the release was built with"
sweep_stale_stages(base / "operations", time.time())
worker_path = base / "shared/hermes-worker.json"
worker = json.loads(worker_path.read_text())
live, home = Path(worker["source"]), Path(worker["managedHome"])
python, launcher = Path(worker["qualificationPython"]), Path(worker["managedLauncher"])
patch = Path(worker["approvedPatchFile"])
private = base / "shared/upgrade-private"
runner = private / "regressions.py"
assert all(p.is_absolute() for p in [live, home, python, launcher, patch])
assert sha(patch) == worker["requiredPatchSha256"]

def snapshot(path):
    revision = subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()
    diff = subprocess.check_output(["git", "-c", "core.abbrev=10", "-C", str(path), "diff", "HEAD", "--binary"])
    return revision, hashlib.sha256(diff).hexdigest()

baseline = snapshot(live)
assert baseline[0] == PAYLOAD["hermesRevision"]
# An upstream update can change diff headers while preserving the exact approved
# repaired tree. Reuse the installer's provenance check, then reconstruct that
# tree in the disposable checkout and compare its actual revision/diff below.
repair_worker = runpy.run_path(str(release / "scripts/hermes-upgrade-worker.py"))
repair_owner = types.SimpleNamespace(config=worker, source=live, environment=dict(os.environ))
repair_worker["Worker"].approved_repair(repair_owner, baseline[0], baseline[1],
    subprocess.check_output(["git", "-c", "core.abbrev=10", "-C", str(live), "diff", "HEAD", "--binary"]))
browser_facts = home / "tools/facts.json"
browser = repair_worker["native_chromium"](home)
qualification = runpy.run_path(str(release / "src/hermes/qualification.py"))

def live_probe_browser(path):
    """The live receipt's browser selection, bound afresh. The receipt picks an executable this
    program runs, so it must be the runtime's own private file, read without following a link,
    and a requested path that now resolves elsewhere is refused, as the in-app updater does."""
    path = Path(path)
    if not path.is_absolute():
        raise ValueError("Live qualification receipt must be an absolute path: " + str(path))
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as error:
        raise ValueError("Live qualification receipt is missing or a link: " + str(path)) from error
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 8192:
            raise ValueError("Live qualification receipt must be owner-only and owned by this runtime")
        receipt = json.loads(stream.read())
    return qualification["receipt_computer_probe_browser"](receipt, rebind=True)


requested_probe_browser = PAYLOAD.get("computerProbeBrowser")
if requested_probe_browser is None and PAYLOAD.get("inheritComputerProbeBrowser"):
    # A host whose PM Chromium cannot sandbox keeps the browser its last qualification passed
    # with (Nov 9, 2026: a release qualified without the flag failed the local-network probe).
    # Use the descriptor rebind validated; resolving `requested` again could bind a retargeted link.
    probe_browser = live_probe_browser(PAYLOAD["liveQualificationReceipt"])
    requested_probe_browser = probe_browser and probe_browser["requested"]
else:
    probe_browser = qualification["computer_probe_browser"](requested_probe_browser)
host_files = {p: sha(p) for p in {str(worker_path), str(runner), str(browser_facts), str(browser), *worker["qualificationFiles"]}}
if probe_browser:
    host_files[probe_browser["executable"]] = probe_browser["sha256"]
digest = qualification["integration_digest"](release)
operation = str(uuid.uuid4())
stage = ops / ("qualification-" + operation)
stage.mkdir(mode=0o700)
(stage / ".agent-interface-upgrade-stage").write_text(json.dumps(dict(schemaVersion=1, operationId=operation, state="active")))
(stage / ".agent-interface-isolated").write_text("agent-interface-disposable-spike")
source = stage / "source"
fixture_home = stage / "host-home"
fixture_home.mkdir(mode=0o700)
env = {k: os.environ[k] for k in ("PATH", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR") if k in os.environ}
env.update(HOME=str(fixture_home), PYTHONDONTWRITEBYTECODE="1", AGENT_BROWSER_EXECUTABLE_PATH=str(browser), PATH=str(Path(PAYLOAD["node"]).parent) + ":" + env.get("PATH", "/usr/bin:/bin"))
env = qualification["computer_probe_environment"](env, probe_browser)

def run(argv, name, environment=None, capture=False, cwd=release):
    with (stage / name).open("w") as output:
        result = subprocess.run([str(v) for v in argv], env=environment or env, cwd=cwd,
            stdout=subprocess.PIPE if capture else output, stderr=output, text=True,
            timeout=worker.get("qualificationTimeoutSeconds") or 3600)
    if result.returncode:
        raise RuntimeError("Qualification step failed: " + name + ". Inspect its owner-private log; no receipt was issued.")
    return result.stdout

try:
    run(["git", "clone", "--no-hardlinks", "--no-checkout", live, source], "source-clone.log")
    run(["git", "-C", source, "checkout", "--detach", baseline[0]], "source-checkout.log")
    # Rebuild the installed repair itself. approved_repair proved it above, and after an
    # in-app update merged it over adjacent upstream edits, the original artifact no
    # longer applies. The snapshot comparison below still requires the exact tree.
    installed_repair = stage / "installed-repair.patch"
    installed_repair.write_bytes(subprocess.check_output(["git", "-c", "core.abbrev=10", "-C", str(live), "diff", "HEAD", "--binary"]))
    installed_repair.chmod(0o600)
    if installed_repair.stat().st_size:
        run(["git", "-C", source, "apply", "--index", installed_repair], "source-repair.log")
    assert snapshot(source) == baseline
    prepared = json.loads(run([python, "-I", release / "scripts/hermes-qualified-python.py", "prepare",
        "--source", source, "--stage", stage, "--launcher", launcher,
        "--installed-source", live, "--installed-home", home], "managed-prepare.log",
        environment={**env, "HERMES_HOME": str(home)}, capture=True))
    (stage / "prepared-runtime.json").write_text(json.dumps(prepared, indent=2))
    qualified = Path(prepared["python"])
    assert qualified.parent == stage and qualified.is_file()
    isolated_app = stage / "app"
    isolated_app.mkdir(mode=0o700)
    for directory in ("src", "scripts"):
        shutil.copytree(release / directory, isolated_app / directory)
    (isolated_app / "docs/evidence").mkdir(parents=True)
    for name in ("package.json", "package-lock.json", "tsconfig.json"):
        shutil.copy2(release / name, isolated_app / name)
    (isolated_app / "node_modules").symlink_to(release / "node_modules", target_is_directory=True)
    assert qualification["integration_digest"](isolated_app) == digest
    run([qualified, isolated_app / "scripts/spike/run.py", "--qualification", "--revision", baseline[0],
        "--source", source, "--python", qualified, "--source-patch-sha256", baseline[1]], "integration.log", cwd=isolated_app)
    regression_home = stage / "regression-home"
    regression_home.mkdir(mode=0o700)
    (regression_home / "config.yaml").write_text("plugins:\n  enabled: []\n")
    regression_env = {**env, "HERMES_UPGRADE_STAGE_HOME": str(stage), "HERMES_UPGRADE_STAGE_SOURCE": str(source),
        "HERMES_UPGRADE_OPERATION_ID": operation, "HERMES_HOME": str(regression_home)}
    run([qualified, runner, "shared-oauth", "--pytest-harness", private / "pytest-harness"],
        "shared-oauth-regressions.log", regression_env)
    run([qualified, runner, "google-auth", "--google-bundle", private / "google-plugin"],
        "google-regressions.log", regression_env)
    utility = runpy.run_path(str(release / "scripts/hermes-qualified-python.py"))
    assert utility["fingerprint"](qualified) == prepared["fingerprint"]
    assert snapshot(live) == snapshot(source) == baseline
    assert all(sha(p) == expected for p, expected in host_files.items())
    assert qualification["integration_digest"](release) == digest
    assert qualification["integration_digest"](isolated_app) == digest
    assert qualification["computer_probe_browser"](requested_probe_browser) == probe_browser, "Computer probe browser changed during qualification"
    receipt = dict(schemaVersion=1, revision=baseline[0], trackedPatchSha256=baseline[1], integrationDigest=digest,
        qualifiedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), checks=dict(realIntegration=True, hostRegressions=True))
    if probe_browser: receipt["computerProbeBrowser"] = probe_browser
    # approved_repair proved this tree derives from the approved artifact; keep that binding
    # so the next in-app update can prove a repair merged over adjacent upstream edits.
    if baseline[1]: receipt["repairArtifactSha256"] = worker["requiredPatchSha256"]
    receipt_path = stage / "qualification.json"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    qualification["read_receipt"](receipt_path, release)
except BaseException:
    prune_stage(stage)
    raise
pruned = prune_stage(stage)
finish(dict(qualificationComplete=True, receipt=str(receipt_path), integrationDigest=digest,
    revision=baseline[0], trackedPatchSha256=baseline[1], browserExecutableSha256=host_files[str(browser)], productionSourceUnchanged=True,
    computerProbeBrowser=probe_browser, disposableFilesRemoved=pruned))
'''


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("name", help="staged release name from release-app.py prepare")
    browser = parser.add_mutually_exclusive_group()
    browser.add_argument("--computer-probe-browser", help="absolute host path to a sandboxed browser ELF for the local-network probe only; "
                         "by default the live qualification receipt's selection is reused")
    browser.add_argument("--pinned-probe-browser", action="store_true",
                         help="use the release's pinned PM Chromium even when the live receipt selected another browser")
    args = parser.parse_args(argv)
    if Path(args.name).name != args.name:
        parser.error("Use a release name, not a path")
    if args.computer_probe_browser and not Path(args.computer_probe_browser).is_absolute():
        parser.error("--computer-probe-browser must be an absolute host path")
    spec = importlib.util.spec_from_file_location("release_app", Path(__file__).with_name("release-app.py"))
    release_app = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(release_app)
    manifest = release_app.load_manifest(args.name)
    if manifest["status"] not in ("preparing", "prepared"):
        parser.error("Qualify an unactivated staged release only")
    facts = release_app.host_facts(manifest["host"], manifest["appBase"])
    # The runtime the staged release was built with and will deploy with, recorded at preparation.
    payload = {**manifest, "node": manifest.get("node") or facts["prior"]["node"], "computerProbeBrowser": args.computer_probe_browser,
               "inheritComputerProbeBrowser": not (args.computer_probe_browser or args.pinned_probe_browser),
               "liveQualificationReceipt": facts["prior"]["qualificationReceipt"]}
    result = release_app.remote(manifest["host"], REMOTE, payload, timeout=7200)
    release_app.MANIFESTS.joinpath(args.name + "-qualification.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
