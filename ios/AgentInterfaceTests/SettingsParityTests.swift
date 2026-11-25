import XCTest
@testable import AgentInterface

final class SettingsParityTests: XCTestCase {
  func testSettingsListsFiveSectionsWithTheWebLabelsAndSummaries() {
    XCTAssertEqual(SettingsSection.allCases.map(\.label), ["Profile", "Behavior", "Access", "Automation", "Memory & learning"])
    XCTAssertEqual(SettingsSection.allCases.map(\.rawValue), ["profile", "behavior", "access", "automation", "memory"], "Ids match the web's section ids")
    XCTAssertEqual(SettingsSection.profile.summary(shared: true, modelName: "x"), "Shared with your household")
    XCTAssertEqual(SettingsSection.profile.summary(shared: false, modelName: "x"), "Personal")
    XCTAssertEqual(SettingsSection.behavior.summary(shared: true, modelName: "Claude Sonnet"), "Claude Sonnet")
    XCTAssertEqual(SettingsSection.access.summary(shared: true, modelName: ""), "Logins and approvals")
    XCTAssertEqual(SettingsSection.automation.summary(shared: true, modelName: ""), "Scheduled routines")
    XCTAssertEqual(SettingsSection.memory.summary(shared: true, modelName: ""), "What it remembers and learns")
  }
  func testFormerTabNamesOpenTheSectionThatHoldsTheirContent() {
    XCTAssertEqual(SettingsRoute.path(for: "Avatar"), [.section(.profile)])
    XCTAssertEqual(SettingsRoute.path(for: "Skills"), [.section(.behavior)])
    XCTAssertEqual(SettingsRoute.path(for: "Logins"), [.section(.access), .logins])
    XCTAssertNil(SettingsRoute.path(for: "Work"), "Goals, tasks and triggers are gone")
    XCTAssertNil(SettingsRoute.path(for: "Connections"), "The integrations manager is gone")
    XCTAssertEqual(SettingsRoute.path(for: "Memory"), [.section(.memory), .memory])
    XCTAssertEqual(SettingsRoute.path(for: "Learning"), [.section(.memory), .learning])
    XCTAssertNil(SettingsRoute.path(for: "More"))
  }
  /// The same rules as `harnessChoices` in src/app/harness.ts.
  func testHarnessChoicesOfferNativeHarnesses() {
    let ids = { (choices: [Harness.Choice]) in choices.map { "\($0.id)\($0.available ? "" : "-off")" } }
    XCTAssertEqual(ids(Harness.choices(nil, saved: nil)), ["antigravity-off", "codex-off", "claude-code-off", "grok-off", "pi-off"])
    XCTAssertEqual(Harness.defaultChoice(nil), "antigravity")
    let advertised = [HarnessOption(id: "codex", available: true), HarnessOption(id: "grok", available: false, reason: "Sign in first."),
      HarnessOption(id: "opencode", available: true)]
    XCTAssertEqual(ids(Harness.choices(advertised, saved: nil)), ["antigravity-off", "codex", "claude-code-off", "grok-off", "pi-off", "opencode"])
    XCTAssertEqual(Harness.defaultChoice(advertised), "codex")
    XCTAssertEqual(Harness.choices(advertised, saved: nil).first { $0.id == "grok" }?.reason, "Sign in first.")
    XCTAssertEqual(Harness.label("opencode"), "opencode")
  }
  func testBotQueueFollowsCapabilities() {
    var bot = Bot(id: "ranch", name: "Ranch", model: "m", shared: true, activity: .idle)
    let boot = Bootstrap(user: Member(id: "one", name: "One", email: "one@example.test"), household: [], preferences: Preferences(),
      bots: [], capabilities: ["queueManagement": Capability(supported: true)], connection: RuntimeStatus(connected: true))
    XCTAssertTrue(boot.supportsQueue(bot))
    bot.harness = "codex"
    XCTAssertTrue(boot.supportsQueue(bot))
    bot.capabilities = ["queueManagement": Capability(supported: false)]
    XCTAssertFalse(boot.supportsQueue(bot), "The bot's own harness wins over the bootstrap")
  }
  func testSavingWithoutChoosingAHarnessNeverSendsOne() throws {
    var input = BotInput(bot: Bot(id: "ranch", name: "Ranch", model: "m", shared: true, activity: .idle, harness: "codex"))
    let encoded = { (value: BotInput) in try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any] ?? [:] }
    XCTAssertNil(try encoded(input)["harness"], "The composer's model picker saves through BotInput(bot:) and must not switch harnesses")
    input.harness = "claude-code"
    XCTAssertEqual(try encoded(input)["harness"] as? String, "claude-code")
  }
  func testMcpSwitchesListEveryServerOnceSortedAndToggleOnlyTheirOwn() {
    XCTAssertEqual(McpServerChoices.names(available: ["github", "calendar"], enabled: ["retired", "calendar"]), ["calendar", "github", "retired"],
      "An enabled server the profile no longer lists stays visible so it can be turned off")
    XCTAssertEqual(McpServerChoices.names(available: [], enabled: []), [])
    XCTAssertEqual(McpServerChoices.toggled(["calendar"], "github", on: true), ["calendar", "github"])
    XCTAssertEqual(McpServerChoices.toggled(["calendar", "github"], "github", on: true), ["calendar", "github"])
    XCTAssertEqual(McpServerChoices.toggled(["calendar", "github"], "calendar", on: false), ["github"])
  }
  func testBotDetailDecodesAvailableMcpServersAndOlderServersOmitThem() throws {
    let base = #"{"id":"ranch","name":"Ranch hand","model":"m","shared":true,"activity":"idle","enabledMcpServers":["calendar"]"#
    let detail = try JSONDecoder().decode(Bot.self, from: Data((base + #","availableMcpServers":["calendar","files"]}"#).utf8))
    XCTAssertEqual(detail.availableMcpServers, ["calendar", "files"])
    XCTAssertNil(try JSONDecoder().decode(Bot.self, from: Data((base + "}").utf8)).availableMcpServers)
  }
  func testSaveNoticeMentionsSharingOnlyWhenTheAssistantItselfSaved() {
    XCTAssertEqual(settingsSavedNotice(patched: true, shared: true), "Changes saved for both household members.")
    XCTAssertEqual(settingsSavedNotice(patched: true, shared: false), "Assistant saved.")
    XCTAssertEqual(settingsSavedNotice(patched: false, shared: true), "Saved")
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

  // MARK: Macs

  func testMacsRowSummarizesLinkedMacsAndEachShowsOnlineOrLastSeen() throws {
    func list(_ json: String) throws -> MacDeviceList { try JSONDecoder().decode(MacDeviceList.self, from: Data(json.utf8)) }
    XCTAssertEqual(try list(#"{"available":true,"devices":[]}"#).summary, "No Macs linked")
    let two = try list(#"{"available":true,"devices":[{"id":"mac_1","name":"Studio","online":true},{"id":"mac_2","name":"Laptop","online":false,"lastSeenAt":"2026-11-08T10:00:00.000Z"}]}"#)
    XCTAssertEqual(two.summary, "2 Macs, 1 online")
    XCTAssertEqual(try list(#"{"available":true,"devices":[{"id":"m","name":"Laptop","online":false}]}"#).summary, "1 Mac, offline")
    XCTAssertEqual(two.devices?[0].status(), "Online")
    let now = try XCTUnwrap(ServerDate.parse("2026-11-08T12:00:00.000Z"))
    XCTAssertEqual(two.devices?[1].status(now: now), "Last seen 2 hours ago")
    XCTAssertEqual(try list(#"{"available":true,"devices":[{"id":"m","name":"New","online":false}]}"#).devices?[0].status(), "Never connected")
    // A server without a link key answers available false and no devices; Settings hides the row.
    let off = try list(#"{"available":false,"reason":"Mac links are not configured."}"#)
    XCTAssertFalse(off.available)
    XCTAssertNil(off.devices)
  }

  @MainActor func testRevokingAMacDeletesThatMacByItsEscapedId() async throws {
    let server = FakeServer()
    server.reply = .init(status: 200, body: #"{"ok":true}"#)
    try await MacDeviceList.revoke("mac_1/../x", api: server.api())
    XCTAssertEqual(server.lastRequest?.httpMethod, "DELETE")
    XCTAssertEqual(server.lastRequest?.url?.path(percentEncoded: true), "/api/mac/devices/mac_1%2F..%2Fx")
    server.reply = .init(status: 404, body: #"{"error":"Not found"}"#)
    do {
      try await MacDeviceList.revoke("mac_2", api: server.api())
      XCTFail("a refused revoke reported success")
    } catch {
      XCTAssertEqual((error as? APIError)?.status, 404)
    }
  }

  // MARK: Talk voice

  func testBotDecodesItsTalkVoiceAndOlderServersOmitIt() throws {
    let base = #"{"id":"ranch","name":"Ranch hand","model":"m","shared":true,"activity":"idle""#
    XCTAssertEqual(try JSONDecoder().decode(Bot.self, from: Data((base + #","voice":"cedar"}"#).utf8)).voice, "cedar")
    XCTAssertNil(try JSONDecoder().decode(Bot.self, from: Data((base + "}").utf8)).voice)
  }
  func testTalkVoicesMatchTheWebListWithMarinTheDefault() {
    XCTAssertEqual(TalkVoice.all, ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"])
    XCTAssertEqual(TalkVoice.grokAll, ["eve", "ara", "rex", "sal", "leo"])
    XCTAssertEqual(TalkVoice.default, "marin")
    XCTAssertEqual(TalkVoice.grokDefault, "eve")
    XCTAssertEqual(TalkVoice.provider(for: "eve"), .xai)
    XCTAssertEqual(TalkVoice.provider(for: "marin"), .openai)
    XCTAssertEqual(TalkVoice.title("shimmer"), "Shimmer")
  }
  func testUnavailableLiveTalkNoteNamesTheReasonAndOnlyShowsWhenUnsupported() {
    XCTAssertEqual(TalkVoice.unavailableNote(Capability(supported: false, reason: "Add an OpenAI key.")), "Live Talk isn't available yet. Add an OpenAI key.")
    XCTAssertEqual(TalkVoice.unavailableNote(Capability(supported: false, reason: nil)), "Live Talk isn't available yet.")
    XCTAssertNil(TalkVoice.unavailableNote(Capability(supported: true, reason: nil)))
    XCTAssertNil(TalkVoice.unavailableNote(nil))
  }
  @MainActor func testChoosingAVoiceSavesItAtOnceWithAnEscapedPath() async throws {
    let server = FakeServer()
    server.reply = .init(status: 200, body: #"{"voice":"cedar"}"#)
    let model = TalkVoiceModel(botId: "ranch/../x", voice: nil)
    model.api = server.api()
    XCTAssertEqual(model.chosen, "marin")
    let saved = await model.choose("cedar")
    XCTAssertTrue(saved)
    XCTAssertEqual(model.chosen, "cedar")
    XCTAssertEqual(server.lastRequest?.httpMethod, "PUT")
    XCTAssertEqual(server.lastRequest?.url?.path(percentEncoded: true), "/api/bots/ranch%2F%2E%2E%2Fx/voice")
    XCTAssertEqual(try server.lastJSON()["voice"] as? String, "cedar")
    // The voice already chosen sends nothing.
    let again = await model.choose("cedar")
    XCTAssertFalse(again)
    XCTAssertEqual(server.requests.count, 1)
  }
  @MainActor func testAFailedVoiceSaveRollsBackAndSaysWhy() async throws {
    let server = FakeServer()
    server.reply = .init(status: 503, body: #"{"error":"Hermes is restarting."}"#)
    let model = TalkVoiceModel(botId: "ranch", voice: "ash")
    model.api = server.api()
    let saved = await model.choose("coral")
    XCTAssertFalse(saved)
    XCTAssertEqual(model.chosen, "ash")
    XCTAssertEqual(model.error, "Coral wasn't saved: Hermes is restarting.")
    XCTAssertNil(model.saving)
    // The next successful save clears the message.
    server.reply = .init(status: 200, body: #"{"voice":"coral"}"#)
    let retried = await model.choose("coral")
    XCTAssertTrue(retried)
    XCTAssertEqual(model.error, "")
  }
  @MainActor func testASampleThatCannotLoadReportsItAndPlaysNothing() async throws {
    let server = FakeServer()
    server.reply = .init(status: 404, body: #"{"error":"Not found"}"#)
    let model = TalkVoiceModel(botId: "ranch", voice: nil)
    model.api = server.api()
    model.toggleSample("echo")
    XCTAssertEqual(model.playing, "echo")
    try await until { model.failed == "echo" }
    XCTAssertNil(model.playing)
    // The sample is public: it is fetched without the session token.
    XCTAssertEqual(server.lastRequest?.url?.path, "/voice-previews/echo.m4a")
    XCTAssertNil(server.lastRequest?.value(forHTTPHeaderField: "Authorization"))
  }
  @MainActor func testStoppingASampleReleasesTheSharedAudioClaim() async throws {
    let server = FakeServer()
    server.reply = .init(status: 404, body: "{}")
    let model = TalkVoiceModel(botId: "ranch", voice: nil)
    model.api = server.api()
    model.toggleSample("echo")
    XCTAssertNotNil(MicrophoneOwnership.shared.stopPlayback)
    model.stop()
    XCTAssertNil(model.playing)
    XCTAssertNil(MicrophoneOwnership.shared.stopPlayback)
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
    XCTAssertEqual(SettingsLimits.message("The description is", count: 2_001, limit: SettingsLimits.portraitPrompt, action: "generate a portrait"), "The description is 1 character over the 2,000 limit. Shorten the text to generate a portrait.")
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
