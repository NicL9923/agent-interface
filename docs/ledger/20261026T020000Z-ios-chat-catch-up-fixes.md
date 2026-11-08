# iOS review fixes for the chat catch-up

iOS fingerprint `sha256:f00b8ee484ea6ffbce994fb70127a548f6f644f1fffcbfd5d55b38887d929860`
covers commit `bddea92`, which merges `d769f56` into `6c43bf7` plus the release record
for that commit. Its iOS tree is identical to `d769f56`. The host was Nicolass-Mini with
Xcode 27.1 and an iPhone 17 simulator on iOS 27.0.

These commits fix the iOS findings that the October 25 chat catch-up entry deferred to
this change. They fix retry targeting, shared-computer control and its exit cleanup,
opening a chat at a message, search, group notices and queued group loads. Leaving the
native computer screen hands control back only when that screen asked for it. An
abandoned open-at rollback is cleared when the selection changes and is tied to the
selection that created it. Sign-out waits at most 5 seconds for a pending hand-back
before it revokes the session.

At `d769f56`, 498 unit tests passed with 2 skips and no failures. The transcript and
shell UI classes passed 17 of 17. At `afee2ff`, before the last two fix rounds, the
unit tests and the transcript, shell, discovery, daily, parity and experience UI
classes passed, 49 UI tests in total. The later commits change only the store, the
computer screen and unit tests. The full UI suite last ran at `999f838`.

GPT-6.1 Sol reviewed the iOS fixes in four rounds. The last round, at `d769f56`,
found no remaining defects. A red run of the new regressions against `999f838` hung
in its first test, the deadlock that fix removes, and was stopped after 70 minutes, so
the other red checks did not run.

Known limit: if Hermes admits a takeover after sign-out has revoked the session, the
app cannot release it. Fixing that needs a server-side check, which this change does
not include. Not exercised: the native computer screen against a real desktop, an iPad
and any physical phone.
