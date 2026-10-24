import Foundation
import Observation
import XCTest
@testable import AgentInterface

extension AppStore {
  /// Every property of the store that views can observe, by name. `testTheObservedListNamesEveryTrackedProperty`
  /// keeps it complete, so a new property is either counted here or deliberately `@ObservationIgnored`.
  static var observedForTests: [String: PartialKeyPath<AppStore>] {
    [
      "host": \.host, "api": \.api, "bootstrap": \.bootstrap, "scope": \.scope, "additions": \.additions,
      "haptic": \.haptic, "keyboardCommand": \.keyboardCommand, "searchFocusPending": \.searchFocusPending,
      "conversation": \.conversation, "transcript": \.transcript, "turns": \.turns, "echoes": \.echoes,
      "selectedBotId": \.selectedBotId, "routineResult": \.routineResult, "todayRequest": \.todayRequest, "listenRequest": \.listenRequest,
      "draft": \.draft, "draftReady": \.draftReady, "pendings": \.pendings, "receipts": \.receipts,
      "error": \.error, "notice": \.notice, "leftBotId": \.leftBotId, "signingIn": \.signingIn, "loading": \.loading,
      "sending": \.sending, "appUnavailable": \.appUnavailable, "interruptionReviewed": \.interruptionReviewed,
      "authConfig": \.authConfig, "restoring": \.restoring, "sessionExpired": \.sessionExpired,
      "conversationRequest": \.conversationRequest, "preferencesSaving": \.preferencesSaving,
      "preferencesSaveFailed": \.preferencesSaveFailed, "preferencesDraft": \.preferencesDraft,
      "deviceNotifications": \.deviceNotifications, "openedFile": \.openedFile, "computerStatus": \.computerStatus,
      "replyAnnouncement": \.replyAnnouncement, "offlineSavedAt": \.offlineSavedAt, "cachedChats": \.cachedChats,
      "earlierFileCache": \.earlierFileCache, "loadingEarlierFiles": \.loadingEarlierFiles,
      "earlierFilesFailure": \.earlierFilesFailure, "loadingEarlier": \.loadingEarlier,
      "conversationScreens": \.conversationScreens, "chatCovers": \.chatCovers,
      "connectionError": \.connectionError, "activity": \.activity, "latestReply": \.latestReply,
      "readHere": \.readHere,
    ]
  }
  /// The names of the stored properties the Observation macro tracks, read from the backing storage it generates.
  static func trackedPropertyNames(of store: AppStore) -> Set<String> {
    Set(Mirror(reflecting: store).children.compactMap(\.label).filter { $0.hasPrefix("_") && !$0.hasPrefix("_$") }.map { String($0.dropFirst()) })
  }
}

/// How often each observed property of the store changed while `body` ran, as SwiftUI would see it.
/// Each property is tracked on its own and re-armed after every change, so three assignments count three.
@MainActor func observedChanges(of store: AppStore, during body: () async throws -> Void) async rethrows -> [String: Int] {
  /// Observation calls back from the setter, on the main actor here; the lock keeps the log safe regardless.
  final class Log: @unchecked Sendable {
    private let lock = NSLock()
    private var counts: [String: Int] = [:]
    private var recording = true
    var active: Bool {
      get { lock.withLock { recording } }
      set { lock.withLock { recording = newValue } }
    }
    func record(_ name: String) { lock.withLock { counts[name, default: 0] += 1 } }
    var value: [String: Int] { lock.withLock { counts } }
  }
  let log = Log()
  for name in AppStore.observedForTests.keys { arm(store, name, { log.record($0) }, while: { log.active }) }
  try await body()
  log.active = false
  return log.value
}
/// Key paths are not Sendable, so the change handler re-arms by name.
@MainActor private func arm(_ store: AppStore, _ name: String, _ record: @escaping @Sendable (String) -> Void,
  while active: @escaping @Sendable () -> Bool) {
  guard let path = AppStore.observedForTests[name] else { return }
  withObservationTracking { _ = store[keyPath: path] } onChange: {
    guard active() else { return }
    record(name)
    MainActor.assumeIsolated { arm(store, name, record, while: active) }
  }
}
