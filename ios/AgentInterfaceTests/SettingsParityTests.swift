import XCTest
@testable import AgentInterface

final class SettingsParityTests: XCTestCase {
  func testMcpServerFieldKeepsOnlyNamedIdsLikeTheWebField() {
    XCTAssertEqual(BotInput.serverIds(" github, ,calendar ,, "), ["github", "calendar"])
    XCTAssertEqual(BotInput.serverIds(""), [])
  }
  func testNewMemoryEntriesAreSavedWithoutAnIdAndExistingOnesKeepTheirs() throws {
    let document = MemoryDocument(target: "memory", label: "Memory", revision: "r1", enabled: true, entries: [MemoryEntry(id: String(repeating: "a", count: 64), text: "Old")], charLimit: 2200, charCount: 3)
    var drafts = document.drafts()
    XCTAssertFalse(document.isChanged(drafts))
    var added = MemoryDraft(); added.text = "New"
    drafts.append(added)
    XCTAssertTrue(document.isChanged(drafts))
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(MemorySave(revision: "r1", drafts: drafts))) as? [String: Any]
    let entries = try XCTUnwrap(json?["entries"] as? [[String: Any]])
    XCTAssertEqual(entries[0]["id"] as? String, String(repeating: "a", count: 64))
    XCTAssertNil(entries[1]["id"])
    XCTAssertEqual(entries[1]["text"] as? String, "New")
  }
  func testTrialSummaryMatchesWebStatusCopyAndAppendsHermesMessage() {
    func receipt(_ status: String, _ message: String?) -> RoutineRunReceipt {
      RoutineRunReceipt(requestId: "r", routineId: "x", botId: "b", status: status, message: message, startedAt: "2026-10-01T12:00:00Z")
    }
    XCTAssertEqual(receipt("completed", "Done.").summary, "Trial run completed. Done.")
    XCTAssertEqual(receipt("accepted", nil).summary, "Trial run started. Hermes will finish it even if you close this screen.")
    XCTAssertEqual(receipt("uncertain", "").summary, "The run's outcome is unknown. Review its result before starting another.")
    XCTAssertTrue(receipt("failed", nil).finished)
    XCTAssertFalse(receipt("accepted", nil).finished)
  }
  func testSchedulePreviewShowsFullRunTimesInTheHermesTimezone() {
    let en = Locale(identifier: "en_US")
    let chicago = SchedulePreview(botId: "b", schedule: "0 7 * * *", timezone: "America/Chicago", nextRuns: [], kind: "cron")
    XCTAssertEqual(chicago.label("2027-01-04T13:00:00Z", locale: en), "1/4/2027, 7:00:00\u{202F}AM")
    let unknown = SchedulePreview(botId: "b", schedule: "0 7 * * *", timezone: "Not/AZone", nextRuns: [], kind: "cron")
    XCTAssertEqual(unknown.label("2027-01-04T13:00:00Z", locale: en), "1/4/2027, 1:00:00\u{202F}PM UTC")
  }

  // MARK: Hermes updates

  private func upgrade(_ phase: String, operation: String? = nil, candidate: Bool = true, checkedAt: String? = nil,
    canInstall: Bool = false, canCheck: Bool = true, canRetry: Bool = false, canCancel: Bool = false, canRestart: Bool = false,
    message: String = "Server message."
  ) throws -> UpgradeStatus {
    var json: [String: Any] = [
      "available": true, "phase": phase, "message": message, "checks": [], "canCheck": canCheck, "canInstall": canInstall,
      "canRetry": canRetry, "canCancel": canCancel, "canRestartService": canRestart, "busyBots": [],
    ]
    if candidate { json["candidate"] = ["revision": "new-revision", "version": "2.0"] }
    if let operation { json["operation"] = operation }
    if let checkedAt { json["checkedAt"] = checkedAt }
    return try JSONDecoder().decode(UpgradeStatus.self, from: JSONSerialization.data(withJSONObject: json))
  }
  func testUpgradeTitlesDependOnWhetherTheOperationWasACheckOrAnInstall() throws {
    let expected: [(String, String, String)] = [
      ("succeeded", "Hermes is ready", "Hermes is up to date"),
      ("blocked", "This update needs a look", "The update was stopped safely"),
      ("failed", "The check didn't finish", "The update couldn't finish"),
      ("cancelled", "Check stopped", "The update was cancelled"),
    ]
    for (phase, check, install) in expected {
      XCTAssertEqual(try upgrade(phase, operation: "check").title, check, phase)
      XCTAssertEqual(try upgrade(phase, operation: "install").title, install, phase)
    }
    XCTAssertEqual(try upgrade("ready").title, "Update tested and ready")
    XCTAssertEqual(try upgrade("rolled_back").title, "The previous version is restored")
  }
  func testAStatusWithoutAnOperationIsAnInstallOnlyInInstallPhases() throws {
    XCTAssertFalse(try upgrade("failed").isInstall)
    XCTAssertTrue(try upgrade("rolled_back").isInstall)
    XCTAssertTrue(try upgrade("verifying").isInstall)
    XCTAssertTrue(try upgrade("failed", operation: "install").isInstall)
    XCTAssertFalse(try upgrade("verifying", operation: "check").isInstall)
  }
  func testNothingFoundAfterACheckReadsAsUpToDate() throws {
    let current = try upgrade("idle", candidate: false, checkedAt: "2026-10-01T11:45:00.000Z", message: "Checked.")
    XCTAssertEqual(current.title, "Hermes is up to date")
    XCTAssertEqual(current.description(loading: false), "You're running the newest Hermes.")
    let unchecked = try upgrade("idle", candidate: false, message: "")
    XCTAssertEqual(unchecked.title, "Hermes updates")
    XCTAssertEqual(unchecked.description(loading: true), "Getting the current version and update status…")
    XCTAssertEqual(unchecked.description(loading: false), "Find the newest Hermes and test it before installing it.")
    XCTAssertEqual(try upgrade("ready", message: "It passed.").description(loading: false), "It passed.")
  }
  func testUpgradeStepsFollowTheWebPanel() throws {
    func states(_ status: UpgradeStatus) -> [String] { status.steps.map(\.state.rawValue) }
    XCTAssertEqual(try upgrade("checking", candidate: false).steps.map(\.name), ["Find", "Test in a copy", "Install"])
    XCTAssertEqual(states(try upgrade("checking", candidate: false)), ["active", "waiting", "waiting"])
    XCTAssertEqual(states(try upgrade("qualifying", operation: "check")), ["done", "active", "waiting"])
    XCTAssertEqual(states(try upgrade("ready", operation: "check")), ["done", "done", "waiting"])
    XCTAssertEqual(states(try upgrade("blocked", operation: "check")), ["done", "failed", "waiting"])
    XCTAssertEqual(states(try upgrade("failed", operation: "check", candidate: false)), ["failed", "waiting", "waiting"])
    XCTAssertEqual(states(try upgrade("installing", operation: "install")), ["done", "done", "active"])
    XCTAssertEqual(states(try upgrade("succeeded", operation: "install")), ["done", "done", "done"])
    XCTAssertEqual(states(try upgrade("rolled_back", operation: "install")), ["done", "done", "failed"])
    XCTAssertEqual(states(try upgrade("cancelled", operation: "install")), ["done", "done", "failed"])
  }
  func testRetryAndCancelBelongToInstallsAndStopCheckingToChecks() throws {
    let check = try upgrade("qualifying", operation: "check", canRetry: true, canCancel: true)
    XCTAssertTrue(check.canStopCheck)
    XCTAssertFalse(check.showsRecovery, "A running check has no recovery section")
    let install = try upgrade("installing", operation: "install", canCancel: true)
    XCTAssertFalse(install.canStopCheck)
    XCTAssertTrue(install.showsRecovery)
    XCTAssertTrue(try upgrade("failed", operation: "check", canRestart: true).showsRecovery, "Restart applies to either")
    XCTAssertFalse(try upgrade("failed", operation: "check", canRetry: true, canCancel: true).showsRecovery)
    XCTAssertFalse(try upgrade("ready", operation: "check", canCancel: true).canStopCheck, "Stopping needs a running check")
  }
  func testUpgradeButtonAndHintFollowTheWebPanel() throws {
    let ready = try upgrade("ready", operation: "check", canInstall: true)
    XCTAssertEqual(ready.actionLabel(submitting: false, uncertain: false), "Install update")
    XCTAssertEqual(ready.actionLabel(submitting: true, uncertain: false), "Starting the install…")
    XCTAssertEqual(ready.actionHint(uncertain: false), "Installing briefly reconnects Hermes. Conversations and drafts stay saved.")
    let stopped = try upgrade("blocked", operation: "check", candidate: false)
    XCTAssertEqual(stopped.actionLabel(submitting: false, uncertain: false), "Check again")
    XCTAssertEqual(stopped.actionLabel(submitting: true, uncertain: false), "Starting the check…")
    XCTAssertEqual(try upgrade("idle", candidate: false).actionLabel(submitting: false, uncertain: false), "Check for an update")
    XCTAssertEqual(try upgrade("qualifying", operation: "check").actionLabel(submitting: false, uncertain: false), "Testing…")
    XCTAssertEqual(try upgrade("installing", operation: "install").actionLabel(submitting: false, uncertain: false), "Installing…")
    XCTAssertEqual(try upgrade("idle").actionLabel(submitting: false, uncertain: true), "Checking update status…")
    let hint = "You can close this. Progress continues on the server."
    XCTAssertEqual(try upgrade("qualifying", operation: "check").actionHint(uncertain: false), hint)
    XCTAssertEqual(try upgrade("idle").actionHint(uncertain: true), hint)
    XCTAssertTrue(try upgrade("idle").actionHint(uncertain: false).hasPrefix("A check finds"))
  }
  func testTestDetailsReadLikeTheWeb() {
    func check(_ status: String, _ detail: String?) -> UpgradeCheck { UpgradeCheck(id: "x", label: "L", status: status, detail: detail) }
    XCTAssertEqual(check("passed", nil).summary, "Passed")
    XCTAssertEqual(check("failed", "Missing add-on").summary, "Failed · Missing add-on")
    XCTAssertEqual(check("running", nil).summary, "Running")
    XCTAssertEqual(check("pending", "Queued").summary, "Waiting · Queued")
  }

  // MARK: Computer

  func testComputerRowDescribesAvailabilityAndWhoHasControl() throws {
    func status(_ json: String) throws -> ComputerStatus { try JSONDecoder().decode(ComputerStatus.self, from: Data(json.utf8)) }
    XCTAssertEqual(try status(#"{"available":false,"reason":"The desktop is stopped.","control":{"kind":"idle"}}"#).detail, "The desktop is stopped.")
    XCTAssertEqual(try status(#"{"available":false,"control":{"kind":"idle"}}"#).detail, "Desktop unavailable")
    XCTAssertEqual(try status(#"{"available":true,"control":{"kind":"bot","name":"Ranch hand"}}"#).detail, "Ranch hand is using the computer")
    XCTAssertEqual(try status(#"{"available":true,"control":{"kind":"bot"}}"#).detail, "An assistant is using the computer")
    XCTAssertEqual(try status(#"{"available":true,"control":{"kind":"human","name":"Sam","mine":false}}"#).detail, "Sam has control")
    XCTAssertEqual(try status(#"{"available":true,"control":{"kind":"human","mine":true}}"#).detail, "Watching. Take over to control the desktop.")
    XCTAssertEqual(try status(#"{"available":true,"control":{"kind":"idle"}}"#).detail, "Watching. Assistants can use this computer.")
  }

  // MARK: Vault

  func testVaultSourceStatusAndLoginBackendUseTheWebWording() {
    func source(_ name: String, installed: Bool = true, enabled: Bool = true, unlocked: Bool = false) -> VaultSource {
      VaultSource(name: name, displayName: name, enabled: enabled, needsUnlock: true, unlocked: unlocked, installed: installed, canToggle: true, canUnlock: false, canLock: false)
    }
    XCTAssertEqual(source("bitwarden", installed: false).statusText, "CLI is not installed")
    XCTAssertEqual(source("local", enabled: false).statusText, "Available to Hermes in this profile")
    XCTAssertEqual(source("bitwarden", enabled: false).statusText, "Disabled")
    XCTAssertEqual(source("bitwarden", unlocked: true).statusText, "Unlocked for this profile")
    XCTAssertEqual(source("bitwarden").statusText, "Locked")
    func login(_ backend: String) -> VaultLogin {
      VaultLogin(id: "i", kind: "login", label: "L", origin: "https://a.test", createdAt: "", identifier: "me", identifierType: "email", hasOtp: false, backend: backend, canRemove: true)
    }
    XCTAssertEqual(login("local").backendLabel, "Hermes vault")
    XCTAssertEqual(login("onepassword").backendLabel, "1Password")
    XCTAssertEqual(login("bitwarden").backendLabel, "Bitwarden")
  }
  func testOnlyServerFailuresAndDroppedConnectionsLockTheVault() {
    XCTAssertTrue(VaultSafety.uncertain(APIError(message: "x", status: 503)))
    XCTAssertTrue(VaultSafety.uncertain(APIError(message: "x", status: 0)))
    XCTAssertTrue(VaultSafety.uncertain(URLError(.networkConnectionLost)))
    XCTAssertFalse(VaultSafety.uncertain(APIError(message: "x", status: 400)))
    XCTAssertFalse(VaultSafety.uncertain(APIError(message: "x", status: 409)))
  }
  func testAddLoginDefaultsToEmailAndNamesTheBadOriginProblem() {
    XCTAssertEqual(AddVaultLogin.defaultIdentifierType, "email")
    XCTAssertEqual(VaultSafety.invalidOriginMessage, "Enter the website address through the hostname, such as https://example.com.")
    XCTAssertTrue(VaultSafety.validOrigin("https://example.com"))
    XCTAssertFalse(VaultSafety.validOrigin("https://example.com/login"))
    XCTAssertFalse(VaultSafety.validOrigin("example.com"))
  }

  // MARK: Assistant settings

  func testSaveProgressShowsSavingThenSavedOnlyOnTheButtonThatSaved() {
    var progress = SaveProgress()
    XCTAssertEqual(progress.label("details", idle: "Save changes"), "Save changes")
    progress.begin("details")
    XCTAssertEqual(progress.label("details", idle: "Save changes"), "Saving…")
    XCTAssertEqual(progress.label("avatar", idle: "Save avatar"), "Save avatar")
    progress.succeed("details")
    XCTAssertEqual(progress.label("details", idle: "Save changes"), "Saved")
    progress.expire("avatar")
    XCTAssertEqual(progress.label("details", idle: "Save changes"), "Saved", "Another button's timer cannot clear this one")
    progress.begin("avatar")
    progress.expire("details")
    XCTAssertEqual(progress.label("avatar", idle: "Save avatar"), "Saving…", "An old timer cannot end a newer save")
    progress.fail("avatar")
    XCTAssertEqual(progress.label("avatar", idle: "Save avatar"), "Save avatar")
    progress.begin("tools"); progress.succeed("tools"); progress.expire("tools")
    XCTAssertEqual(progress.label("tools", idle: "Save tools"), "Save tools")
  }
  func testLengthLimitsStaySilentUntilNearThenCountThenExplain() {
    let limit = SettingsLimits.instructions
    XCTAssertNil(SettingsLimits.message("Instructions are", count: 100, limit: limit))
    XCTAssertEqual(SettingsLimits.message("Instructions are", count: 45_000, limit: limit), "45,000 of 50,000 characters")
    XCTAssertEqual(SettingsLimits.message("Instructions are", count: 50_000, limit: limit), "50,000 of 50,000 characters")
    XCTAssertEqual(SettingsLimits.message("Instructions are", count: 50_012, limit: limit), "Instructions are 12 characters over the 50,000 limit. Shorten the text to save.")
    XCTAssertEqual(SettingsLimits.message("The description is", count: 2_001, limit: SettingsLimits.portraitPrompt), "The description is 1 character over the 2,000 limit. Shorten the text to save.")
  }
  // MARK: Model picker

  func testModelPickerRefreshAndStarFollowTheWebRules() {
    XCTAssertTrue(ModelPickerRules.refreshVisible(error: nil, providerCount: 2))
    XCTAssertFalse(ModelPickerRules.refreshVisible(error: "Offline", providerCount: 2), "Retry replaces Refresh in an error state")
    XCTAssertFalse(ModelPickerRules.refreshVisible(error: nil, providerCount: 0))
    XCTAssertFalse(ModelPickerRules.starDisabled(saving: false, favoriteCount: 3, isFavorite: false), "Blocked model changes do not block starring")
    XCTAssertTrue(ModelPickerRules.starDisabled(saving: true, favoriteCount: 3, isFavorite: true))
    XCTAssertTrue(ModelPickerRules.starDisabled(saving: false, favoriteCount: 100, isFavorite: false))
    XCTAssertFalse(ModelPickerRules.starDisabled(saving: false, favoriteCount: 100, isFavorite: true), "A full list can still remove a favorite")
  }

  // MARK: Integrations

  func testIntegrationsSummaryFlowHeadingAndAssistantFallback() throws {
    func connection(_ status: String, bots: [String]) -> IntegrationConnection {
      IntegrationConnection(id: status, name: "N", category: "c", owner: "Hermes", profile: "p", status: status, detail: "", permissions: [],
        actions: IntegrationActions(connect: true, check: true, disconnect: true), setup: [], capabilities: [], botIds: bots)
    }
    let catalog = IntegrationCatalog(profile: "p", canManage: true, connections: [connection("connected", bots: []), connection("expired", bots: ["a"]), connection("connected", bots: ["a"])])
    XCTAssertEqual(catalog.connectedSummary, "2 connected")
    XCTAssertEqual(connection("connected", bots: []).assistantsLabel { _ in nil }, "This assistant")
    XCTAssertEqual(connection("connected", bots: ["a", "b"]).assistantsLabel { $0 == "a" ? "Ranch hand" : nil }, "Ranch hand, b")
    func flow(_ kind: String, _ status: String) -> IntegrationFlow { IntegrationFlow(kind: kind, status: status, message: "") }
    XCTAssertEqual(flow("instructions", "approved").heading, "Connection ready")
    XCTAssertEqual(flow("connected", "pending").heading, "Connection ready")
    XCTAssertEqual(flow("device", "pending").heading, "Finish connecting your account")
    XCTAssertEqual(flow("device", "denied").heading, "Sign-in status")
  }
  func testCustomMcpAddressNeedsAFullWebAddress() {
    XCTAssertTrue(IntegrationInput.validServerURL("https://mcp.example.com/sse"))
    XCTAssertTrue(IntegrationInput.validServerURL(" http://localhost:8080 "))
    XCTAssertFalse(IntegrationInput.validServerURL("mcp.example.com"))
    XCTAssertFalse(IntegrationInput.validServerURL("https://"))
    XCTAssertFalse(IntegrationInput.validServerURL("ftp://example.com"))
    XCTAssertFalse(IntegrationInput.validServerURL(""))
  }
}
