# Lock each browser-suite port separately

Base: `62ea8cb992ad38fd4cd58e1612e98f8fc8df21ae`.
Implementation and tests: OpenAI, GPT-6.1 Sol on NicolasLaptop.
Production/test diff SHA-256: `a767f376a3173d9caa1c524af2af3aa3dc8a8033cd778d8c4eb81ef507c026b7`.

The independent review of #339 found that two explicitly requested adjacent app ports could
reserve overlapping app/control pairs before either server bound a socket. Each port now has
its own file lock. Both descriptors are inherited by the suite, updated to its PID, and
released together. Failure to acquire the second port releases the first reservation.
Default nonoverlapping candidates and an explicit busy-port refusal retain their behavior.

## Validation

- Before the fix, the adjacent-pair regression failed because both overlapping requests were
  admitted. Output: `.private/port-pair-red.log`.
- The fixed PortTest suite passed all 15 tests. The real Node descriptor and killed-parent
  checks passed. Output: `.private/port-pair-green.log` and
  `.private/port-inheritance-green.log`.
- The full non-browser check-all passed typecheck, lint, Ruff, 4,064 JavaScript tests in
  221 files, build, and Python checks across 52 files. It queued for 5,297.864 seconds and
  executed for 377.957 seconds. Output: `.private/port-pair-check-all.log`.
- Four deliberate mutations independently removed the second reservation, its release,
  descriptor inheritance, and PID update. Each failed its regression. All runs used the
  committed mutate-py helper from PR #425 with a passing baseline and byte-for-byte restore.
  Output: `.private/port-pair-mutations.log`.
- A cleanup now kills the detached fake npm on assertion failure, so a deliberately failing
  SIGKILL test cannot retain a lock. After this test-only cleanup, the complete helper suite
  passed all 98 tests in 24.655 seconds. Output: `.private/port-pair-all-tests.log`.
- `git diff --check` passed.

The descriptor contract was runtime-exercised with real Node: the slot and both ports remain
with npm at descriptors 3, 4, and 5; its grandchild inherits none. The actual SIGKILL scenario
also verifies both ports remain reserved until the surviving suite ends. This checks the
caller two hops beyond reservation rather than only the lock helper. No application, API,
web/native-client, or production runtime behavior changes.

The latest main must be integrated before publication. Full final-state validation and a
real Chromium/WebKit run using the changed launcher remain pending. Independent review is
incomplete because Anthropic is usage-limited and xAI has exhausted its balance. Keep the
follow-up draft until an eligible outside-OpenAI reviewer completes it. No release is needed
for this development-tool change.
