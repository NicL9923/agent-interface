# November 8 release runtime validation

Branch `t3/release-node-runtime` (PR #267), on NicolasLaptop, Linux, Node 24.22.2 and
Python 3.14.10. No release host, production service or Mac was touched.

- `python3 -m unittest release_app_test`: 49 tests passed.
- `python3 scripts/run-python-tests.py`: 37 files passed, 0 skipped, 0 failed.
- `npx vitest run`: 148 files and 1,981 tests passed. `npm run typecheck`: passed.
- Real systemd, checked by hand with transient user units: `systemctl show` prints one
  `EnvironmentFiles=PATH (ignore_errors=yes|no)` line per file, quotes an `Environment` entry
  containing a space, and prints an `ExecStart` path with a space unescaped. An
  `EnvironmentFile` that sets `PATH` overrides `Environment=PATH` in the live process. The
  host facts program, run against such a unit with a node binary, reported a clean unit as
  wholly on that binary and flagged the overriding file and the live `PATH`'s other node.
- Mutants, each applied separately and confirmed red, then restored: the stage not recording
  the resolved binary, the deploy configuration keeping the requested path, qualification
  skipping the recorded-binary check, `Environment` split on whitespace, the `ExecStart`
  regex stopping at a space, the live process `PATH` replaced by the configured one,
  environment files ignored, a missing optional environment file counted as setting `PATH`,
  runtime problems skipping `pathFiles` or `livePath`, and the `EnvironmentFiles` property
  dropped from the systemctl query.

## Review follow-up: environment file wildcards

The GPT-6.1 Sol re-review of `a63b4ea..49ddd0d` closed the symlink and quoting findings and
found one gap: systemd expands a wildcard `EnvironmentFile`, which the check opened literally.
Real systemd lists the pattern itself in `EnvironmentFiles=` and applies `PATH` from a match.
The check now expands the pattern, reads each match, and flags a required pattern with no match.
Both mutants, no expansion and a required no-match allowed, were confirmed red, then restored.
`release_app_test`: 49 tests passed.
