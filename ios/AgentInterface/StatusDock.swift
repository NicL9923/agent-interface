import SwiftUI

/// What the status dock above the composer can show. One stack, most urgent first, instead of
/// notices scattered between the header, the transcript and the composer.
enum DockItem: Hashable, Comparable {
  /// Hermes, the app or this device is unreachable, so nothing can be sent.
  case connection
  /// A send ended without a receipt: check, retry the same request or discard it.
  case uncertainSend
  /// Hermes refused the last message; it is back in the draft.
  case rejected(String)
  /// The last submission was interrupted.
  case interruptedSubmission
  /// The task was interrupted and must be reviewed before anything else is sent.
  case interruptionReview
  /// Questions, secure requests and approvals waiting in the open chat.
  case decisions(Int)
  /// Text from a notification, Siri or the Share sheet waits for the send to settle.
  case heldText

  /// Lower sorts first. Being offline makes every other action moot, and a message that may
  /// not have arrived blocks the next one, so those lead.
  var priority: Int {
    switch self {
    case .connection: 0
    case .uncertainSend: 1
    case .rejected: 2
    case .interruptedSubmission: 3
    case .interruptionReview: 4
    case .decisions: 5
    case .heldText: 6
    }
  }
  static func < (lhs: DockItem, rhs: DockItem) -> Bool { lhs.priority < rhs.priority }

  /// The dock's items for the open chat's state, sorted.
  static func items(connectionLost: Bool, uncertain: Bool, receiptStatus: String?, receiptMessage: String?,
    interrupted: Bool, decisions: Int, holdsText: Bool) -> [DockItem] {
    var items: [DockItem] = []
    if connectionLost { items.append(.connection) }
    if uncertain { items.append(.uncertainSend) }
    if receiptStatus == "rejected" {
      items.append(.rejected(receiptMessage?.isEmpty == false ? receiptMessage! : "Hermes did not accept this message. Your draft is saved."))
    }
    if receiptStatus == "interrupted" { items.append(.interruptedSubmission) }
    if interrupted { items.append(.interruptionReview) }
    if decisions > 0 { items.append(.decisions(decisions)) }
    if holdsText { items.append(.heldText) }
    return items.sorted()
  }
  static func decisionsLabel(_ count: Int) -> String { count == 1 ? "1 decision waiting" : "\(count) decisions waiting" }
}

/// The dock above the message box. Its own view, so the open conversation's changes render it and
/// not the text the person is typing.
struct StatusDock: View {
  var botId: String
  @Binding var discardConfirm: Bool
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var scheme
  @Environment(\.dynamicTypeSize) private var typeSize
  @State private var checkingConnection = false
  private let reachability = NetworkReachability.shared

  /// The chat's connection card, as it showed above the transcript: not for a chat still showing
  /// its saved copy while home is live, which says so itself.
  private var connectionLost: Bool {
    !(store.offlineSavedAt != nil && store.householdConnected && !reachability.offline)
      && store.connectionLost(offline: reachability.offline) && store.bootstrap != nil
  }
  private var decisions: Int {
    (store.conversation?.attention?.count ?? 0) + (store.conversation?.approvals.filter { $0.status == "pending" }.count ?? 0)
  }
  var body: some View {
    let items = DockItem.items(connectionLost: connectionLost, uncertain: store.pending != nil && !store.sending,
      receiptStatus: store.receipt?.status, receiptMessage: store.receipt?.message,
      interrupted: store.activity == .interrupted, decisions: decisions, holdsText: store.holdsText(for: botId))
    if !items.isEmpty {
      VStack(alignment: .leading, spacing: 8) {
        ForEach(items, id: \.self) { item in row(item) }
      }.accessibilityElement(children: .contain).accessibilityIdentifier("statusDock")
    }
  }
  @ViewBuilder private func row(_ item: DockItem) -> some View {
    switch item {
    case .connection: connectionCard
    case .uncertainSend:
      // A normal send only spins the send button. This appears once the request ended without a receipt.
      VStack(alignment: .leading, spacing: 8) {
        Text("Checking whether your last message arrived…").font(.footnote)
        Button("Retry this saved message") { Task { await store.send(reviewedUncertain: true) } }
          .font(.footnote).disabled(store.sending || !store.supports(.idempotency) || !store.connected)
        // A send that never resolves would otherwise block this assistant on this device.
        Button("Discard and keep my text in the draft", role: .destructive) {
          discardConfirm = true
        }.font(.caption).accessibilityIdentifier("discardUnconfirmedSend")
      }.modifier(DockCard())
    case .rejected(let message):
      Text(message).font(.footnote).foregroundStyle(Palette.attention).frame(maxWidth: .infinity, alignment: .leading)
    case .interruptedSubmission:
      Text("This submission was interrupted. Review its last actions before trying again.")
        .font(.footnote).foregroundStyle(Palette.attention).frame(maxWidth: .infinity, alignment: .leading)
    case .interruptionReview:
      Toggle("I reviewed the interrupted task and its last actions before continuing.", isOn: Bindable(store).interruptionReviewed)
        .toggleStyle(CheckboxStyle()).font(.footnote)
    case .decisions(let count):
      let layout = typeSize.isAccessibilitySize
        ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(spacing: 10))
      layout {
        HStack(spacing: 10) {
          Image(systemName: "exclamationmark.bubble").foregroundStyle(Palette.attention).accessibilityHidden(true)
          Text(DockItem.decisionsLabel(count)).font(.footnote.weight(.medium))
            .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
        }
        Button("Review") { store.attentionScrollRequest = UUID() }.font(.footnote.weight(.semibold))
          .buttonStyle(.bordered).controlSize(.small).accessibilityIdentifier("reviewDecisions")
          .accessibilityHint("Scrolls to the first one in the conversation")
      }.modifier(DockCard())
    case .heldText:
      Text("Text from a notification, Siri or the Share sheet joins this draft once your last message settles.")
        .font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
    }
  }
  /// The compact connection card the web shows while Hermes is unreachable.
  private var connectionCard: some View {
    let connection = store.bootstrap?.connection
    let copy = ConnectionCopy.compact(code: connection?.code, appUnavailable: store.appUnavailable, offline: reachability.offline)
    return VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        Image(systemName: reachability.offline ? "wifi.slash" : "arrow.triangle.2.circlepath").foregroundStyle(Palette.attention)
          .accessibilityHidden(true)
        Text(copy.title).font(.subheadline.bold())
      }
      Text(copy.detail).font(.caption).foregroundStyle(.secondary)
      Button(checkingConnection ? "Checking connection…" : copy.setup ? "Check connection" : "Reconnect now") {
        checkingConnection = true
        Task { await store.reconnect(); checkingConnection = false }
      }.font(.caption).buttonStyle(.bordered).disabled(checkingConnection || reachability.offline).padding(.vertical, 2)
      DisclosureGroup(copy.setup ? "Set up this installation" : "Connection details") {
        VStack(alignment: .leading, spacing: 8) {
          if let address = connection?.address { Text("Hermes address: \(address)").textSelection(.enabled) }
          if let detail = connection?.detail, !detail.isEmpty { Text(detail) }
          if let last = connection?.lastConnectedAt, !When.format(last).isEmpty { Text("Last connected \(When.format(last, inline: true)).") }
          if copy.setup {
            Text("On the computer running WildBots, open its project folder and run `npm run setup`. Setup keeps the connection token on that computer. Restart this app after saving; everyone else can simply sign in.")
          }
          Text("For a read-only connection check on that computer, run `npm run doctor`.")
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 4)
      }.font(.caption).foregroundStyle(.secondary)
    }.modifier(DockCard())
      .accessibilityElement(children: .contain).accessibilityIdentifier("connectionCard")
  }
}

private struct DockCard: ViewModifier {
  @Environment(\.colorScheme) private var scheme
  func body(content: Content) -> some View {
    content.padding(10).frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.line, lineWidth: 1))
  }
}
