# October 24 message admission and custom answers

Source fingerprint `sha256:dd51cb85a539b6bfd14f76c6857672891245ad117b8bdadac95e86cc7ebc2efc`
covers the implementation on top of `1d43bbf`. Ledger entries are excluded.
Native validation used iOS input fingerprint
`sha256:c30c3e68f3daf3b8c1ba07368a534a01b8e3e9704dad70041f4120813dc28782`.
The host was Nicolass-Mini with Node 26.10.0, Python 3.14.7 and Xcode 27.1,
build 27A9275.

All 1,104 Vitest tests, the production build and Ruff passed. The full Python
runner passed all 32 test files. After the final native-refusal and image-cleanup
changes, the journal and gateway-guard files passed again. Coverage includes
definite native refusals, unchanged receipts on replay and restart, unknown
failures, image cleanup and admission of a later message. Existing ambiguous
receipts stay uncertain and are never replayed.

The task-reserved iPhone 18 Pro simulator, iOS 27.0, ran 125 NativeContractTests
and DailyFlowTests/testQuestionAcceptsACustomAnswer with no failures. The final
combined run used the native fingerprint above and the shared iOS validation lock.
The UI flow selected a custom answer, typed it and verified that the fixture
received it. An earlier attempt used the wrong picker locator and was cancelled;
the final test uses stable control identifiers.

An agent exercised the loopback browser fixture at 1200 x 1189 and 390 x 844,
selected a custom answer and inspected its rendering. The actual request body was
`{"answers":{"category":"Household repairs"}}`. Browser diagnostics reported no
errors or warnings. Web regressions also cover retaining the answer after failure,
switching back to a suggestion with the same label as the custom action, and
blank-answer prevention. Screenshots remain in the task's ignored `.private`
directory and accompany the pull request.

These checks use isolated fixtures. They do not qualify the changed add-on against
live Hermes, activate a server release, or publish an iOS build. The normal release
qualification and a new iOS build are still required to deliver the changes.

Claude Opus 5.5 independently reviewed the full diff and verified the refusal
codes against the pinned Hermes source. Review fixes removed an unsupported
error-reason assumption, replaced raw native refusal instructions with plain
recovery messages, and distinguished the iOS custom field's VoiceOver label from
the picker. A focused second review found no blockers. The reviewer checked the
code; the implementation agent ran validation.
