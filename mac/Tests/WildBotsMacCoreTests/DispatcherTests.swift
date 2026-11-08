import XCTest

@testable import WildBotsMacCore

/// A screenshot provider that holds every capture until released, to fill the concurrency cap.
final class HeldScreenshots: ScreenshotProvider, @unchecked Sendable {
  private let lock = NSLock()
  private var waiting: [CheckedContinuation<Void, Never>] = []
  private var released = false
  var png = Data([0x89, 0x50, 0x4e, 0x47])
  var count: Int { lock.withLock { waiting.count } }
  func capture(maxWidth: Int) async throws -> Screenshot {
    await withCheckedContinuation { continuation in
      let resumeNow = lock.withLock { () -> Bool in
        if released { return true }
        waiting.append(continuation)
        return false
      }
      if resumeNow { continuation.resume() }
    }
    return Screenshot(png: png, width: maxWidth, height: 10)
  }
  func release() {
    let all = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
      released = true
      defer { waiting = [] }
      return waiting
    }
    all.forEach { $0.resume() }
  }
}

final class DispatcherTests: XCTestCase {
  var box: Sandbox!
  var journal: InvocationJournal!
  var activity: ActivityLog!
  var policy = PolicyDocument()
  var screenshots = HeldScreenshots()

  override func setUpWithError() throws {
    box = try Sandbox()
    journal = try InvocationJournal(url: URL(fileURLWithPath: box.appData + "/journal.jsonl"))
    activity = ActivityLog(url: URL(fileURLWithPath: box.appData + "/activity.jsonl"))
    policy = PolicyDocument()
    policy.folders = [FolderGrant(name: "dev", path: box.granted)]
    policy.grants = [Grant(assistantId: "patch", assistantName: "Patch", abilities: Set(Ability.allCases), unattended: true)]
    screenshots = HeldScreenshots()
  }

  func dispatcher(journal: InvocationJournal? = nil) throws -> Dispatcher {
    let snapshot = LiveSnapshot(policy: policy, folders: [try box.folder()], screenLocked: false, screenPermission: .granted)
    return Dispatcher(
      journal: journal ?? self.journal, activity: activity, environment: box.environment, screenshots: screenshots,
      snapshot: { snapshot })
  }

  func invoke(_ id: String, _ action: String, _ args: [String: JSONValue], scheduled: Bool = false) -> Invocation {
    Invocation(id: id, assistantId: "patch", assistantName: "Patch", scheduled: scheduled, action: action, args: args)
  }

  func testARepeatedIdIsAnsweredFromTheJournalAndNeverRunsAgain() async throws {
    let dispatcher = try dispatcher()
    let write = invoke("w1", "write_file", ["path": "a.txt", "content": "first", "createOnly": true])
    let first = await dispatcher.handle(write)
    XCTAssertEqual(first.value?["created"], true)
    try "changed by the person".write(toFile: box.granted + "/a.txt", atomically: false, encoding: .utf8)
    // Running it again would fail with `exists`; the recorded result comes back instead.
    let again = await dispatcher.handle(write)
    XCTAssertEqual(again, first)
    XCTAssertEqual(box.read(box.granted + "/a.txt"), "changed by the person")
  }

  func testAReusedIdWithChangedArgumentsIsRefused() async throws {
    let dispatcher = try dispatcher()
    _ = await dispatcher.handle(invoke("w1", "write_file", ["path": "a.txt", "content": "first"]))
    let changed = await dispatcher.handle(invoke("w1", "write_file", ["path": "a.txt", "content": "second"]))
    assertFailure(changed, .invalidArguments, containing: "already used with different arguments")
    XCTAssertEqual(box.read(box.granted + "/a.txt"), "first")
  }

  func testAfterARestartAnUnfinishedIdIsUncertainAndDoesNotRun() async throws {
    let write = invoke("w1", "write_file", ["path": "a.txt", "content": "x"])
    _ = try journal.begin(id: write.id, fingerprint: write.fingerprint)
    let restarted = try dispatcher(journal: try InvocationJournal(url: URL(fileURLWithPath: box.appData + "/journal.jsonl")))
    assertFailure(await restarted.handle(write), .uncertain, containing: "may or may not have finished")
    XCTAssertNil(box.read(box.granted + "/a.txt"))
  }

  func testWithoutAJournalRecordNothingRuns() async throws {
    let journalPath = box.appData + "/journal.jsonl"
    FileManager.default.createFile(atPath: journalPath, contents: nil)
    chmod(journalPath, 0o400)
    defer { chmod(journalPath, 0o600) }
    let dispatcher = try dispatcher()
    let outcome = await dispatcher.handle(invoke("w1", "write_file", ["path": "a.txt", "content": "x"]))
    assertFailure(outcome, .failed, containing: "could not record")
    XCTAssertNil(box.read(box.granted + "/a.txt"))
  }

  func testAMalformedInvokeGetsAJournaledInvalidArgumentsResult() async throws {
    let dispatcher = try dispatcher()
    let message = LinkCodec.decode(#"{"type":"invoke","id":"bad","assistantId":"patch","action":"run"}"#)
    let first = await dispatcher.handle(message)
    XCTAssertEqual(first?.id, "bad")
    assertFailure(first!.outcome, .invalidArguments, containing: "scheduled flag")
    XCTAssertEqual(journal.unacknowledged().map(\.id), ["bad"])
    let ackAnswer = await dispatcher.handle(.ack(id: "bad"))
    XCTAssertNil(ackAnswer)
  }

  func testAFifthConcurrentActionIsBusy() async throws {
    let dispatcher = try dispatcher()
    var running: [Task<ActionOutcome, Never>] = []
    for index in 0..<4 {
      running.append(Task { await dispatcher.handle(self.invoke("s\(index)", "screenshot", [:])) })
    }
    try await waitUntil { self.screenshots.count == 4 }
    XCTAssertEqual(dispatcher.activeCount, 4)
    assertFailure(await dispatcher.handle(invoke("s4", "screenshot", [:])), .busy, containing: "already running 4")
    screenshots.release()
    for task in running {
      let outcome = await task.value
      XCTAssertEqual(outcome.value?["width"], 1920)
    }
    XCTAssertEqual(dispatcher.activeCount, 0)
    // A refusal is journaled too, so the busy ID is not run later either.
    assertFailure(await dispatcher.handle(invoke("s4", "screenshot", [:])), .busy)
  }

  func testAResultTooLargeForTheLinkIsRefused() async throws {
    screenshots.png = Data(count: 7 * 1024 * 1024)
    screenshots.release()
    let dispatcher = try dispatcher()
    assertFailure(await dispatcher.handle(invoke("big", "screenshot", [:])), .tooLarge, containing: "larger than the link")
  }

  func testPauseStopsARunningCommand() async throws {
    let dispatcher = try dispatcher()
    let task = Task { await dispatcher.handle(self.invoke("r1", "run", ["command": "sleep 60"])) }
    try await waitUntil { dispatcher.activeCount == 1 }
    try await Task.sleep(nanoseconds: 300_000_000)
    dispatcher.cancelAll()
    assertFailure(await task.value, .paused, containing: "stopped")
  }

  func testRunResolvesItsWorkingFolderInsideTheFolders() async throws {
    let dispatcher = try dispatcher()
    try FileManager.default.createDirectory(atPath: box.granted + "/sub", withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: box.granted + "/away", withDestinationPath: box.outside)
    let inSub = await dispatcher.handle(invoke("r1", "run", ["command": "pwd", "cwd": "sub"]))
    XCTAssertEqual(inSub.value?["stdout"], .string(box.granted + "/sub\n"))
    XCTAssertEqual(inSub.value?["cwd"], .string(box.granted + "/sub"))
    let byDefault = await dispatcher.handle(invoke("r2", "run", ["command": "pwd"]))
    XCTAssertEqual(byDefault.value?["stdout"], .string(box.granted + "\n"))
    assertFailure(await dispatcher.handle(invoke("r3", "run", ["command": "pwd", "cwd": .string(box.outside)])), .outsideFolders)
    assertFailure(await dispatcher.handle(invoke("r4", "run", ["command": "pwd", "cwd": "away"])), .outsideFolders, containing: "symbolic link")
    assertFailure(await dispatcher.handle(invoke("r5", "run", ["command": "pwd", "cwd": "missing"])), .notFound)
    let leftovers = try FileManager.default.contentsOfDirectory(atPath: box.tempRoot)
    XCTAssertEqual(leftovers, [], "private temporary folders are removed after each command")
  }

  func testActivityKeepsCommandsAndPathsButNeverContentOrOutput() async throws {
    let dispatcher = try dispatcher()
    _ = await dispatcher.handle(invoke("w", "write_file", ["path": "notes.txt", "content": "TOP-SECRET-CONTENT"], scheduled: true))
    _ = await dispatcher.handle(invoke("r", "read_file", ["path": "notes.txt"]))
    let run = await dispatcher.handle(invoke("c", "run", ["command": "echo $((6*7))xyzzy"]))
    XCTAssertEqual(run.value?["stdout"], "42xyzzy\n")
    let text = try String(contentsOfFile: box.appData + "/activity.jsonl", encoding: .utf8)
    XCTAssertFalse(text.contains("TOP-SECRET-CONTENT"))
    XCTAssertFalse(text.contains("42xyzzy"))
    XCTAssertTrue(text.contains("echo $((6*7))xyzzy"))
    XCTAssertTrue(text.contains("notes.txt"))
    let entries = activity.entries
    XCTAssertEqual(entries.map(\.id), ["c", "r", "w"])
    XCTAssertEqual(entries.last?.scheduled, true)
    XCTAssertEqual(entries.last?.assistantName, "Patch")
    XCTAssertEqual(entries.first?.note, "exit code 0")
  }
}

func waitUntil(timeout: TimeInterval = 10, _ condition: @escaping () async -> Bool) async throws {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    if await condition() { return }
    try await Task.sleep(nanoseconds: 10_000_000)
  }
  XCTFail("condition not met within \(timeout) s")
  throw CancellationError()
}

final class ActivityLogTests: XCTestCase {
  func testOnlyANotAllowedEntryOffersAllowAndRefusalsAreNotUnattendedActions() {
    func entry(_ action: String, _ outcome: String) -> ActivityEntry {
      ActivityEntry(id: "i", at: Date(), assistantId: "a", assistantName: nil, scheduled: true, action: action, detail: "", outcome: outcome)
    }
    XCTAssertEqual(entry("write_file", "not_allowed").allowSuggestion, .filesWrite)
    XCTAssertEqual(entry("list_dir", "not_allowed").allowSuggestion, .filesRead)
    XCTAssertNil(entry("run", "unattended_not_allowed").allowSuggestion, "unattended is never allowed in one click")
    XCTAssertNil(entry("bogus", "not_allowed").allowSuggestion)
    XCTAssertTrue(entry("run", "unattended_not_allowed").wasRefused)
    XCTAssertFalse(entry("run", "ok").wasRefused)
    XCTAssertFalse(entry("write_file", "conflict").wasRefused, "a conflict happened after the action started")
  }

  func testKeepsTheNewestThousandAcrossRestarts() throws {
    let box = try Sandbox()
    let url = URL(fileURLWithPath: box.appData + "/activity.jsonl")
    let log = ActivityLog(url: url)
    for index in 0..<1250 {
      log.append(ActivityEntry(id: "\(index)", at: Date(), assistantId: "a", assistantName: nil, scheduled: false, action: "run",
        detail: "ls", outcome: "ok"))
    }
    XCTAssertEqual(log.entries.count, 1000)
    XCTAssertEqual(log.entries.first?.id, "1249")
    XCTAssertEqual(log.entries.last?.id, "250")
    let reopened = ActivityLog(url: url)
    XCTAssertEqual(reopened.entries.count, 1000)
    XCTAssertEqual(reopened.entries.first?.id, "1249")
  }
}
