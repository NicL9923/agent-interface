# Shared text persistence review

## Assessment

No verified blocking defects found in the requested Anthropic implementation. The change addresses #206's retry after the emptied ShareInbox save fails, including retry through a reconstructed store. Approval is limited to that behavior and the source scope below. This is not an exactly-once guarantee across every crash.

Reviewer: OpenAI GPT-6.1 Sol, inherited high reasoning effort. Implementer for this scope: Anthropic Claude Opus. Reviewed branch `nic/design-followups-compact-composer`, supplied comparison `3812a91` to `b630d93`.

## Scope and source conclusions

Reviewed the shared-text changes in `ShareInbox.swift`, `DraftAdditions.swift`, `ShareCaptureView.swift`, the storage-kind and `persistDraft` changes in `AppStore.swift`, and the specified Foundation and XCTest changes. Read the draft merge, persistence, send settlement, account transition, and sheet callers as context. Other OpenAI changes, including `homeRequest`, assistant-choice guarding, and the text-length guard, were excluded from independent review.

- `ShareInbox.transferText` passes the whole capture to acceptance, clears text only after acceptance, and leaves the in-memory copy cleared if saving throws. Rejection leaves its text intact. See `ios/Shared/ShareInbox.swift:59`.
- `holdShared` refuses another account before considering deduplication. `sharedTextAdded` checks the account-scoped saved queue and receipts, so retrying a pending or landed share does not enqueue it again. Different share IDs and changed text remain eligible. See `ios/AgentInterface/DraftAdditions.swift:78` and `ios/AgentInterface/AppStore.swift:304`.
- Receipts identify the share and SHA256 of the UTF-8 text. Pruning happens when recording new receipts, using the same seven-day lifetime as the inbox. Receipt timestamps start at landing, after capture creation, so normal pruning does not remove a receipt while its original inbox capture is still within its lifetime. Unpruned older receipts can remain until another share lands. See `ios/Shared/ShareInbox.swift:16` and `:66`.
- The new optional `DraftAddition.capture` uses synthesized optional decoding. Old queue entries without that key still decode as `nil` and land normally, without fabricating a receipt. See `ios/AgentInterface/DraftAdditions.swift:27`.
- Landing requires a loaded draft and no in-memory or stored pending send. It copies the existing draft, appends text, retains attachments, and marks the edit dirty. It then persists the draft, records receipts, and removes delivered queue entries, without an intervening await. Its save path writes the editable draft, not a message submission. See `ios/AgentInterface/DraftAdditions.swift:34`, `:40`, `:139`, and `ios/AgentInterface/AppStore.swift:975`, `:1055`, `:1130`.
- Dirty draft merging retains unsaved additions against a server read unless the existing sent-copy rules apply. Appending advances the edit sequence, which distinguishes new draft text from the prior sent copy. Send settlement restores or clears its own draft before the scheduled additions drain can land shared text. See `ios/AgentInterface/Models.swift:412` and `ios/AgentInterface/AppStore.swift:1250`.
- On reopening an already accepted share, the view clears its stale text and either removes a text-only inbox capture or saves the cleared capture while retaining its files. Failed saves keep `needsCaptureSave` set, disable text editing, and require that save before another import. Later also retries persistence. See `ios/AgentInterface/ShareCaptureView.swift:23`, `:46`, `:65`, `:81`, and `:90`.

The existing drain behavior that drops queued additions for deleted assistants is unchanged at `ios/AgentInterface/DraftAdditions.swift:118`. It is not a new finding.

## Known residual crash window

At `ios/AgentInterface/DraftAdditions.swift:147`, the local draft is saved before the receipt and queue removal. If the process stops after that save but before queue removal at line 150, the next drain can append the surviving queued text again. This includes stopping after the receipt write: `landAdditions` does not consult receipts before replaying its queue. Receipt checking protects capture acceptance, not that interrupted drain.

The result can be duplicate editable draft text. This path never submits a message automatically. The source write order avoids deliberately removing the queued copy before saving its draft, but UserDefaults and atomic file writes do not provide a transaction or an fsync/power-loss guarantee. Neither source inspection nor the reported checks establishes loss-free behavior for every storage failure.

For this explicit add-to-editable-draft flow, the disclosed residual duplication risk is proportionate and does not block the #206 fix. Any claim of exactly-once crash recovery would exceed the implementation. Eliminating the gap would require durable transactional landing or replay-aware draft state.

## Validation evidence and limits

No tests, builds, simulator runs, browser work, or hashes were run for this review. No subagents were started. Only this report was written.

The supplied validation reports standalone Foundation checks passing under the Mac lock, Swift 6 strict-concurrency no-emit typechecks for the app and all XCTest sources, and a subsequent successful xcodebuild of the app and extension targets. These results were supplied by the task owner, not reproduced here. The new XCTest regression was typechecked but not executed because of the XCTest service mismatch.

Source inspection of `testASharedTextRetriedAfterARelaunchJoinsItsDraftOnce` confirms assertions for failed capture saving, saved queue reuse, persisted landing, receipt reuse, distinct shares, changed text, and cross-account refusal. Its `store(server)` helper resets the draft to "Send this" at `ios/AgentInterfaceTests/NativeContractTests.swift:373`. Consequently the later-store assertions at lines 2569-2574 test receipt reuse, not production cold-launch restoration of the landed draft. The explicit saved-draft assertion at line 2565 does check that landing persisted its combined text. This is an evidence limitation, not a verified product defect.
