# November 8 prepare-when-idle option pass-through

Branch `t3/prepare-when-idle-node`, on NicolasLaptop, Linux, Python 3.14.10. No host touched.

Cause: the #264 release stopped because `prepare-when-idle.py` rejected `--node`, which #267 added
to `release-app.py prepare` only. The wrapper now passes every option it doesn't define to prepare.

- `python3 -m unittest prepare_when_idle_test`: 9 tests passed.
- `python3 scripts/run-python-tests.py`: 37 files passed, 0 skipped, 0 failed.
- Mutants, each confirmed red, then restored: options not passed through, and abbreviations allowed,
  which lets `--min` set the wrapper's `--minutes` instead of reaching prepare.

## Review follow-up: shared argument definitions

GPT-6.1 Sol found that blind pass-through could swap meanings: in `--qualification Q COMMIT`,
Q became the commit. The wrapper now takes `release-app.py`'s own prepare argument definitions
(`add_prepare_arguments`) and rebuilds each attempt's arguments with `prepare_argv`. An option
prepare doesn't take is refused before any attempt.

- `prepare_when_idle_test` and `release_app_test`: 58 tests passed. Full Python suite: 37 files passed.
- Mutants confirmed red, then restored: unknown options passed through, flags dropped, options
  dropped, commit dropped.
- Two mutants survive by design. Emitting `--opt value` instead of `--opt=value`, and placing the
  commit without the `--` separator, differ only for a value starting with `-`, which no real
  path or commit does. Both are cheap guards, kept without a test.
