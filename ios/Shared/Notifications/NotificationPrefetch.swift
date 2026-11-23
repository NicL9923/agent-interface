import CryptoKit
import Foundation
import Security

/// Shared Keychain storage for the notification service extension only.
/// Only `AgentInterface` and `AgentInterfaceNotifications` carry the
/// `$(AppIdentifierPrefix)dev.agentinterface.ios.notifications` access group, so the share and
/// widget extensions still never see a sign-in token.
enum PrefetchKeychain {
  static let service = "dev.agentinterface.native.prefetch"
  static let groupSuffix = "dev.agentinterface.ios.notifications"

  /// The full Keychain access group for this signed bundle (`<TeamID>.dev.agentinterface.ios.notifications`,
  /// or `dev.agentinterface.ios.notifications` on unsigned simulator builds).
  static var accessGroup: String? {
    guard let prefix = Bundle.main.object(forInfoDictionaryKey: "AppIdentifierPrefix") as? String,
      !prefix.contains("$(")
    else { return nil }
    return prefix + groupSuffix
  }

  static func read(host: String, accessGroup: String? = Self.accessGroup) -> String? {
    guard let accessGroup, !accessGroup.isEmpty else { return nil }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: host,
      kSecAttrAccessGroup as String: accessGroup,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data
    else { return nil }
    return String(data: data, encoding: .utf8)
  }

  /// Mirrors or removes the host's sign-in token in the shared Keychain group.
  /// Best-effort: unsigned test hosts without Keychain entitlements leave the main Keychain unaffected.
  static func save(_ token: String?, host: String, accessGroup: String? = Self.accessGroup) {
    guard let accessGroup, !accessGroup.isEmpty else { return }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: host,
      kSecAttrAccessGroup as String: accessGroup,
    ]
    SecItemDelete(query as CFDictionary)
    guard let token else { return }
    var value = query
    value[kSecValueData as String] = Data(token.utf8)
    value[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    _ = SecItemAdd(value as CFDictionary, nil)
  }
}

/// Non-secret connection metadata the app leaves in the App Group so the notification service
/// extension knows which server and account are currently signed in on this device.
struct NotificationPrefetchConfig: Codable, Equatable, Sendable {
  var origin: String
  var account: String
}

/// One conversation page fetched by the notification service extension and staged in the App Group
/// for the main app to absorb as soon as it opens or resumes.
struct PrefetchedConversation: Codable, Equatable, Sendable {
  var botId: String
  var account: String
  var fetchedAt: Date
  var etag: String?
  var payload: Data
}

/// Sendable notification target extracted synchronously from `UNNotificationContent.userInfo`.
struct NotificationPrefetchTarget: Equatable, Sendable {
  var botId: String
  var account: String
  var url: String?
}

extension NotificationPrefetchTarget {
  init?(userInfo: [AnyHashable: Any]) {
    guard let botId = userInfo["botId"] as? String, !botId.isEmpty,
      let account = userInfo["account"] as? String, NotificationSenders.isAccountMarker(account)
    else { return nil }
    let url = userInfo["url"] as? String
    if let url, let components = URLComponents(string: url) {
      let items = components.queryItems ?? []
      if items.contains(where: { $0.name == "routine" }) { return nil }
      if items.contains(where: { $0.name == "view" && ($0.value == "today" || $0.value == "home") }) { return nil }
    }
    self.botId = botId
    self.account = account
    self.url = url
  }
}

/// Bounded App Group storage shared between the main app and the notification service extension.
enum NotificationPrefetchStore {
  static let maximumBytes = 1_536 * 1024
  static let maximumChats = 5
  static let maximumAge: TimeInterval = 24 * 3600
  private static let configName = "config.json"

  static var root: URL? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: ShareInbox.group)?
      .appendingPathComponent("NotificationPrefetch", isDirectory: true)
  }

  static func configURL(root: URL? = Self.root) -> URL? {
    root?.appendingPathComponent(configName)
  }

  static func accountDirectory(account: String, root: URL? = Self.root) -> URL? {
    guard NotificationSenders.isAccountMarker(account) else { return nil }
    return root?.appendingPathComponent(account, isDirectory: true)
  }

  /// Assistant IDs are server data, so file names are their hashes and can never escape the folder.
  static func conversationURL(account: String, botId: String, root: URL? = Self.root) -> URL? {
    guard !botId.isEmpty, let folder = accountDirectory(account: account, root: root) else { return nil }
    let name = SHA256.hash(data: Data(botId.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
    return folder.appendingPathComponent(name + ".json")
  }

  static func readConfig(root: URL? = Self.root) -> NotificationPrefetchConfig? {
    guard let url = configURL(root: root), let data = try? Data(contentsOf: url),
      let config = try? JSONDecoder().decode(NotificationPrefetchConfig.self, from: data),
      NotificationSenders.isAccountMarker(config.account),
      validOrigin(config.origin) != nil
    else { return nil }
    return config
  }

  /// Writes the active account config and removes cached chats belonging to any other account.
  static func writeConfig(_ config: NotificationPrefetchConfig?, root: URL? = Self.root) {
    guard let root else { return }
    let manager = FileManager.default
    guard let config, NotificationSenders.isAccountMarker(config.account), validOrigin(config.origin) != nil else {
      clear(root: root)
      return
    }
    ensureDirectory(root)
    let keep = accountDirectory(account: config.account, root: root)?.standardizedFileURL
    let configFile = configURL(root: root)?.standardizedFileURL
    for entry in (try? manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [] {
      let standardized = entry.standardizedFileURL
      if standardized != keep && standardized != configFile {
        try? manager.removeItem(at: entry)
      }
    }
    if readConfig(root: root) == config { return }
    guard let url = configURL(root: root), let data = try? JSONEncoder().encode(config) else { return }
    try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  static func clear(root: URL? = Self.root) {
    guard let root else { return }
    try? FileManager.default.removeItem(at: root)
  }

  @discardableResult
  static func save(_ entry: PrefetchedConversation, root: URL? = Self.root) -> Bool {
    guard entry.payload.count <= maximumBytes,
      let root,
      let folder = accountDirectory(account: entry.account, root: root),
      let file = conversationURL(account: entry.account, botId: entry.botId, root: root),
      let encoded = try? JSONEncoder().encode(entry)
    else { return false }
    ensureDirectory(root)
    ensureDirectory(folder)
    do {
      try encoded.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      prune(in: folder, keeping: file)
      return true
    } catch {
      return false
    }
  }

  static func read(account: String, botId: String, root: URL? = Self.root, now: Date = Date()) -> PrefetchedConversation? {
    guard let file = conversationURL(account: account, botId: botId, root: root) else { return nil }
    return readFile(file, expectedAccount: account, expectedBotId: botId, now: now)
  }

  static func readAll(account: String, root: URL? = Self.root, now: Date = Date()) -> [PrefetchedConversation] {
    guard let folder = accountDirectory(account: account, root: root) else { return [] }
    let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
    return files
      .filter { $0.pathExtension == "json" }
      .compactMap { readFile($0, expectedAccount: account, expectedBotId: nil, now: now) }
      .sorted { $0.fetchedAt < $1.fetchedAt }
  }

  static func remove(account: String, botId: String, root: URL? = Self.root) {
    guard let file = conversationURL(account: account, botId: botId, root: root) else { return }
    try? FileManager.default.removeItem(at: file)
  }

  /// Validates the stored server origin: HTTPS, or loopback HTTP for local development.
  static func validOrigin(_ raw: String) -> URL? {
    guard let url = URL(string: raw),
      let host = url.host?.lowercased(), !host.isEmpty,
      url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
      ["", "/"].contains(url.path),
      url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host))
    else { return nil }
    return url
  }

  private static func readFile(_ file: URL, expectedAccount: String, expectedBotId: String?, now: Date) -> PrefetchedConversation? {
    let maxEnvelopeBytes = maximumBytes + 64 * 1024
    guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize,
      size <= maxEnvelopeBytes,
      let data = try? Data(contentsOf: file),
      let entry = try? JSONDecoder().decode(PrefetchedConversation.self, from: data),
      entry.account == expectedAccount,
      expectedBotId == nil || entry.botId == expectedBotId,
      entry.payload.count <= maximumBytes,
      now.timeIntervalSince(entry.fetchedAt) < maximumAge
    else {
      try? FileManager.default.removeItem(at: file)
      return nil
    }
    return entry
  }

  private static func ensureDirectory(_ directory: URL) {
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var dir = directory
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? dir.setResourceValues(values)
  }

  private static func prune(in folder: URL, keeping kept: URL) {
    let manager = FileManager.default
    let files = ((try? manager.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [])
      .filter { $0.pathExtension == "json" }
    guard files.count > maximumChats else { return }
    let keptPath = kept.standardizedFileURL.path
    let candidates = files.filter { $0.standardizedFileURL.path != keptPath }
    let ordered = candidates.sorted { lhs, rhs in
      let left = (try? lhs.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
      let right = (try? rhs.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
      return left < right
    }
    for old in ordered.prefix(files.count - maximumChats) {
      try? manager.removeItem(at: old)
    }
  }
}

/// Keeps bearer tokens on the exact configured origin by refusing cross-origin redirects.
private final class PrefetchSessionDelegate: NSObject, URLSessionTaskDelegate, Sendable {
  let origin: URL
  init(origin: URL) { self.origin = origin }

  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    guard let url = request.url,
      url.scheme == origin.scheme,
      url.host?.lowercased() == origin.host?.lowercased(),
      url.port == origin.port
    else {
      completionHandler(nil)
      return
    }
    completionHandler(request)
  }
}

/// Minimal header check so the extension validates the payload without linking full UI models.
private struct ConversationEnvelope: Decodable {
  let botId: String
}

/// Fetches the latest conversation page when an alert push arrives so opening the app renders
/// the new message immediately. Bounded by a short timeout so slow networks never stall alerts.
enum NotificationPrefetcher {
  static let defaultTimeout: Duration = .seconds(2.5)
  static let historyPageTurns = 20

  static func encodedComponent(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_"))) ?? value
  }

  static func conversationURL(origin: URL, botId: String) -> URL? {
    let path = "/api/bots/\(encodedComponent(botId))/conversation?turns=\(historyPageTurns)"
    guard let url = URL(string: path, relativeTo: origin)?.absoluteURL,
      url.scheme == origin.scheme,
      url.host?.lowercased() == origin.host?.lowercased(),
      url.port == origin.port
    else { return nil }
    return url
  }

  /// Prefetches `target`'s conversation into `root`. Returns `true` when a validated response was written.
  @discardableResult
  static func prefetch(
    target: NotificationPrefetchTarget?,
    root: URL? = NotificationPrefetchStore.root,
    tokenProvider: @Sendable (String) -> String? = { PrefetchKeychain.read(host: $0) },
    session: URLSession? = nil,
    timeout: Duration = defaultTimeout,
    now: @Sendable () -> Date = Date.init
  ) async -> Bool {
    guard let target,
      let config = NotificationPrefetchStore.readConfig(root: root),
      config.account == target.account,
      let origin = NotificationPrefetchStore.validOrigin(config.origin),
      let token = tokenProvider(config.origin), !token.isEmpty,
      let requestURL = conversationURL(origin: origin, botId: target.botId)
    else { return false }

    let started = now()
    let timeoutSeconds = Double(timeout.components.seconds) + Double(timeout.components.attoseconds) / 1e18
    var request = URLRequest(url: requestURL)
    request.httpMethod = "GET"
    request.timeoutInterval = max(0.5, timeoutSeconds)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.httpShouldHandleCookies = false
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("no-store", forHTTPHeaderField: "Cache-Control")

    let delegate = PrefetchSessionDelegate(origin: origin)
    let ownedSession: URLSession?
    let activeSession: URLSession
    if let session {
      ownedSession = nil
      activeSession = session
    } else {
      let configuration = URLSessionConfiguration.ephemeral
      configuration.urlCache = nil
      configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
      configuration.httpCookieStorage = nil
      configuration.timeoutIntervalForRequest = max(0.5, timeoutSeconds)
      configuration.timeoutIntervalForResource = max(0.5, timeoutSeconds)
      let created = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
      ownedSession = created
      activeSession = created
    }
    defer { ownedSession?.invalidateAndCancel() }

    let finalRequest = request
    let responsePair: (Data, URLResponse)? = await withTaskGroup(of: (Data, URLResponse)?.self) { group in
      group.addTask {
        try? await activeSession.data(for: finalRequest, delegate: delegate)
      }
      group.addTask {
        try? await Task.sleep(for: timeout)
        return nil
      }
      let first = await group.next() ?? nil
      group.cancelAll()
      return first
    }

    guard !Task.isCancelled,
      let (data, response) = responsePair,
      let http = response as? HTTPURLResponse,
      http.statusCode == 200,
      data.count <= NotificationPrefetchStore.maximumBytes,
      let envelope = try? JSONDecoder().decode(ConversationEnvelope.self, from: data),
      envelope.botId == target.botId
    else { return false }

    // Re-check after the network round-trip: sign-out or account switch meanwhile discards this copy.
    guard NotificationPrefetchStore.readConfig(root: root) == config else { return false }

    let entry = PrefetchedConversation(
      botId: target.botId,
      account: target.account,
      fetchedAt: started,
      etag: http.value(forHTTPHeaderField: "ETag"),
      payload: data
    )
    return NotificationPrefetchStore.save(entry, root: root)
  }
}
