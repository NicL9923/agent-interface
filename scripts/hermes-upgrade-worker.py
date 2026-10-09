"""Durable installer-owned Hermes upgrade worker. Never execute client commands.

The app starts this detached worker after persisting an operation. Every external
command is a fixed argv from an owner-only host configuration. Qualification uses
an isolated app/source copy, never the production Hermes home. Installation is a
separate action and revalidates all qualification inputs under an exclusive lock.
"""
import argparse
import base64
import difflib
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import select
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid

OFFICIAL_UPSTREAM = "https://github.com/NousResearch/hermes-agent.git"
MAX_REPAIR_SNAPSHOT_PACK_BYTES = 512 * 1024 * 1024


def private_file(path):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise RuntimeError("Installer configuration must be a private file owned by the worker user")
    return path


def atomic(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(value, output); output.write("\n"); output.flush(); os.fsync(output.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try: os.fsync(directory)
    finally: os.close(directory)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def git(source, *args):
    return subprocess.check_output(["git", "-C", str(source), *args], stderr=subprocess.PIPE)


def git_tag_refs(source):
    return [line.split(" ") for line in git(source, "for-each-ref", "--format=%(refname) %(objectname)", "refs/tags").decode().splitlines()]


def complete_history(source):
    shallow = git(source, "rev-parse", "--is-shallow-repository").strip()
    if shallow != b"false":
        raise RuntimeError("Installed Hermes history is incomplete. The installer must restore complete version history before qualifying an update.")
    return shallow


# Installer-created links beside hermes_cli, each to its file in the app's src/hermes.
# Every wrapper an installer adds must be listed here, or update checks refuse the source.
MANAGED_WRAPPERS = {
    "agent_interface_dashboard.py": "dashboard.py",
    "agent_interface_gateway.py": "gateway_guard.py",
    "agent_interface_computer_host.py": "computer_host.py",
}


REPAIR_FILE_LINES = (b"new file mode ", b"deleted file mode ", b"old mode ", b"new mode ",
    b"rename from ", b"rename to ", b"copy from ", b"copy to ")


def repair_changes(patch):
    """The lines a repair adds and removes, per file and in order. Context and hunk
    positions are excluded, so upstream edits beside a repair do not change it.
    Binary hunks are kept verbatim; a diff without binary content returns None."""
    files, current, binary = {}, None, False
    for line in patch.split(b"\n"):
        if line.startswith(b"diff --git "):
            current, binary = files.setdefault(line, []), False
        elif line.startswith(b"Binary files "):
            return None
        elif binary or line.startswith(b"GIT binary patch"):
            binary = True
            current.append(line)
        elif current is None or line.startswith((b"index ", b"--- ", b"+++ ", b"@@", b"similarity index ", b"dissimilarity index ")):
            continue
        elif line.startswith(REPAIR_FILE_LINES) or line[:1] in (b"+", b"-") or line.startswith(b"\\ No newline"):
            current.append(line)
    return files


def merge_lines(base, ours, theirs):
    """Re-apply ours' edits of base onto theirs, line by line. Each replaced run of
    base lines must survive unchanged and contiguous in theirs; each insertion needs
    both neighbours unchanged and still adjacent. Edits beside a change are fine,
    unlike Git's merge, which treats touching edits as conflicts. None means refuse."""
    mapping = {}
    for tag, i1, i2, j1, _ in difflib.SequenceMatcher(None, base, theirs, autojunk=False).get_opcodes():
        if tag == "equal": mapping.update((i1 + k, j1 + k) for k in range(i2 - i1))
    edits = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, base, ours, autojunk=False).get_opcodes():
        if tag == "equal": continue
        if i2 > i1:
            positions = [mapping.get(index) for index in range(i1, i2)]
            if None in positions or positions != list(range(positions[0], positions[0] + len(positions))): return None
            edits.append((positions[0], positions[-1] + 1, ours[j1:j2]))
        else:
            before = mapping.get(i1 - 1) if i1 else -1
            after = mapping.get(i1) if i1 < len(base) else len(theirs)
            if before is None or after is None or after != before + 1: return None
            edits.append((after, after, ours[j1:j2]))
    merged, boundary = list(theirs), None
    for start, end, replacement in sorted(edits, reverse=True):
        if boundary is not None and end > boundary: return None
        merged[start:end] = replacement; boundary = start
    return merged


def source_state(source, dashboard_target=None):
    revision = git(source, "rev-parse", "HEAD").decode().strip()
    patch = git(source, "diff", "HEAD", "--binary")
    # Runtime bootstrap files are ignored by git. Unknown working files cannot be
    # silently dropped during a source replacement.
    unknown = git(source, "ls-files", "--others", "--exclude-standard").decode().splitlines()
    wrappers = {} if dashboard_target is None else {
        name: Path(dashboard_target).with_name(target) for name, target in MANAGED_WRAPPERS.items()}
    for name in unknown:
        path = Path(source) / name
        if name not in wrappers or not path.is_symlink() or path.resolve() != wrappers[name].resolve():
            raise RuntimeError("Untracked source files require installer review")
    return revision, sha(patch) if patch else None, patch


def integration_digest(app_root):
    module_path = Path(app_root) / "src/hermes/qualification.py"
    spec = importlib.util.spec_from_file_location("upgrade_qualification", module_path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module.integration_digest(Path(app_root))


def dependency_inputs(source, revision):
    paths = git(source, "ls-tree", "-r", "--name-only", revision).decode().splitlines()
    selected = [path for path in paths if Path(path).name in {"pyproject.toml", "uv.lock", "setup.py", "setup.cfg", ".python-version", "Pipfile", "Pipfile.lock"}
        or re.fullmatch(r"(?:requirements|constraints)[^/]*\.(?:txt|lock)", Path(path).name)
        or path == "pm/lock.json" or "runtime_bootstrap" in path or "package_manager" in path]
    return {path: sha(git(source, "show", revision + ":" + path)) for path in selected}


def runtime_fingerprint(python):
    # Keep the original venv launcher path for execution. Resolving it would drop
    # its dependency environment; resolution is used only for the binary hash.
    freeze = subprocess.check_output([python, "-m", "pip", "freeze"], stderr=subprocess.PIPE, timeout=60).decode()
    packages = sorted(line for line in freeze.splitlines() if not line.startswith(("#", "-e")))
    return {"interpreterSha256": sha(Path(python).resolve().read_bytes()), "dependenciesSha256": sha("\n".join(packages).encode())}


class Cancelled(RuntimeError):
    pass


class UnsupportedDependencies(RuntimeError):
    pass


class UnsupportedRepair(RuntimeError):
    pass


class NativeUpdateClaim:
    """Hold the native updater marker across all installation and recovery hooks."""
    def __init__(self, source, home):
        self.path = Path(home) / ".hermes-update-in-progress"
        module_path = Path(source) / "hermes_cli/update_lock.py"
        spec = importlib.util.spec_from_file_location("agent_interface_native_update_lock", module_path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        # Native liveness checks lazily import dependency-free recovery helpers.
        sys.path.insert(0, str(source))
        self.original_bytecode = sys.dont_write_bytecode
        sys.dont_write_bytecode = True
        try:
            spec.loader.exec_module(module)
            if hasattr(module, "_pid_alive"):
                recovery_spec = importlib.util.spec_from_file_location("agent_interface_native_recovery", Path(source) / "hermes_cli/_early_recovery.py")
                recovery = importlib.util.module_from_spec(recovery_spec); recovery_spec.loader.exec_module(recovery)
                # Native's optional import treats failures as a dead holder.
                # Loading it eagerly makes interpreter incompatibility fail closed.
                module._pid_alive = recovery._pid_is_running
        except BaseException:
            sys.path.remove(str(source)); sys.dont_write_bytecode = self.original_bytecode; raise
        self.source_path = str(source)
        self.lock = module.UpdateLock(path=self.path)
        self.failure = None
        self.guardian_pid = None
        self.guardian_fd = None
        self.owner_pid = os.getpid()

    def validate(self):
        if self.guardian_pid and os.waitpid(self.guardian_pid, os.WNOHANG)[0]:
            self.guardian_pid = None
            self.failure = RuntimeError("The native update guardian exited")
        if self.failure is not None: raise RuntimeError("The native updater claim was lost") from self.failure
        marker = private_file(self.path)
        lines = marker.read_text().splitlines()
        if len(lines) != 2 or int(lines[0]) != self.owner_pid or not 0 <= time.time() - float(lines[1]) < 1200:
            raise RuntimeError("The native updater claim changed")

    def refresh(self):
        self.validate()
        # Refresh only the existing owned inode. Never replace another updater's claim.
        fd = os.open(self.path, os.O_RDWR | os.O_NOFOLLOW)
        with os.fdopen(fd, "r+") as output:
            info = os.fstat(output.fileno())
            if info.st_ino != self.path.lstat().st_ino or int(output.readline().strip()) != self.owner_pid:
                raise RuntimeError("The native updater claim changed")
            output.seek(0); output.write(f"{self.owner_pid}\n{int(time.time())}\n"); output.truncate(); output.flush(); os.fsync(output.fileno())

    def __enter__(self):
        try:
            if self.path.exists() or self.path.is_symlink(): private_file(self.path)
            if not self.lock.acquire() or not self.lock.acquired:
                raise RuntimeError("Another updater owns Hermes, or the native updater claim is unavailable")
            self.validate()
            # The marker owner must outlive orphan hooks. Native UpdateLock is a
            # PID marker, not an inherited OS lock, so a dead worker PID is unsafe.
            read_fd, write_fd = os.pipe()
            ready_read, ready_write = os.pipe()
            worker_pid = os.getpid()
            guardian = os.fork()
            if guardian == 0:
                os.close(write_fd); os.close(ready_read)
                try:
                    marker_fd = os.open(self.path, os.O_RDWR | os.O_NOFOLLOW)
                    with os.fdopen(marker_fd, "r+") as output:
                        if int(output.readline().strip()) != worker_pid: raise RuntimeError("Native claim changed during handoff")
                        self.owner_pid = os.getpid()
                        output.seek(0); output.write(f"{self.owner_pid}\n{int(time.time())}\n"); output.truncate(); output.flush(); os.fsync(output.fileno())
                    os.write(ready_write, b"1"); os.close(ready_write)
                    while True:
                        readable, _, _ = select.select([read_fd], [], [], 30)
                        if readable and not os.read(read_fd, 1): break
                        self.refresh()
                    self.lock.release()
                    os._exit(0)
                except BaseException:
                    # Ownership loss must never remove somebody else's marker.
                    os._exit(1)
            os.close(read_fd); os.close(ready_write)
            self.guardian_pid, self.guardian_fd, self.owner_pid = guardian, write_fd, guardian
            try:
                if not select.select([ready_read], [], [], 5)[0] or os.read(ready_read, 1) != b"1":
                    raise RuntimeError("The native update guardian could not start")
            finally: os.close(ready_read)
            self.validate()
            return self
        except BaseException:
            self.close_guardian()
            self.lock.release(); sys.path.remove(self.source_path); sys.dont_write_bytecode = self.original_bytecode; raise

    def close_guardian(self):
        if self.guardian_fd is not None:
            os.close(self.guardian_fd); self.guardian_fd = None
        if self.guardian_pid:
            os.waitpid(self.guardian_pid, 0); self.guardian_pid = None

    def __exit__(self, *_error):
        self.close_guardian()
        self.lock.release()
        sys.path.remove(self.source_path)
        sys.dont_write_bytecode = self.original_bytecode


class Worker:
    def __init__(self, config, state_dir, action, operation):
        self.config = json.loads(private_file(config).read_text())
        self.config_file = Path(config)
        self.directory = Path(state_dir)
        info = self.directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise RuntimeError("Upgrade state directory must be private and owned by the worker")
        self.state_file = self.directory / "status.json"
        self.state = json.loads(private_file(self.state_file).read_text())
        if self.state.get("operationId") != operation:
            raise RuntimeError("Operation was superseded; refusing to run")
        self.action, self.operation = action, operation
        self.app = Path(self.config.get("appRoot", "")).resolve()
        self.source = Path(self.config.get("source", "")).resolve()
        self.log = None
        self.host_hook_started = False
        self.stage = None
        self.native_claim = None
        self.lock_fd = None
        self.recovering = False
        self.release_started = False
        self.environment = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ["HOME"], "LANG": "C.UTF-8"}
        self.environment.update({"HERMES_UPGRADE_SOURCE": str(self.source), "HERMES_UPGRADE_OPERATION_ID": operation})

    def snapshot(self, source):
        return source_state(source, self.app / "src/hermes/dashboard.py")

    def dashboard_link(self):
        links = {}
        for name, target in MANAGED_WRAPPERS.items():
            link = self.source / name
            if not link.is_symlink(): continue
            if link.resolve() != (self.app / "src/hermes" / target).resolve(): raise RuntimeError("Managed Hermes wrapper link changed")
            links[name] = {"target": os.readlink(link), "targetSha256": sha(link.read_bytes())}
        return links or None

    def host_fingerprint(self):
        files = {str(self.config_file): sha(private_file(self.config_file).read_bytes()),
            str(Path(__file__).resolve()): sha(Path(__file__).read_bytes())}
        if self.config.get("approvedPatchFile"):
            path = private_file(self.config["approvedPatchFile"])
            files[str(path)] = sha(path.read_bytes())
        # Native release facts affect requires_hermes and PM plugin selection.
        files["git:" + str(self.source) + ":refs/tags"] = sha(json.dumps(git_tag_refs(self.source)).encode())
        files["git:" + str(self.source) + ":history"] = sha(complete_history(self.source))
        if self.config.get("managedLauncher"):
            utility = self.app / "scripts/hermes-qualified-python.py"
            files[str(utility)] = sha(utility.read_bytes())
        commands = self.config["hooks"]
        for argv in [*commands["regressions"], *[commands[key] for key in ("quiescence", "backup", "install", "verify", "rollback", "finish")]]:
            for arg in argv:
                path = Path(arg)
                if path.is_absolute() and path.is_file(): files[str(path)] = sha(path.read_bytes())
        for filename in self.config.get("qualificationFiles", []):
            path = private_file(filename)
            if not path.is_absolute(): raise RuntimeError("Qualification dependency paths must be absolute")
            files[str(path)] = sha(path.read_bytes())
        return files

    def managed_fingerprint(self, python):
        utility = self.app / "scripts/hermes-qualified-python.py"
        spec = importlib.util.spec_from_file_location("hermes_qualified_python", utility)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module; spec.loader.exec_module(module)
        return module.fingerprint(python)

    def qualified_fingerprint(self, qualification):
        if qualification.get("runtimeMode") == "managed": return self.managed_fingerprint(qualification["qualificationPython"])
        return runtime_fingerprint(qualification["qualificationPython"])

    def retain_qualification_stages(self):
        """Keep two completed probe stages. Recovery backups are never pruned."""
        root = Path(self.config["stageRoot"])
        if not root.exists(): return
        info = root.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077: return
        completed = []
        protected = self.state.get("qualification", {}).get("stage") if self.state.get("phase") == "ready" else None
        for stage in root.glob("qualification-*"):
            try:
                identifier = stage.name.removeprefix("qualification-")
                uuid.UUID(identifier)
                info = stage.lstat()
                if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077: continue
                if (stage / "backup").exists() or (stage / "backup").is_symlink() or (stage / ".agent-interface-upgrade-install").exists(): continue
                marker = private_file(stage / ".agent-interface-upgrade-stage")
                record = json.loads(marker.read_text())
                if record.get("schemaVersion") != 1 or record.get("operationId") != identifier or record.get("state") != "completed": continue
                completed.append((marker.stat().st_mtime_ns, stage))
            except (OSError, ValueError, RuntimeError): continue
        completed.sort(reverse=True)
        keep = {stage for _, stage in completed[:2]}
        if protected: keep.add(Path(protected))
        for _, stage in completed:
            if stage not in keep: shutil.rmtree(stage)

    def validate_config(self):
        for key in ["source", "qualificationPython", "appRoot", "stageRoot", "qualificationReceipt"]:
            if not isinstance(self.config.get(key), str) or not Path(self.config[key]).is_absolute():
                raise RuntimeError("Installer paths must be absolute")
        if self.config.get("managedLauncher") or self.config.get("managedHome"):
            for key in ("managedLauncher", "managedHome"):
                if not isinstance(self.config.get(key), str) or not Path(self.config[key]).is_absolute(): raise RuntimeError("Managed qualification requires an absolute launcher and Hermes home")
        if self.config.get("approvedPatchFile") is not None:
            path = self.config["approvedPatchFile"]
            if not isinstance(path, str) or not Path(path).is_absolute(): raise RuntimeError("Approved repair path must be fixed and absolute")
            private_file(path)
            if not re.fullmatch(r"[a-f0-9]{64}", str(self.config.get("requiredPatchSha256", ""))): raise RuntimeError("Approved repair requires an exact original artifact hash")
        if self.config.get("upstreamRef", "refs/remotes/origin/main") != "refs/remotes/origin/main":
            raise RuntimeError("Only the trusted upstream main branch is supported")
        remote = git(self.source, "remote", "get-url", "origin").decode().strip().removesuffix(".git")
        if remote != "https://github.com/NousResearch/hermes-agent":
            raise RuntimeError("Installed source must use the official HTTPS upstream")
        hooks = self.config.get("hooks", {})
        def command(value):
            return isinstance(value, list) and value and all(isinstance(arg, str) and "\0" not in arg for arg in value) and Path(value[0]).is_absolute()
        for name in ["quiescence", "backup", "install", "verify", "rollback", "finish"]:
            if not command(hooks.get(name)): raise RuntimeError("Missing fixed installer hook: " + name)
        regressions = hooks.get("regressions")
        if not isinstance(regressions, list) or not regressions or not all(command(argv) for argv in regressions):
            raise RuntimeError("Host regression tests are mandatory")

    def update(self, **fields):
        current = json.loads(self.state_file.read_text())
        if current.get("operationId") != self.operation: raise RuntimeError("Operation was superseded")
        # Optional wire fields are omitted when cleared. JSON null would fail
        # readers expecting an optional string and strand verified recovery.
        if "error" in fields and fields["error"] is None:
            fields.pop("error")
            self.state.pop("error", None)
        self.state.update(fields, workerPid=os.getpid(), updatedAt=now())
        atomic(self.state_file, self.state)

    def intent(self):
        path = self.directory / "controls" / (self.operation + ".json")
        return json.loads(private_file(path).read_text()) if path.exists() else None

    def cancellation(self):
        intent = self.intent()
        if not self.recovering and not self.release_started and intent and intent.get("status") == "pending" and intent.get("action") == "cancel":
            raise Cancelled("The administrator cancelled this update")

    def complete_control(self):
        intent = self.intent()
        if not intent or intent.get("status") != "pending": return
        intent.update(status="complete", result=self.state)
        atomic(self.directory / "controls" / (self.operation + ".json"), intent)
        atomic(self.directory / "controls" / ("request-" + intent["requestId"] + ".json"), intent)

    def check_step(self, identifier, label, work):
        self.cancellation()
        checks = self.state.setdefault("checks", [])
        item = next((item for item in checks if item["id"] == identifier), None)
        if item is None:
            item = {"id": identifier, "label": label}; checks.append(item)
        item["status"] = "running"; self.update(checks=checks)
        try: result = work()
        except Exception as error:
            # Explained refusals say why on the check itself; others point at the private log.
            item["status"] = "failed"
            item["detail"] = str(error) if isinstance(error, (UnsupportedRepair, UnsupportedDependencies)) else "Details are in the update's private log."
            self.update(checks=checks); raise
        item["status"] = "passed"; self.update(checks=checks)
        self.cancellation()
        return result

    def run(self, argv, cwd=None, environment=None, timeout=1800):
        subprocess.run(argv, cwd=cwd or self.app, env=environment or self.environment,
            stdout=self.log, stderr=subprocess.STDOUT, check=True, timeout=timeout,
            pass_fds=tuple(fd for fd in (self.lock_fd, self.native_claim.guardian_fd if self.native_claim else None) if fd is not None))

    def hook(self, name):
        if self.native_claim: self.native_claim.validate()
        argv = self.config["hooks"].get(name)
        if argv is None and name in ("recover", "restart_service"):
            finish = self.config["hooks"]["finish"]
            if finish[-1] != "finish" or not any(arg.endswith("/hermes-upgrade-linux.py") for arg in finish):
                raise RuntimeError("This installer has not enabled safe recovery hooks")
            argv = [*finish[:-1], name]
        self.environment["HERMES_UPGRADE_LOCK_FD"] = str(self.lock_fd) if self.lock_fd is not None else ""
        self.environment["HERMES_UPGRADE_CLAIM_FD"] = str(self.native_claim.guardian_fd) if self.native_claim and self.native_claim.guardian_fd is not None else ""
        self.run(argv, timeout=self.config.get("hookTimeoutSeconds", 1800))
        if self.native_claim: self.native_claim.validate()

    def revision(self, value):
        return {"revision": value, "version": value[:12], "notesUrl": "https://github.com/NousResearch/hermes-agent/commit/" + value}

    def stage_source(self, source, candidate):
        # Installed checkouts may be promisor clones. Sharing their object store
        # loses lazy-fetch ownership and also couples retained stages to live GC.
        # Fetch the exact trusted commit into a complete independent repository.
        if not re.fullmatch(r"[a-f0-9]{40}", candidate):
            raise RuntimeError("Staging requires an exact trusted Git revision")
        complete_history(self.source)
        tags = git_tag_refs(self.source)
        self.run(["git", "init", str(source)])
        self.run(["git", "-C", str(source), "remote", "add", "origin", OFFICIAL_UPSTREAM])
        # Full ancestry and installed tag object identities preserve native
        # version and plugin compatibility decisions. Never fetch moving tags.
        objects = [candidate, *sorted({identity for _, identity in tags} - {candidate})]
        self.run(["git", "-C", str(source), "fetch", "--no-tags", "--no-filter", "origin", *objects], timeout=180)
        for ref, identity in tags:
            self.run(["git", "-C", str(source), "update-ref", ref, identity])
        self.run(["git", "-C", str(source), "checkout", "--detach", candidate])
        if git(source, "rev-parse", "HEAD").decode().strip() != candidate:
            raise RuntimeError("Staged source differs from the exact trusted candidate")

    def approved_repair(self, revision, actual_hash, actual_patch):
        filename = self.config.get("approvedPatchFile")
        if filename is None:
            if actual_hash != self.config.get("requiredPatchSha256"):
                raise UnsupportedRepair("The installed Hermes repair differs from the approved repair. Ask the installer to review it before updating.")
            return actual_patch
        patch = private_file(filename).read_bytes()
        if sha(patch) != self.config["requiredPatchSha256"]:
            raise UnsupportedRepair("The approved Hermes repair file changed. Ask the installer to restore its reviewed copy.")
        # Compare exact tracked trees, not regenerated diff headers. Copy only
        # the captured commit's tree/blob closure. Live alternates can freshen
        # object mtimes even with a separate writable object directory.
        with tempfile.TemporaryDirectory(prefix="agent-interface-repair-proof-") as temporary:
            root = Path(temporary); repository = root / "repository"
            environment = dict(self.environment, GIT_NO_LAZY_FETCH="1", GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0")
            def read_source(*args):
                return subprocess.check_output(["git", "-C", str(self.source), *args], env=environment, stderr=subprocess.PIPE, timeout=60)
            def tree(name, data):
                env = dict(environment, GIT_INDEX_FILE=str(root / name))
                def command(*args, input=None):
                    return subprocess.check_output(["git", "--git-dir", str(repository), *args], input=input,
                        env=env, stderr=subprocess.PIPE, timeout=60)
                command("read-tree", revision)
                if data: command("apply", "--cached", "--binary", "-", input=data)
                return command("write-tree")
            try:
                subprocess.run(["git", "init", "--bare", str(repository)], env=environment,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=60)
                root_tree = read_source("rev-parse", revision + "^{tree}").decode().strip()
                rows = read_source("ls-tree", "-r", "-t", "--format=%(objecttype) %(objectname)", revision).decode().splitlines()
                objects = {revision, root_tree, *(identity for kind, identity in (row.split(" ") for row in rows) if kind in ("tree", "blob"))}
                with (root / "snapshot.pack").open("xb") as output:
                    def bounded_pack(): resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_REPAIR_SNAPSHOT_PACK_BYTES, MAX_REPAIR_SNAPSHOT_PACK_BYTES))
                    subprocess.run(["git", "-C", str(self.source), "pack-objects", "--stdout"],
                        input=("\n".join(sorted(objects)) + "\n").encode(), env=environment, stdout=output,
                        stderr=subprocess.PIPE, check=True, timeout=180, preexec_fn=bounded_pack)
                with (root / "snapshot.pack").open("rb") as payload:
                    subprocess.run(["git", "--git-dir", str(repository), "index-pack", "--stdin"], stdin=payload,
                        env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=180)
                expected = tree("expected-index", patch)
                actual = tree("actual-index", actual_patch)
            except subprocess.CalledProcessError as error:
                expected = actual = None
                proof_error = error
            else:
                proof_error = None
            if expected != actual or proof_error:
                # A previous update may have re-applied the repair over upstream edits
                # beside it. Accept that only when its changed lines are identical.
                approved_changes = repair_changes(patch)
                if approved_changes is None or repair_changes(actual_patch) != approved_changes:
                    if proof_error: raise UnsupportedRepair("The approved Hermes repair needs installer review before this version can be updated.") from proof_error
                    raise UnsupportedRepair("The installed Hermes files differ from the approved repair. Ask the installer to review them before updating.")
        self.environment.update({"HERMES_UPGRADE_APPROVED_PATCH_FILE": filename,
            "HERMES_UPGRADE_APPROVED_PATCH_SHA256": self.config["requiredPatchSha256"]})
        return patch

    def merge_repair(self, target, current, candidate):
        """Carry the installed repair onto a staged candidate whose upstream edited lines
        beside it. Uses the installed files, already proven against the approved artifact."""
        def blob(repository, revision, path):
            listed = git(repository, "ls-tree", "-z", revision, "--", path).split(b"\0")[0]
            if not listed: return None, None
            mode, _, identity = listed.split(b"\t")[0].split(b" ")
            return mode, git(repository, "cat-file", "blob", identity.decode())
        entries = git(self.source, "diff", "HEAD", "--name-status", "--no-renames", "-z").split(b"\0")
        changes = list(zip(entries[0::2], entries[1::2]))
        if not changes: return False
        for status, raw in changes:
            path = raw.decode()
            ours = (self.source / path).read_bytes()
            base_mode, base = blob(self.source, current, path)
            their_mode, theirs = blob(target, candidate, path)
            if status == b"A":
                # An added repair file may not collide with a different upstream file.
                if theirs is not None and theirs != ours: return False
                merged = ours
            elif status == b"M":
                if theirs is None or their_mode != base_mode: return False
                if theirs == base: merged = ours
                elif b"\0" in base + ours + theirs: return False
                else:
                    lines = merge_lines(base.splitlines(True), ours.splitlines(True), theirs.splitlines(True))
                    if lines is None: return False
                    merged = b"".join(lines)
            else:
                return False
            destination = target / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(merged)
            destination.chmod((self.source / path).stat().st_mode & 0o777)
            self.run(["git", "-C", str(target), "add", "--", path])
        return True

    def qualify(self):
        self.update(phase="checking", message="Checking Hermes and preserving the current repair.", checks=[], maintenance=False)
        current, current_patch, patch = self.check_step("source", "Current source and shared OAuth repair", lambda: self.snapshot(self.source))
        dashboard_link = self.dashboard_link()
        host_fingerprint = self.host_fingerprint()
        patch = self.check_step("repair", "Exact approved repair provenance", lambda: self.approved_repair(current, current_patch, patch))
        self.update(current=self.revision(current))
        digest = integration_digest(self.app)
        def fetch():
            self.run(["git", "-C", str(self.source), "fetch", "--no-tags", "origin", "main:refs/remotes/origin/main"], timeout=180)
            candidate = git(self.source, "rev-parse", "refs/remotes/origin/main").decode().strip()
            self.run(["git", "-C", str(self.source), "merge-base", "--is-ancestor", current, candidate])
            return candidate
        candidate = self.check_step("upstream", "Trusted upstream update", fetch)
        self.update(candidate=self.revision(candidate))
        if candidate == current:
            self.state.pop("candidate", None)
            self.update(phase="idle", message="Hermes is up to date.", checkedAt=now()); return
        def dependencies():
            if dependency_inputs(self.source, current) != dependency_inputs(self.source, candidate):
                raise UnsupportedDependencies("This Hermes update changes its dependencies. The installer must qualify a separate managed runtime before it can be installed.")
            return runtime_fingerprint(self.config["qualificationPython"])
        managed = bool(self.config.get("managedLauncher"))
        runtime = None if managed else self.check_step("dependencies", "Unchanged dependency inputs and tested interpreter", dependencies)
        qualified_python = self.config["qualificationPython"]
        runtime_descriptor = None
        stage_root = Path(self.config["stageRoot"])
        stage_root.mkdir(parents=True, mode=0o700, exist_ok=True)
        stage = stage_root / ("qualification-" + self.operation); stage.mkdir(mode=0o700)
        self.stage = stage
        atomic(stage / ".agent-interface-upgrade-stage", {"schemaVersion": 1, "operationId": self.operation, "state": "active", "createdAt": now()})
        (stage / ".agent-interface-isolated").write_text("agent-interface-disposable-spike")
        source = stage / "source"
        self.environment.update({"HERMES_UPGRADE_CANDIDATE": candidate, "HERMES_UPGRADE_STAGE_HOME": str(stage),
            "HERMES_UPGRADE_STAGE_SOURCE": str(source), "HERMES_UPGRADE_RECEIPT": str(stage / "qualification.json"),
            "HERMES_UPGRADE_BACKUP_DIR": str(stage / "backup")})
        def prepare():
            self.stage_source(source, candidate)
            rebased = False
            if patch:
                patch_path = stage / "preserved.patch"; patch_path.write_bytes(patch); patch_path.chmod(0o600)
                try: self.run(["git", "-C", str(source), "apply", "--index", str(patch_path)])
                except subprocess.CalledProcessError as error:
                    # Upstream may have edited lines beside the repair, such as a linter
                    # rewriting a signature. Only an approved artifact may be merged, and
                    # only when the merge leaves the repair's own lines unchanged.
                    if not self.config.get("approvedPatchFile") or repair_changes(patch) is None:
                        raise UnsupportedRepair("The approved Hermes repair cannot be applied to this update. Ask the installer to review it before updating.") from error
                    if not self.merge_repair(source, current, candidate):
                        raise UnsupportedRepair("Hermes changed the code the approved repair edits, so it cannot be applied to this update. Ask the installer to review it before updating.") from error
                    rebased = True
            actual, patch_hash, candidate_diff = self.snapshot(source)
            if actual != candidate or not self.config.get("approvedPatchFile") and patch_hash != current_patch:
                raise UnsupportedRepair("The shared Hermes repair changed on the candidate. Ask the installer to review it before updating.")
            if self.config.get("approvedPatchFile") and patch and repair_changes(candidate_diff or b"") != repair_changes(patch):
                raise UnsupportedRepair("Re-applying the approved repair to this update changed its edits. Ask the installer to review it before updating.")
            if rebased:
                print("Approved repair re-applied over upstream edits beside it; its changed lines are identical.", file=self.log, flush=True)
            self.repair_rebased = rebased
            return patch_hash
        self.repair_rebased = False
        candidate_patch = self.check_step("staging", "Disposable target and unchanged OAuth repair", prepare)
        if self.repair_rebased:
            checks = self.state["checks"]
            next(item for item in checks if item["id"] == "staging")["detail"] = "Re-applied over nearby upstream edits. The repair's own changes are identical."
            self.update(checks=checks)
        if candidate_patch: self.environment["HERMES_UPGRADE_CANDIDATE_PATCH_SHA256"] = candidate_patch
        if managed:
            def prepare_dependencies():
                result = subprocess.run([self.config["qualificationPython"], str(self.app / "scripts/hermes-qualified-python.py"), "prepare",
                    "--source", str(source), "--stage", str(stage), "--launcher", self.config["managedLauncher"],
                    "--installed-source", str(self.source), "--installed-home", self.config["managedHome"]], cwd=self.app,
                    env=self.environment, stdout=subprocess.PIPE, stderr=self.log, check=True,
                    timeout=self.config.get("qualificationTimeoutSeconds", 3600), text=True)
                prepared = json.loads(result.stdout)
                for key in ("python", "descriptor"):
                    path = private_file(prepared[key])
                    if not path.is_absolute() or path.parent.resolve() != stage.resolve(): raise RuntimeError("Prepared runtime escaped its marked stage")
                if self.managed_fingerprint(prepared["python"]) != prepared["fingerprint"]: raise RuntimeError("Prepared dependency fingerprint does not match actual activation")
                return prepared
            prepared = self.check_step("dependencies", "Isolated native managed dependency generation", prepare_dependencies)
            qualified_python, runtime_descriptor, runtime = prepared["python"], prepared["descriptor"], prepared["fingerprint"]
        self.environment["HERMES_UPGRADE_QUALIFICATION_PYTHON"] = qualified_python
        self.environment["HERMES_UPGRADE_RUNTIME_FINGERPRINT"] = json.dumps(runtime)
        if runtime_descriptor: self.environment["HERMES_UPGRADE_RUNTIME_DESCRIPTOR"] = runtime_descriptor
        self.update(phase="qualifying", message="Testing the update in a separate Hermes home. Your running Hermes is unchanged.")
        isolated_app = stage / "app"; isolated_app.mkdir()
        for directory in ["src", "scripts"]:
            shutil.copytree(self.app / directory, isolated_app / directory)
        (isolated_app / "docs/evidence").mkdir(parents=True)
        for name in ["package.json", "package-lock.json", "tsconfig.json"]:
            shutil.copy2(self.app / name, isolated_app / name)
        (isolated_app / "node_modules").symlink_to(self.app / "node_modules", target_is_directory=True)
        command = [qualified_python, str(isolated_app / "scripts/spike/run.py"),
            "--qualification", "--revision", candidate, "--source", str(source), "--python", qualified_python]
        if candidate_patch: command.extend(["--source-patch-sha256", candidate_patch])
        self.check_step("integration", "Real isolated Hermes integration and recovery", lambda: self.run(command, cwd=isolated_app, timeout=self.config.get("qualificationTimeoutSeconds", 3600)))
        def regressions():
            for argv in self.config["hooks"]["regressions"]: self.run(argv)
        self.check_step("regressions", "Host OAuth, Google authentication and profile regressions", regressions)
        if self.snapshot(self.source)[:2] != (current, current_patch) or self.snapshot(source)[:2] != (candidate, candidate_patch) or git_tag_refs(source) != git_tag_refs(self.source) or integration_digest(self.app) != digest or self.dashboard_link() != dashboard_link or self.host_fingerprint() != host_fingerprint:
            raise RuntimeError("Qualification inputs changed while tests were running")
        if (self.managed_fingerprint(qualified_python) if managed else runtime_fingerprint(qualified_python)) != runtime:
            raise RuntimeError("The dependency environment changed during qualification")
        receipt = {"schemaVersion": 1, "revision": candidate, "trackedPatchSha256": candidate_patch,
            "integrationDigest": digest, "qualifiedAt": now(), "checks": {"realIntegration": True, "hostRegressions": True}}
        atomic(stage / "qualification.json", receipt)
        self.update(phase="ready", message="The Hermes update passed its checks and is ready to install.", checkedAt=now(),
            qualification={"stage": str(stage), "currentRevision": current, "currentPatchSha256": current_patch,
                "candidateRevision": candidate, "candidatePatchSha256": candidate_patch, "integrationDigest": digest, "runtimeFingerprint": runtime,
                "qualificationPython": qualified_python, "runtimeMode": "managed" if managed else "venv",
                "runtimeDescriptor": runtime_descriptor, "dashboardLink": dashboard_link, "hostFingerprint": host_fingerprint,
                "tagRefs": git_tag_refs(source)})

    def configure_install(self, qualification):
        stage = Path(qualification["stage"])
        if stage.parent.resolve() != Path(self.config["stageRoot"]).resolve(): raise RuntimeError("Invalid qualification stage")
        old = (qualification["currentRevision"], qualification["currentPatchSha256"])
        target = (qualification["candidateRevision"], qualification["candidatePatchSha256"])
        self.environment.update({"HERMES_UPGRADE_CURRENT": old[0], "HERMES_UPGRADE_CANDIDATE": target[0], "HERMES_UPGRADE_STAGE_HOME": str(stage),
            "HERMES_UPGRADE_STAGE_SOURCE": str(stage / "source"), "HERMES_UPGRADE_RECEIPT": str(stage / "qualification.json"),
            "HERMES_UPGRADE_BACKUP_DIR": str(stage / "backup"), "HERMES_UPGRADE_QUALIFICATION_PYTHON": qualification["qualificationPython"],
            "HERMES_UPGRADE_RUNTIME_FINGERPRINT": json.dumps(qualification["runtimeFingerprint"]),
            "HERMES_UPGRADE_INTEGRATION_DIGEST": integration_digest(self.app)})
        if self.config.get("approvedPatchFile"):
            self.environment.update({"HERMES_UPGRADE_APPROVED_PATCH_FILE": self.config["approvedPatchFile"], "HERMES_UPGRADE_APPROVED_PATCH_SHA256": self.config["requiredPatchSha256"]})
        if target[1]: self.environment["HERMES_UPGRADE_CANDIDATE_PATCH_SHA256"] = target[1]
        if qualification.get("runtimeDescriptor"): self.environment["HERMES_UPGRADE_RUNTIME_DESCRIPTOR"] = qualification["runtimeDescriptor"]
        return stage, old, target

    def recovery(self, action):
        self.recovering = True
        try:
            if self.state.get("maintenance"):
                qualification = self.state["qualification"]
                stage, old, target = self.configure_install(qualification)
                journal_path = stage / "recovery.json"
                journal = json.loads(private_file(journal_path).read_text()) if journal_path.exists() else None
                if journal and journal.get("operationId") != self.operation: raise RuntimeError("Recovery journal belongs to another update")
                if journal and journal.get("releaseStarted"): raise RuntimeError("Admission release may already have happened. Installer review is required before restarting or restoring Hermes")
                platform = stage / "platform.json"
                unstarted = not journal and not platform.exists() and not any(check["id"] in ("quiescence", "backup", "install") for check in self.state.get("checks", []))
                if unstarted or journal and not journal.get("hostHookStarted"):
                    self.update(maintenance=False)
                else:
                    self.host_hook_started = True
                    self.update(phase="recovering", maintenance=True, message="Recovering Hermes under its saved maintenance gate. Conversations remain paused until verification succeeds.")
                    if action != "restart_service":
                        if journal:
                            previous = journal.get("previousReceipt")
                            if previous is None: raise RuntimeError("The previous installation has no saved qualification receipt")
                            self.environment["HERMES_UPGRADE_PREVIOUS_RECEIPT"] = str(stage / "previous-qualification.json")
                            data = base64.b64decode(previous, validate=True)
                            receipt = json.loads(data)
                            if receipt.get("revision") != old[0] or receipt.get("trackedPatchSha256") != old[1] or receipt.get("integrationDigest") != integration_digest(self.app):
                                raise RuntimeError("The previous qualification receipt does not match the saved baseline and current integration")
                            atomic(stage / "previous-qualification.json", receipt)
                    source = self.source if self.source.exists() else stage / "source"
                    if self.native_claim:
                        self.hook("restart_service" if action == "restart_service" else "recover")
                    elif self.config.get("managedLauncher"):
                        with NativeUpdateClaim(source, self.config["managedHome"]) as claim:
                            self.native_claim = claim
                            self.environment["HERMES_UPDATE_HANDOFF_PID"] = str(claim.owner_pid)
                            try: self.hook("restart_service" if action == "restart_service" else "recover")
                            finally: self.native_claim = None
                    else: self.hook("restart_service" if action == "restart_service" else "recover")
                    current = self.snapshot(self.source)
                    self.update(current=self.revision(current[0]), maintenance=False)
            self.update(phase="cancelled" if action == "cancel" else "succeeded", maintenance=False,
                message="The update was cancelled. Hermes is verified and ready." if action == "cancel" else "Hermes is verified and ready.", error=None)
            self.complete_request(); self.complete_control()
            if action == "retry":
                # Retrying means a new qualification, never replaying an install.
                self.operation = str(uuid.uuid4())
                self.state = {"operationId": self.operation, "phase": "checking", "checks": [], "message": "Checking the update again."}
                atomic(self.state_file, self.state)
                self.environment["HERMES_UPGRADE_OPERATION_ID"] = self.operation
                self.recovering = False
                self.qualify()
        finally: self.recovering = False

    def install(self):
        if self.config.get("managedLauncher"):
            with NativeUpdateClaim(self.source, self.config["managedHome"]) as claim:
                self.native_claim = claim
                self.environment["HERMES_UPDATE_HANDOFF_PID"] = str(claim.owner_pid)
                try: self.install_claimed()
                finally: self.native_claim = None
        else: self.install_claimed()

    def install_claimed(self):
        qualification = self.state["qualification"]
        stage = Path(qualification["stage"])
        if stage.parent.resolve() != Path(self.config["stageRoot"]).resolve(): raise RuntimeError("Invalid qualification stage")
        receipt = json.loads(private_file(stage / "qualification.json").read_text())
        old = (qualification["currentRevision"], qualification["currentPatchSha256"])
        target = (qualification["candidateRevision"], qualification["candidatePatchSha256"])
        expected = {"schemaVersion": 1, "revision": target[0], "trackedPatchSha256": target[1],
            "integrationDigest": qualification["integrationDigest"], "checks": {"realIntegration": True, "hostRegressions": True}}
        if any(receipt.get(key) != value for key, value in expected.items()) or not receipt.get("qualifiedAt"):
            raise RuntimeError("The target is not fully qualified")
        if git_tag_refs(stage / "source") != qualification["tagRefs"]:
            raise RuntimeError("The staged native version tags changed after qualification")
        if self.state.get("candidate", {}).get("revision") != target[0] or self.snapshot(self.source)[:2] != old or self.snapshot(stage / "source")[:2] != target or integration_digest(self.app) != receipt["integrationDigest"] or self.dashboard_link() != qualification.get("dashboardLink") or self.host_fingerprint() != qualification["hostFingerprint"]:
            raise RuntimeError("Qualification is stale; check this update again")
        if self.qualified_fingerprint(qualification) != qualification["runtimeFingerprint"]:
            raise RuntimeError("The tested dependency environment changed; qualify it again")
        self.configure_install(qualification)
        deployed_receipt = Path(self.config["qualificationReceipt"])
        previous_receipt = private_file(deployed_receipt).read_bytes() if deployed_receipt.exists() else None
        atomic(stage / ".agent-interface-upgrade-install", {"operationId": self.operation, "requestId": self.state["requestId"], "startedAt": now()})
        journal = {"operationId": self.operation, "requestId": self.state["requestId"],
            "previousReceipt": base64.b64encode(previous_receipt).decode() if previous_receipt is not None else None,
            "hostHookStarted": False, "installStarted": False, "releaseStarted": False}
        atomic(stage / "recovery.json", journal)
        attempted = False
        lease = False
        release_started = False
        try:
            self.cancellation()
            def acquire():
                journal["hostHookStarted"] = True; atomic(stage / "recovery.json", journal)
                self.host_hook_started = True
                return self.hook("quiescence")
            self.check_step("quiescence", "No active native Hermes work", acquire); lease = True
            if self.snapshot(self.source)[:2] != old or integration_digest(self.app) != receipt["integrationDigest"] or self.dashboard_link() != qualification.get("dashboardLink") or self.host_fingerprint() != qualification["hostFingerprint"]:
                raise RuntimeError("The running source changed before installation")
            self.check_step("backup", "Recoverable source, runtime and household backup", lambda: self.hook("backup"))
            self.update(phase="installing", maintenance=True, message="Installing Hermes. Your conversations and settings are backed up.")
            attempted = True
            journal["installStarted"] = True; atomic(stage / "recovery.json", journal)
            atomic(deployed_receipt, receipt)
            self.check_step("install", "Managed Hermes installation", lambda: self.hook("install"))
            self.update(phase="verifying", message="Checking Hermes and both household profiles after installation.")
            def verify():
                if self.snapshot(self.source)[:2] != target or self.dashboard_link() != qualification.get("dashboardLink"): raise RuntimeError("Installed source differs from qualified source")
                self.hook("verify")
            self.check_step("verify", "Original sign-in, profiles, services and fresh connections", verify)
            self.update(current=self.revision(target[0]))
            self.cancellation()
            release_started = True
            self.release_started = True
            journal["releaseStarted"] = True; atomic(stage / "recovery.json", journal)
            self.check_step("release", "Resume household Hermes work", lambda: self.hook("finish")); lease = False
            self.update(phase="succeeded", maintenance=False, current=self.revision(target[0]), message="Hermes is updated and ready.")
        except Cancelled:
            self.recovery("cancel")
            return
        except Exception as install_error:
            self.recovering = True # Rollback is already the safe response to a pending cancellation.
            if release_started:
                # A timed-out release may already admit native/Discord work.
                # Never kill that work by guessing it is safe to roll back.
                raise
            if attempted:
                self.update(phase="verifying", maintenance=True, message="The update did not pass verification. Restoring the previous Hermes installation.")
                def rollback():
                    if previous_receipt is None: deployed_receipt.unlink(missing_ok=True)
                    else:
                        temporary = deployed_receipt.with_suffix(".restore.tmp")
                        temporary.write_bytes(previous_receipt); temporary.chmod(0o600); temporary.replace(deployed_receipt)
                    self.hook("rollback")
                    if self.snapshot(self.source)[:2] != old or self.dashboard_link() != qualification.get("dashboardLink"): raise RuntimeError("Rollback did not restore the exact source and repair")
                    self.environment["HERMES_UPGRADE_ROLLBACK"] = "1"
                    self.hook("verify")
                self.check_step("rollback", "Restore and verify the previous Hermes installation", rollback)
                self.release_started = True
                journal["releaseStarted"] = True; atomic(stage / "recovery.json", journal)
                self.check_step("release", "Resume the restored Hermes installation", lambda: self.hook("finish")); lease = False
                self.update(phase="rolled_back", maintenance=False, current=self.revision(old[0]), message="The update could not be verified. The previous Hermes is restored and ready.", error="upgrade_rolled_back")
            else:
                if not lease and not (isinstance(install_error, subprocess.CalledProcessError) and install_error.returncode == 75):
                    raise
                if lease:
                    self.release_started = True
                    journal["releaseStarted"] = True; atomic(stage / "recovery.json", journal)
                    self.hook("finish"); lease = False
                self.update(phase="blocked", maintenance=False, message="The update was stopped before installation. Check again after the installer resolves the failed check.", error="install_precondition_failed")
        self.complete_request()

    def complete_request(self):
        if self.state.get("requestId") and not self.state.get("maintenance"):
            request = self.directory / "requests" / (self.state["requestId"] + ".json")
            record = json.loads(private_file(request).read_text())
            if record.get("operationId") != self.operation: raise RuntimeError("Install receipt belongs to another update")
            record.update(status="complete", result=self.state)
            atomic(request, record)

    def main(self):
        fd = os.open(self.directory / "worker.lock", os.O_RDWR | os.O_CREAT, 0o600)
        with os.fdopen(fd, "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.lock_fd = lock.fileno()
            # Read again under ownership. A delayed launch must never replay a completed operation.
            self.state = json.loads(private_file(self.state_file).read_text())
            if self.state.get("operationId") != self.operation: raise RuntimeError("Operation was superseded")
            if self.action in ("check", "install") and self.state.get("phase") not in ("checking", "installing"): return
            if self.action in ("retry", "cancel", "restart_service") and not (self.intent() or {}).get("status") == "pending": return
            log_path = self.directory / (self.operation + "-" + uuid.uuid4().hex + ".log")
            log_fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(log_fd, "w") as output:
                self.log = output
                self.update()
                try:
                    self.validate_config()
                    if self.action == "check": self.qualify()
                    elif self.action == "install": self.install()
                    else: self.recovery(self.action)
                    self.cancellation()
                    self.complete_control()
                except Cancelled:
                    self.update(phase="cancelled", maintenance=False, error=None, message="The update check was cancelled. Hermes was unchanged.")
                    self.complete_control()
                except Exception as error:
                    import traceback
                    traceback.print_exc(file=output)
                    safe_rejection = self.action == "install" and not self.host_hook_started
                    unsupported = isinstance(error, (UnsupportedDependencies, UnsupportedRepair))
                    checking = self.action == "check" or self.state.get("phase") in ("checking", "qualifying")
                    self.update(phase="blocked" if safe_rejection or unsupported else "failed", error="repair_requires_review" if isinstance(error, UnsupportedRepair) else "dependencies_require_qualification" if unsupported else "qualification_failed" if checking else "qualification_stale" if safe_rejection else "install_requires_review",
                        message=str(error) if unsupported else "The update check failed. Ask the installer to review its private log." if checking
                        else "The qualified update changed before installation. Check again before installing it." if safe_rejection
                        else "The update stopped without a verified recovery. Hermes changes stay paused until the installer reviews it.",
                        maintenance=bool(self.state.get("maintenance")) and not safe_rejection)
                    self.complete_request()
                    self.complete_control()
                    raise
                finally:
                    if self.stage:
                        marker = json.loads((self.stage / ".agent-interface-upgrade-stage").read_text())
                        marker.update(state="completed", completedAt=now())
                        atomic(self.stage / ".agent-interface-upgrade-stage", marker)
                        # Retention failure must not invalidate a successful probe.
                        try: self.retain_qualification_stages()
                        except OSError:
                            import traceback
                            traceback.print_exc(file=output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--action", choices=["check", "install", "retry", "cancel", "restart_service"], required=True)
    parser.add_argument("--operation-id", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    Worker(args.config, args.state_dir, args.action, args.operation_id).main()


if __name__ == "__main__": main()
