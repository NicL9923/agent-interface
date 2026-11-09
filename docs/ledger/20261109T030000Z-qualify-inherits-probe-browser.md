# November 9 qualification reuses the live probe browser

Branch `t3/qualify-inherits-probe-browser`, on NicolasLaptop, Linux, Python 3.14. No release
host, production service or Mac was touched.

The f218e65 release's first qualification failed because the operator omitted
`--computer-probe-browser`, which the live receipt had used. `qualify-app-release.py` now reuses
the live receipt's selection when neither browser flag is given, binding the requested path
afresh, and `--pinned-probe-browser` opts out.

- `python3 -m unittest release_app_test.QualificationBrowser`: 2 tests passed, running the real
  host program against fixture homes for inherited, opted-out, absent and malformed live metadata.
- Mutants, each applied separately and confirmed red, then restored: inheritance removed, the
  host ignoring the opt-out, the end-of-run browser check reading the raw payload, the CLI
  ignoring `--pinned-probe-browser`, the two flags allowed together, and inheriting the
  resolved executable instead of the requested path.
- `python3 scripts/run-python-tests.py`: 40 files passed, 0 skipped, 0 failed.
