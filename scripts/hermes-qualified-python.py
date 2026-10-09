#!/usr/bin/env python3
"""Build and inspect a real Hermes PM generation without borrowing live dependencies."""
from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import re
import runpy
import shlex
import shutil
import site
import stat
import subprocess
import traceback
import sys
import urllib.parse
import uuid


def sha(data):
    return hashlib.sha256(data).hexdigest()


def source_identity(source):
    revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], stderr=subprocess.PIPE).decode().strip()
    if len(revision) != 40 or any(character not in "0123456789abcdef" for character in revision):
        raise RuntimeError("Managed source must have an exact Git revision")
    patch = subprocess.check_output(["git", "-C", str(source), "diff", "HEAD", "--binary"], stderr=subprocess.PIPE)
    return {"revision": revision, "patchSha256": sha(patch)}


def ignored(directory, names):
    excluded = {".git", ".hermes", "__pycache__", ".env", ".venv", "venv", "node_modules",
                "auth.json", "credentials.json", "token.json", "tokens.json", "oauth_tokens.json",
                "session.json", "state.db", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"}
    result = []
    for name in names:
        path = Path(directory) / name
        private_key = (name.endswith((".pem", ".key")) and path.is_file()
                       and b"PRIVATE KEY-----" in path.read_bytes()[:8192])
        if name in excluded or name.startswith(".env.") or name.endswith((".pyc", ".pyo", ".egg-info")) or private_key:
            result.append(name)
    return result


def tree_digest(root):
    digest = hashlib.sha256()
    for directory, dirs, files in os.walk(root):
        dirs[:] = sorted(set(dirs) - set(ignored(directory, dirs)))
        for name in sorted(set(files) - set(ignored(directory, files))):
            path = Path(directory) / name
            relative = path.relative_to(root).as_posix()
            data = os.readlink(path).encode() if path.is_symlink() else path.read_bytes()
            digest.update(relative.encode() + b"\0" + data + b"\0")
    return digest.hexdigest()


def private_directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise RuntimeError("Candidate stage must be a private directory owned by this user")


def stage_marker(stage, *, allow_completed=False):
    private_directory(stage)
    marker = stage / ".agent-interface-upgrade-stage"
    if marker.is_symlink():
        raise RuntimeError("Candidate stage marker must be a real file")
    value = json.loads(marker.read_text())
    allowed = {"active", "completed"} if allow_completed else {"active"}
    if value.get("schemaVersion") != 1 or value.get("state") not in allowed:
        raise RuntimeError("Candidate stage needs an active upgrade marker")
    uuid.UUID(value["operationId"])
    return value


def clean_environment(home, tools):
    result = {key: os.environ[key] for key in ("PATH", "HOME", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR") if key in os.environ}
    result.update(HERMES_HOME=str(home), HERMES_RUNTIME_DIR=str(tools), HERMES_DISABLE_LAZY_INSTALLS="1", PYTHONDONTWRITEBYTECODE="1")
    return result


def activate_readonly(source, home):
    """Read the selected library tree without PM recovery, publication, or lease writes."""
    source, home = source.resolve(), home.resolve()
    os.environ["HERMES_HOME"] = str(home)
    os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
    for name in ("HERMES_INSTALL_ROOT", "HERMES_RUNTIME_DIR", "PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV"):
        os.environ.pop(name, None)
    sys.path.insert(0, str(source))
    from hermes_cli._launchers import resolve_store_python
    from pm.environments import committed_venv, site_packages
    python = resolve_store_python(source)
    if python is None or Path(python).resolve() != Path(sys._base_executable).resolve():
        raise RuntimeError("Fingerprint must run in the native selected store interpreter")
    selected = committed_venv(source)
    if selected is None:
        raise RuntimeError("Native PM has no committed dependency generation")
    packages = site_packages(selected)
    if not packages.is_dir():
        raise RuntimeError("Native PM dependency generation is missing")
    sys.path[:] = [entry for entry in sys.path if Path(entry).name not in ("site-packages", "dist-packages")]
    site.addsitedir(str(packages))
    sys.path.insert(0, str(source))
    os.environ["HERMES_QUALIFIED_SOURCE"] = str(source)
    os.environ["HERMES_QUALIFIED_SITE_PACKAGES"] = str(packages)
    return python, selected


def active_fingerprint():
    """Inspect metadata from the actual activated import path, including editable snapshots."""
    source = os.environ.get("HERMES_QUALIFIED_SOURCE")
    identity = source_identity(Path(source)) if source else None
    packages_path = os.environ.get("HERMES_QUALIFIED_SITE_PACKAGES")
    if not packages_path or not Path(packages_path).is_absolute() or not Path(packages_path).is_dir():
        raise RuntimeError("Fingerprint requires the selected managed site-packages tree")
    # Ignore duplicate checkout egg-info only when the selected generation
    # attests that same editable package, including PM's workspace snapshots.
    # The source identity and actual editable tree are hashed below. Keep dependencies made
    # importable by .pth files in the inventory as well.
    editable_source_names = set()
    for distribution in importlib.metadata.distributions(path=[packages_path]):
        direct = distribution.read_text("direct_url.json")
        if source and direct and distribution.read_text("RECORD") is not None:
            value = json.loads(direct)
            url = urllib.parse.urlparse(value.get("url", ""))
            if (value.get("dir_info", {}).get("editable") and url.scheme == "file"
                    and url.netloc in ("", "localhost")):
                editable_source_names.add(distribution.metadata.get("Name", "").lower().replace("_", "-"))
    distributions = []
    for distribution in importlib.metadata.distributions():
        name = distribution.metadata.get("Name")
        if not name or not distribution.version:
            raise RuntimeError("Dependency metadata has no package identity")
        if (source and name.lower().replace("_", "-") in editable_source_names
                and Path(distribution.locate_file("")).resolve() == Path(source).resolve()
                and distribution.read_text("RECORD") is None and distribution.read_text("PKG-INFO") is not None):
            continue
        direct = distribution.read_text("direct_url.json")
        replacements = {}
        if direct:
            value = json.loads(direct)
            if value.get("dir_info", {}).get("editable"):
                url = urllib.parse.urlparse(value.get("url", ""))
                if url.scheme != "file" or url.netloc not in ("", "localhost"):
                    raise RuntimeError("Unknown editable dependency origin")
                root = Path(urllib.parse.unquote(url.path)).resolve()
                if not root.is_dir() or identity is None:
                    raise RuntimeError("Editable dependencies require exact managed source identity")
                # Generated snapshots are part of the actual loaded environment.
                # Their content and the exact checked-out Hermes SHA must match.
                token = "<editable:" + sha(json.dumps(identity, sort_keys=True).encode()) + ":" + tree_digest(root) + ">"
                replacements[str(root)] = token
                replacements[root.as_uri()] = token
                replacements[urllib.parse.unquote(url.path)] = token
                replacements[value["url"]] = token
        records = distribution.read_text("RECORD")
        if records is None:
            raise RuntimeError("Dependency lacks installed RECORD metadata: " + name)
        rows = []
        packages = Path(distribution.locate_file("")).resolve()
        generation = (packages.parent.parent.parent
                      if packages.name == "site-packages" and packages.parent.parent.name in ("lib", "lib64")
                      and packages.parent.name.startswith("python") else None)
        for relative, checksum, size in csv.reader(io.StringIO(records)):
            path = Path(distribution.locate_file(relative)).resolve()
            if relative.endswith((".pyc", ".pyo")) or "__pycache__" in Path(relative).parts:
                continue
            if relative.endswith("/RECORD") or relative.endswith(".dist-info/uv_cache.json"):
                # uv's rebuild timestamp is resolver bookkeeping, not loaded code.
                continue
            script = generation is not None and path.is_relative_to(generation / "bin")
            if not path.is_relative_to(packages) and not script:
                raise RuntimeError("Installed dependency record escaped its library tree or native generation bin: " + name)
            if not path.is_file():
                raise RuntimeError("Installed dependency file is missing: " + name)
            data = path.read_bytes()
            if script:
                # Console bodies are executable inputs. Only their generated first
                # Python shebang may name this generation's installation path.
                first, separator, body = data.partition(b"\n")
                if first.startswith(b"#!"):
                    command = first[2:].strip().split(maxsplit=1)
                    interpreter = Path(os.fsdecode(command[0])) if command else None
                    native_alias = interpreter and interpreter.parent.resolve() == generation / "bin" and re.fullmatch(r"python(?:\d+(?:\.\d+)*)?", interpreter.name)
                    selected_interpreter = interpreter and interpreter.resolve() == Path(sys._base_executable).resolve()
                    exact_store_interpreter = interpreter and interpreter.absolute() == Path(sys._base_executable).absolute()
                    if native_alias and not selected_interpreter:
                        raise RuntimeError("Console script selects a different managed interpreter: " + name)
                    if selected_interpreter and not native_alias and not exact_store_interpreter:
                        raise RuntimeError("Console script selects an external interpreter alias: " + name)
                    if native_alias and selected_interpreter or exact_store_interpreter:
                        first = b"#!<qualified-python>" + (b" " + command[1] if len(command) > 1 else b"")
                        data = first + separator + body
            if replacements and (relative.endswith((".pth", ".py")) or relative.endswith("/direct_url.json")):
                text = data.decode("utf-8")
                for before, after in sorted(replacements.items(), key=lambda item: -len(item[0])):
                    text = text.replace(before, after)
                data = text.encode()
            # Hash actual installed bytes, not an unchanged RECORD after file edits.
            rows.append([relative, sha(data), len(data)])
        distributions.append([name.lower().replace("_", "-"), distribution.version, sorted(rows)])
    binary = Path(sys._base_executable).resolve()
    return {"interpreterSha256": sha(binary.read_bytes()), "dependenciesSha256": sha(json.dumps(sorted(distributions), separators=(",", ":")).encode())}


def fingerprint(python):
    code = "import runpy; m=runpy.run_path(" + repr(str(Path(__file__).resolve())) + "); import json; print(json.dumps(m['active_fingerprint']()))"
    return json.loads(subprocess.check_output([str(python), "-c", code], stderr=subprocess.PIPE, timeout=180))


def selection(source, home):
    python, selected = activate_readonly(source, home)
    from pm.environments import runtime_facts_path
    from pm.workspace import enabled_member_dirs, enabled_plugin_dirs
    members = enabled_member_dirs()
    enabled = enabled_plugin_dirs()
    if set(members) != {path for path in enabled if (path / "pyproject.toml").is_file() or (path / "hermes-plugin.json").is_file()}:
        # A selected plugin rejected by this native version must not vanish silently.
        from pm.plugin_declarations import read_python_declaration
        if any(read_python_declaration(path).is_member and path not in members for path in enabled):
            raise RuntimeError("An enabled native plugin was excluded from the dependency union")
    facts = json.loads(runtime_facts_path(source).read_text())
    extras = facts.get("packages", {}).get("venv", {}).get("extras")
    if not isinstance(extras, list) or any(not isinstance(extra, str) for extra in extras):
        raise RuntimeError("Native PM extra selection is unknown")
    return {"python": str(python), "extras": extras, "plugins": [str(path.resolve()) for path in members]}


def prepare(source, stage, launcher, installed_source, installed_home):
    stage_marker(stage)
    stage = stage.resolve()
    source = source.resolve()
    if not source.is_relative_to(stage) or source == stage:
        raise RuntimeError("Candidate source must be inside the marked stage")
    for path in (launcher, installed_source, installed_home):
        if not path.is_absolute():
            raise RuntimeError("Managed installation paths must be absolute")
    command = json.loads(subprocess.check_output([str(launcher), "--print-runtime-command"], stderr=subprocess.PIPE, timeout=30))
    python = Path(command[0])
    if not python.is_absolute() or not python.is_file():
        raise RuntimeError("Native launcher did not name a store interpreter")
    helper = Path(__file__).resolve()
    native = json.loads(subprocess.check_output([str(python), "-I", str(helper), "selection", "--source", str(installed_source), "--home", str(installed_home)], env=clean_environment(installed_home, installed_home / "tools"), stderr=subprocess.PIPE, timeout=60))
    home = stage / "pm-home"
    home.mkdir(mode=0o700)
    (home / "config.yaml").write_text("cli:\n  expose_on_path: false\nplugins:\n  enabled: []\n")
    (home / "config.yaml").chmod(0o600)
    members, copied = {}, []
    for index, original in enumerate(native["plugins"]):
        origin = Path(original)
        for directory, dirs, files in os.walk(origin):
            dirs[:] = sorted(set(dirs) - set(ignored(directory, dirs)))
            for name in set(dirs + files) - set(ignored(directory, dirs + files)):
                if (Path(directory) / name).is_symlink():
                    raise RuntimeError("Enabled plugin contains a symbolic source link; installer review is required")
        target = stage / "plugin-sources" / str(index)
        shutil.copytree(origin, target, symlinks=True, ignore=ignored)
        original_hash, target_hash = tree_digest(origin), tree_digest(target)
        if original_hash != target_hash:
            raise RuntimeError("Native plugin source changed during staging")
        members[original] = str(target)
        copied.append({"identity": original, "path": str(target), "sha256": target_hash})
    code = "\n".join([
        "import sys,json; from pathlib import Path", "sys.path.insert(0," + repr(str(source)) + ")",
        "import pm; from pm.plugin_inputs import Members",
        "members=Members({Path(k):Path(v) for k,v in " + repr(members) + ".items()})",
        "pm.sync_venv(" + repr(native["extras"]) + ",explicit=True,project_root=Path(" + repr(str(source)) + "),plugins=members)",
        "assert pm.venv_is_current(extras=" + repr(native["extras"]) + ",plugins=members,project_root=Path(" + repr(str(source)) + "))",
        "from hermes_cli._launchers import resolve_store_python; from pm.environments import committed_venv",
        "print(json.dumps({'python':str(resolve_store_python(Path(" + repr(str(source)) + "))),'generation':str(committed_venv(Path(" + repr(str(source)) + ")))}))",
    ])
    log = stage / "pm-build.log"
    with log.open("w") as output:
        log.chmod(0o600)
        result = subprocess.run([str(python), "-I", "-c", code], env=clean_environment(home, home / "tools"), stdout=subprocess.PIPE, stderr=output, text=True, timeout=1800)
    if result.returncode:
        raise RuntimeError("Candidate native PM dependency build failed; inspect its private build log")
    built = json.loads(result.stdout)
    runtime = Path(built["python"])
    generation = Path(built["generation"])
    if not runtime.is_relative_to(home / "tools") or not generation.is_relative_to(home / "installs") or not runtime.is_file():
        raise RuntimeError("Native PM selected a generation outside the isolated home")
    descriptor = stage / "qualified-runtime.json"
    frozen_helper = stage / "qualified-python-runtime.py"
    shutil.copy2(helper, frozen_helper)
    frozen_helper.chmod(0o600)
    wrapper = stage / "qualified-python"
    wrapper.write_text("#!/bin/sh\nexec " + shlex.join([str(runtime), "-I", "-u", str(frozen_helper), "launch", "--descriptor", str(descriptor), "--"]) + ' "$@"\n')
    wrapper.chmod(0o700)
    value = {"schemaVersion": 1, "source": str(source), "sourceIdentity": source_identity(source), "home": str(home), "python": str(runtime), "generation": str(generation), "wrapper": str(wrapper), "plugins": copied, "extras": native["extras"], "helperSha256": sha(frozen_helper.read_bytes())}
    descriptor.write_text(json.dumps(value, sort_keys=True)); descriptor.chmod(0o600)
    value["fingerprint"] = fingerprint(wrapper)
    descriptor.write_text(json.dumps(value, sort_keys=True))
    return {"python": str(wrapper), "descriptor": str(descriptor), "fingerprint": value["fingerprint"]}


def launch(descriptor, arguments):
    stage = descriptor.parent
    stage_marker(stage, allow_completed=True)
    value = json.loads(descriptor.read_text())
    if value.get("schemaVersion") != 1 or sha(Path(__file__).read_bytes()) != value["helperSha256"]:
        raise RuntimeError("Qualified Python helper changed")
    source, home = Path(value["source"]), Path(value["home"])
    if source_identity(source) != value["sourceIdentity"]:
        raise RuntimeError("Qualified source changed")
    if any(tree_digest(Path(plugin["path"])) != plugin["sha256"] for plugin in value["plugins"]):
        raise RuntimeError("Qualified plugin source changed")
    fixture_home = os.environ.get("HERMES_HOME")
    os.environ.update(HERMES_HOME=str(home), HERMES_RUNTIME_DIR=str(home / "tools"), HERMES_DISABLE_LAZY_INSTALLS="1", HERMES_QUALIFIED_SOURCE=str(source))
    for name in ("HERMES_INSTALL_ROOT", "PYTHONHOME", "VIRTUAL_ENV"):
        os.environ.pop(name, None)
    sys.path.insert(0, str(source))
    import pm.environments
    pm.environments.dependency_home_root = lambda: home
    if str(pm.environments.committed_venv(source)) != value["generation"]:
        raise RuntimeError("Qualified dependency generation changed")
    import hermes_bootstrap
    os.environ["HERMES_QUALIFIED_SITE_PACKAGES"] = str(pm.environments.site_packages(Path(value["generation"])))
    if fixture_home:
        os.environ["HERMES_HOME"] = fixture_home
    sys.executable = value["wrapper"]
    args = list(arguments)
    while args and args[0] in ("-I", "-B", "-u"):
        flag = args.pop(0)
        if flag == "-B": sys.dont_write_bytecode = True
    if args[:1] in (["--version"], ["-V"]):
        print("Python " + sys.version.split()[0]); return
    if not args:
        raise RuntimeError("Qualified Python requires -m, -c or a script")
    if args[0] == "-c":
        sys.argv = ["-c", *args[2:]]; exec(args[1], {"__name__": "__main__"})
    elif args[0] == "-m":
        sys.argv = [args[1], *args[2:]]; runpy.run_module(args[1], run_name="__main__", alter_sys=True)
    elif args[0].startswith("-"):
        raise RuntimeError("Unsupported qualification interpreter option")
    else:
        script = Path(args[0]).absolute()
        sys.path.insert(0, str(script.parent))
        sys.argv = [str(script), *args[1:]]; runpy.run_path(str(script), run_name="__main__")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    for name in ("fingerprint", "selection"):
        command = sub.add_parser(name)
        command.add_argument("--source", required=True, type=Path)
        command.add_argument("--home", required=True, type=Path)
    command = sub.add_parser("prepare")
    for name in ("source", "stage", "launcher", "installed-source", "installed-home"):
        command.add_argument("--" + name, required=True, type=Path)
    command = sub.add_parser("launch")
    command.add_argument("--descriptor", required=True, type=Path)
    command.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.action == "prepare": result = prepare(args.source, args.stage, args.launcher, args.installed_source, args.installed_home)
    elif args.action == "selection": result = selection(args.source, args.home)
    elif args.action == "fingerprint":
        activate_readonly(args.source, args.home); result = active_fingerprint()
    else:
        launch(args.descriptor, args.arguments[1:] if args.arguments[:1] == ["--"] else args.arguments); return
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try: main()
    except (RuntimeError, subprocess.SubprocessError, OSError, ValueError) as error:
        # The caller's log needs the stack: "Permission denied: '/'" alone cannot be traced.
        traceback.print_exc()
        raise SystemExit("Managed qualification failed: " + str(error))
