# November 8 prepare-when-idle option pass-through

Branch `t3/prepare-when-idle-node`, on NicolasLaptop, Linux, Python 3.14.10. No host touched.

Cause: the #264 release stopped because `prepare-when-idle.py` rejected `--node`, which #267 added
to `release-app.py prepare` only. The wrapper now passes every option it doesn't define to prepare.

- `python3 -m unittest prepare_when_idle_test`: 9 tests passed.
- `python3 scripts/run-python-tests.py`: 37 files passed, 0 skipped, 0 failed.
- Mutants, each confirmed red, then restored: options not passed through, and abbreviations allowed,
  which lets `--min` set the wrapper's `--minutes` instead of reaching prepare.
