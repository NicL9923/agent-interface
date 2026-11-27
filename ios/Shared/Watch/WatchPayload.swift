import Foundation

/// Wire contract between the iPhone app and the Apple Watch companion over `WatchConnectivity`.
/// Never carries sign-in tokens, Keychain credentials, or vault secrets.
enum WatchPayload {
  static let snapshotKey = "snapshot"
  static let signedOutKey = "signedOut"
  static let actionKey = "action"

  /// Strips any non-property-list values so `WatchConnectivity` dictionaries cross concurrency
  /// domains safely in Swift 6.
  nonisolated static func sanitize(_ raw: [String: Any]) -> [String: Any] {
    var clean: [String: Any] = [:]
    if let data = raw[actionKey] as? Data { clean[actionKey] = data }
    if let data = raw[snapshotKey] as? Data { clean[snapshotKey] = data }
    if let signedOut = raw[signedOutKey] as? Bool { clean[signedOutKey] = signedOut }
    return clean
  }
}

/// Command sent from Apple Watch to the paired iPhone. Always carries `scope` so the iPhone
/// rejects stale commands after an account switch or sign-out.
struct WatchAction: Codable, Equatable, Sendable {
  enum Kind: Codable, Equatable, Sendable {
    case stop(botId: String, name: String)
    case decline(botId: String, name: String, approvalId: String)
    case review(botId: String)
    case queueDraft(botId: String, text: String)
    case refresh
  }

  var id = UUID()
  var scope: String
  var kind: Kind
  var sentAt = Date()
}
