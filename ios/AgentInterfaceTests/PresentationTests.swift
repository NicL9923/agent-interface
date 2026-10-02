import XCTest

@testable import AgentInterface

final class PresentationTests: XCTestCase {
  func testReadAnchorSkipsCanonicalToolsWithoutVisibleRows() {
    let conversation = Conversation(
      botId: "bot",
      messages: [
        Message(id: "before", role: "user", text: "a"),
        Message(id: "tool", role: "tool", text: "b"),
        Message(id: "after", role: "assistant", text: "c"),
        Message(id: "last-tool", role: "tool", text: "d"),
      ], activity: Activity(state: .idle), approvals: [], files: [])
    XCTAssertEqual(conversation.restorableReadAnchor("before"), "before")
    XCTAssertEqual(conversation.restorableReadAnchor("tool"), "after")
    XCTAssertNil(conversation.restorableReadAnchor("last-tool"))
    XCTAssertNil(conversation.restorableReadAnchor("missing"))
  }
  func testCurrentToolCallsMergeWithCanonicalResultsByTheirActualID() throws {
    let json = """
      {"botId":"bot","messages":[{"id":"assistant","role":"assistant","text":"","toolCall":{"id":"call-one","name":"read_file","arguments":"{\\"path\\":\\"note.txt\\"}","status":"completed","result":"Saved note"}}],"activity":{"state":"working"},"approvals":[],"files":[],"toolCalls":[{"id":"call-one","name":"read_file","status":"running"},{"id":"call-two","name":"web_search","status":"running"}]}
      """
    let conversation = try JSONDecoder().decode(Conversation.self, from: Data(json.utf8))
    XCTAssertEqual(conversation.activityMessages.compactMap { $0.toolCall?.id }, ["call-one", "call-two"])
    XCTAssertEqual(conversation.activityMessages.first?.toolCall?.result, "Saved note")
    XCTAssertEqual(conversation.activityMessages.first?.toolCall?.arguments, "{\"path\":\"note.txt\"}")
    XCTAssertEqual(conversation.visibleMessages.map(\.id),["assistant"])
    XCTAssertEqual(conversation.restorableReadAnchor("assistant"),"assistant")
    var mixed = conversation
    mixed.messages[0].text = "Here is the answer."
    XCTAssertEqual(mixed.visibleMessages.map(\.id), ["assistant"])
    var tool = Message(id: "canonical-tool", role: "tool", text: "Actual canonical result", toolCall: ToolCall(id: "call", name: "read_file", status: "completed"))
    XCTAssertEqual(tool.toolResult, "Actual canonical result")
    tool.role = "assistant"
    XCTAssertEqual(tool.toolResult, "", "Assistant answer text is not a tool result")
  }
  func testTaskListsAreReadOnlyCompletionIndicatorsAndOrdinaryListsKeepMarkers() throws {
    let done = try XCTUnwrap(MarkdownView.listRow("- [x] Finished **work**"))
    XCTAssertEqual(done.completed, true)
    XCTAssertEqual(done.text, "Finished **work**")
    let pending = try XCTUnwrap(MarkdownView.listRow("* [ ] Pending work"))
    XCTAssertEqual(pending.completed, false)
    XCTAssertEqual(pending.text, "Pending work")
    XCTAssertEqual(MarkdownView.listRow("2. Next step")?.marker, "2.")
    XCTAssertEqual(
      MarkdownView.blocks("- [x] Done\n- [ ] Waiting\n\nParagraph").map(\.kind), ["list", "text"])
  }
  func testNativeReadAnchorDoesNotClaimABrowserPixelOffset() throws {
    let encoded = try JSONEncoder().encode(ReadPosition(messageId: "visible-message"))
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    XCTAssertEqual(object["messageId"] as? String, "visible-message")
    XCTAssertNil(object["scrollTop"])
  }
  func testActualServerTimestampAndPlainISOAreAccepted() {
    XCTAssertNotNil(ServerDate.parse("2026-10-07T09:08:21.125Z"))
    XCTAssertNotNil(ServerDate.parse("2026-10-07T09:08:21Z"))
    XCTAssertNil(ServerDate.parse("not a date"))
  }
  func testMarkdownKeepsBlankTableCellsAndEscapedPipes() {
    XCTAssertEqual(MarkdownView.tableCells("| First | | Last |"), ["First", "", "Last"])
    XCTAssertEqual(MarkdownView.tableCells("| A\\|B | C |"), ["A|B", "C"])
    XCTAssertEqual(MarkdownView.tableCells("A | B"), ["A", "B"])
    let blocks = MarkdownView.blocks(
      "# Title\n\n| A | B |\n| --- | --- |\n| Hello | |\n\n```swift\nlet n = 1\n```")
    XCTAssertEqual(blocks.map(\.kind), ["heading", "table", "code"])
    XCTAssertEqual(blocks.last?.text, "let n = 1")
  }
  func testEveryAvatarSilhouetteSupportsFiniteConsistentMorphing() {
    for shape in AvatarConfig.shapes + ["mascot"] + AvatarConfig.seasonalColors.keys.sorted() {
      let points = AvatarGeometry.points(shape)
      XCTAssertEqual(points.values.count, 144, shape)
      XCTAssertTrue(points.values.allSatisfy(\.isFinite), shape)
      XCTAssertGreaterThan(points.magnitudeSquared, 0)
    }
  }
  func testSeasonalAvatarsDecodeAndKeepCustomizationWhenSelected() throws {
    for (family, color) in AvatarConfig.seasonalColors {
      let data = Data("{\"mode\":\"mascot\",\"family\":\"\(family)\",\"color\":\"#111111\",\"eyes\":\"spark\",\"accessory\":\"glasses\",\"eyeSpacing\":1.3}".utf8)
      let saved = try JSONDecoder().decode(AvatarConfig.self, from: data)
      XCTAssertEqual(saved.geometry, family)
      XCTAssertEqual(try JSONDecoder().decode(AvatarConfig.self, from: JSONEncoder().encode(saved)), saved)
      let selected = saved.selectingFamily(family)
      XCTAssertEqual(selected.color, color)
      XCTAssertEqual(selected.eyes, "spark")
      XCTAssertEqual(selected.accessory, "glasses")
      XCTAssertEqual(selected.eyeSpacing, 1.3)
      XCTAssertTrue(AvatarConfig.families.contains { $0.id == family })
      XCTAssertNotEqual(AvatarGeometry.svg(family), AvatarGeometry.mascotHead)
    }
    let original = AvatarConfig(mode: "mascot", color: "#111111")
    XCTAssertEqual(original.selectingFamily("fox").color, "#111111")
  }
  @MainActor func testPushRoutesOnlyRelativeConversationURL() {
    let origin = URL(string: "https://household.example")!
    XCTAssertEqual(NotificationController.botId(from: "/?bot=a%2Fb", origin: origin), "a/b")
    XCTAssertNil(NotificationController.botId(from: "https://evil.example/?bot=a", origin: origin))
    XCTAssertNil(NotificationController.botId(from: "//evil.example/?bot=a", origin: origin))
    XCTAssertNil(NotificationController.botId(from: "/api/files/a?bot=b", origin: origin))
  }
  func testAgentMessagesAndHandoffsStayVisibleInSimplePresentation() {
    let incoming = Message(id: "in", role: "user", text: "Message from 🤖 Ledger (@ledger): Check the gate battery.")
    XCTAssertEqual(incoming.agentEnvelope?.name, "Ledger")
    XCTAssertEqual(incoming.agentEnvelope?.body, "Check the gate battery.")
    var human = incoming; human.sender = Sender(id: "one", name: "Nicolas")
    XCTAssertNil(human.agentEnvelope)
    let handoff = Message(id: "out", role: "tool", text: "Delivered", toolCall: ToolCall(id: "call", name: "message_agent", status: "completed"))
    let conversation = Conversation(botId: "ranch", messages: [incoming, handoff], activity: Activity(state: .idle), approvals: [], files: [])
    XCTAssertEqual(conversation.visibleMessages.map(\.id), ["in", "out"])
  }
  func testNativeGroupAndRoutineOutputContractsDecodeWithoutInventingAttribution() throws {
    let page = try JSONDecoder().decode(GroupPage.self, from: Data(#"{"events":[{"event_id":"e1","seq":1,"kind":"message.user","created_at":1790935200,"actor":{"kind":"user","id":"desktop"},"payload":{"text":"Check the gates","thread_id":"thread-1"}}],"cursor":1,"has_more":false}"#.utf8))
    XCTAssertEqual(page.events.first?.payload.thread_id, "thread-1")
    let output = try JSONDecoder().decode(RoutineOutput.self, from: Data(#"{"messages":[{"id":"cron-output","role":"assistant","text":"Gate is ready"}],"previewOnly":false}"#.utf8))
    XCTAssertEqual(output.messages.first?.text, "Gate is ready"); XCTAssertFalse(output.previewOnly)
  }
}

/// Mirrors tests/avatar-motion.test.ts so the native rig keeps the web's motion contract.
final class AvatarMotionTests: XCTestCase {
  typealias M = AvatarMotion
  private func samples(_ from: Double, _ to: Double, _ step: Double = 0.02) -> [Double] {
    (0..<Int(((to - from) / step).rounded())).map { from + Double($0) * step }
  }

  func testDisconnectedAndInterruptedNeverMove() {
    for state in [ActivityState.disconnected, .interrupted] {
      for t in samples(0, 6, 0.37) { XCTAssertEqual(M.pose(state, t, reduce: false), M.restingPose) }
    }
  }
  func testReducedMotionHoldsEveryStateStill() {
    for state in [ActivityState.idle, .working, .done, .blocked] {
      for t in [0, 1.3, 7] { XCTAssertEqual(M.pose(state, t, reduce: true), M.restingPose) }
    }
    let snapshot = M.Snapshot.entering(.done, at: Date())
    let still = M.frame(snapshot, at: Date().addingTimeInterval(0.4), still: true)
    XCTAssertEqual(still.pose, M.restingPose)
    XCTAssertEqual(still.trailLevel, 0)
    XCTAssertEqual(still.expression.happy, 1, "A still completed avatar shows its settled face")
  }
  func testTimelinePausesWhenNothingCanMove() {
    func paused(
      _ state: ActivityState, reduce: Bool = false, visible: Bool = true, active: Bool = true,
      settling: Bool = false
    ) -> Bool {
      M.timelinePaused(
        state, reduceMotion: reduce, visible: visible, active: active, settling: settling)
    }
    XCTAssertFalse(paused(.working))
    XCTAssertTrue(paused(.working, reduce: true))
    XCTAssertTrue(paused(.working, visible: false), "Offscreen avatars stop")
    XCTAssertTrue(paused(.working, active: false), "Background scenes stop")
    XCTAssertFalse(paused(.working, visible: true), "Avatars resume when visible again")
    XCTAssertFalse(paused(.failed, settling: true), "A failure shakes on entry")
    XCTAssertTrue(paused(.failed), "then holds still")
    for state in M.frozenStates {
      XCTAssertTrue(paused(state, settling: true), "\(state) never ticks")
    }
  }
  func testWorkingKeepsTheFaceForwardUntilASpinTurnsItAway() {
    let scanEnd = M.workCycle - M.workSpin
    for t in samples(0, scanEnd) {
      let pose = M.pose(.working, t, reduce: false)
      XCTAssertTrue(M.project(0, yaw: pose.yaw).visible, "t=\(t)")
      XCTAssertEqual(pose.trails, 0)
    }
    let spin = samples(scanEnd, M.workCycle).map { M.pose(.working, $0, reduce: false) }
    XCTAssertTrue(spin.contains { !M.project(0, yaw: $0.yaw).visible })
    XCTAssertGreaterThan(spin.map(\.trails).max() ?? 0, 0.9)
  }
  func testCompletionSettlesIntoACalmHappyFace() {
    let celebrating = samples(0, M.celebration).map { M.pose(.done, $0, reduce: false) }
    XCTAssertEqual(celebrating.map(\.trails).max(), 1)
    let after = M.pose(.done, M.celebration + 2, reduce: false)
    XCTAssertEqual(after.trails, 0)
    XCTAssertTrue(M.project(0, yaw: after.yaw).visible)
    XCTAssertEqual(M.expression(for: .done, at: M.celebration + 2).happy, 1)
    let start = M.expression(for: .working, at: 0)
    XCTAssertEqual(
      M.expression(from: start, toward: .done, after: M.celebration + 2).happy, 1, accuracy: 0.001)
  }
  func testBlinksAreBrief() {
    let openness = samples(0, 12, 0.01).map(M.blinkAt)
    XCTAssertLessThan(openness.min() ?? 1, 0.2)
    XCTAssertLessThan(Double(openness.filter { $0 < 1 }.count) / Double(openness.count), 0.15)
  }
  func testFarSideFeaturesAreHidden() {
    XCTAssertTrue(M.project(15, yaw: 0).visible)
    XCTAssertFalse(M.project(15, yaw: .pi).visible)
  }
  func testTrailsSplitIntoArcsBehindAndInFrontOfTheBody() {
    let arcs = M.orbitArcs(head: 1.5 * .pi, length: .pi, rx: 58, ry: 13, tilt: 0)
    XCTAssertFalse(arcs.back.isEmpty)
    XCTAssertFalse(arcs.front.isEmpty)
  }
  func testFaceInkPicksReadableColors() {
    XCTAssertEqual(M.faceInk("#1084FE"), "#fff9ee")
    XCTAssertEqual(M.faceInk("#FFE45C"), "#2b201b")
    XCTAssertEqual(M.faceInk("#FF9800", mascot: true), "#2b201b")
    XCTAssertEqual(M.faceInk("#111111", mascot: true), "#fff3db")
    XCTAssertEqual(M.faceInk("not-a-color"), "#fff9ee")
    XCTAssertEqual(M.faceInk("#C3C3C3"), "#2b201b")
    for color in AvatarConfig.colors { XCTAssertEqual(M.faceInk(color), "#fff9ee", color) }
    XCTAssertEqual(M.tint("#FF9800", 0.45), "#ffc673")
  }
  func testSmoothingIsContinuousAcrossStateChanges() {
    let now = Date()
    let working = M.Snapshot.entering(.working, at: now)
    // Leave mid-spin: the trails carry over and fade instead of vanishing.
    let midSpin = now.addingTimeInterval(M.workCycle - M.workSpin / 2)
    let before = M.frame(working, at: midSpin, still: false)
    let waiting = M.next(working, to: .waiting, at: midSpin, still: false)
    let after = M.frame(waiting, at: midSpin, still: false)
    XCTAssertGreaterThan(before.trailLevel, 0.9)
    XCTAssertEqual(after.trailLevel, before.trailLevel, accuracy: 0.0001)
    XCTAssertEqual(after.expression, before.expression)
    XCTAssertEqual(M.frame(waiting, at: midSpin.addingTimeInterval(0.7), still: false).trailLevel, 0)
    // Thinking dots settle in with the morph time constant.
    let thinking = M.next(M.Snapshot.entering(.idle, at: now), to: .thinking, at: now, still: false)
    XCTAssertEqual(M.frame(thinking, at: now, still: false).morph.dots, 0)
    XCTAssertGreaterThan(M.frame(thinking, at: now.addingTimeInterval(0.6), still: false).morph.dots, 0.98)
  }
}
