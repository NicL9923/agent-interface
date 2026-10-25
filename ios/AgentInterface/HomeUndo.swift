import SwiftUI

/// A home change that can be taken back for a few seconds: pinning, unpinning or moving an
/// assistant to another section from its row's swipe or long-press menu.
struct UndoToast: Identifiable, Equatable {
  enum Change: Equatable {
    case pin(botId: String, pinned: Bool)
    case move(botId: String, from: String?)
  }
  let id = UUID()
  var message: String
  var change: Change
  static let duration: Duration = .seconds(5)

  static func pin(_ bot: Bot, pinned: Bool) -> UndoToast {
    UndoToast(message: pinned ? "Pinned \(bot.name)" : "Unpinned \(bot.name)", change: .pin(botId: bot.id, pinned: pinned))
  }
  static func move(_ bot: Bot, from: String?, to section: String?) -> UndoToast {
    UndoToast(message: section.map { "Moved \(bot.name) to \($0)" } ?? "Removed \(bot.name) from its section",
      change: .move(botId: bot.id, from: from))
  }
  /// What VoiceOver hears when the toast appears, since it may not land on it.
  var announcement: String { message + ". Undo is available for 5 seconds." }
}

/// The toast on screen, if any. A new change replaces the last one, whose undo then lapses;
/// a timer only clears the toast it was started for.
struct UndoQueue: Equatable {
  private(set) var current: UndoToast?
  mutating func show(_ toast: UndoToast) { current = toast }
  /// The change to reverse, once. A second tap, or a tap after it lapsed, does nothing.
  mutating func undo(_ id: UUID) -> UndoToast.Change? {
    guard let current, current.id == id else { return nil }
    self.current = nil
    return current.change
  }
  mutating func expire(_ id: UUID) { if current?.id == id { current = nil } }
}

extension AppStore {
  /// Reverses a change from home's undo toast with the same save path the change took.
  func undo(_ change: UndoToast.Change) async {
    switch change {
    case .pin(let botId, let pinned):
      if homePreferences?.favorites.contains(botId) == pinned { await togglePin(botId) }
    case .move(let botId, let from):
      homeMove(botId, toSection: from)
    }
  }
  /// The name of an assistant's home section, for the toast.
  func homeSectionName(_ sectionId: String?) -> String? {
    sectionId.flatMap { id in homePreferences?.sections.first { $0.id == id } }.map { $0.name.isEmpty ? "Untitled section" : $0.name }
  }
}

/// Home's toast, at the bottom, with Undo. Five seconds, as on the web.
struct UndoToastView: View {
  var toast: UndoToast
  var undo: () -> Void
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    HStack(spacing: 12) {
      Text(toast.message).font(.subheadline).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
      Button("Undo", action: undo).font(.subheadline.weight(.semibold)).tint(Palette.accent)
        .accessibilityIdentifier("undoToastAction").accessibilityHint(toast.message)
    }.padding(.horizontal, 16).padding(.vertical, 12)
      .background(.regularMaterial, in: Capsule())
      .overlay(Capsule().stroke(Palette.line, lineWidth: 1))
      .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
      .padding(.horizontal, 16).padding(.bottom, 12).frame(maxWidth: 520)
      .accessibilityElement(children: .contain).accessibilityIdentifier("undoToast")
  }
}

extension View {
  /// Shows home's undo toast over the bottom edge and clears it after five seconds.
  func undoToast(_ queue: Binding<UndoQueue>, undo: @escaping (UndoToast.Change) -> Void) -> some View {
    modifier(UndoToastHost(queue: queue, undo: undo))
  }
}
private struct UndoToastHost: ViewModifier {
  @Binding var queue: UndoQueue
  var undo: (UndoToast.Change) -> Void
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  func body(content: Content) -> some View {
    content.overlay(alignment: .bottom) {
      if let toast = queue.current {
        UndoToastView(toast: toast) { if let change = queue.undo(toast.id) { undo(change) } }
          .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
          .task(id: toast.id) {
            AccessibilityNotification.Announcement(toast.announcement).post()
            try? await Task.sleep(for: UndoToast.duration)
            if !Task.isCancelled { queue.expire(toast.id) }
          }
      }
    }.animation(reduceMotion ? nil : .snappy(duration: 0.25), value: queue.current)
  }
}
