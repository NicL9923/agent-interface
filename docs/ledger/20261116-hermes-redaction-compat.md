# Keep history caching compatible with current Hermes redaction

Latest Hermes candidate `3007033aeb6f6ffc86b63f68b29796107435a740` failed its isolated
integration qualification twice. `extension_probe.py` received no `app_projection_shadow`
report because Hermes moved the vault registry from `agent.redact` to
`agent.redact_vault_values`. WildBots returned unreadable redaction state and disabled its
projection memo. Production stayed on `ed1afb082eb3`.

The add-on now follows that known module split. Its fingerprint also covers external
secret-source values, the effective redaction switch and per-profile policy maps. Unknown
registries still disable the memo. These inputs also invalidate the settled-history cache,
so newly registered secrets and policy changes cannot reuse a prior rendering.

## Regression evidence

Three new projection regressions failed on the original code. They reproduced a disabled
memo under the modular layout, stale visible text after external secret publication and
stale text after a policy change. The baseline refusal was recorded through
`mutate-py.py --baseline`; no mutation ran on that failing baseline.

After the fix, `python3 tests/hermes_projection_memo_test.py` passed all 19 tests.
The journal, open-row cache and history warm-up suites also passed. Four mutations each
failed their regression: removing module compatibility, ignoring secret-source changes,
ignoring the effective switch and ignoring another profile's policy. The mutation helper
restored the source byte for byte. Private outputs are `.private/redaction-green.log`,
`.private/redaction-callers.log` and `.private/redaction-mutations.log`.

The real staged candidate's redactor was exercised in a separate process and private home,
using its public vault registration and clearing, secret-source publication and redaction,
and profile policy APIs. The updated fingerprint changed for registration, lazy source
classification and policy changes, and returned to its original value after clearing.
Production was untouched. Output: `.private/native-redaction-check.log`.

The shared test double models the real SDK's moved registry, lazy source classification
and policy inputs. The runtime redactor itself was not mocked in the staged-candidate check.
Running and settled histories are covered, including restoration after secrets are removed
or redaction is enabled again. Web and native clients share this add-on; its wire format
and native execution admission do not change.

Full local validation and fresh release qualification are pending. Independent review is
incomplete: Anthropic has a recorded weekly usage limit and xAI has exhausted its balance.
No same-provider review is represented as independent.

## Native empty toolsets

The full staged-candidate probe passed projection, gateway durability, steering and executor
recovery, then found a second native contract change. The current dashboard preserved
`enabled_toolsets: []`; the old probe expected its historical normalization to `null`.
The updated probe keeps that legacy check and, when Hermes preserves the empty list,
triggers a real routine and requires zero tool schemas in its provider request. It then
restores the skills-only restriction and retains the exact three-schema execution check.
WildBots's existing rejection of new empty selections is unchanged, preserving safety on
older supported dashboards. No client capability or routine-setting behavior changes.
