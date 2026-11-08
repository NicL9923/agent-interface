import Foundation

/// Inputs for one command's sandbox. Every path must already be canonical (no symbolic links),
/// because Seatbelt matches the resolved path: `/tmp` is `/private/tmp` to it.
public struct SandboxConfig: Equatable, Sendable {
  /// The person's home folder. Tests pass a fake one so they never touch the real home.
  public var home: String
  /// Canonical paths of the granted folders: read, write and execute.
  public var grantedFolders: [String]
  /// This command's private temporary folder: read and write.
  public var tempDir: String
  /// The app's own data folder (journal, policy, activity). Always denied.
  public var appDataDir: String
  /// The active developer directory from `xcode-select`, when it lies outside the usual places.
  public var developerDir: String?

  public init(home: String, grantedFolders: [String], tempDir: String, appDataDir: String, developerDir: String? = nil) {
    self.home = home
    self.grantedFolders = grantedFolders
    self.tempDir = tempDir
    self.appDataDir = appDataDir
    self.developerDir = developerDir
  }
}

/// Builds the Seatbelt profile a command runs under. It starts from Codex's closed-by-default
/// base, its minimal platform read list and its network helpers (Sandbox/README.md), then adds
/// WildBots' own rules. Seatbelt applies the last matching rule, so the denies come last.
public enum SandboxPolicy {
  /// Developer tools that commands may read and run, but never change.
  static let toolRoots = [
    "/opt/homebrew", "/usr/local", "/Library/Developer", "/Library/Frameworks", "/System/Library",
    "/System/Cryptexes", "/private/var/select",
  ]
  static let homeToolPaths = [".cargo", ".rustup", ".nvm", ".pyenv", ".local/bin", ".gitconfig", ".config/git"]

  public static func build(_ config: SandboxConfig) -> String {
    var lines: [String] = [
      EmbeddedPolicies.base,
      EmbeddedPolicies.platformDefaults,
      EmbeddedPolicies.network,
      "",
      "; ---- WildBots additions (see mac/Sandbox/README.md) ----",
      "",
      "; Network: IP sockets only. Unix-domain sockets stay closed, so a command cannot reach",
      "; ssh-agent, Docker or other local daemons; DNS goes through mDNSResponder.",
      "(allow network-outbound (remote ip))",
      "(allow network-inbound (local ip))",
      "(allow network-bind (local ip))",
      "(allow network-outbound (literal \"/private/var/run/mDNSResponder\"))",
      "",
      "; Developer tools: read and execute, never write.",
    ]
    var tools = toolRoots.map { "(subpath \(quote($0)))" }
    tools.append("(regex #\"^/Applications/Xcode[^/]*\\.app(/|$)\")")
    if let developer = config.developerDir { tools.append("(subpath \(quote(developer)))") }
    lines.append("(allow file-read* file-map-executable \(tools.joined(separator: " ")))")
    let homeTools = homeToolPaths.map { "(subpath \(quote(config.home + "/" + $0)))" }
    lines.append("(allow file-read* file-map-executable \(homeTools.joined(separator: " ")))")

    lines.append("")
    lines.append("; Stat (never list) the folders above granted folders and the home tool paths, so")
    lines.append("; tools that check their ancestors, such as Git looking for a repository, work.")
    var ancestors = Set<String>()
    for path in config.grantedFolders + [config.tempDir, config.home] {
      var parts = pathComponents(path)
      while !parts.isEmpty {
        parts.removeLast()
        ancestors.insert("/" + parts.joined(separator: "/"))
      }
    }
    ancestors.insert(config.home)
    if !ancestors.isEmpty {
      let literals = ancestors.sorted().map { "(literal \(quote($0)))" }.joined(separator: " ")
      lines.append("(allow file-read-metadata file-test-existence \(literals))")
    }

    lines.append("")
    lines.append("; Granted folders and this command's private temporary folder.")
    for folder in config.grantedFolders {
      lines.append("(allow file-read* file-write* file-map-executable (subpath \(quote(folder))))")
    }
    lines.append("(allow file-read* file-write* file-map-executable (subpath \(quote(config.tempDir))))")

    lines.append("")
    lines.append("; Denies win over everything above.")
    lines.append("(deny appleevent-send)")
    let own = [
      config.appDataDir, config.home + "/Library/Application Support/" + ProtectedPaths.appSupportName,
      config.home + "/Library/Keychains", config.home + "/Library/LaunchAgents", "/Library/LaunchAgents",
      "/Library/LaunchDaemons", "/Library/Keychains",
    ]
    lines.append("(deny file-read* file-write* \(own.map { "(subpath \(quote($0)))" }.joined(separator: " ")))")
    lines.append(
      "(deny file-read* file-write* (literal \(quote(config.home + "/Library/Preferences/" + ProtectedPaths.appSupportName + ".plist"))))"
    )
    for folder in config.grantedFolders + [config.tempDir] {
      for pattern in ProtectedPaths.patterns {
        let tail = pattern.map(caseInsensitive).joined(separator: "/")
        lines.append("(deny file-read* file-write* (regex #\"^\(regexEscape(folder))(/.*)?/\(tail)(/|$)\"))")
      }
    }
    return lines.joined(separator: "\n") + "\n"
  }

  /// An SBPL string literal. Folder validation refuses quotes and control characters; the
  /// escaping is a second line of defense.
  static func quote(_ value: String) -> String {
    "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
  }

  /// Escapes POSIX extended regular expression metacharacters for a `#"…"` literal.
  static func regexEscape(_ value: String) -> String {
    var out = ""
    for character in value {
      if "\\.[](){}*+?|^$".contains(character) { out.append("\\") }
      if character == "\"" {
        out += "\\x22"
        continue
      }
      out.append(character)
    }
    return out
  }

  /// `[sS][sS][hH]` for `ssh`: Seatbelt regexes have no case-insensitive flag.
  static func caseInsensitive(_ component: String) -> String {
    var out = ""
    for character in component {
      let lower = character.lowercased(), upper = character.uppercased()
      if lower != upper, lower.count == 1, upper.count == 1 {
        out += "[\(lower)\(upper)]"
      } else {
        out += regexEscape(String(character))
      }
    }
    return out
  }
}
