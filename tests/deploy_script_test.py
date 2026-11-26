"""Tests for scripts/deploy.py using temp directories and fake executables on PATH."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEPLOY_SCRIPT = REPO_ROOT / "scripts" / "deploy.py"


def make_executable(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


class DeployScriptTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="wildbots-deploy-test-"))
        self.addCleanup(
            lambda: subprocess.run(["rm", "-rf", str(self.tmp)], check=False)
        )
        self.bin_dir = self.tmp / "bin"
        self.bin_dir.mkdir()
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        self.remote_root = self.tmp / "remote"
        self.remote_root.mkdir()
        self.log_file = self.tmp / "calls.log"

        # Real tiny git repo so resolve_commit and git archive are exercised end to end.
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        subprocess.run(
            ["git", "config", "user.email", "test@example.test"],
            cwd=self.repo,
            check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test"], cwd=self.repo, check=True
        )
        (self.repo / "package.json").write_text(
            '{"name":"wildbots"}\n', encoding="utf-8"
        )
        subprocess.run(["git", "add", "."], cwd=self.repo, check=True)
        subprocess.run(
            ["git", "commit", "-q", "-m", "initial"], cwd=self.repo, check=True
        )

        # Previous release with dist/client/assets.
        self.prev_release = self.remote_root / "releases" / "release-prev"
        (self.prev_release / "dist" / "client" / "assets").mkdir(parents=True)
        (self.remote_root / "current").symlink_to(self.prev_release)

    def _install_fakes(self, *, health_body: str = '{"ok":true}') -> dict[str, str]:
        # Fake scp copies the local tarball directly to the destination path on local disk.
        make_executable(
            self.bin_dir / "scp",
            """#!/usr/bin/env python3
import shutil, sys
src, dst = sys.argv[-2], sys.argv[-1]
remote_path = dst.split(":", 1)[1]
shutil.copy2(src, remote_path)
""",
        )
        # Fake ssh runs the stdin bash script locally against self.remote_root!
        make_executable(
            self.bin_dir / "ssh",
            f"""#!/usr/bin/env python3
import os, subprocess, sys
script = sys.stdin.read()
env = os.environ.copy()
env["PATH"] = {str(self.bin_dir)!r} + os.pathsep + env["PATH"]
proc = subprocess.run(["bash", "-s"], input=script, text=True, env=env)
sys.exit(proc.returncode)
""",
        )
        # Fake npm records calls and creates dist/.
        make_executable(
            self.bin_dir / "npm",
            f"""#!/usr/bin/env bash
echo "npm $*" >> {str(self.log_file)!r}
mkdir -p dist/client/assets
""",
        )
        make_executable(
            self.bin_dir / "systemctl",
            f"""#!/usr/bin/env bash
echo "systemctl $*" >> {str(self.log_file)!r}
""",
        )
        make_executable(
            self.bin_dir / "curl",
            f"""#!/usr/bin/env bash
printf '%s' {health_body!r}
""",
        )
        env = os.environ.copy()
        env["PATH"] = f"{self.bin_dir}{os.pathsep}{env['PATH']}"
        return env

    def test_dry_run_resolves_commit_without_touching_host(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                str(DEPLOY_SCRIPT),
                "--repo",
                str(self.repo),
                "--remote-root",
                str(self.remote_root),
                "--dry-run",
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Dry run: would deploy", result.stdout)
        self.assertEqual(
            os.readlink(self.remote_root / "current"), str(self.prev_release)
        )

    def test_deploys_release_writes_previous_assets_json_and_flips_symlink(
        self,
    ) -> None:
        env = self._install_fakes(health_body='{"ok":true}')
        result = subprocess.run(
            [
                sys.executable,
                str(DEPLOY_SCRIPT),
                "--repo",
                str(self.repo),
                "--host",
                "fake-host",
                "--remote-root",
                str(self.remote_root),
                "--skip-backup",
            ],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        current = Path(os.readlink(self.remote_root / "current"))
        self.assertNotEqual(current, self.prev_release)
        self.assertTrue((current / "package.json").is_file())
        prev_json = json.loads(
            (current / "dist" / "previous-release.json").read_text("utf-8")
        )
        self.assertEqual(
            prev_json, {"assets": str(self.prev_release / "dist" / "client" / "assets")}
        )
        calls = self.log_file.read_text("utf-8")
        self.assertIn("npm ci", calls)
        self.assertIn("npm run build:server:bun", calls)
        self.assertIn("systemctl --user restart agent-interface.service", calls)

    def test_rolls_back_automatically_when_health_check_fails(self) -> None:
        env = self._install_fakes(health_body='{"ok":false}')
        # Speed up the 30-iteration poll by replacing sleep on PATH with a no-op.
        make_executable(self.bin_dir / "sleep", "#!/usr/bin/env bash\nexit 0\n")
        result = subprocess.run(
            [
                sys.executable,
                str(DEPLOY_SCRIPT),
                "--repo",
                str(self.repo),
                "--host",
                "fake-host",
                "--remote-root",
                str(self.remote_root),
                "--skip-backup",
            ],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("rolling back", result.stderr)
        # Current symlink must point back to previous release after rollback.
        self.assertEqual(
            os.path.realpath(self.remote_root / "current"),
            os.path.realpath(self.prev_release),
        )
        calls = self.log_file.read_text("utf-8").splitlines()
        restarts = [
            line for line in calls if line.startswith("systemctl --user restart")
        ]
        self.assertEqual(len(restarts), 2)

    def test_rejects_keep_releases_below_two(self) -> None:
        result = subprocess.run(
            [sys.executable, str(DEPLOY_SCRIPT), "--keep-releases", "1"],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
