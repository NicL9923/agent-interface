import PDFKit
import SwiftUI
import UIKit
import XCTest
import os

@testable import AgentInterface

/// Unit tests for the iOS 26/27 UI & ecosystem upgrades: biometric gating (including suspended
/// auth races), Apple Watch bridge (dedup, late-refresh rejection, honest outcomes, runId Stop),
/// VisionKit PDF scanning, scoped automation App Intents, completion-driven Core Spotlight,
/// Home Screen Quick Actions, word-preserving FoundationModels helpers, secondary chat idempotency,
/// and durable opt-in AlarmKit escalations.
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

  // MARK: 1. Biometric gating, suspended relock race & fail-closed approvals

  private final class FakeBiometrics: BiometricAuthenticating, @unchecked Sendable {
    let lock = NSLock()
    var nextOutcome: BiometricOutcome = .authenticated
    var prompts: [String] = []
    var holdNext = false
    private var continuation: CheckedContinuation<BiometricOutcome, Never>?
    var biometryLabel: String { "Face ID" }
    var biometrySymbol: String { "faceid" }
    var isAvailable: Bool { true }
    func authenticate(reason: String) async -> BiometricOutcome {
      let shouldHold = lock.withLock { () -> Bool in
        prompts.append(reason)
        if holdNext {
          holdNext = false
          return true
        }
        return false
      }
      if shouldHold {
        return await withCheckedContinuation { cont in
          lock.withLock { continuation = cont }
        }
      }
      return lock.withLock { nextOutcome }
    }
    func resumeHeld(with outcome: BiometricOutcome) {
      let cont = lock.withLock { () -> CheckedContinuation<BiometricOutcome, Never>? in
        let c = continuation
        continuation = nil
        return c
      }
      cont?.resume(returning: outcome)
    }
    var isHolding: Bool { lock.withLock { continuation != nil } }
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

    // Sensitive prompts (`vault.unlock_prompt`, approvals) require fresh verification even while unlocked.
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

  func testPendingBiometricResultCannotUndoRelockForVaultOrFreshVerification() async throws {
    let defaults = isolatedDefaults()
    let auth = FakeBiometrics()
    let gate = BiometricGate(authenticator: auth, defaults: defaults)
    _ = await gate.setEnabled(true, for: "scope-a")

    // Start Vault unlock, then lock() while Face ID is still pending.
    auth.holdNext = true
    let pendingVault = Task { await gate.verify(reason: "Unlock vault", scope: "scope-a", requireFresh: false) }
    try await until { auth.isHolding }
    gate.lock()
    auth.resumeHeld(with: .authenticated)
    let vaultOutcome = await pendingVault.value
    XCTAssertEqual(vaultOutcome, .cancelled)
    XCTAssertFalse(gate.isVaultUnlocked(for: "scope-a"), "A late auth success must never undo relock")

    // Same for fresh verification (approval / vault.unlock_prompt).
    auth.holdNext = true
    let pendingFresh = Task { await gate.verify(reason: "Approve", scope: "scope-a", requireFresh: true) }
    try await until { auth.isHolding }
    gate.lock()
    auth.resumeHeld(with: .authenticated)
    let freshOutcome = await pendingFresh.value
    XCTAssertEqual(freshOutcome, .cancelled)
  }

  func testSensitiveApprovalClassifierFailsClosedForAllApprovalsAndNeverGatesDeclines() {
    let redirection = Approval(id: "a1", title: "Run shell", detail: "Write config", status: "pending", command: "echo key > ~/.ssh/authorized_keys")
    XCTAssertTrue(BiometricGate.isSensitiveApproval(redirection, decision: "approved", scope: nil))
    XCTAssertTrue(BiometricGate.isSensitiveApproval(redirection, decision: "approved", scope: "always"))
    XCTAssertTrue(BiometricGate.isSensitiveApproval(redirection, decision: "approved", scope: "session"))
    XCTAssertFalse(BiometricGate.isSensitiveApproval(redirection, decision: "denied", scope: "always"))
    XCTAssertFalse(BiometricGate.isSensitiveApproval(redirection, decision: "denied", scope: nil))
  }

  // MARK: 2. Apple Watch Companion Bridge

  @MainActor private final class FakeWatchTransport: WatchTransport {
    var isSupported = true
    var contexts: [[String: Any]] = []
    var handler: (@MainActor ([String: Any]) async -> [String: Any])?
    func activate(delegate: @escaping @MainActor ([String: Any]) async -> [String: Any]) { handler = delegate }
    func updateApplicationContext(_ context: [String: Any]) { contexts.append(context) }
  }

  func testWatchBridgeSyncsNonSecretSnapshotDeduplicatesActionsReportsHonestOutcomesAndRejectsLateRefresh() async throws {
    let defaults = isolatedDefaults()
    let transport = FakeWatchTransport()
    let bridge = WatchBridge(transport: transport, defaults: defaults)
    let store = AppStore()
    store.widgetSnapshotURL = nil
    store.api = APIClient(baseURL: URL(string: "https://watch.invalid")!)
    store.bootstrap = try sampleBootstrap()
    let scope = try XCTUnwrap(store.scope)
    bridge.store = store

    var performedActions: [ActivityAction] = []
    var openedURLs: [URL] = []
    var reviewNotified: [String] = []
    var nextActionResult = ActivityActionResult(ok: true, message: "Done.")
    bridge.actHandler = { action in
      performedActions.append(action)
      return nextActionResult
    }
    bridge.openHandler = { openedURLs.append($0) }
    bridge.notifyReview = { reviewNotified.append($0) }
    bridge.isForegroundActive = { false }
    bridge.start()

    // Snapshot sync carries only WidgetSnapshot data (never tokens).
    let snap = WidgetSnapshot(scope: scope, generatedAt: Date(), assistants: [
      .init(id: "kitchen", name: "Kitchen", activity: "waiting", lastMessage: nil, lastMessageAt: nil, color: nil, pinned: true, approvalId: "ap-1"),
      .init(id: "ranch", name: "Ranch", activity: "working", lastMessage: nil, lastMessageAt: nil, color: nil, pinned: false, runId: "run-42"),
    ])
    bridge.sync(snap)
    XCTAssertEqual(transport.contexts.last?[WatchPayload.signedOutKey] as? Bool, false)
    let encodedSnap = try XCTUnwrap(transport.contexts.last?[WatchPayload.snapshotKey] as? Data)
    XCTAssertEqual(try JSONDecoder().decode(WidgetSnapshot.self, from: encodedSnap), snap)

    // Action for wrong account scope is rejected and clears Watch state.
    let wrongAction = WatchAction(scope: "other-account", kind: .stop(botId: "ranch", name: "Ranch", runId: "run-42"))
    let rejected = await bridge.handle(rawMessage: [WatchPayload.actionKey: try JSONEncoder().encode(wrongAction)])
    XCTAssertEqual(rejected["ok"] as? Bool, false)
    XCTAssertEqual(transport.contexts.last?[WatchPayload.signedOutKey] as? Bool, true)
    XCTAssertTrue(performedActions.isEmpty)

    // Stop without a runId is refused so Watch can never abort a newer run.
    let emptyRunStop = WatchAction(scope: scope, kind: .stop(botId: "ranch", name: "Ranch", runId: ""))
    let emptyRunReply = await bridge.handle(rawMessage: [WatchPayload.actionKey: try JSONEncoder().encode(emptyRunStop)])
    XCTAssertEqual(emptyRunReply["ok"] as? Bool, false)
    XCTAssertTrue(performedActions.isEmpty)

    // Decline refusal reports actual failure honestly to Watch.
    nextActionResult = ActivityActionResult(ok: false, message: "Approval already settled.")
    let declineAction = WatchAction(scope: scope, kind: .decline(botId: "kitchen", name: "Kitchen", approvalId: "ap-1"))
    let declined = await bridge.handle(rawMessage: [WatchPayload.actionKey: try JSONEncoder().encode(declineAction)])
    XCTAssertEqual(declined["ok"] as? Bool, false)
    XCTAssertEqual(declined["error"] as? String, "Approval already settled.")

    // Stop forwards runId and reports success.
    nextActionResult = ActivityActionResult(ok: true, message: "Stop requested for Ranch.")
    let stopAction = WatchAction(scope: scope, kind: .stop(botId: "ranch", name: "Ranch", runId: "run-42"))
    let stopped = await bridge.handle(rawMessage: [WatchPayload.actionKey: try JSONEncoder().encode(stopAction)])
    XCTAssertEqual(stopped["ok"] as? Bool, true)
    XCTAssertEqual(performedActions.last, ActivityAction(kind: .stop, botId: "ranch", scope: scope, name: "Ranch", runId: "run-42"))

    // Background Review does not claim iPhone opened on screen; it posts a local notification instead.
    let reviewAction = WatchAction(scope: scope, kind: .review(botId: "kitchen"))
    let reviewed = await bridge.handle(rawMessage: [WatchPayload.actionKey: try JSONEncoder().encode(reviewAction)])
    XCTAssertEqual(reviewed["ok"] as? Bool, true)
    XCTAssertEqual(reviewed["message"] as? String, "Open WildBots on iPhone to review.")
    XCTAssertEqual(openedURLs, [DeepLink.bot("kitchen")])
    XCTAssertEqual(reviewNotified, ["kitchen"])

    // Wrist dictation queues a draft once; a retried transferUserInfo with the SAME WatchAction.id deduplicates!
    store.selectedBotId = "kitchen"
    store.draft = Draft(text: "Milk", attachments: [], dirty: true)
    store.draftReady = true
    let dictate = WatchAction(scope: scope, kind: .queueDraft(botId: "kitchen", text: "Pick up eggs too"))
    let encodedDictate = try JSONEncoder().encode(dictate)
    let firstQueue = await bridge.handle(rawMessage: [WatchPayload.actionKey: encodedDictate])
    let retryQueue = await bridge.handle(rawMessage: [WatchPayload.actionKey: encodedDictate])
    XCTAssertEqual(firstQueue["ok"] as? Bool, true)
    XCTAssertEqual(retryQueue["ok"] as? Bool, true)
    await store.deliverAdditions()
    XCTAssertEqual(store.draft.text, "Milk\n\nPick up eggs too", "Duplicate WatchAction.id must not append twice")
    XCTAssertFalse(store.sending)

    // Empty draft and unknown bot are rejected.
    let emptyDictate = WatchAction(scope: scope, kind: .queueDraft(botId: "kitchen", text: "   "))
    let emptyReply = await bridge.handle(rawMessage: [WatchPayload.actionKey: try JSONEncoder().encode(emptyDictate)])
    XCTAssertEqual(emptyReply["ok"] as? Bool, false)
    let unknownBot = WatchAction(scope: scope, kind: .queueDraft(botId: "ghost", text: "Hi"))
    let unknownReply = await bridge.handle(rawMessage: [WatchPayload.actionKey: try JSONEncoder().encode(unknownBot)])
    XCTAssertEqual(unknownReply["ok"] as? Bool, false)

    // Late refresh reply after sign-out is rejected and never repopulates Watch.
    var refreshContinuation: CheckedContinuation<WidgetSnapshot?, Never>?
    bridge.refreshHandler = {
      await withCheckedContinuation { refreshContinuation = $0 }
    }
    let refreshAction = WatchAction(scope: scope, kind: .refresh)
    let encodedRefresh = try JSONEncoder().encode(refreshAction)
    let refreshTask = Task { () -> (Bool, Bool) in
      let reply = await bridge.handle(rawMessage: [WatchPayload.actionKey: encodedRefresh])
      return (reply["ok"] as? Bool ?? false, reply[WatchPayload.snapshotKey] != nil)
    }
    try await until { refreshContinuation != nil }
    bridge.sync(nil)
    XCTAssertEqual(transport.contexts.last?[WatchPayload.signedOutKey] as? Bool, true)
    refreshContinuation?.resume(returning: snap)
    let (refreshOK, refreshHasSnap) = await refreshTask.value
    XCTAssertFalse(refreshOK)
    XCTAssertFalse(refreshHasSnap)
    XCTAssertEqual(transport.contexts.last?[WatchPayload.signedOutKey] as? Bool, true)
    store.suspend()
  }

  func testStopActionForwardsRunIdToServer() async throws {
    let server = FakeServer { _ in .init(body: #"{"ok":true}"#) }
    let store = AppStore()
    store.widgetSnapshotURL = nil
    store.api = server.api(token: "tok")
    store.bootstrap = try sampleBootstrap()
    let scope = try XCTUnwrap(store.scope)
    let controller = NotificationController()
    controller.store = store
    let result = await controller.performAction(ActivityAction(kind: .stop, botId: "ranch", scope: scope, name: "Ranch", runId: "run-99"))
    XCTAssertTrue(result.ok)
    let decoded = try server.lastJSON()
    XCTAssertEqual(decoded["runId"] as? String, "run-99")
    XCTAssertNotNil(decoded["account"] as? String)
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

    // Rejects scans that exceed max page count or byte limit.
    XCTAssertThrowsError(try ScannedDocumentPDF.build(pageCount: ScannedDocumentPDF.maxPages + 1) { _ in solidImage(.white) }) { error in
      XCTAssertEqual(error as? ScannedDocumentPDF.BuildError, .tooLarge)
    }
    XCTAssertThrowsError(try ScannedDocumentPDF.build(images: [solidImage(.white)], maxBytes: 10)) { error in
      XCTAssertEqual(error as? ScannedDocumentPDF.BuildError, .tooLarge)
    }

    let filename = ScannedDocumentPDF.filename(at: Date(timeIntervalSince1970: 1_800_000_000))
    XCTAssertTrue(filename.hasPrefix("Scan "))
    XCTAssertTrue(filename.hasSuffix(".pdf"))
  }

  // MARK: 4. Scoped Automation App Intents (TryOnceIntent & SendAssistantMessageIntent)

  func testTryOnceIntentUsesScopedEntityIdAndRejectsCrossAccountOrUnscopedParameters() async throws {
    let dir = temporaryDirectory()
    let routinesURL = dir.appendingPathComponent("routines.json")
    RoutineEntityQuery.snapshotURL = routinesURL
    addTeardownBlock { RoutineEntityQuery.snapshotURL = RoutineSnapshotStore.defaultURL }

    let routineSnap = RoutineSnapshot(scope: "scope-1", updatedAt: Date(), routines: [
      .init(id: "r-morning", botId: "kitchen", botName: "Kitchen", name: "Morning brief", enabled: true),
    ])
    RoutineSnapshotStore.write(routineSnap, to: routinesURL)
    let queried = try await RoutineEntityQuery().suggestedEntities()
    XCTAssertEqual(queried.map(\.id), ["scope-1|r-morning"])

    let server = FakeServer { _ in
      .init(body: #"{"requestId":"req-1","routineId":"r-morning","botId":"kitchen","status":"accepted","message":"Started","startedAt":"2026-11-27T08:00:00Z"}"#)
    }
    let client = server.api(token: "tok")

    // Rejects unscoped legacy bare ID, cross-account persisted ID, and missing routine.
    for badId in ["r-morning", "scope-2|r-morning"] {
      do {
        _ = try await TryOnceIntent.execute(scopedRoutineId: badId, routineName: "Morning brief", snapshot: routineSnap, signedInScope: "scope-1", client: client)
        XCTFail("Expected signedOut for \(badId)")
      } catch let error as AssistantIntentError {
        XCTAssertEqual(String(describing: error), String(describing: AssistantIntentError.signedOut))
      }
    }
    do {
      _ = try await TryOnceIntent.execute(scopedRoutineId: "scope-1|missing", routineName: "Missing", snapshot: routineSnap, signedInScope: "scope-1", client: client)
      XCTFail("Expected missing")
    } catch let error as AssistantIntentError {
      XCTAssertEqual(String(describing: error), String(describing: AssistantIntentError.missing))
    }
    XCTAssertNil(server.lastRequest)

    // Valid scoped run posts to /api/routines/r-morning/run with a requestId.
    let dialog = try await TryOnceIntent.execute(scopedRoutineId: "scope-1|r-morning", routineName: "Morning brief", snapshot: routineSnap, signedInScope: "scope-1", client: client)
    XCTAssertEqual(dialog, "Started Morning brief.")
    XCTAssertEqual(server.lastRequest?.url?.path, "/api/routines/r-morning/run")

    // Sign-out clears RoutineSnapshotStore.
    RoutineSnapshotStore.write(nil, to: routinesURL)
    let afterSignOut = try await RoutineEntityQuery().suggestedEntities()
    XCTAssertEqual(afterSignOut, [])
  }

  func testSendAssistantMessageIntentEnforcesOptInScopeLengthAndPersistentRateLimit() async throws {
    let defaults = isolatedDefaults()
    let snap = WidgetSnapshot(scope: "scope-1", generatedAt: Date(), assistants: [
      .init(id: "kitchen", name: "Kitchen", activity: "idle", lastMessage: nil, lastMessageAt: nil, color: nil, pinned: true),
    ])
    let server = FakeServer { _ in
      .init(body: #"{"requestId":"r1","status":"accepted","turn":"started"}"#)
    }
    let client = server.api(token: "tok")
    let scopedKitchen = ScopedAssistantEntity.scopedId(scope: "scope-1", botId: "kitchen")

    // Disabled by default.
    do {
      _ = try await SendAssistantMessageIntent.execute(
        scopedAssistantId: scopedKitchen, assistantName: "Kitchen", message: "Start coffee",
        snapshot: snap, signedInScope: "scope-1", client: client, defaults: defaults
      )
      XCTFail("Expected sendDisabled by default")
    } catch let error as AssistantIntentError {
      XCTAssertEqual(String(describing: error), String(describing: AssistantIntentError.sendDisabled))
    }
    XCTAssertNil(server.lastRequest)

    // Enable opt-in for scope-1.
    ShortcutSendPolicy.setEnabled(true, for: "scope-1", defaults: defaults)

    // Cross-account persisted entity (account A saved "scope-A|kitchen") and unscoped "kitchen" are rejected!
    for badId in ["kitchen", "scope-A|kitchen"] {
      do {
        _ = try await SendAssistantMessageIntent.execute(
          scopedAssistantId: badId, assistantName: "Kitchen", message: "Hijack",
          snapshot: snap, signedInScope: "scope-1", client: client, defaults: defaults
        )
        XCTFail("Expected signedOut for \(badId)")
      } catch let error as AssistantIntentError {
        XCTAssertEqual(String(describing: error), String(describing: AssistantIntentError.signedOut))
      }
    }

    // Missing client fails BEFORE consuming a cooldown slot.
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    do {
      _ = try await SendAssistantMessageIntent.execute(
        scopedAssistantId: scopedKitchen, assistantName: "Kitchen", message: "No client",
        snapshot: snap, signedInScope: "scope-1", client: nil, defaults: defaults, now: t0
      )
      XCTFail("Expected signedOut when client is nil")
    } catch let error as AssistantIntentError {
      XCTAssertEqual(String(describing: error), String(describing: AssistantIntentError.signedOut))
    }

    // Rejects overly long messages (> 4,000 chars).
    let longText = String(repeating: "a", count: ShortcutSendPolicy.maxMessageLength + 1)
    do {
      _ = try await SendAssistantMessageIntent.execute(
        scopedAssistantId: scopedKitchen, assistantName: "Kitchen", message: longText,
        snapshot: snap, signedInScope: "scope-1", client: client, defaults: defaults, now: t0
      )
      XCTFail("Expected sendTooLong")
    } catch let error as AssistantIntentError {
      XCTAssertEqual(String(describing: error), String(describing: AssistantIntentError.sendTooLong))
    }

    // Valid send succeeds at t0 (proving nil-client attempt did not consume the slot).
    let ok = try await SendAssistantMessageIntent.execute(
      scopedAssistantId: scopedKitchen, assistantName: "Kitchen", message: "Check grocery list",
      snapshot: snap, signedInScope: "scope-1", client: client, defaults: defaults, now: t0
    )
    XCTAssertEqual(ok, "Sent to Kitchen.")
    XCTAssertEqual(server.lastRequest?.url?.path, "/api/bots/kitchen/messages")

    // Immediate second send hits persisted cooldown in UserDefaults (survives process restart).
    XCTAssertGreaterThan(defaults.double(forKey: ShortcutSendPolicy.cooldownKey(scope: "scope-1", botId: "kitchen")), 0)
    do {
      _ = try await SendAssistantMessageIntent.execute(
        scopedAssistantId: scopedKitchen, assistantName: "Kitchen", message: "Again",
        snapshot: snap, signedInScope: "scope-1", client: client, defaults: defaults, now: t0.addingTimeInterval(2)
      )
      XCTFail("Expected rateLimited")
    } catch let error as AssistantIntentError {
      XCTAssertEqual(String(describing: error), String(describing: AssistantIntentError.rateLimited))
    }

    // After cooldown passes, send works again.
    let okAfter = try await SendAssistantMessageIntent.execute(
      scopedAssistantId: scopedKitchen, assistantName: "Kitchen", message: "After cooldown",
      snapshot: snap, signedInScope: "scope-1", client: client, defaults: defaults, now: t0.addingTimeInterval(6)
    )
    XCTAssertEqual(okAfter, "Sent to Kitchen.")
  }

  // MARK: 5. Deeper Spotlight Indexing (including failed-delete retry bookkeeping)

  private final class RecordingSpotlight: SpotlightIndexing {
    var indexed: [[SpotlightRecord]] = []
    var deleted: [[String]] = []
    var deleteAllCount = 0
    var failDeletes = false
    func index(_ records: [SpotlightRecord]) { indexed.append(records) }
    func delete(ids: [String]) { deleted.append(ids) }
    func deleteAll() { deleteAllCount += 1 }
    func delete(ids: [String], completion: @escaping @Sendable (Bool) -> Void) {
      deleted.append(ids)
      completion(!failDeletes)
    }
    func deleteAll(completion: @escaping @Sendable (Bool) -> Void) {
      deleteAllCount += 1
      completion(!failDeletes)
    }
  }

  func testSpotlightIndexesGroupsRoutinesAndSavedTitlesOnlyAndRetriesFailedDeletes() {
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

    // A failed deletion keeps local bookkeeping intact so the next sync retries!
    index.failDeletes = true
    XCTAssertTrue(spotlight.syncSaved([], scope: "scope-1"))
    XCTAssertEqual(index.deleted.last, ["saved:sv-1"])
    index.failDeletes = false
    XCTAssertTrue(spotlight.syncSaved([], scope: "scope-1"), "Must retry deletion after prior failure")
    XCTAssertEqual(index.deleted.count, 2)

    // Sign-out clears the entire domain; failed deleteAll also retains bookkeeping for retry.
    index.failDeletes = true
    XCTAssertTrue(spotlight.sync(nil))
    index.failDeletes = false
    XCTAssertTrue(spotlight.sync(nil))
    XCTAssertEqual(index.deleteAllCount, 2)
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

  // MARK: 7. On-Device FoundationModels Helpers (word-preserving dictation cleanup)

  func testOnDeviceIntelligenceHelpersPolishSuggestSummarizeAndPreserveWords() async {
    // Pure punctuation/capitalization cleanup succeeds.
    let polished = await OnDeviceIntelligence.polishTranscript("check the north gate tomorrow") { _, _ in
      "Check the north gate tomorrow."
    }
    XCTAssertEqual(polished, "Check the north gate tomorrow.")

    // Dropping a negation or altering any word falls back to the exact raw transcript!
    let droppedNegation = await OnDeviceIntelligence.polishTranscript("do not delete the invoice") { _, _ in
      "Delete the invoice."
    }
    XCTAssertEqual(droppedNegation, "do not delete the invoice")

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

  // MARK: 8. Opt-In AlarmKit Escalation (suspended schedule race & durable relaunch cleanup)

  @MainActor private final class FakeAlarmBackend: CriticalAlarmBackend {
    var isSupported = true
    var authState: CriticalAlarmAuthorization = .notDetermined
    var nextAuthResult: CriticalAlarmAuthorization = .authorized
    var scheduled: [CriticalAlarmRequest] = []
    var cancelled: [UUID] = []
    var liveIds: Set<UUID> = []
    var holdNextSchedule = false
    private var scheduleContinuation: CheckedContinuation<Void, Never>?

    func authorizationState() -> CriticalAlarmAuthorization { authState }
    func requestAuthorization() async -> CriticalAlarmAuthorization {
      authState = nextAuthResult
      return authState
    }
    func schedule(_ request: CriticalAlarmRequest) async throws {
      scheduled.append(request)
      liveIds.insert(request.id)
      if holdNextSchedule {
        holdNextSchedule = false
        await withCheckedContinuation { scheduleContinuation = $0 }
      }
    }
    func cancel(id: UUID) {
      cancelled.append(id)
      liveIds.remove(id)
    }
    func currentAlarmIds() -> Set<UUID> { liveIds }
    var isHoldingSchedule: Bool { scheduleContinuation != nil }
    func resumeSchedule() {
      let c = scheduleContinuation
      scheduleContinuation = nil
      c?.resume()
    }
  }

  func testCriticalAlarmsAreOptInCancelLateSuspendedSchedulesAndPersistOwnershipAcrossRelaunch() async throws {
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

    // Suspended schedule cancelled when sign-out / opt-out runs mid-flight!
    manager.setBotWaitingEnabled(true, botId: "kitchen", for: "scope-1")
    backend.holdNextSchedule = true
    let inflight = Task {
      await manager.escalateWaitingIfOptedIn(
        botId: "kitchen", botName: "Kitchen", reason: "Needs approval", dedupKey: "ap-race", scope: "scope-1"
      )
    }
    try await until { backend.isHoldingSchedule }
    manager.cancelAll()
    backend.resumeSchedule()
    let raceResult = await inflight.value
    XCTAssertFalse(raceResult, "Late schedule after cancelAll must cancel itself")
    XCTAssertTrue(backend.liveIds.isEmpty)

    // Routine reconciliation schedules active routines and cancels paused/deleted routines across relaunch.
    let future = Date().addingTimeInterval(600)
    var routine = Routine.empty(botId: "kitchen").with(id: "rt-1", name: "Water check")
    routine.nextRunAt = ServerDate.string(future)
    manager.setRoutineEnabled(true, routineId: "rt-1", for: "scope-1")
    await manager.reconcile(routines: [routine], scope: "scope-1")
    XCTAssertEqual(backend.liveIds.count, 1)

    // Simulate app relaunch with a brand-new manager sharing the same defaults and backend.
    let relaunched = CriticalAlarmManager(backend: backend, defaults: defaults)
    // Pausing or removing the routine cancels the persisted alarm!
    await relaunched.reconcile(routines: [], scope: "scope-1")
    XCTAssertTrue(backend.liveIds.isEmpty)

    // Account switch on relaunch cancels prior account's persisted alarms.
    await relaunched.reconcile(routines: [routine], scope: "scope-1")
    XCTAssertEqual(backend.liveIds.count, 1)
    let afterSwitch = CriticalAlarmManager(backend: backend, defaults: defaults)
    afterSwitch.reconcileOnLaunch(activeScope: "scope-2")
    XCTAssertTrue(backend.liveIds.isEmpty)
  }

  // MARK: 9. Secondary iPad Window (bounded turns=20 & idempotent retry)

  func testSecondaryChatUsesBoundedTurnsAndReusesRequestIdOnRetry() async throws {
    let failNextPost = OSAllocatedUnfairLock(initialState: true)
    let server = FakeServer { request in
      if request.httpMethod == "POST" {
        let shouldFail = failNextPost.withLock { value -> Bool in
          let current = value
          value = false
          return current
        }
        if shouldFail {
          return .init(status: 503, body: #"{"error":"temporarily unavailable"}"#)
        }
        return .init(body: #"{"requestId":"ok","status":"accepted","turn":"started"}"#)
      }
      return .init(body: #"{"botId":"kitchen","messages":[],"activity":{"state":"idle"},"approvals":[],"attention":[]}"#)
    }
    let store = AppStore()
    store.widgetSnapshotURL = nil
    store.api = server.api(token: "tok")
    store.bootstrap = try sampleBootstrap()
    let model = SecondaryChatModel(botId: "kitchen")

    await model.load(using: store)
    XCTAssertEqual(server.lastRequest?.url?.path, "/api/bots/kitchen/conversation")
    XCTAssertEqual(server.lastRequest?.url?.query, "turns=20")

    // First send fails -> pending is retained with its original requestId.
    model.draft = "Check oven timer"
    await model.send(using: store)
    let firstId = try XCTUnwrap(model.pending?.requestId)
    let firstBody = try server.lastJSON()
    XCTAssertEqual(firstBody["requestId"] as? String, firstId)

    // Retry reuses the exact same requestId and clears pending + draft on admission.
    await model.send(using: store, retryPending: true)
    let postRequestIds = server.bodies.compactMap { data -> String? in
      (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["requestId"] as? String
    }
    XCTAssertEqual(postRequestIds, [firstId, firstId])
    XCTAssertNil(model.pending)
    XCTAssertEqual(model.draft, "")
    store.suspend()
  }

  func testSecondaryChatPreservesPendingOnUncertain200ReceiptAndReconcilesViaSubmissions() async throws {
    let server = FakeServer { request in
      if request.httpMethod == "POST" {
        return .init(body: #"{"requestId":"u1","status":"uncertain","message":"Still checking"}"#)
      }
      if request.url?.path.hasPrefix("/api/submissions/") == true {
        return .init(body: #"{"requestId":"u1","status":"accepted","turn":"started"}"#)
      }
      return .init(body: #"{"botId":"kitchen","messages":[],"activity":{"state":"idle"},"approvals":[],"attention":[]}"#)
    }
    let store = AppStore()
    store.widgetSnapshotURL = nil
    store.api = server.api(token: "tok")
    store.bootstrap = try sampleBootstrap()
    let model = SecondaryChatModel(botId: "kitchen")

    model.draft = "Check water pump"
    await model.send(using: store)
    let pending = try XCTUnwrap(model.pending, "HTTP 200 status=uncertain must keep pending requestId")
    let requestId = pending.requestId

    // Explicit Retry sets reviewedUncertain = true while reusing the exact same requestId.
    await model.send(using: store, retryPending: true)
    XCTAssertEqual(model.pending?.requestId, requestId)
    XCTAssertEqual(model.pending?.reviewedUncertain, true)

    // Reconcile via GET /submissions/:requestId clears pending and draft without resending.
    await model.reconcilePending(using: store)
    XCTAssertNil(model.pending)
    XCTAssertEqual(model.draft, "")
    store.suspend()
  }

  func testWatchRefreshSucceedsWhenHandlerSyncsSameScopeAndDeduplicatesInFlightAction() async throws {
    let defaults = isolatedDefaults()
    let transport = FakeWatchTransport()
    let bridge = WatchBridge(transport: transport, defaults: defaults)
    let store = AppStore()
    store.widgetSnapshotURL = nil
    store.api = APIClient(baseURL: URL(string: "https://watch.invalid")!)
    store.bootstrap = try sampleBootstrap()
    let scope = try XCTUnwrap(store.scope)
    bridge.store = store

    let snap = WidgetSnapshot(scope: scope, generatedAt: Date(), assistants: [
      .init(id: "ranch", name: "Ranch", activity: "working", lastMessage: nil, lastMessageAt: nil, color: nil, pinned: true, runId: "run-7"),
    ])
    bridge.sync(snap)
    // Production BackgroundRefresh calls bridge.sync(latest) internally before returning!
    bridge.refreshHandler = {
      bridge.sync(snap)
      return snap
    }
    let refreshAction = WatchAction(scope: scope, kind: .refresh)
    let refreshReply = await bridge.handle(rawMessage: [WatchPayload.actionKey: try JSONEncoder().encode(refreshAction)])
    XCTAssertEqual(refreshReply["ok"] as? Bool, true)
    XCTAssertNotNil(refreshReply[WatchPayload.snapshotKey])

    // Duplicate delivery arriving while the first WatchAction is still suspended joins the in-flight task.
    var calls = 0
    var gate: CheckedContinuation<ActivityActionResult, Never>?
    bridge.actHandler = { _ in
      calls += 1
      return await withCheckedContinuation { gate = $0 }
    }
    let stopAction = WatchAction(scope: scope, kind: .stop(botId: "ranch", name: "Ranch", runId: "run-7"))
    let encodedStop = try JSONEncoder().encode(stopAction)
    let first = Task { () -> Bool in (await bridge.handle(rawMessage: [WatchPayload.actionKey: encodedStop]))["ok"] as? Bool ?? false }
    try await until { gate != nil }
    let second = Task { () -> Bool in (await bridge.handle(rawMessage: [WatchPayload.actionKey: encodedStop]))["ok"] as? Bool ?? false }
    gate?.resume(returning: ActivityActionResult(ok: true, message: "Stopped."))
    let firstOK = await first.value
    let secondOK = await second.value
    XCTAssertTrue(firstOK)
    XCTAssertTrue(secondOK)
    XCTAssertEqual(calls, 1, "Concurrent duplicate delivery must not execute twice")

    // SystemWatchTransport persists pending signedOut clear across relaunch and reconstructs it when signed out.
    let persistedDefaults = isolatedDefaults()
    let transport1 = SystemWatchTransport(defaults: persistedDefaults, savedScope: { nil })
    transport1.updateApplicationContext([WatchPayload.signedOutKey: true])
    let transport2 = SystemWatchTransport(defaults: persistedDefaults, savedScope: { "some-scope" })
    XCTAssertEqual(transport2.authoritativeContextToFlush(), .signedOut)
    let transportSignedOut = SystemWatchTransport(defaults: isolatedDefaults(), savedScope: { nil })
    XCTAssertEqual(transportSignedOut.authoritativeContextToFlush(), .signedOut)
    store.suspend()
  }

  func testCriticalAlarmBatchStopsMidBatchOnSignOutAndReschedulesAfterToggleOffAndOn() async throws {
    let defaults = isolatedDefaults()
    let backend = FakeAlarmBackend()
    let manager = CriticalAlarmManager(backend: backend, defaults: defaults)
    backend.nextAuthResult = .authorized
    _ = await manager.setEnabled(true, for: "scope-1")

    let future = Date().addingTimeInterval(600)
    var r1 = Routine.empty(botId: "kitchen").with(id: "rt-1", name: "First")
    r1.nextRunAt = ServerDate.string(future)
    var r2 = Routine.empty(botId: "kitchen").with(id: "rt-2", name: "Second")
    r2.nextRunAt = ServerDate.string(future)
    manager.setRoutineEnabled(true, routineId: "rt-1", for: "scope-1")
    manager.setRoutineEnabled(true, routineId: "rt-2", for: "scope-1")

    // Cancel mid-batch while first routine is suspended -> second routine must NEVER be scheduled!
    backend.holdNextSchedule = true
    let batch = Task { await manager.reconcile(routines: [r1, r2], scope: "scope-1") }
    try await until { backend.isHoldingSchedule }
    manager.cancelAll()
    backend.resumeSchedule()
    await batch.value
    XCTAssertTrue(backend.liveIds.isEmpty)
    XCTAssertEqual(backend.scheduled.map(\.routineId), ["rt-1"], "Second routine must not schedule after cancelAll")

    // Toggle a routine alarm off then back on before nextRunAt changes -> reschedules cleanly!
    await manager.reconcile(routines: [r1], scope: "scope-1")
    XCTAssertEqual(backend.liveIds.count, 1)
    manager.setRoutineEnabled(false, routineId: "rt-1", for: "scope-1")
    XCTAssertTrue(backend.liveIds.isEmpty)
    manager.setRoutineEnabled(true, routineId: "rt-1", for: "scope-1")
    await manager.reconcile(routines: [r1], scope: "scope-1")
    XCTAssertEqual(backend.liveIds.count, 1, "Re-enabling routine must reschedule the same occurrence")
  }

  private final class DeferredSpotlight: SpotlightIndexing, @unchecked Sendable {
    private let lock = NSLock()
    var events: [String] = []
    private var heldIndex: (@Sendable (Bool) -> Void)?
    func index(_ records: [SpotlightRecord]) {}
    func delete(ids: [String]) {}
    func deleteAll() {}
    func index(_ records: [SpotlightRecord], completion: @escaping @Sendable (Bool) -> Void) {
      lock.withLock {
        events.append("index:\(records.map(\.id).joined(separator: ","))")
        heldIndex = completion
      }
    }
    func deleteAll(completion: @escaping @Sendable (Bool) -> Void) {
      lock.withLock { events.append("deleteAll") }
      completion(true)
    }
    func finishHeldIndex(ok: Bool = true) {
      let cb = lock.withLock { () -> (@Sendable (Bool) -> Void)? in
        let c = heldIndex
        heldIndex = nil
        return c
      }
      cb?(ok)
    }
    var isHolding: Bool { lock.withLock { heldIndex != nil } }
  }

  func testSpotlightSerializesSignOutBehindInFlightFirstIndex() {
    let defaults = isolatedDefaults()
    let index = DeferredSpotlight()
    let spotlight = AssistantSpotlight(index: index, defaults: defaults)
    let room = GroupRoom(room_id: "r1", name: "Private Room", members: [])

    XCTAssertTrue(spotlight.syncGroups([room], scope: "scope-1"))
    XCTAssertTrue(index.isHolding)

    // Sign out BEFORE first index completion arrives.
    XCTAssertTrue(spotlight.sync(nil))
    // deleteAll must wait for the in-flight index, then run right after it!
    XCTAssertEqual(index.events, ["index:group:r1"])
    index.finishHeldIndex(ok: true)
    XCTAssertEqual(index.events, ["index:group:r1", "deleteAll"])
    XCTAssertNil(defaults.data(forKey: "spotlight.groups"), "Stale completion must not persist bookkeeping after sign-out")
  }

  // MARK: 10. Interactive Widget Refresh, Approval ID & Run ID Backwards Compatibility

  func testWidgetSnapshotDecodesWithAndWithoutApprovalAndRunIdsAndRefreshIntentCallsHandler() async throws {
    let legacyJSON = #"{"scope":"a","generatedAt":0,"assistants":[{"id":"k","name":"Kitchen","activity":"waiting","pinned":true}]}"#
    let legacy = try JSONDecoder().decode(WidgetSnapshot.self, from: Data(legacyJSON.utf8))
    XCTAssertNil(legacy.assistants[0].approvalId)
    XCTAssertNil(legacy.assistants[0].runId)

    let withIds = WidgetSnapshot(scope: "a", generatedAt: Date(), assistants: [
      .init(id: "k", name: "Kitchen", activity: "waiting", lastMessage: nil, lastMessageAt: nil, color: nil, pinned: true, approvalId: "ap-9", runId: "run-7"),
    ])
    let roundTrip = try JSONDecoder().decode(WidgetSnapshot.self, from: JSONEncoder().encode(withIds))
    XCTAssertEqual(roundTrip.assistants[0].approvalId, "ap-9")
    XCTAssertEqual(roundTrip.assistants[0].runId, "run-7")

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
