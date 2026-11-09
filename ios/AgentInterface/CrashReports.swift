import Foundation
import MetricKit

/// One crash or hang, shaped for `POST /api/client-errors`, the route the web client uses for its
/// render crashes. The limits mirror `CLIENT_ERROR_LIMITS` in src/shared/api.ts.
struct CrashReport: Codable, Equatable {
  enum Kind: String, Codable { case crash, hang }
  static let maxMessage = 1024, maxStack = 8192, maxRelease = 64
  /// Frames kept from the top of the call stack.
  static let maxFrames = 24
  var kind: Kind
  var platform = "ios"
  var message: String
  var stack: String?
  /// A path only: the server refuses a query or hash.
  var route: String
  var release: String?
}

extension CrashReport {
  /// Builds a report from MetricKit's `jsonRepresentation()` of a crash or hang diagnostic, which
  /// holds `diagnosticMetaData` and a `callStackTree`. The version and build come from the
  /// diagnostic, since the crash may have happened in an older build than the one now running;
  /// `fallback` fills in what the diagnostic omits. An unreadable diagnostic still yields a report.
  static func make(kind: Kind, json: Data, fallbackVersion: String?, fallbackBuild: String?) -> CrashReport {
    let root = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any] ?? [:]
    let meta = root["diagnosticMetaData"] as? [String: Any] ?? [:]
    let version = text(meta["appVersion"]) ?? fallbackVersion
    let build = text(meta["appBuildVersion"]) ?? fallbackBuild
    let label = [version, build.map { "(\($0))" }].compactMap { $0 }.joined(separator: " ")
    var parts: [String] = []
    switch kind {
    case .crash:
      parts.append("Crash")
      if let type = int(meta["exceptionType"]) { parts.append(exceptionTypes[type] ?? "exception type \(type)") }
      if let signal = int(meta["signal"]) { parts.append("(\(signals[signal] ?? "signal \(signal)"))") }
      if let code = int(meta["exceptionCode"]) { parts.append("code \(code)") }
      if let reason = text(meta["terminationReason"]) { parts.append("terminated: \(reason)") }
    case .hang:
      parts.append("Hang")
      if let duration = text(meta["hangDuration"]) { parts.append("for \(duration)") }
    }
    if !label.isEmpty { parts.append("in \(label)") }
    return CrashReport(
      kind: kind,
      message: clean(parts.joined(separator: " "), limit: maxMessage),
      stack: stack(root["callStackTree"]).map { String($0.prefix(maxStack)) },
      route: kind == .crash ? "/ios/crash" : "/ios/hang",
      release: release(version: version, build: build))
  }

  /// `<marketing>-<build>`, restricted to what the server's release pattern allows.
  static func release(version: String?, build: String?) -> String? {
    guard let version, !version.isEmpty else { return nil }
    let value = [version, build].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "-")
    let safe = String(value.map { $0.isASCII && ($0.isLetter || $0.isNumber || "._-".contains($0)) ? $0 : "-" })
    return String(safe.prefix(maxRelease))
  }

  /// The top frames as `index Binary +0xoffset`, innermost first, one per line. Follows the
  /// attributed thread's heaviest branch: a crash has one chain, a hang's busiest path is the likely
  /// culprit. A per-thread tree, as crashes and hangs send, starts at the innermost frame and nests
  /// its callers; an aggregated one starts at the outermost and nests callees. Nothing but binary names and offsets, never an address a process could be located by
  /// or any path.
  static func stack(_ tree: Any?) -> String? {
    guard let tree = tree as? [String: Any], let stacks = tree["callStacks"] as? [[String: Any]] else { return nil }
    let perThread = tree["callStackPerThread"] as? Bool ?? true
    let attributed = stacks.first { $0["threadAttributed"] as? Bool == true } ?? stacks.first
    var frames: [[String: Any]] = []
    var level = attributed?["callStackRootFrames"] as? [[String: Any]] ?? []
    while let next = level.max(by: { (int($0["sampleCount"]) ?? 0) < (int($1["sampleCount"]) ?? 0) }) {
      frames.append(next)
      level = next["subFrames"] as? [[String: Any]] ?? []
    }
    let innermostFirst = perThread ? frames : frames.reversed()
    let lines = innermostFirst.prefix(maxFrames).enumerated().map { index, frame in
      let name = text(frame["binaryName"]) ?? "?"
      let offset = int(frame["offsetIntoBinaryTextSegment"]).map { "+0x" + String($0, radix: 16) } ?? ""
      return "\(index) \(name) \(offset)".trimmingCharacters(in: .whitespaces)
    }
    return lines.isEmpty ? nil : lines.joined(separator: "\n")
  }

  /// Drops the query and hash from anything that reads as a URL or path, then bounds the length.
  static func clean(_ value: String, limit: Int) -> String {
    let words = value.split(separator: " ", omittingEmptySubsequences: false).map { word -> String in
      guard word.contains("/"), let cut = word.firstIndex(where: { $0 == "?" || $0 == "#" }) else { return String(word) }
      return String(word[..<cut])
    }
    return String(words.joined(separator: " ").prefix(limit))
  }

  private static func text(_ value: Any?) -> String? {
    switch value {
    case let string as String: string.isEmpty ? nil : string
    case let number as NSNumber: number.stringValue
    default: nil
    }
  }
  private static func int(_ value: Any?) -> Int? {
    switch value {
    case let number as NSNumber: number.intValue
    case let string as String: Int(string)
    default: nil
    }
  }
  private static let exceptionTypes = [
    1: "EXC_BAD_ACCESS", 2: "EXC_BAD_INSTRUCTION", 3: "EXC_ARITHMETIC", 4: "EXC_EMULATION", 5: "EXC_SOFTWARE",
    6: "EXC_BREAKPOINT", 7: "EXC_SYSCALL", 8: "EXC_MACH_SYSCALL", 9: "EXC_RPC_ALERT", 10: "EXC_CRASH",
    11: "EXC_RESOURCE", 12: "EXC_GUARD", 13: "EXC_CORPSE_NOTIFY",
  ]
  private static let signals = [
    1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 4: "SIGILL", 5: "SIGTRAP", 6: "SIGABRT", 7: "SIGEMT", 8: "SIGFPE",
    9: "SIGKILL", 10: "SIGBUS", 11: "SIGSEGV", 12: "SIGSYS", 13: "SIGPIPE", 14: "SIGALRM", 15: "SIGTERM",
  ]
}

/// Holds crash reports until they can go to the app server, and sends them one at a time. Reports
/// wait in memory for this launch only, a few at most, while signed out or offline. A 429 drops
/// everything waiting instead of retrying; so does any other refusal of that one report.
@MainActor final class CrashReporter {
  static let shared = CrashReporter()
  static let maxPending = 5
  var pending: [CrashReport] = []
  private var sending = false
  /// The signed-in client right now, or nil. Set by the app from its store.
  var api: () -> APIClient? = { nil }

  func receive(_ reports: [CrashReport]) {
    pending.append(contentsOf: reports.prefix(max(0, Self.maxPending - pending.count)))
    Task { await flush() }
  }

  /// Sends what waits, if someone is signed in. Safe to call often.
  func flush() async {
    guard !sending else { return }
    sending = true
    defer { sending = false }
    while let report = pending.first, let api = api(), api.token != nil {
      do {
        let _: ReportAck = try await api.write("/client-errors", report)
        pending.removeFirst()
      } catch let problem as APIError {
        // Offline or signed out: it waits for the next flush.
        if problem.code == "CONNECTION_UNAVAILABLE" || problem.status == 401 { return }
        // Rate limited or refused: the report is not worth a loop. A limit applies to the rest too.
        if problem.status == 429 { pending.removeAll() } else { pending.removeFirst() }
      } catch { return }
    }
  }
  private struct ReportAck: Decodable { var ok: Bool }
}

/// Subscribes to MetricKit, which hands the app the crashes and hangs of earlier launches.
final class CrashDiagnosticsSubscriber: NSObject, MXMetricManagerSubscriber, @unchecked Sendable {
  static let shared = CrashDiagnosticsSubscriber()
  func start() { MXMetricManager.shared.add(self) }
  func didReceive(_ payloads: [MXDiagnosticPayload]) {
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
    var reports: [CrashReport] = []
    for payload in payloads {
      for diagnostic in payload.crashDiagnostics ?? [] {
        reports.append(.make(kind: .crash, json: diagnostic.jsonRepresentation(), fallbackVersion: version, fallbackBuild: build))
      }
      for diagnostic in payload.hangDiagnostics ?? [] {
        reports.append(.make(kind: .hang, json: diagnostic.jsonRepresentation(), fallbackVersion: version, fallbackBuild: build))
      }
    }
    guard !reports.isEmpty else { return }
    let ready = reports
    Task { @MainActor in CrashReporter.shared.receive(ready) }
  }
}
