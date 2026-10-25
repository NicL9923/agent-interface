import SwiftUI

/// `@handle` mentions in a group chat message. A mention being typed is the word at the end of the
/// draft that starts with `@`; choosing a suggestion completes it as `@handle `.
enum GroupMentions {
  /// The handle characters Hermes accepts after `@`.
  private static func handleCharacter(_ character: Character) -> Bool {
    character.isLetter || character.isNumber || character == "_" || character == "-" || character == "."
  }
  /// The partial handle after an `@` that ends the text and starts a word, or nil.
  static func query(in text: String) -> String? {
    guard let at = text.lastIndex(of: "@") else { return nil }
    let partial = text[text.index(after: at)...]
    guard partial.allSatisfy(handleCharacter) else { return nil }
    // An email address or a handle glued to a word is not a mention.
    if at > text.startIndex, !text[text.index(before: at)].isWhitespace { return nil }
    return String(partial)
  }
  /// Members whose handle or name starts with the partial handle, handle matches first. Members
  /// already mentioned with the same complete handle are not offered again.
  static func suggestions(for query: String, members: [GroupMember]) -> [GroupMember] {
    let needle = query.lowercased()
    let byHandle = members.filter { $0.handle.lowercased().hasPrefix(needle) && $0.handle.lowercased() != needle }
    let byName = members.filter { member in
      !byHandle.contains(member) && member.handle.lowercased() != needle
        && (member.display_name ?? member.profile).lowercased().split(separator: " ").contains { $0.hasPrefix(needle) }
    }
    return byHandle + byName
  }
  /// The text with the mention being typed completed for `member`, ready for the next word.
  static func insert(_ member: GroupMember, into text: String) -> String {
    guard query(in: text) != nil, let at = text.lastIndex(of: "@") else {
      let separator = text.isEmpty || text.last?.isWhitespace == true ? "" : " "
      return text + separator + "@" + member.handle + " "
    }
    return String(text[..<at]) + "@" + member.handle + " "
  }
}

/// Suggestions above the group composer while a mention is typed.
struct MentionSuggestions: View {
  var members: [GroupMember]
  var choose: (GroupMember) -> Void
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(members, id: \.member_id) { member in
          Button { choose(member) } label: {
            HStack(spacing: 4) {
              Text("@" + member.handle).fontWeight(.semibold)
              if let name = member.display_name, name.caseInsensitiveCompare(member.handle) != .orderedSame {
                Text(name).foregroundStyle(.secondary)
              }
            }.font(.footnote).padding(.horizontal, 12).frame(minHeight: 36)
              .background(Palette.raised(scheme), in: Capsule())
              .overlay(Capsule().stroke(Palette.line, lineWidth: 1))
          }.buttonStyle(.plain)
            .accessibilityLabel("Mention \(member.display_name ?? member.profile)").accessibilityIdentifier("mention.\(member.handle)")
        }
      }
    }.accessibilityElement(children: .contain).accessibilityLabel("Mention suggestions")
  }
}

/// A room change announced on the app event stream: `event: group` with the room and its latest
/// sequence number. While at least one stream asks for a room, the server polls Hermes for it.
struct GroupNotice: Decodable, Equatable {
  var roomId: String
  var latestSeq: Int
  /// Whether this notice means the open room has events past the loaded cursor.
  static func news(_ notice: GroupNotice?, room: String, cursor: Int) -> Bool {
    guard let notice else { return false }
    return notice.roomId == room && notice.latestSeq > cursor
  }
  /// Reads the notice from one event's name and data line.
  static func parse(event: String, data: String) -> GroupNotice? {
    guard event == "group" else { return nil }
    return try? JSONDecoder().decode(GroupNotice.self, from: Data(data.utf8))
  }
}

extension View {
  /// Follows the room's notices on the app event stream while the app is active. Each notice of
  /// new events calls `changed`. A slow poll elsewhere covers a stream that fails unnoticed.
  func watchingGroup(_ roomId: String, cursor: @escaping () -> Int, changed: @escaping () async -> Void) -> some View {
    modifier(GroupWatch(roomId: roomId, cursor: cursor, changed: changed))
  }
}
private struct GroupWatch: ViewModifier {
  var roomId: String
  var cursor: () -> Int
  var changed: () async -> Void
  @Environment(AppStore.self) private var store
  @Environment(\.scenePhase) private var scenePhase
  func body(content: Content) -> some View {
    content.task(id: "\(store.scope ?? "")|\(roomId)|\(scenePhase == .active)") {
      guard scenePhase == .active, let api = store.api else { return }
      var failures = 0
      while !Task.isCancelled {
        do {
          let lines = try await api.events("/api/events?group=\(APIClient.component(roomId))")
          failures = 0
          // Notices sent before the subscription are lost, so connecting counts as one.
          await changed()
          var event = ""
          for try await line in lines {
            guard !Task.isCancelled else { return }
            if line.hasPrefix("event:") { event = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces) }
            if line.hasPrefix("data:") {
              let data = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
              if GroupNotice.news(GroupNotice.parse(event: event, data: data), room: roomId, cursor: cursor()) { await changed() }
              event = ""
            }
          }
        } catch {}
        guard !Task.isCancelled else { return }
        failures += 1
        // Timer: a reconnect delay that grows with failures, as the conversation streams use.
        try? await Task.sleep(for: .seconds(min(30, 3 * failures)))
      }
    }
  }
}
