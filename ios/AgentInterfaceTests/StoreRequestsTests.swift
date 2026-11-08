import SwiftUI
import XCTest

@testable import AgentInterface

@MainActor
final class StoreRequestsTests: XCTestCase {
  private func client(_ host: String) -> APIClient { APIClient(baseURL: URL(string: "https://\(host).invalid")!) }

  func testMultiStepWorkStopsBeforeItsNextStepOnceTheClientChanges() async {
    let store = AppStore()
    store.widgetSnapshotURL = nil
    store.api = client("first")
    var reachedSecondStep = false
    let outcome = await store.attempt { context -> Int in
      store.api = self.client("second")
      try context.checkCurrent()
      reachedSecondStep = true
      return 1
    }
    XCTAssertNil(outcome, "a stale request reports nothing, not a failure")
    XCTAssertFalse(reachedSecondStep)
  }

  func testCurrentWorkPassesItsCheckAndReturnsItsValue() async throws {
    let store = AppStore()
    store.widgetSnapshotURL = nil
    store.api = client("only")
    let outcome = await store.attempt { context -> Int in
      try context.checkCurrent()
      return 2
    }
    XCTAssertEqual(try outcome?.get(), 2)
  }

  func testAStaleStepLeavesTheViewErrorAlone() async {
    let store = AppStore()
    store.widgetSnapshotURL = nil
    store.api = client("first")
    var error: String?
    let binding = Binding(get: { error }, set: { error = $0 })
    let value: Int? = await store.run(error: binding) { context in
      store.api = self.client("second")
      try context.checkCurrent()
      return 3
    }
    XCTAssertNil(value)
    XCTAssertNil(error)
  }
  func testViewPredicateStopsMultiStepWorkAndPreventsStartingStaleWork() async {
    let store = AppStore()
    store.widgetSnapshotURL = nil
    store.api = client("only")
    var visible = true
    var writes = 0
    let outcome = await store.attempt(current: { visible }) { context -> Int in
      writes += 1
      visible = false
      try context.checkCurrent()
      writes += 1
      return writes
    }
    XCTAssertNil(outcome)
    XCTAssertEqual(writes, 1)
    let stale = await store.attempt(current: { visible }) { _ in writes += 1; return writes }
    XCTAssertNil(stale)
    XCTAssertEqual(writes, 1, "A queued button task cannot start after its view closes")
  }

}
