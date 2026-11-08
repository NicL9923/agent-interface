import SwiftUI

/// `GET /api/mac/devices`: the signed-in person's linked Macs (docs/MacLink.md). `available` is
/// false when the server has no Mac link key, and Settings hides the row then.
struct MacDeviceList: Codable, Equatable {
  var available: Bool
  var reason: String?
  var devices: [MacDevice]?

  /// The Settings row's detail: how many are linked and online.
  var summary: String {
    let all = devices ?? []
    guard !all.isEmpty else { return "No Macs linked" }
    let online = all.filter(\.online).count
    let linked = all.count == 1 ? "1 Mac" : "\(all.count) Macs"
    return online == 0 ? "\(linked), offline" : "\(linked), \(online) online"
  }

  static func load(_ api: APIClient) async throws -> MacDeviceList { try await api.get("/mac/devices") }

  static func revoke(_ id: String, api: APIClient) async throws {
    let escaped = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? id
    try await api.delete("/mac/devices/\(escaped)")
  }
}

struct MacDevice: Codable, Equatable, Identifiable {
  var id: String
  var name: String
  var model: String?
  var osVersion: String?
  var appVersion: String?
  var createdAt: String?
  var lastSeenAt: String?
  var online: Bool

  /// "Online", or when the Mac last connected. A Mac that never connected says so.
  func status(now: Date = Date()) -> String {
    if online { return "Online" }
    guard let seen = lastSeenAt.flatMap(ServerDate.parse) else { return "Never connected" }
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .full
    return "Last seen " + formatter.localizedString(for: seen, relativeTo: now)
  }
}

struct MacsView: View {
  @Binding var list: MacDeviceList?
  @Environment(AppStore.self) private var store
  @State private var revoking: MacDevice?
  @State private var busy = false
  @State private var error: String?

  var body: some View {
    Form {
      Section {
        if (list?.devices ?? []).isEmpty {
          Text("No Macs linked").foregroundStyle(Palette.muted)
        }
        ForEach(list?.devices ?? []) { mac in
          HStack {
            VStack(alignment: .leading, spacing: 4) {
              Text(mac.name)
              Text(mac.status()).font(.caption).foregroundStyle(mac.online ? Palette.accent : Palette.muted)
            }
            Spacer(minLength: 8)
            Button("Revoke", role: .destructive) { revoking = mac }.buttonStyle(.borderless)
              .accessibilityIdentifier("revokeMac-\(mac.id)")
          }
        }
      } footer: {
        Text("Install WildBots for Mac and choose Link this Mac to add one. Revoking disconnects the Mac at once, stops what it is running and deletes its credential.")
      }
      if let error { Section { ErrorBanner(message: error, dismiss: { self.error = nil }) } }
    }
    .householdListBackground().navigationTitle("Macs").navigationBarTitleDisplayMode(.inline)
    .disabled(busy || store.sessionExpired)
    .refreshable { await reload() }
    .confirmationDialog(
      "Revoke \(revoking?.name ?? "this Mac")?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }),
      titleVisibility: .visible, presenting: revoking
    ) { mac in
      Button("Revoke", role: .destructive) { Task { await revoke(mac) } }
    } message: { _ in
      Text("Assistants can no longer use it. To use it again, link it again from the Mac.")
    }
  }

  private func reload() async {
    guard let api = store.api else { return }
    do { list = try await MacDeviceList.load(api) } catch { self.error = error.localizedDescription }
  }

  private func revoke(_ mac: MacDevice) async {
    guard let api = store.api else { return }
    busy = true
    defer { busy = false }
    do {
      try await MacDeviceList.revoke(mac.id, api: api)
      list?.devices?.removeAll { $0.id == mac.id }
      await reload()
    } catch {
      self.error = error.localizedDescription
    }
  }
}
