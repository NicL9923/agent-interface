import XCTest

@testable import AgentInterface

/// A synthetic MetricKit diagnostic, shaped like `MXCrashDiagnostic.jsonRepresentation()`. Crashes and
/// hangs send per-thread trees, rooted at the innermost frame as in Apple's documented example.
private func diagnostic(meta: [String: Any], frames: [[String: Any]]? = nil, perThread: Bool = true) -> Data {
  var root: [String: Any] = ["diagnosticMetaData": meta]
  if let frames { root["callStackTree"] = ["callStackPerThread": perThread, "callStacks": [["threadAttributed": true, "callStackRootFrames": frames]]] }
  return try! JSONSerialization.data(withJSONObject: root)
}
/// A chain of frames, the first as the root, each next one nested in `subFrames`.
private func chain(_ names: [(String, Int)]) -> [[String: Any]] {
  var inner: [[String: Any]] = []
  for (name, offset) in names.reversed() {
    inner = [["binaryName": name, "offsetIntoBinaryTextSegment": offset, "sampleCount": 1, "address": 4_300_000_000, "subFrames": inner]]
  }
  return inner
}

final class CrashReportTests: XCTestCase {
  private let meta: [String: Any] = [
    "exceptionType": 1, "exceptionCode": 1, "signal": 11, "terminationReason": "Namespace SIGNAL, Code 11 Segmentation fault: 11",
    "appVersion": "1.4.0", "appBuildVersion": "23",
  ]

  func testACrashNamesTheExceptionSignalReasonAndTheBuildItHappenedIn() {
    let report = CrashReport.make(kind: .crash, json: diagnostic(meta: meta), fallbackVersion: "9.9", fallbackBuild: "99")
    XCTAssertEqual(report.kind, .crash)
    XCTAssertEqual(report.platform, "ios")
    XCTAssertEqual(report.message, "Crash EXC_BAD_ACCESS (SIGSEGV) code 1 terminated: Namespace SIGNAL, Code 11 Segmentation fault: 11 in 1.4.0 (23)")
    XCTAssertEqual(report.route, "/ios/crash")
    XCTAssertEqual(report.release, "1.4.0-23", "The diagnostic's build wins over the running one")
  }
  func testAHangReportsItsDurationAndUsesItsOwnRoute() {
    let report = CrashReport.make(kind: .hang, json: diagnostic(meta: ["hangDuration": "3.2 sec", "appVersion": "1.4.0", "appBuildVersion": "23"]), fallbackVersion: nil, fallbackBuild: nil)
    XCTAssertEqual(report.kind, .hang)
    XCTAssertEqual(report.message, "Hang for 3.2 sec in 1.4.0 (23)")
    XCTAssertEqual(report.route, "/ios/hang")
  }
  func testAnUnreadableDiagnosticStillReportsWithTheRunningBuild() {
    let report = CrashReport.make(kind: .crash, json: Data("not json".utf8), fallbackVersion: "1.4.0", fallbackBuild: "23")
    XCTAssertEqual(report.message, "Crash in 1.4.0 (23)")
    XCTAssertNil(report.stack)
    XCTAssertEqual(report.release, "1.4.0-23")
  }
  func testUnknownExceptionAndSignalNumbersStayReadable() {
    let report = CrashReport.make(kind: .crash, json: diagnostic(meta: ["exceptionType": 99, "signal": 77]), fallbackVersion: nil, fallbackBuild: nil)
    XCTAssertEqual(report.message, "Crash exception type 99 (signal 77)")
    XCTAssertNil(report.release, "No version, no release: the field is optional")
  }
  func testTheStackListsTheInnermostFramesFirstAsBinaryAndOffsetOnly() {
    // Per-thread: the faulting frame is the root, and its callers nest down to dyld.
    let frames = chain([("AgentInterface", 255), ("UIKitCore", 0x9f00), ("AgentInterface", 0x1a2b4), ("dyld", 0x10)])
    let stack = CrashReport.make(kind: .crash, json: diagnostic(meta: meta, frames: frames), fallbackVersion: nil, fallbackBuild: nil).stack
    XCTAssertEqual(stack, "0 AgentInterface +0xff\n1 UIKitCore +0x9f00\n2 AgentInterface +0x1a2b4\n3 dyld +0x10")
    XCTAssertFalse(stack?.contains("4300000000") ?? true, "Addresses are not sent")
  }
  func testTheStackKeepsOnlyTheTopFramesAndFitsTheServerLimit() {
    let deep = chain((0..<200).reversed().map { ("Binary\($0)-" + String(repeating: "x", count: 100), $0) })
    let stack = try! XCTUnwrap(CrashReport.make(kind: .crash, json: diagnostic(meta: meta, frames: deep), fallbackVersion: nil, fallbackBuild: nil).stack)
    XCTAssertEqual(stack.split(separator: "\n").count, CrashReport.maxFrames)
    XCTAssertTrue(stack.hasPrefix("0 Binary199-"), "The innermost frame leads")
    XCTAssertLessThanOrEqual(stack.count, CrashReport.maxStack)
  }
  func testAHangFollowsTheBusiestBranch() {
    let busy: [String: Any] = ["binaryName": "Busy", "offsetIntoBinaryTextSegment": 2, "sampleCount": 9, "subFrames": []]
    let idle: [String: Any] = ["binaryName": "Idle", "offsetIntoBinaryTextSegment": 1, "sampleCount": 1, "subFrames": []]
    let root: [[String: Any]] = [["binaryName": "main", "offsetIntoBinaryTextSegment": 0, "sampleCount": 10, "subFrames": [idle, busy]]]
    // An aggregated tree is rooted at the outermost frame, so it reads backwards.
    let stack = CrashReport.make(kind: .hang, json: diagnostic(meta: [:], frames: root, perThread: false), fallbackVersion: nil, fallbackBuild: nil).stack
    XCTAssertEqual(stack, "0 Busy +0x2\n1 main +0x0")
  }
  func testNoCallStackMeansNoStack() {
    XCTAssertNil(CrashReport.stack(nil))
    XCTAssertNil(CrashReport.stack(["callStacks": []]))
  }
  func testTheReleaseMatchesTheServerPatternAndLength() {
    XCTAssertEqual(CrashReport.release(version: "1.4.0", build: "23"), "1.4.0-23")
    XCTAssertEqual(CrashReport.release(version: "1.4 beta", build: "2/3"), "1.4-beta-2-3")
    XCTAssertEqual(CrashReport.release(version: String(repeating: "9", count: 100), build: "1")?.count, CrashReport.maxRelease)
    XCTAssertNil(CrashReport.release(version: nil, build: "23"))
    XCTAssertNil(CrashReport.release(version: "", build: "23"))
  }
  func testTextNeverCarriesAUrlQueryOrHashAndStaysWithinTheLimit() {
    XCTAssertEqual(CrashReport.clean("failed https://x.invalid/a?token=SECRET#frag and /p?q=1 ok? yes", limit: 1024), "failed https://x.invalid/a and /p ok? yes")
    XCTAssertEqual(CrashReport.clean(String(repeating: "a", count: 2000), limit: CrashReport.maxMessage).count, CrashReport.maxMessage)
    let report = CrashReport.make(kind: .crash, json: diagnostic(meta: ["terminationReason": "loading https://x.invalid/app?code=SECRET failed"]), fallbackVersion: nil, fallbackBuild: nil)
    XCTAssertFalse(report.message.contains("SECRET"))
  }

  // MARK: Sending

  @MainActor private func reporter(_ server: FakeServer?) -> CrashReporter {
    let reporter = CrashReporter()
    if let server { let api = server.api(); reporter.api = { api } } else { reporter.api = { nil } }
    return reporter
  }
  private let sample = CrashReport.make(kind: .crash, json: diagnostic(meta: ["exceptionType": 1, "appVersion": "1.4.0", "appBuildVersion": "23"]), fallbackVersion: nil, fallbackBuild: nil)

  @MainActor func testASignedInReportIsPostedWithTheServersFieldsAndNothingElse() async throws {
    let server = FakeServer()
    server.reply = .init(status: 200, body: #"{"ok":true}"#)
    let reporter = reporter(server)
    reporter.pending = [sample]
    await reporter.flush()
    XCTAssertEqual(server.lastRequest?.httpMethod, "POST")
    XCTAssertEqual(server.lastRequest?.url?.path, "/api/client-errors")
    let sent = try server.lastJSON()
    XCTAssertEqual(Set(sent.keys), ["kind", "platform", "message", "route", "release"])
    XCTAssertEqual(sent["kind"] as? String, "crash")
    XCTAssertEqual(sent["platform"] as? String, "ios")
    XCTAssertEqual(sent["route"] as? String, "/ios/crash")
    XCTAssertEqual(sent["release"] as? String, "1.4.0-23")
    XCTAssertTrue(reporter.pending.isEmpty)
  }
  @MainActor func testReportsWaitWhileSignedOutAreBoundedAndSendOnceSignedIn() async throws {
    let reporter = reporter(nil)
    reporter.receive(Array(repeating: sample, count: 9))
    XCTAssertEqual(reporter.pending.count, CrashReporter.maxPending)
    await reporter.flush()
    XCTAssertEqual(reporter.pending.count, CrashReporter.maxPending, "Nothing is dropped for being signed out")
    let server = FakeServer()
    server.reply = .init(status: 200, body: #"{"ok":true}"#)
    let api = server.api()
    reporter.api = { api }
    await reporter.flush()
    XCTAssertEqual(server.requests.count, CrashReporter.maxPending)
    XCTAssertTrue(reporter.pending.isEmpty)
  }
  @MainActor func testARateLimitDropsEverythingWaitingWithoutRetrying() async throws {
    let server = FakeServer()
    server.reply = .init(status: 429, body: #"{"error":"Too many error reports. Try again later."}"#)
    let reporter = reporter(server)
    reporter.pending = [sample, sample, sample]
    await reporter.flush()
    XCTAssertEqual(server.requests.count, 1)
    XCTAssertTrue(reporter.pending.isEmpty)
  }
  @MainActor func testAnOfflineAttemptKeepsTheReportForTheNextFlush() async throws {
    let server = FakeServer()
    server.failing = URLError(.notConnectedToInternet)
    let reporter = reporter(server)
    reporter.pending = [sample]
    await reporter.flush()
    XCTAssertEqual(reporter.pending.count, 1)
    XCTAssertEqual(server.requests.count, 1, "One attempt per flush, not a loop")
    server.failing = nil
    server.reply = .init(status: 200, body: #"{"ok":true}"#)
    await reporter.flush()
    XCTAssertTrue(reporter.pending.isEmpty)
  }
  @MainActor func testARefusedReportIsDroppedAndTheNextOneStillSends() async throws {
    let server = FakeServer { request in
      let body = String(decoding: FakeExchange.body(request) ?? Data(), as: UTF8.self)
      return body.contains("hang") ? .init(status: 400, body: #"{"error":"bad"}"#) : .init(status: 200, body: #"{"ok":true}"#)
    }
    let hang = CrashReport.make(kind: .hang, json: diagnostic(meta: [:]), fallbackVersion: nil, fallbackBuild: nil)
    let reporter = reporter(server)
    reporter.pending = [hang, sample]
    await reporter.flush()
    XCTAssertEqual(server.requests.count, 2)
    XCTAssertTrue(reporter.pending.isEmpty)
  }
}
