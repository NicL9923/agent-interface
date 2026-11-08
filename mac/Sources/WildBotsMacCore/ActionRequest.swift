import Foundation

/// Limits from the action table in docs/MacLink.md.
public enum ActionLimits {
  public static let commandLength = 1...16384
  public static let timeoutSeconds = 1...600
  public static let defaultTimeoutSeconds = 120
  public static let readLength = 1...1_048_576
  public static let defaultReadLength = 262_144
  public static let writeBytes = 1_048_576
  public static let listLimit = 1...500
  public static let defaultListLimit = 200
  public static let pathLength = 1...4096
  /// Each output stream keeps its last 64 KiB.
  public static let streamTail = 65_536
}

/// A validated action. Parsing rejects unknown arguments so a misspelled option fails loudly
/// instead of silently taking its default.
public enum ActionRequest: Equatable, Sendable {
  case run(command: String, cwd: String?, timeoutSeconds: Int)
  case readFile(path: String, offset: Int, length: Int)
  case writeFile(path: String, content: Data, expectedSha256: String?, createOnly: Bool)
  case listDir(path: String?, offset: Int, limit: Int)
  case screenshot

  public static func ability(for action: String) -> Ability? {
    switch action {
    case "run": return .run
    case "read_file", "list_dir": return .filesRead
    case "write_file": return .filesWrite
    case "screenshot": return .screenshot
    default: return nil
    }
  }

  public var ability: Ability {
    switch self {
    case .run: return .run
    case .readFile, .listDir: return .filesRead
    case .writeFile: return .filesWrite
    case .screenshot: return .screenshot
    }
  }

  /// What the activity log shows: the command or the path, never file contents.
  public var summary: String {
    switch self {
    case .run(let command, let cwd, _): return cwd.map { "\(command)  (in \($0))" } ?? command
    case .readFile(let path, _, _), .writeFile(let path, _, _, _): return path
    case .listDir(let path, _, _): return path ?? "first folder"
    case .screenshot: return "main display"
    }
  }

  public static func parse(action: String, args: [String: JSONValue]) -> Result<ActionRequest, ActionError> {
    do {
      return .success(try parseThrowing(action: action, args: args))
    } catch let error as ActionError {
      return .failure(error)
    } catch {
      return .failure(ActionError(.invalidArguments, "\(error)"))
    }
  }

  private static func parseThrowing(action: String, args: [String: JSONValue]) throws -> ActionRequest {
    var reader = ArgumentReader(args: args)
    let request: ActionRequest
    switch action {
    case "run":
      let command = try reader.string("command", required: true, allowEmpty: false)!
      guard ActionLimits.commandLength.contains(command.utf16.count) else {
        throw ActionError(.invalidArguments, "command must be 1 to 16384 characters.")
      }
      guard !command.contains("\0") else { throw ActionError(.invalidArguments, "command must not contain a NUL character.") }
      let cwd = try reader.path("cwd", required: false)
      let timeout = try reader.int("timeoutSeconds", range: ActionLimits.timeoutSeconds) ?? ActionLimits.defaultTimeoutSeconds
      request = .run(command: command, cwd: cwd, timeoutSeconds: timeout)
    case "read_file":
      let path = try reader.path("path", required: true)!
      let offset = try reader.int("offset", range: 0...Int.max) ?? 0
      let length = try reader.int("length", range: ActionLimits.readLength) ?? ActionLimits.defaultReadLength
      request = .readFile(path: path, offset: offset, length: length)
    case "write_file":
      let path = try reader.path("path", required: true)!
      let content = try reader.string("content", required: true, allowEmpty: true)!
      let encoding = try reader.string("encoding", required: false, allowEmpty: false) ?? "utf8"
      let data: Data
      switch encoding {
      case "utf8":
        // Count before converting so a huge string is refused without a second copy.
        guard content.utf8.count <= ActionLimits.writeBytes else {
          throw ActionError(.tooLarge, "content is larger than 1 MiB.")
        }
        data = Data(content.utf8)
      case "base64":
        guard content.utf8.count <= (ActionLimits.writeBytes / 3 + 1) * 4 + 4 else {
          throw ActionError(.tooLarge, "content is larger than 1 MiB.")
        }
        guard let decoded = Data(base64Encoded: content) else {
          throw ActionError(.invalidArguments, "content is not valid base64.")
        }
        data = decoded
      default:
        throw ActionError(.invalidArguments, "encoding must be utf8 or base64.")
      }
      guard data.count <= ActionLimits.writeBytes else { throw ActionError(.tooLarge, "content is larger than 1 MiB.") }
      let expected = try reader.string("expectedSha256", required: false, allowEmpty: false)?.lowercased()
      if let value = expected {
        guard value.count == 64, value.allSatisfy({ $0.isHexDigit }) else {
          throw ActionError(.invalidArguments, "expectedSha256 must be 64 hexadecimal characters.")
        }
      }
      let createOnly = try reader.bool("createOnly") ?? false
      if createOnly, expected != nil {
        throw ActionError(.invalidArguments, "createOnly and expectedSha256 cannot be combined.")
      }
      request = .writeFile(path: path, content: data, expectedSha256: expected, createOnly: createOnly)
    case "list_dir":
      let path = try reader.path("path", required: false)
      let offset = try reader.int("offset", range: 0...Int.max) ?? 0
      let limit = try reader.int("limit", range: ActionLimits.listLimit) ?? ActionLimits.defaultListLimit
      request = .listDir(path: path, offset: offset, limit: limit)
    case "screenshot":
      request = .screenshot
    default:
      throw ActionError(.invalidArguments, "Unknown action \(action).")
    }
    if let extra = reader.unread.sorted().first {
      throw ActionError(.invalidArguments, "Unknown argument \(extra) for \(action).")
    }
    return request
  }
}

private struct ArgumentReader {
  var args: [String: JSONValue]
  var unread: Set<String>
  init(args: [String: JSONValue]) {
    self.args = args
    unread = Set(args.keys)
  }

  /// A value that is absent or JSON null counts as not given.
  mutating func take(_ key: String) -> JSONValue? {
    unread.remove(key)
    guard let value = args[key], value != .null else { return nil }
    return value
  }

  mutating func string(_ key: String, required: Bool, allowEmpty: Bool) throws -> String? {
    guard let value = take(key) else {
      if required { throw ActionError(.invalidArguments, "\(key) is required.") }
      return nil
    }
    guard let string = value.stringValue else { throw ActionError(.invalidArguments, "\(key) must be a string.") }
    if !allowEmpty, string.isEmpty { throw ActionError(.invalidArguments, "\(key) must not be empty.") }
    return string
  }

  mutating func path(_ key: String, required: Bool) throws -> String? {
    guard let value = try string(key, required: required, allowEmpty: false) else { return nil }
    guard ActionLimits.pathLength.contains(value.utf8.count) else {
      throw ActionError(.invalidArguments, "\(key) must be at most 4096 bytes.")
    }
    guard !value.unicodeScalars.contains(where: { $0.value == 0 }) else {
      throw ActionError(.invalidArguments, "\(key) must not contain a NUL character.")
    }
    return value
  }

  mutating func int(_ key: String, range: ClosedRange<Int>) throws -> Int? {
    guard let value = take(key) else { return nil }
    guard let number = value.intValue else { throw ActionError(.invalidArguments, "\(key) must be an integer.") }
    guard range.contains(number) else {
      let upper = range.upperBound == Int.max ? "" : " to \(range.upperBound)"
      throw ActionError(.invalidArguments, "\(key) must be \(range.lowerBound)\(upper.isEmpty ? " or more" : upper).")
    }
    return number
  }

  mutating func bool(_ key: String) throws -> Bool? {
    guard let value = take(key) else { return nil }
    guard let flag = value.boolValue else { throw ActionError(.invalidArguments, "\(key) must be true or false.") }
    return flag
  }
}
