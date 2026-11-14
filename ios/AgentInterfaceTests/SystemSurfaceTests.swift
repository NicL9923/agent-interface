import SwiftUI
import WidgetKit
import XCTest

@testable import AgentInterface

/// Live Activity content, widget snapshots, deep links and the app update offer.
@MainActor final class SystemSurfaceTests: XCTestCase {
  private func state(_ json: String) throws -> AssistantActivityState {
    try JSONDecoder().decode(AssistantActivityState.self, from: Data(json.utf8))
  }
  private func row(_ id: String, _ phase: ActivityPhase) -> AssistantActivityState.Row {
    .init(botId: id, name: id.capitalized, phase: phase, status: phase.rawValue)
  }

  func testContentStateDecodesDocumentedJSONWithEpochSecondsAndUnknownPhase() throws {
    let value = try state("""
      {"title":"Kitchen needs you","activeCount":2,"attentionCount":1,"updatedAt":1760000000,
       "rows":[{"botId":"kitchen","name":"Kitchen","phase":"waiting","status":"Needs approval",
                "detail":"Order groceries","since":1759999900,"color":"#1084FE"},
               {"botId":"garden","name":"Garden","phase":"composting","status":"Composting"}]}
      """)
    XCTAssertEqual(value.updatedDate, Date(timeIntervalSince1970: 1_760_000_000))
    XCTAssertEqual(value.rows[0].sinceDate, Date(timeIntervalSince1970: 1_759_999_900))
    XCTAssertEqual(value.rows[0].detail, "Order groceries"); XCTAssertEqual(value.rows[0].color, "#1084FE")
    XCTAssertEqual(value.rows[1].phase, .unknown); XCTAssertNil(value.rows[1].since)
    XCTAssertEqual(value.rows[1].statusText(stale: false), "Status unknown")
    // ActivityKit stores the state with its own coder; it must survive the round trip.
    XCTAssertEqual(try JSONDecoder().decode(AssistantActivityState.self, from: JSONEncoder().encode(value)), value)
  }
  func testHeroDrivesLabelsAndStaleRowsStopClaimingWork() {
    var value = AssistantActivityState(title: "Kitchen needs you", activeCount: 3, attentionCount: 2, updatedAt: 0,
      rows: [row("kitchen", .waiting), row("garden", .working), row("ranch", .done)])
    XCTAssertEqual(value.hero?.botId, "kitchen")
    XCTAssertEqual(value.compactLabel(stale: false), "Approval")
    XCTAssertEqual(value.header(stale: false).text, "3 active"); XCTAssertEqual(value.header(stale: false).attention, " · 2 need you")
    XCTAssertEqual(value.header(stale: true).text, "Assistant status out of date"); XCTAssertNil(value.header(stale: true).attention)
    XCTAssertEqual(value.rows.map { $0.statusText(stale: true) }, ["Out of date", "Out of date", "done"])
    XCTAssertFalse(value.rows[1].showsTimer(stale: false), "No start time, no timer")
    value.rows[0].phase = .blocked
    XCTAssertEqual(value.compactLabel(stale: false), "Input")
    value.rows = [row("garden", .working)]; value.attentionCount = 0; value.activeCount = 1
    XCTAssertEqual(value.compactLabel(stale: false), "1 active")
    value.rows = [row("garden", .failed)]; value.activeCount = 0
    XCTAssertEqual(value.compactLabel(stale: false), "Failed")
    XCTAssertEqual(value.header(stale: false).text, "Kitchen needs you")
    value.rows = [row("garden", .done)]
    XCTAssertEqual(value.compactLabel(stale: false), "Done"); XCTAssertEqual(value.compactLabel(stale: true), "Out of date")
    XCTAssertTrue(ActivityPhase.done.showsSymbolWhenMinimal); XCTAssertFalse(ActivityPhase.working.showsSymbolWhenMinimal)
  }
  func testSeedAddsStartingRowInServerOrderWithoutDuplicatingActiveWork() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let base = AssistantActivityState(title: "", activeCount: 1, attentionCount: 1, updatedAt: 0,
      rows: [row("kitchen", .waiting), row("ranch", .done)])
    let seeded = base.seeded(botId: "garden", name: "Garden", color: "#00BCA6", at: now)
    XCTAssertEqual(seeded.rows.map(\.botId), ["kitchen", "garden", "ranch"])
    XCTAssertEqual(seeded.rows[1].phase, .starting); XCTAssertEqual(seeded.rows[1].since, now.timeIntervalSince1970)
    XCTAssertEqual(seeded.activeCount, 2); XCTAssertEqual(seeded.updatedAt, now.timeIntervalSince1970)
    XCTAssertEqual(seeded.seeded(botId: "garden", name: "Garden", color: nil, at: now), seeded)
    // A finished assistant sent to again starts over.
    let restarted = base.seeded(botId: "ranch", name: "Ranch", color: nil, at: now)
    XCTAssertEqual(restarted.rows.map(\.phase), [.waiting, .starting]); XCTAssertEqual(restarted.activeCount, 2)
    let fresh = AssistantActivityState.empty(at: now).seeded(botId: "garden", name: "Garden", color: nil, at: now)
    XCTAssertEqual(fresh.title, "Garden is starting"); XCTAssertEqual(fresh.compactLabel(stale: false), "1 active")
  }

  private func assistant(_ id: String, _ activity: String, pinned: Bool = false, at: TimeInterval? = nil) -> WidgetSnapshot.Assistant {
    .init(id: id, name: id, activity: activity, lastMessage: nil, lastMessageAt: at.map(Date.init(timeIntervalSince1970:)), color: nil, pinned: pinned)
  }
  func testWidgetOrderPutsAttentionThenWorkThenPinnedThenRecent() {
    let snapshot = WidgetSnapshot(scope: "a", generatedAt: Date(), assistants: [
      assistant("old", "idle", at: 10), assistant("recent", "done", at: 30), assistant("pinned", "idle", pinned: true, at: 1),
      assistant("working", "working"), assistant("blocked", "blocked"), assistant("never", "idle"), assistant("thinking", "thinking", at: 5),
    ])
    XCTAssertEqual(snapshot.ordered.map(\.id), ["blocked", "thinking", "working", "pinned", "recent", "old", "never"])
    XCTAssertEqual(snapshot.summary, "1 needs you · 2 working")
    XCTAssertEqual(WidgetSnapshot(scope: "a", generatedAt: Date(), assistants: [assistant("a", "idle")]).summary, "All caught up")
    XCTAssertEqual(snapshot.assistants.map(\.status), [nil, "Done", nil, "Working", "Needs your input", nil, "Thinking"])
    XCTAssertNil(assistant("a", "disconnected").phase); XCTAssertEqual(assistant("a", "napping").status, "Status unknown")
  }
  func testWidgetSnapshotGoesStaleAfterThirtyMinutesOnItsOwnTimeline() {
    let generated = Date(timeIntervalSince1970: 1_800_000_000)
    let snapshot = WidgetSnapshot(scope: "a", generatedAt: generated, assistants: [])
    XCTAssertFalse(snapshot.isStale(at: generated.addingTimeInterval(29 * 60)))
    XCTAssertTrue(snapshot.isStale(at: generated.addingTimeInterval(30 * 60)))
    let now = generated.addingTimeInterval(60)
    XCTAssertEqual(snapshot.timelineDates(now: now), [now, generated.addingTimeInterval(30 * 60)])
    XCTAssertEqual(snapshot.timelineDates(now: generated.addingTimeInterval(31 * 60)).count, 1)
  }
  private func temporarySnapshotURL() -> URL {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    return directory.appendingPathComponent("snapshot.json")
  }
  func testSnapshotStoreReloadsOnlyForChangesOrAge() {
    let url = temporarySnapshotURL()
    let start = Date(timeIntervalSince1970: 1_800_000_000)
    var value = WidgetSnapshot(scope: "a", generatedAt: start, assistants: [assistant("kitchen", "idle")])
    XCTAssertTrue(WidgetSnapshotStore.write(value, to: url))
    value.generatedAt = start.addingTimeInterval(60)
    XCTAssertFalse(WidgetSnapshotStore.write(value, to: url), "Same content a minute later")
    XCTAssertEqual(WidgetSnapshotStore.read(from: url)?.generatedAt, start)
    value.assistants[0].activity = "working"
    XCTAssertTrue(WidgetSnapshotStore.write(value, to: url))
    value.generatedAt = start.addingTimeInterval(11 * 60)
    XCTAssertTrue(WidgetSnapshotStore.write(value, to: url), "Unchanged but old enough to refresh its time")
    XCTAssertTrue(WidgetSnapshotStore.write(nil, to: url)); XCTAssertNil(WidgetSnapshotStore.read(from: url))
    XCTAssertFalse(WidgetSnapshotStore.write(nil, to: url))
  }
  private func bootstrap(connected: Bool = true) throws -> Bootstrap {
    try JSONDecoder().decode(Bootstrap.self, from: Data("""
      {"user":{"id":"one","name":"One","email":"one@example.test"},"household":[],
       "preferences":{"presentation":"simple","theme":"system","favorites":["garden"],"sections":[],"followBots":[]},
       "bots":[{"id":"kitchen","name":"Kitchen","model":"m","shared":true,"activity":"waiting",
                "avatar":{"mode":"geometric","color":"#FF9800"},"lastMessage":{"text":"Milk is low","at":"2026-10-16T12:00:00Z"}},
               {"id":"garden","name":"Garden","model":"m","shared":false,"activity":"idle","avatar":{"mode":"portrait"}}],
       "capabilities":{},"connection":{"connected":\(connected)}}
      """.utf8))
  }
  func testAppWritesSnapshotForTheAccountAndRemovesItOnSignOut() async throws {
    let url = temporarySnapshotURL()
    let store = AppStore()
    store.widgetSnapshotURL = url
    store.api = APIClient(baseURL: URL(string: "https://one.example.test")!)
    store.bootstrap = try bootstrap()
    let written = try XCTUnwrap(WidgetSnapshotStore.read(from: url))
    XCTAssertEqual(written.scope, store.scope)
    XCTAssertEqual(written.assistants.map(\.pinned), [false, true])
    XCTAssertEqual(written.assistants[0].lastMessage, "Milk is low")
    XCTAssertEqual(written.assistants[0].lastMessageAt, ServerDate.parse("2026-10-16T12:00:00Z"))
    XCTAssertEqual(written.assistants.map(\.color), ["#FF9800", nil])
    // An outage keeps the last good snapshot instead of refreshing its time.
    store.bootstrap = try bootstrap(connected: false)
    XCTAssertEqual(WidgetSnapshotStore.read(from: url), written)
    var other = try bootstrap(connected: false)
    other.user.id = "two"
    store.bootstrap = other
    XCTAssertNil(WidgetSnapshotStore.read(from: url), "A disconnected account switch removes the previous person's previews")
    await store.signOut(localOnly: true)
    XCTAssertNil(WidgetSnapshotStore.read(from: url))
  }

  func testLiveActivityInstallationIdsStayStableWithinAnAccountAndSeparateAccounts() {
    let first = "test-one-\(UUID().uuidString)", second = "test-two-\(UUID().uuidString)"
    defer {
      UserDefaults.standard.removeObject(forKey: "liveActivity.deviceId.\(first)")
      UserDefaults.standard.removeObject(forKey: "liveActivity.deviceId.\(second)")
    }
    let one = LiveActivityController.deviceId(for: first)
    XCTAssertNotNil(UUID(uuidString: one))
    XCTAssertEqual(LiveActivityController.deviceId(for: first), one)
    XCTAssertNotEqual(LiveActivityController.deviceId(for: second), one)
  }

  /// A request the Live Activity controller sent, with its JSON body's string fields.
  private struct Sent: Equatable {
    var method: String, path: String, body: [String: String]
    init(_ method: String, _ path: String, _ body: [String: String] = [:]) { (self.method, self.path, self.body) = (method, path, body) }
  }
  private func liveActivityRequests(_ server: FakeServer) -> [Sent] {
    zip(server.requests, server.bodies).compactMap { request, body in
      guard let path = request.url?.path, path.hasPrefix("/api/native/live-activity") else { return nil }
      return Sent(request.httpMethod ?? "", path, (try? JSONDecoder().decode([String: String].self, from: body)) ?? [:])
    }
  }
  /// A controller for a signed-in account, with iOS and the device's defaults stood in for.
  private func liveActivities(_ fake: FakeActivities, turnedOn: Bool? = nil) throws -> (LiveActivityController, FakeServer, String) {
    let server = FakeServer()
    let store = AppStore()
    store.widgetSnapshotURL = nil
    store.api = server.api()
    store.bootstrap = try bootstrap()
    let scope = try XCTUnwrap(store.scope)
    let suite = "live-activity-switch-\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    if let turnedOn { defaults.set(turnedOn, forKey: DeviceDefaults.liveActivities) }
    let controller = LiveActivityController()
    controller.system = fake.system
    controller.defaults = defaults
    controller.store = store
    addTeardownBlock { @MainActor in
      store.suspend()
      defaults.removePersistentDomain(forName: suite)
      UserDefaults.standard.removeObject(forKey: "liveActivity.deviceId.\(scope)")
      UserDefaults.standard.removeObject(forKey: DeviceDefaults.expiry(server.origin))
      FakeExchange.remove(host: server.origin.host!)
    }
    return (controller, server, scope)
  }

  func testTurningLiveActivitiesOffEndsEveryActivityAndForgetsBothTokens() async throws {
    let fake = FakeActivities()
    let (controller, server, scope) = try liveActivities(fake)
    fake.running = [.init(id: "mine", scope: scope, token: "aa11"), .init(id: "theirs", scope: "another-account", token: "bb22")]
    XCTAssertTrue(controller.turnedOn, "Unset is on, so existing installs keep their Live Activities")
    await controller.setTurnedOn(false)
    XCTAssertEqual(fake.ended, ["mine", "theirs"])
    let deviceId = LiveActivityController.deviceId(for: scope)
    XCTAssertEqual(liveActivityRequests(server), [
      Sent("DELETE", "/api/native/live-activity", ["deviceId": deviceId, "token": "aa11"]),
      Sent("DELETE", "/api/native/live-activity/start", ["deviceId": deviceId]),
    ], "Another account's token is not this sign-in's to remove")
    let relaunched = LiveActivityController()
    relaunched.defaults = controller.defaults
    XCTAssertFalse(relaunched.turnedOn, "The choice outlives the launch and is not tied to the account")
    // An earlier launch may have registered a running activity's token that this launch never did.
    XCTAssertEqual(LiveActivityController.tokensToForget(registered: "aa", running: [
      .init(id: "1", scope: "s", token: "aa"), .init(id: "2", scope: "s", token: "bb"),
      .init(id: "3", scope: "s", token: nil), .init(id: "4", scope: "t", token: "cc"),
    ], scope: "s"), ["aa", "bb"])
  }

  func testWhileLiveActivitiesAreOffNothingStartsAndForegroundsRepeatOnlyTheUnconfirmedRequest() async throws {
    let fake = FakeActivities(startToken: "cc33")
    let (controller, server, scope) = try liveActivities(fake, turnedOn: false)
    await controller.sent(to: "kitchen")
    XCTAssertEqual(liveActivityRequests(server), [], "No state read after a send, so nothing starts")
    let forget = Sent("DELETE", "/api/native/live-activity/start", ["deviceId": LiveActivityController.deviceId(for: scope)])
    server.reply = .init(status: 503)
    await controller.foreground()
    server.reply = .init()
    await controller.foreground()
    await controller.foreground()
    XCTAssertEqual(liveActivityRequests(server), [forget, forget],
      "A foreground neither reads state nor sends the start token, and repeats the off request until the server confirms it")
  }

  func testTurningLiveActivitiesOnSendsTheStartTokenOnlyAfterTheOffRequestIsAnswered() async throws {
    let fake = FakeActivities(startToken: "cc33")
    let (controller, server, scope) = try liveActivities(fake)
    let deviceId = LiveActivityController.deviceId(for: scope)
    let release = server.hold(path: "/api/native/live-activity/start")
    let off = Task { await controller.setTurnedOn(false) }
    try await until { self.liveActivityRequests(server).count == 1 }
    let on = Task { await controller.setTurnedOn(true) }
    // Absence check: the start token must not reach the server ahead of the off request it follows.
    try await Task.sleep(for: .milliseconds(300))
    XCTAssertEqual(liveActivityRequests(server).map(\.method), ["DELETE"])
    release()
    await off.value
    await on.value
    XCTAssertEqual(liveActivityRequests(server), [
      Sent("DELETE", "/api/native/live-activity/start", ["deviceId": deviceId]),
      Sent("PUT", "/api/native/live-activity/start", ["deviceId": deviceId, "token": "cc33", "scope": scope]),
    ])
    XCTAssertTrue(controller.turnedOn)
  }

  func testWhenIosHasLiveActivitiesOffTheSwitchSaysSoAndNothingRegisters() async throws {
    XCTAssertEqual(LiveActivitySwitch(turnedOn: true, systemAllowed: false), .offInSettings)
    XCTAssertEqual(LiveActivitySwitch(turnedOn: false, systemAllowed: false), .offInSettings)
    XCTAssertEqual(LiveActivitySwitch(turnedOn: true, systemAllowed: true), .on)
    XCTAssertEqual(LiveActivitySwitch(turnedOn: false, systemAllowed: true), .off)
    let fake = FakeActivities(startToken: "cc33")
    fake.allowed = false
    let (controller, server, _) = try liveActivities(fake)
    await controller.setTurnedOn(true)
    await controller.sent(to: "kitchen")
    XCTAssertEqual(liveActivityRequests(server), [], "Neither the start token nor a state read goes out while iOS has them off")
  }

  func testUpdateOfferComparesBuildsAndRequiresHTTPS() {
    let url = "https://testflight.apple.com/join/CODE"
    XCTAssertEqual(AppUpdate.evaluate(NativeAppInfo(latestBuild: 12, updateUrl: url), installedBuild: 11), .available(URL(string: url)!))
    XCTAssertEqual(AppUpdate.evaluate(NativeAppInfo(latestBuild: 12, updateUrl: url), installedBuild: 12), .upToDate)
    XCTAssertEqual(AppUpdate.evaluate(NativeAppInfo(latestBuild: 12, updateUrl: url), installedBuild: 13), .upToDate)
    XCTAssertNil(AppUpdate.evaluate(nil, installedBuild: 11))
    XCTAssertNil(AppUpdate.evaluate(NativeAppInfo(latestBuild: 12, updateUrl: url), installedBuild: nil))
    for unsafe in ["http://testflight.apple.com/join/CODE", "itms-services://?action=download", "javascript:alert(1)", "https:///nohost"] {
      XCTAssertNil(AppUpdate.evaluate(NativeAppInfo(latestBuild: 12, updateUrl: unsafe), installedBuild: 11), unsafe)
    }
  }

  func testDeepLinksMapToNotificationPathsAndRejectEverythingElse() throws {
    XCTAssertEqual(DeepLink.relativePath(for: URL(string: "agentinterface://open?bot=kitchen")!), "/?bot=kitchen")
    XCTAssertEqual(DeepLink.relativePath(for: DeepLink.bot("a b&c")), "/?bot=a%20b%26c")
    XCTAssertEqual(DeepLink.relativePath(for: DeepLink.today), "/?view=today")
    let origin = URL(string: "https://app.example.test")!
    XCTAssertEqual(NotificationController.botId(from: try XCTUnwrap(DeepLink.relativePath(for: DeepLink.bot("a b&c"))), origin: origin), "a b&c")
    for rejected in ["agentinterface://auth/callback?code=x&bot=kitchen", "agentinterface://open/other?bot=kitchen",
      "https://open?bot=kitchen", "agentinterface://open?bot=", "agentinterface://open?view=settings", "other://open?bot=kitchen"] {
      XCTAssertNil(DeepLink.relativePath(for: URL(string: rejected)!), rejected)
    }
  }
  /// iOS ends the app when a feature asks for a device permission without a purpose string, and
  /// the simulator hides the camera, so only this check catches a missing one.
  func testEveryRequestedDevicePermissionHasAPurposeString() {
    for key in ["NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSCalendarsFullAccessUsageDescription", "NSRemindersFullAccessUsageDescription"] {
      let purpose = Bundle.main.object(forInfoDictionaryKey: key) as? String
      XCTAssertFalse(purpose?.isEmpty ?? true, key)
    }
  }
}

/// Stands in for ActivityKit: the activities iOS is showing, those the app ended, and the start token.
@MainActor private final class FakeActivities {
  var allowed = true
  var running: [LiveActivitySystem.Running] = []
  var ended: [String] = []
  var startToken: String?
  init(startToken: String? = nil) { self.startToken = startToken }
  var system: LiveActivitySystem {
    LiveActivitySystem(
      allowed: { [unowned self] in allowed },
      running: { [unowned self] in running },
      end: { [unowned self] id in
        guard running.contains(where: { $0.id == id }) else { return XCTFail("Ended \(id), which iOS is not showing") }
        ended.append(id)
        running.removeAll { $0.id == id }
      },
      startToken: { [unowned self] in startToken })
  }
}
