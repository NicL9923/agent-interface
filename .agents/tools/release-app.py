#!/usr/bin/env python3
"""Prepare, activate and verify a household app release.

  prepare COMMIT   Build a merged commit locally and on the host, derive its deploy
                   configuration from the last successful release and live state,
                   then run the guarded tool's no-change preflight.
  activate NAME    Run the guarded activation for a prepared release, then record it.
  record NAME      Verify an activated release, write the production receipt and
                   ledger entry, then open their docs PR from a temporary worktree of
                   origin/main. Activation runs this; rerun it if a post-release check
                   failed and the cause is fixed, or to retry an unopened docs PR.
  verify NAME      Read-only public and service checks for an activated release.
  discard NAME     Remove a prepared release that was never activated.
  recover NAME     After an outside Hermes update disabled the add-on, install the fresh
                   qualification of staged release NAME for the unchanged live release.
                   Runs the recovery helper's read-only check, then the recovery,
                   which restarts the app, dashboard and gateway under maintenance.

The guarded activation itself stays in deploy-guarded-app-release.py. This wrapper
only replaces the hand-assembled steps around it. Host access details are passed as
arguments and kept in the ignored .private/releases manifests.
"""
import argparse
import contextlib
import datetime
import fcntl
import json
import re
import shlex
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

from deploy_common import OPTIMIZED_REFUSAL, fence

ROOT = Path(__file__).resolve().parents[2]
MANIFESTS = ROOT / ".private/releases"
GUARDED_TOOL = ".agents/tools/deploy-guarded-app-release.py"
APP_UNITS = ("agent-interface.service", "hermes-dashboard.service", "hermes-gateway.service")
RUNNING_PHASES = ("checking", "qualifying", "installing", "verifying", "recovering")
# A release in these states may be mid-cutover or live; only review may change it.
UNDISCARDABLE = ("activating", "needs-review", "activated", "recorded", "recovering", "recovered")


# Pure release rules. Tests cover these without a host.

def release_name(commit, now):
    return f"release-{commit[:8]}-{now.strftime('%Y%m%dT%H%M%SZ')}"


def built_web_version(build_log):
    found = re.findall(r"Built service worker ([0-9a-f]{16})", build_log)
    if not found:
        raise ValueError("The build log does not report a service worker build.")
    return found[-1]


def helper_hooks(value, release):
    """Point upgrade hooks at the release's own platform helper, the file activation verifies
    against fixedHelperSha256. A pinned older copy would silently keep running instead."""
    if isinstance(value, dict): return {key: helper_hooks(item, release) for key, item in value.items()}
    if isinstance(value, list): return [helper_hooks(item, release) for item in value]
    if isinstance(value, str) and value.endswith("/scripts/hermes-upgrade-linux.py"):
        return str(Path(release) / "scripts/hermes-upgrade-linux.py")
    return value


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
        newWorkerConfig={**worker, "appRoot": str(release), **({"hooks": helper_hooks(worker["hooks"], release)} if "hooks" in worker else {})},
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
    return f"""# {day:%B} {day.day} app release {manifest['commit'][:7]}

{pull} at `{manifest['commit']}`. The release is live at `{manifest['origin']}`,
web build `{manifest['webBuild']}`, from the archive with SHA256
`{manifest['archiveSha256']}`. The host build reproduced the local web build.

{qualification} The guarded release tool's no-change preflight passed.
Activation drained idle native work, switched the release and verified original
Google HTTP and fresh WebSockets, the configured Discord connections and the
gateway guard before clearing maintenance. The
[production receipt](../evidence/{receipt_name}) records the result. Hermes remains
at `{manifest['hermesRevision'][:12]}`. Afterwards the public service worker reported the new
build, API requests required sign-in, the app and Hermes services were active and
maintenance was clear. A signed-in household session was not exercised.
"""


LEDGER_DIR = "docs/ledger"
# The frozen archive of earlier entries; new ones are files in LEDGER_DIR.
LEDGER_ARCHIVE = "docs/ValidationLedger.md"


def ledger_file(release_name):
    """Entry path under LEDGER_DIR, named by the release's UTC stamp so listings sort chronologically.

    Derived from the release name, which two releases never share, so entries cannot collide.
    """
    match = re.fullmatch(r"release-([0-9a-f]+)-(\d{8}T\d{6}Z)", release_name)
    fence(match, "release name carries its commit and UTC stamp")
    return f"{LEDGER_DIR}/{match[2]}-app-release-{match[1]}.md"


def insert_ledger_entry(root, manifest):
    """Write the release's entry file under root, once per release.

    Keyed by the release's receipt link as well as its file, so an entry another branch already
    recorded by hand, in the archive or under another name, is not repeated.
    """
    path = root / ledger_file(manifest["name"])
    if path.exists():
        return False
    link = f"evidence/{manifest['receiptName']})"
    recorded = [root / LEDGER_ARCHIVE, *sorted((root / LEDGER_DIR).glob("*.md"))]
    if any(link in entry.read_text() for entry in recorded if entry.is_file()):
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(relocated_entry(manifest["ledgerEntry"]))
    return True


def relocated_entry(text):
    """An entry saved by an earlier version for the archive, moved to its own file.

    Those manifests hold a `##` heading and receipt links relative to docs/; a retry writes them under
    docs/ledger/, so the heading becomes the file's title and the links climb one directory.
    """
    if text.startswith("## "):
        text = text[1:]
    return text.replace("](evidence/", "](../evidence/")


def docs_branch(manifest):
    # One branch per release, so a second release of the same commit gets its own PR.
    return f"docs/record-{manifest['name']}"


def docs_pull_request(manifest):
    """Title and body of the PR that records an activated release, shaped like earlier ones."""
    pull = f"#{manifest['pullRequest']}" if manifest.get("pullRequest") else f"`{manifest['commit'][:7]}`"
    title = f"Record the {pull.strip('`')} deployment"
    qualification = ("It activated a fresh qualification receipt." if manifest["qualification"] == "new"
                     else "It reused the existing qualification receipt.")
    helper = (" It was prepared with `--accept-helper-change`, so the worker hooks now run this release's helper."
              if manifest.get("helperChanged") else "")
    body = (f"Records the production release of {pull} (`{manifest['name']}`). It is the activation receipt "
            f"and validation ledger entry written by `release-app.py activate`.\n\n"
            f"{qualification}{helper} Hermes stayed at `{manifest['hermesRevision'][:8]}`.\n\n"
            "🤖 Generated with [Claude Code](https://claude.com/claude-code)\n")
    return title, body


# Host and repository steps.

REMOTE_PRELUDE = OPTIMIZED_REFUSAL + """
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
    "repairSha256": hashlib.sha256(subprocess.check_output(["git", "-c", "core.abbrev=10", "-C", source, "diff", "HEAD", "--binary"])).hexdigest(),
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

# Releases kept beyond the live one and the rollback target its deploy configuration names.
# Older ones are removed only after a week untouched, so a stage another session is still
# preparing or qualifying is never removed under it.
RELEASES_KEPT = 10
RELEASE_MIN_AGE_DAYS = 7
REMOTE_PRUNE = """
import re
base = Path(PAYLOAD["appBase"]); releases = base / "releases"
current = (base / "current").resolve()
keep = {current}
# The live release's deploy configuration names its rollback target.
config = base / "operations" / current.name / "deploy-config.json"
if config.exists():
    keep |= {(releases / name).resolve() for name in re.findall(r"releases/(release-[A-Za-z0-9._-]+)", config.read_text())}
dirs = sorted((p for p in releases.iterdir() if p.is_dir() and not p.is_symlink()), key=lambda p: p.stat().st_mtime, reverse=True)
keep |= {p.resolve() for p in dirs[:PAYLOAD["keep"]]}
import time
def touched(path):
    operation = base / "operations" / path.name
    return max(path.stat().st_mtime, operation.stat().st_mtime if operation.exists() else 0)
cutoff = time.time() - PAYLOAD["minAgeDays"] * 86400
removed = [p.name for p in dirs if p.resolve() not in keep and touched(p) < cutoff]
for name in removed: shutil.rmtree(releases / name)
finish({"removed": removed, "kept": len(dirs) - len(removed)})
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

REMOTE_RECOVER = """
import datetime, time
base = Path(PAYLOAD["appBase"]); operations = base / "operations"
release = (base / "current").resolve(strict=True)
tools = release / ".agents/tools"
helper = tools / "recover-app-after-native-update.py"
# The helper imports its shared host steps from its own directory.
sys.path.insert(0, str(tools))
helper_globals = runpy.run_path(str(helper))
fingerprint = helper_globals["fingerprint"]
# Pin the shared steps the live helper runs; releases before deploy_common.py exec'd these.
shared_functions = helper_globals.get("SHARED_FUNCTIONS", "deploy-app-release.py")
# The live release's own deploy configuration carries every installer setting.
prior = json.loads((operations / release.name / "deploy-config.json").read_text())
assert prior["release"] == str(release), "The live release has no deploy configuration of its own."
source, home = Path(prior["source"]), Path(prior["hermesHome"])
operation = PAYLOAD["operationId"]
path = operations / ("native-recovery-config-" + operation) / "config.json"
if not PAYLOAD["check"]:
    # Recovery reuses the exact configuration its read-only check passed with.
    assert path.is_file(), "Run the recovery check first."
else:
    units = Path.home() / ".config/systemd/user"
    preserved = [base / "shared/app.env", base / "shared/hermes-service.env", base / "shared/hermes-worker.json",
                 *(units / (unit + ".service.d") / name for unit in ("hermes-gateway", "hermes-dashboard")
                   for name in ("90-agent-interface.conf", "computer.conf")),
                 *(source / ("agent_interface_" + name + ".py") for name in ("gateway", "dashboard", "computer_host"))]
    config = dict(prior,
        release=str(release), expectedRelease=str(release), operationId=operation,
        hermesRevision=subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip(),
        repairSha256=hashlib.sha256(subprocess.check_output(["git", "-c", "core.abbrev=10", "-C", str(source), "diff", "HEAD", "--binary"])).hexdigest(),
        newQualificationReceipt=PAYLOAD["receipt"],
        profileHashes={item: fingerprint(item) for item in prior["profileHashes"]},
        preservedFiles={str(item): fingerprint(item) for item in preserved if os.path.lexists(item)},
        deployFunctionsSha256=fingerprint(tools / shared_functions))
    path.parent.mkdir(mode=0o700)
    path.write_text(json.dumps(config, indent=2) + "\\n"); path.chmod(0o600)

def heartbeat_age():
    try:
        updated = json.loads((home / "gateway_state.json").read_text())["updated_at"]
        return time.time() - datetime.datetime.fromisoformat(updated).timestamp()
    except (OSError, ValueError, KeyError):
        return None

def run_helper(*flags):
    # The helper requires a gateway heartbeat under ten seconds old; heartbeats
    # arrive about once a minute, so start right after one.
    deadline = time.monotonic() + PAYLOAD["heartbeatWaitSeconds"]
    while (age := heartbeat_age()) is None or age > 1:
        if time.monotonic() > deadline:
            raise SystemExit("The gateway reported no fresh heartbeat. Check hermes-gateway.service; nothing was changed.")
        time.sleep(0.25)
    done = subprocess.run([sys.executable, str(helper), "--config", str(path), *flags],
                          capture_output=True, text=True, timeout=1500)
    lines = done.stdout.strip().splitlines()
    if done.returncode == 0 and lines:
        return json.loads(lines[-1])
    audits = sorted((item for item in operations.glob("native-recovery*-" + operation + "*") if item != path.parent),
                    key=lambda item: item.stat().st_mtime)
    log = audits[-1] / "commands.log" if audits else None
    tail = log.read_text()[-1500:] if log and log.is_file() else done.stderr[-1500:]
    raise SystemExit(("Recovery check" if flags else "Recovery") + " stopped. "
                     + (lines[-1] if lines else "") + "\\nAudit: " + str(log) + "\\n" + tail)

finish(run_helper("--check") if PAYLOAD["check"] else run_helper())
"""

REMOTE_DISCARD = """
base = Path(PAYLOAD["appBase"]); release = Path(PAYLOAD["release"]); operation = Path(PAYLOAD["operationDir"])
# Compare resolved paths, so a symlinked base can never hide the live release.
assert (base / "current").resolve() != release.resolve(), "The release is live; it cannot be discarded."
assert release.parent == base / "releases" and operation.parent == base / "operations"
assert not (base / "operations" / ("continued-" + PAYLOAD["operationId"]) / "result.json").exists(), "The release was activated."
# A qualified stage's receipt is what the next prepare --qualification needs. Losing it costs a rerun.
receipts = sorted(str(path) for path in operation.glob("qualification-*/qualification.json"))
if receipts and not PAYLOAD.get("includeQualification"):
    raise SystemExit("This stage holds a qualification receipt for prepare --qualification: " + ", ".join(receipts)
                     + ". Keep it until that release is activated, or pass --include-qualification to discard it too.")
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


def remote_source(program, payload):
    """The exact Python source a host program runs as, with its prelude and payload."""
    return REMOTE_PRELUDE + f"PAYLOAD = json.loads({json.dumps(json.dumps(payload))})\n" + program


def remote(host, program, payload, timeout=900):
    """Run a Python program on the host with a JSON payload; return its final JSON line."""
    done = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4", host, "python3", "-"], input=remote_source(program, payload),
                          capture_output=True, text=True, timeout=timeout)
    if done.returncode:
        raise SystemExit(f"Host step failed:\n{(done.stderr or done.stdout).strip()[-3000:]}")
    return json.loads(done.stdout.strip().splitlines()[-1])


def guarded(host, manifest, check):
    command = f"cd {shlex.quote(manifest['release'])} && python3 {GUARDED_TOOL} --config {shlex.quote(manifest['configPath'])}"
    done = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4", host, command + (" --check" if check else "")],
                          capture_output=True, text=True, timeout=1800)
    output = done.stdout.strip()
    print(output)
    if done.returncode:
        print(done.stderr.strip()[-3000:], file=sys.stderr)
        return None
    return json.loads(output.splitlines()[-1])


def git(*args, cwd=None):
    # ROOT is read per call, never bound as a default, so a test's checkout is the one used.
    return subprocess.check_output(["git", *args], cwd=cwd or ROOT, text=True).strip()


def manifest_path(name):
    return MANIFESTS / f"{name}.json"


def load_manifest(name):
    return json.loads(manifest_path(name).read_text())


@contextlib.contextmanager
def manifest_lock(name):
    """Hold one release's manifest for a whole command, so a concurrent run cannot
    overwrite its state with a stale copy."""
    MANIFESTS.mkdir(parents=True, exist_ok=True)
    with open(MANIFESTS / f"{name}.lock", "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit(f"Another release-app.py command is using {name}. Try again after it finishes.")
        yield


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
        git("worktree", "remove", "--force", "--force", str(checkout))


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
    manifest.update(webBuild=built["webBuild"], helperChanged=built["helperSha256"] != prior["fixedHelperSha256"])
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
    prune_releases(manifest)
    record_release(manifest, docs_pr=not args.no_docs_pr)


def prune_releases(manifest):
    """Remove old release builds so the host keeps room for Hermes update checks; never fails a release."""
    try:
        pruned = remote(manifest["host"], REMOTE_PRUNE, {"appBase": manifest["appBase"], "keep": RELEASES_KEPT, "minAgeDays": RELEASE_MIN_AGE_DAYS})
        print(f"Removed {len(pruned['removed'])} old releases; kept {pruned['kept']}.")
    except (SystemExit, subprocess.SubprocessError, ValueError, KeyError, TypeError) as error:
        print(f"Warning: old releases were not pruned: {error}", file=sys.stderr)


def write_records(root, manifest):
    """Write the release's receipt and ledger entry into a checkout; rerunning changes nothing.

    Returns the paths that hold this release's records. The entry file is absent when the release was
    already recorded elsewhere, by hand or in the archive, so only the receipt is listed then.
    """
    receipt = "docs/evidence/" + manifest["receiptName"]
    (root / receipt).write_text(manifest["productionReceipt"])
    insert_ledger_entry(root, manifest)
    entry = ledger_file(manifest["name"])
    return [entry, receipt] if (root / entry).exists() else [receipt]


def record_release(manifest, docs_pr=True):
    """Verify an activated release, write its receipt and ledger entry once, then open its docs PR."""
    checks, _ = verify_release(manifest)
    print(json.dumps(checks, indent=2))
    if not all(checks.values()):
        raise SystemExit(f"Activated, but a post-release check failed. Investigate, then run: "
                         f"release-app.py record {manifest['name']}")
    if "ledgerEntry" not in manifest:
        # Saved before writing, so a rerun on a later day keeps the same ledger heading,
        # and the docs PR and any retry use these exact records.
        day = datetime.datetime.now(datetime.timezone.utc).date()
        receipt_name = f"production-{manifest['name']}.json"
        manifest.update(receiptName=receipt_name, ledgerEntry=ledger_entry(manifest, receipt_name, day),
                        productionReceipt=json.dumps(production_receipt(manifest, manifest["guardedResult"], checks), indent=2) + "\n")
        save_manifest(manifest)
    receipt_name = manifest["receiptName"]
    write_records(ROOT, manifest)
    manifest["status"] = "recorded"
    save_manifest(manifest)
    print(f"Wrote docs/evidence/{receipt_name} and a ledger entry.")
    if docs_pr:
        open_docs_pull_request(manifest)


def gh(*args):
    return subprocess.run(["gh", *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout.strip()


def open_docs_pull_request(manifest):
    """Commit the records on a branch from the latest origin/main and open, never merge, its PR.

    Works in a temporary worktree under .private, so the operator's checkout is untouched. Safe to rerun: an
    existing PR, pushed branch or recorded entry on main is reused. Failure only warns; the
    release stays recorded.
    """
    branch = docs_branch(manifest)
    title, body = docs_pull_request(manifest)
    try:
        existing = gh("pr", "list", "--head", branch, "--state", "all", "--json", "url", "--jq", ".[].url")
        if existing:
            print(f"The docs PR already exists: {existing.splitlines()[0]}")
            return
        git("fetch", "--quiet", "origin", "main")
        if not git("ls-remote", "--heads", "origin", branch):
            # Inside the checkout's ignored .private, so it lands on the checkout's own disk.
            worktrees = ROOT / ".private/docs-pr-worktrees"
            worktrees.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(dir=worktrees) as temporary:
                checkout = Path(temporary) / "records"
                git("worktree", "add", "--quiet", "--detach", str(checkout), "origin/main")
                try:
                    git("add", *write_records(checkout, manifest), cwd=checkout)
                    if not git("status", "--porcelain", cwd=checkout):
                        print("origin/main already records this release; no docs PR is needed.")
                        return
                    git("commit", "--quiet", "-m", title, cwd=checkout)
                    git("push", "--quiet", "origin", "HEAD:refs/heads/" + branch, cwd=checkout)
                finally:
                    # A second --force also removes a worktree git left locked by an interrupted add.
                    git("worktree", "remove", "--force", "--force", str(checkout))
        url = gh("pr", "create", "--base", "main", "--head", branch, "--title", title, "--body", body)
        print(f"Opened the docs PR: {url.splitlines()[-1]}")
    except Exception as error:
        detail = (getattr(error, "stderr", None) or str(error)).strip().splitlines()
        print(f"Warning: the docs PR was not opened ({detail[-1] if detail else type(error).__name__}). "
              f"The release is recorded and its records are in this checkout.\n"
              f"Retry with: release-app.py record {manifest['name']}\n"
              f"Or by hand:\n"
              f"  git fetch origin main && git switch -c {branch} origin/main\n"
              f"  git add {ledger_file(manifest['name'])} docs/evidence/{manifest['receiptName']}\n"
              f"  git commit -m {shlex.quote(title)} && git push -u origin {branch}\n"
              f"  gh pr create --base main --head {branch} --title {shlex.quote(title)}")


def record(args):
    manifest = load_manifest(args.name)
    if manifest["status"] == "recorded" and "ledgerEntry" in manifest:
        # Already verified and written; only its docs PR can be outstanding.
        if not args.no_docs_pr:
            open_docs_pull_request(manifest)
        return
    if manifest["status"] != "activated":
        raise SystemExit(f"{args.name} is {manifest['status']}; only activated releases are recorded.")
    manifest["host"] = args.host or manifest["host"]
    record_release(manifest, docs_pr=not args.no_docs_pr)


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
        "operationId": manifest.get("operationId", ""), "upgradeStateDir": manifest.get("upgradeStateDir"),
        "includeQualification": getattr(args, "include_qualification", False)}))
    manifest["status"] = "discarded"
    save_manifest(manifest)


def recover(args):
    with manifest_lock(args.name):
        run_recovery(args)


def run_recovery(args):
    manifest = load_manifest(args.name)
    if manifest["status"] not in ("preparing", "prepared"):
        raise SystemExit(f"{args.name} is {manifest['status']}; recover with a qualified, unactivated release.")
    qualification = MANIFESTS / f"{args.name}-qualification.json"
    result = json.loads(qualification.read_text()) if qualification.is_file() else {}
    if result.get("qualificationComplete") is not True:
        raise SystemExit(f"Qualify first: qualify-app-release.py {args.name}")
    host = args.host or manifest["host"]
    operation = str(uuid.uuid4())
    payload = {"appBase": manifest["appBase"], "receipt": result["receipt"], "operationId": operation,
               "check": True, "heartbeatWaitSeconds": 150}
    # A failed check changes nothing, so the release stays recoverable.
    print(json.dumps(remote(host, REMOTE_RECOVER, payload, timeout=1800), indent=2))
    if args.check:
        return
    # Recorded before services change, so an interrupted run never looks merely prepared.
    manifest.update(status="recovering", recoveryOperationId=operation)
    save_manifest(manifest)
    try:
        outcome = remote(host, REMOTE_RECOVER, {**payload, "check": False}, timeout=3600)
    except BaseException:
        manifest["status"] = "needs-review"
        save_manifest(manifest)
        print("Recovery needs review. The helper records its phase under "
              f"{manifest['appBase']}/operations/native-recovery-{operation}.", file=sys.stderr)
        raise
    manifest.update(status="recovered", recoveryResult=outcome)
    save_manifest(manifest)
    print(json.dumps(outcome, indent=2))


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
        if name == "discard":
            step.add_argument("--include-qualification", action="store_true",
                              help="also discard a qualification receipt the stage holds")
        if name in ("activate", "record"):
            step.add_argument("--no-docs-pr", action="store_true",
                              help="write the records locally without opening their docs PR")
        step.set_defaults(run=run)
    step = commands.add_parser("recover", help="restore the add-on after an outside Hermes update")
    step.add_argument("name", help="staged release of the live commit, qualified against the installed Hermes")
    step.add_argument("--host", help="override the SSH alias recorded at preparation")
    step.add_argument("--check", action="store_true", help="run only the read-only recovery preflight")
    step.set_defaults(run=recover)
    args = parser.parse_args(argv)
    args.run(args)


if __name__ == "__main__":
    main()
