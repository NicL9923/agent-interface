import XCTest
@testable import AgentInterface

private struct Envelope<T: Decodable>: Decodable { var request: String; var response: T }
private typealias Check = @MainActor (Data) throws -> Void
/// Decodes a fixture's response through the app's own decoding path, then runs `verify`.
@MainActor private func check<T: Decodable>(_ type: T.Type, _ verify: @escaping @MainActor (T) throws -> Void) -> Check {
  { data in
    let envelope: Envelope<T> = try APIClient.decode(data, from: "fixture")
    try verify(envelope.response)
  }
}

/// Decodes every server-generated fixture in `Contract/` into the app's real types.
/// `tests/native-contract.test.ts` writes the fixtures from the real server; regenerate them with
/// `UPDATE_CONTRACT=1 npx vitest run tests/native-contract.test.ts`.
@MainActor final class ContractFixtureTests: XCTestCase {
  private static let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .appendingPathComponent("Contract", isDirectory: true)
  private func fixture(_ name: String) throws -> Data {
    try Data(contentsOf: Self.directory.appendingPathComponent(name + ".json"))
  }

  /// One entry per fixture. The test fails when a fixture has no entry, so new endpoints get decoded.
  private var checks: [String: Check] { [
    "auth-config": check(AuthConfig.self) { XCTAssertEqual($0.nativeAuthVersion, 1); XCTAssertTrue($0.localDevAuth) },
    "auth-native-exchange": check(TokenExchange.self) {
      XCTAssertEqual($0.user.id, "local-one"); XCTAssertNil($0.user.picture)
      XCTAssertNotNil($0.expiresAt.flatMap(ServerDate.parse))
    },
    "automations": check(AutomationOverview.self) {
      XCTAssertEqual($0.routines.map(\.id), ["routine-morning", "routine-garden"])
      XCTAssertEqual($0.usage.first?.actualCost, 1.25); XCTAssertNil($0.usage.last?.estimatedCost)
      XCTAssertEqual($0.unavailableBots, ["archive"])
    },
    "bootstrap": check(Bootstrap.self) {
      XCTAssertEqual($0.bots.map(\.activity), [.working, .waiting, .done])
      XCTAssertEqual($0.bots.map(\.avatar?.mode), ["geometric", "mascot", "portrait"])
      XCTAssertEqual($0.bots[0].avatar?.geometry, "pebble")
      XCTAssertEqual($0.bots[1].avatar?.family, "fox"); XCTAssertEqual($0.bots[2].avatar?.origin, "generated")
      XCTAssertEqual($0.bots[0].avatar?.eyeSpacing, 1.2); XCTAssertEqual($0.bots[1].ownerId, "local-one")
      XCTAssertEqual($0.household.count, 2); XCTAssertNotNil($0.user.picture); XCTAssertNil($0.csrfToken)
      XCTAssertEqual($0.preferences.notifications?.batchMinutes, 15); XCTAssertEqual($0.preferences.sections.first?.botIds, ["household", "garden"])
      XCTAssertEqual($0.capabilities["imageGeneration"]?.supported, false); XCTAssertNotNil($0.capabilities["imageGeneration"]?.reason)
      XCTAssertEqual($0.connection.code, "ready"); XCTAssertNotNil($0.connection.lastConnectedAt)
      XCTAssertEqual($0.preferences.assistantGroups($0.bots).map(\.title), ["Home", "More assistants"])
    },
    "bot-avatar": check(AvatarConfig.self) { XCTAssertEqual($0.shape, "pebble"); XCTAssertEqual($0.accessory, "glasses") },
    "bot-draft": check(Draft?.self) { XCTAssertEqual($0?.text, "Add basil") },
    "bot-draft-save": check(Draft.self) { XCTAssertEqual($0.attachments.first?.id, "pantry.signature") },
    "bot-portrait": check(FileRef.self) { XCTAssertEqual($0.url, "/api/files/portrait.signature") },
    "bot-read-position": check(ReadPosition.self) { XCTAssertEqual($0.messageId, "message-assistant"); XCTAssertEqual($0.scrollTop, 240.5) },
    "bot-skills": check([CapabilityItem].self) { XCTAssertEqual($0.first?.required, true) },
    "bot-starters": check([Starter].self) { XCTAssertEqual($0.first?.id, "meals") },
    "bot-tools": check([CapabilityItem].self) { XCTAssertEqual($0.map(\.id), ["terminal", "web"]) },
    "bot-update": check(Bot.self) { XCTAssertEqual($0.enabledMcpServers, ["calendar"]); XCTAssertEqual($0.activity, .working) },
    "bot-upload": check(FileRef.self) { XCTAssertEqual($0.mime, "text/plain"); XCTAssertNotNil($0.size) },
    "card-state": check(ReplyCardState.self) { XCTAssertEqual($0.checkedIds, ["milk"]) },
    "card-state-save": check(ReplyCardState.self) { XCTAssertEqual($0.checkedIds, ["milk"]); XCTAssertTrue($0.notes.isEmpty) },
    "connection-retry": check(RuntimeStatus.self) { XCTAssertTrue($0.connected); XCTAssertNotNil($0.retryAt) },
    "conversation": check(Conversation.self) {
      XCTAssertEqual($0.messages.first?.sender?.name, "Local member one")
      XCTAssertEqual($0.activity.state, .working); XCTAssertEqual($0.activity.runId, "run-dinner")
      XCTAssertEqual($0.attention?.compactMap(\.secure).filter(\.supported).count, 4)
      XCTAssertEqual($0.attention?.first?.questions?.first?.options, ["Market", "Co-op"])
      XCTAssertNotNil($0.approvals.first?.expiresAt.flatMap(ServerDate.parse))
      XCTAssertEqual($0.activityMessages.compactMap(\.toolCall).map(\.id), ["call-search", "call-calendar"])
      XCTAssertEqual($0.toolCalls?.last?.error, "Calendar access expired.")
      XCTAssertEqual($0.draft?.text, "Add basil"); XCTAssertEqual($0.readPosition?.scrollTop, 240.5)
      let reply = try XCTUnwrap($0.messages.last)
      XCTAssertEqual(reply.reasoning, "Balanced the week around the pantry list."); XCTAssertEqual(reply.files?.first?.size, 18432)
      XCTAssertEqual(ReplyCards.parse(reply.text).compactMap(\.cards).flatMap { $0 }.map(\.id), ["groceries"])
    },
    "group-approve": check(GroupApproved.self) { XCTAssertTrue($0.approved) },
    "group-create": check(GroupCreated.self) { XCTAssertEqual($0.room.members.map(\.display_name), ["Household", "Garden"]) },
    "group-log": check(GroupPage.self) {
      XCTAssertEqual($0.events.first?.payload.thread_id, "thread-1"); XCTAssertEqual($0.events.first?.created_at, 1790852400.5)
      XCTAssertFalse($0.has_more)
    },
    "group-message": check(GroupAccepted.self) { XCTAssertTrue($0.accepted) },
    "group-state": check(GroupState.self) {
      let action = try XCTUnwrap($0.driver_status?.pending_actions.first)
      XCTAssertEqual(action.execution_generation, 1); XCTAssertEqual(action.approval?.command, "grocer order --items 12")
      XCTAssertEqual($0.driver_status?.blocked, true)
    },
    "group-stop": check([String: Int].self) { XCTAssertEqual($0["cancelled"], 1) },
    "groups": check(GroupCatalog.self) { XCTAssertTrue($0.canSend); XCTAssertEqual($0.rooms.first?.members.count, 2); XCTAssertNotNil($0.reason) },
    "history": check(HistoryPage.self) { XCTAssertEqual($0.messages.first?.sender?.id, "local-two"); XCTAssertTrue($0.hasMore) },
    "integration-callback": check(IntegrationFlow.self) { XCTAssertEqual($0.kind, "redirect") },
    "integration-check": check(IntegrationConnection.self) {
      XCTAssertEqual($0.permissions.map(\.granted), [true, false, nil]); XCTAssertEqual($0.statusLabel, "Connected")
    },
    "integration-connect": check(IntegrationFlow.self) {
      XCTAssertEqual($0.userCode, "WXYZ-1234"); XCTAssertEqual($0.callbackInput, true); XCTAssertNotNil($0.expiresAt)
    },
    "integration-flow": check(IntegrationFlow.self) { XCTAssertEqual($0.flowId, "flow_a1b2c3d4e5f6g7h8i9j0") },
    "integration-flow-cancel": check(IntegrationFlow.self) { XCTAssertEqual($0.status, "cancelled") },
    "integration-mcp": check(CustomMcpResponse.self) { XCTAssertNil($0.flow) },
    "integrations": check(IntegrationCatalog.self) {
      XCTAssertTrue($0.canManage)
      XCTAssertEqual($0.connections.first?.setup.first?.options?.first?.value, "primary")
      XCTAssertEqual($0.connections.first?.setup.first?.defaultValue, "primary")
    },
    "memory": check(ProfileMemory.self) { XCTAssertEqual($0.documents.map(\.target), ["memory", "user"]); XCTAssertEqual($0.documents.first?.entries.count, 1) },
    "memory-save": check(ProfileMemory.self) { XCTAssertEqual($0.documents.first?.charLimit, 2200) },
    "message-submit": check(Receipt.self) { XCTAssertEqual($0.status, "accepted"); XCTAssertEqual($0.messageId, "message-user") },
    "models": check(ModelCatalog.self) {
      XCTAssertEqual($0.providers.first?.matches("claude"), true)
      XCTAssertEqual($0.providers.first?.models.map(\.available), [true, false])
    },
    "preferences": check(Preferences.self) {
      XCTAssertEqual($0.presentation, "advanced"); XCTAssertEqual($0.startPage, "today"); XCTAssertEqual($0.notifications?.quietStart, "22:00")
    },
    "push-config": check(PushConfig.self) { XCTAssertTrue($0.available); XCTAssertEqual($0.environment, "sandbox") },
    "routine-output": check(RoutineOutput.self) { XCTAssertEqual($0.messages.first?.role, "assistant"); XCTAssertFalse($0.previewOnly) },
    "routine-preview": check(SchedulePreview.self) { XCTAssertEqual($0.timezone, "America/Chicago"); XCTAssertEqual($0.nextRuns.count, 2) },
    "routine-results": check([RoutineResultRow].self) { XCTAssertEqual($0.first?.preview, "Five dinners and a grocery list.") },
    "routine-run": check(RoutineRunReceipt.self) { XCTAssertEqual($0.status, "completed") },
    "routine-run-receipt": check(RoutineRunReceipt.self) { XCTAssertNotNil($0.finishedAt); XCTAssertEqual($0.routineId, "routine-morning") },
    "routine-save": check(Routine.self) { XCTAssertEqual($0.recipientIds, ["local-one", "local-two"]) },
    "routine-templates": check([RoutineTemplate].self) { XCTAssertEqual($0.map(\.id), ["morning", "meals", "health"]) },
    "routines": check([Routine].self) {
      XCTAssertEqual($0.first?.recipientIds, ["local-one", "local-two"]); XCTAssertNotNil($0.first?.lastDeliveryError)
    },
    "saved": check([SavedItem].self) { XCTAssertEqual($0.map(\.kind), ["routine", "session"]) },
    "saved-routine": check(SavedItem.self) { XCTAssertEqual($0.resultId, "result-1") },
    "saved-session": check(SavedItem.self) { XCTAssertEqual($0.messageId, "message-assistant"); XCTAssertEqual($0.offset, 0) },
    "search": check(SearchResponse.self) {
      XCTAssertEqual($0.hits.map(\.routineId), [nil, "routine-morning"]); XCTAssertEqual($0.unavailableBots, ["archive"])
    },
    "submission": check(Receipt.self) { XCTAssertEqual($0.runId, "run-dinner"); XCTAssertNotNil($0.message) },
    "today": check(TodayOverview.self) { overview in
      XCTAssertEqual(overview.items.map(\.botId), ["household", "garden", "archive"])
      XCTAssertEqual(overview.recentMessage(overview.items[0])?.id, "message-assistant")
      XCTAssertNotNil(overview.items[2].error); XCTAssertEqual(overview.unavailableBots, ["archive"])
      XCTAssertEqual(overview.events.first?.routineId, "routine-morning"); XCTAssertEqual(overview.upcoming?.count, 1)
      XCTAssertEqual(overview.frontier, "1"); XCTAssertFalse(overview.hasMore)
    },
    "today-seen": check([String: Bool].self) { XCTAssertEqual($0["ok"], true) },
    "upgrade": check(UpgradeStatus.self) {
      XCTAssertEqual($0.title, "Update ready"); XCTAssertEqual($0.candidate?.displayVersion, "0.9.5")
      XCTAssertEqual($0.checks.first?.status, "passed"); XCTAssertEqual($0.busyBots, ["Household"])
    },
    "vault": check(ProfileVault.self) { XCTAssertEqual($0.items.first?.hasOtp, true); XCTAssertEqual($0.sources.map(\.name), ["local", "bitwarden"]) },
    "vault-login-add": check(AddedVaultLogin.self) { XCTAssertEqual($0.id, "login-new") },
    "vault-login-remove": check(RemovedVaultLogin.self) { XCTAssertTrue($0.removed) },
    "vault-secure-answer": check(SecureRequestResult.self) { XCTAssertEqual($0.status, "ok") },
    "voice-transcript": check(VoiceTranscript.self) { XCTAssertEqual($0.text, "Add basil to the list."); XCTAssertEqual($0.provider, "whisper") },
  ] }

  func testEveryServerFixtureDecodesIntoTheAppTypes() throws {
    let names = Set(try FileManager.default.contentsOfDirectory(at: Self.directory, includingPropertiesForKeys: nil)
      .filter { $0.pathExtension == "json" }.map { $0.deletingPathExtension().lastPathComponent })
    XCTAssertFalse(names.isEmpty, "Generate fixtures with UPDATE_CONTRACT=1 npx vitest run tests/native-contract.test.ts")
    XCTAssertEqual(names.subtracting(checks.keys).sorted(), [], "Add a decoding check for each new fixture")
    XCTAssertEqual(Set(checks.keys).subtracting(names).sorted(), [], "Remove checks for fixtures the server no longer writes")
    for name in names.sorted() {
      guard let check = checks[name] else { continue }
      do { try check(try fixture(name)) } catch {
        XCTFail("\(name): \((error as? APIError)?.detail ?? String(describing: error))")
      }
    }
  }

  func testUnrecognizedActivityStateDegradesInsteadOfFailingTheResponse() throws {
    let text = try XCTUnwrap(String(data: try fixture("bootstrap"), encoding: .utf8))
    let newer = text.replacingOccurrences(of: #""activity": "working""#, with: #""activity": "daydreaming""#)
    XCTAssertNotEqual(newer, text)
    let bootstrap: Envelope<Bootstrap> = try APIClient.decode(Data(newer.utf8), from: "/api/bootstrap")
    XCTAssertEqual(bootstrap.response.bots.map(\.activity), [.unknown, .waiting, .done])
    XCTAssertEqual(ActivityState.unknown.label, "Status unknown")
    XCTAssertFalse(ActivityState.unknown.active)
    XCTAssertEqual(ActivityState.allCases.count, 9, "Pickers and specimens list only server-defined states")
    XCTAssertFalse(ActivityState.allCases.contains(.unknown))
    XCTAssertTrue(AvatarMotion.timelinePaused(.unknown, reduceMotion: false, visible: true, active: true, settling: true))
    XCTAssertEqual(AvatarMotion.pose(.unknown, 1.2, reduce: false), AvatarMotion.restingPose)
  }

  func testUnreadableResponsesReportTheFailingCodingPathWithoutValues() {
    func detail<T: Decodable>(_ json: String, as type: T.Type) -> String? {
      do { let _: T = try APIClient.decode(Data(json.utf8), from: "/api/example?q=private"); return nil } catch {
        let error = error as? APIError
        XCTAssertEqual(error?.code, "INVALID_RESPONSE")
        XCTAssertEqual(error?.message, "The app server returned an unreadable response. Check that its version supports this client.")
        return error?.detail
      }
    }
    XCTAssertEqual(detail(#"{"googleClientId": "secret-value"}"#, as: Bootstrap.self), "user is missing")
    XCTAssertEqual(detail(#"[{"id": 1, "title": "t", "prompt": "p"}]"#, as: [Starter].self), "[0].id is not String")
    XCTAssertEqual(detail(#"{"user": {"id": "one"}}"#, as: Bootstrap.self), "user.name is missing")
    XCTAssertEqual(detail("not json", as: RuntimeStatus.self), "response is not valid JSON")
  }
}
