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
  /// The list's content height, once measured, so the sheet can fit it.
  @State private var contentHeight: CGFloat?
  private let clock = MinuteClock.shared
  var body: some View {
    NavigationStack {
      List {
        Section { header; actions }.listRowBackground(Color.clear).listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 12, trailing: 0))
        Section { details }
        Section {
          Toggle("Notify me about all activity", isOn: follow).disabled(!store.homeCanOrganize).accessibilityIdentifier("followBot")
          HomeSectionPicker(botId: bot.id) { sectionFor = bot }
        } footer: {
          Text("Shared tasks you're part of always notify you. Turn this on to hear about everything \(bot.name) does.").foregroundStyle(Palette.muted)
        }
      }.householdListBackground().listSectionSpacing(.compact).accessibilityIdentifier("botProfileList")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityIdentifier("closeBotProfile") } }
        .newSectionAlert(for: $sectionFor)
        .measuringContent($contentHeight)
    }.presentationDragIndicator(.visible)
      .modifier(FittedDetents(contentHeight: contentHeight))
  }
  private var header: some View {
    VStack(spacing: 8) {
      AvatarView(avatar: bot.avatar ?? AvatarConfig(), state: state, size: 88, name: bot.name, botId: bot.id)
      Text(bot.name).font(.title2.bold()).multilineTextAlignment(.center).accessibilityAddTraits(.isHeader)
      Text(Self.roleLine(bot)).font(.subheadline).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("profileRole")
    }.frame(maxWidth: .infinity).padding(.top, 4).padding(.horizontal, 16).padding(.bottom, 14)
  }
  /// Who it works for, the model it runs on and when it last spoke, as rows that read at a glance.
  @ViewBuilder private var details: some View {
    LabeledContent("Model") {
      Text(bot.provider.map { "\($0) · \(bot.model)" } ?? bot.model).foregroundStyle(Palette.muted).lineLimit(typeSize.isAccessibilitySize ? nil : 2).multilineTextAlignment(.trailing)
    }.accessibilityIdentifier("profileModel")
    LabeledContent("Last activity") {
      if state != .idle && state != .done { ActivityLabel(state: state) }
      else { Text(Self.lastActivity(bot, now: clock.now)).foregroundStyle(Palette.muted) }
    }.accessibilityIdentifier("profileLastActivity")
    LabeledContent("Who sees it") { Text(Self.audience(bot)).foregroundStyle(Palette.muted) }
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
  /// The assistant's role in one line: its description, or what it is when it has none.
  static func roleLine(_ bot: Bot) -> String {
    let role = bot.description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return role.isEmpty ? (bot.shared ? "Shared assistant" : "Personal assistant") : role
  }
  /// When the conversation last moved, from the roster's latest message.
  static func lastActivity(_ bot: Bot, now: Date) -> String {
    guard let at = bot.lastMessage?.at, let date = ServerDate.parse(at) else { return "No messages yet" }
    return When.format(date, now: now)
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
  @ScaledMetric(relativeTo: .title3) private var glyphHeight: CGFloat = 26
  var body: some View {
    Button(action: action) {
      VStack(spacing: 6) {
        Image(systemName: symbol).font(.title3).frame(height: glyphHeight)
          .overlay(alignment: .topTrailing) {
            if badge > 0 {
              Text("\(badge)").font(.caption2.weight(.semibold)).monospacedDigit().foregroundStyle(Palette.onAccent)
                .padding(.horizontal, 5).frame(minWidth: 18, minHeight: 18).background(Palette.accent, in: Capsule())
                .offset(x: 12, y: -6).accessibilityHidden(true)
            }
          }
        Text(title).font(.subheadline.weight(.medium)).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
      }.frame(maxWidth: .infinity, minHeight: 64).padding(.vertical, 4)
        .foregroundStyle(enabled ? Palette.accent : Palette.muted)
        .background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 14))
        .contentShape(RoundedRectangle(cornerRadius: 14))
    }.buttonStyle(.plain)
  }
}

/// Sheet heights for the card: the medium detent when the content fits in it, otherwise the
/// content's own height while that leaves the top of the screen free, and full height beyond.
enum FittedSheet {
  /// The navigation bar, grabber and bottom inset around the measured list content.
  static let chrome: CGFloat = 76
  static func detents(contentHeight: CGFloat?, available: CGFloat) -> Set<PresentationDetent> {
    guard let contentHeight, available > 0 else { return [.medium, .large] }
    let needed = contentHeight + chrome
    if needed <= available * 0.5 { return [.medium, .large] }
    if needed <= available * 0.9 { return [.height(needed.rounded(.up)), .large] }
    return [.large]
  }
}
private struct FittedDetents: ViewModifier {
  var contentHeight: CGFloat?
  @State private var selection: PresentationDetent = .medium
  /// The window's height. The sheet's own size follows the detent, so it cannot be the measure.
  private var available: CGFloat {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
      .first { $0.isKeyWindow }?.bounds.height ?? 0
  }
  func body(content: Content) -> some View {
    let detents = FittedSheet.detents(contentHeight: contentHeight, available: available)
    content
      .presentationDetents(detents, selection: $selection)
      // The smallest detent that holds the content, until the person drags it.
      .onChange(of: detents, initial: true) { _, detents in
        if let fitted = detents.first(where: { $0 != .large }) { selection = fitted } else { selection = .large }
      }
  }
}
private extension View {
  /// The list's content height, on iOS 18 and later. iOS 17 keeps the medium and large detents.
  @ViewBuilder func measuringContent(_ height: Binding<CGFloat?>) -> some View {
    if #available(iOS 18, *) {
      onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { _, value in
        if value > 0 { height.wrappedValue = value }
      }
    } else { self }
  }
}
