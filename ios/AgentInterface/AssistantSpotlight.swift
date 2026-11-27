import CoreSpotlight
import Foundation
import UniformTypeIdentifiers
import os

/// One item as Spotlight lists it: title only, since Spotlight results can show on a locked
/// device and message previews stay strictly inside the app.
struct SpotlightRecord: Equatable, Sendable {
  enum Kind: String, Codable, Equatable, Sendable {
    case assistant
    case group
    case routine
    case saved
  }
  var id: String
  var title: String
  var kind: Kind = .assistant

  var description: String {
    switch kind {
    case .assistant: "WildBots assistant"
    case .group: "WildBots group chat"
    case .routine: "WildBots routine"
    case .saved: "WildBots saved item"
    }
  }
}

/// The part of Core Spotlight this app uses, so tests can watch what is indexed and removed.
/// Implementations that perform async I/O override the completion variants so local bookkeeping
/// advances only when Core Spotlight confirms success.
protocol SpotlightIndexing {
  func index(_ records: [SpotlightRecord])
  func delete(ids: [String])
  func deleteAll()
  func index(_ records: [SpotlightRecord], completion: @escaping @Sendable (Bool) -> Void)
  func delete(ids: [String], completion: @escaping @Sendable (Bool) -> Void)
  func deleteAll(completion: @escaping @Sendable (Bool) -> Void)
}

extension SpotlightIndexing {
  func index(_ records: [SpotlightRecord], completion: @escaping @Sendable (Bool) -> Void) {
    index(records)
    completion(true)
  }
  func delete(ids: [String], completion: @escaping @Sendable (Bool) -> Void) {
    delete(ids: ids)
    completion(true)
  }
  func deleteAll(completion: @escaping @Sendable (Bool) -> Void) {
    deleteAll()
    completion(true)
  }
}

struct SystemSpotlightIndex: SpotlightIndexing {
  static let domain = "dev.agentinterface.assistants"
  func index(_ records: [SpotlightRecord]) { index(records) { _ in } }
  func delete(ids: [String]) { delete(ids: ids) { _ in } }
  func deleteAll() { deleteAll { _ in } }

  func index(_ records: [SpotlightRecord], completion: @escaping @Sendable (Bool) -> Void) {
    guard !records.isEmpty else { completion(true); return }
    let items = records.map { record -> CSSearchableItem in
      let attributes = CSSearchableItemAttributeSet(contentType: .content)
      attributes.title = record.title
      attributes.contentDescription = record.description
      return CSSearchableItem(uniqueIdentifier: record.id, domainIdentifier: Self.domain, attributeSet: attributes)
    }
    CSSearchableIndex.default().indexSearchableItems(items) { error in
      completion(error == nil)
    }
  }
  func delete(ids: [String], completion: @escaping @Sendable (Bool) -> Void) {
    guard !ids.isEmpty else { completion(true); return }
    CSSearchableIndex.default().deleteSearchableItems(withIdentifiers: ids) { error in
      completion(error == nil)
    }
  }
  func deleteAll(completion: @escaping @Sendable (Bool) -> Void) {
    CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: [Self.domain]) { error in
      completion(error == nil)
    }
  }
}

/// Keeps Spotlight listing exactly the signed-in account's assistants, group chats, routines
/// (by name), and saved references (title-only for privacy). Signing out or switching accounts
/// clears the entire domain immediately, serializing behind any in-flight writes so a late
/// completion can never leave private titles indexed after sign-out.
struct AssistantSpotlight {
  var index: SpotlightIndexing
  var defaults: UserDefaults = .standard
  private let queue = SpotlightSerialQueue()
  @MainActor static let system = AssistantSpotlight(index: SystemSpotlightIndex())

  init(index: SpotlightIndexing, defaults: UserDefaults = .standard) {
    self.index = index
    self.defaults = defaults
  }

  private struct Indexed: Codable, Equatable, Sendable { var scope: String; var records: [String: String] }
  private static let assistantsKey = "spotlight.assistants"
  private static let groupsKey = "spotlight.groups"
  private static let routinesKey = "spotlight.routines"
  private static let savedKey = "spotlight.saved"
  private static let pendingClearKey = "spotlight.pendingClear"
  private static let allKeys = [assistantsKey, groupsKey, routinesKey, savedKey]

  static let groupPrefix = "group:"
  static let routinePrefix = "routine:"
  static let savedPrefix = "saved:"

  /// Maps a Core Spotlight unique identifier back to its in-app `DeepLink`.
  /// Bare identifiers remain assistant IDs for backwards compatibility.
  static func deepLink(for identifier: String) -> URL? {
    if identifier.hasPrefix(groupPrefix) {
      let roomId = String(identifier.dropFirst(groupPrefix.count))
      return roomId.isEmpty ? nil : DeepLink.group(roomId)
    }
    if identifier.hasPrefix(routinePrefix) {
      let rest = String(identifier.dropFirst(routinePrefix.count))
      let parts = rest.split(separator: ":", maxSplits: 1).map(String.init)
      guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
      return DeepLink.routine(botId: parts[0], routineId: parts[1])
    }
    if identifier.hasPrefix(savedPrefix) {
      return DeepLink.saved
    }
    return identifier.isEmpty ? nil : DeepLink.bot(identifier)
  }

  /// Syncs assistants from the widget snapshot. Returns whether anything changed, so callers can
  /// refresh Siri's list of assistant names. Signing out (`nil`) clears every Spotlight category,
  /// invalidating any in-flight writes and queuing `deleteAll` behind them so a late completion
  /// can never leave private titles indexed.
  @discardableResult func sync(_ snapshot: WidgetSnapshot?) -> Bool {
    guard let snapshot else {
      let hadAny = defaults.bool(forKey: Self.pendingClearKey)
        || Self.allKeys.contains { defaults.data(forKey: $0) != nil }
        || queue.hasPendingWork
      guard hadAny else { return false }
      // Persist that a sign-out clear is owed so a failed `deleteAll` retries on the next
      // sign-out or before the next account writes, even if an earlier first write had not yet
      // written its bookkeeping.
      defaults.set(true, forKey: Self.pendingClearKey)
      let clearGeneration = queue.invalidate()
      let box = SentDefaults(defaults)
      let indexBox = SentIndex(index)
      let serialQueue = queue
      queue.enqueue { done in
        indexBox.index.deleteAll { ok in
          if ok {
            for key in Self.allKeys { box.defaults.removeObject(forKey: key) }
            if serialQueue.isCurrent(clearGeneration) {
              box.defaults.removeObject(forKey: Self.pendingClearKey)
            }
          }
          done()
        }
      }
      return true
    }
    let records = Dictionary(snapshot.assistants.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
    return syncCategory(key: Self.assistantsKey, kind: .assistant, scope: snapshot.scope, records: records)
  }

  /// Syncs group chat room names (title-only) for the active account scope.
  @discardableResult func syncGroups(_ rooms: [GroupRoom], scope: String?) -> Bool {
    guard let scope else { return false }
    let records = Dictionary(
      rooms.compactMap { room -> (String, String)? in
        let name = room.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? nil : (Self.groupPrefix + room.id, name)
      },
      uniquingKeysWith: { first, _ in first }
    )
    return syncCategory(key: Self.groupsKey, kind: .group, scope: scope, records: records)
  }

  /// Syncs routine names (name-only) for the active account scope.
  @discardableResult func syncRoutines(_ routines: [Routine], scope: String?) -> Bool {
    guard let scope else { return false }
    let records = Dictionary(
      routines.compactMap { routine -> (String, String)? in
        let name = routine.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? nil : ("\(Self.routinePrefix)\(routine.botId):\(routine.id)", name)
      },
      uniquingKeysWith: { first, _ in first }
    )
    return syncCategory(key: Self.routinesKey, kind: .routine, scope: scope, records: records)
  }

  /// Syncs saved reference titles (title-only, never message bodies) for the active account scope.
  @discardableResult func syncSaved(_ items: [SavedItem], scope: String?) -> Bool {
    guard let scope else { return false }
    let records = Dictionary(
      items.compactMap { item -> (String, String)? in
        let title = item.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? nil : (Self.savedPrefix + item.id, title)
      },
      uniquingKeysWith: { first, _ in first }
    )
    return syncCategory(key: Self.savedKey, kind: .saved, scope: scope, records: records)
  }

  private func syncCategory(key: String, kind: SpotlightRecord.Kind, scope: String, records: [String: String]) -> Bool {
    let currentStored = defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(Indexed.self, from: $0) }
    let next = Indexed(scope: scope, records: records)
    if next == currentStored, !defaults.bool(forKey: Self.pendingClearKey), !queue.hasPendingWork { return false }
    let writeGeneration = queue.currentGeneration
    let box = SentDefaults(defaults)
    let indexBox = SentIndex(index)
    let serialQueue = queue
    let encodedNext = try? JSONEncoder().encode(next)

    queue.enqueue { done in
      guard serialQueue.isCurrent(writeGeneration) else { done(); return }
      // Read the last applied state inside the queued operation so earlier in-flight writes are
      // always reflected when computing removals and deltas.
      let stored = box.defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(Indexed.self, from: $0) }
      let pendingClear = box.defaults.bool(forKey: Self.pendingClearKey)
      let scopeChanged = stored != nil && stored?.scope != next.scope
      let needsFullClear = pendingClear || scopeChanged
      if !needsFullClear, next == stored {
        done()
        return
      }
      let changed = next.records.filter {
        needsFullClear ? true : (stored?.records[$0.key] != $0.value)
      }
      let toIndex = changed.map { SpotlightRecord(id: $0.key, title: $0.value, kind: kind) }.sorted { $0.id < $1.id }
      let shouldIndex = !toIndex.isEmpty || kind == .assistant

      let finishIndex: @Sendable () -> Void = {
        guard serialQueue.isCurrent(writeGeneration) else { done(); return }
        if shouldIndex {
          indexBox.index.index(toIndex) { ok in
            if ok, serialQueue.isCurrent(writeGeneration), let encodedNext {
              box.defaults.set(encodedNext, forKey: key)
            }
            done()
          }
        } else {
          if serialQueue.isCurrent(writeGeneration), let encodedNext {
            box.defaults.set(encodedNext, forKey: key)
          }
          done()
        }
      }

      // A pending sign-out clear or a different account clears the entire domain first.
      if needsFullClear {
        indexBox.index.deleteAll { ok in
          guard ok else { done(); return }
          for allKey in Self.allKeys { box.defaults.removeObject(forKey: allKey) }
          if serialQueue.isCurrent(writeGeneration) {
            box.defaults.removeObject(forKey: Self.pendingClearKey)
          }
          finishIndex()
        }
      } else if let stored {
        let gone = stored.records.keys.filter { next.records[$0] == nil }.sorted()
        if !gone.isEmpty {
          indexBox.index.delete(ids: gone) { ok in
            guard ok else { done(); return }
            finishIndex()
          }
        } else {
          finishIndex()
        }
      } else {
        finishIndex()
      }
    }
    return true
  }
}

/// FIFO serial queue for Core Spotlight mutations. Synchronous test doubles complete inline;
/// asynchronous Core Spotlight calls run one at a time so sign-out `deleteAll` always executes
/// after any earlier write and invalidates stale completions.
private final class SpotlightSerialQueue: @unchecked Sendable {
  private let lock = NSLock()
  private var running = false
  private var pending: [@Sendable (@escaping @Sendable () -> Void) -> Void] = []
  private var generation: UInt64 = 0

  var hasPendingWork: Bool { lock.withLock { running || !pending.isEmpty } }
  var currentGeneration: UInt64 { lock.withLock { generation } }
  func isCurrent(_ value: UInt64) -> Bool { lock.withLock { generation == value } }

  @discardableResult func invalidate() -> UInt64 {
    lock.withLock {
      generation &+= 1
      return generation
    }
  }

  func enqueue(_ work: @escaping @Sendable (@escaping @Sendable () -> Void) -> Void) {
    let shouldStart = lock.withLock { () -> Bool in
      pending.append(work)
      if running { return false }
      running = true
      return true
    }
    if shouldStart { drain() }
  }

  private struct DrainState: Sendable {
    var finishedInline = false
    var completed = false
    var waitingAsync = false
  }

  private func drain() {
    while true {
      let next = lock.withLock { () -> (@Sendable (@escaping @Sendable () -> Void) -> Void)? in
        if pending.isEmpty {
          running = false
          return nil
        }
        return pending.removeFirst()
      }
      guard let next else { return }
      let state = OSAllocatedUnfairLock(initialState: DrainState())
      next {
        let shouldContinue = state.withLock { value -> Bool in
          guard !value.completed else { return false }
          value.completed = true
          if value.waitingAsync { return true }
          value.finishedInline = true
          return false
        }
        if shouldContinue { self.drain() }
      }
      let goAsync = state.withLock { value -> Bool in
        if value.finishedInline { return false }
        value.waitingAsync = true
        return true
      }
      if goAsync { return }
    }
  }
}

private final class SentDefaults: @unchecked Sendable {
  let defaults: UserDefaults
  init(_ defaults: UserDefaults) { self.defaults = defaults }
}

private final class SentIndex: @unchecked Sendable {
  let index: SpotlightIndexing
  init(_ index: SpotlightIndexing) { self.index = index }
}
