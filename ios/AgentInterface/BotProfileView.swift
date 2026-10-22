import SwiftUI

/// What the assistant card hands back to the chat once it has closed.
enum BotProfileAction { case find, artifacts, settings }

/// The chat header's assistant card, like a contact card in Messages: a big live avatar and the
/// assistant's name, quick actions, then the choices that belong to this one assistant. Find,
/// artifacts and settings close the card and open over the chat, as the header's buttons did.
struct BotProfileView: View {
  var bot: Bot
  var state: ActivityState
  var choose: (BotProfileAction) -> Void
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @Environment(\.dynamicTypeSize) private var typeSize
  @State private var sectionFor: Bot?
  var body: some View {
    NavigationStack {
      List {
        Section { header; actions }.listRowBackground(Color.clear).listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 12, trailing: 0))
        Section {
          Toggle("Notify me about all activity", isOn: follow).disabled(!store.homeCanOrganize).accessibilityIdentifier("followBot")
          HomeSectionPicker(botId: bot.id) { sectionFor = bot }
        } footer: {
          Text("Shared tasks you're part of always notify you. Turn this on to hear about everything \(bot.name) does.")
        }
      }.householdListBackground().listSectionSpacing(.compact)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityIdentifier("closeBotProfile") } }
        .newSectionAlert(for: $sectionFor)
    }.presentationDragIndicator(.visible)
  }
  private var header: some View {
    VStack(spacing: 10) {
      AvatarView(avatar: bot.avatar ?? AvatarConfig(), state: state, size: 104, name: bot.name, botId: bot.id)
        .padding(.bottom, 4)
      Text(bot.name).font(.title2.bold()).multilineTextAlignment(.center).accessibilityAddTraits(.isHeader)
      VStack(spacing: 3) {
        Text(BotProfileView.audience(bot))
        Text(bot.provider.map { "\($0) · \(bot.model)" } ?? bot.model).lineLimit(2)
      }.font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
      if let description = bot.description?.trimmingCharacters(in: .whitespacesAndNewlines), !description.isEmpty {
        Text(description).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
          .lineLimit(4).padding(.top, 2)
      }
    }.frame(maxWidth: .infinity).padding(.top, 8).padding(.horizontal, 16).padding(.bottom, 18)
  }
  /// Four equal tiles in a row; at the largest text sizes, two rows of two.
  private var actions: some View {
    let columns = Array(repeating: GridItem(.flexible(), spacing: 10), count: typeSize.isAccessibilitySize ? 2 : 4)
    let pinned = store.homePreferences?.favorites.contains(bot.id) == true
    let files = store.conversationFileCount
    return LazyVGrid(columns: columns, spacing: 10) {
      ProfileActionTile(title: "Find", symbol: "magnifyingglass") { choose(.find) }
        .accessibilityIdentifier("profileFind")
      ProfileActionTile(title: pinned ? "Unpin" : "Pin", symbol: pinned ? "pin.slash" : "pin") {
        Task { await store.togglePin(bot.id) }
      }.disabled(!store.homeCanOrganize).accessibilityIdentifier("profilePin")
      ProfileActionTile(title: "Artifacts", symbol: "doc", badge: files) { choose(.artifacts) }
        .accessibilityValue(files == 0 ? "" : files == 1 ? "1 file" : "\(files) files").accessibilityIdentifier("conversationFiles")
      ProfileActionTile(title: "Settings", symbol: "gearshape") { choose(.settings) }
        .accessibilityIdentifier("profileSettings")
    }.padding(.horizontal, 2)
  }
  private var follow: Binding<Bool> {
    Binding(get: { store.homeFollows(bot.id) }, set: { store.homeFollow(bot.id, $0) })
  }
  /// Who the assistant works for, in the words the chat header used to show.
  static func audience(_ bot: Bot) -> String {
    bot.shared ? "Shared with your household" : bot.ownerId == nil ? "Personal, visible to the household" : "Your personal assistant"
  }
}

/// A quick action on the assistant card: an icon over a short label on a raised tile.
private struct ProfileActionTile: View {
  var title: String
  var symbol: String
  var badge = 0
  var action: () -> Void
  @Environment(\.colorScheme) private var scheme
  @Environment(\.isEnabled) private var enabled
  var body: some View {
    Button(action: action) {
      VStack(spacing: 6) {
        Image(systemName: symbol).font(.title3).frame(height: 26)
          .overlay(alignment: .topTrailing) {
            if badge > 0 {
              Text("\(badge)").font(.caption2.weight(.semibold)).monospacedDigit().foregroundStyle(.white)
                .padding(.horizontal, 5).frame(minWidth: 18, minHeight: 18).background(Palette.accent, in: Capsule())
                .offset(x: 12, y: -6).accessibilityHidden(true)
            }
          }
        Text(title).font(.caption.weight(.medium)).lineLimit(1).minimumScaleFactor(0.8)
      }.frame(maxWidth: .infinity, minHeight: 64).padding(.vertical, 4)
        .foregroundStyle(enabled ? Palette.accent : Palette.muted)
        .background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 14))
        .contentShape(RoundedRectangle(cornerRadius: 14))
    }.buttonStyle(.plain)
  }
}
