import SwiftUI
import XCTest
@testable import AgentInterface

/// The chat shell's rules: prompt recall, long pastes, the status dock, home's undo, group
/// mentions and live notices, the app badge, the native desktop viewer and the quick switcher.
@MainActor final class ShellFeatureTests: XCTestCase {
  private func message(_ json: String) throws -> Message { try JSONDecoder().decode(Message.self, from: Data(json.utf8)) }
  private func bot(_ id: String, activity: String = "idle", unread: Bool = false, session: String? = nil, at: String? = nil) throws -> Bot {
    let last = at.map { #","lastMessage":{"text":"Hi","at":"\#($0)"}"# } ?? ""
    let sessionField = session.map { #","sessionId":"\#($0)""# } ?? ""
    let json = #"{"id":"\#(id)","name":"\#(id.capitalized)","model":"m","shared":true,"activity":"\#(activity)","unread":\#(unread)\#(sessionField)\#(last)}"#
    return try JSONDecoder().decode(Bot.self, from: Data(json.utf8))
  }

  // MARK: Prompt recall
  func testRecallListsOnlyThisPersonsOwnMessagesNewestFirstWithoutRepeats() throws {
    let messages = try [
      #"{"id":"1","role":"user","text":"Check the hay","sender":{"id":"me","name":"Me"}}"#,
      #"{"id":"2","role":"assistant","text":"Done"}"#,
      #"{"id":"3","role":"user","text":"From my spouse","sender":{"id":"spouse","name":"Spouse"}}"#,
      #"{"id":"4","role":"user","text":"Water the garden","sender":{"id":"me","name":"Me"}}"#,
      #"{"id":"5","role":"user","text":"Water the garden","sender":{"id":"me","name":"Me"}}"#,
      #"{"id":"6","role":"user","text":"Scheduled job handoff: hay","origin":{"kind":"scheduled","visibility":"activity"}}"#,
      #"{"id":"7","role":"user","text":"   "}"#,
      #"{"id":"8","role":"user","text":"Personal chat note"}"#,
    ].map(message)
    XCTAssertEqual(PromptRecall.ownMessages(messages, userId: "me"), ["Personal chat note", "Water the garden", "Check the hay"])
  }
  func testUpStepsBackFromAnEmptyComposerAndDownReturnsToTheEmptyDraft() {
    var recall = PromptRecall()
    var reads = 0
    let history = { reads += 1; return ["Newest", "Middle", "Oldest"] }
    XCTAssertEqual(recall.arrow(up: true, text: "", messages: history), "Newest")
    XCTAssertEqual(recall.arrow(up: true, text: "Newest", messages: history), "Middle")
    XCTAssertEqual(recall.arrow(up: true, text: "Middle", messages: history), "Oldest")
    XCTAssertEqual(recall.arrow(up: true, text: "Oldest", messages: history), "Oldest", "The oldest stays; the key is still taken")
    XCTAssertEqual(reads, 1, "History is read once, when recall starts")
    XCTAssertEqual(recall.arrow(up: false, text: "Oldest", messages: history), "Middle")
    XCTAssertEqual(recall.arrow(up: false, text: "Middle", messages: history), "Newest")
    XCTAssertEqual(recall.arrow(up: false, text: "Newest", messages: history), "", "Past the newest is the empty draft")
    XCTAssertFalse(recall.recalling)
    XCTAssertNil(recall.arrow(up: false, text: "", messages: history), "Down outside recall moves the cursor")
  }
  func testArrowsMoveTheCursorInADraftOrAfterTheRecalledTextIsEdited() {
    var recall = PromptRecall()
    XCTAssertNil(recall.arrow(up: true, text: "My draft", messages: { ["Earlier"] }), "A draft is never replaced")
    XCTAssertNil(recall.arrow(up: true, text: "", messages: { [] }), "Nothing to recall")
    XCTAssertEqual(recall.arrow(up: true, text: "", messages: { ["Earlier", "Older"] }), "Earlier")
    XCTAssertNil(recall.arrow(up: true, text: "Earlier, edited", messages: { ["Earlier", "Older"] }), "Editing keeps the text and ends recall")
    XCTAssertFalse(recall.recalling)
  }
  func testOnlyPlainArrowsOutsideCompositionRecall() {
    XCTAssertEqual(ComposerUITextView.recallArrow(.keyboardUpArrow, [], composing: false), true)
    XCTAssertEqual(ComposerUITextView.recallArrow(.keyboardDownArrow, [], composing: false), false)
    XCTAssertNil(ComposerUITextView.recallArrow(.keyboardUpArrow, .shift, composing: false), "Shift-Up selects")
    XCTAssertNil(ComposerUITextView.recallArrow(.keyboardUpArrow, .command, composing: false), "Cmd-Up jumps")
    XCTAssertNil(ComposerUITextView.recallArrow(.keyboardUpArrow, [], composing: true), "Arrows pick a candidate while composing")
    XCTAssertNil(ComposerUITextView.recallArrow(.keyboardLeftArrow, [], composing: false))
  }
  func testRecallCannotChangeADraftWhoseSendIsInFlight() throws {
    let store = AppStore()
    store.selectedBotId = "ranch"
    store.draftReady = true
    store.draft = Draft(text: "Sent words")
    store.pendings["ranch"] = PendingSubmission(requestId: "r1", botId: "ranch", text: "Sent words", attachments: [],
      reviewedInterruption: false, draftBaseRevision: 0)
    store.sending = true
    XCTAssertTrue(store.sendingDraft)
    store.editComposer { $0.text = "Recalled words" }
    XCTAssertEqual(store.draft.text, "Sent words", "The sent copy stays as it was sent")
  }

  // MARK: Long paste
  func testPastesOf32KiBOfUTF8BecomeAnAttachment() {
    XCTAssertFalse(LargePaste.attaches(String(repeating: "a", count: 32 * 1024 - 1)))
    XCTAssertTrue(LargePaste.attaches(String(repeating: "a", count: 32 * 1024)))
    // Bytes, not characters: 10,923 euro signs are 32,769 bytes.
    let euros = String(repeating: "€", count: 10_923)
    XCTAssertLessThan(euros.count, LargePaste.threshold)
    XCTAssertTrue(LargePaste.attaches(euros))
  }
  func testALongPasteIsWrittenAsPastedTextInItsOwnFolder() throws {
    let text = String(repeating: "line\n", count: 7_000)
    let first = try LargePaste.file(text), second = try LargePaste.file(text)
    defer { for url in [first, second] { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) } }
    XCTAssertEqual(first.lastPathComponent, "Pasted text.txt")
    XCTAssertNotEqual(first.deletingLastPathComponent(), second.deletingLastPathComponent(), "Two pastes never collide")
    XCTAssertEqual(try String(contentsOf: first, encoding: .utf8), text)
    if case .failure(let problem) = UploadRules.prepare(name: first.lastPathComponent, mime: "text/plain", size: text.utf8.count) {
      XCTFail("The upload rules refuse a pasted text file: \(problem.message)")
    }
  }

  // MARK: Status dock
  func testDockSortsByUrgencyWhateverOrderStatesArrive() {
    let items = DockItem.items(connectionLost: true, uncertain: true, receiptStatus: "rejected", receiptMessage: nil,
      interrupted: true, decisions: 2, holdsText: true)
    XCTAssertEqual(items, [.connection, .uncertainSend, .rejected("Hermes did not accept this message. Your draft is saved."),
      .interruptionReview, .decisions(2), .heldText])
    XCTAssertEqual(DockItem.items(connectionLost: false, uncertain: false, receiptStatus: "interrupted", receiptMessage: nil,
      interrupted: false, decisions: 1, holdsText: false), [.interruptedSubmission, .decisions(1)])
    XCTAssertEqual(DockItem.items(connectionLost: false, uncertain: false, receiptStatus: "accepted", receiptMessage: "ok",
      interrupted: false, decisions: 0, holdsText: false), [], "A quiet chat shows no dock")
    XCTAssertEqual(DockItem.items(connectionLost: false, uncertain: false, receiptStatus: "rejected", receiptMessage: "Too long",
      interrupted: false, decisions: 0, holdsText: false), [.rejected("Too long")])
  }
  func testDecisionsLabelCountsInWords() {
    XCTAssertEqual(DockItem.decisionsLabel(1), "1 decision waiting")
    XCTAssertEqual(DockItem.decisionsLabel(3), "3 decisions waiting")
  }

  // MARK: Undo
  func testUndoReversesOnlyTheLatestChangeOnce() throws {
    let ranch = try bot("ranch")
    var queue = UndoQueue()
    let first = UndoToast.pin(ranch, pinned: true)
    queue.show(first)
    let second = UndoToast.move(ranch, from: "yard", to: "Kitchen")
    queue.show(second)
    XCTAssertNil(queue.undo(first.id), "A replaced toast's undo lapsed")
    queue.expire(first.id)
    XCTAssertEqual(queue.current, second, "An older timer leaves the newer toast")
    XCTAssertEqual(queue.undo(second.id), .move(botId: "ranch", from: "yard"))
    XCTAssertNil(queue.undo(second.id), "Undo runs once")
    XCTAssertNil(queue.current)
    XCTAssertEqual(second.message, "Moved Ranch to Kitchen")
    XCTAssertEqual(UndoToast.move(ranch, from: "yard", to: nil).message, "Removed Ranch from its section")
    XCTAssertEqual(first.announcement, "Pinned Ranch. Undo is available for 5 seconds.")
  }
  func testUndoingAPinPutsTheAssistantBackOnlyIfItIsStillChanged() async throws {
    let store = AppStore()
    let json = #"{"user":{"id":"one","name":"One","email":"one@example.test"},"household":[],"preferences":{"presentation":"simple","theme":"system","favorites":[],"sections":[{"id":"yard","name":"Yard","botIds":[]}],"followBots":[]},"bots":[],"capabilities":{},"connection":{"connected":true},"csrfToken":null}"#
    store.bootstrap = try JSONDecoder().decode(Bootstrap.self, from: Data(json.utf8))
    // Unpinned from home; Undo pins it again.
    await store.undo(.pin(botId: "ranch", pinned: false))
    XCTAssertEqual(store.homePreferences?.favorites, ["ranch"])
    // Pinned from home, but already unpinned elsewhere: nothing to reverse.
    store.discardPreferenceChanges()
    await store.undo(.pin(botId: "ranch", pinned: true))
    XCTAssertEqual(store.homePreferences?.favorites, [])
    await store.undo(.move(botId: "ranch", from: "yard"))
    XCTAssertEqual(store.homeSectionId(of: "ranch"), "yard")
    XCTAssertEqual(store.homeSectionName("yard"), "Yard")
  }

  // MARK: Group chats
  private let members = [
    GroupMember(member_id: "ranch", profile: "ranch", handle: "ranch", display_name: "Ranch hand"),
    GroupMember(member_id: "kitchen", profile: "kitchen", handle: "kitchen", display_name: "Kitchen companion"),
    GroupMember(member_id: "planner", profile: "planner", handle: "planner", display_name: "Meal planner"),
  ]
  func testAMentionIsTheAtWordEndingTheDraft() {
    XCTAssertEqual(GroupMentions.query(in: "@"), "")
    XCTAssertEqual(GroupMentions.query(in: "Ask @kit"), "kit")
    XCTAssertNil(GroupMentions.query(in: "Ask @kitchen about it"), "The mention was finished")
    XCTAssertNil(GroupMentions.query(in: "mail me@example"), "An address is not a mention")
    XCTAssertNil(GroupMentions.query(in: "No mention"))
  }
  func testSuggestionsMatchHandlesFirstThenNames() {
    XCTAssertEqual(GroupMentions.suggestions(for: "", members: members).map(\.handle), ["ranch", "kitchen", "planner"])
    XCTAssertEqual(GroupMentions.suggestions(for: "K", members: members).map(\.handle), ["kitchen"])
    XCTAssertEqual(GroupMentions.suggestions(for: "meal", members: members).map(\.handle), ["planner"], "Display names match by word")
    XCTAssertEqual(GroupMentions.suggestions(for: "companion", members: members).map(\.handle), ["kitchen"])
    XCTAssertEqual(GroupMentions.suggestions(for: "ranch", members: members), [], "A complete handle needs no suggestion")
  }
  func testChoosingASuggestionCompletesTheMention() {
    XCTAssertEqual(GroupMentions.insert(members[1], into: "Ask @kit"), "Ask @kitchen ")
    XCTAssertEqual(GroupMentions.insert(members[1], into: "@"), "@kitchen ")
    XCTAssertEqual(GroupMentions.insert(members[0], into: "Hello"), "Hello @ranch ")
    XCTAssertEqual(GroupMentions.insert(members[0], into: ""), "@ranch ")
  }
  func testHumanMessagesNameTheirSenderAndOlderServersStillDecode() throws {
    func event(_ sender: String) throws -> GroupEvent {
      let json = #"{"event_id":"e","seq":1,"kind":"message.user","created_at":1,"payload":{"text":"hi"}\#(sender)}"#
      return try JSONDecoder().decode(GroupEvent.self, from: Data(json.utf8))
    }
    XCTAssertEqual(GroupConversationView.memberName(try event(#","sender":{"id":"u","name":"Kim"}"#)), "Kim")
    XCTAssertEqual(GroupConversationView.memberName(try event("")), "Household member")
    XCTAssertNil(try event(#","sender":"Kim""#).sender, "A sender of another shape is left out, not fatal")
    XCTAssertEqual(GroupConversationView.memberName(try event(#","sender":{"id":"u","name":" "}"#)), "Household member")
  }
  func testOnlyANoticeOfNewEventsInThisRoomLoads() {
    let notice = GroupNotice.parse(event: "group", data: #"{"roomId":"r1","latestSeq":7}"#)
    XCTAssertEqual(notice, GroupNotice(roomId: "r1", latestSeq: 7))
    XCTAssertTrue(GroupNotice.news(notice, room: "r1", cursor: 6))
    XCTAssertFalse(GroupNotice.news(notice, room: "r1", cursor: 7), "Already loaded")
    XCTAssertFalse(GroupNotice.news(notice, room: "r2", cursor: 0), "Another room")
    XCTAssertNil(GroupNotice.parse(event: "", data: "roster"), "Roster notices share the stream")
    XCTAssertNil(GroupNotice.parse(event: "group", data: "{bad"))
  }
  func testGroupFallbackPollIsSlowNowThatTheServerAnnouncesChanges() {
    XCTAssertEqual(GroupConversationView.fallbackInterval, .seconds(30))
  }

  // MARK: Badge
  func testBadgeCountsEachUnreadOrDecidingAssistantOnce() throws {
    let bots = try [bot("a", unread: true), bot("b", activity: "waiting"), bot("c", activity: "blocked", unread: true),
      bot("d", activity: "working"), bot("e")]
    XCTAssertEqual(AppBadge.count(bots: bots, unread: { $0.unread == true }, deciding: { AppBadge.deciding($0.activity) }), 3)
    XCTAssertEqual(AppBadge.count(bots: [], unread: { _ in true }, deciding: { _ in true }), 0)
  }
  func testStoreBadgeUsesHomesUnreadRuleAndClearsWhenSignedOut() throws {
    let store = AppStore()
    let json = #"{"user":{"id":"one","name":"One","email":"one@example.test"},"household":[],"preferences":{"presentation":"simple","theme":"system","favorites":[],"sections":[],"followBots":[]},"bots":[{"id":"a","name":"A","model":"m","shared":true,"activity":"idle","unread":true,"lastMessage":{"text":"x","at":"2026-10-01T12:00:00Z"}},{"id":"b","name":"B","model":"m","shared":true,"activity":"waiting"},{"id":"c","name":"C","model":"m","shared":true,"activity":"idle"}],"capabilities":{},"connection":{"connected":true},"csrfToken":null}"#
    store.bootstrap = try JSONDecoder().decode(Bootstrap.self, from: Data(json.utf8))
    XCTAssertEqual(store.badgeCount, 2)
    store.sessionExpired = true
    XCTAssertEqual(store.badgeCount, 0)
  }

  // MARK: Native desktop
  func testViewerPageCarriesTheTicketOnlyInItsFragment() throws {
    let base = URL(string: "https://agentui.example.test")!
    let url = try XCTUnwrap(DesktopLink.pageURL(base: base, path: "/api/computer/desktop/ws?ticket=abc_-123", control: false))
    XCTAssertEqual(url.absoluteString, "https://agentui.example.test/native/computer#path=%2Fapi%2Fcomputer%2Fdesktop%2Fws%3Fticket%3Dabc_-123&control=0")
    XCTAssertNil(url.query, "Nothing about the ticket reaches the server's logs")
    XCTAssertEqual(DesktopLink.fragment(path: "/p", control: true), "path=%2Fp&control=1")
    XCTAssertEqual(DesktopWebView.literal("a'b\"c</script>"), #""a'b\"c<\/script>""#)
  }
  func testATicketIsUsableOnlyBeforeItExpires() {
    let now = Date(timeIntervalSince1970: 1_000_000)
    func ticket(_ offset: TimeInterval) -> DesktopTicket {
      DesktopTicket(path: "/p", expiresAt: ISO8601DateFormatter().string(from: now.addingTimeInterval(offset)), viewerId: nil)
    }
    XCTAssertTrue(DesktopLink.usable(ticket(30), now: now))
    XCTAssertFalse(DesktopLink.usable(ticket(0.5), now: now), "Too close to expiry to connect")
    XCTAssertFalse(DesktopLink.usable(ticket(-5), now: now))
    XCTAssertFalse(DesktopLink.usable(DesktopTicket(path: "/p", expiresAt: "soon", viewerId: nil), now: now))
  }
  func testReconnectsBackOffThenStopForAManualReconnect() {
    XCTAssertEqual((0..<6).map { DesktopLink.retryDelay(attempt: $0) }, [.seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(8), nil])
  }
  func testControlFollowsTheServersOwnerAndTakeOverRespectsAnotherMember() throws {
    func status(_ control: String, available: Bool = true) throws -> ComputerStatus {
      try JSONDecoder().decode(ComputerStatus.self, from: Data(#"{"available":\#(available),"control":\#(control)}"#.utf8))
    }
    XCTAssertTrue(DesktopLink.controlling(try status(#"{"kind":"human","mine":true}"#)))
    XCTAssertFalse(DesktopLink.controlling(try status(#"{"kind":"human","mine":false,"name":"Kim"}"#)))
    XCTAssertFalse(DesktopLink.controlling(nil))
    XCTAssertTrue(DesktopLink.canTake(try status(#"{"kind":"bot","name":"Ranch"}"#)), "Taking over from an assistant pauses it")
    XCTAssertTrue(DesktopLink.canTake(try status(#"{"kind":"idle"}"#)))
    XCTAssertFalse(DesktopLink.canTake(try status(#"{"kind":"human","mine":false,"name":"Kim"}"#)))
    XCTAssertFalse(DesktopLink.canTake(try status(#"{"kind":"idle"}"#, available: false)))
  }
  func testViewerNavigatesOnlyToTheServersViewerPage() {
    let base = URL(string: "https://agentui.example.test")!
    XCTAssertTrue(DesktopLink.allows(URL(string: "https://agentui.example.test/native/computer#path=x")!, base: base))
    XCTAssertFalse(DesktopLink.allows(URL(string: "https://agentui.example.test/settings")!, base: base))
    XCTAssertFalse(DesktopLink.allows(URL(string: "https://evil.example.test/native/computer")!, base: base))
    XCTAssertFalse(DesktopLink.allows(URL(string: "http://agentui.example.test/native/computer")!, base: base))
    XCTAssertTrue(DesktopLink.allows(URL(string: "about:blank")!, base: base))
  }

  // MARK: Search, switcher, sheets and pickers
  func testOnlyHitsInTheAssistantsCurrentSessionOpenTheLiveChat() throws {
    func hit(_ session: String, message: String? = "m1", routine: String? = nil) throws -> SearchHit {
      var fields = #""botId":"ranch","botName":"Ranch","sessionId":"\#(session)","title":"t","snippet":"s""#
      if let message { fields += #","messageId":"\#(message)""# }
      if let routine { fields += #","routineId":"\#(routine)""# }
      return try JSONDecoder().decode(SearchHit.self, from: Data("{\(fields)}".utf8))
    }
    let bots = [try bot("ranch", session: "live")]
    XCTAssertEqual(DiscoveryView.liveMessage(try hit("live"), bots: bots), "m1")
    XCTAssertNil(DiscoveryView.liveMessage(try hit("old"), bots: bots), "Another session opens its history")
    XCTAssertNil(DiscoveryView.liveMessage(try hit("live", message: nil), bots: bots))
    XCTAssertNil(DiscoveryView.liveMessage(try hit("live", routine: "r"), bots: bots))
    XCTAssertNil(DiscoveryView.liveMessage(try hit("live"), bots: [try bot("ranch")]), "No known session is never live")
    XCTAssertEqual(DiscoveryView.minimumQuery, 2)
    XCTAssertEqual(DiscoveryView.searchDelay, .milliseconds(300))
    XCTAssertEqual(DiscoveryView.resultsAnnouncement(1), "1 result")
  }
  func testQuickSwitcherListsPinnedAssistantsFirstThenMatchingViews() throws {
    let bots = try [bot("alpha"), bot("kitchen"), bot("ranch")]
    let all = QuickSwitch.entries(query: "", bots: bots, pinned: ["ranch", "kitchen"])
    XCTAssertEqual(all.map(\.target), [.bot("ranch"), .bot("kitchen"), .bot("alpha"), .today, .groups, .search])
    XCTAssertEqual(QuickSwitch.entries(query: "kit", bots: bots, pinned: []).map(\.target), [.bot("kitchen")])
    XCTAssertEqual(QuickSwitch.entries(query: "group", bots: bots, pinned: []).map(\.target), [.groups])
    XCTAssertEqual(QuickSwitch.entries(query: "zzz", bots: bots, pinned: []), [])
  }
  func testAShortOptionListIsSegmentedAndALongOneStaysAMenu() {
    XCTAssertTrue(InferenceChoice.segmented(InferenceSettings.speeds.count))
    XCTAssertFalse(InferenceChoice.segmented(InferenceSettings.reasoningLevels.count))
    XCTAssertFalse(InferenceChoice.segmented(1))
  }
  func testAssistantCardSheetFitsItsContent() {
    XCTAssertEqual(FittedSheet.detents(contentHeight: 300, available: 900), [.medium, .large], "Fits in the medium detent")
    XCTAssertEqual(FittedSheet.detents(contentHeight: 600, available: 900), [.height(676), .large], "Its own height")
    XCTAssertEqual(FittedSheet.detents(contentHeight: 900, available: 900), [.large])
    XCTAssertEqual(FittedSheet.detents(contentHeight: nil, available: 900), [.medium, .large], "Unmeasured on iOS 17")
  }
  func testAssistantCardRoleLineAndLastActivity() throws {
    let quiet = try bot("ranch")
    XCTAssertEqual(BotProfileView.roleLine(quiet), "Shared assistant")
    XCTAssertEqual(BotProfileView.lastActivity(quiet, now: Date()), "No messages yet")
    let now = Date(timeIntervalSince1970: 1_790_000_000)
    let recent = try bot("ranch", at: ISO8601DateFormatter().string(from: now.addingTimeInterval(-600)))
    XCTAssertEqual(BotProfileView.lastActivity(recent, now: now), "10 min ago")
  }
}
