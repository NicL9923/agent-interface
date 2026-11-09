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

## Review follow-up: trusting the live receipt

The GPT-6.1 Sol review found that the host read the live receipt without `read_receipt`'s
ownership, mode, link and size checks, so another account able to write it could pick the
executable qualification runs, and that a requested path retargeted to another browser was
accepted. The host program now opens the receipt with `O_NOFOLLOW`, requires an owner-only
regular file of at most 8 KB owned by the runtime, and binds the selection with
`receipt_computer_probe_browser(..., rebind=True)` as the in-app updater does. The checks live
in the tool, not `src/hermes/qualification.py`, so the integration digest is unchanged.

- New refusals tested before staging: malformed metadata, a world-writable receipt, a receipt
  reached through a link, a missing receipt and a retargeted browser path.
- Mutants confirmed red, then restored: following links, the mode check removed, no rebind,
  plus the six earlier mutants. The owner check needs a second account and is not exercised.
