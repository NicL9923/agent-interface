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
import datetime, importlib.util, types, uuid
base = Path(PAYLOAD["appBase"])
release = Path(PAYLOAD["release"])
ops = Path(PAYLOAD["operationDir"])
assert release.parent == base / "releases" and ops.parent == base / "operations"
assert release.is_dir() and not release.is_symlink()
assert sha(ops / "release.tar.gz") == PAYLOAD["archiveSha256"]
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
    diff = subprocess.check_output(["git", "-C", str(path), "diff", "HEAD", "--binary"])
    return revision, hashlib.sha256(diff).hexdigest()

baseline = snapshot(live)
assert baseline[0] == PAYLOAD["hermesRevision"]
# An upstream update can change diff headers while preserving the exact approved
# repaired tree. Reuse the installer's provenance check, then reconstruct that
# tree in the disposable checkout and compare its actual revision/diff below.
repair_worker = runpy.run_path(str(release / "scripts/hermes-upgrade-worker.py"))
repair_owner = types.SimpleNamespace(config=worker, source=live, environment=dict(os.environ))
repair_worker["Worker"].approved_repair(repair_owner, baseline[0], baseline[1],
    subprocess.check_output(["git", "-C", str(live), "diff", "HEAD", "--binary"]))
browser_facts = home / "tools/facts.json"
browser_template = json.loads(browser_facts.read_text())["packages"]["chromium"]["env"]["AGENT_BROWSER_EXECUTABLE_PATH"]
browser = Path(browser_template.replace("{{store}}", str(home / "tools"))).resolve()
assert "{{" not in str(browser) and browser.is_relative_to((home / "tools").resolve())
assert browser.is_file() and os.access(browser, os.X_OK)
host_files = {p: sha(p) for p in {str(worker_path), str(runner), str(browser_facts), str(browser), *worker["qualificationFiles"]}}
qualification = runpy.run_path(str(release / "src/hermes/qualification.py"))
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
    run(["git", "-C", source, "apply", "--index", patch], "source-repair.log")
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
    assert snapshot(live) == snapshot(source) == baseline
    assert all(sha(p) == expected for p, expected in host_files.items())
    assert qualification["integration_digest"](release) == digest
    assert qualification["integration_digest"](isolated_app) == digest
    utility = runpy.run_path(str(release / "scripts/hermes-qualified-python.py"))
    assert utility["fingerprint"](qualified) == prepared["fingerprint"]
    receipt = dict(schemaVersion=1, revision=baseline[0], trackedPatchSha256=baseline[1], integrationDigest=digest,
        qualifiedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), checks=dict(realIntegration=True, hostRegressions=True))
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
    disposableFilesRemoved=pruned))
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("name", help="staged release name from release-app.py prepare")
    args = parser.parse_args()
    if Path(args.name).name != args.name:
        parser.error("Use a release name, not a path")
    spec = importlib.util.spec_from_file_location("release_app", Path(__file__).with_name("release-app.py"))
    release_app = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(release_app)
    manifest = release_app.load_manifest(args.name)
    if manifest["status"] not in ("preparing", "prepared"):
        parser.error("Qualify an unactivated staged release only")
    facts = release_app.remote(manifest["host"], release_app.REMOTE_FACTS, {"appBase": manifest["appBase"]})
    payload = {**manifest, "node": facts["prior"]["node"]}
    result = release_app.remote(manifest["host"], REMOTE, payload, timeout=7200)
    release_app.MANIFESTS.joinpath(args.name + "-qualification.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
