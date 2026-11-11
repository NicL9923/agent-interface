# iOS announces the whole reply

Branch `t3/ios-whole-reply`, based on `origin/main` at `41bfa499`. Swift written and run on the Mac mini
(Xcode 27.2, iPhone 18 Pro simulator, iOS 27.0) through `.agents/tools/validate-ios.sh`. Simulator runs, not device runs.

## What changed

`ReplyWatch` (`ConversationView.swift`) is now a port of the web's `watchReplies` (#337, `src/app/reply-announcement.ts`).
The announcement is every speakable saved row of the newest turn after the last one seen, joined with a blank line,
plus the rows an earlier read held while the assistant was still working (a held row is read again from the
conversation, since it can grow in place). What was already heard is compared on text with whitespace removed, as a
whole reply, a head or a tail, so only what follows it is read. A held reply records its turn and is dropped when a
newer turn's reply arrives. The 200-character limit still applies in `snippet`, after the join. Before, only the last
saved row was read.

## Tests

`ReplyAnnouncementTests` keeps its nine old cases and gains eleven ported from `tests/reply-announcement.test.ts`:
two segments, a head read, a tail read, the whole reply read with other separators, words not in the reply or heard
in an earlier turn, a segment still streaming (through every growth, and finishing before it is saved), a held row
that grew in place, a held reply from an earlier turn, two turns between reads, and the 200-character cut after joining.

## Red proof

Five lines were broken together by hand and the run went red, 15 failures in the 20 tests: the whitespace-free
comparison, the held-turn check, the newest-turn start, the held segment while the tail streams, and the heard-prefix
skip. The restored file passed.

## Final run

`bash .agents/tools/validate-ios.sh 39F5329D-FA70-4259-9B8A-6AECECDE2227 test -only-testing:AgentInterfaceTests`
passed: 759 tests, 2 skipped (`testRenderPropEvidence`, `testRenderEvidence`, which need an evidence directory), 0 failed.
