import XCTest
@testable import AgentInterface

/// A timer the test releases by hand, standing in for `Task.sleep` in the read retry. Each
/// wait is recorded; `release` ends every wait asked for so far, and cancellation ends one early.
@MainActor final class HeldPauses {
  private(set) var waits: [Duration] = []
  private(set) var cancelled = 0
  /// Waits asked for and not yet over. Release only once the one to end is waiting.
  private(set) var waiting = 0
  private var released = 0
  func pause(_ duration: Duration) async throws {
    waits.append(duration)
    let ticket = waits.count
    waiting += 1
    defer { waiting -= 1 }
    do {
      // Timer: stands in for the production timer, so only `release` or cancellation ends it.
      while released < ticket { try await Task.sleep(for: .milliseconds(5)) }
    } catch {
      cancelled += 1
      throw error
    }
  }
  func release() { released = waits.count }
}

/// A timer on the test's clock: each wait ends once the test moves its time past the wait's end,
/// as `Task.sleep` does on the real one. A timer replaced meanwhile is cancelled, as in production.
@MainActor final class ClockPauses {
  /// Each wait's end, in the order the timers asked.
  private(set) var waits: [ContinuousClock.Instant] = []
  private let clock: () -> ContinuousClock.Instant
  init(clock: @escaping () -> ContinuousClock.Instant) { self.clock = clock }
  func pause(until end: ContinuousClock.Instant) async throws {
    waits.append(end)
    // Timer: stands in for the production timer, ending when the test's clock reaches its end.
    while clock() < end { try await Task.sleep(for: .milliseconds(5)) }
  }
}

// When a lost connection goes on screen, at the edges the web's tests/outage.test.ts covers: after a
// grace period that hides blips, at once when waiting cannot fix it, in more words once it lasts,
// and never as a flash. The state machine takes the time as an argument, so every edge is exact.
final class OutageTests: XCTestCase {
  private let start = ContinuousClock.now
  private func at(_ ms: Int) -> ContinuousClock.Instant { start + .milliseconds(ms) }
  private let grace = 3_000, lasting = 10_000, minimum = 1_000
  /// The owner's timer reaching `ms`: every step due by then is taken.
  private func tick(_ outage: inout Outage, _ ms: Int) { outage.advance(to: at(ms)) }

  func testShowsAfterTheGracePeriodNotAMillisecondSoonerAndClearsWhenItEnds() {
    var outage = Outage()
    outage.update(down: true, at: at(0))
    XCTAssertEqual(outage.deadline, at(grace), "The owner's timer is asked for the end of the grace period")
    tick(&outage, grace - 1)
    XCTAssertFalse(outage.shown); XCTAssertTrue(outage.pending)
    tick(&outage, grace)
    XCTAssertTrue(outage.shown); XCTAssertFalse(outage.lasting); XCTAssertFalse(outage.lingering)
    outage.update(down: false, at: at(grace + minimum))
    XCTAssertFalse(outage.shown); XCTAssertFalse(outage.lingering)
    XCTAssertNil(outage.deadline)
  }

  func testNeverShowsALossThatEndsInsideTheGracePeriodAndTimesTheNextFromItsOwnStart() {
    var outage = Outage()
    outage.update(down: true, at: at(0))
    outage.update(down: false, at: at(grace - 1))
    // A timer that was set for the grace period runs anyway, after the loss ended.
    tick(&outage, grace + 1)
    XCTAssertFalse(outage.shown); XCTAssertNil(outage.deadline)
    outage.update(down: true, at: at(5_000))
    tick(&outage, 5_000 + grace - 1)
    XCTAssertFalse(outage.shown)
    tick(&outage, 5_000 + grace)
    XCTAssertTrue(outage.shown)
  }

  func testCountsAsLastingTenSecondsAfterItBeganNotAMillisecondSooner() {
    var outage = Outage()
    outage.update(down: true, at: at(0))
    tick(&outage, grace)
    XCTAssertEqual(outage.deadline, at(lasting))
    tick(&outage, lasting - 1)
    XCTAssertTrue(outage.shown); XCTAssertFalse(outage.lasting)
    tick(&outage, lasting)
    XCTAssertTrue(outage.lasting)
    XCTAssertNil(outage.deadline, "Nothing waits on the clock once it explains itself")
  }

  func testShowsADefiniteLossAtOnceAndAsLastingWhetherItStartsOrBecomesDefinite() {
    var outage = Outage()
    outage.update(down: true, definite: true, at: at(0))
    XCTAssertTrue(outage.shown); XCTAssertTrue(outage.lasting)
    outage.update(down: false, at: at(minimum))
    XCTAssertFalse(outage.shown)
    // A loss still inside its grace period that turns out to need a person stops waiting.
    outage.update(down: true, at: at(5_000))
    tick(&outage, 5_000 + grace - 1)
    XCTAssertFalse(outage.shown)
    outage.update(down: true, definite: true, at: at(5_000 + grace - 1))
    XCTAssertTrue(outage.shown); XCTAssertTrue(outage.lasting)
  }

  // What made a loss certain can pass while the loss goes on. A notice already on screen must not
  // hide for the rest of a grace period and come back, or fall back to its one-line form.
  func testStaysAsItIsWhenALossThatWasDefiniteStopsBeingDefinite() {
    for after in [nil, 1_000] {
      var outage = Outage()
      if let after { outage.update(down: true, at: at(0)); tick(&outage, after) }
      let now = after ?? 0
      outage.update(down: true, definite: true, at: at(now))
      outage.update(down: true, definite: false, at: at(now))
      tick(&outage, now + grace)
      XCTAssertTrue(outage.shown, "definite from \(after.map { "\($0) ms" } ?? "its start")")
      XCTAssertTrue(outage.lasting, "definite from \(after.map { "\($0) ms" } ?? "its start")")
    }
  }

  // The minimum time is the notice's, from when it was drawn. Learning more about the loss later
  // does not start it again.
  func testClearsANoticeShownLongEnoughAtOnceThoughTheLossBecameDefiniteMeanwhile() {
    var outage = Outage()
    outage.update(down: true, at: at(0))
    tick(&outage, grace)
    outage.update(down: true, definite: true, at: at(grace + minimum))
    outage.update(down: false, at: at(grace + minimum + minimum / 2))
    XCTAssertFalse(outage.shown); XCTAssertFalse(outage.lingering)
  }

  func testKeepsANoticeThatJustAppearedForASecondAfterTheLossEndsThenClearsIt() {
    var outage = Outage()
    outage.update(down: true, at: at(0))
    tick(&outage, grace)
    outage.update(down: false, at: at(grace))
    XCTAssertTrue(outage.shown); XCTAssertTrue(outage.lingering); XCTAssertFalse(outage.spoken)
    XCTAssertEqual(outage.deadline, at(grace + minimum))
    tick(&outage, grace + minimum - 1)
    XCTAssertTrue(outage.shown)
    tick(&outage, grace + minimum)
    XCTAssertFalse(outage.shown); XCTAssertFalse(outage.lingering)
  }

  // A lingering notice keeps the words it had: one that named its reason does not shrink to one line.
  func testKeepsALingeringNoticeInTheFormItHad() {
    var outage = Outage()
    outage.update(down: true, definite: true, at: at(0))
    outage.update(down: false, at: at(minimum - 1))
    XCTAssertTrue(outage.shown); XCTAssertTrue(outage.lasting); XCTAssertTrue(outage.lingering)
  }

  // A timer held back, as in a suspended app, can draw the notice long after it was due. The second
  // counts from when it was drawn, or the next successful read would flash it.
  func testKeepsANoticeASecondFromWhenItWasFirstDrawnHoweverLateThatWas() {
    var outage = Outage()
    outage.update(down: true, at: at(0))
    let late = grace + 2 * minimum
    tick(&outage, late)
    XCTAssertTrue(outage.shown)
    outage.update(down: false, at: at(late))
    XCTAssertTrue(outage.shown)
    tick(&outage, late + minimum - 1)
    XCTAssertTrue(outage.shown)
    tick(&outage, late + minimum)
    XCTAssertFalse(outage.shown)
  }

  // The read that ends a loss can land before the grace period's timer runs, though after its
  // deadline. The loss was never on screen while it was one, so it is not drawn now, and is no recovery.
  func testShowsNothingAndCountsNoRecoveryWhenTheLossEndsAsItsGracePeriodDoes() {
    var outage = Outage()
    outage.update(down: true, at: at(0))
    outage.update(down: false, at: at(grace + 1))
    tick(&outage, grace + 1)
    XCTAssertFalse(outage.shown); XCTAssertEqual(outage.recoveries, 0)
  }

  // A loss belongs to what it was a loss of, such as one chat. Another chat neither inherits its
  // notice nor the time it had already been down.
  func testStartsOverForAnotherScopeNothingLingersAndItsOwnLossWaitsItsOwnGracePeriod() {
    var outage = Outage()
    outage.update(down: true, scope: "a", at: at(0))
    tick(&outage, grace)
    XCTAssertTrue(outage.shown)
    outage.update(down: false, scope: "b", at: at(grace + 10))
    XCTAssertFalse(outage.shown, "Nothing lingers over the other scope")
    outage.update(down: true, scope: "b", at: at(grace + 10))
    tick(&outage, grace + 10 + grace - 1)
    XCTAssertFalse(outage.shown)
    tick(&outage, grace + 10 + grace)
    XCTAssertTrue(outage.shown)
    // Still down, but for a third scope from the first moment: its own grace period again.
    outage.update(down: true, scope: "c", at: at(10_000))
    XCTAssertFalse(outage.shown)
  }

  func testCarriesALossThatReturnsWhileItsNoticeLingersAsTheSameOutage() {
    var outage = Outage()
    outage.update(down: true, at: at(0))
    tick(&outage, grace)
    outage.update(down: false, at: at(grace))
    outage.update(down: true, at: at(grace + minimum - 1))
    // No new grace period hides it, and it lasts from when it first began.
    XCTAssertTrue(outage.shown); XCTAssertFalse(outage.lingering)
    tick(&outage, lasting - 1)
    XCTAssertFalse(outage.lasting)
    tick(&outage, lasting)
    XCTAssertTrue(outage.lasting)
  }

  func testGivesALossThatFollowsAClearedNoticeItsOwnGracePeriod() {
    var outage = Outage()
    outage.update(down: true, at: at(0))
    tick(&outage, grace)
    outage.update(down: false, at: at(grace))
    tick(&outage, grace + minimum)
    outage.update(down: true, at: at(grace + minimum))
    tick(&outage, grace + minimum + grace - 1)
    XCTAssertFalse(outage.shown)
    tick(&outage, grace + minimum + grace)
    XCTAssertTrue(outage.shown)
  }

  // What tells VoiceOver the connection is back: a loss that was on screen ended because the
  // connection returned. One that never showed, or that ended by leaving its scope, is no recovery.
  func testCountsALossThatWasOnScreenAndCameBackAtTheMomentItDoes() {
    var outage = Outage()
    outage.update(down: true, at: at(0))
    tick(&outage, grace)
    XCTAssertEqual(outage.recoveries, 0)
    outage.update(down: false, at: at(grace))
    XCTAssertEqual(outage.recoveries, 1); XCTAssertTrue(outage.lingering)
    // The notice running out its minimum time is not a second recovery, whatever else changes meanwhile.
    outage.update(down: false, definite: true, at: at(grace + 10))
    tick(&outage, grace + minimum)
    XCTAssertEqual(outage.recoveries, 1); XCTAssertFalse(outage.shown)
  }

  func testCountsNoRecoveryForALossThatNeverShowedOrWasLeftWithItsScope() {
    var outage = Outage()
    outage.update(down: true, at: at(0))
    outage.update(down: false, at: at(grace - 1))
    XCTAssertEqual(outage.recoveries, 0)
    outage.update(down: true, scope: "a", at: at(5_000))
    tick(&outage, 5_000 + grace)
    outage.update(down: false, scope: "b", at: at(5_000 + grace))
    tick(&outage, 9_000 + minimum)
    XCTAssertEqual(outage.recoveries, 0)
  }
}

// How soon a failure is read again. The first retry comes a second after the failure, so most
// losses are over before their 3-second grace period ends and nothing ever shows.
final class ReadRetryTests: XCTestCase {
  func testReadsAgainAfterOneTwoFourEightSixteenThenEveryThirtySeconds() {
    XCTAssertEqual((1...8).map(ReadRetry.delay(after:)), [1, 2, 4, 8, 16, 30, 30, 30].map { .seconds($0) })
  }
  func testThePollWaitsTheSameAfterFailedBootstrapsAndItsUsualPaceOtherwise() {
    XCTAssertEqual(AppStore.pollDelay(failures: 0), .milliseconds(1_500))
    XCTAssertEqual((1...7).map(AppStore.pollDelay(failures:)), [1, 2, 4, 8, 16, 30, 30].map { .seconds($0) })
  }
}

// What the connection notice says, from the web's tests/connection-copy.test.ts.
final class ConnectionCopyTests: XCTestCase {
  private func down(_ code: String?) -> RuntimeStatus { RuntimeStatus(connected: false, code: code) }
  private var up: RuntimeStatus { RuntimeStatus(connected: true) }

  func testSaysTheDraftIsKeptOnlyWhenThereIsOne() {
    let cases: [(String, (Bool) -> ConnectionCopy, String)] = [
      ("offline", { .of(connection: self.down("unreachable"), offline: true, hasDraft: $0) }, "Your draft is kept on this device. "),
      ("the app unreachable", { .of(connection: self.down("unreachable"), appUnavailable: true, lasting: true, hasDraft: $0) }, "Your draft is kept. "),
      ("Hermes not answering", { .of(connection: self.down("unreachable"), lasting: true, hasDraft: $0) }, "Your draft is kept. "),
      ("one chat failing", { .of(connection: self.up, chatOnly: true, lasting: true, hasDraft: $0) }, "Your draft is kept. "),
    ]
    for (name, copy, sentence) in cases {
      let without = copy(false).detail ?? ""
      XCTAssertFalse(without.localizedCaseInsensitiveContains("draft"), name)
      // The same notice with the one sentence added, so nothing else changes with it.
      XCTAssertEqual(copy(true).detail?.replacingOccurrences(of: sentence, with: ""), without, name)
    }
  }

  func testNeverMentionsADraftWhereNoneIsAtStake() {
    let setup = ConnectionCopy.of(connection: down("unauthorized"), hasDraft: true)
    let connecting = ConnectionCopy.of(connection: down("connecting"), lasting: true, hasDraft: true)
    XCTAssertFalse("\(setup.detail ?? "") \(connecting.detail ?? "")".localizedCaseInsensitiveContains("draft"))
  }

  func testSaysOneLineWithNoReasonUntilALossLastsThenNamesWhatIsDown() {
    for copy in [ConnectionCopy.of(connection: down("unreachable"), hasDraft: true),
                 .of(connection: down("unreachable"), appUnavailable: true, hasDraft: true),
                 .of(connection: up, chatOnly: true, hasDraft: true)] {
      XCTAssertEqual(copy, ConnectionCopy(title: "Reconnecting…"))
    }
    XCTAssertEqual(ConnectionCopy.of(connection: down("unreachable"), lasting: true),
      ConnectionCopy(title: "Hermes isn't answering", detail: "Messages can't be sent until it's back. We'll keep trying."))
    XCTAssertEqual(ConnectionCopy.of(connection: down("unreachable"), appUnavailable: true, lasting: true),
      ConnectionCopy(title: "Can't reach the app", detail: "We'll keep trying."))
    XCTAssertEqual(ConnectionCopy.of(connection: up, chatOnly: true, lasting: true),
      ConnectionCopy(title: "Can't refresh this chat", detail: "New messages may not show yet. We'll keep trying."))
  }

  func testCallsAServerThatJustStartedConnectingNotReconnecting() {
    XCTAssertEqual(ConnectionCopy.of(connection: down("connecting")), ConnectionCopy(title: "Connecting…"))
    XCTAssertEqual(ConnectionCopy.of(connection: down("connecting"), lasting: true).title, "Connecting to Hermes")
    // The app being unreachable says nothing about Hermes, whatever the last answer said of it.
    XCTAssertEqual(ConnectionCopy.of(connection: down("connecting"), appUnavailable: true).title, "Reconnecting…")
  }

  func testLetsTheMostCertainFactWinOfflineThenTheAppThenTheChat() {
    let everything = { (offline: Bool) in
      ConnectionCopy.of(connection: self.down("unauthorized"), offline: offline, appUnavailable: true, chatOnly: true, lasting: true)
    }
    XCTAssertEqual(everything(true).title, "You're offline")
    XCTAssertFalse(everything(true).setup, "Setup steps don't help someone who is offline")
    // What bootstrap last said of Hermes is stale while the app cannot be reached.
    XCTAssertEqual(everything(false).title, "Can't reach the app")
  }

  func testAsksForSetupAtOnceWithoutWaitingForTheLossToLast() {
    let copy = ConnectionCopy.of(connection: down("unauthorized"))
    XCTAssertTrue(copy.setup)
    XCTAssertEqual(copy.title, "Hermes didn't accept the connection")
  }

  func testTreatsACodeItDoesNotKnowOrNoneAsHermesNotAnswering() {
    for code in ["something_new", "reconnecting", nil] {
      XCTAssertFalse(ConnectionCopy.needsSetup(down(code)))
      XCTAssertEqual(ConnectionCopy.of(connection: down(code), lasting: true).title, "Hermes isn't answering", code ?? "no code")
    }
  }

  func testNeedsSetupOnlyWhileHermesIsDownForAReasonAPersonMustFix() {
    XCTAssertTrue(ConnectionCopy.needsSetup(down("not_configured")))
    XCTAssertFalse(ConnectionCopy.needsSetup(down("unreachable")))
    // Connected is connected, whatever code came with it.
    XCTAssertFalse(ConnectionCopy.needsSetup(RuntimeStatus(connected: true, code: "unauthorized")))
    XCTAssertFalse(ConnectionCopy.needsSetup(nil))
  }

  func testSpeaksTheTitleAsASentenceAndAddsNoPeriodAfterAnEllipsis() {
    XCTAssertEqual(ConnectionCopy(title: "Reconnecting…").spoken, "Reconnecting…")
    XCTAssertEqual(ConnectionCopy(title: "Can't reach the app", detail: "We'll keep trying.").spoken, "Can't reach the app. We'll keep trying.")
    XCTAssertEqual(ConnectionCopy(title: "Hermes is reachable. One step remains.", detail: "More.").spoken, "Hermes is reachable. One step remains. More.")
  }
}

// The store's two outages, as the screen and VoiceOver see them: the household's and the open chat's.
// The clock and the timer are the test's, so each step happens exactly when the test moves time.
@MainActor final class ConnectionStateStoreTests: XCTestCase {
  private var time = ContinuousClock.now
  private var start = ContinuousClock.now
  private lazy var timers = ClockPauses { [unowned self] in self.time }
  private var said: [String] = []

  private func store(connection: String = #"{"connected":true}"#, worked: Bool = true) throws -> AppStore {
    let value = AppStore()
    value.widgetSnapshotURL = nil
    value.now = { [unowned self] in self.time }
    value.outagePause = { [timers] in try await timers.pause(until: $0) }
    value.announce = { [unowned self] in self.said.append($0) }
    let json = #"{"user":{"id":"one","name":"One","email":"one@example.test"},"household":[],"preferences":{"presentation":"simple","theme":"system","favorites":[],"sections":[],"followBots":[]},"bots":[{"id":"ranch","name":"Ranch","model":"m","shared":true,"activity":"working"},{"id":"barn","name":"Barn","model":"m","shared":true,"activity":"idle"}],"capabilities":{},"connection":\#(connection),"csrfToken":null}"#
    value.bootstrap = try JSONDecoder().decode(Bootstrap.self, from: Data(json.utf8))
    // A session in which a household read has answered with Hermes connected, unless told otherwise.
    value.bootstrapAnswered = worked
    value.everConnected = worked
    value.selectedBotId = "ranch"
    value.conversationShown("ranch", true)
    value.draftReady = true
    value.updateActivity()
    return value
  }
  /// Moves the test's clock to `ms` after the start and lets every waiting timer run.
  /// Moves the test's clock to `ms` after the start and waits until every timer due by then has run.
  private func move(to ms: Int, _ value: AppStore) async throws {
    time = start + .milliseconds(ms)
    try await until { value.outageDeadline.map { $0 > time } ?? true }
  }
  override func setUp() async throws {
    start = ContinuousClock.now
    time = start
    said = []
  }

  func testAHouseholdLossRefusesSendAtOnceAndShowsOnlyAfterItsGracePeriod() async throws {
    let value = try store()
    value.appUnavailable = true
    XCTAssertFalse(value.connected)
    XCTAssertEqual(value.connectionReason, AppStore.checkingConnection, "Send says why before anything shows")
    XCTAssertEqual(value.activity, .working, "The chat still shows what Hermes last said")
    XCTAssertFalse(value.connectionCardShown)
    try await until { timers.waits.count == 1 }
    XCTAssertEqual(timers.waits, [start + .seconds(3)], "The timer waits for the end of the grace period")
    try await move(to: 2_999, value)
    XCTAssertFalse(value.appOutage.shown); XCTAssertEqual(said, [])
    try await move(to: 3_000, value)
    XCTAssertTrue(value.connectionCardShown); XCTAssertEqual(value.activity, .disconnected)
    XCTAssertEqual(value.connectionCopy(hasDraft: value.hasDraft), ConnectionCopy(title: "Reconnecting…"))
    XCTAssertEqual(value.connectionReason, AppStore.waitingForConnection)
    XCTAssertEqual(said, ["Reconnecting…"])
    try await move(to: 9_999, value)
    XCTAssertFalse(value.appOutage.lasting)
    try await move(to: 10_000, value)
    XCTAssertEqual(value.connectionCopy(hasDraft: false).title, "Can't reach the app")
    XCTAssertEqual(said, ["Reconnecting…", "Can't reach the app. We'll keep trying."])
    value.appUnavailable = false
    XCTAssertFalse(value.connectionCardShown, "Shown for longer than its minimum, so it goes at once")
    XCTAssertEqual(value.activity, .working)
    XCTAssertEqual(said.last, AppStore.connectedAgain)
  }

  func testALossThatEndsInsideTheGracePeriodShowsAndSaysNothing() async throws {
    let value = try store()
    value.appUnavailable = true
    try await move(to: 2_999, value)
    value.appUnavailable = false
    try await move(to: 3_000, value)
    XCTAssertFalse(value.connectionShown); XCTAssertEqual(said, [])
    XCTAssertTrue(value.connected)
  }

  func testALaunchFromTheSavedCopyWaitsForItsFirstAnswerAndALossBeforeHermesWasReachedShowsAtOnce() async throws {
    let value = try store(worked: false)
    // A cold launch shows the roster saved on the device before any household read has answered.
    value.appUnavailable = true
    XCTAssertFalse(value.connectionShown, "Nothing has failed yet, so nothing shows")
    value.bootstrapAnswered = true
    value.updateActivity()
    XCTAssertTrue(value.appOutage.shown); XCTAssertTrue(value.appOutage.lasting)
    XCTAssertEqual(said, ["Can't reach the app. We'll keep trying."])
  }

  func testASetupProblemShowsAtOnceAndOtherHermesLossesWait() async throws {
    let setup = try store(connection: #"{"connected":false,"code":"unauthorized"}"#)
    XCTAssertTrue(setup.appOutage.shown)
    XCTAssertEqual(setup.connectionCopy(hasDraft: false).title, "Hermes didn't accept the connection")
    let unreachable = try store(connection: #"{"connected":false,"code":"unreachable"}"#)
    XCTAssertFalse(unreachable.appOutage.shown); XCTAssertTrue(unreachable.appOutage.pending)
  }

  func testAnOfflineDeviceWaitsItsGracePeriodThenSaysSo() async throws {
    let value = try store()
    value.deviceOffline = true
    XCTAssertTrue(value.appOutage.pending); XCTAssertEqual(said, [])
    try await move(to: 3_000, value)
    XCTAssertTrue(value.connectionCardShown)
    XCTAssertEqual(value.connectionCopy(hasDraft: false), ConnectionCopy(title: "You're offline", detail: "We'll reconnect when you're back online."))
    XCTAssertEqual(said, ["You're offline. We'll reconnect when you're back online."])
  }

  func testAChatsSavedCopyWhileHomeIsLiveSaysSoItselfWithoutTheNotice() async throws {
    let value = try store()
    value.offlineSavedAt = Date()
    value.cachedChats = ["ranch"]
    value.readFailedFor = "ranch"
    try await move(to: 3_000, value)
    XCTAssertTrue(value.chatOutage.shown)
    XCTAssertFalse(value.connectionCardShown, "The saved copy's own line speaks for it")
  }

  func testSomethingThatComesBackWhileAnotherLossIsSaidIsNotAnnounced() async throws {
    let value = try store()
    value.readFailedFor = "ranch"
    value.appUnavailable = true
    try await move(to: 3_000, value)
    let heard = said
    value.readFailedFor = nil
    XCTAssertEqual(value.chatOutage.recoveries, 1)
    XCTAssertFalse(said.contains(AppStore.connectedAgain), "The app is still gone, so nothing is back")
    XCTAssertEqual(said, heard)
  }

  func testOneChatsFailedReadStaysInThatChat() async throws {
    let value = try store()
    value.readFailedFor = "ranch"
    XCTAssertFalse(value.connected, "Send is refused at once")
    try await move(to: 3_000, value)
    XCTAssertTrue(value.chatOutage.shown); XCTAssertFalse(value.appOutage.shown)
    XCTAssertEqual(value.activity, .disconnected, "The chat's own avatar dims")
    XCTAssertEqual(value.listedActivity, .working, "Home lists what Hermes last said")
    XCTAssertTrue(value.householdConnected, "Home, settings and other assistants stay live")
    try await move(to: 10_000, value)
    XCTAssertEqual(value.connectionCopy(hasDraft: false).title, "Can't refresh this chat")
    // Leaving the chat is not its recovery: nothing lingers and nothing says it is back.
    value.conversationShown("ranch", false)
    XCTAssertFalse(value.connectionShown)
    XCTAssertEqual(value.chatOutage.recoveries, 0)
    XCTAssertFalse(said.contains(AppStore.connectedAgain))
    // Off screen, its failed read is timed by nobody.
    try await move(to: 20_000, value)
    XCTAssertFalse(value.connectionShown)
    // Back on screen, it waits its own grace period again.
    value.conversationShown("ranch", true)
    XCTAssertFalse(value.connectionShown); XCTAssertTrue(value.chatOutage.pending)
  }

  func testAChatThatComesBackSaysSoAndItsNoticeStaysOutItsSecond() async throws {
    let value = try store()
    value.readFailedFor = "ranch"
    try await move(to: 3_000, value)
    value.readFailedFor = nil
    XCTAssertTrue(value.connectionCardShown, "It lingers for its minimum second")
    XCTAssertTrue(value.connected, "Send works from the first successful read, not when the notice goes")
    XCTAssertEqual(said, ["Reconnecting…", AppStore.connectedAgain])
    try await move(to: 4_000, value)
    XCTAssertFalse(value.connectionCardShown)
  }

  func testTheNoticeMentionsTheDraftOnlyWhenTheMessageBoxHoldsOneAndTypingDoesNotRepeatIt() async throws {
    let value = try store()
    value.draft.text = "   "
    value.appUnavailable = true
    try await move(to: 10_000, value)
    XCTAssertEqual(value.connectionCopy(hasDraft: value.hasDraft).detail, "We'll keep trying.", "Spaces are no draft")
    let heard = said
    value.draft.text = "Water the north field"
    XCTAssertEqual(value.connectionCopy(hasDraft: value.hasDraft).detail, "Your draft is kept. We'll keep trying.")
    XCTAssertEqual(value.connectionReason, AppStore.waitingWithDraft)
    value.updateActivity()
    XCTAssertEqual(said, heard, "The draft's first word is no news about the connection")
  }

  /// Review finding 1: with a healthy household, going offline left `connected` true until a read failed.
  func testAnOfflineDeviceRefusesWritesFromTheFirstMoment() async throws {
    let value = try store()
    value.deviceOffline = true
    XCTAssertFalse(value.connected, "Nothing can be written without a network")
    XCTAssertEqual(value.connectionReason, AppStore.checkingConnection, "Send says why before the notice shows")
    XCTAssertEqual(value.activity, .working, "The chat still shows what Hermes last said during the grace period")
    value.deviceOffline = false
    XCTAssertTrue(value.connected)
  }

  /// Review finding 5: one chat's failed read is that chat's; the household's controls stay live.
  func testOneChatsFailedReadLeavesTheHouseholdReachable() async throws {
    let value = try store()
    value.readFailedFor = "ranch"
    XCTAssertFalse(value.connected, "The chat's own writes wait")
    XCTAssertTrue(value.householdReachable, "Group rooms and Settings read the household")
    value.deviceOffline = true
    XCTAssertFalse(value.householdReachable, "Offline, the household can take no write either")
  }

  /// Review finding 8: a working chat that recovered right after its notice showed brought its activity row
  /// back while the notice stayed out its minimum second.
  func testTheActivityRowWaitsForTheNoticeToGoAndTheComposerDoesNot() async throws {
    let value = try store()
    XCTAssertTrue(value.activityRowShown)
    value.readFailedFor = "ranch"
    XCTAssertTrue(value.activityRowShown, "During the grace period the chat shows what Hermes last said")
    try await move(to: 3_000, value)
    XCTAssertFalse(value.activityRowShown)
    value.readFailedFor = nil
    XCTAssertTrue(value.active, "The composer has the recovered activity at once")
    XCTAssertFalse(value.activityRowShown, "The row stays hidden while the notice lingers")
    try await move(to: 4_000, value)
    XCTAssertTrue(value.activityRowShown)
  }

  /// Review finding 3: VoiceOver heard a failed poll during the grace period, and again from the notice.
  /// The chat announces only the errors its banner shows.
  func testAFailedPollIsTheNoticesNewsAndOtherErrorsAreTheBanners() async throws {
    let value = try store()
    value.readFailedFor = "ranch"
    value.reportPoll(APIError(message: "Hermes timed out. Try again.", status: 502), .chat)
    XCTAssertNotNil(value.error)
    XCTAssertFalse(value.chatErrorShown, "Hidden with the loss during the grace period")
    try await move(to: 3_000, value)
    XCTAssertFalse(value.chatErrorShown, "The notice says it")
    value.report(APIError(message: "The file is too large.", status: 413))
    XCTAssertTrue(value.chatErrorShown, "A failed action is the banner's")
    value.error = nil
    value.readFailedFor = nil
    try await move(to: 4_000, value)
    value.reportPoll(APIError(message: "Checking a send failed.", status: 503), .submissions)
    XCTAssertTrue(value.chatErrorShown, "A failed poll with no loss being timed is the banner's")
  }

  /// Round 2, finding 7: a failed submission check hidden during a household loss was still the error once
  /// the loss ended. When the notice cleared the banner showed it, but `error` had not changed, so a view
  /// that watched `error` never told VoiceOver. The banner's message is what changes, and what is watched.
  func testTheBannerMessageChangesWhenAHiddenErrorComesIntoViewThoughTheErrorDoesNot() async throws {
    let value = try store()
    value.appUnavailable = true
    try await move(to: 3_000, value)
    value.reportPoll(APIError(message: "Checking a send failed.", status: 503), .submissions)
    XCTAssertNil(value.chatErrorBanner, "Hidden behind the notice")
    value.appUnavailable = false
    XCTAssertTrue(value.connectionCardShown, "The notice stays out its second")
    try await move(to: 4_000, value)
    XCTAssertFalse(value.connectionCardShown)
    XCTAssertEqual(value.error, "Checking a send failed.", "The error itself never changed")
    XCTAssertEqual(value.chatErrorBanner, "Checking a send failed.", "The value the chat's onChange compares does")
  }

  /// Review finding 7: with a send on its way the composer is empty, but the notice still said the draft was kept.
  func testTheNoticeClaimsNoDraftWhileTheMessageBoxShowsItEmptyForASend() async throws {
    let value = try store()
    value.draft.text = "Water the north field"
    value.pendings["ranch"] = PendingSubmission(requestId: "request", botId: "ranch", text: "Water the north field", attachments: [], reviewedInterruption: false)
    value.sendingRequests["ranch"] = "request"
    XCTAssertEqual(value.composerDraft.text, "", "The composer shows the box empty while the message is on its way")
    XCTAssertFalse(value.hasDraft)
    // Words typed after the send are a draft again.
    value.sendingRequests["ranch"] = nil
    XCTAssertTrue(value.hasDraft)
  }
}

// What a lost connection does to an assistant's avatar and caption, and what a failed read says.
@MainActor final class ConnectionQuietingTests: XCTestCase {
  func testALostConnectionDimsAnAvatarWithoutABadgeAndLessThanAStoppedTask() {
    XCTAssertFalse(AvatarView.badged(.disconnected, portrait: false))
    XCTAssertFalse(AvatarView.badged(.disconnected, portrait: true))
    XCTAssertTrue(AvatarView.badged(.interrupted, portrait: false), "Other states keep their badge")
    let lost = AvatarView.dim(.disconnected), stopped = AvatarView.dim(.interrupted)
    XCTAssertLessThan(lost.saturation, 1); XCTAssertGreaterThan(lost.saturation, stopped.saturation)
    XCTAssertEqual(AvatarView.dim(.working).saturation, 1)
  }
  func testHomeSaysALostConnectionOnceAndCaptionsNoAssistantWithIt() {
    XCTAssertFalse(ActivityState.disconnected.captioned)
    XCTAssertTrue(ActivityState.working.captioned)
    XCTAssertFalse(ActivityState.idle.captioned)
  }
  func testAReadThatNeverReachedTheAppMentionsNoDraftAndAWriteDoes() {
    let read = APIClient.unreachable(URLError(.cannotConnectToHost), read: true).localizedDescription
    let write = APIClient.unreachable(URLError(.cannotConnectToHost), read: false).localizedDescription
    XCTAssertFalse(read.localizedCaseInsensitiveContains("draft"), read)
    XCTAssertTrue(write.contains("Your draft is kept"), write)
  }
}
