import AppIntents
import Foundation
import SwiftUI
#if canImport(AlarmKit)
  import AlarmKit
#endif

/// Authorization status for opt-in critical alert alarms (AlarmKit on iOS 26+).
enum CriticalAlarmAuthorization: Equatable, Sendable {
  case unavailable
  case notDetermined
  case denied
  case authorized
}

/// Descriptor for an opt-in WildBots alarm escalation.
struct CriticalAlarmRequest: Equatable, Sendable {
  var id: UUID
  var title: String
  var botId: String
  var routineId: String?
  var scope: String
  var fireDate: Date?
}

/// Injectable AlarmKit boundary so unit tests verify opt-in defaults, deduping, account scoping,
/// and sign-out cancellation without scheduling real system alarms.
@MainActor protocol CriticalAlarmBackend {
  var isSupported: Bool { get }
  func authorizationState() -> CriticalAlarmAuthorization
  func requestAuthorization() async -> CriticalAlarmAuthorization
  func schedule(_ request: CriticalAlarmRequest) async throws
  func cancel(id: UUID)
}

#if canImport(AlarmKit)
  @available(iOS 26.0, *)
  struct WildBotsAlarmMetadata: AlarmMetadata {
    var botId: String
    var routineId: String?
    var title: String
    var scope: String
  }

  /// Opens the assistant or routine in WildBots when the user taps Open on an escalated alarm.
  @available(iOS 26.0, *)
  struct OpenCriticalAlarmIntent: LiveActivityIntent {
    static var title: LocalizedStringResource { "Open in WildBots" }
    static var isDiscoverable: Bool { false }
    static var openAppWhenRun: Bool { true }
    @Parameter(title: "Assistant") var botId: String
    @Parameter(title: "Routine") var routineId: String?
    init() {}
    init(botId: String, routineId: String? = nil) {
      self.botId = botId
      self.routineId = routineId
    }
    @MainActor func perform() async throws -> some IntentResult {
      let url = routineId.map { DeepLink.routine(botId: botId, routineId: $0) } ?? DeepLink.bot(botId)
      await IntentLinks.open(url)
      return .result()
    }
  }
#endif

@MainActor struct SystemCriticalAlarmBackend: CriticalAlarmBackend {
  var isSupported: Bool {
    #if canImport(AlarmKit)
      if #available(iOS 26.0, *) { return true }
    #endif
    return false
  }

  func authorizationState() -> CriticalAlarmAuthorization {
    #if canImport(AlarmKit)
      if #available(iOS 26.0, *) {
        switch AlarmManager.shared.authorizationState {
        case .notDetermined: return .notDetermined
        case .denied: return .denied
        case .authorized: return .authorized
        @unknown default: return .unavailable
        }
      }
    #endif
    return .unavailable
  }

  func requestAuthorization() async -> CriticalAlarmAuthorization {
    #if canImport(AlarmKit)
      if #available(iOS 26.0, *) {
        do {
          switch try await AlarmManager.shared.requestAuthorization() {
          case .authorized: return .authorized
          case .denied: return .denied
          case .notDetermined: return .notDetermined
          @unknown default: return .unavailable
          }
        } catch {
          return .denied
        }
      }
    #endif
    return .unavailable
  }

  func schedule(_ request: CriticalAlarmRequest) async throws {
    #if canImport(AlarmKit)
      guard #available(iOS 26.0, *) else { return }
      let openButton = AlarmButton(text: "Open", textColor: .white, systemImageName: "arrow.up.forward.app")
      let alert: AlarmPresentation.Alert
      if #available(iOS 26.1, *) {
        alert = AlarmPresentation.Alert(
          title: LocalizedStringResource(stringLiteral: request.title),
          secondaryButton: openButton,
          secondaryButtonBehavior: .custom
        )
      } else {
        let stopButton = AlarmButton(text: "Dismiss", textColor: .white, systemImageName: "xmark")
        alert = AlarmPresentation.Alert(
          title: LocalizedStringResource(stringLiteral: request.title),
          stopButton: stopButton,
          secondaryButton: openButton,
          secondaryButtonBehavior: .custom
        )
      }
      let presentation = AlarmPresentation(alert: alert)
      let metadata = WildBotsAlarmMetadata(botId: request.botId, routineId: request.routineId, title: request.title, scope: request.scope)
      let attributes = AlarmAttributes(presentation: presentation, metadata: metadata, tintColor: Palette.accent)
      let openIntent = OpenCriticalAlarmIntent(botId: request.botId, routineId: request.routineId)
      let config: AlarmManager.AlarmConfiguration<WildBotsAlarmMetadata>
      if let fireDate = request.fireDate, fireDate > Date().addingTimeInterval(2) {
        config = .alarm(schedule: .fixed(fireDate), attributes: attributes, secondaryIntent: openIntent)
      } else {
        config = .timer(duration: 1, attributes: attributes, secondaryIntent: openIntent)
      }
      _ = try await AlarmManager.shared.schedule(id: request.id, configuration: config)
    #endif
  }

  func cancel(id: UUID) {
    #if canImport(AlarmKit)
      guard #available(iOS 26.0, *) else { return }
      try? AlarmManager.shared.cancel(id: id)
    #endif
  }
}

/// Manages strictly opt-in AlarmKit escalations for critical routine or waiting alerts on iOS 26+.
/// Never enabled by default: the user must enable critical alarms in Settings AND explicitly mark
/// specific routines or assistants as alarm-worthy.
@MainActor @Observable final class CriticalAlarmManager {
  static let shared = CriticalAlarmManager()

  private(set) var preferenceVersion = 0
  private(set) var authorization: CriticalAlarmAuthorization = .notDetermined
  private(set) var scheduledIds: [String: UUID] = [:]

  @ObservationIgnored var backend: CriticalAlarmBackend
  @ObservationIgnored var defaults: UserDefaults
  @ObservationIgnored private var escalatedKeys: Set<String> = []

  init(backend: CriticalAlarmBackend = SystemCriticalAlarmBackend(), defaults: UserDefaults = .standard) {
    self.backend = backend
    self.defaults = defaults
    self.authorization = backend.authorizationState()
  }

  var isSupported: Bool { backend.isSupported }

  private static func masterKey(_ scope: String) -> String { "native.\(scope).alarmKit.enabled" }
  private static func routinesKey(_ scope: String) -> String { "native.\(scope).alarmKit.routines" }
  private static func botsKey(_ scope: String) -> String { "native.\(scope).alarmKit.bots" }

  /// Master opt-in switch (always `false` by default).
  func isEnabled(for scope: String?) -> Bool {
    _ = preferenceVersion
    guard isSupported, let scope, !scope.isEmpty else { return false }
    return defaults.bool(forKey: Self.masterKey(scope))
  }

  /// Turns master alarm escalation on (requesting AlarmKit permission) or off (cancelling active alarms).
  @discardableResult func setEnabled(_ enabled: Bool, for scope: String?) async -> CriticalAlarmAuthorization {
    guard isSupported, let scope, !scope.isEmpty else { return .unavailable }
    if !enabled {
      defaults.set(false, forKey: Self.masterKey(scope))
      cancelAll()
      preferenceVersion += 1
      return backend.authorizationState()
    }
    let state = await backend.requestAuthorization()
    authorization = state
    if state == .authorized {
      defaults.set(true, forKey: Self.masterKey(scope))
      preferenceVersion += 1
    } else {
      defaults.set(false, forKey: Self.masterKey(scope))
      preferenceVersion += 1
    }
    return state
  }

  /// Whether a specific routine is explicitly marked alarm-worthy by the user.
  func routineEnabled(_ routineId: String, for scope: String?) -> Bool {
    _ = preferenceVersion
    guard let scope, !scope.isEmpty else { return false }
    return Set(defaults.stringArray(forKey: Self.routinesKey(scope)) ?? []).contains(routineId)
  }

  func setRoutineEnabled(_ enabled: Bool, routineId: String, for scope: String?) {
    guard let scope, !scope.isEmpty else { return }
    var ids = Set(defaults.stringArray(forKey: Self.routinesKey(scope)) ?? [])
    if enabled { ids.insert(routineId) } else {
      ids.remove(routineId)
      cancel(eventKey: "routine:\(routineId)")
    }
    defaults.set(Array(ids).sorted(), forKey: Self.routinesKey(scope))
    preferenceVersion += 1
  }

  /// Whether a specific assistant's waiting/approval alerts are explicitly marked alarm-worthy.
  func botWaitingEnabled(_ botId: String, for scope: String?) -> Bool {
    _ = preferenceVersion
    guard let scope, !scope.isEmpty else { return false }
    return Set(defaults.stringArray(forKey: Self.botsKey(scope)) ?? []).contains(botId)
  }

  func setBotWaitingEnabled(_ enabled: Bool, botId: String, for scope: String?) {
    guard let scope, !scope.isEmpty else { return }
    var ids = Set(defaults.stringArray(forKey: Self.botsKey(scope)) ?? [])
    if enabled { ids.insert(botId) } else {
      ids.remove(botId)
      cancel(eventKey: "waiting:\(botId)")
    }
    defaults.set(Array(ids).sorted(), forKey: Self.botsKey(scope))
    preferenceVersion += 1
  }

  /// Escalates a waiting/approval alert for an assistant if and only if both the master opt-in and
  /// that assistant's opt-in flag are enabled, deduplicated per `dedupKey`.
  @discardableResult func escalateWaitingIfOptedIn(
    botId: String,
    botName: String,
    reason: String,
    dedupKey: String,
    scope: String?
  ) async -> Bool {
    guard let scope, isEnabled(for: scope), botWaitingEnabled(botId, for: scope) else { return false }
    let fullKey = "\(scope)|waiting|\(botId)|\(dedupKey)"
    guard !escalatedKeys.contains(fullKey) else { return false }
    guard backend.authorizationState() == .authorized else { return false }
    let id = UUID()
    let request = CriticalAlarmRequest(
      id: id,
      title: "\(botName): \(reason)",
      botId: botId,
      routineId: nil,
      scope: scope,
      fireDate: nil
    )
    do {
      try await backend.schedule(request)
      escalatedKeys.insert(fullKey)
      scheduledIds["waiting:\(botId)"] = id
      return true
    } catch {
      return false
    }
  }

  /// Schedules or escalates an alarm for a routine the user explicitly marked alarm-worthy.
  @discardableResult func scheduleRoutineAlarmIfOptedIn(
    routine: Routine,
    scope: String?,
    now: Date = Date()
  ) async -> Bool {
    guard let scope, isEnabled(for: scope), routineEnabled(routine.id, for: scope), routine.enabled else { return false }
    guard backend.authorizationState() == .authorized else { return false }
    let failed = routine.lastStatus == "failed" || routine.lastStatus == "error" || routine.lastStatus == "delivery_failed"
    let fireDate: Date?
    let dedupKey: String
    if failed {
      fireDate = nil
      dedupKey = "failed:\(routine.lastRunAt ?? routine.id)"
    } else if let next = routine.nextRunAt.flatMap(ServerDate.parse), next > now {
      fireDate = next
      dedupKey = "next:\(routine.nextRunAt ?? "")"
    } else {
      return false
    }
    let fullKey = "\(scope)|routine|\(routine.id)|\(dedupKey)"
    guard !escalatedKeys.contains(fullKey) else { return false }
    cancel(eventKey: "routine:\(routine.id)")
    let id = UUID()
    let title = failed ? "\(routine.name) failed" : "\(routine.name) starting"
    let request = CriticalAlarmRequest(id: id, title: title, botId: routine.botId, routineId: routine.id, scope: scope, fireDate: fireDate)
    do {
      try await backend.schedule(request)
      escalatedKeys.insert(fullKey)
      scheduledIds["routine:\(routine.id)"] = id
      return true
    } catch {
      return false
    }
  }

  func cancel(eventKey: String) {
    if let id = scheduledIds.removeValue(forKey: eventKey) {
      backend.cancel(id: id)
    }
  }

  /// Cancels all scheduled WildBots alarms and clears dedup tracking (called on sign-out / account change).
  func cancelAll() {
    for id in scheduledIds.values { backend.cancel(id: id) }
    scheduledIds.removeAll()
    escalatedKeys.removeAll()
  }
}
