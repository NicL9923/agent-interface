import XCTest

@testable import AgentInterface

/// The conductor's promises, checked on the native side: no two bots ever show the same look at
/// once, a bot's avatars share one cue, bots on screen together keep their own pace, and a
/// completion celebrates within a short bound or not at all.
@MainActor
final class AvatarConductorTests: XCTestCase {
  typealias Kind = AvatarMotion.GestureKind
  private let frame = 1.0 / 30

  /// A deterministic random source, so a failing household can be replayed.
  private struct Random {
    var state: UInt64
    mutating func next() -> Double {
      state &+= 0x9E37_79B9_7F4A_7C15
      var z = state
      z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
      z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
      return Double((z ^ (z >> 31)) >> 11) / Double(1 << 53)
    }
  }

  private struct Avatar {
    var owner: String
    var state: ActivityState
    var since: Double
    var entered: Bool
    var held = false
  }

  /// Gestures a plan shows at `t` seconds into its state, as the pose function would play them.
  private func showing(_ plan: AvatarMotion.Plan, _ t: Double) -> [Kind] {
    var shown: [Kind] = []
    if let g = plan.gesture, t >= g.start, t < g.start + g.kind.length { shown.append(g.kind) }
    if let boop = plan.boop, t >= boop, t < boop + Kind.boop.length { shown.append(.boop) }
    return shown
  }

  /// Fails if a look is on two bots in this frame, or two bots' turns at one look come closer
  /// than the gap. Counts each kind seen.
  private func watch(
    _ conductor: AvatarConductor, _ avatars: [Avatar], now: Double,
    last: inout [String: (owner: String, at: Double)], seen: inout [Kind: Int]
  ) {
    var owners: [String: String] = [:]
    for avatar in avatars {
      let cue = conductor.cue(
        owner: avatar.owner, state: avatar.state, since: avatar.since, entered: avatar.entered,
        held: avatar.held, now: now)
      for kind in showing(cue.plan, now - cue.since) {
        let look = kind.look
        if let other = owners[look], other != avatar.owner {
          XCTFail("\(avatar.owner) and \(other) both show \(look) at \(now)")
        }
        owners[look] = avatar.owner
        if let previous = last[look], previous.owner != avatar.owner,
          now - previous.at < AvatarConductor.turnGap - 1e-6
        {
          XCTFail("\(avatar.owner) shows \(look) \(now - previous.at) s after \(previous.owner)")
        }
        last[look] = (avatar.owner, now)
        seen[kind, default: 0] += 1
      }
    }
  }

  func testNoTwoBotsShowTheSameLookAtOnceOverALongBusyDay() {
    let conductor = AvatarConductor()
    var random = Random(state: 7)
    let states: [ActivityState] = [
      .idle, .idle, .idle, .working, .working, .thinking, .thinking, .waiting, .blocked, .done,
      .failed,
    ]
    // Ten bots in home rows, three also open in a chat header. Home rows show a finished bot as
    // idle, so one bot can be in two states at once.
    var bots = (0..<10).map { (name: "Bot \($0)", state: ActivityState.idle, since: 0.0, held: false) }
    var last: [String: (owner: String, at: Double)] = [:]
    var seen: [Kind: Int] = [:]
    for n in 0..<(10 * 60 * 30) {
      let now = Double(n) * frame
      let together = n > 0 && n % (120 * 30) == 0
      let shared = states[Int(random.next() * Double(states.count))]
      for i in bots.indices {
        if together ? random.next() < 0.7 : random.next() < frame / 9 {
          let state = together ? shared : states[Int(random.next() * Double(states.count))]
          if state != bots[i].state { (bots[i].state, bots[i].since) = (state, now) }
        }
        if bots[i].state == .working && random.next() < frame / 4 { bots[i].held.toggle() }
      }
      let avatars = bots.enumerated().flatMap { i, bot -> [Avatar] in
        let home = Avatar(
          owner: bot.name, state: bot.state == .done ? .idle : bot.state, since: bot.since,
          entered: bot.since > 0)
        let header = Avatar(
          owner: bot.name, state: bot.state, since: bot.since, entered: bot.since > 0,
          held: bot.held)
        // The last bot's home row scrolls away now and then.
        guard i != 9 || Int(now / 40) % 2 == 0 else { return [] }
        return i < 3 ? [home, header] : [home]
      }
      watch(conductor, avatars, now: now, last: &last, seen: &seen)
    }
    // Every kind actually played, so the check above was not vacuous.
    for kind in Kind.allCases { XCTAssertGreaterThan(seen[kind] ?? 0, 0, kind.rawValue) }
  }

  func testAvatarsOfOneBotShareACue() {
    let conductor = AvatarConductor()
    var home = conductor.cue(owner: "Juniper", state: .idle, since: 0, entered: false, held: false, now: 0)
    var now = 0.0
    while now < 3 {
      home = conductor.cue(owner: "Juniper", state: .idle, since: 0, entered: false, held: false, now: now)
      now += frame
    }
    // A chat header opened later joins the bot's motion instead of starting its own.
    let header = conductor.cue(owner: "Juniper", state: .idle, since: 3, entered: false, held: false, now: now)
    XCTAssertEqual(header, home)
    XCTAssertEqual(header.since, 0)
    XCTAssertNotNil(header.plan.gesture)
  }

  func testTwoBotsThatShareANameStayApart() {
    XCTAssertNotEqual(AvatarView.motionOwner(botId: "ranch", name: "Helper", instance: "a"), AvatarView.motionOwner(botId: "kitchen", name: "Helper", instance: "b"))
    XCTAssertEqual(AvatarView.motionOwner(botId: "ranch", name: "Helper", instance: "a"), AvatarView.motionOwner(botId: "ranch", name: "Renamed", instance: "b"))
    XCTAssertEqual(AvatarView.motionOwner(botId: nil, name: "Welcome 1", instance: "a"), AvatarView.motionOwner(botId: nil, name: "Welcome 1", instance: "b"))
    XCTAssertNotEqual(AvatarView.motionOwner(botId: nil, name: nil, instance: "a"), AvatarView.motionOwner(botId: nil, name: nil, instance: "b"))
  }

  func testBotsOnScreenTogetherKeepTheirOwnPhaseAndPace() {
    let conductor = AvatarConductor()
    let plans = (0..<8).map {
      conductor.cue(owner: "Bot \($0)", state: .working, since: 0, entered: true, held: false, now: 0).plan
    }
    for (i, a) in plans.enumerated() {
      for b in plans[(i + 1)...] {
        let phase = abs(a.phase - b.phase)
        XCTAssertTrue(
          min(phase, 1 - phase) > 0.05 || abs(a.tempo - b.tempo) > 0.03,
          "\(a.phase)/\(a.tempo) vs \(b.phase)/\(b.tempo)")
      }
    }
    // Two bots that start together do not move in step.
    for state in [ActivityState.idle, .working, .thinking, .waiting] {
      let apart = stride(from: 1.0, to: 6, by: 0.1).filter { t in
        let p = AvatarMotion.pose(state, t, reduce: false, plan: plans[0])
        let q = AvatarMotion.pose(state, t, reduce: false, plan: plans[1])
        return abs(p.gazeX - q.gazeX) + abs(p.roll - q.roll) + abs(p.lift - q.lift) > 0.05
      }
      XCTAssertGreaterThan(apart.count, 40, "\(state)")
    }
  }

  func testCelebrationsWaitABoundedTimeOrSkip() {
    let conductor = AvatarConductor()
    let since = 100.0
    let cues = (0..<6).map {
      conductor.cue(owner: "Bot \($0)", state: .done, since: since, entered: true, held: false, now: since)
    }
    let starts = cues.compactMap { $0.plan.gesture?.start }
    XCTAssertGreaterThanOrEqual(starts.count, 4)
    XCTAssertLessThanOrEqual(starts.max() ?? 0, AvatarConductor.celebrationDelay + 1e-9)
    XCTAssertEqual(starts.filter { $0 == 0 }.count, 2)
    XCTAssertEqual(Set(cues.compactMap { $0.plan.gesture?.kind }), [.twirl, .cheer])
    var last: [String: (owner: String, at: Double)] = [:]
    var seen: [Kind: Int] = [:]
    var now = since
    while now < since + 6 {
      let avatars = (0..<6).map { Avatar(owner: "Bot \($0)", state: .done, since: since, entered: true) }
      watch(conductor, avatars, now: now, last: &last, seen: &seen)
      now += frame
    }
    XCTAssertEqual(seen[.twirl].map { $0 > 0 }, true)
    XCTAssertEqual(seen[.cheer].map { $0 > 0 }, true)
  }

  func testACompletionMovesABookedSpinInsteadOfWaiting() {
    let conductor = AvatarConductor()
    func spin(_ owner: String, _ now: Double) -> Double {
      conductor.cue(owner: owner, state: .working, since: 0, entered: false, held: false, now: now)
        .plan.gesture?.start ?? .nan
    }
    var now = 0.0
    while now < 1 {
      _ = spin("Sage", now)
      now += frame
    }
    let booked = spin("Sage", 1)
    let end = 1 + AvatarConductor.celebrationDelay
    XCTAssertLessThan(booked, end, "Sage's spin is booked where a twirl starting now would be")
    let twirl = conductor.cue(owner: "Juniper", state: .done, since: 1, entered: true, held: false, now: 1)
    XCTAssertEqual(twirl.plan.gesture?.kind, .twirl)
    XCTAssertEqual(twirl.plan.gesture?.start, 0)
    XCTAssertGreaterThanOrEqual(spin("Sage", 1), end - 1e-9)
  }

  func testAHeldPropDropsTheSpin() {
    let conductor = AvatarConductor()
    func sage(_ now: Double, held: Bool = false) -> AvatarMotion.Gesture? {
      conductor.cue(owner: "Sage", state: .working, since: 0, entered: false, held: held, now: now)
        .plan.gesture
    }
    XCTAssertEqual(sage(0)?.kind, .spin)
    var now = 0.0
    while now < 2.9 {
      _ = sage(now)
      now += frame
    }
    _ = sage(2.9, held: true)
    XCTAssertNil(sage(2.9))
    let other = conductor.cue(
      owner: "Juniper", state: .working, since: 0, entered: false, held: false, now: 2.9)
    XCTAssertLessThan(other.plan.gesture?.start ?? .infinity, 2.9 + AvatarConductor.turnGap + 1e-9)
  }
}
