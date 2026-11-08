import AppIntents
import UserNotifications
import XCTest

@testable import AgentInterface

/// What reaches the person outside the open app: widgets kept current in the background, the Live
/// Activity's Stop and Decline, the Focus filter, Handoff and universal links, and Siri's status answer.
@MainActor final class NativeReachTests: XCTestCase {
  private let server = URL(string: "https://agentui.example.test")!
  private var scope: String { AppStore.scope(server: server, userId: "one") }

  private func temporarySnapshotURL() -> URL {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    return directory.appendingPathComponent("snapshot.json")
  }
  private func bootstrapJSON(user: String = "one", connected: Bool = true, activity: String = "waiting") -> String {
    """
    {"user":{"id":"\(user)","name":"One","email":"one@example.test"},"household":[],
     "preferences":{"presentation":"simple","theme":"system","favorites":[],"sections":[],"followBots":[]},
     "bots":[{"id":"kitchen","name":"Kitchen","model":"m","shared":true,"activity":"\(activity)",
              "lastMessage":{"text":"Milk is low","at":"2026-11-06T12:00:00Z"}}],
     "capabilities":{},"connection":{"connected":\(connected)}}
    """
  }
  private func refreshing(with fake: FakeServer, client: @escaping @MainActor () -> APIClient?) -> URL {
    let url = temporarySnapshotURL()
    let (oldClient, oldURL) = (BackgroundRefresh.client, BackgroundRefresh.snapshotURL)
    BackgroundRefresh.client = client
    BackgroundRefresh.snapshotURL = url
    addTeardownBlock { @MainActor in BackgroundRefresh.client = oldClient; BackgroundRefresh.snapshotURL = oldURL }
    return url
  }

  // MARK: Widgets in the background

  func testABackgroundPushOrRefreshRewritesTheSnapshotForTheSignedInAccount() async throws {
    let fake = FakeServer()
    fake.reply = .init(body: bootstrapJSON())
    let api = fake.api()
    let url = refreshing(with: fake) { api }
    let refreshed = await BackgroundRefresh.refreshWidgets()
    XCTAssertTrue(refreshed)
    XCTAssertEqual(fake.lastRequest?.url?.path, "/api/bootstrap")
    let written = try XCTUnwrap(WidgetSnapshotStore.read(from: url))
    XCTAssertEqual(written.scope, AppStore.scope(server: fake.origin, userId: "one"), "The same scope the open app writes")
    XCTAssertEqual(written.assistants.map(\.activity), ["waiting"])
  }

  func testAnOutageOrAChangedSignInLeavesTheSnapshotAlone() async {
    let fake = FakeServer()
    fake.reply = .init(body: bootstrapJSON(connected: false))
    let api = fake.api()
    var current: APIClient? = api
    let url = refreshing(with: fake) { current }
    let outage = await BackgroundRefresh.refreshWidgets()
    XCTAssertFalse(outage)
    XCTAssertNil(WidgetSnapshotStore.read(from: url), "An outage never refreshes the snapshot's time")
    // Signed out while the read was out: the previous person's names must not come back.
    let body = bootstrapJSON(), signOut = SignOutDuringRead()
    let late = FakeServer(answer: { _ in signOut.happened = true; return .init(body: body) })
    let lateAPI = late.api()
    current = lateAPI
    BackgroundRefresh.client = { signOut.happened ? nil : current }
    let signedOut = await BackgroundRefresh.refreshWidgets()
    XCTAssertFalse(signedOut)
    XCTAssertNil(WidgetSnapshotStore.read(from: url))
    current = nil
    let nobody = await BackgroundRefresh.refreshWidgets()
    XCTAssertFalse(nobody)
  }

  func testAReadThatFinishesAfterANewerSnapshotLeavesItAlone() async throws {
    let fake = FakeServer()
    fake.reply = .init(body: bootstrapJSON(activity: "working"))
    let api = fake.api()
    let url = refreshing(with: fake) { api }
    let started = Date(timeIntervalSince1970: 1_800_000_000)
    // The app opened during the read and wrote what it showed, a minute later.
    let newer = WidgetSnapshot(scope: "one", generatedAt: started.addingTimeInterval(60), assistants: [])
    XCTAssertTrue(WidgetSnapshotStore.write(newer, to: url))
    let late = await BackgroundRefresh.refreshWidgets(at: { started })
    XCTAssertFalse(late)
    XCTAssertEqual(WidgetSnapshotStore.read(from: url), newer)
    // A read that began after it replaces it, dated when the read began.
    let current = await BackgroundRefresh.refreshWidgets(at: { started.addingTimeInterval(120) })
    XCTAssertTrue(current)
    XCTAssertEqual(WidgetSnapshotStore.read(from: url)?.generatedAt, started.addingTimeInterval(120))
  }

  func testOnlyAWidgetRefreshPushAsksForIt() {
    XCTAssertTrue(BackgroundRefresh.requested(by: ["aps": ["content-available": 1], "refresh": ["widgets"]]))
    XCTAssertFalse(BackgroundRefresh.requested(by: ["aps": ["content-available": 1], "clear": ["tags": ["a"]]]))
    XCTAssertFalse(BackgroundRefresh.requested(by: ["refresh": "widgets"]))
  }

  func testTheAppMayRunItsRefreshTaskAndPlayAudioInTheBackground() throws {
    let info = try XCTUnwrap(Bundle.main.infoDictionary)
    let modes = try XCTUnwrap(info["UIBackgroundModes"] as? [String])
    XCTAssertTrue(Set(modes).isSuperset(of: ["audio", "fetch", "remote-notification"]))
    XCTAssertEqual(info["BGTaskSchedulerPermittedIdentifiers"] as? [String], [BackgroundRefresh.taskIdentifier])
    XCTAssertTrue((info["NSUserActivityTypes"] as? [String])?.contains(ChatHandoff.activityType) == true)
  }

  // MARK: Live Activity actions

  private func row(_ phase: ActivityPhase, approvalId: String? = nil) -> AssistantActivityState.Row {
    .init(botId: "kitchen", name: "Kitchen", phase: phase, status: phase.rawValue, approvalId: approvalId)
  }
  private func state(_ rows: [AssistantActivityState.Row]) -> AssistantActivityState {
    .init(title: "", activeCount: rows.count, attentionCount: 0, updatedAt: 0, rows: rows)
  }

  func testTheActivityOffersDeclineForANamedApprovalAndStopForRunningWork() throws {
    XCTAssertEqual(state([row(.waiting, approvalId: "request-7")]).action(stale: false), .decline(approvalId: "request-7"))
    XCTAssertNil(state([row(.waiting)]).action(stale: false), "Without an ID there is nothing to decline")
    XCTAssertEqual(state([row(.working)]).action(stale: false), .stop)
    XCTAssertEqual(state([row(.thinking)]).action(stale: false), .stop)
    for phase in [ActivityPhase.starting, .blocked, .done, .failed, .interrupted, .unknown] {
      XCTAssertNil(state([row(phase)]).action(stale: false), "\(phase)")
    }
    XCTAssertNil(state([row(.working)]).action(stale: true), "An out-of-date row may no longer be running")
    let decoded = try JSONDecoder().decode(AssistantActivityState.self, from: Data("""
      {"title":"Kitchen needs you","activeCount":1,"attentionCount":1,"updatedAt":1,
       "rows":[{"botId":"kitchen","name":"Kitchen","phase":"waiting","status":"Needs approval","approvalId":"request-7"}]}
      """.utf8))
    XCTAssertEqual(decoded.hero?.approvalId, "request-7")
  }

  func testTheButtonsNeedTheDeviceUnlockedAndStayOutOfShortcuts() {
    for policy in [StopAssistantActivityIntent.authenticationPolicy, DeclineApprovalActivityIntent.authenticationPolicy] {
      guard case .requiresAuthentication = policy else { return XCTFail("\(policy)") }
    }
    XCTAssertFalse(StopAssistantActivityIntent.isDiscoverable)
    XCTAssertFalse(DeclineApprovalActivityIntent.isDiscoverable)
  }

  func testTheScopeNamesItsUser() {
    XCTAssertEqual(AppStore.userId(inScope: scope), "one")
    XCTAssertEqual(AppStore.userId(inScope: AppStore.scope(server: server, userId: "user|with|bars")), "user|with|bars")
    XCTAssertNil(AppStore.userId(inScope: "not base64!"))
  }

  private func makeController(for fake: FakeServer, signedIn: String?) -> (NotificationController, () -> [UNNotificationRequest]) {
    let controller = NotificationController()
    var notices: [UNNotificationRequest] = []
    controller.deliverNotice = { notices.append($0) }
    let api = fake.api()
    controller.actionClient = { api }
    controller.savedScope = { signedIn }
    return (controller, { notices })
  }

  func testStopUsesTheChatsStopForTheActivitysOwnAccount() async throws {
    let fake = FakeServer()
    let ownScope = AppStore.scope(server: fake.origin, userId: "one")
    let (controller, notices) = makeController(for: fake, signedIn: ownScope)
    await controller.act(ActivityAction(kind: .stop, botId: "kitchen helper", scope: ownScope, name: "Kitchen"))
    XCTAssertEqual(fake.lastRequest?.httpMethod, "POST")
    XCTAssertEqual(fake.lastRequest?.url?.path, "/api/bots/kitchen helper/stop")
    // The server refuses it when a different person's token is in use by now.
    XCTAssertEqual(try fake.lastJSON() as? [String: String], ["account": NotificationActions.accountMarker("one")])
    XCTAssertTrue(notices().isEmpty)
    fake.reply = .init(status: 409, body: #"{"error":"stop is unavailable"}"#)
    await controller.act(ActivityAction(kind: .stop, botId: "kitchen", scope: ownScope, name: "Kitchen"))
    let notice = try XCTUnwrap(notices().last)
    XCTAssertEqual(notice.content.title, "Kitchen didn't stop")
    XCTAssertEqual(notice.content.body, "stop is unavailable. Tap to open the chat.")
    XCTAssertEqual(notice.content.userInfo["url"] as? String, "/?bot=kitchen")
  }

  func testDeclineNamesTheAccountAndAnotherSignInDoesNothing() async throws {
    let fake = FakeServer()
    let ownScope = AppStore.scope(server: fake.origin, userId: "one")
    let (controller, notices) = makeController(for: fake, signedIn: ownScope)
    await controller.act(ActivityAction(kind: .decline(approvalId: "request:7"), botId: "kitchen", scope: ownScope, name: "Kitchen"))
    XCTAssertEqual(fake.lastRequest?.url?.path, "/api/bots/kitchen/approvals/request:7")
    XCTAssertEqual(try fake.lastJSON() as? [String: String], ["decision": "denied", "account": NotificationActions.accountMarker("one")])
    let sent = fake.requests.count
    let (other, otherNotices) = makeController(for: fake, signedIn: AppStore.scope(server: fake.origin, userId: "two"))
    await other.act(ActivityAction(kind: .stop, botId: "kitchen", scope: ownScope, name: "Kitchen"))
    XCTAssertEqual(fake.requests.count, sent, "Another account's activity is never acted on")
    XCTAssertEqual(otherNotices().last?.content.title, "Kitchen wasn't changed")
    XCTAssertTrue(notices().isEmpty)
  }

  // MARK: Focus filter

  func testAFocusLetsChosenAssistantsHouseholdNewsAndOptionallyEveryApprovalThrough() {
    let open = FocusChoice()
    XCTAssertFalse(open.active)
    XCTAssertTrue(open.predicate.evaluate(with: "garden"))
    let focus = FocusChoice(assistantIds: ["kitchen"], allApprovals: true)
    XCTAssertTrue(focus.predicate.evaluate(with: "kitchen"))
    XCTAssertTrue(focus.predicate.evaluate(with: "household"))
    XCTAssertTrue(focus.predicate.evaluate(with: "approval:garden"), "Work waiting on a decision is never stranded")
    XCTAssertFalse(focus.predicate.evaluate(with: "garden"))
    let strict = FocusChoice(assistantIds: ["kitchen"], allApprovals: false)
    XCTAssertTrue(strict.predicate.evaluate(with: "approval:kitchen"))
    XCTAssertFalse(strict.predicate.evaluate(with: "approval:garden"))
    XCTAssertTrue(strict.predicate.evaluate(with: "household"))
  }

  func testAFocusNarrowsHomeUnlessItNamesNobodyHereAndIsSavedUntilItEnds() throws {
    let bots = try JSONDecoder().decode(Bootstrap.self, from: Data(bootstrapJSON().utf8)).bots
    XCTAssertEqual(FocusChoice(assistantIds: ["kitchen"]).shown(bots).map(\.id), ["kitchen"])
    XCTAssertEqual(FocusChoice(assistantIds: ["someone-else"]).shown(bots).map(\.id), ["kitchen"], "Another account's choice shows everyone")
    let defaults = try XCTUnwrap(UserDefaults(suiteName: "focus-\(UUID().uuidString)"))
    FocusChoice(assistantIds: ["kitchen"], allApprovals: false).save(defaults)
    XCTAssertEqual(FocusChoice.saved(defaults), FocusChoice(assistantIds: ["kitchen"], allApprovals: false))
    FocusChoice().save(defaults)
    XCTAssertEqual(FocusChoice.saved(defaults), FocusChoice())
  }

  // MARK: Handoff and universal links

  func testHandoffCarriesTheWebLinkAndAssistant() {
    let activity = NSUserActivity(activityType: ChatHandoff.activityType)
    let bot = try! JSONDecoder().decode(Bootstrap.self, from: Data(bootstrapJSON().utf8)).bots[0]
    ChatHandoff.describe(activity, bot: bot, server: server)
    XCTAssertEqual(activity.webpageURL?.absoluteString, "https://agentui.example.test/?bot=kitchen")
    XCTAssertTrue(activity.isEligibleForHandoff)
    XCTAssertFalse(activity.isEligibleForSearch)
    XCTAssertEqual(activity.title, "Kitchen")
  }

  func testOnlyThisServersChatAndTodayLinksOpenInTheApp() {
    func path(_ link: String) -> String? { ChatHandoff.relativePath(for: URL(string: link)!, server: server) }
    XCTAssertEqual(path("https://agentui.example.test/?bot=kitchen%20helper"), "/?bot=kitchen%20helper")
    XCTAssertEqual(path("https://AGENTUI.example.test?view=today"), "/?view=today")
    XCTAssertNil(path("https://other.example.test/?bot=kitchen"))
    XCTAssertNil(path("http://agentui.example.test/?bot=kitchen"))
    XCTAssertNil(path("https://agentui.example.test/native/sign-in?bot=kitchen"))
    XCTAssertNil(path("https://agentui.example.test/?view=settings"))
  }

  func testAnotherServersLinkSaysSoInsteadOfOpening() async {
    let store = AppStore()
    store.api = APIClient(baseURL: server)
    let controller = NotificationController()
    controller.store = store
    await controller.openWebLink(URL(string: "https://other.example.test/?bot=kitchen")!)
    XCTAssertEqual(store.notice, "That link is for other.example.test, but WildBots is connected to agentui.example.test.")
    XCTAssertNil(controller.pendingURL)
    // A chat handed off from a phone on another household's server, even with the same assistant ID.
    store.notice = nil
    let handoff = NSUserActivity(activityType: ChatHandoff.activityType)
    handoff.webpageURL = URL(string: "https://other.example.test/?bot=kitchen")
    await controller.continueActivity(handoff)
    XCTAssertNotNil(store.notice)
    XCTAssertNil(controller.pendingURL)
    // Without a link there is no telling whose chat it was.
    store.notice = nil
    await controller.continueActivity(NSUserActivity(activityType: ChatHandoff.activityType))
    XCTAssertNil(store.notice)
    XCTAssertNil(controller.pendingURL)
  }

  // MARK: Siri

  func testSiriSaysWhoNeedsYouThenWhoIsWorkingAndHowOldItIs() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    func assistant(_ name: String, _ activity: String) -> WidgetSnapshot.Assistant {
      .init(id: name, name: name, activity: activity, lastMessage: nil, lastMessageAt: nil, color: nil, pinned: false)
    }
    let busy = WidgetSnapshot(scope: "a", generatedAt: now, assistants: [
      assistant("Garden", "working"), assistant("Kitchen", "waiting"), assistant("Pantry", "blocked"), assistant("Shop", "thinking"), assistant("Barn", "idle"),
    ])
    XCTAssertEqual(busy.spokenSummary(at: now),
      "Kitchen needs your approval. Pantry needs your input. Garden and Shop are working.")
    let quiet = WidgetSnapshot(scope: "a", generatedAt: now, assistants: [assistant("Barn", "idle")])
    XCTAssertEqual(quiet.spokenSummary(at: now), "All caught up. Nobody needs you and nothing is running.")
    XCTAssertTrue(quiet.spokenSummary(at: now.addingTimeInterval(45 * 60)).hasPrefix("WildBots last checked"))
  }
}

/// Set from the fake server's thread when a read arrives, to sign out while it is out.
private final class SignOutDuringRead: @unchecked Sendable {
  private let lock = NSLock()
  private var value = false
  var happened: Bool {
    get { lock.withLock { value } }
    set { lock.withLock { value = newValue } }
  }
}
