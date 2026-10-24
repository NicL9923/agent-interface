import SwiftUI
import XCTest
import os

@testable import AgentInterface

/// Siri, Shortcuts, Spotlight and the configurable widget read what the app already writes for
/// the widgets: the App Group snapshot of the signed-in account's assistants.
@MainActor final class AssistantSurfaceTests: XCTestCase {
  private var directory: URL!
  private var url: URL { directory.appendingPathComponent("snapshot.json") }
  private let now = Date(timeIntervalSince1970: 1_800_000_000)
  override func setUp() async throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent("assistant-surface-" + UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    AssistantEntityQuery.snapshotURL = url
  }
  override func tearDown() async throws {
    AssistantEntityQuery.snapshotURL = WidgetSnapshotStore.defaultURL
    try? FileManager.default.removeItem(at: directory)
  }
  private func assistant(_ id: String, _ activity: String = "idle", pinned: Bool = false, at: TimeInterval? = nil) -> WidgetSnapshot.Assistant {
    .init(id: id, name: id.capitalized, activity: activity, lastMessage: nil, lastMessageAt: at.map { Date(timeIntervalSince1970: 1_800_000_000 - $0) }, color: nil, pinned: pinned)
  }
  private func snapshot(_ assistants: [WidgetSnapshot.Assistant], scope: String = "one") -> WidgetSnapshot {
    WidgetSnapshot(scope: scope, generatedAt: now, assistants: assistants)
  }
  private func writeSnapshot(_ assistants: [WidgetSnapshot.Assistant], scope: String = "one") {
    WidgetSnapshotStore.write(snapshot(assistants, scope: scope), to: url)
  }

  // MARK: Entities

  func testEntityQueryReadsTheSnapshotInItsOrderAndSignOutEmptiesIt() async throws {
    let query = AssistantEntityQuery()
    let none = try await query.suggestedEntities()
    XCTAssertEqual(none, [], "No snapshot, no assistants")
    writeSnapshot([assistant("garden", at: 600), assistant("ranch", "working"), assistant("kitchen", "waiting"), assistant("school", pinned: true, at: 3600)])
    let suggested = try await query.suggestedEntities()
    XCTAssertEqual(suggested.map(\.id), ["kitchen", "ranch", "school", "garden"], "Needs you, working, pinned, then recent")
    XCTAssertEqual(suggested.first?.name, "Kitchen")
    // The snapshot goes away on sign-out, and the entities with it.
    WidgetSnapshotStore.write(nil, to: url)
    let afterSignOut = try await query.suggestedEntities()
    XCTAssertEqual(afterSignOut, [])
    let byId = try await query.entities(for: ["kitchen"])
    XCTAssertEqual(byId, [], "A shortcut holding an old assistant finds nothing after sign-out")
  }
  func testEntitiesResolveInRequestedOrderSkipMissingAndSearchByName() async throws {
    writeSnapshot([assistant("kitchen"), assistant("ranch"), assistant("garden")])
    let query = AssistantEntityQuery()
    let ordered = try await query.entities(for: ["garden", "gone", "kitchen"])
    XCTAssertEqual(ordered.map(\.id), ["garden", "kitchen"])
    let matching = try await query.entities(matching: "  RAN ")
    XCTAssertEqual(matching.map(\.id), ["ranch"])
    let blank = try await query.entities(matching: "  ")
    XCTAssertEqual(blank.count, 3, "An empty search lists everyone")
  }

  // MARK: Intents

  func testIntentsOpenTheSameLinksAsWidgetsAndNotifications() {
    let kitchen = AssistantEntity(id: "kitchen", name: "Kitchen")
    XCTAssertEqual(DeepLink.relativePath(for: OpenAssistantIntent(assistant: kitchen).destination), "/?bot=kitchen")
    XCTAssertEqual(DeepLink.relativePath(for: OpenTodayIntent().destination), "/?view=today")
    // An id with characters a URL treats specially survives the round trip.
    let odd = AssistantEntity(id: "a b&c=d", name: "Odd")
    XCTAssertEqual(DeepLink.relativePath(for: OpenAssistantIntent(assistant: odd).destination).flatMap { URLComponents(string: $0)?.queryItems?.first?.value }, "a b&c=d")
  }
  func testAskRequestNeedsASignedInAssistantAndRealText() throws {
    let current = snapshot([assistant("kitchen")], scope: "one")
    let request = try AskRequest.make(botId: "kitchen", text: "  What is for dinner?\n", snapshot: current, now: now)
    XCTAssertEqual(request, AskRequest(botId: "kitchen", text: "What is for dinner?", scope: "one", at: now))
    func fails(_ botId: String, _ text: String, _ snapshot: WidgetSnapshot?, _ expected: AssistantIntentError, line: UInt = #line) {
      XCTAssertThrowsError(try AskRequest.make(botId: botId, text: text, snapshot: snapshot, now: now), line: line) { error in
        XCTAssertEqual(String(describing: error), String(describing: expected), line: line)
      }
    }
    fails("kitchen", "Hi", nil, .signedOut)
    fails("gone", "Hi", current, .missing)
    fails("kitchen", " \n ", current, .empty)
    fails("kitchen", String(repeating: "a", count: AppStore.maxMessageLength + 1), current, .tooLong)
    XCTAssertNoThrow(try AskRequest.make(botId: "kitchen", text: String(repeating: "a", count: AppStore.maxMessageLength), snapshot: current))
  }

  private static let askOrigin = "https://one.invalid"
  private static func forgetHeldText() {
    let scope = Data((askOrigin + "|one").utf8).base64URLEncoded
    UserDefaults.standard.removeObject(forKey: "native.\(scope).draftAdditions")
  }
  private func askBootstrap() throws -> Bootstrap {
    try JSONDecoder().decode(Bootstrap.self, from: Data("""
      {"user":{"id":"one","name":"One","email":"one@example.test"},"household":[],
       "preferences":{"presentation":"simple","theme":"system","favorites":[],"sections":[],"followBots":[]},
       "bots":[{"id":"kitchen","name":"Kitchen","model":"m","shared":true,"activity":"idle"},
               {"id":"garden","name":"Garden","model":"m","shared":false,"activity":"idle"}],
       "capabilities":{},"connection":{"connected":true}}
      """.utf8))
  }
  private func askStore(draft: String = "", bootstrap: Bool = true) throws -> AppStore {
    Self.forgetHeldText()
    addTeardownBlock { @MainActor in Self.forgetHeldText() }
    let store = AppStore()
    store.widgetSnapshotURL = url
    store.api = APIClient(baseURL: URL(string: Self.askOrigin)!)
    if bootstrap { store.bootstrap = try askBootstrap() }
    store.selectedBotId = "kitchen"
    store.draft = Draft(text: draft, attachments: [], dirty: true)
    store.draftReady = true
    return store
  }
  private func ask(_ store: AppStore, _ text: String = "What is for dinner?", bot: String = "kitchen", scope: String? = nil, at: Date? = nil) -> AskRequest {
    AskRequest(botId: bot, text: text, scope: scope ?? store.scope ?? Data((Self.askOrigin + "|one").utf8).base64URLEncoded, at: at ?? Date())
  }

  func testAskLandsInTheDraftAfterExistingTextOpensTheChatAndNeverSends() async throws {
    let store = try askStore(draft: "Milk")
    let opened = store.conversationRequest
    store.queueAsk(ask(store))
    await store.deliverAdditions()
    XCTAssertEqual(store.draft.text, "Milk\n\nWhat is for dinner?")
    XCTAssertTrue(store.additions.isEmpty)
    XCTAssertNotEqual(store.conversationRequest, opened, "The chat opens for review")
    XCTAssertFalse(store.sending); XCTAssertTrue(store.pendings.isEmpty); XCTAssertTrue(store.receipts.isEmpty)
    store.suspend()
  }
  func testAskWaitsForAnUnsettledSendThenLandsInTheClearedDraft() async throws {
    let store = try askStore(draft: "Sent already")
    store.pendings["kitchen"] = PendingSubmission(requestId: "r1", botId: "kitchen", text: "Sent already", attachments: [], reviewedInterruption: false)
    store.queueAsk(ask(store))
    await store.deliverAdditions()
    XCTAssertEqual(store.draft.text, "Sent already", "The sent copy is left exactly as sent, like the Share inbox")
    XCTAssertEqual(store.additions.map(\.text), ["What is for dinner?"], "The question waits")
    XCTAssertTrue(store.holdsText(for: "kitchen"), "The composer says why")
    // The send settles and its draft clears; the question arrives in the empty draft.
    store.draft.text = ""
    store.pendings = [:]
    await store.deliverAdditions()
    XCTAssertEqual(store.draft.text, "What is for dinner?")
    XCTAssertTrue(store.additions.isEmpty)
    store.suspend()
  }
  func testAskForAnotherAccountOrAGoneAssistantOrAStaleRequestIsDropped() async throws {
    let store = try askStore(draft: "Mine")
    for request in [ask(store, scope: "someone-else"), ask(store, bot: "gone"), ask(store, at: Date().addingTimeInterval(-AskRequest.patience - 1))] {
      store.queueAsk(request)
      await store.deliverAdditions()
      XCTAssertTrue(store.additions.isEmpty, "\(request)")
      XCTAssertEqual(store.draft.text, "Mine")
    }
    store.suspend()
  }
  func testSignOutSetsAWaitingAskAsideForItsOwnAccountOnly() async throws {
    let store = try askStore()
    store.pendings["kitchen"] = PendingSubmission(requestId: "r1", botId: "kitchen", text: "", attachments: [], reviewedInterruption: false)
    store.queueAsk(ask(store))
    await store.signOut(localOnly: true)
    XCTAssertTrue(store.additions.isEmpty)
    // Another person signing in never sees it.
    store.api = APIClient(baseURL: URL(string: Self.askOrigin)!)
    var other = try askBootstrap(); other.user.id = "two"
    store.bootstrap = other
    XCTAssertTrue(store.additions.isEmpty)
    // The same person signing in again finds it waiting, within its five minutes.
    store.bootstrap = try askBootstrap()
    XCTAssertEqual(store.additions.map(\.text), ["What is for dinner?"])
    store.suspend()
  }
  func testAskBeforeTheStoreExistsIsHandedOverWhenItDoes() async throws {
    let controller = NotificationController()
    let store = try askStore()
    let request = ask(store, "Hi")
    controller.ask(request)
    XCTAssertEqual(controller.earlyAsk, request)
    controller.store = store
    XCTAssertNil(controller.earlyAsk)
    XCTAssertEqual(store.additions.map(\.text), ["Hi"])
    await store.deliverAdditions()
    XCTAssertEqual(store.draft.text, "Hi")
    store.suspend()
  }
  func testAskBeforeTheSignInLoadsWaitsForItsAccount() async throws {
    let store = try askStore(draft: "Milk", bootstrap: false)
    store.queueAsk(ask(store, "Eggs too"))
    store.queueAsk(ask(store, "For someone else", scope: "someone-else"))
    await store.deliverAdditions()
    XCTAssertEqual(store.draft.text, "Milk", "Nothing joins before the account is known")
    store.bootstrap = try askBootstrap()
    await store.deliverAdditions()
    XCTAssertEqual(store.draft.text, "Milk\n\nEggs too", "Only the signed-in account's question lands")
    XCTAssertTrue(store.additions.isEmpty)
    store.suspend()
  }

  func testTalkLinkRecordsOnlyWhileFreshAndForItsAccount() async throws {
    let store = try askStore()
    let controller = NotificationController()
    await controller.open(DeepLink.bot("kitchen", listen: true))
    XCTAssertNotNil(controller.listenLinkAt, "Without a store the link waits")
    // It waited for sign-in longer than a person would expect the microphone to start.
    controller.listenLinkAt = Date().addingTimeInterval(-ListenRequest.patience)
    controller.store = store
    await controller.openPendingConversation()
    XCTAssertEqual(store.listenRequest?.botId, "kitchen")
    XCTAssertEqual(store.listenRequest?.scope, store.scope)
    XCTAssertEqual(store.listenRequest?.fresh(), false, "A link that waited does not start the microphone")
    store.listenRequest = nil
    await controller.open(DeepLink.bot("kitchen", listen: true))
    XCTAssertEqual(store.listenRequest?.fresh(), true)
    // A link the widget extension handed over keeps the time the control was used.
    store.listenRequest = nil
    await controller.open(DeepLink.bot("kitchen", listen: true), at: Date().addingTimeInterval(-ListenRequest.patience))
    XCTAssertEqual(store.listenRequest?.fresh(), false)
    // An ordinary link to the same chat never records.
    store.listenRequest = nil
    await controller.open(DeepLink.bot("kitchen"))
    XCTAssertNil(store.listenRequest)
    store.suspend()
  }

  func testTalkLinkNeverRecordsForAnAccountThatSignedInWhileTheChatOpened() async throws {
    let gate = DispatchSemaphore(value: 0), holding = OSAllocatedUnfairLock(initialState: false)
    let server = FakeServer { _ in
      if holding.withLock({ $0 }) { _ = gate.wait(timeout: .now() + 10) }
      return .init(body: "{}")
    }
    let store = AppStore()
    store.widgetSnapshotURL = nil
    store.api = server.api()
    store.bootstrap = try askBootstrap()
    let controller = NotificationController()
    controller.store = store
    let before = server.requests.count
    holding.withLock { $0 = true }
    let opening = Task { await controller.open(DeepLink.bot("kitchen", listen: true)) }
    try await until { server.requests.count > before }
    var other = try askBootstrap(); other.user.id = "two"
    store.bootstrap = other
    holding.withLock { $0 = false }
    for _ in 0..<20 { gate.signal() }
    await opening.value
    XCTAssertNil(store.listenRequest, "The request belonged to the account that asked for it")
    store.suspend()
  }

  // MARK: Widget settings

  func testWidgetShowsOnlyChosenAssistantsAndCountsThem() throws {
    let all = snapshot([assistant("kitchen", "waiting"), assistant("ranch", "working"), assistant("garden")])
    let intent = SelectAssistantsIntent()
    XCTAssertEqual(intent.shown(in: all), all, "Nothing chosen keeps today's behavior")
    intent.assistants = []
    XCTAssertEqual(intent.shown(in: all), all)
    intent.assistants = [AssistantEntity(id: "garden", name: "Garden"), AssistantEntity(id: "ranch", name: "Ranch")]
    let shown = try XCTUnwrap(intent.shown(in: all))
    XCTAssertEqual(shown.ordered.map(\.id), ["ranch", "garden"])
    XCTAssertEqual(shown.attentionCount, 0, "The header describes what the widget shows")
    XCTAssertEqual(shown.summary, "1 working")
    XCTAssertEqual(shown.scope, all.scope); XCTAssertEqual(shown.generatedAt, all.generatedAt, "Staleness is the snapshot's")
    intent.assistants = [AssistantEntity(id: "removed", name: "Removed")]
    XCTAssertEqual(intent.shown(in: all), all, "A choice that left the household falls back instead of showing nothing")
    intent.assistants = [AssistantEntity(id: "kitchen", name: "Kitchen"), AssistantEntity(id: "removed", name: "Removed")]
    XCTAssertEqual(intent.shown(in: all)?.assistants.map(\.id), ["kitchen"])
    XCTAssertNil(intent.shown(in: nil), "Signed out stays signed out")
  }

  // MARK: Spotlight

  private final class FakeIndex: SpotlightIndexing {
    var calls: [String] = []
    func index(_ records: [SpotlightRecord]) { calls.append("index " + records.map { "\($0.id)=\($0.title)" }.joined(separator: ",")) }
    func delete(ids: [String]) { calls.append("delete " + ids.joined(separator: ",")) }
    func deleteAll() { calls.append("deleteAll") }
  }
  private func spotlight() -> (AssistantSpotlight, FakeIndex) {
    let suite = "spotlight-test-" + UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
    let index = FakeIndex()
    return (AssistantSpotlight(index: index, defaults: defaults), index)
  }
  func testSpotlightIndexesRemovesLeaversAndClearsOnSignOutAndAccountChange() {
    let (spotlight, index) = spotlight()
    XCTAssertFalse(spotlight.sync(nil), "Nothing was indexed, so nothing to clear"); XCTAssertEqual(index.calls, [])
    XCTAssertTrue(spotlight.sync(snapshot([assistant("kitchen"), assistant("ranch")])))
    XCTAssertEqual(index.calls, ["index kitchen=Kitchen,ranch=Ranch"])
    index.calls = []
    XCTAssertFalse(spotlight.sync(snapshot([assistant("ranch", "working"), assistant("kitchen", pinned: true)])), "State changes are not Spotlight changes")
    XCTAssertEqual(index.calls, [])
    XCTAssertTrue(spotlight.sync(snapshot([assistant("kitchen"), assistant("garden")])))
    XCTAssertEqual(index.calls, ["delete ranch", "index garden=Garden"], "A disappeared assistant leaves, and only new ones are indexed")
    index.calls = []
    XCTAssertTrue(spotlight.sync(snapshot([assistant("kitchen"), assistant("garden")], scope: "two")))
    XCTAssertEqual(index.calls, ["deleteAll", "index garden=Garden,kitchen=Kitchen"], "Another account never sees the first account's names")
    index.calls = []
    XCTAssertTrue(spotlight.sync(nil)); XCTAssertEqual(index.calls, ["deleteAll"])
    XCTAssertFalse(spotlight.sync(nil), "Signing out twice clears once"); XCTAssertEqual(index.calls, ["deleteAll"])
    XCTAssertTrue(spotlight.sync(snapshot([assistant("kitchen")], scope: "two")), "Signing back in indexes again")
  }
  func testAppFollowsTheSnapshotIntoSpotlightAndForgetsOnSignOut() async throws {
    let store = try askStore()
    let (spotlight, index) = spotlight()
    store.spotlight = spotlight
    store.bootstrap = store.bootstrap
    XCTAssertEqual(index.calls, ["index garden=Garden,kitchen=Kitchen"])
    var outage = try XCTUnwrap(store.bootstrap)
    outage.connection.connected = false
    index.calls = []
    store.bootstrap = outage
    XCTAssertEqual(index.calls, [], "An outage keeps the last good index, like the snapshot")
    await store.signOut(localOnly: true)
    XCTAssertEqual(index.calls, ["deleteAll"])
  }

  // MARK: Keyboard and haptics

  func testPinnedShortcutsFollowPinOrderAndStopAtNine() throws {
    let store = try askStore()
    XCTAssertEqual(store.pinnedForShortcuts.map(\.id), [])
    var value = try XCTUnwrap(store.bootstrap)
    value.bots = (1...11).map { number in
      var bot = value.bots[0]
      bot.id = "bot\(number)"; bot.name = "Bot \(number)"
      return bot
    }
    value.preferences.favorites = ["bot11", "bot3", "missing", "bot3"] + (1...10).map { "bot\($0)" }
    store.bootstrap = value
    XCTAssertEqual(store.pinnedForShortcuts.map(\.id), ["bot11", "bot3", "bot1", "bot2", "bot4", "bot5", "bot6", "bot7", "bot8"])
  }
  func testCommandsAndHapticsAreDistinctEvenWhenRepeated() throws {
    let store = try askStore()
    store.command(.find); let first = store.keyboardCommand
    store.command(.find)
    XCTAssertNotEqual(first, store.keyboardCommand, "Pressing Cmd+F twice is two events")
    store.buzz(.failed); let buzz = store.haptic
    store.buzz(.failed)
    XCTAssertNotEqual(buzz, store.haptic)
    XCTAssertEqual(Haptic.failed.feedback, .error); XCTAssertEqual(Haptic.replied.feedback, .success)
  }
  func testSwipeActionTracksOnlyMostlyHorizontalLeftDrags() {
    XCTAssertTrue(SwipeAction.shouldTrack(CGSize(width: -40, height: 10)))
    XCTAssertFalse(SwipeAction.shouldTrack(CGSize(width: -10, height: 40)), "Scrolling wins")
    XCTAssertFalse(SwipeAction.shouldTrack(CGSize(width: 60, height: 0)), "Rightward drags belong to navigation")
  }
}
