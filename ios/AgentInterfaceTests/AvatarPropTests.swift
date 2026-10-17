import SwiftUI
import XCTest

@testable import AgentInterface

/// Mirrors the held-prop cases in tests/avatar-motion.test.ts. Expected numbers come from the
/// web's `propMotion` and `avatarPose` in src/components/avatar-motion.ts.
final class AvatarPropTests: XCTestCase {
  typealias M = AvatarMotion

  func testPicksTheWebPropForEachToolName() {
    let cases: [(String?, AvatarProp?)] = [
      ("web_search", .search), ("browser_navigate", .search), ("search_files", .search),
      ("vision_analyze", .search), ("Web_Search", .search),
      ("terminal", .computer), ("execute_code", .computer), ("process", .computer),
      ("read_file", .read), ("skill_view", .read),
      ("write_file", .write), ("patch", .write), ("calendar.create_event", .write), ("todo", .write),
      ("memory", .write),
      ("send_message", nil), ("", nil), (nil, nil),
    ]
    for (tool, prop) in cases { XCTAssertEqual(AvatarProp.from(tool: tool), prop, tool ?? "nil") }
  }

  func testEarlierPropsWinWhenANameMatchesSeveral() {
    XCTAssertEqual(AvatarProp.from(tool: "code_search"), .search, "search beats computer")
    XCTAssertEqual(AvatarProp.from(tool: "list_processes"), .computer, "computer beats read")
    XCTAssertEqual(AvatarProp.from(tool: "read_write"), .read, "read beats write")
  }

  func testHoldsThePropForTheLatestRunningToolCall() {
    let calls = [
      ToolCall(id: "1", name: "web_search", status: "running"),
      ToolCall(id: "2", name: "terminal", status: "running"),
      ToolCall(id: "3", name: "write_file", status: "completed"),
    ]
    XCTAssertEqual(AvatarProp.from(toolCalls: calls), .computer)
    XCTAssertNil(AvatarProp.from(toolCalls: [ToolCall(id: "1", name: "read_file", status: "completed")]))
    XCTAssertNil(AvatarProp.from(toolCalls: nil))
  }

  func testPropMotionMatchesTheWebFormulas() {
    let expected: [(AvatarProp, Double, M.PropPlacement)] = [
      (.search, 0, .init(x: 72, y: 70, rotate: -8)),
      (.search, 0.7, .init(x: 80.10090397958854, y: 71.96078981271106, rotate: -2.59939734694097)),
      (.search, 2.5, .init(x: 65.18877754222865, y: 72.47339561655845, rotate: -12.540814971847569)),
      (.computer, 0, .init(x: 50, y: 88, rotate: 0)),
      (.computer, 2.5, .init(x: 50, y: 87.75641274376974, rotate: 0)),
      (.read, 0.7, .init(x: 50, y: 86.83049737049197, rotate: 0.9412517763423159)),
      (.read, 2.5, .init(x: 50, y: 85.64921677231038, rotate: 1.9679718937478738)),
      (.write, 0, .init(x: 74, y: 79.2, rotate: 0)),
      (.write, 0.7, .init(x: 71.54386846843917, y: 79.40210435919164, rotate: 0)),
    ]
    for (prop, t, place) in expected {
      let actual = M.propMotion(prop, t)
      XCTAssertEqual(actual.x, place.x, accuracy: 1e-9, "\(prop) x at \(t)")
      XCTAssertEqual(actual.y, place.y, accuracy: 1e-9, "\(prop) y at \(t)")
      XCTAssertEqual(actual.rotate, place.rotate, accuracy: 1e-9, "\(prop) rotate at \(t)")
    }
  }

  func testWorkingPoseWatchesThePropLikeTheWeb() {
    // (prop, t, gazeX, gazeY, roll, lift) from avatarPose("working", t, false, prop).
    let expected: [(AvatarProp, Double, Double, Double, Double, Double)] = [
      (.search, 0.7, 0.6750753316323781, 0.4, 2.0252259948971343, -0.7769187023368357),
      (.computer, 0.7, 0.09176470588235286, 0.85, 0, -0.7853256525790105),
      (.computer, 2.5, 0.45882352941176474, 0.85, 0, 0.5558469749500476),
      (.read, 0.7, -0.20470588235294118, 0.85, 0, -0.7769187023368357),
      (.write, 2.5, 0.4329248793438211, 0.7, 3, 0.7994342311803024),
    ]
    for (prop, t, gazeX, gazeY, roll, lift) in expected {
      let pose = M.pose(.working, t, reduce: false, prop: prop)
      XCTAssertEqual(pose.gazeX, gazeX, accuracy: 1e-9, "\(prop) gazeX at \(t)")
      XCTAssertEqual(pose.gazeY, gazeY, accuracy: 1e-9, "\(prop) gazeY at \(t)")
      XCTAssertEqual(pose.roll, roll, accuracy: 1e-9, "\(prop) roll at \(t)")
      XCTAssertEqual(pose.lift, lift, accuracy: 1e-9, "\(prop) lift at \(t)")
      XCTAssertEqual(pose.yaw, gazeX * 0.12, accuracy: 1e-9)
    }
    let search = M.pose(.working, 0.7, reduce: false, prop: .search)
    XCTAssertEqual(search.scaleX, 0.9917717535061659, accuracy: 1e-9)
    XCTAssertEqual(search.scaleY, 1.0131271330972433, accuracy: 1e-9)
  }

  func testHeldPropReplacesTheSpinWithCalmMotion() {
    let times = (0..<380).map { Double($0) * 0.02 }
    for prop in AvatarProp.allCases {
      let poses = times.map { M.pose(.working, $0, reduce: false, prop: prop) }
      XCTAssertTrue(poses.allSatisfy { M.project(0, yaw: $0.yaw).visible && $0.trails == 0 }, "\(prop)")
      let gaze = poses.map(\.gazeX)
      XCTAssertGreaterThan(gaze.max()! - gaze.min()!, 0.1, "\(prop) eyes follow the prop")
      XCTAssertEqual(M.pose(.working, 1.3, reduce: true, prop: prop), M.restingPose)
    }
  }

  func testOnlyAWorkingFrameHoldsTheProp() {
    let now = Date()
    let working = M.Snapshot.entering(.working, at: now)
    let moving = M.frame(working, at: now.addingTimeInterval(1), still: false, prop: .read, propSince: now)
    XCTAssertEqual(moving.prop, .read)
    XCTAssertEqual(moving.propAge, 1, accuracy: 1e-9)
    let still = M.frame(working, at: now.addingTimeInterval(1), still: true, prop: .read, propSince: now)
    XCTAssertEqual(still.prop, .read, "Reduced motion still shows the prop")
    XCTAssertEqual(still.propAge, 1, "A still prop is fully grown")
    XCTAssertEqual(still.pose, M.restingPose)
    let waiting = M.frame(M.Snapshot.entering(.waiting, at: now), at: now, still: false, prop: .read)
    XCTAssertNil(waiting.prop)
  }

  func testPropPopsInWithASpringyOvershoot() {
    XCTAssertEqual(M.popIn(0), 0, accuracy: 1e-12)
    XCTAssertEqual(M.popIn(1), 1, accuracy: 1e-12)
    XCTAssertGreaterThan((0...20).map { M.popIn(Double($0) / 20) }.max()!, 1.04)
  }
}

/// Renders every held prop to PNG for visual review. Skipped unless the runner sets
/// AGENT_INTERFACE_EVIDENCE_DIR, which xcodebuild forwards from TEST_RUNNER_AGENT_INTERFACE_EVIDENCE_DIR.
@MainActor final class AvatarPropEvidenceTests: XCTestCase {
  func testRenderPropEvidence() throws {
    let path = ProcessInfo.processInfo.environment["AGENT_INTERFACE_EVIDENCE_DIR"] ?? ""
    try XCTSkipUnless(!path.isEmpty, "Set AGENT_INTERFACE_EVIDENCE_DIR to render evidence.")
    let directory = URL(fileURLWithPath: path, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let avatars: [(String, AvatarConfig)] = [
      ("blob", AvatarConfig()),
      ("fox", AvatarConfig(mode: "mascot", shape: nil, family: "fox", color: "#FF6700")),
      ("triangle", AvatarConfig(shape: "triangle", color: "#292929", eyes: "visor")),
    ]
    let size = 160.0
    let base = Date()
    for dark in [false, true] {
      let row = HStack(spacing: 24) {
        ForEach(AvatarProp.allCases, id: \.self) { prop in
          VStack(spacing: 24) {
            ForEach(avatars, id: \.0) { _, avatar in
              ForEach([0.0, 0.7], id: \.self) { t in
                Canvas { context, _ in
                  var ctx = context
                  ctx.translateBy(x: size * 0.2, y: size * 0.2)
                  ctx.scaleBy(x: size / 116, y: size / 116)
                  ctx.translateBy(x: 8, y: 8)
                  AvatarArtwork(
                    avatar: avatar, state: .working,
                    frame: AvatarMotion.frame(
                      .entering(.working, at: base), at: base.addingTimeInterval(t), still: t == 0,
                      prop: prop, propSince: .distantPast),
                    still: t == 0, body: AvatarGeometry.path(avatar.geometry),
                    bodyColor: Color(hex: avatar.color ?? "#1084FE")
                  ).draw(ctx)
                }.frame(width: size * 1.4, height: size * 1.4)
              }
            }
          }
        }
      }.padding(24).background(Palette.surface(dark ? .dark : .light))
      let renderer = ImageRenderer(content: row.environment(\.colorScheme, dark ? .dark : .light))
      renderer.scale = 2
      let image = try XCTUnwrap(renderer.uiImage)
      try XCTUnwrap(image.pngData()).write(
        to: directory.appendingPathComponent("avatar-props-\(dark ? "dark" : "light").png"))
    }
  }
}
