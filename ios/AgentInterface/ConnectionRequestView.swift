import SwiftUI

/// An assistant asking a person to set up one of its connections in the chat. `connectionId` is a
/// catalog ID from `GET /api/integrations`, such as `google_workspace`, `github` or `key:brave`.
/// The reason is the assistant's own words. Hermes settles the request when the person answers.
struct ConnectionRequest: Codable, Equatable {
  var epoch: String
  var sessionId: String
  var connectionId: String
  var reason: String
}
/// What a person chose: Continue sends `connected`, Not now sends `decline`.
struct ConnectionDecision: Codable, Equatable {
  var decision: String
  var epoch: String
  var sessionId: String
  /// The catalog ID the request named. The server refuses a body without it.
  var connection: String
  static let connected = "connected"
  static let decline = "decline"
  init(_ decision: String, for request: ConnectionRequest) {
    self.decision = decision; epoch = request.epoch; sessionId = request.sessionId; connection = request.connectionId
  }
}
struct ConnectionRequestResult: Decodable { var status: String }

/// Decides when a connection card tells the assistant it may continue without being asked.
/// A connection that was already set up when the card first loaded waits for Continue. One that
/// becomes ready while the card is on screen, or after its own sign-in finished in the card, does
/// not. Every ready read after that asks again, so a continue the server refused is retried.
struct ConnectionReadiness: Equatable {
  /// Set up and not waiting on a sign-in, as the server checks (src/shared/integrations.ts connectionReady).
  static func isReady(_ connection: IntegrationConnection?) -> Bool {
    guard let connection else { return false }
    return ["connected", "configured"].contains(connection.status) && connection.authorizing != true
  }
  private var initiallyReady: Bool?
  private var flowApproved = false
  /// A connect or sign-in flow for this card's connection finished. The next ready read settles the request.
  mutating func flowFinished() { flowApproved = true }
  /// Records a catalog read. True when the card should send `connected` itself.
  mutating func observe(ready: Bool) -> Bool {
    guard let initial = initiallyReady else { initiallyReady = ready; return false }
    return ready && (!initial || flowApproved)
  }
}

/// The card for a connection request. It embeds the connection's own integration controls, so
/// connecting, signing in and checking work as they do under Settings. Continue is available once
/// the connection is set up, and Not now declines.
struct ConnectionRequestView: View {
  var request: Attention
  var connection: ConnectionRequest
  var botId: String
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var scheme
  @State private var catalog: IntegrationCatalog?
  @State private var readiness = ConnectionReadiness()
  @State private var sending: String?
  @State private var settled = false
  @State private var autoSent = false
  @State private var error: String?
  private var name: String { store.bootstrap?.bots.first { $0.id == botId }?.name ?? "The assistant" }
  private var entry: IntegrationConnection? { catalog?.connections.first { $0.id == connection.connectionId && $0.id != "apple" } }
  private var serviceName: String { entry?.name ?? "a service" }
  private var missing: Bool { catalog != nil && entry == nil }
  private var ready: Bool { ConnectionReadiness.isReady(entry) }
  private var busy: Bool { sending != nil || settled }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(missing ? "\(name) asked for a connection" : "\(name) wants to connect \(serviceName)").font(.subheadline.bold())
      VStack(alignment: .leading, spacing: 2) {
        Text("Why").font(.caption).foregroundStyle(.secondary)
        Text(connection.reason).font(.subheadline).textSelection(.enabled)
      }.accessibilityElement(children: .combine)
      Text("In \(name)'s words. Credentials go straight to Hermes, never into this chat.").font(.caption).foregroundStyle(.secondary)
      if missing {
        Text("WildBots doesn't have a connection called \(connection.connectionId) for \(name).").font(.subheadline)
          .accessibilityIdentifier("connection.missing")
      } else {
        IntegrationsView(botId: botId, focus: IntegrationFocus(id: connection.connectionId, loaded: { loaded($0) },
          approved: { if $0 == connection.connectionId { readiness.flowFinished() } }))
          .padding(12).frame(maxWidth: .infinity, alignment: .leading)
          .background(Palette.surface(scheme), in: RoundedRectangle(cornerRadius: 10))
        if catalog?.canManage == false && !ready {
          Text("Only a household integration administrator can connect \(serviceName). Ask one of them, or choose Not now.")
            .font(.footnote).accessibilityIdentifier("connection.admin")
        }
      }
      HStack {
        if !missing {
          Button(sending == ConnectionDecision.connected ? "Sending…" : "Continue") { settle(ConnectionDecision.connected) }
            .buttonStyle(.accentProminent).controlSize(.large)
            .disabled(!store.connected || busy || !ready).accessibilityIdentifier("connection.continue")
        }
        Button { settle(ConnectionDecision.decline) } label: {
          Text(sending == ConnectionDecision.decline ? "Sending…" : "Not now").frame(minHeight: 44).padding(.horizontal, 8).contentShape(Rectangle())
        }.disabled(!store.connected || busy).accessibilityIdentifier("connection.decline")
      }
      Text("Or send a message instead. That cancels this request so \(name) can read it.")
        .font(.caption).foregroundStyle(.secondary)
      if let error { Text(error).font(.footnote).foregroundStyle(Palette.attention).accessibilityIdentifier("connection.error") }
    }.accessibilityElement(children: .contain).accessibilityIdentifier("connection")
  }
  private func loaded(_ value: IntegrationCatalog) {
    catalog = value
    let current = value.connections.first { $0.id == connection.connectionId && $0.id != "apple" }
    if readiness.observe(ready: ConnectionReadiness.isReady(current)), !autoSent, !busy {
      autoSent = true
      settle(ConnectionDecision.connected, automatic: true)
    }
  }
  private func settle(_ decision: String, automatic: Bool = false) {
    guard let api = store.api, !busy else { return }
    sending = decision; error = nil
    let id = request.id
    Task {
      defer { sending = nil }
      do {
        let path = "/bots/\(APIClient.component(botId))/connection-requests/\(APIClient.component(id))"
        let result: ConnectionRequestResult = try await api.write(path, ConnectionDecision(decision, for: connection))
        if result.status == "expired" { error = "This request had already closed. Refresh the conversation to see what happened."; return }
        settled = true
        let receipt = decision == ConnectionDecision.connected ? "Connected \(serviceName). \(name) will continue." : "You chose Not now. \(name) will continue without it."
        SettledRequests.shared.remember(botId: botId, requestId: id, text: receipt)
        await store.refreshConversation()
      } catch let failure as APIError where failure.status == 409 {
        // The server re-read the catalog and does not see it set up yet; its message says what is missing.
        // An automatic continue the server refuses waits for the person instead of showing an error.
        autoSent = false
        if !automatic { error = failure.message }
      } catch { autoSent = false; self.error = "Couldn't reach Hermes. Try \(decision == ConnectionDecision.connected ? "Continue" : "Not now") again." }
    }
  }
}
