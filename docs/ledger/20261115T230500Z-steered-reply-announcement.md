# Steered guidance keeps the whole reply announcement

Base: `92b3fadc4f712a4338166c5f6184183fae54ca6c`. Source fingerprint before ledger:
`sha256:67eb043da9422fc49772ef224fd91ae3a68f983d6f59efa177d77eda90f6df49`.
Implemented by GPT-6.1 Sol on NicolasLaptop, Node 24.22.2.

Sol's independent review of #350 found that iOS treats steered user guidance as a new turn.
The same predicates exist in the web client from #337. Both clients now exclude
`steered == true` from the prompt that names a turn and the prompt that bounds its joined rows.
Missing or false steering still starts a new turn. Existing tests cover separate turns.

## Regression evidence

`npx vitest run tests/reply-announcement.test.ts` on unfixed production code with two new tests:
20 passed, 2 failed. Both new tests announced only the second segment. One read receives
both segments around guidance; another holds the first segment while working before guidance arrives.
With the fix all 22 tests passed. Each changed web predicate was separately restored to its
old form and its corresponding new test failed with the same missing first segment. The file
was restored byte for byte after each mutation. `git diff --check` passed.

Matching native regression tests are added. Native red/green execution is pending the Mac
checkout's existing own-send recovery task. No Apple build or test ran on Linux.

## Other entry points and limits

Both web `watchReplies` and iOS `ReplyWatch.next` use the same turn rules. Saved and held
segments are covered; existing cases retain new-turn isolation, saved/streaming deduplication,
and snippet shortening after joining. The server's `hermes-mapping.ts` already treats steered
rows as guidance in the running turn. No server or Hermes change is required.

Full local check-all, compatible-container WebKit, native checks, and cross-provider review
are pending. No browser or physical-device interaction was performed for this change.
