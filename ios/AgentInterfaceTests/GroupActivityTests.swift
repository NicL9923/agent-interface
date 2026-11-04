import XCTest
@testable import AgentInterface

/// Group chat live work, room settings and routine posts. The web's tests/group-activity.test.ts checks the same rules.
@MainActor final class GroupActivityTests: XCTestCase {
  private let members = [
    GroupMember(member_id: "ranch", profile: "ranch", handle: "ranch", display_name: "Ranch hand"),
    GroupMember(member_id: "planner", profile: "planner", handle: "planner", display_name: "Planner"),
    GroupMember(member_id: "cook", profile: "cook", handle: "cook", display_name: nil),
  ]
  private func driver(_ activity: [GroupMemberActivity], maxRounds: Int? = 3) -> GroupDriver {
    GroupDriver(working: !activity.isEmpty, blocked: false, pending_actions: [], member_activity: activity, max_rounds: maxRounds)
  }
  private func event(_ json: String) throws -> GroupEvent { try JSONDecoder().decode(GroupEvent.self, from: Data(json.utf8)) }

  func testSimpleSaysWhoIsWorkingAndAdvancedAddsToolAndRound() {
    let status = driver([
      GroupMemberActivity(member_id: "planner", status: "running", round_index: 1, started_at: 1, tool: "web_search"),
      GroupMemberActivity(member_id: "cook", status: "queued", round_index: 1),
    ])
    XCTAssertEqual(GroupActivity.lines(status, members: members, advanced: false), [
      .init(memberId: "planner", sentence: "Planner is working...", round: nil),
      .init(memberId: "cook", sentence: "cook is waiting to start...", round: nil),
    ])
    XCTAssertEqual(GroupActivity.lines(status, members: members, advanced: true), [
      .init(memberId: "planner", sentence: "Planner is using web_search...", round: "Round 2 of 3"),
      .init(memberId: "cook", sentence: "cook is waiting to start...", round: "Round 2 of 3"),
    ])
  }

  func testOneLinePerAssistantFromItsRunningTurn() {
    let status = driver([
      GroupMemberActivity(member_id: "ranch", status: "queued", round_index: 2),
      GroupMemberActivity(member_id: "ranch", status: "running", round_index: 1, tool: "  "),
      GroupMemberActivity(member_id: "planner", status: "stopping", round_index: 0, tool: "terminal"),
      GroupMemberActivity(member_id: "gone", status: "running"),
    ], maxRounds: nil)
    XCTAssertEqual(GroupActivity.lines(status, members: members, advanced: true), [
      .init(memberId: "ranch", sentence: "Ranch hand is working...", round: "Round 2"),
      .init(memberId: "planner", sentence: "Planner is stopping...", round: "Round 1"),
      .init(memberId: "gone", sentence: "gone is working...", round: nil),
    ])
    XCTAssertEqual(GroupActivity.lines(nil, members: members, advanced: true), [])
  }

  func testComposerHintCoversAttentionOlderHermesAndALead() {
    XCTAssertEqual(GroupActivity.status(GroupDriver(working: false, blocked: true, pending_actions: []), context: nil, members: members), "Discussion needs attention.")
    XCTAssertEqual(GroupActivity.status(GroupDriver(working: true, blocked: false, pending_actions: []), context: nil, members: members), "Assistants are discussing…")
    XCTAssertEqual(GroupActivity.status(driver([GroupMemberActivity(member_id: "ranch", status: "running")]), context: nil, members: members), "Type @ to address one assistant.")
    let lead = GroupContext(purpose: "", notes: "", routing: "lead", lead_member_id: "planner")
    XCTAssertEqual(GroupActivity.status(nil, context: lead, members: members), "Type @ to address one assistant. Otherwise Planner picks who answers.")
  }

  func testLeadHandOffsAreWordedAndAnUnreadablePayloadNeverFailsThePage() throws {
    func assignment(_ payload: String) throws -> String? {
      try GroupActivity.assignment(event(#"{"event_id":"a","seq":2,"kind":"room.assignment","created_at":2,"actor":{"kind":"gateway","id":"g"},"payload":\#(payload)}"#), members: members)
    }
    XCTAssertEqual(try assignment(#"{"lead_member_id":"planner","member_ids":["ranch","cook"]}"#), "Planner gave this to Ranch hand and cook.")
    XCTAssertEqual(try assignment(#"{"lead_member_id":"planner","member_ids":["planner"],"fallback":true}"#), "Planner took this one.")
    XCTAssertEqual(try assignment(#"{"lead_member_id":"planner","member_ids":["planner","ranch"]}"#), "Planner is answering this with Ranch hand.")
    XCTAssertNil(try assignment(#"{"lead_member_id":"planner","member_ids":"ranch"}"#))
    let page = try JSONDecoder().decode(GroupPage.self, from: Data(#"{"events":[{"event_id":"m","seq":1,"kind":"message.user","created_at":1,"payload":{"text":"Who fixes the gate?","thread_id":"t"}},{"event_id":"a","seq":2,"kind":"room.assignment","created_at":2,"payload":{"lead_member_id":7,"member_ids":["ranch"]}},{"event_id":"c","seq":3,"kind":"room.context_set","created_at":3,"payload":{"purpose":"Plan"}},{"event_id":"r","seq":4,"kind":"message.member","created_at":4,"payload":{"text":"On it","thread_id":"t","member_id":"ranch"}}],"cursor":4,"has_more":false}"#.utf8))
    // Messages keep the thread of the message before them; hand-offs sit between; other events stay out.
    let rows = GroupConversationView.transcript(page.events)
    XCTAssertEqual(rows.map(\.id), ["m", "a", "r"])
    XCTAssertEqual(rows.map(\.previousThread), [nil, nil, "t"])
  }

  func testRoomStateWithUnreadableLiveDetailStillOpensTheRoom() throws {
    let state = try JSONDecoder().decode(GroupState.self, from: Data(#"{"room":{"room_id":"r","name":"Gate","members":[]},"driver_status":{"working":true,"blocked":false,"pending_actions":[],"member_activity":"soon","max_rounds":"3"},"context":{"purpose":1}}"#.utf8))
    XCTAssertNil(state.driver_status?.member_activity); XCTAssertNil(state.driver_status?.max_rounds); XCTAssertNil(state.context)
    XCTAssertEqual(GroupActivity.status(state.driver_status, context: state.context, members: []), "Assistants are discussing…")
  }

  func testSettingsSendNullForNoLeadAndCountNotesInBytes() throws {
    let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(GroupContextSave(requestId: "r", purpose: "Plan", notes: "Gate", leadMemberId: nil))) as? [String: Any]
    XCTAssertEqual(body?.keys.sorted(), ["leadMemberId", "notes", "purpose", "requestId"]); XCTAssertTrue(body?["leadMemberId"] is NSNull)
    XCTAssertEqual(GroupSettingsView.notesOver(String(repeating: "€", count: 1400)), 104)
    XCTAssertEqual(GroupSettingsView.notesOver(String(repeating: "a", count: 4096) + "\n\n"), 0)
    // A lead who left the room is no lead.
    XCTAssertEqual(GroupSettingsView.initialLead(GroupContext(purpose: "", notes: "", routing: "lead", lead_member_id: "gone"), members: members), "")
    XCTAssertEqual(GroupSettingsView.initialLead(GroupContext(purpose: "", notes: "", routing: "lead", lead_member_id: "ranch"), members: members), "ranch")
  }

  func testRoutinesPostOnlyInRoomsTheEditorCanShowAndNeverGuess() {
    let room = { (id: String, profiles: [String]) in GroupRoom(room_id: id, name: id.capitalized, members: profiles.map { GroupMember(member_id: $0, profile: $0, handle: $0, display_name: nil) }) }
    let catalog = GroupCatalog(supported: true, canSend: true, reason: nil, rooms: [room("open", ["ranch", "planner"]), room("mine", ["ranch", "diary"])], routineDelivery: true)
    var diary = Bot(id: "diary", name: "Diary", model: "m", shared: false, activity: .idle); diary.ownerId = "one"
    let ranch = Bot(id: "ranch", name: "Ranch", model: "m", shared: true, activity: .idle)
    XCTAssertEqual(GroupActivity.routineRoomChoices(catalog, bot: ranch, bots: [ranch, diary]).map(\.id), ["open", "mine"])
    XCTAssertEqual(GroupActivity.routineRoomChoices(catalog, bot: diary, bots: [ranch, diary]).map(\.id), ["mine"])
    let choices = catalog.rooms
    XCTAssertEqual(RoutineRooms.saved(["open", "gone"], catalog: catalog, choices: choices), ["open"])
    // Unknown rooms, or a Hermes that cannot post in rooms, send nothing, so the server keeps what it has.
    XCTAssertNil(RoutineRooms.saved(nil, catalog: catalog, choices: choices))
    var older = catalog; older.routineDelivery = nil
    XCTAssertNil(RoutineRooms.saved(["open"], catalog: older, choices: choices))
    XCTAssertEqual(RoutineRooms.names(["mine", "hidden"], catalog: catalog), "Mine")
    XCTAssertNil(RoutineRooms.names([], catalog: catalog))
  }
}
