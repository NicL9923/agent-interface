import CryptoKit
import Foundation

/// The link protocol version this app speaks. See docs/MacLink.md, "Protocol, version 1".
public let linkProtocolVersion = 1
/// The server drops frames above 8 MiB; the app never sends one that large.
public let maxFrameBytes = 8 * 1024 * 1024

/// Error codes the Mac reports in a result. The raw values are the wire contract.
public enum ErrorCode: String, Sendable, CaseIterable, Codable {
  case notAllowed = "not_allowed"
  case unattendedNotAllowed = "unattended_not_allowed"
  case paused
  case outsideFolders = "outside_folders"
  case protectedPath = "protected_path"
  case notFound = "not_found"
  case notAFile = "not_a_file"
  case notADirectory = "not_a_directory"
  case tooLarge = "too_large"
  case conflict
  case exists
  case hardLink = "hard_link"
  case busy
  case inProgress = "in_progress"
  case uncertain
  case permissionNeeded = "permission_needed"
  case screenLocked = "screen_locked"
  case invalidArguments = "invalid_arguments"
  case sandboxUnavailable = "sandbox_unavailable"
  case failed
}

public struct ActionError: Error, Equatable, Sendable, CustomStringConvertible {
  /// The longest message the Mac journals or sends, in UTF-16 code units as the server counts.
  public static let maxMessageLength = 2000
  /// The longest path quoted inside a message; longer ones keep their start and end.
  public static let maxQuotedPathLength = 300

  public var code: ErrorCode
  /// Always at most `maxMessageLength`, however it is set.
  public var message: String {
    didSet { if message.utf16.count > Self.maxMessageLength { message = Self.bounded(message) } }
  }
  public init(_ code: ErrorCode, _ message: String) {
    self.code = code
    self.message = Self.bounded(message)
  }
  public var description: String { "\(code.rawValue): \(message)" }

  /// Cuts `text` to `maxMessageLength` with a trailing ellipsis, never inside a character.
  static func bounded(_ text: String) -> String {
    guard text.utf16.count > maxMessageLength else { return text }
    return prefix(text, utf16Budget: maxMessageLength - 1) + "…"
  }

  /// A path short enough to quote: its start and end around an ellipsis.
  public static func quoted(_ path: String) -> String {
    guard path.utf16.count > maxQuotedPathLength else { return path }
    let half = (maxQuotedPathLength - 1) / 2
    let head = prefix(path, utf16Budget: half)
    var tail = ""
    var used = 0
    for character in path.reversed() {
      used += character.utf16.count
      if used > half { break }
      tail.insert(character, at: tail.startIndex)
    }
    return head + "…" + tail
  }

  private static func prefix(_ text: String, utf16Budget: Int) -> String {
    var result = ""
    var used = 0
    for character in text {
      used += character.utf16.count
      if used > utf16Budget { break }
      result.append(character)
    }
    return result
  }
}

/// What a finished invocation answers: a value or an error. Stored verbatim in the journal so a
/// result can be resent unchanged after a reconnect.
public enum ActionOutcome: Equatable, Sendable {
  case success(JSONValue)
  case failure(ActionError)

  public var json: JSONValue {
    switch self {
    case .success(let value): return ["ok": true, "value": value]
    case .failure(let error):
      return ["ok": false, "error": ["code": .string(error.code.rawValue), "message": .string(error.message)]]
    }
  }
  public init?(json: JSONValue) {
    switch json["ok"]?.boolValue {
    case true?:
      self = .success(json["value"] ?? .null)
    case false?:
      guard let raw = json["error"]?["code"]?.stringValue, let code = ErrorCode(rawValue: raw) else { return nil }
      self = .failure(ActionError(code, json["error"]?["message"]?.stringValue ?? ""))
    case nil:
      return nil
    }
  }
  public var errorCode: ErrorCode? { if case .failure(let error) = self { return error.code }; return nil }
}

/// One `invoke` from the server, with its fields checked for type but its arguments not yet
/// validated against the action (see `ActionRequest`).
public struct Invocation: Equatable, Sendable {
  public var id: String
  public var assistantId: String
  public var assistantName: String?
  public var scheduled: Bool
  public var action: String
  public var args: [String: JSONValue]
  public var timeoutMs: Int?
  /// Identifies what was asked, so a reused ID with different arguments is caught. It covers the
  /// assistant, the scheduled flag, the action and its arguments, not display names or deadlines.
  public var fingerprint: String

  public init(
    id: String, assistantId: String, assistantName: String? = nil, scheduled: Bool, action: String,
    args: [String: JSONValue] = [:], timeoutMs: Int? = nil
  ) {
    self.id = id
    self.assistantId = assistantId
    self.assistantName = assistantName
    self.scheduled = scheduled
    self.action = action
    self.args = args
    self.timeoutMs = timeoutMs
    fingerprint = Invocation.fingerprint(
      assistantId: .string(assistantId), scheduled: .bool(scheduled), action: .string(action), args: .object(args))
  }

  static func fingerprint(assistantId: JSONValue?, scheduled: JSONValue?, action: JSONValue?, args: JSONValue?) -> String {
    let canonical: JSONValue = [
      "assistantId": assistantId ?? .null, "scheduled": scheduled ?? .null, "action": action ?? .null,
      "args": args ?? .object([:]),
    ]
    let digest = SHA256.hash(data: Data(canonical.serialized.utf8))
    return digest.map { String(format: "%02x", $0) }.joined()
  }
}

/// An `invoke` whose ID could be read but whose other fields are malformed. It still gets a
/// journaled `invalid_arguments` result so the server's waiting call ends.
public struct MalformedInvocation: Equatable, Sendable {
  public var id: String
  public var fingerprint: String
  public var assistantId: String?
  public var error: ActionError
}

public enum InboundMessage: Equatable, Sendable {
  case welcome(protocolVersion: Int)
  case invoke(Invocation)
  case malformedInvoke(MalformedInvocation)
  case ack(id: String)
  case revoked
  /// Valid JSON the app does not act on, such as an unknown type from a newer server.
  case ignored(reason: String)
}

/// The longest invocation ID the app accepts; the server's IDs are far shorter.
let maxInvocationIdLength = 200

public enum LinkCodec {
  /// Reads one server frame. Malformed frames become `.ignored` with the reason, never a crash.
  public static func decode(_ text: String) -> InboundMessage {
    guard text.utf8.count <= maxFrameBytes else { return .ignored(reason: "frame larger than 8 MiB") }
    guard let json = try? JSONValue.parse(text), let fields = json.objectValue else {
      return .ignored(reason: "frame is not a JSON object")
    }
    switch fields["type"]?.stringValue {
    case "welcome"?:
      guard let version = fields["protocol"]?.intValue else { return .ignored(reason: "welcome without a protocol number") }
      return .welcome(protocolVersion: version)
    case "ack"?:
      guard let id = fields["id"]?.stringValue, !id.isEmpty else { return .ignored(reason: "ack without an id") }
      return .ack(id: id)
    case "revoked"?:
      return .revoked
    case "invoke"?:
      return decodeInvoke(fields)
    case let other?:
      return .ignored(reason: "unknown message type \(other)")
    case nil:
      return .ignored(reason: "message without a type")
    }
  }

  static func decodeInvoke(_ fields: [String: JSONValue]) -> InboundMessage {
    guard let id = fields["id"]?.stringValue, !id.isEmpty, id.utf16.count <= maxInvocationIdLength else {
      return .ignored(reason: "invoke without a usable id")
    }
    let fingerprint = Invocation.fingerprint(
      assistantId: fields["assistantId"], scheduled: fields["scheduled"], action: fields["action"], args: fields["args"])
    func malformed(_ message: String) -> InboundMessage {
      .malformedInvoke(
        MalformedInvocation(
          id: id, fingerprint: fingerprint, assistantId: fields["assistantId"]?.stringValue,
          error: ActionError(.invalidArguments, message)))
    }
    guard let assistantId = fields["assistantId"]?.stringValue, !assistantId.isEmpty, assistantId.utf16.count <= 200 else {
      return malformed("The invocation has no assistantId.")
    }
    // A missing flag is not read as "attended": the unattended switch must never be bypassed by omission.
    guard let scheduled = fields["scheduled"]?.boolValue else { return malformed("The invocation has no scheduled flag.") }
    guard let action = fields["action"]?.stringValue, !action.isEmpty else { return malformed("The invocation has no action.") }
    var args: [String: JSONValue] = [:]
    if let raw = fields["args"], raw != .null {
      guard let object = raw.objectValue else { return malformed("args must be an object.") }
      args = object
    }
    var timeoutMs: Int?
    if let raw = fields["timeoutMs"], raw != .null {
      guard let value = raw.intValue, value > 0 else { return malformed("timeoutMs must be a positive integer.") }
      timeoutMs = value
    }
    var invocation = Invocation(
      id: id, assistantId: assistantId, assistantName: fields["assistantName"]?.stringValue, scheduled: scheduled,
      action: action, args: args, timeoutMs: timeoutMs)
    invocation.fingerprint = fingerprint
    return .invoke(invocation)
  }

  public static func hello(appVersion: String, state: MacState) -> String {
    JSONValue.object([
      "type": "hello", "protocol": .int(linkProtocolVersion), "appVersion": .string(appVersion), "state": state.json,
    ]).serialized
  }
  public static func state(_ state: MacState) -> String {
    JSONValue.object(["type": "state", "state": state.json]).serialized
  }
  public static func result(id: String, outcome: ActionOutcome) -> String {
    var fields = outcome.json.objectValue ?? [:]
    fields["type"] = "result"
    fields["id"] = .string(id)
    return JSONValue.object(fields).serialized
  }
}

public enum ScreenPermission: String, Sendable, Codable {
  case granted, denied, unknown
}

/// What the Mac tells the server about itself in `hello` and `state`.
public struct MacState: Equatable, Sendable {
  public struct Folder: Equatable, Sendable {
    public var name: String
    public var path: String
    public init(name: String, path: String) {
      self.name = name
      self.path = path
    }
  }
  public struct Grant: Equatable, Sendable {
    public var assistantId: String
    public var abilities: [Ability]
    public var unattended: Bool
    public init(assistantId: String, abilities: [Ability], unattended: Bool) {
      self.assistantId = assistantId
      self.abilities = abilities
      self.unattended = unattended
    }
  }
  public var paused: Bool
  public var screenLocked: Bool
  public var screenPermission: ScreenPermission
  public var folders: [Folder]
  public var grants: [Grant]

  public init(paused: Bool, screenLocked: Bool, screenPermission: ScreenPermission, folders: [Folder], grants: [Grant]) {
    self.paused = paused
    self.screenLocked = screenLocked
    self.screenPermission = screenPermission
    self.folders = folders
    self.grants = grants
  }

  public var json: JSONValue {
    .object([
      "paused": .bool(paused), "screenLocked": .bool(screenLocked), "screenPermission": .string(screenPermission.rawValue),
      "folders": .array(folders.map { ["name": .string($0.name), "path": .string($0.path)] }),
      "grants": .array(
        grants.map {
          [
            "assistantId": .string($0.assistantId), "abilities": .array($0.abilities.map { .string($0.rawValue) }),
            "unattended": .bool($0.unattended),
          ]
        }),
    ])
  }
}
