import SwiftUI

/// A hardware keyboard shortcut, delivered to whichever screen owns it. Home opens pinned
/// assistants and Search; the open chat finds and stops. The number keeps repeats distinct.
struct KeyboardCommand: Equatable {
  enum Kind: Equatable { case pinned(Int), find, stop }
  var number: Int
  var kind: Kind
}
extension AppStore {
  func command(_ kind: KeyboardCommand.Kind) {
    commandCount += 1
    keyboardCommand = KeyboardCommand(number: commandCount, kind: kind)
  }
  /// Cmd+1 through Cmd+9, in the order pins appear on home.
  var pinnedForShortcuts: [Bot] { bootstrap.map { Array($0.preferences.pinnedAssistants($0.bots).prefix(9)) } ?? [] }
}

/// The menu iPadOS shows when Command is held, and the Mac menu bar. None of these keys is used by
/// the composer: its hardware Return sends and Shift-Return adds a line, and Command-Return is
/// left to the system.
struct AssistantCommands: Commands {
  @ObservedObject var store: AppStore
  var body: some Commands {
    CommandMenu("Assistants") {
      ForEach(Array(store.pinnedForShortcuts.enumerated()), id: \.element.id) { index, bot in
        Button(bot.name) { store.command(.pinned(index)) }
          .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
      }
      if !store.pinnedForShortcuts.isEmpty { Divider() }
      Button("Find") { store.command(.find) }.keyboardShortcut("f", modifiers: .command)
        .disabled(store.bootstrap == nil)
      Button("Stop active work") { store.command(.stop) }.keyboardShortcut(".", modifiers: .command)
        .disabled(store.bootstrap == nil)
    }
  }
}

/// Each of these is its own modifier, so the big screens' bodies stay quick to type-check.
extension View {
  /// Home plays the store's haptics and runs the shortcuts that belong to it.
  func homeSignals(haptic: HapticEvent?, command: KeyboardCommand?, run: @escaping (KeyboardCommand) -> Void) -> some View {
    storeHaptics(haptic).onChange(of: command) { _, command in if let command { run(command) } }
  }
  /// Cmd+F in the chat on screen.
  func findShortcut(botId: String, open: @escaping () -> Void) -> some View { modifier(FindShortcut(botId: botId, open: open)) }
  /// Cmd+. in the chat on screen.
  func stopShortcut(bot: Bot, canStop: Bool, stop: @escaping () -> Void) -> some View { modifier(StopShortcut(bot: bot, canStop: canStop, stop: stop)) }
}
private struct FindShortcut: ViewModifier {
  var botId: String
  var open: () -> Void
  @EnvironmentObject private var store: AppStore
  func body(content: Content) -> some View {
    content.onChange(of: store.keyboardCommand) { _, command in
      if command?.kind == .find, store.viewingBotId == botId { open() }
    }
  }
}
/// Cmd+. is one key from Cmd+, and the system's own cancel, so unlike the Stop button it asks first.
private struct StopShortcut: ViewModifier {
  var bot: Bot
  var canStop: Bool
  var stop: () -> Void
  @EnvironmentObject private var store: AppStore
  @State private var confirming = false
  func body(content: Content) -> some View {
    content
      .onChange(of: store.keyboardCommand) { _, command in
        if command?.kind == .stop, store.viewingBotId == bot.id, canStop { confirming = true }
      }
      .confirmationDialog("Stop \(bot.name)'s work?", isPresented: $confirming, titleVisibility: .visible) {
        Button("Stop work", role: .destructive, action: stop)
      }
  }
}
