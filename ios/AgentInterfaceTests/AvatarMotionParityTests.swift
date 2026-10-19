import XCTest

@testable import AgentInterface

/// Checks AvatarView.swift's motion model against the web's. The samples in
/// Motion/avatar-motion.json come from `avatarPose`, `expressionFor`, `pitchEyes`, `tickMarks`
/// and `motionSeed` in src/components/avatar-motion.ts, written by
/// tests/avatar-motion-parity.test.ts. After an intended web motion change, run
/// `UPDATE_MOTION=1 npx vitest run tests/avatar-motion-parity.test.ts`, commit the samples,
/// and match AvatarView.swift until this passes.
final class AvatarMotionParityTests: XCTestCase {
  typealias M = AvatarMotion
  private static let accuracy = 1e-5

  private struct Samples: Decodable {
    struct PoseSample: Decodable {
      var state: String
      var t: Double
      var prop: String?
      var seed: Double
      var pose: [String: Double]
    }
    struct ExpressionSample: Decodable {
      var state: String
      var t: Double
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
    var seeds: [String: Double]
    var poses: [PoseSample]
    var expressions: [ExpressionSample]
    var pitch: [PitchSample]
    var ticks: [TickSample]
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

  func testSeedsMatchTheWeb() throws {
    let samples = try samples()
    XCTAssertFalse(samples.seeds.isEmpty)
    for (name, seed) in samples.seeds {
      XCTAssertEqual(M.motionSeed(name), seed, name)
    }
  }

  func testPosesMatchTheWeb() throws {
    let samples = try samples()
    XCTAssertGreaterThan(samples.poses.count, 400)
    for sample in samples.poses {
      let prop = try sample.prop.map { try XCTUnwrap(AvatarProp(rawValue: $0), $0) }
      let actual = M.pose(
        try state(sample.state), sample.t, reduce: false, prop: prop, seed: sample.seed)
      assertMatch(
        fields(actual), sample.pose,
        "\(sample.state) t=\(sample.t) prop=\(sample.prop ?? "-") seed=\(sample.seed)")
    }
  }

  func testExpressionsMatchTheWeb() throws {
    let samples = try samples()
    XCTAssertGreaterThan(samples.expressions.count, 100)
    for sample in samples.expressions {
      assertMatch(
        fields(M.expression(for: try state(sample.state), at: sample.t)), sample.expression,
        "\(sample.state) t=\(sample.t)")
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

  /// The native timeline reads expressions in closed form instead of stepping each frame, so
  /// it must agree with the web's stepwise approach even across a thinking idea beat.
  func testClosedFormExpressionFollowsRepeatedApproach() {
    let start = M.expression(for: .working, at: 0)
    let step = 1.0 / 1000
    var stepped = start
    var t = 0.0
    var checks = 0
    while t < 14 {
      stepped = M.approach(stepped, M.expression(for: .thinking, at: t), step)
      t += step
      if Int((t / step).rounded()) % 500 == 0 {
        let closed = M.expression(from: start, toward: .thinking, after: t)
        for (key, value) in fields(stepped) {
          XCTAssertEqual(fields(closed)[key] ?? .nan, value, accuracy: 0.01, "\(key) at \(t)")
        }
        checks += 1
      }
    }
    XCTAssertGreaterThan(checks, 20)
  }
}
