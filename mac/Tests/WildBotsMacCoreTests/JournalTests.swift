import XCTest

@testable import WildBotsMacCore

final class JournalTests: XCTestCase {
  var box: Sandbox!
  var url: URL!

  override func setUpWithError() throws {
    box = try Sandbox()
    url = URL(fileURLWithPath: box.appData + "/journal.jsonl")
  }

  func testRecordsBeforeWorkAndAnswersRepeatsFromTheRecord() throws {
    let journal = try InvocationJournal(url: url)
    XCTAssertEqual(try journal.begin(id: "a", fingerprint: "f1"), .started)
    XCTAssertEqual(try journal.begin(id: "a", fingerprint: "f1"), .inProgress)
    XCTAssertEqual(try journal.begin(id: "a", fingerprint: "f2"), .mismatch)
    let outcome = ActionOutcome.success(["n": 1])
    try journal.finish(id: "a", outcome: outcome)
    XCTAssertEqual(try journal.begin(id: "a", fingerprint: "f1"), .finished(outcome))
    XCTAssertEqual(journal.unacknowledged().map(\.id), ["a"])
    try journal.acknowledge(id: "a")
    XCTAssertTrue(journal.unacknowledged().isEmpty)
    // Still never run again after it was acknowledged.
    if case .started = try journal.begin(id: "a", fingerprint: "f1") { XCTFail("an acknowledged id ran again") }
  }

  func testDiscardingWaitingResultsKeepsTheirIdsFromRunningAgain() throws {
    let journal = try InvocationJournal(url: url)
    _ = try journal.begin(id: "a", fingerprint: "f")
    try journal.finish(id: "a", outcome: .success(1))
    try journal.discardUnacknowledged()
    XCTAssertTrue(journal.unacknowledged().isEmpty)
    XCTAssertEqual(try journal.begin(id: "a", fingerprint: "f"), .finished(.success(1)))
    XCTAssertTrue(try InvocationJournal(url: url).unacknowledged().isEmpty)
  }

  func testAnActionCutOffByAQuitIsUncertainAfterRestart() throws {
    do {
      let journal = try InvocationJournal(url: url)
      _ = try journal.begin(id: "cut", fingerprint: "f")
      _ = try journal.begin(id: "done", fingerprint: "g")
      try journal.finish(id: "done", outcome: .success("ok"))
    }
    let reopened = try InvocationJournal(url: url)
    let pending = Dictionary(uniqueKeysWithValues: reopened.unacknowledged().map { ($0.id, $0.outcome) })
    XCTAssertEqual(pending["cut"]?.errorCode, .uncertain)
    XCTAssertEqual(pending["done"], .success("ok"))
    XCTAssertEqual(try reopened.begin(id: "cut", fingerprint: "f"), pending["cut"].map { .finished($0) })
    XCTAssertEqual(try reopened.begin(id: "cut", fingerprint: "other"), .mismatch)
    // The uncertain result was written down, so a second restart says the same.
    let again = try InvocationJournal(url: url)
    XCTAssertEqual(again.unacknowledged().first { $0.id == "cut" }?.outcome.errorCode, .uncertain)
  }

  func testAcknowledgementsSurviveRestartAndATornLastLineIsSkipped() throws {
    do {
      let journal = try InvocationJournal(url: url)
      _ = try journal.begin(id: "a", fingerprint: "f")
      try journal.finish(id: "a", outcome: .success(1))
      try journal.acknowledge(id: "a")
    }
    let handle = try FileHandle(forWritingTo: url)
    try handle.seekToEnd()
    try handle.write(contentsOf: Data(#"{"t":"accepted","id":"b","fp":"#.utf8))
    try handle.close()
    let reopened = try InvocationJournal(url: url)
    XCTAssertTrue(reopened.unacknowledged().isEmpty)
    XCTAssertEqual(try reopened.begin(id: "b", fingerprint: "f"), .started)
  }

  /// A crash in the middle of a multi-byte character used to make the whole file undecodable,
  /// and the empty result was compacted over it, so accepted IDs could run again.
  func testATornMultiByteFinalRecordKeepsEveryEarlierRecord() throws {
    do {
      let journal = try InvocationJournal(url: url)
      _ = try journal.begin(id: "a", fingerprint: "f")
      try journal.finish(id: "a", outcome: .success("café"))
      _ = try journal.begin(id: "b", fingerprint: "g")
    }
    let handle = try FileHandle(forWritingTo: url)
    try handle.seekToEnd()
    try handle.write(contentsOf: Data(#"{"t":"result","id":"b","outcome":{"ok":true,"value":"caf"#.utf8) + Data([0xC3]))
    try handle.close()
    let reopened = try InvocationJournal(url: url)
    XCTAssertEqual(try reopened.begin(id: "a", fingerprint: "f"), .finished(.success("café")))
    let pending = Dictionary(uniqueKeysWithValues: reopened.unacknowledged().map { ($0.id, $0.outcome) })
    XCTAssertEqual(pending["a"], .success("café"))
    XCTAssertEqual(pending["b"]?.errorCode, .uncertain, "the torn result is not trusted; b may have run")
  }

  /// A journal that exists but cannot be read, or is damaged before its last record, must not be
  /// replaced by an empty one: the app does not start, and the file is left as it was.
  func testAJournalThatCannotBeReadStopsStartupAndIsLeftAlone() throws {
    do {
      let journal = try InvocationJournal(url: url)
      _ = try journal.begin(id: "a", fingerprint: "f")
      try journal.finish(id: "a", outcome: .success(1))
    }
    let before = try Data(contentsOf: url)
    chmod(url.path, 0o000)
    defer { chmod(url.path, 0o600) }
    XCTAssertThrowsError(try InvocationJournal(url: url)) { error in
      XCTAssertEqual((error as? ActionError)?.code, .failed)
      XCTAssertTrue((error as? ActionError)?.message.contains("could not be read") == true, "\(error)")
    }
    chmod(url.path, 0o600)
    XCTAssertEqual(try Data(contentsOf: url), before)

    let damaged = Data("not a record\n".utf8) + before
    try damaged.write(to: url)
    XCTAssertThrowsError(try InvocationJournal(url: url)) { error in
      XCTAssertTrue((error as? ActionError)?.message.contains("record 1 is damaged") == true, "\(error)")
    }
    XCTAssertEqual(try Data(contentsOf: url), damaged)
  }

  /// An accepted record is what keeps an ID from running twice. One without its fingerprint before
  /// the last record is damage that stops startup; as a torn last record it is skipped.
  func testAMalformedAcceptedRecordBeforeTheLastStopsStartup() throws {
    do {
      let journal = try InvocationJournal(url: url)
      _ = try journal.begin(id: "a", fingerprint: "f")
      try journal.finish(id: "a", outcome: .success(1))
    }
    let valid = try Data(contentsOf: url)
    let malformed = Data(#"{"t":"accepted","id":"z","at":1}"#.utf8)
    let damaged = malformed + Data("\n".utf8) + valid
    try damaged.write(to: url)
    XCTAssertThrowsError(try InvocationJournal(url: url)) { error in
      XCTAssertTrue((error as? ActionError)?.message.contains("not a valid accepted invocation") == true, "\(error)")
    }
    XCTAssertEqual(try Data(contentsOf: url), damaged)
    try (valid + malformed).write(to: url)
    let reopened = try InvocationJournal(url: url)
    XCTAssertEqual(try reopened.begin(id: "a", fingerprint: "f"), .finished(.success(1)))
  }

  /// After 7 days an unacknowledged result loses its value but not its ID: a late repeat is
  /// answered `uncertain`, not run. The ID itself is forgotten 30 days after it was accepted.
  func testAnUnacknowledgedResultLosesItsValueAfter7DaysAndItsIdAfter30() throws {
    let start = Date(timeIntervalSince1970: 1_000_000)
    let clock = TestClock(start)
    do {
      let journal = try InvocationJournal(url: url, now: { clock.now })
      _ = try journal.begin(id: "x", fingerprint: "f")
      try journal.finish(id: "x", outcome: .success(["content": "payload"]))
    }
    func reopen(after seconds: TimeInterval) throws -> InvocationJournal {
      clock.now = start.addingTimeInterval(seconds)
      return try InvocationJournal(url: url, now: { clock.now })
    }
    let day: TimeInterval = 24 * 3600

    let beforeWeek = try reopen(after: 7 * day - 1)
    XCTAssertEqual(beforeWeek.unacknowledged().first?.outcome, .success(["content": "payload"]))

    let afterWeek = try reopen(after: 7 * day + 1)
    XCTAssertTrue(afterWeek.unacknowledged().isEmpty, "an expired result is not sent again")
    guard case .finished(let expired) = try afterWeek.begin(id: "x", fingerprint: "f") else {
      return XCTFail("an expired id would run again")
    }
    assertFailure(expired, .uncertain, containing: "no longer available")
    XCTAssertEqual(try afterWeek.begin(id: "x", fingerprint: "other"), .mismatch)
    XCTAssertFalse(try String(contentsOf: url, encoding: .utf8).contains("payload"))

    XCTAssertEqual(try reopen(after: 30 * day - 1).begin(id: "x", fingerprint: "f"), .finished(expired))
    XCTAssertEqual(try reopen(after: 30 * day + 1).begin(id: "x", fingerprint: "f"), .started)
  }

  func testCompactionForgetsOldEntriesButKeepsRecentOnes() throws {
    let clock = TestClock(Date(timeIntervalSince1970: 1_000_000))
    do {
      let journal = try InvocationJournal(url: url, now: { clock.now })
      _ = try journal.begin(id: "old", fingerprint: "f")
      try journal.finish(id: "old", outcome: .success(["content": "big"]))
      try journal.acknowledge(id: "old")
      _ = try journal.begin(id: "unacked", fingerprint: "f")
      try journal.finish(id: "unacked", outcome: .success(1))
      _ = try journal.begin(id: "recent", fingerprint: "f")
      try journal.finish(id: "recent", outcome: .success(2))
      try journal.acknowledge(id: "recent")
    }
    clock.now = clock.now.addingTimeInterval(InvocationJournal.unackedRetention + 60)
    let later = try InvocationJournal(url: url, now: { clock.now })
    XCTAssertTrue(later.unacknowledged().isEmpty, "an unacknowledged result past retention is dropped")
    if case .started = try later.begin(id: "recent", fingerprint: "f") { XCTFail("a recent acknowledged id was forgotten") }
    let text = try String(contentsOf: url, encoding: .utf8)
    XCTAssertFalse(text.contains("big"), "acknowledged values are not kept in full")
    clock.now = clock.now.addingTimeInterval(InvocationJournal.ackedRetention)
    let muchLater = try InvocationJournal(url: url, now: { clock.now })
    XCTAssertEqual(try muchLater.begin(id: "old", fingerprint: "f"), .started)
  }
}

final class TestClock: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Date
  init(_ value: Date) { self.value = value }
  var now: Date {
    get { lock.withLock { value } }
    set { lock.withLock { value = newValue } }
  }
}
