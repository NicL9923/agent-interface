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
  func testTheSameMemberSigningInAgainEndsARequestInWordsTheViewCanShow() async {
    let store = AppStore()
    store.widgetSnapshotURL = nil
    store.api = client("only")
    var error: String?
    let binding = Binding(get: { error }, set: { error = $0 })
    let value: Int? = await store.run(error: binding) { context in
      store.replaceClient(token: nil)
      let _: EmptyResponse = try await context.api.write("/anything", [String: String]())
      return 4
    }
    XCTAssertNil(value)
    XCTAssertEqual(error, AppStore.signInChanged)
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

  /// Round 2, finding 6: a group write tapped just before the connection dropped still saved its pending
  /// request and posted. A write that needs the household checks it as it starts, before its first step.
  func testAHouseholdWriteChecksTheConnectionAsItStartsAndOneChatsFailureIsNotIt() async throws {
    let store = AppStore()
    store.widgetSnapshotURL = nil
    store.api = client("only")
    store.bootstrap = try JSONDecoder().decode(Bootstrap.self, from: Data(#"{"user":{"id":"one","name":"One","email":"one@example.test"},"household":[],"preferences":{"presentation":"simple","theme":"system","favorites":[],"sections":[],"followBots":[]},"bots":[{"id":"ranch","name":"Ranch","model":"m","shared":true,"activity":"idle"}],"capabilities":{},"connection":{"connected":true}}"#.utf8))
    store.selectedBotId = "ranch"
    var error: String?
    let binding = Binding(get: { error }, set: { error = $0 })
    var started = 0
    let losses: [(String, (AppStore) -> Void, (AppStore) -> Void)] = [
      ("offline", { $0.deviceOffline = true }, { $0.deviceOffline = false }),
      ("the app", { $0.appUnavailable = true }, { $0.appUnavailable = false }),
    ]
    for (name, lose, restore) in losses {
      lose(store)
      let value: Int? = await store.run(error: binding, household: true, failure: { _ in "mapped" }) { _ in started += 1; return 1 }
      XCTAssertNil(value)
      XCTAssertEqual(started, 0, "Nothing starts, so nothing is saved as pending, with \(name) lost")
      XCTAssertEqual(error, AppStore.waitingForConnection, "The reason, not the write's own failure wording")
      error = nil
      restore(store)
    }
    store.readFailedFor = "ranch"
    XCTAssertFalse(store.connected)
    let value: Int? = await store.run(error: binding, household: true) { _ in started += 1; return 2 }
    XCTAssertEqual(value, 2, "One chat's failed read says nothing about the household")
    store.deviceOffline = true
    let unchecked: Int? = await store.run(error: binding) { _ in started += 1; return 3 }
    XCTAssertEqual(unchecked, 3, "A read, such as a room's poll, is not checked")
  }
}
