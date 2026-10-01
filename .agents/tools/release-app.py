#!/usr/bin/env python3
"""Prepare, activate and verify a household app release.

  prepare COMMIT   Build a merged commit locally and on the host, derive its deploy
                   configuration from the last successful release and live state,
                   then run the guarded tool's no-change preflight.
  activate NAME    Run the guarded activation for a prepared release, then record it.
  record NAME      Verify an activated release and write the production receipt and
                   ledger entry for a docs PR. Activation runs this; rerun it if a
                   post-release check failed and the cause is fixed.
  verify NAME      Read-only public and service checks for an activated release.
  discard NAME     Remove a prepared release that was never activated.

The guarded activation itself stays in deploy-guarded-app-release.py. This wrapper
only replaces the hand-assembled steps around it. Host access details are passed as
arguments and kept in the ignored .private/releases manifests.
"""
import argparse
import datetime
import hashlib
import json
import re
import shlex
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFESTS = ROOT / ".private/releases"
GUARDED_TOOL = ".agents/tools/deploy-guarded-app-release.py"
APP_UNITS = ("agent-interface.service", "hermes-dashboard.service", "hermes-gateway.service")
RUNNING_PHASES = ("checking", "qualifying", "installing", "verifying", "recovering")
# A release in these states may be mid-cutover or live; only review may change it.
UNDISCARDABLE = ("activating", "needs-review", "activated", "recorded")


# Pure release rules. Tests cover these without a host.

def release_name(commit, now):
    return f"release-{commit[:8]}-{now.strftime('%Y%m%dT%H%M%SZ')}"


def built_web_version(build_log):
    found = re.findall(r"Built service worker ([0-9a-f]{16})", build_log)
    if not found:
        raise ValueError("The build log does not report a service worker build.")
    return found[-1]


def derive_config(prior, *, release, current, operation, web_build, worker, profile_hashes,
                  helper_sha, hermes_revision, repair_sha, qualification=None):
    """The next guarded deploy configuration.

    Settings are carried from the last successful release. Live state supplies the
    worker configuration (pointed at the new release) and the installed Hermes
    revision and repair, which a Hermes update changes without an app release.
    """
    config = {key: value for key, value in prior.items() if key != "newQualificationReceipt"}
    config.update(
        release=str(release),
        expectedRelease=str(current),
        operationId=str(operation),
        webBuild=web_build,
        newWorkerConfig={**worker, "appRoot": str(release)},
        profileHashes={path: profile_hashes[path] for path in prior["profileHashes"]},
        fixedHelperSha256=helper_sha,
        hermesRevision=hermes_revision,
        repairSha256=repair_sha,
    )
    if qualification:
        config["newQualificationReceipt"] = str(qualification)
    return config


def preparation_problems(facts, built, *, local_web_build, qualification, accept_helper_change):
    """Reasons a prepared release must not proceed to the guarded preflight."""
    problems = []
    prior = facts["prior"]
    if facts["maintenance"] or facts["leasePresent"] or facts["drainPresent"]:
        problems.append("Maintenance is active. Resolve the recorded operation before releasing.")
    if facts["upgradePhase"] in RUNNING_PHASES:
        problems.append(f"A Hermes update is {facts['upgradePhase']}. Wait for it to finish.")
    if built["webBuild"] != local_web_build:
        problems.append(f"The host built {built['webBuild']}, but the local build is {local_web_build}.")
    if not built["receipt"]["valid"]:
        problems.append(
            "The app integration inputs no longer match the qualification receipt"
            + (" supplied." if qualification else ". Qualify this release and pass --qualification.")
            + f" ({built['receipt']['error']})")
    if built["helperSha256"] != prior["fixedHelperSha256"] and not accept_helper_change:
        problems.append("The upgrade helper changed since the last release. Review it, then pass "
                        "--accept-helper-change.")
    return problems


def maintenance_clear(live):
    """Admission is open and no update or release operation holds the host."""
    return (live["maintenance"] is False and live["phase"] not in RUNNING_PHASES
            and not live["leasePresent"] and not live["drainPresent"])


def merged_pull_request(subject):
    match = re.match(r"Merge pull request #(\d+) ", subject)
    return int(match.group(1)) if match else None


def production_receipt(manifest, result, checks):
    return {**result, "sourceCommit": manifest["commit"], "archiveSha256": manifest["archiveSha256"],
            "release": manifest["name"], "qualification": manifest["qualification"],
            "preflightCheckPassed": True, **checks}


def ledger_entry(manifest, receipt_name, day):
    pull = f"PR #{manifest['pullRequest']} merged" if manifest.get("pullRequest") else "Merged"
    qualification = ("A fresh qualification receipt was activated with the release."
                     if manifest["qualification"] == "new"
                     else "The app integration inputs were unchanged, so the existing qualification receipt "
                          "validated against the release and was reused.")
    return f"""## {day:%B} {day.day} app release {manifest['commit'][:7]}

{pull} at `{manifest['commit']}`. The release is live at `{manifest['origin']}`,
web build `{manifest['webBuild']}`, from the archive with SHA256
`{manifest['archiveSha256']}`. The host build reproduced the local web build.

{qualification} The guarded release tool's no-change preflight passed.
Activation drained idle native work, switched the release and verified original
Google HTTP and fresh WebSockets, the configured Discord connections and the
gateway guard before clearing maintenance. The
[production receipt](evidence/{receipt_name}) records the result. Hermes remains
at `{manifest['hermesRevision'][:12]}`. Afterwards the public service worker reported the new
build, API requests required sign-in, the app and Hermes services were active and
maintenance was clear. A signed-in household session was not exercised.
"""


# Host and repository steps.

REMOTE_PRELUDE = """
import hashlib, json, os, runpy, shutil, subprocess, sys
from pathlib import Path
os.umask(0o077)
sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
def finish(value):
    print(json.dumps(value))
    raise SystemExit(0)
"""

REMOTE_FACTS = """
base = Path(PAYLOAD["appBase"]); operations = base / "operations"
best = None
for path in operations.glob("*/deploy-config.json"):
    try:
        config = json.loads(path.read_text())
    except ValueError:
        continue
    result = operations / ("continued-" + str(config.get("operationId"))) / "result.json"
    if result.is_file() and (best is None or result.stat().st_mtime > best[0]):
        best = (result.stat().st_mtime, path, config)
if best is None:
    raise SystemExit("No successful guarded release was found to carry settings from.")
prior = best[2]
status = json.loads((Path(prior["upgradeStateDir"]) / "status.json").read_text())
source = prior["source"]
finish({
    "hermesRevision": subprocess.check_output(["git", "-C", source, "rev-parse", "HEAD"], text=True).strip(),
    "repairSha256": hashlib.sha256(subprocess.check_output(["git", "-C", source, "diff", "HEAD", "--binary"])).hexdigest(),
    "workerSha256": sha(base / "shared/hermes-worker.json"),
    "priorPath": str(best[1]), "prior": prior, "current": str((base / "current").resolve()),
    "worker": json.loads((base / "shared/hermes-worker.json").read_text()),
    "profileHashes": {path: sha(path) for path in prior["profileHashes"]},
    "upgradePhase": status.get("phase"), "maintenance": status.get("maintenance") is not False,
    "leasePresent": Path(prior["maintenanceFile"]).exists(),
    "drainPresent": (Path(prior["hermesHome"]) / ".drain_request.json").exists(),
})
"""

REMOTE_BUILD = """
base = Path(PAYLOAD["appBase"]); release = Path(PAYLOAD["release"]); operation = Path(PAYLOAD["operationDir"])
archive = operation / "release.tar.gz"
assert release.parent == base / "releases" and not release.exists(), "The release directory already exists."
assert sha(archive) == PAYLOAD["archiveSha256"], "The uploaded archive does not match."
release.mkdir()
subprocess.run(["tar", "xzf", str(archive), "-C", str(release)], check=True)
environment = dict(os.environ, PATH=str(Path(PAYLOAD["node"]).parent) + os.pathsep + os.environ["PATH"])
with (operation / "build.log").open("w") as log:
    for command in (["npm", "ci", "--cache", str(base / "npm-cache"), "--no-audit", "--no-fund"], ["npm", "run", "build"]):
        if subprocess.run(command, cwd=release, env=environment, stdout=log, stderr=subprocess.STDOUT).returncode:
            raise SystemExit("The host build failed. See " + str(operation / "build.log"))
receipt = Path(PAYLOAD["qualification"] or PAYLOAD["qualificationReceipt"])
try:
    read = runpy.run_path(str(release / "src/hermes/qualification.py"))["read_receipt"](receipt, release)
    valid = read["revision"] == PAYLOAD["hermesRevision"] and read["trackedPatchSha256"] == PAYLOAD["repairSha256"]
    receipt_result = {"valid": valid, "error": None if valid else "revision or repair differs"}
except Exception as error:
    receipt_result = {"valid": False, "error": f"{type(error).__name__}: {error}"}
finish({"buildLog": (operation / "build.log").read_text()[-4000:],
        "helperSha256": sha(release / "scripts/hermes-upgrade-linux.py"), "receipt": receipt_result})
"""

REMOTE_LIVE = """
base = Path(PAYLOAD["appBase"])
finish({"current": str((base / "current").resolve()), "workerSha256": sha(base / "shared/hermes-worker.json")})
"""

REMOTE_WRITE_CONFIG = """
path = Path(PAYLOAD["path"])
assert not path.exists(), "A deploy configuration already exists for this release."
path.write_text(json.dumps(PAYLOAD["config"], indent=2) + "\\n"); path.chmod(0o600)
finish({"written": str(path)})
"""

REMOTE_VERIFY = """
base = Path(PAYLOAD["appBase"])
units = {unit: subprocess.run(["systemctl", "--user", "is-active", unit], capture_output=True, text=True).stdout.strip()
         for unit in PAYLOAD["units"]}
units["caddy.service"] = subprocess.run(["systemctl", "is-active", "caddy.service"], capture_output=True, text=True).stdout.strip()
status = json.loads((Path(PAYLOAD["upgradeStateDir"]) / "status.json").read_text())
result = base / "operations" / ("continued-" + PAYLOAD["operationId"]) / "result.json"
finish({"current": str((base / "current").resolve()), "release": str(Path(PAYLOAD["release"]).resolve()), "units": units,
        "phase": status.get("phase"), "maintenance": status.get("maintenance"),
        "leasePresent": Path(PAYLOAD["maintenanceFile"]).exists(),
        "drainPresent": (Path(PAYLOAD["hermesHome"]) / ".drain_request.json").exists(),
        "result": json.loads(result.read_text()) if result.is_file() else None})
"""

REMOTE_DISCARD = """
base = Path(PAYLOAD["appBase"]); release = Path(PAYLOAD["release"]); operation = Path(PAYLOAD["operationDir"])
# Compare resolved paths, so a symlinked base can never hide the live release.
assert (base / "current").resolve() != release.resolve(), "The release is live; it cannot be discarded."
assert release.parent == base / "releases" and operation.parent == base / "operations"
assert not (base / "operations" / ("continued-" + PAYLOAD["operationId"]) / "result.json").exists(), "The release was activated."
if PAYLOAD.get("upgradeStateDir"):
    # The guarded tool holds this lock for its whole run, including activation.
    import fcntl
    lock = open(Path(PAYLOAD["upgradeStateDir"]) / "worker.lock", "a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("A release or update operation is running. Try again after it finishes.")
for path in (release, operation):
    if path.exists():
        shutil.rmtree(path)
finish({"discarded": [str(release), str(operation)]})
"""


def remote(host, program, payload, timeout=900):
    """Run a Python program on the host with a JSON payload; return its final JSON line."""
    source = REMOTE_PRELUDE + f"PAYLOAD = json.loads({json.dumps(json.dumps(payload))})\n" + program
    done = subprocess.run(["ssh", "-o", "BatchMode=yes", host, "python3", "-"], input=source,
                          capture_output=True, text=True, timeout=timeout)
    if done.returncode:
        raise SystemExit(f"Host step failed:\n{(done.stderr or done.stdout).strip()[-3000:]}")
    return json.loads(done.stdout.strip().splitlines()[-1])


def guarded(host, manifest, check):
    command = f"cd {shlex.quote(manifest['release'])} && python3 {GUARDED_TOOL} --config {shlex.quote(manifest['configPath'])}"
    done = subprocess.run(["ssh", "-o", "BatchMode=yes", host, command + (" --check" if check else "")],
                          capture_output=True, text=True, timeout=1800)
    output = done.stdout.strip()
    print(output)
    if done.returncode:
        print(done.stderr.strip()[-3000:], file=sys.stderr)
        return None
    return json.loads(output.splitlines()[-1])


def git(*args, cwd=ROOT):
    return subprocess.check_output(["git", *args], cwd=cwd, text=True).strip()


def manifest_path(name):
    return MANIFESTS / f"{name}.json"


def load_manifest(name):
    return json.loads(manifest_path(name).read_text())


def save_manifest(manifest):
    MANIFESTS.mkdir(parents=True, exist_ok=True)
    manifest_path(manifest["name"]).write_text(json.dumps(manifest, indent=2) + "\n")


def build_locally(commit, work):
    """Archive and build an exact commit in a disposable worktree."""
    checkout = work / "checkout"
    git("worktree", "add", "--detach", str(checkout), commit)
    try:
        archive = json.loads(subprocess.check_output(
            [sys.executable, ".agents/tools/archive-release.py", str(work / "release.tar.gz")], cwd=checkout, text=True))
        log = subprocess.run("npm ci --no-audit --no-fund && npm run build", shell=True, cwd=checkout,
                             capture_output=True, text=True)
        if log.returncode:
            raise SystemExit("The local build failed:\n" + (log.stdout + log.stderr)[-3000:])
        return archive["sha256"], built_web_version(log.stdout)
    finally:
        git("worktree", "remove", "--force", str(checkout))


def prepare(args):
    git("fetch", "--quiet", "origin", "main")
    commit = git("rev-parse", "--verify", args.commit + "^{commit}")
    if subprocess.run(["git", "merge-base", "--is-ancestor", commit, "origin/main"], cwd=ROOT).returncode:
        raise SystemExit("Release only commits that are merged to origin/main.")
    name = release_name(commit, datetime.datetime.now(datetime.timezone.utc))
    base = Path(args.app_base)
    facts = remote(args.host, REMOTE_FACTS, {"appBase": str(base)})
    prior = facts["prior"]
    print(f"Carrying settings from {facts['priorPath']}; live release {Path(facts['current']).name}.")
    operation_dir = base / "operations" / name
    release = base / "releases" / name
    manifest = {
        "name": name, "status": "preparing", "commit": commit, "host": args.host, "appBase": str(base),
        "release": str(release), "operationDir": str(operation_dir), "origin": prior["appOrigin"],
        "hermesRevision": facts["hermesRevision"], "qualification": "new" if args.qualification else "reused",
        "pullRequest": merged_pull_request(git("log", "-1", "--format=%s", commit)),
    }
    with tempfile.TemporaryDirectory() as temporary:
        work = Path(temporary)
        archive_sha, local_web_build = build_locally(commit, work)
        manifest["archiveSha256"] = archive_sha
        # Recorded before the host changes, so discard can always clean up.
        save_manifest(manifest)
        subprocess.run(["ssh", "-o", "BatchMode=yes", args.host,
                        f"umask 077 && mkdir {shlex.quote(str(operation_dir))}"], check=True)
        subprocess.run(["scp", "-q", "-o", "BatchMode=yes", str(work / "release.tar.gz"),
                        f"{args.host}:{operation_dir}/release.tar.gz"], check=True)
    built = remote(args.host, REMOTE_BUILD, {
        "appBase": str(base), "release": str(release), "operationDir": str(operation_dir),
        "archiveSha256": archive_sha, "node": prior["node"], "qualification": args.qualification,
        "qualificationReceipt": prior["qualificationReceipt"], "hermesRevision": facts["hermesRevision"],
        "repairSha256": facts["repairSha256"]})
    built["webBuild"] = built_web_version(built["buildLog"])
    manifest["webBuild"] = built["webBuild"]
    save_manifest(manifest)
    problems = preparation_problems(facts, built, local_web_build=local_web_build,
                                    qualification=args.qualification, accept_helper_change=args.accept_helper_change)
    if problems:
        raise SystemExit("Not ready to release:\n- " + "\n- ".join(problems)
                         + f"\nDiscard with: release-app.py discard {name} --host {args.host}")
    config = derive_config(prior, release=release, current=facts["current"], operation=uuid.uuid4(),
                           web_build=built["webBuild"], worker=facts["worker"],
                           profile_hashes=facts["profileHashes"], helper_sha=built["helperSha256"],
                           hermes_revision=facts["hermesRevision"], repair_sha=facts["repairSha256"],
                           qualification=args.qualification)
    config_path = operation_dir / "deploy-config.json"
    remote(args.host, REMOTE_WRITE_CONFIG, {"path": str(config_path), "config": config})
    manifest.update(configPath=str(config_path), operationId=config["operationId"],
                    upgradeStateDir=config["upgradeStateDir"], maintenanceFile=config["maintenanceFile"],
                    hermesHome=config["hermesHome"], workerSha256=facts["workerSha256"],
                    expectedRelease=facts["current"])
    save_manifest(manifest)
    if guarded(args.host, manifest, check=True) is None:
        raise SystemExit("The guarded preflight did not pass. Nothing was changed on the host. "
                         f"Discard with: release-app.py discard {name}")
    manifest["status"] = "prepared"
    save_manifest(manifest)
    print(f"Prepared {name} (web build {built['webBuild']}). Activate with: "
          f"release-app.py activate {name} --host {args.host}")


def http_get(url):
    """Status and body of a public request, including error responses."""
    import urllib.error
    import urllib.request
    try:
        with urllib.request.urlopen(url, timeout=20) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, ""


def verify_release(manifest):
    public_build = manifest["webBuild"] in http_get(manifest["origin"] + "/sw.js")[1]
    signed_out = http_get(manifest["origin"] + "/api/bootstrap")[0] == 401
    live = remote(manifest["host"], REMOTE_VERIFY, {
        "appBase": manifest["appBase"], "release": manifest["release"], "units": APP_UNITS,
        "operationId": manifest["operationId"],
        "upgradeStateDir": manifest["upgradeStateDir"], "maintenanceFile": manifest["maintenanceFile"],
        "hermesHome": manifest["hermesHome"]})
    checks = {
        "publicServiceWorkerBuild": public_build,
        "apiRequiresSignIn": signed_out,
        "releaseIsCurrent": live["current"] == live["release"],
        "servicesActive": all(state == "active" for state in live["units"].values()),
        "maintenanceCleared": maintenance_clear(live),
    }
    return checks, live["result"]


def activate(args):
    manifest = load_manifest(args.name)
    if manifest["status"] != "prepared":
        raise SystemExit(f"{args.name} is {manifest['status']}, not prepared.")
    manifest["host"] = args.host or manifest["host"]
    live = remote(manifest["host"], REMOTE_LIVE, {"appBase": manifest["appBase"]})
    if live["current"] != manifest["expectedRelease"] or live["workerSha256"] != manifest["workerSha256"]:
        raise SystemExit("The live release or worker configuration changed since preparation. "
                         f"Discard {args.name} and prepare again.")
    # Recorded before cutover, so an interrupted run can never look merely prepared.
    manifest["status"] = "activating"
    save_manifest(manifest)
    def held_for_review():
        manifest["status"] = "needs-review"
        save_manifest(manifest)
        return ("Activation needs review. The guarded tool preserves native owners and records its phase "
                f"under {manifest['appBase']}/operations/continued-{manifest['operationId']}.")
    try:
        result = guarded(manifest["host"], manifest, check=False)
    except BaseException:
        # A lost connection or interruption leaves the outcome unknown.
        print(held_for_review(), file=sys.stderr)
        raise
    if result is None:
        raise SystemExit(held_for_review())
    manifest.update(status="activated", guardedResult=result)
    save_manifest(manifest)
    record_release(manifest)


def record_release(manifest):
    """Verify an activated release, then write its receipt and ledger entry once."""
    checks, _ = verify_release(manifest)
    print(json.dumps(checks, indent=2))
    if not all(checks.values()):
        raise SystemExit(f"Activated, but a post-release check failed. Investigate, then run: "
                         f"release-app.py record {manifest['name']}")
    day = datetime.datetime.now(datetime.timezone.utc).date()
    receipt_name = f"production-{manifest['name']}.json"
    (ROOT / "docs/evidence" / receipt_name).write_text(
        json.dumps(production_receipt(manifest, manifest["guardedResult"], checks), indent=2) + "\n")
    ledger = ROOT / "docs/ValidationLedger.md"
    text = ledger.read_text()
    heading = "# Validation ledger\n"
    assert text.startswith(heading)
    ledger.write_text(heading + "\n" + ledger_entry(manifest, receipt_name, day) + text[len(heading):])
    manifest["status"] = "recorded"
    save_manifest(manifest)
    print(f"Wrote docs/evidence/{receipt_name} and a ledger entry. Open a docs PR to record the release.")


def record(args):
    manifest = load_manifest(args.name)
    if manifest["status"] != "activated":
        raise SystemExit(f"{args.name} is {manifest['status']}; only activated releases are recorded.")
    manifest["host"] = args.host or manifest["host"]
    record_release(manifest)


def verify(args):
    manifest = load_manifest(args.name)
    manifest["host"] = args.host or manifest["host"]
    checks, result = verify_release(manifest)
    print(json.dumps({"checks": checks, "guardedResult": result}, indent=2))
    if not all(checks.values()):
        raise SystemExit(1)


def discard(args):
    manifest = load_manifest(args.name)
    if manifest["status"] in UNDISCARDABLE:
        raise SystemExit(f"{args.name} is {manifest['status']}; it cannot be discarded.")
    print(remote(args.host or manifest["host"], REMOTE_DISCARD, {
        "appBase": manifest["appBase"], "release": manifest["release"], "operationDir": manifest["operationDir"],
        "operationId": manifest.get("operationId", ""), "upgradeStateDir": manifest.get("upgradeStateDir")}))
    manifest["status"] = "discarded"
    save_manifest(manifest)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    step = commands.add_parser("prepare", help="build and preflight a merged commit")
    step.add_argument("commit")
    step.add_argument("--host", required=True, help="SSH alias of the app host")
    step.add_argument("--app-base", required=True, help="absolute application directory on the host")
    step.add_argument("--qualification", help="fresh qualification receipt on the host, when integration inputs changed")
    step.add_argument("--accept-helper-change", action="store_true",
                      help="confirm a reviewed change to scripts/hermes-upgrade-linux.py")
    step.set_defaults(run=prepare)
    for name, run, text in (("activate", activate, "activate a prepared release"),
                            ("record", record, "verify an activated release and write its records"),
                            ("verify", verify, "re-run read-only post-release checks"),
                            ("discard", discard, "remove a prepared, unactivated release")):
        step = commands.add_parser(name, help=text)
        step.add_argument("name")
        step.add_argument("--host", help="override the SSH alias recorded at preparation")
        step.set_defaults(run=run)
    args = parser.parse_args(argv)
    args.run(args)


if __name__ == "__main__":
    main()
