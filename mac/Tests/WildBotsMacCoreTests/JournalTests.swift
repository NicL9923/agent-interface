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
