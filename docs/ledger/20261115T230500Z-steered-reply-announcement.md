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

## Full Linux validation

At implementation commit `d45a28a9963f1394a593cc6ecceb9f3c7d8f1ed9`,
`.agents/tools/check-all --skip e2e --keep-going` passed typecheck, lint, ruff,
4,066 tests in 221 files, and build. Python was skipped because no Python inputs changed.
The browser check then passed through `.agents/tools/check-all --only e2e` in the
Playwright 1.65.0 Noble container using the pinned Node 24.22.2 runtime. It covered
both Chromium and WebKit, with three existing capability skips.

Both commands held the Linux machine lock together. They queued for 5,722.3 s and ran
for 353.5 s after acquisition. Log: `.private/steer-check-all.log`; browser output:
`/home/nic/.cache/agent-interface/check-all/logs/20261116T004459-1-work/e2e.log`.

Main was then merged at `1a4113507cf4a90aab058d7cee572cfd7ac895cb`. Its changes since
the implementation base are iOS accessibility and release evidence. None changes the
web code, dependencies, server, browser tests or validation tools, so the completed Linux
checks remain applicable. The pending native run will compile and test the merged state.

Native checks and cross-provider review remain pending. Grok's review launch failed
with HTTP 402 for exhausted balance; Anthropic is weekly-limited. The implementation
is OpenAI, so same-provider review cannot clear this obligation. Keep the PR unmerged.
No manual browser or physical-device interaction was performed for this change.


## Completed native single-predicate validation

Mac validation ran at `4a4e3cc8f03477d44ad21aed602381000fabf0a3` on Xcode 27.2.
The shared machine lock queued for 3,032 seconds and was held for 145 seconds for the
combined native task, which also attempted PR #430. The following checks exercised the
iPhone 17e simulator, not a physical device.

- Restoring only the old `turn(at:)` identity predicate failed the held-segment regression
  `testAHeldSegmentSurvivesGuidanceSteeredBeforeTheNextSegment`, with 1 failure among
  22 tests. Mutated source SHA-256:
  `283b0455f0397355ecb529396bde92035f24423493bc4d9fbf9854f1dad3e099`.
- Restoring only the old `turnStart` join boundary failed
  `testSteeredGuidanceKeepsSegmentsOnBothSidesInTheSameAnnouncement`, with 1 failure among
  22 tests. Mutated source SHA-256:
  `df441e3c93b381e565af0bc11322f83a1a0cec40396c4ac222218f0e595b4935`.
- After byte-for-byte source restoration, all 22 ReplyAnnouncementTests passed. The restored
  source SHA-256 `a760d5669e688def3ac1d7aba4b43990878c792d93fd76e6276ba30f6048f1af`
  matches the committed file. The checkout was clean at the requested SHA.

Logs are `/Volumes/DevSSD/scratch/ios-validation-task-20261116/pr431-identity.log`,
`pr431-boundary.log`, and `pr431-restored.log`. Result bundles in the Mac project are
`.private/ios-test-20261116T043826Z-47924.xcresult`,
`.private/ios-test-20261116T043921Z-48989.xcresult`, and
`.private/ios-test-20261116T044004Z-49553.xcresult`, respectively.

This completes the corrected individual mutation coverage. The earlier opposite-test
selections did not establish that coverage. No source or test changes were needed.
Independent review outside OpenAI remains incomplete; keep the PR draft until it finishes.
