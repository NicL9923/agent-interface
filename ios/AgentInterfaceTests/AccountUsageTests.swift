import Foundation
import XCTest

@testable import AgentInterface

/// The Swift port of `src/shared/account-usage.ts`: the same cutoffs and the same words as the web's Usage panel.
@MainActor final class AccountUsageTests: XCTestCase {
  private func window(_ label: String, _ used: Double?, _ scope: UsageWindow.Scope = .account) -> UsageWindow {
    UsageWindow(label: label, usedPercent: used, scope: scope)
  }
  private func account(_ provider: String = "openai-codex", windows: [UsageWindow] = [], bots: [String] = [], fetched: String = "2026-10-01T11:59:00.000Z") -> UsageAccount {
    UsageAccount(key: provider + "-key", provider: provider, plan: nil, title: "Account limits", fetchedAt: fetched, windows: windows, details: [],
      unavailableReason: nil, bankedResets: 0, botIds: bots, fallbackOnly: false)
  }
  private func result(_ status: ResetStatus, message: String = "", available: Int = 1) -> ResetResult {
    ResetResult(status: status, message: message, availableCount: available, windowsReset: 0, account: nil)
  }

  // MARK: Reset phrase

  private let now = ISO8601DateFormatter().date(from: "2026-10-01T12:00:00Z")!
  private func phrase(afterSeconds seconds: TimeInterval, zone: String = "America/Chicago") -> String {
    AccountUsage.resetPhrase(ServerDate.string(now.addingTimeInterval(seconds)), now: now, locale: Locale(identifier: "en_US"), timeZone: TimeZone(identifier: zone)!)
      .replacingOccurrences(of: "\u{202F}", with: " ")
  }

  func testResetPhraseCountsMinutesUpToAnHourThenHoursAndMinutesUpToADay() {
    XCTAssertEqual(phrase(afterSeconds: -60), "Resets any moment", "A reset time already past")
    XCTAssertEqual(phrase(afterSeconds: 0), "Resets any moment", "Zero minutes left is not 'in 0 min'")
    XCTAssertEqual(phrase(afterSeconds: 1), "Resets in 1 min", "A part of a minute counts as the whole minute")
    XCTAssertEqual(phrase(afterSeconds: 59 * 60), "Resets in 59 min")
    XCTAssertEqual(phrase(afterSeconds: 60 * 60), "Resets in 1 hr", "The hour boundary drops the zero minutes")
    XCTAssertEqual(phrase(afterSeconds: 61 * 60), "Resets in 1 hr 1 min")
    XCTAssertEqual(phrase(afterSeconds: (23 * 60 + 59) * 60), "Resets in 23 hr 59 min", "Last minute before a day")
  }
  func testResetPhraseNamesTheWeekdayAndLocalTimeFromADayOnAndFollowsTheTimeZone() {
    // 12:00Z on Thursday Oct 1 plus a day is 12:00Z Friday: 7:00 AM in Chicago, 1:00 AM in Auckland, which is east of UTC.
    XCTAssertEqual(phrase(afterSeconds: 24 * 3600), "Resets Fri 7:00 AM", "A full day is the first time that names the weekday")
    XCTAssertEqual(phrase(afterSeconds: 24 * 3600, zone: "Pacific/Auckland"), "Resets Sat 1:00 AM", "The weekday is the local one, not UTC's")
  }
  func testResetPhraseIsEmptyForATimeItCannotRead() {
    XCTAssertEqual(AccountUsage.resetPhrase("soon", now: now), "")
    XCTAssertEqual(AccountUsage.resetPhrase("", now: now), "")
  }

  // MARK: Windows and levels

  func testUsageLevelWarnsAtHalfAndAlarmsAtEightyPercent() {
    XCTAssertEqual([0, 49.9, 50, 79.9, 80, 100].map(AccountUsage.level), [.ok, .ok, .warn, .warn, .alarm, .alarm])
  }
  func testTightestWindowPrefersLimitsThatStopTheWholeAccountAndSkipsUnreportedOnes() {
    let model = window("Opus week", 100, .model), weekly = window("Weekly", 40), session = window("Session", 40.5)
    XCTAssertEqual(AccountUsage.tightestWindow(account(windows: [model, weekly, session]))?.label, "Session", "A full model-only limit never outranks an account limit")
    XCTAssertEqual(AccountUsage.tightestWindow(account(windows: [window("Opus week", 30, .model), window("Sonnet week", 70, .model)]))?.label, "Sonnet week", "With no account limit, any limit counts")
    XCTAssertEqual(AccountUsage.tightestWindow(account(windows: [window("A", 50), window("B", 50)]))?.label, "A", "A tie keeps the first, as on the web")
    XCTAssertNil(AccountUsage.tightestWindow(account(windows: [window("Quota", nil)])))
    XCTAssertNil(AccountUsage.tightestWindow(account()))
  }
  func testAResetWouldBeWastedUnlessAnAccountWideLimitIsUsedUp() {
    XCTAssertFalse(AccountUsage.resetWouldBeWasted(account(windows: [window("Session", 100), window("Weekly", 10)])))
    XCTAssertTrue(AccountUsage.resetWouldBeWasted(account(windows: [window("Opus week", 100, .model)])), "A model-only limit does not stop the account")
    XCTAssertTrue(AccountUsage.resetWouldBeWasted(account(windows: [window("Session", 99.9)])), "Just short of full")
    XCTAssertTrue(AccountUsage.resetWouldBeWasted(account(windows: [window("Session", nil)])), "An unreported percentage is not full")
    XCTAssertTrue(AccountUsage.resetWouldBeWasted(account()))
  }

  // MARK: Names and the menu summary

  func testAccountNameUsesPeopleWordsForKnownProvidersAndTitleCasesTheRest() {
    XCTAssertEqual(["openai-codex", "anthropic", "xai", "custom", "my-new_provider", ""].map(AccountUsage.name),
      ["ChatGPT", "Claude", "Grok", "Custom", "My New Provider", ""])
  }
  func testSummaryNamesTheAccountClosestToALimit() {
    XCTAssertNil(AccountUsage.summary([]))
    XCTAssertNil(AccountUsage.summary([account(windows: [window("Quota", nil)]), account("custom")]), "Nothing reports a percentage")
    let chatgpt = account("openai-codex", windows: [window("Session", 40), window("Opus week", 100, .model), window("Weekly", 62.5)])
    let openrouter = account("openrouter", windows: [window("API key quota", 25)])
    XCTAssertEqual(AccountUsage.summary([openrouter, chatgpt]), "ChatGPT · 63% of weekly", "62.5 rounds up, and the label is lowercased")
    let tied = account("anthropic", windows: [window("Session", 62.5)])
    XCTAssertEqual(AccountUsage.summary([tied, chatgpt]), "Claude · 63% of session", "A tie keeps the earlier account")
  }

  // MARK: Reset outcome

  func testResetOutcomeSaysWhatHappenedForEveryStatus() {
    XCTAssertEqual(AccountUsage.resetOutcome(result(.reset, available: 1)), "Limits reset. 1 banked reset left.")
    XCTAssertEqual(AccountUsage.resetOutcome(result(.reset, available: 0)), "Limits reset. 0 banked resets left.")
    XCTAssertEqual(AccountUsage.resetOutcome(result(.reset, available: 2)), "Limits reset. 2 banked resets left.")
    XCTAssertEqual(AccountUsage.resetOutcome(result(.nothingToReset)), "Nothing needed resetting, so no reset was used.")
    XCTAssertEqual(AccountUsage.resetOutcome(result(.alreadyRedeemed)), "That reset was already used. No other reset was spent.")
    XCTAssertEqual(AccountUsage.resetOutcome(result(.noCredit)), "This account has no banked resets.")
    XCTAssertEqual(AccountUsage.resetOutcome(result(.noCreditsBanked)), "This account has no banked resets.")
    XCTAssertEqual(AccountUsage.resetOutcome(result(.notExhausted)), "Not reset: no limit is used up yet, so a reset would be wasted.")
  }
  func testResetOutcomeNeverRepeatsWordsForAStatusTheAppKnows() {
    XCTAssertEqual(AccountUsage.resetOutcome(result(.unavailable, message: "Unexpected response: {'account_id': 'private'}")),
      "ChatGPT did not confirm the reset. Refresh to see whether it went through before trying again.")
    XCTAssertEqual(AccountUsage.resetOutcome(result(.uncertain)),
      "ChatGPT did not answer after the reset was sent. Try again: it goes as the same request, so it cannot spend a second reset.")
    XCTAssertEqual(AccountUsage.resetOutcome(result(.reset, message: "Reset redeemed.")), "Limits reset. 1 banked reset left.", "A status the app has copy for ignores Hermes's message")
  }

  // MARK: Rows

  func testUsedByNamesTheAssistantsStillListedAndSkipsUnknownIds() throws {
    let bots = try JSONDecoder().decode([Bot].self, from: Data(#"[{"id":"household","name":"Household","model":"m","shared":true,"activity":"idle"},{"id":"garden","name":"Garden","model":"m","shared":true,"activity":"idle"}]"#.utf8))
    XCTAssertEqual(AccountUsage.assistantNames(account(bots: ["garden", "gone", "household"]), bots: bots), ["Garden", "Household"])
    XCTAssertEqual(AccountUsage.assistantNames(account(bots: ["gone"]), bots: bots), [])
  }
  func testUpdatedUsesTheNewestReadAndIgnoresAnUnreadableOne() {
    XCTAssertNil(AccountUsage.newestFetch([]))
    let newest = AccountUsage.newestFetch([account(fetched: "2026-10-01T11:00:00Z"), account(fetched: "nonsense"), account(fetched: "2026-10-01T11:59:00.000Z")])
    XCTAssertEqual(newest, ISO8601DateFormatter().date(from: "2026-10-01T11:59:00Z"))
  }
  func testUpdatedLabelNeverPointsIntoTheFuture() {
    let en = Locale(identifier: "en_US")
    XCTAssertEqual(UsageView.relative(now.addingTimeInterval(-120), now: now, locale: en), "2 minutes ago")
    XCTAssertEqual(UsageView.relative(now.addingTimeInterval(30), now: now, locale: en), "now", "A read stamped ahead of this clock is not 'in 30 seconds'")
  }

  // MARK: Decoding

  func testAScopeOrStatusTheAppDoesNotKnowDegradesInsteadOfFailingTheResponse() throws {
    let decoded = try JSONDecoder().decode(UsageWindow.self, from: Data(#"{"label":"Pool","usedPercent":null,"resetsAt":null,"detail":null,"scope":"team"}"#.utf8))
    XCTAssertEqual(decoded.scope, .model, "An unknown scope never raises an account-wide alarm")
    let outcome = try JSONDecoder().decode(ResetResult.self, from: Data(#"{"status":"queued","message":"Hermes is working on it.","availableCount":1,"windowsReset":0}"#.utf8))
    XCTAssertEqual(outcome.status, .unknown)
    XCTAssertEqual(AccountUsage.resetOutcome(outcome), "Hermes is working on it.", "The reset may have been spent, so the person reads Hermes's words")
  }

  // MARK: Store

  private static func fixtureResponse(_ name: String) throws -> String {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Contract/\(name).json")
    let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    return String(decoding: try JSONSerialization.data(withJSONObject: try XCTUnwrap(envelope["response"])), as: UTF8.self)
  }
  private func store(_ server: FakeServer) throws -> AppStore {
    let value = AppStore()
    value.widgetSnapshotURL = nil
    value.api = server.api()
    value.bootstrap = try JSONDecoder().decode(Bootstrap.self, from: Data(#"{"user":{"id":"one","name":"One","email":"one@example.test"},"household":[],"preferences":{"presentation":"simple","theme":"system","favorites":[],"sections":[],"followBots":[]},"bots":[],"capabilities":{"chat":{"supported":true}},"connection":{"connected":true}}"#.utf8))
    return value
  }
  private func clean(_ server: FakeServer, _ value: AppStore) {
    value.suspend()
    if let api = value.api { UserDefaults.standard.removeObject(forKey: DeviceDefaults.expiry(api.baseURL)) }
    FakeExchange.remove(host: server.origin.host!)
  }

  func testRefreshAsksForTheProvidersAgainOnlyWhenToldTo() async throws {
    let server = FakeServer(), value = try store(server)
    defer { clean(server, value) }
    server.reply = .init(body: try Self.fixtureResponse("usage-accounts"))
    let failure = await value.refreshAccountUsage()
    XCTAssertNil(failure)
    XCTAssertEqual(value.accountUsage?.accounts.map(\.provider), ["openai-codex", "openrouter", "custom"])
    XCTAssertEqual(server.lastRequest?.url?.query, nil)
    _ = await value.refreshAccountUsage(refresh: true)
    XCTAssertEqual(server.lastRequest?.url?.path, "/api/usage/accounts")
    XCTAssertEqual(server.lastRequest?.url?.query, "refresh=1")
  }
  func testAReadThatStartedBeforeAResetNeverReplacesTheAccountItChanged() async throws {
    let server = FakeServer(), value = try store(server)
    defer { clean(server, value) }
    server.reply = .init(body: try Self.fixtureResponse("usage-accounts"))
    _ = await value.refreshAccountUsage()
    let chatgpt = try XCTUnwrap(value.accountUsage?.accounts.first)
    XCTAssertEqual(chatgpt.bankedResets, 2)
    // A Refresh goes out first and is answered with the limits from before the reset, but lands last.
    let release = server.hold(path: "/api/usage/accounts")
    let seen = server.requests.count
    let late = Task { await value.refreshAccountUsage(refresh: true) }
    for _ in 0..<200 where server.requests.count == seen { try await Task.sleep(nanoseconds: 10_000_000) }
    var after = try JSONSerialization.jsonObject(with: Data(try Self.fixtureResponse("usage-reset").utf8)) as! [String: Any]
    var updated = after["account"] as! [String: Any]; updated["bankedResets"] = 1; after["account"] = updated
    server.reply = .init(body: String(decoding: try JSONSerialization.data(withJSONObject: after), as: UTF8.self))
    _ = try await value.resetAccountUsage(chatgpt, force: false, requestId: UUID().uuidString)
    release()
    _ = await late.value
    XCTAssertEqual(value.accountUsage?.accounts.first?.bankedResets, 1, "The reset's answer stands")
  }
  func testAReadThatStartsDuringAResetAndLandsAfterItNeverReplacesTheAccountItChanged() async throws {
    let before = try Self.fixtureResponse("usage-accounts")
    var after = try JSONSerialization.jsonObject(with: Data(try Self.fixtureResponse("usage-reset").utf8)) as! [String: Any]
    var updated = after["account"] as! [String: Any]; updated["bankedResets"] = 1; after["account"] = updated
    let resetBody = String(decoding: try JSONSerialization.data(withJSONObject: after), as: UTF8.self)
    let server = FakeServer { request in .init(body: request.httpMethod == "POST" ? resetBody : before) }
    let value = try store(server)
    defer { clean(server, value) }
    _ = await value.refreshAccountUsage()
    let chatgpt = try XCTUnwrap(value.accountUsage?.accounts.first)
    func waitFor(_ count: Int) async throws { for _ in 0..<200 where server.requests.count < count { try await Task.sleep(nanoseconds: 10_000_000) } }
    // The reset goes out first; a Refresh starts while it is out, with the limits from before; the reset answers first.
    let releaseReset = server.hold(path: "/api/usage/accounts/\(chatgpt.key)/reset")
    let reset = Task { try await value.resetAccountUsage(chatgpt, force: false, requestId: UUID().uuidString) }
    try await waitFor(2)
    let releaseRead = server.hold(path: "/api/usage/accounts")
    let late = Task { await value.refreshAccountUsage(refresh: true) }
    try await waitFor(3)
    releaseReset()
    _ = try await reset.value
    releaseRead()
    _ = await late.value
    XCTAssertEqual(value.accountUsage?.accounts.first?.bankedResets, 1, "The reset's answer stands")
  }
  func testTheMenuReadsAgainOnlyOnceTheLastReadIsAMinuteOld() async throws {
    let server = FakeServer(), value = try store(server)
    defer { clean(server, value) }
    server.reply = .init(body: try Self.fixtureResponse("usage-accounts"))
    await value.refreshAccountUsageIfStale()
    let readAt = try XCTUnwrap(value.accountUsageReadAt)
    await value.refreshAccountUsageIfStale(now: readAt.addingTimeInterval(59))
    XCTAssertEqual(server.requests.count, 1)
    await value.refreshAccountUsageIfStale(now: readAt.addingTimeInterval(60))
    XCTAssertEqual(server.requests.count, 2)
  }
  func testAFailedReadReportsTheServersWordsAndKeepsWhatWasShown() async throws {
    let server = FakeServer(), value = try store(server)
    defer { clean(server, value) }
    server.reply = .init(body: try Self.fixtureResponse("usage-accounts"))
    _ = await value.refreshAccountUsage()
    server.reply = .init(status: 502, body: #"{"error":"Hermes is not reachable."}"#)
    let failure = await value.refreshAccountUsage(refresh: true)
    XCTAssertEqual(failure, "Hermes is not reachable.")
    XCTAssertEqual(value.accountUsage?.accounts.count, 3, "The last good read stays on screen")
  }
  func testSpendingAResetConfirmsAndForcesOnlyWhenAskedAndReplacesThatAccount() async throws {
    let server = FakeServer(), value = try store(server)
    defer { clean(server, value) }
    server.reply = .init(body: try Self.fixtureResponse("usage-accounts"))
    _ = await value.refreshAccountUsage()
    let chatgpt = try XCTUnwrap(value.accountUsage?.accounts.first)
    var after = try JSONSerialization.jsonObject(with: Data(try Self.fixtureResponse("usage-reset").utf8)) as! [String: Any]
    var updated = after["account"] as! [String: Any]; updated["bankedResets"] = 1; after["account"] = updated
    server.reply = .init(body: String(decoding: try JSONSerialization.data(withJSONObject: after), as: UTF8.self))
    let outcome = try await value.resetAccountUsage(chatgpt, force: true, requestId: "6f1d2c3b-4a59-4e7d-8c1b-2a3f4e5d6c7b")
    XCTAssertEqual(server.lastRequest?.httpMethod, "POST")
    XCTAssertEqual(server.lastRequest?.url?.path, "/api/usage/accounts/\(chatgpt.key)/reset")
    let sent = try server.lastJSON()
    XCTAssertEqual(sent["confirmed"] as? Bool, true)
    XCTAssertEqual(sent["force"] as? Bool, true)
    XCTAssertEqual(sent["requestId"] as? String, "6f1d2c3b-4a59-4e7d-8c1b-2a3f4e5d6c7b", "The ID the caller keeps for a retry is the one sent")
    XCTAssertEqual(outcome.status, .reset)
    XCTAssertEqual(value.accountUsage?.accounts.map(\.bankedResets), [1, 0, 0], "Only the reset account changed")
    _ = try await value.resetAccountUsage(chatgpt, force: false, requestId: UUID().uuidString)
    XCTAssertEqual(try server.lastJSON()["force"] as? Bool, false)
  }
}
