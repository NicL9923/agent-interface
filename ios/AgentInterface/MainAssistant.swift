import SwiftUI

/// The member's main assistant and its check-ins, mirroring src/shared/main-assistant.ts. Only a
/// member's own personal assistant can be one, so its check-ins stay private to them.
struct CheckInSettings: Codable, Equatable {
  var enabled: Bool
  /// Whole hours between check-ins, 1 to 4.
  var everyHours: Int
  /// The IANA timezone the main assistant reads as night, when it stays silent.
  var timezone: String
}

enum MainAssistant {
  static let hours = 1...4
  static let defaultHours = 2
  static func eligible(_ bot: Bot, userId: String) -> Bool { !bot.shared && bot.ownerId == userId }
  /// Why an assistant can't be this member's main one, or nil when it can.
  static func ineligibleReason(_ bot: Bot, userId: String) -> String? {
    if eligible(bot, userId: userId) { return nil }
    if bot.shared { return "Shared with the household. Check-ins stay private only on your own personal assistant." }
    return "Visible to the whole household because it has no recorded owner."
  }
  static func frequencyLabel(_ hours: Int) -> String { hours == 1 ? "Every hour" : "Every \(hours) hours" }
  /// Minutes between runs from Hermes's display, "every 120m", or nil for any other schedule.
  static func scheduleMinutes(_ schedule: String) -> Int? {
    let pattern = /^(?:every\s+)?(\d+)\s*(m|min|minutes?|h|hr|hours?)$/.ignoresCase()
    guard let match = schedule.trimmingCharacters(in: .whitespaces).wholeMatch(of: pattern), let count = Int(match.1) else { return nil }
    return count * (match.2.lowercased().hasPrefix("h") ? 60 : 1)
  }
  /// The assistant a handoff names, for "Open <name>'s chat": its target, or the sender of one this
  /// chat received. Only assistants on this person's home resolve; never a fan-out or the open chat.
  static func exchangePartner(target: String?, incomingName: String?, bots: [Bot], currentBotId: String) -> Bot? {
    guard let name = incomingName ?? target else { return nil }
    var wanted = name.trimmingCharacters(in: .whitespaces).lowercased()
    if wanted.hasPrefix("@") { wanted.removeFirst() }
    guard !wanted.isEmpty else { return nil }
    let bot = bots.first { $0.id.lowercased() == wanted } ?? bots.first { $0.name.trimmingCharacters(in: .whitespaces).lowercased() == wanted }
    return bot?.id == currentBotId ? nil : bot
  }
}

extension Preferences {
  /// The main assistant, when it is still on this person's home.
  func mainAssistant(_ bots: [Bot]) -> Bot? { mainBotId.flatMap { id in bots.first { $0.id == id } } }
}

/// Clearing is an explicit null, never a missing field, so the server can tell it from an older client.
struct MainChoice: Encodable {
  var botId: String?
  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(botId, forKey: .botId)
  }
  enum CodingKeys: String, CodingKey { case botId }
}

extension AppStore {
  var mainAssistant: Bot? { bootstrap.flatMap { $0.preferences.mainAssistant($0.bots) } }
  /// Makes an assistant the main one, or clears it with nil. Throws the server's reason it couldn't.
  func setMainAssistant(_ botId: String?) async throws {
    guard let api else { return }
    let currentGeneration = generation
    let saved: Preferences = try await api.write("/preferences/main", MainChoice(botId: botId), method: "PUT")
    if currentGeneration == generation { bootstrap?.preferences = saved }
  }
  /// Turns check-ins on or off, or changes how often, keeping the other setting.
  func setCheckIns(enabled: Bool? = nil, everyHours: Int? = nil) async throws {
    guard let api else { return }
    let current = bootstrap?.preferences.checkIns
    let body = CheckInSettings(enabled: enabled ?? current?.enabled ?? false, everyHours: everyHours ?? current?.everyHours ?? MainAssistant.defaultHours,
      timezone: TimeZone.current.identifier)
    let currentGeneration = generation
    let saved: Preferences = try await api.write("/preferences/check-ins", body, method: "PUT")
    if currentGeneration == generation { bootstrap?.preferences = saved }
  }
  func dismissMainSuggestion() {
    guard var preferences = homePreferences else { return }
    preferences.mainSuggestionDismissed = true
    queuePreferences(preferences)
  }
}

/// Home's suggestion to choose a main assistant, until it is dismissed.
struct MainSuggestionCard: View {
  var choose: () -> Void
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      (Text("Choose a main assistant: ").bold() + Text("it checks in on what's coming up and hands work to your other assistants."))
        .font(.subheadline).fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 10) {
        Button("Choose", action: choose).buttonStyle(.borderedProminent).tint(Palette.accent).accessibilityIdentifier("chooseMain")
        Button("Not now") { store.dismissMainSuggestion() }.buttonStyle(.bordered).accessibilityIdentifier("dismissMainSuggestion")
      }
    }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.accentSoft.opacity(0.45), in: RoundedRectangle(cornerRadius: 16))
      .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Palette.accent.opacity(0.35), style: StrokeStyle(lineWidth: 1, dash: [5, 4])))
      .accessibilityElement(children: .contain).accessibilityIdentifier("mainSuggestion")
  }
}

/// Choosing a main assistant: the member's own personal ones, and why each other one can't be.
struct MainAssistantPicker: View {
  var makePersonal: (Bot) -> Void
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var busy: String?
  @State private var failure: String?
  var body: some View {
    let bots = store.bootstrap?.bots ?? []
    let userId = store.bootstrap?.user.id ?? ""
    let own = bots.filter { MainAssistant.eligible($0, userId: userId) }
    let others = bots.filter { !MainAssistant.eligible($0, userId: userId) }
    NavigationStack {
      List {
        Section {
          if own.isEmpty { Text("You don't have a personal assistant yet. Make one of these personal, or create a new personal assistant.") }
          ForEach(own) { bot in
            row(bot, note: bot.description ?? "Your personal assistant") {
              Button(busy == bot.id ? "Saving…" : "Make main") { choose(bot) }.buttonStyle(.borderedProminent).tint(Palette.accent)
                .disabled(busy != nil).accessibilityIdentifier("makeMain.\(bot.id)")
            }
          }
        } header: { Text("Your personal assistants") } footer: {
          Text("Your main assistant leads your home, checks in on what's coming up if you turn that on, and hands work to your other assistants. It must be one of your own personal assistants, so its check-ins stay private to you.")
        }
        if !others.isEmpty {
          Section("Other assistants") {
            ForEach(others) { bot in
              row(bot, note: MainAssistant.ineligibleReason(bot, userId: userId) ?? "") {
                Button("Make it personal") { dismiss(); makePersonal(bot) }.buttonStyle(.bordered).accessibilityIdentifier("makePersonal.\(bot.id)")
              }
            }
          }
        }
        if let failure { Section { Text(failure).foregroundStyle(Palette.danger) } }
      }.householdListBackground().navigationTitle("Choose a main assistant").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
    }.accessibilityIdentifier("mainPicker")
  }
  private func row(_ bot: Bot, note: String, @ViewBuilder action: () -> some View) -> some View {
    HStack(spacing: 12) {
      AvatarView(avatar: bot.avatar ?? AvatarConfig(), state: .idle, size: 40, name: bot.name, forceReducedMotion: true).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(bot.name).font(.body.weight(.semibold))
        Text(note).font(.footnote).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
      }.frame(maxWidth: .infinity, alignment: .leading)
      action()
    }
  }
  private func choose(_ bot: Bot) {
    busy = bot.id; failure = nil
    Task {
      defer { busy = nil }
      do { try await store.setMainAssistant(bot.id); dismiss() } catch { failure = error.localizedDescription }
    }
  }
}

/// In an assistant's details: Make main, and on the main assistant, "Check in with me" and how often.
struct MainAssistantSection: View {
  var bot: Bot
  @Environment(AppStore.self) private var store
  @State private var busy = false
  @State private var failure: String?
  var body: some View {
    let preferences = store.bootstrap?.preferences
    let isMain = preferences?.mainBotId == bot.id
    let checkIns = preferences?.checkIns
    let on = isMain && checkIns?.enabled == true
    let canCheckIn = isMain && store.bootstrap?[capability: .routines]?.supported == true
    Section {
      Button { run { try await store.setMainAssistant(isMain ? nil : bot.id) } } label: {
        Label(isMain ? "Main assistant" : "Make main assistant", systemImage: isMain ? "star.fill" : "star")
      }.disabled(busy || !store.homeCanOrganize).accessibilityValue(isMain ? "On" : "Off")
        .accessibilityHint(isMain ? "Tap to stop it being your main assistant" : "").accessibilityIdentifier("profileMain")
      if canCheckIn {
        Toggle("Check in with me", isOn: Binding(get: { on }, set: { value in run { try await store.setCheckIns(enabled: value) } }))
          .disabled(busy || !store.homeCanOrganize).accessibilityIdentifier("checkIns")
        if on {
          Picker("How often", selection: Binding(get: { checkIns?.everyHours ?? MainAssistant.defaultHours },
            set: { hours in run { try await store.setCheckIns(enabled: true, everyHours: hours) } })) {
            ForEach(Array(MainAssistant.hours), id: \.self) { Text(MainAssistant.frequencyLabel($0)).tag($0) }
          }.disabled(busy || !store.homeCanOrganize).accessibilityIdentifier("checkInFrequency")
        }
      }
    } footer: {
      if let failure { Text(failure).foregroundStyle(Palette.danger) }
      else if canCheckIn { Text("\(bot.name) looks over your calendar, email and tasks and messages you only when something needs you. Quiet overnight.").foregroundStyle(Palette.muted) }
    }
  }
  private func run(_ work: @escaping () async throws -> Void) {
    busy = true; failure = nil
    Task { defer { busy = false }; do { try await work() } catch { failure = error.localizedDescription } }
  }
}
