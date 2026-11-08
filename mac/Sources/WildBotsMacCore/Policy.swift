import Darwin
import Foundation

public enum Ability: String, Sendable, Codable, CaseIterable, Hashable {
  case filesRead = "files_read"
  case filesWrite = "files_write"
  case run
  case screenshot
}

/// What one assistant may do on this Mac. Only the person changes this, in the app.
public struct Grant: Equatable, Sendable, Codable, Identifiable {
  public var assistantId: String
  /// The name the person or the server's assistant list gave it, for display only.
  public var assistantName: String
  public var abilities: Set<Ability>
  public var unattended: Bool
  public var id: String { assistantId }
  public init(assistantId: String, assistantName: String, abilities: Set<Ability> = [], unattended: Bool = false) {
    self.assistantId = assistantId
    self.assistantName = assistantName
    self.abilities = abilities
    self.unattended = unattended
  }
}

/// A folder the person chose. `path` is its canonical (symlink-free) path at the time it was added.
public struct FolderGrant: Equatable, Sendable, Codable, Identifiable {
  public var name: String
  public var path: String
  public var id: String { path }
  public init(name: String, path: String) {
    self.name = name
    self.path = path
  }
}

/// The person's policy as saved in Application Support. The command sandbox cannot read or write it.
public struct PolicyDocument: Equatable, Sendable, Codable {
  public var folders: [FolderGrant] = []
  public var grants: [Grant] = []
  /// Personal assistants the server listed while linking, offered when adding a grant.
  public var knownAssistants: [KnownAssistant] = []
  public var paused = false
  public init() {}
  enum CodingKeys: String, CodingKey { case folders, grants, knownAssistants, paused }
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    folders = try container.decodeIfPresent([FolderGrant].self, forKey: .folders) ?? []
    grants = try container.decodeIfPresent([Grant].self, forKey: .grants) ?? []
    knownAssistants = try container.decodeIfPresent([KnownAssistant].self, forKey: .knownAssistants) ?? []
    paused = try container.decodeIfPresent(Bool.self, forKey: .paused) ?? false
  }

  public func grant(for assistantId: String) -> Grant? { grants.first { $0.assistantId == assistantId } }

  public static func load(from url: URL) -> PolicyDocument {
    guard let data = try? Data(contentsOf: url), let document = try? JSONDecoder().decode(PolicyDocument.self, from: data)
    else { return PolicyDocument() }
    return document
  }
  public func save(to url: URL) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try encoder.encode(self).write(to: url, options: [.atomic])
    chmod(url.path, 0o600)
  }
}

public struct KnownAssistant: Equatable, Sendable, Codable, Identifiable, Hashable {
  public var id: String
  public var name: String
  public init(id: String, name: String) {
    self.id = id
    self.name = name
  }
}

/// Paths assistants never reach, even inside a granted folder. Each entry is a run of path
/// components matched anywhere in a path, ignoring case, because APFS volumes are usually
/// case-insensitive and `.SSH` opens `.ssh`.
public enum ProtectedPaths {
  public static let appSupportName = "dev.agentinterface.mac"
  public static let patterns: [[String]] = [
    [".ssh"], [".gnupg"], [".aws"], [".netrc"], [".config", "gh"], [".config", "gcloud"], [".azure"], [".kube"],
    [".docker"], [".git-credentials"], ["Keychains"], [".mozilla"],
    ["Library", "Mail"], ["Library", "Messages"], ["Library", "Safari"], ["Library", "Cookies"],
    ["Library", "LaunchAgents"], ["Library", "LaunchDaemons"],
    ["Library", "Application Support", "Google", "Chrome"],
    ["Library", "Application Support", "Chromium"],
    ["Library", "Application Support", "Firefox"],
    ["Library", "Application Support", "BraveSoftware"],
    ["Library", "Application Support", "Microsoft Edge"],
    ["Library", "Application Support", "Arc"],
    ["Library", "Application Support", appSupportName],
    ["Library", "Preferences", "\(appSupportName).plist"],
    ["Library", "Containers", "com.apple.mail"],
    ["Library", "Group Containers", "group.com.apple.mail"],
  ]

  /// The protected pattern a path falls under, or nil. `components` are the absolute path's components.
  public static func match(_ components: [String]) -> [String]? {
    let lowered = components.map { $0.lowercased() }
    for pattern in patterns {
      let target = pattern.map { $0.lowercased() }
      guard target.count <= lowered.count else { continue }
      for start in 0...(lowered.count - target.count) where Array(lowered[start..<start + target.count]) == target {
        return pattern
      }
    }
    return nil
  }
}

/// Checks a folder the person picked before it becomes a grant.
public enum FolderValidator {
  public enum Refusal: Error, Equatable, CustomStringConvertible {
    case notADirectory(String)
    case homeFolder
    case containsHome
    case library
    case systemLocation(String)
    case volumeRoot
    case protected(String)
    case unsupportedCharacters

    public var description: String {
      switch self {
      case .notADirectory(let path): return "\(path) is not a folder."
      case .homeFolder: return "Your home folder itself cannot be added. Choose a folder inside it."
      case .containsHome: return "A folder that contains your home folder cannot be added."
      case .library: return "Folders in ~/Library cannot be added."
      case .systemLocation(let path): return "\(path) is a system or app location and cannot be added."
      case .volumeRoot: return "A whole disk cannot be added. Choose a folder on it."
      case .protected(let pattern): return "Folders under \(pattern) hold credentials and cannot be added."
      case .unsupportedCharacters: return "Folders whose path has quotes or control characters cannot be added."
      }
    }
  }

  /// Top-level locations that are never grantable, nor anything inside them.
  static let systemRoots = [
    "/System", "/Library", "/Applications", "/usr", "/bin", "/sbin", "/private", "/etc", "/var", "/tmp", "/opt",
    "/cores", "/dev", "/Network",
  ]

  /// Returns the canonical path to store, or why it is refused. `home` is the person's home
  /// folder; tests pass a fake one.
  public static func validate(_ path: String, home: String) -> Result<String, Refusal> {
    guard let resolved = realpath(path) else { return .failure(.notADirectory(path)) }
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: resolved, isDirectory: &isDirectory), isDirectory.boolValue else {
      return .failure(.notADirectory(path))
    }
    return check(resolved, home: realpath(home) ?? home)
  }

  /// The checks on an already canonical path, separated so they can be tested without creating
  /// system folders.
  public static func check(_ resolved: String, home: String) -> Result<String, Refusal> {
    if resolved.unicodeScalars.contains(where: { $0 == "\"" || $0.value < 0x20 || $0.value == 0x7f }) {
      return .failure(.unsupportedCharacters)
    }
    let components = pathComponents(resolved)
    let homeComponents = pathComponents(home)
    if components == homeComponents { return .failure(.homeFolder) }
    if components.count < homeComponents.count, Array(homeComponents.prefix(components.count)) == components {
      return .failure(.containsHome)
    }
    if components.isEmpty { return .failure(.containsHome) }
    if isInside(components, homeComponents + ["Library"]) { return .failure(.library) }
    if let pattern = ProtectedPaths.match(components) { return .failure(.protected(pattern.joined(separator: "/"))) }
    // Inside the home folder only ~/Library and credentials are off limits.
    if isInside(components, homeComponents) { return .success(resolved) }
    for root in systemRoots where isInside(components, pathComponents(root)) {
      return .failure(.systemLocation(root))
    }
    if components.first == "Users", components.count == 1 { return .failure(.containsHome) }
    if components.first == "Volumes", components.count <= 2 { return .failure(.volumeRoot) }
    return .success(resolved)
  }

  static func isInside(_ components: [String], _ root: [String]) -> Bool {
    components.count >= root.count
      && zip(components, root).allSatisfy { $0.lowercased() == $1.lowercased() }
  }

  static func realpath(_ path: String) -> String? {
    guard let pointer = Darwin.realpath(path, nil) else { return nil }
    defer { free(pointer) }
    return String(cString: pointer)
  }
}

func pathComponents(_ path: String) -> [String] {
  path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
}
