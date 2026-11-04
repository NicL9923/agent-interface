import Foundation

/// A room's purpose and shared notes, which every member reads from the next message on, and who answers a
/// message that names no one: every member (`everyone`) or the lead, who passes it on (`lead`).
struct GroupContext: Codable, Equatable {
  var purpose: String; var notes: String; var routing: String; var lead_member_id: String
}
/// One assistant's live work in a room, from Hermes `groups.state`. `status` is queued, running or stopping;
/// `round_index` is 0-based; `tool` is the tool it is in now.
struct GroupMemberActivity: Decodable, Equatable {
  var member_id: String; var status: String; var thread_id: String?; var round_index: Int?; var started_at: Double?; var tool: String?
}
/// A room settings save. `leadMemberId` is always sent, as null for no lead, because the server requires it.
struct GroupContextSave: Encodable {
  var requestId: String; var purpose: String; var notes: String; var leadMemberId: String?
  private enum CodingKeys: String, CodingKey { case requestId, purpose, notes, leadMemberId }
  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(requestId, forKey: .requestId); try c.encode(purpose, forKey: .purpose)
    try c.encode(notes, forKey: .notes); try c.encode(leadMemberId, forKey: .leadMemberId)
  }
}
struct GroupContextSaved: Decodable { var context: GroupContext }

/// What a group chat says about its assistants' live work, its lead and the lead's hand-offs.
/// Ported from src/shared/group-activity.ts; keep the two in step.
enum GroupActivity {
  struct Line: Equatable, Identifiable {
    var memberId: String
    /// The working line, such as "Ada is using web_search...".
    var sentence: String
    /// Advanced presentation only: "Round 2 of 3".
    var round: String?
    var id: String { memberId }
  }
  /// Hermes's limits for room settings (gateway/hosted_room_context.py). Notes count UTF-8 bytes once trimmed.
  static let purposeLimit = 500
  static let notesByteLimit = 4096
  static func notesBytes(_ notes: String) -> Int { notes.trimmingCharacters(in: .whitespacesAndNewlines).utf8.count }

  static func memberName(_ members: [GroupMember], _ id: String?) -> String {
    let member = members.first { $0.member_id == id }
    if let name = member?.display_name, !name.isEmpty { return name }
    return member?.profile ?? ((id?.isEmpty == false) ? id! : "Assistant")
  }
  /// Names joined as a sentence says them: "Ada", "Ada and Ben", "Ada, Ben and Cy".
  static func nameList(_ names: [String]) -> String {
    guard names.count > 1 else { return names.joined() }
    return names.dropLast().joined(separator: ", ") + " and " + names.last!
  }
  /// One line for each assistant with live work, in the order Hermes admitted it. Simple says who is working;
  /// Advanced adds the tool each one is in and its round.
  static func lines(_ driver: GroupDriver?, members: [GroupMember], advanced: Bool) -> [Line] {
    let all = driver?.member_activity ?? []
    var seen = Set<String>()
    return all.compactMap { activity in
      // One assistant can hold a queued turn behind its running one; the running one says what it is doing.
      guard seen.insert(activity.member_id).inserted else { return nil }
      let rows = all.filter { $0.member_id == activity.member_id }
      let current = rows.first { $0.status == "running" } ?? rows.first { $0.status == "stopping" } ?? activity
      let name = memberName(members, activity.member_id)
      let tool = current.tool?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      let sentence: String
      switch current.status {
      case "queued": sentence = "\(name) is waiting to start..."
      case "stopping": sentence = "\(name) is stopping..."
      default: sentence = ActivitySentence.text(name: name, state: .working, detail: advanced && current.status == "running" && !tool.isEmpty ? "Using \(tool)" : nil, connectionLost: false)
      }
      var round: String?
      if advanced, let index = current.round_index, index >= 0 {
        if let max = driver?.max_rounds, max > 0 { round = "Round \(index + 1) of \(max)" } else { round = "Round \(index + 1)" }
      }
      return Line(memberId: activity.member_id, sentence: sentence, round: round)
    }
  }
  /// The lead assistant's name, when the room sends unaddressed messages to its lead first.
  static func leadName(_ context: GroupContext?, members: [GroupMember]) -> String? {
    guard let context, context.routing == "lead", !context.lead_member_id.isEmpty else { return nil }
    return memberName(members, context.lead_member_id)
  }
  /// The hint under the composer. Live work has its own lines, so this only says how to address the room.
  static func status(_ driver: GroupDriver?, context: GroupContext?, members: [GroupMember]) -> String {
    if driver?.blocked == true { return "Discussion needs attention." }
    // Hermes versions without per-member activity only say that the room is working.
    if driver?.working == true && (driver?.member_activity ?? []).isEmpty { return "Assistants are discussing…" }
    if let lead = leadName(context, members: members) { return "Type @ to address one assistant. Otherwise \(lead) picks who answers." }
    return "Type @ to address one assistant."
  }
  /// The lead's hand-off of a message nobody was named in (`room.assignment`), or nil for another event.
  static func assignment(_ event: GroupEvent, members: [GroupMember]) -> String? {
    guard event.kind == "room.assignment", let lead = event.payload.lead_member_id, let chosen = event.payload.member_ids, !chosen.isEmpty else { return nil }
    let name = memberName(members, lead)
    let others = nameList(chosen.filter { $0 != lead }.map { memberName(members, $0) })
    if others.isEmpty { return "\(name) took this one." }
    return chosen.contains(lead) ? "\(name) is answering this with \(others)." : "\(name) gave this to \(others)."
  }
  /// The group chats an assistant's routine may post in: any room this person can open, or, for a personal
  /// assistant, only rooms with one of its owner's personal assistants, which nobody else can open.
  static func routineRoomChoices(_ catalog: GroupCatalog?, bot: Bot?, bots: [Bot]) -> [GroupRoom] {
    guard let catalog, catalog.supported, catalog.routineDelivery == true else { return [] }
    guard let bot, !bot.shared, let owner = bot.ownerId else { return catalog.rooms }
    return catalog.rooms.filter { room in
      room.members.contains { member in bots.contains { $0.id == member.profile && !$0.shared && $0.ownerId == owner } }
    }
  }
}
