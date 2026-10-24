import XCTest

@testable import AgentInterface

/// Checks AvatarView.swift's motion model and AvatarConductor.swift against the web's. The
/// samples in Motion/avatar-motion.json come from `avatarPose`, `expressionFor`, `pitchEyes`,
/// `tickMarks`, `motionSeed`, `ringOffset` and a scripted household run through the conductor
/// in src/components, written by tests/avatar-motion-parity.test.ts. After an intended web
/// motion change, run `UPDATE_MOTION=1 npx vitest run tests/avatar-motion-parity.test.ts`,
/// commit the samples, and match the Swift side until this passes.
@MainActor
final class AvatarMotionParityTests: XCTestCase {
  typealias M = AvatarMotion
  private static let accuracy = 1e-5

  private struct GestureSample: Decodable {
    var kind: String
    var side: Double
    var start: Double
  }
  private struct PlanSample: Decodable {
    var gesture: GestureSample?
    var previous: GestureSample?
    var boop: Double?
    var phase: Double
    var tempo: Double
  }
  private struct Samples: Decodable {
    struct PoseSample: Decodable {
      var state: String
      var t: Double
      var prop: String?
      var plan: PlanSample
      var pose: [String: Double]
    }
    struct ExpressionSample: Decodable {
      var state: String
      var t: Double
      var plan: PlanSample
      var expression: [String: Double]
    }
    struct PitchSample: Decodable {
      var pitch: Double
      var y: Double
      var scale: Double
      var visible: Bool
    }
    struct TickSample: Decodable {
      var level: Double
      var side: Double
      var top: Double
      var paths: [String]
    }
    struct Ring: Decodable {
      var phase: Double
      var pace: Double
    }
    /// One timeline entry: [seconds, state or null when off screen, held prop].
    struct Entry: Decodable {
      var at: Double
      var state: String?
      var held: Bool
      init(from decoder: Decoder) throws {
        var row = try decoder.unkeyedContainer()
        at = try row.decode(Double.self)
        state = try row.decodeNil() ? nil : row.decode(String.self)
        held = try row.decode(Bool.self)
      }
    }
    struct Member: Decodable {
      var owner: String
      var timeline: [Entry]
    }
    struct Scenario: Decodable {
      var step: Double
      var steps: Int
      var household: [Member]
    }
    struct CueSample: Decodable {
      struct Cue: Decodable {
        var since: Double
        var gesture: GestureSample?
        var previous: GestureSample?
        var boop: Double?
        var phase: Double
        var tempo: Double
      }
      var step: Int
      var avatar: Int
      var cue: Cue
    }
    struct QuietSample: Decodable {
      var plan: PlanSample
      var ahead: Double
      /// `idleQuietAt` every 0.05 s from 0, as 1 for quiet and 0 for not.
      var quiet: String
    }
    var seeds: [String: Double]
    var rings: [String: Ring]
    var quiet: [QuietSample]
    var poses: [PoseSample]
    var expressions: [ExpressionSample]
    var pitch: [PitchSample]
    var ticks: [TickSample]
    var scenario: Scenario
    var cues: [CueSample]
  }

  private func samples() throws -> Samples {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("Motion", isDirectory: true)
      .appendingPathComponent("avatar-motion.json")
    return try JSONDecoder().decode(Samples.self, from: Data(contentsOf: url))
  }
  private func state(_ name: String) throws -> ActivityState {
    try XCTUnwrap(ActivityState(rawValue: name), name)
  }
  private func gesture(_ sample: GestureSample?) throws -> M.Gesture? {
    try sample.map {
      M.Gesture(
        kind: try XCTUnwrap(M.GestureKind(rawValue: $0.kind), $0.kind), side: $0.side,
        start: $0.start)
    }
  }
  private func plan(_ sample: PlanSample) throws -> M.Plan {
    M.Plan(
      gesture: try gesture(sample.gesture), previous: try gesture(sample.previous),
      boop: sample.boop, phase: sample.phase, tempo: sample.tempo)
  }
  private func numbers(_ path: String) -> [Double] {
    path.split { !"-.0123456789".contains($0) }.compactMap { Double($0) }
  }

  private func fields(_ pose: M.Pose) -> [String: Double] {
    [
      "yaw": pose.yaw, "lift": pose.lift, "shiftX": pose.shiftX, "roll": pose.roll,
      "scaleX": pose.scaleX, "scaleY": pose.scaleY, "gazeX": pose.gazeX, "gazeY": pose.gazeY,
      "blink": pose.blink, "trails": pose.trails, "sweep": pose.sweep,
      "symbolTilt": pose.symbolTilt, "pitch": pose.pitch, "eyeScale": pose.eyeScale,
      "ticks": pose.ticks, "tickSide": pose.tickSide,
    ]
  }
  private func fields(_ expression: M.Expression) -> [String: Double] {
    [
      "open": expression.open, "tilt": expression.tilt, "happy": expression.happy,
      "mouth": expression.mouth, "dot": expression.dot,
    ]
  }
  private func assertMatch(
    _ actual: [String: Double], _ expected: [String: Double], _ label: String
  ) {
    XCTAssertEqual(Set(actual.keys), Set(expected.keys), "\(label) fields")
    for (key, value) in expected {
      XCTAssertEqual(
        actual[key] ?? .nan, value, accuracy: Self.accuracy, "\(label) \(key)")
    }
  }
  private func assertMatch(_ actual: M.Gesture?, _ expected: GestureSample?, _ label: String) {
    XCTAssertEqual(actual?.kind.rawValue, expected?.kind, label)
    XCTAssertEqual(actual?.side, expected?.side, label)
    XCTAssertEqual(actual?.start ?? 0, expected?.start ?? 0, accuracy: Self.accuracy, label)
  }

  func testSeedsMatchTheWeb() throws {
    let samples = try samples()
    XCTAssertFalse(samples.seeds.isEmpty)
    for (name, seed) in samples.seeds {
      XCTAssertEqual(M.motionSeed(name), seed, name)
    }
    for (name, ring) in samples.rings {
      let offset = M.ringOffset(name)
      XCTAssertEqual(offset.phase, ring.phase, accuracy: Self.accuracy, name)
      XCTAssertEqual(offset.pace, ring.pace, accuracy: Self.accuracy, name)
    }
  }

  func testPosesMatchTheWeb() throws {
    let samples = try samples()
    XCTAssertGreaterThan(samples.poses.count, 400)
    for sample in samples.poses {
      let prop = try sample.prop.map { try XCTUnwrap(AvatarProp(rawValue: $0), $0) }
      let actual = M.pose(
        try state(sample.state), sample.t, reduce: false, prop: prop, plan: try plan(sample.plan))
      assertMatch(
        fields(actual), sample.pose,
        "\(sample.state) t=\(sample.t) prop=\(sample.prop ?? "-") gesture=\(sample.plan.gesture?.kind ?? "-")")
    }
  }

  func testExpressionsMatchTheWeb() throws {
    let samples = try samples()
    XCTAssertGreaterThan(samples.expressions.count, 100)
    for sample in samples.expressions {
      assertMatch(
        fields(M.expression(for: try state(sample.state), at: sample.t, plan: try plan(sample.plan))),
        sample.expression, "\(sample.state) t=\(sample.t) gesture=\(sample.plan.gesture?.kind ?? "-")")
    }
  }

  /// The idle cadence must slow down at the same moments on both clients, so blinks, gaze shifts,
  /// gestures and arrivals always get every frame.
  func testIdleQuietSpansMatchTheWeb() throws {
    let samples = try samples().quiet
    XCTAssertEqual(samples.count, 2)
    for sample in samples {
      let plan = try plan(sample.plan)
      let actual = (0..<sample.quiet.count).map { step in
        M.idleQuietAt((Double(step) * 0.05 * 1e6).rounded() / 1e6, plan, ahead: sample.ahead) ? "1" : "0"
      }.joined()
      XCTAssertEqual(actual, sample.quiet, "gesture \(sample.plan.gesture?.kind ?? "-")")
      // Both kinds of span occur, so a model that is always quiet or never quiet fails.
      XCTAssertTrue(sample.quiet.contains("0") && sample.quiet.contains("1"))
    }
  }

  func testFaceRollMatchesTheWeb() throws {
    // The samples store the pitch rounded to 1e-6 while the web computed from the exact angle,
    // and `y` multiplies that rounding by the face radius, so it gets a matching allowance.
    let heightAccuracy = Self.accuracy * M.faceRadius * 2
    for sample in try samples().pitch {
      let roll = M.pitchEyes(sample.pitch)
      XCTAssertEqual(roll.y, sample.y, accuracy: heightAccuracy, "pitch \(sample.pitch)")
      XCTAssertEqual(roll.scale, sample.scale, accuracy: Self.accuracy, "pitch \(sample.pitch)")
      XCTAssertEqual(roll.visible, sample.visible, "pitch \(sample.pitch)")
    }
  }

  func testTickMarksMatchTheWeb() throws {
    for sample in try samples().ticks {
      let label = "level \(sample.level) side \(sample.side) top \(sample.top)"
      let paths = M.tickMarks(level: sample.level, side: sample.side, top: sample.top)
      XCTAssertEqual(paths.count, sample.paths.count, label)
      for (actual, expected) in zip(paths, sample.paths) {
        let a = numbers(actual)
        let e = numbers(expected)
        XCTAssertEqual(a.count, e.count, "\(label) \(actual)")
        for (x, y) in zip(a, e) { XCTAssertEqual(x, y, accuracy: Self.accuracy, label) }
      }
    }
  }

  /// Replays the web's scripted household through the native conductor; every cue change must
  /// land on the same step with the same gesture, start, boop and pace.
  func testConductorMatchesTheWeb() throws {
    let samples = try samples()
    let scenario = samples.scenario
    let conductor = AvatarConductor()
    var views = scenario.household.map { _ in
      (state: ActivityState?.none, since: 0.0, entered: false, last: M.Cue?.none)
    }
    var log: [(step: Int, avatar: Int, cue: M.Cue)] = []
    for step in 0..<scenario.steps {
      let now = Double(step) * scenario.step
      for (avatar, member) in scenario.household.enumerated() {
        guard let entry = member.timeline.last(where: { $0.at <= now }), let name = entry.state
        else {
          views[avatar].state = nil
          continue
        }
        let state = try state(name)
        if state != views[avatar].state {
          views[avatar] = (state, now, views[avatar].state != nil, views[avatar].last)
        }
        let view = views[avatar]
        let cue = conductor.cue(
          owner: member.owner, state: state, since: view.since, entered: view.entered,
          held: entry.held, now: now)
        if cue != view.last { log.append((step, avatar, cue)) }
        views[avatar].last = cue
      }
    }
    XCTAssertGreaterThan(samples.cues.count, 50)
    XCTAssertEqual(log.count, samples.cues.count)
    for (actual, expected) in zip(log, samples.cues) {
      let label = "step \(expected.step) avatar \(expected.avatar)"
      XCTAssertEqual(actual.step, expected.step, label)
      XCTAssertEqual(actual.avatar, expected.avatar, label)
      XCTAssertEqual(actual.cue.since, expected.cue.since, accuracy: Self.accuracy, label)
      XCTAssertEqual(actual.cue.plan.phase, expected.cue.phase, accuracy: Self.accuracy, label)
      XCTAssertEqual(actual.cue.plan.tempo, expected.cue.tempo, accuracy: Self.accuracy, label)
      XCTAssertEqual(actual.cue.plan.boop ?? -1, expected.cue.boop ?? -1, accuracy: Self.accuracy, label)
      assertMatch(actual.cue.plan.gesture, expected.cue.gesture, "\(label) gesture")
      assertMatch(actual.cue.plan.previous, expected.cue.previous, "\(label) previous")
    }
  }

  /// The native timeline reads expressions in closed form instead of stepping each frame, so
  /// it must agree with the web's stepwise approach even across thinking idea beats.
  func testClosedFormExpressionFollowsRepeatedApproach() {
    let start = M.expression(for: .working, at: 0)
    let first = M.Gesture(kind: .idea, side: 1, start: 4.6)
    let second = M.Gesture(kind: .idea, side: -1, start: 11.3)
    func plan(_ t: Double) -> M.Plan {
      t < first.start + M.thinkBeat
        ? M.Plan(gesture: first) : M.Plan(gesture: second, previous: first)
    }
    let step = 1.0 / 1000
    var stepped = start
    var t = 0.0
    var checks = 0
    while t < 14 {
      stepped = M.approach(stepped, M.expression(for: .thinking, at: t, plan: plan(t)), step)
      t += step
      if Int((t / step).rounded()) % 250 == 0 {
        let closed = M.expression(from: start, toward: .thinking, after: t, plan: plan(t))
        for (key, value) in fields(stepped) {
          XCTAssertEqual(fields(closed)[key] ?? .nan, value, accuracy: 0.01, "\(key) at \(t)")
        }
        checks += 1
      }
    }
    XCTAssertGreaterThan(checks, 40)
  }
}
