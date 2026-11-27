import PDFKit
import SwiftUI
import UIKit
import XCTest
import os

@testable import AgentInterface

/// Unit tests for the iOS 26/27 UI & ecosystem upgrades: biometric gating, Apple Watch bridge,
/// VisionKit PDF scanning, automation App Intents, deeper Core Spotlight indexing, Home Screen
/// Quick Actions, on-device FoundationModels helpers, and opt-in AlarmKit escalations.
@MainActor final class EcosystemUpgradeTests: XCTestCase {

  // MARK: Helpers

  private func isolatedDefaults() -> UserDefaults {
    let suite = "ecosystem-upgrade-" + UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
    return defaults
  }

  private func temporaryDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("ecosystem-" + UUID().uuidString, isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
  }

  private func sampleBootstrap(pinned: [String] = ["kitchen"], main: String? = nil) throws -> Bootstrap {
    let mainJSON = main.map { #""mainBotId":"\#($0)","# } ?? ""
    let favJSON = pinned.map { #""\#($0)""# }.joined(separator: ",")
    return try JSONDecoder().decode(Bootstrap.self, from: Data("""
      {"user":{"id":"one","name":"One","email":"one@example.test"},"household":[],
       "preferences":{"presentation":"simple","theme":"system",\(mainJSON)"favorites":[\(favJSON)],"sections":[],"followBots":[]},
       "bots":[{"id":"kitchen","name":"Kitchen","model":"m","shared":true,"activity":"waiting"},
               {"id":"ranch","name":"Ranch","model":"m","shared":false,"ownerId":"one","activity":"working"},
               {"id":"garden","name":"Garden","model":"m","shared":true,"activity":"idle"}],
       "capabilities":{},"connection":{"connected":true}}
      """.utf8))
  }

  // MARK: 1. Biometric gating & shared-iPad protection

  private final class FakeBiometrics: BiometricAuthenticating, @unchecked Sendable {
    let lock = NSLock()
    var nextOutcome: BiometricOutcome = .authenticated
    var prompts: [String] = []
    var biometryLabel: String { "Face ID" }
    var biometrySymbol: String { "faceid" }
    var isAvailable: Bool { true }
    func authenticate(reason: String) async -> BiometricOutcome {
      lock.withLock {
        prompts.append(reason)
        return nextOutcome
      }
    }
  }

  func testBiometricGateDefaultsOffRequiresAuthToToggleAndRelocksOnBackgroundOrAccountSwitch() async {
    let defaults = isolatedDefaults()
    let auth = FakeBiometrics()
    let gate = BiometricGate(authenticator: auth, defaults: defaults)

    // Default is off per account scope.
    XCTAssertFalse(gate.isEnabled(for: "scope-a"))
    XCTAssertTrue(gate.isVaultUnlocked(for: "scope-a"))

    // Cancelled enable leaves protection off.
    auth.nextOutcome = .cancelled
    let cancelledEnable = await gate.setEnabled(true, for: "scope-a")
    XCTAssertEqual(cancelledEnable, .cancelled)
    XCTAssertFalse(gate.isEnabled(for: "scope-a"))

    // Successful enable turns it on for scope-a only (shared-iPad isolation).
    auth.nextOutcome = .authenticated
    let enabled = await gate.setEnabled(true, for: "scope-a")
    XCTAssertEqual(enabled, .authenticated)
    XCTAssertTrue(gate.isEnabled(for: "scope-a"))
    XCTAssertFalse(gate.isEnabled(for: "scope-b"))
    XCTAssertFalse(gate.isVaultUnlocked(for: "scope-a"))

    // Unlocking Vault succeeds and caches for scope-a while foregrounded.
    let promptsBefore = auth.lock.withLock { auth.prompts.count }
    let firstUnlock = await gate.verify(reason: "Unlock vault", scope: "scope-a")
    XCTAssertEqual(firstUnlock, .authenticated)
    XCTAssertTrue(gate.isVaultUnlocked(for: "scope-a"))
    XCTAssertEqual(auth.lock.withLock { auth.prompts.count }, promptsBefore + 1)

    // Re-verifying non-fresh reuses foreground grant for the same scope.
    let reused = await gate.verify(reason: "Unlock vault", scope: "scope-a", requireFresh: false)
    XCTAssertEqual(reused, .authenticated)
    XCTAssertEqual(auth.lock.withLock { auth.prompts.count }, promptsBefore + 1)

    // Sensitive prompts (`vault.unlock_prompt`, high-risk approvals) require fresh verification even while unlocked.
    let fresh = await gate.verify(reason: "Unlock 1Password", scope: "scope-a", requireFresh: true)
    XCTAssertEqual(fresh, .authenticated)
    XCTAssertEqual(auth.lock.withLock { auth.prompts.count }, promptsBefore + 2)

    // Backgrounding or switching accounts immediately locks the vault.
    gate.lock()
    XCTAssertFalse(gate.isVaultUnlocked(for: "scope-a"))

    // Turning protection OFF requires authentication (prevents shared-iPad bypass).
    auth.nextOutcome = .failed("Face not recognized")
    let failedDisable = await gate.setEnabled(false, for: "scope-a")
    XCTAssertEqual(failedDisable, .failed("Face not recognized"))
    XCTAssertTrue(gate.isEnabled(for: "scope-a"))

    auth.nextOutcome = .authenticated
    let disabled = await gate.setEnabled(false, for: "scope-a")
    XCTAssertEqual(disabled, .authenticated)
    XCTAssertFalse(gate.isEnabled(for: "scope-a"))
  }

  func testSensitiveApprovalClassifierGatesHighRiskApprovalsAndNeverGatesDeclines() {
    let benign = Approval(id: "a1", title: "List files", detail: "Read project directory", status: "pending", command: "ls -la")
    XCTAssertFalse(BiometricGate.isSensitiveApproval(benign, decision: "approved", scope: nil))
    XCTAssertTrue(BiometricGate.isSensitiveApproval(benign, decision: "approved", scope: "always"))
    XCTAssertTrue(BiometricGate.isSensitiveApproval(benign, decision: "approved", scope: "session"))
    XCTAssertFalse(BiometricGate.isSensitiveApproval(benign, decision: "denied", scope: "always"))

    let dangerousCmd = Approval(id: "a2", title: "Run shell", detail: "Clean directory", status: "pending", command: "rm -rf /tmp/build")
    XCTAssertTrue(BiometricGate.isSensitiveApproval(dangerousCmd, decision: "approved", scope: nil))
    XCTAssertFalse(BiometricGate.isSensitiveApproval(dangerousCmd, decision: "denied", scope: nil))

    let flaggedPattern = Approval(id: "a3", title: "Run script", detail: "Deploy", status: "pending", patterns: ["network write"])
    XCTAssertTrue(BiometricGate.isSensitiveApproval(flaggedPattern, decision: "approved", scope: nil))

    let sensitiveKeyword = Approval(id: "a4", title: "Rotate production credential", detail: "Updates secret", status: "pending")
    XCTAssertTrue(BiometricGate.isSensitiveApproval(sensitiveKeyword, decision: "approved", scope: nil))
  }

  // MARK: 2. Apple Watch Companion Bridge

  @MainActor private final class FakeWatchTransport: WatchTransport {
    var isSupported = true
    var contexts: [[String: Any]] = []
    var handler: (@MainActor ([String: Any]) async -> [String: Any])?
    func activate(delegate: @escaping @MainActor ([String: Any]) async -> [String: Any]) { handler = delegate }
    func updateApplicationContext(_ context: [String: Any]) { contexts.append(context) }
  }

  func testWatchBridgeSyncsNonSecretSnapshotEnforcesScopeQueuesDraftsAndClearsOnSignOut() async throws {
    let transport = FakeWatchTransport()
    let bridge = WatchBridge(transport: transport)
    let store = AppStore()
    store.widgetSnapshotURL = nil
    store.api = APIClient(baseURL: URL(string: "https://watch.invalid")!)
    store.bootstrap = try sampleBootstrap()
    let scope = try XCTUnwrap(store.scope)
    bridge.store = store

    var performedActions: [ActivityAction] = []
    var openedURLs: [URL] = []
    bridge.actHandler = { performedActions.append($0) }
    bridge.openHandler = { openedURLs.append($0) }
    bridge.start()

    // Snapshot sync carries only WidgetSnapshot data (never tokens).
    let snap = WidgetSnapshot(scope: scope, generatedAt: Date(), assistants: [
      .init(id: "kitchen", name: "Kitchen", activity: "waiting", lastMessage: nil, lastMessageAt: nil, color: nil, pinned: true, approvalId: "ap-1"),
    ])
    bridge.sync(snap)
    XCTAssertEqual(transport.contexts.last?[WatchPayload.signedOutKey] as? Bool, false)
    let encodedSnap = try XCTUnwrap(transport.contexts.last?[WatchPayload.snapshotKey] as? Data)
    XCTAssertEqual(try JSONDecoder().decode(WidgetSnapshot.self, from: encodedSnap), snap)

    // Action for wrong account scope is rejected and clears Watch state.
    let wrongAction = WatchAction(scope: "other-account", kind: .stop(botId: "ranch", name: "Ranch"))
    let rejected = await bridge.handle(rawMessage: [WatchPayload.actionKey: try JSONEncoder().encode(wrongAction)])
    XCTAssertEqual(rejected["ok"] as? Bool, false)
    XCTAssertEqual(transport.contexts.last?[WatchPayload.signedOutKey] as? Bool, true)
    XCTAssertTrue(performedActions.isEmpty)

    // Decline, Stop, and Review route to the app's handlers.
    let declineAction = WatchAction(scope: scope, kind: .decline(botId: "kitchen", name: "Kitchen", approvalId: "ap-1"))
    let declined = await bridge.handle(rawMessage: [WatchPayload.actionKey: try JSONEncoder().encode(declineAction)])
    XCTAssertEqual(declined["ok"] as? Bool, true)

    let stopAction = WatchAction(scope: scope, kind: .stop(botId: "ranch", name: "Ranch"))
    let stopped = await bridge.handle(rawMessage: [WatchPayload.actionKey: try JSONEncoder().encode(stopAction)])
    XCTAssertEqual(stopped["ok"] as? Bool, true)

    let reviewAction = WatchAction(scope: scope, kind: .review(botId: "kitchen"))
    let reviewed = await bridge.handle(rawMessage: [WatchPayload.actionKey: try JSONEncoder().encode(reviewAction)])
    XCTAssertEqual(reviewed["ok"] as? Bool, true)

    XCTAssertEqual(performedActions, [
      ActivityAction(kind: .decline(approvalId: "ap-1"), botId: "kitchen", scope: scope, name: "Kitchen"),
      ActivityAction(kind: .stop, botId: "ranch", scope: scope, name: "Ranch"),
    ])
    XCTAssertEqual(openedURLs, [DeepLink.bot("kitchen")])

    // Wrist dictation queues a draft addition for review on iPhone, never sending automatically.
    store.selectedBotId = "kitchen"
    store.draft = Draft(text: "Milk", attachments: [], dirty: true)
    store.draftReady = true
    let dictate = WatchAction(scope: scope, kind: .queueDraft(botId: "kitchen", text: "Pick up eggs too"))
    let queued = await bridge.handle(rawMessage: [WatchPayload.actionKey: try JSONEncoder().encode(dictate)])
    XCTAssertEqual(queued["ok"] as? Bool, true)
    await store.deliverAdditions()
    XCTAssertEqual(store.draft.text, "Milk\n\nPick up eggs too")
    XCTAssertFalse(store.sending)

    // Empty draft and unknown bot are rejected.
    let emptyDictate = WatchAction(scope: scope, kind: .queueDraft(botId: "kitchen", text: "   "))
    let emptyReply = await bridge.handle(rawMessage: [WatchPayload.actionKey: try JSONEncoder().encode(emptyDictate)])
    XCTAssertEqual(emptyReply["ok"] as? Bool, false)
    let unknownBot = WatchAction(scope: scope, kind: .queueDraft(botId: "ghost", text: "Hi"))
    let unknownReply = await bridge.handle(rawMessage: [WatchPayload.actionKey: try JSONEncoder().encode(unknownBot)])
    XCTAssertEqual(unknownReply["ok"] as? Bool, false)

    // Sign-out wipes Watch state.
    bridge.sync(nil)
    XCTAssertEqual(transport.contexts.last?[WatchPayload.signedOutKey] as? Bool, true)
    store.suspend()
  }

  // MARK: 3. VisionKit Document Scanner PDF builder

  func testScannedDocumentPDFBuildsValidMultiPagePDFAndEnforcesBounds() throws {
    XCTAssertThrowsError(try ScannedDocumentPDF.build(images: [])) { error in
      XCTAssertEqual(error as? ScannedDocumentPDF.BuildError, .empty)
    }

    func solidImage(_ color: UIColor) -> UIImage {
      UIGraphicsImageRenderer(size: CGSize(width: 200, height: 260)).image { ctx in
        color.setFill()
        ctx.fill(CGRect(x: 0, y: 0, width: 200, height: 260))
      }
    }
    let pdfData = try ScannedDocumentPDF.build(images: [solidImage(.white), solidImage(.systemTeal)])
    let document = try XCTUnwrap(PDFDocument(data: pdfData))
    XCTAssertEqual(document.pageCount, 2)

    // Rejects scans that cannot fit inside an artificially tiny byte limit.
    XCTAssertThrowsError(try ScannedDocumentPDF.build(images: [solidImage(.white)], maxBytes: 10)) { error in
      XCTAssertEqual(error as? ScannedDocumentPDF.BuildError, .tooLarge)
    }

    let filename = ScannedDocumentPDF.filename(at: Date(timeIntervalSince1970: 1_800_000_000))
    XCTAssertTrue(filename.hasPrefix("Scan "))
    XCTAssertTrue(filename.hasSuffix(".pdf"))
  }

  // MARK: 4. Automation App Intents (TryOnceIntent & SendAssistantMessageIntent)

  func testTryOnceIntentRunsRoutineWithIdempotentRequestIdAndRejectsInvalidStates() async throws {
    let dir = temporaryDirectory()
    let routinesURL = dir.appendingPathComponent("routines.json")
    RoutineEntityQuery.snapshotURL = routinesURL
    addTeardownBlock { RoutineEntityQuery.snapshotURL = RoutineSnapshotStore.defaultURL }

    let routineSnap = RoutineSnapshot(scope: "scope-1", updatedAt: Date(), routines: [
      .init(id: "r-morning", botId: "kitchen", botName: "Kitchen", name: "Morning brief", enabled: true),
    ])
    RoutineSnapshotStore.write(routineSnap, to: routinesURL)
    let queried = try await RoutineEntityQuery().suggestedEntities()
    XCTAssertEqual(queried.map(\.id), ["r-morning"])

    let server = FakeServer { _ in
      .init(body: #"{"requestId":"req-1","routineId":"r-morning","botId":"kitchen","status":"accepted","message":"Started","startedAt":"2026-11-27T08:00:00Z"}"#)
    }
    let client = server.api(token: "tok")

    // Rejects mismatched scope or missing routine.
    do {
      _ = try await TryOnceIntent.execute(routineId: "r-morning", routineName: "Morning brief", snapshot: routineSnap, signedInScope: "scope-2", client: client)
      XCTFail("Expected signedOut")
    } catch let error as AssistantIntentError {
      XCTAssertEqual(String(describing: error), String(describing: AssistantIntentError.signedOut))
    }
    do {
      _ = try await TryOnceIntent.execute(routineId: "missing", routineName: "Missing", snapshot: routineSnap, signedInScope: "scope-1", client: client)
      XCTFail("Expected missing")
    } catch let error as AssistantIntentError {
      XCTAssertEqual(String(describing: error), String(describing: AssistantIntentError.missing))
    }

    // Valid run posts to /api/routines/r-morning/run with a requestId.
    let dialog = try await TryOnceIntent.execute(routineId: "r-morning", routineName: "Morning brief", snapshot: routineSnap, signedInScope: "scope-1", client: client)
    XCTAssertEqual(dialog, "Started Morning brief.")
    XCTAssertEqual(server.lastRequest?.url?.path, "/api/routines/r-morning/run")

    // Sign-out clears RoutineSnapshotStore.
    RoutineSnapshotStore.write(nil, to: routinesURL)
    let afterSignOut = try await RoutineEntityQuery().suggestedEntities()
    XCTAssertEqual(afterSignOut, [])
  }

  func testSendAssistantMessageIntentEnforcesOptInLengthAndRateLimit() async throws {
    let defaults = isolatedDefaults()
    ShortcutSendPolicy.resetCooldowns()
    addTeardownBlock { @MainActor in ShortcutSendPolicy.resetCooldowns() }

    let snap = WidgetSnapshot(scope: "scope-1", generatedAt: Date(), assistants: [
      .init(id: "kitchen", name: "Kitchen", activity: "idle", lastMessage: nil, lastMessageAt: nil, color: nil, pinned: true),
    ])
    let server = FakeServer { _ in
      .init(body: #"{"requestId":"r1","status":"accepted","turn":"started"}"#)
    }
    let client = server.api(token: "tok")

    // Disabled by default.
    do {
      _ = try await SendAssistantMessageIntent.execute(
        botId: "kitchen", assistantName: "Kitchen", message: "Start coffee",
        snapshot: snap, signedInScope: "scope-1", client: client, defaults: defaults
      )
      XCTFail("Expected sendDisabled by default")
    } catch let error as AssistantIntentError {
      XCTAssertEqual(String(describing: error), String(describing: AssistantIntentError.sendDisabled))
    }
    XCTAssertNil(server.lastRequest)

    // Enable opt-in for scope-1.
    ShortcutSendPolicy.setEnabled(true, for: "scope-1", defaults: defaults)

    // Rejects overly long messages (> 4,000 chars).
    let longText = String(repeating: "a", count: ShortcutSendPolicy.maxMessageLength + 1)
    do {
      _ = try await SendAssistantMessageIntent.execute(
        botId: "kitchen", assistantName: "Kitchen", message: longText,
        snapshot: snap, signedInScope: "scope-1", client: client, defaults: defaults
      )
      XCTFail("Expected sendTooLong")
    } catch let error as AssistantIntentError {
      XCTAssertEqual(String(describing: error), String(describing: AssistantIntentError.sendTooLong))
    }

    // Valid send succeeds.
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    let ok = try await SendAssistantMessageIntent.execute(
      botId: "kitchen", assistantName: "Kitchen", message: "Check grocery list",
      snapshot: snap, signedInScope: "scope-1", client: client, defaults: defaults, now: t0
    )
    XCTAssertEqual(ok, "Sent to Kitchen.")
    XCTAssertEqual(server.lastRequest?.url?.path, "/api/bots/kitchen/messages")

    // Immediate second send hits cooldown rate limit.
    do {
      _ = try await SendAssistantMessageIntent.execute(
        botId: "kitchen", assistantName: "Kitchen", message: "Again",
        snapshot: snap, signedInScope: "scope-1", client: client, defaults: defaults, now: t0.addingTimeInterval(2)
      )
      XCTFail("Expected rateLimited")
    } catch let error as AssistantIntentError {
      XCTAssertEqual(String(describing: error), String(describing: AssistantIntentError.rateLimited))
    }

    // After cooldown passes, send works again.
    let okAfter = try await SendAssistantMessageIntent.execute(
      botId: "kitchen", assistantName: "Kitchen", message: "After cooldown",
      snapshot: snap, signedInScope: "scope-1", client: client, defaults: defaults, now: t0.addingTimeInterval(6)
    )
    XCTAssertEqual(okAfter, "Sent to Kitchen.")
  }

  // MARK: 5. Deeper Spotlight Indexing

  private final class RecordingSpotlight: SpotlightIndexing {
    var indexed: [[SpotlightRecord]] = []
    var deleted: [[String]] = []
    var deleteAllCount = 0
    func index(_ records: [SpotlightRecord]) { indexed.append(records) }
    func delete(ids: [String]) { deleted.append(ids) }
    func deleteAll() { deleteAllCount += 1 }
  }

  func testSpotlightIndexesGroupsRoutinesAndSavedTitlesOnlyAndClearsAllOnSignOutOrSwitch() {
    let defaults = isolatedDefaults()
    let index = RecordingSpotlight()
    let spotlight = AssistantSpotlight(index: index, defaults: defaults)

    let room = GroupRoom(room_id: "room-1", name: "Family Planning", members: [])
    let routine = Routine.empty(botId: "kitchen").with(id: "rt-1", name: "Morning Brief")
    let saved = SavedItem(id: "sv-1", botId: "kitchen", kind: "session", sessionId: "s1", routineId: nil, resultId: nil, messageId: "m1", offset: 0, title: "Chili Recipe", createdAt: "2026-11-27T00:00:00Z")

    XCTAssertTrue(spotlight.syncGroups([room], scope: "scope-1"))
    XCTAssertTrue(spotlight.syncRoutines([routine], scope: "scope-1"))
    XCTAssertTrue(spotlight.syncSaved([saved], scope: "scope-1"))
    XCTAssertEqual(index.indexed.flatMap { $0 }, [
      SpotlightRecord(id: "group:room-1", title: "Family Planning", kind: .group),
      SpotlightRecord(id: "routine:kitchen:rt-1", title: "Morning Brief", kind: .routine),
      SpotlightRecord(id: "saved:sv-1", title: "Chili Recipe", kind: .saved),
    ])

    // Deep link mapping works for every category.
    XCTAssertEqual(AssistantSpotlight.deepLink(for: "kitchen"), DeepLink.bot("kitchen"))
    XCTAssertEqual(AssistantSpotlight.deepLink(for: "group:room-1"), DeepLink.group("room-1"))
    XCTAssertEqual(AssistantSpotlight.deepLink(for: "routine:kitchen:rt-1"), DeepLink.routine(botId: "kitchen", routineId: "rt-1"))
    XCTAssertEqual(AssistantSpotlight.deepLink(for: "saved:sv-1"), DeepLink.saved)

    // Removing a saved item deletes only that item.
    XCTAssertTrue(spotlight.syncSaved([], scope: "scope-1"))
    XCTAssertEqual(index.deleted.last, ["saved:sv-1"])

    // Sign-out clears the entire domain.
    XCTAssertTrue(spotlight.sync(nil))
    XCTAssertEqual(index.deleteAllCount, 1)
    XCTAssertFalse(spotlight.sync(nil))
  }

  // MARK: 6. Home Screen Quick Actions

  func testQuickActionsPreferMainThenPinnedAndMapToDeepLinks() throws {
    let signedOut = QuickActions.items(for: nil)
    XCTAssertEqual(signedOut.map(\.type), [QuickActions.todayType, QuickActions.searchType])

    let pinnedOnly = try sampleBootstrap(pinned: ["kitchen"], main: nil)
    let pinnedItems = QuickActions.items(for: pinnedOnly)
    XCTAssertEqual(pinnedItems.count, 3)
    XCTAssertEqual(pinnedItems[2].localizedTitle, "Talk to Kitchen")
    XCTAssertEqual(QuickActions.url(for: pinnedItems[0]), DeepLink.today)
    XCTAssertEqual(QuickActions.url(for: pinnedItems[1]), DeepLink.search)
    XCTAssertEqual(QuickActions.url(for: pinnedItems[2]), DeepLink.bot("kitchen", listen: true))

    let withMain = try sampleBootstrap(pinned: ["kitchen"], main: "ranch")
    let mainItems = QuickActions.items(for: withMain)
    XCTAssertEqual(mainItems[2].localizedTitle, "Talk to Ranch")
    XCTAssertEqual(QuickActions.url(for: mainItems[2]), DeepLink.bot("ranch", listen: true))

    let unknown = UIApplicationShortcutItem(type: "dev.agentinterface.ios.quick.unknown", localizedTitle: "Other")
    XCTAssertNil(QuickActions.url(for: unknown))
  }

  // MARK: 7. On-Device FoundationModels Helpers

  func testOnDeviceIntelligenceHelpersPolishSuggestSummarizeAndFallbackGracefully() async {
    // Voice transcript polish succeeds and rejects runaway hallucinations.
    let polished = await OnDeviceIntelligence.polishTranscript("check the north gate tomorrow") { _, _ in
      "Check the north gate tomorrow."
    }
    XCTAssertEqual(polished, "Check the north gate tomorrow.")

    let runaway = await OnDeviceIntelligence.polishTranscript("hi") { _, _ in
      String(repeating: "very long hallucination ", count: 20)
    }
    XCTAssertEqual(runaway, "hi")

    let unavailable = await OnDeviceIntelligence.polishTranscript("raw words") { _, _ in nil }
    XCTAssertEqual(unavailable, "raw words")

    // Reference title strips quotes and respects 80-char limit; skips short text.
    let shortRef = await OnDeviceIntelligence.suggestReferenceTitle(for: "Too short") { _, _ in "Should not run" }
    XCTAssertNil(shortRef)

    let refTitle = await OnDeviceIntelligence.suggestReferenceTitle(for: "Here is a detailed comparison of ranch solar inverter battery backups for winter.") { _, _ in
      "\"Winter Solar Inverter Comparison\""
    }
    XCTAssertEqual(refTitle, "Winter Solar Inverter Comparison")

    // Group title requires 2+ members.
    let singleMember = await OnDeviceIntelligence.suggestGroupTitle(members: ["Kitchen"]) { _, _ in "Solo" }
    XCTAssertNil(singleMember)
    let groupTitle = await OnDeviceIntelligence.suggestGroupTitle(members: ["Kitchen", "Ranch"]) { _, _ in "Household Ops" }
    XCTAssertEqual(groupTitle, "Household Ops")

    // Share snippet summarization requires >=240 chars and rejects expansions.
    let longShare = String(repeating: "This is a long article paragraph about pasture irrigation schedules. ", count: 6)
    let summary = await OnDeviceIntelligence.summarizeSharedSnippet(longShare) { _, _ in
      "Summary of pasture irrigation schedules."
    }
    XCTAssertEqual(summary, "Summary of pasture irrigation schedules.")

    let expanded = await OnDeviceIntelligence.summarizeSharedSnippet(longShare) { _, _ in
      longShare + " extra"
    }
    XCTAssertNil(expanded)
  }

  // MARK: 8. Opt-In AlarmKit Escalation

  @MainActor private final class FakeAlarmBackend: CriticalAlarmBackend {
    var isSupported = true
    var authState: CriticalAlarmAuthorization = .notDetermined
    var nextAuthResult: CriticalAlarmAuthorization = .authorized
    var scheduled: [CriticalAlarmRequest] = []
    var cancelled: [UUID] = []
    func authorizationState() -> CriticalAlarmAuthorization { authState }
    func requestAuthorization() async -> CriticalAlarmAuthorization {
      authState = nextAuthResult
      return authState
    }
    func schedule(_ request: CriticalAlarmRequest) async throws { scheduled.append(request) }
    func cancel(id: UUID) { cancelled.append(id) }
  }

  func testCriticalAlarmsAreStrictlyOptInDeduplicatedAndCancelledOnSignOut() async {
    let defaults = isolatedDefaults()
    let backend = FakeAlarmBackend()
    let manager = CriticalAlarmManager(backend: backend, defaults: defaults)

    // Never enabled by default.
    XCTAssertFalse(manager.isEnabled(for: "scope-1"))
    let skipped = await manager.escalateWaitingIfOptedIn(
      botId: "kitchen", botName: "Kitchen", reason: "Needs approval", dedupKey: "ap-1", scope: "scope-1"
    )
    XCTAssertFalse(skipped)
    XCTAssertTrue(backend.scheduled.isEmpty)

    // Denied authorization keeps master switch off.
    backend.nextAuthResult = .denied
    _ = await manager.setEnabled(true, for: "scope-1")
    XCTAssertFalse(manager.isEnabled(for: "scope-1"))

    // Grant authorization -> master on, but still requires per-assistant opt-in.
    backend.nextAuthResult = .authorized
    _ = await manager.setEnabled(true, for: "scope-1")
    XCTAssertTrue(manager.isEnabled(for: "scope-1"))
    let notOptedBot = await manager.escalateWaitingIfOptedIn(
      botId: "kitchen", botName: "Kitchen", reason: "Needs approval", dedupKey: "ap-1", scope: "scope-1"
    )
    XCTAssertFalse(notOptedBot)

    // Opt in Kitchen -> escalates once, then deduplicates.
    manager.setBotWaitingEnabled(true, botId: "kitchen", for: "scope-1")
    let escalated = await manager.escalateWaitingIfOptedIn(
      botId: "kitchen", botName: "Kitchen", reason: "Needs approval", dedupKey: "ap-1", scope: "scope-1"
    )
    XCTAssertTrue(escalated)
    XCTAssertEqual(backend.scheduled.count, 1)
    let duplicate = await manager.escalateWaitingIfOptedIn(
      botId: "kitchen", botName: "Kitchen", reason: "Needs approval", dedupKey: "ap-1", scope: "scope-1"
    )
    XCTAssertFalse(duplicate)
    XCTAssertEqual(backend.scheduled.count, 1)

    // Routine alarm schedules only when opted in and enabled.
    let future = Date().addingTimeInterval(600)
    var routine = Routine.empty(botId: "kitchen").with(id: "rt-1", name: "Water check")
    routine.nextRunAt = ServerDate.string(future)
    let routineNotOpted = await manager.scheduleRoutineAlarmIfOptedIn(routine: routine, scope: "scope-1")
    XCTAssertFalse(routineNotOpted)

    manager.setRoutineEnabled(true, routineId: "rt-1", for: "scope-1")
    let routineScheduled = await manager.scheduleRoutineAlarmIfOptedIn(routine: routine, scope: "scope-1")
    XCTAssertTrue(routineScheduled)
    XCTAssertEqual(backend.scheduled.count, 2)

    // Sign-out cancels every scheduled alarm.
    let ids = Set(backend.scheduled.map(\.id))
    manager.cancelAll()
    XCTAssertEqual(Set(backend.cancelled), ids)
  }

  // MARK: 9. Interactive Widget Refresh & Approval ID Backwards Compatibility

  func testWidgetSnapshotDecodesWithAndWithoutApprovalIdAndRefreshIntentCallsHandler() async throws {
    let legacyJSON = #"{"scope":"a","generatedAt":0,"assistants":[{"id":"k","name":"Kitchen","activity":"waiting","pinned":true}]}"#
    let legacy = try JSONDecoder().decode(WidgetSnapshot.self, from: Data(legacyJSON.utf8))
    XCTAssertNil(legacy.assistants[0].approvalId)

    let withApproval = WidgetSnapshot(scope: "a", generatedAt: Date(), assistants: [
      .init(id: "k", name: "Kitchen", activity: "waiting", lastMessage: nil, lastMessageAt: nil, color: nil, pinned: true, approvalId: "ap-9"),
    ])
    let roundTrip = try JSONDecoder().decode(WidgetSnapshot.self, from: JSONEncoder().encode(withApproval))
    XCTAssertEqual(roundTrip.assistants[0].approvalId, "ap-9")

    let previous = ActivityActions.refreshHandler
    defer { ActivityActions.refreshHandler = previous }
    var refreshed = false
    ActivityActions.refreshHandler = { refreshed = true }
    _ = try await RefreshWidgetsIntent().perform()
    XCTAssertTrue(refreshed)
  }
}

private extension Routine {
  func with(id: String, name: String) -> Routine {
    var copy = self
    copy.id = id
    copy.name = name
    return copy
  }
}
