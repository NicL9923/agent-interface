import XCTest

@testable import AgentInterface

final class DraftMergeTests: XCTestCase {
    private func hash(_ text: String) -> String { Draft.contentHash(text, []) }
    private func server(_ text: String, _ revision: Int, sent: Int = 0) -> SavedDraft {
        SavedDraft(text: text, attachments: [], revision: revision, reason: sent == revision && revision > 0 ? "sent" : "edit", sentRevision: sent)
    }
    private func copy(_ text: String = "Typed here", dirty: Bool? = true, base: Int? = 2, baseHash: String? = nil, sentHash: String? = nil) -> Draft {
        Draft(text: text, attachments: [], dirty: dirty, baseRevision: base, baseHash: baseHash, sentHash: sentHash)
    }

    func testACleanCopyAdoptsTheServerDraft() {
        let merged = Draft.merge(copy(dirty: nil), with: server("From the phone", 3))
        XCTAssertEqual(merged.draft, Draft(text: "From the phone", attachments: [], dirty: false, baseRevision: 3, baseHash: hash("From the phone"))); XCTAssertFalse(merged.push)
        XCTAssertEqual(Draft.merge(copy(dirty: nil, base: nil), with: nil).draft, Draft(dirty: false, baseRevision: 0, baseHash: hash("")))
    }

    func testAnUnsavedCopyStillHoldingItsBaseContentIsDroppedAfterASend() {
        let merged = Draft.merge(copy(baseHash: hash("Typed here")), with: server("", 4, sent: 3))
        XCTAssertEqual(merged.draft, Draft(dirty: false, baseRevision: 4, baseHash: hash(""))); XCTAssertFalse(merged.push)
    }

    func testWorkChangedSinceItsBaseSurvivesASendElsewhere() {
        let offline = copy("Offline note", baseHash: hash("Shared plan"))
        let merged = Draft.merge(offline, with: server("", 3, sent: 3), authoritative: true)
        XCTAssertEqual(merged.draft, copy("Offline note", base: 3, baseHash: hash(""))); XCTAssertTrue(merged.push)
        XCTAssertEqual(Draft.merge(copy(base: nil), with: server("", 1, sent: 1)).draft.text, "Typed here", "A copy without a fingerprint is kept")
    }

    func testTellsTheSentCopyFromTheSameWordsTypedAgainByEditSequence() {
        let marked = Draft(text: "Typed here", attachments: [], dirty: true, baseRevision: 3, baseHash: hash("Older"), seq: 5,
            sentHash: hash("Typed here"), sentBase: 3, sentSeq: 5)
        let submission = PendingSubmission(requestId: "req", botId: "bot", text: "Typed here", attachments: [], reviewedInterruption: false)
        XCTAssertTrue(marked.isSentCopy)
        let cleared = marked.sent(submission)
        XCTAssertEqual(cleared.text, ""); XCTAssertEqual(cleared.sentSeq, 5); XCTAssertEqual(cleared.seq, 5)
        var retyped = cleared
        retyped.text = "Typed here"; retyped.dirty = true; retyped.seq = 6
        XCTAssertFalse(retyped.isSentCopy)
        XCTAssertEqual(retyped.sent(submission), retyped)
        let merged = Draft.merge(retyped, with: server("", 4, sent: 4))
        XCTAssertEqual(merged.draft.text, "Typed here"); XCTAssertEqual(merged.draft.baseRevision, 4); XCTAssertTrue(merged.push)
        retyped.text = "Older"
        XCTAssertEqual(Draft.merge(retyped, with: server("", 4, sent: 4)).draft.text, "Older", "Typed back to its base words: new work too")
        XCTAssertEqual(Draft.merge(marked, with: server("", 4, sent: 4)).draft.text, "", "Untouched, the sent copy gives way to the clear")
    }

    func testAnAdoptedClearIsNeverTheSentCopy() {
        let marked = Draft(text: "Typed here", attachments: [], dirty: false, baseRevision: 3, seq: 5, sentHash: hash("Typed here"), sentBase: 3, sentSeq: 5)
        let adopted = Draft.merge(marked, with: server("", 4, sent: 4)).draft
        XCTAssertEqual(adopted.text, ""); XCTAssertEqual(adopted.sentSeq, 5); XCTAssertFalse(adopted.isSentCopy)
        let saved = Draft.merge(Draft(text: "Typed here", attachments: [], dirty: true, baseRevision: 3, seq: 5,
            sentHash: hash("Typed here"), sentBase: 3, sentSeq: 5), with: server("Typed here", 4)).draft
        XCTAssertEqual(saved.dirty, false); XCTAssertTrue(saved.isSentCopy, "Saved as it is, it stays the sent copy until the send shows")
        let legacy = Draft(text: "Typed here", attachments: [], dirty: true)
        XCTAssertTrue(legacy.isSentCopy, "A copy from an older version keeps the content-only check")
    }

    func testTheTextThisDeviceSentIsDroppedOnceTheServerShowsTheSend() {
        let sending = copy(base: 0, baseHash: hash(""), sentHash: hash("Typed here"))
        XCTAssertEqual(Draft.merge(sending, with: server("", 1, sent: 1)).draft, Draft(dirty: false, baseRevision: 1, baseHash: hash("")))
        let cleared = copy("", dirty: false, base: 0, sentHash: hash("Typed here"))
        XCTAssertEqual(Draft.merge(cleared, with: server("Typed here", 1)).draft, cleared, "A save from before the send is not adopted")
        XCTAssertEqual(Draft.merge(cleared, with: server("", 2, sent: 2)).draft.baseRevision, 2)
    }

    func testALaterDraftWithTheLastSentTextIsAdoptedOnceTheServerShowsThatSend() {
        // Sent "Continue" on revision 5 and missed the empty revision 6.
        var cleared = copy("", dirty: false, base: 5, sentHash: hash("Continue")); cleared.sentBase = 5
        let merged = Draft.merge(cleared, with: server("Continue", 7, sent: 6)).draft
        XCTAssertEqual(merged.text, "Continue"); XCTAssertNil(merged.sentHash)
        XCTAssertEqual(Draft.merge(cleared, with: server("Continue", 6, sent: 0)).draft, cleared, "Before the send shows, the guard holds")
    }

    func testEditsHereWinOverANewerEditAndSaveOnItsRevision() {
        let merged = Draft.merge(copy(), with: server("Phone edit", 5, sent: 1))
        XCTAssertEqual(merged.draft, copy(base: 5, baseHash: hash("Phone edit"))); XCTAssertTrue(merged.push)
    }

    func testUnsavedEditsOnAnUnchangedServerCopyAreLeftAlone() {
        let merged = Draft.merge(copy(), with: server("Older text", 2))
        XCTAssertEqual(merged.draft, copy()); XCTAssertFalse(merged.push)
        XCTAssertEqual(Draft.merge(copy(base: nil), with: SavedDraft(text: "Old server")).draft, copy(base: nil), "A server without revisions is revision 0")
    }

    func testMatchingTextIsMarkedSavedOnlyOnceNoOlderSaveIsInFlight() {
        XCTAssertEqual(Draft.merge(copy(base: 1), with: server("Typed here", 4)).draft, copy(dirty: false, base: 4, baseHash: hash("Typed here")))
        let waiting = Draft.merge(copy(base: 1), with: server("Typed here", 4), settled: false)
        XCTAssertEqual(waiting.draft, copy(base: 4, baseHash: hash("Typed here"))); XCTAssertFalse(waiting.push)
    }

    func testAnOlderResponseIsIgnoredUnlessItAnswersTheLatestEdit() {
        XCTAssertEqual(Draft.merge(copy(dirty: nil, base: 7), with: server("Older read", 6)).draft, copy(dirty: nil, base: 7))
        XCTAssertEqual(Draft.merge(copy(dirty: false, base: 3, baseHash: hash("Newer")), with: server("Older", 2)).draft.text, "Typed here",
                       "A late 409 from an older save leaves the newer copy")
        let restored = Draft.merge(copy(base: 7), with: server("Restored", 2), authoritative: true)
        XCTAssertEqual(restored.draft, copy(base: 2, baseHash: hash("Restored"))); XCTAssertTrue(restored.push, "After a database restore, edits still save")
    }

    func testASaveKeepsEditsTypedWhileItWasInFlight() {
        XCTAssertEqual(Draft.merge(copy("Typed", base: 1), with: server("Typed", 2)).draft, copy("Typed", dirty: false, base: 2, baseHash: hash("Typed")))
        XCTAssertEqual(Draft.merge(copy(base: 1), with: server("Typed", 2)).draft, copy(base: 2, baseHash: hash("Typed")))
    }

    func testASentCopyEmptiesButKeepsItsBase() {
        let submission = PendingSubmission(requestId: "r", botId: "bot", text: "Typed here", attachments: [], reviewedInterruption: false)
        XCTAssertEqual(copy(dirty: nil, base: 3, baseHash: "h", sentHash: "s").sent(submission), Draft(dirty: false, baseRevision: 3, baseHash: "h", sentHash: "s"))
        let more = copy("More", base: 3)
        XCTAssertEqual(more.sent(submission), more)
    }
}
