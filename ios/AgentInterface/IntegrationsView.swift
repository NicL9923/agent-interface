import SafariServices
import SwiftUI

struct IntegrationField: Codable, Identifiable {
  var key: String
  var label: String
  var kind: String
  var required: Bool
  var defaultValue: String?
  var options: [IntegrationFieldOption]?
  var id: String { key }
}
struct IntegrationFieldOption: Codable { var value: String; var label: String }
struct IntegrationPermission: Codable, Identifiable {
  var id: String
  var name: String
  var granted: Bool?
}
struct IntegrationActions: Codable {
  var connect: Bool
  var check: Bool
  var disconnect: Bool
}
struct IntegrationConnection: Codable, Identifiable {
  var id: String
  var name: String
  var category: String
  var owner: String
  var profile: String
  var account: String?
  var status: String
  var detail: String
  var checkedAt: String?
  var permissions: [IntegrationPermission]
  var actions: IntegrationActions
  var setup: [IntegrationField]
  var capabilities: [String]
  var botIds: [String]
  var statusLabel: String {
    switch status {
    case "connected": "Connected"
    case "configured": "Configured · not checked"
    case "expired": "Sign in again"
    case "missing_permission": "Permission needed"
    case "unavailable": "Unavailable"
    case "unsupported": "Setup needed"
    default: "Not connected"
    }
  }
}
struct IntegrationCatalog: Codable {
  var profile: String
  var canManage: Bool
  var connections: [IntegrationConnection]
}
struct IntegrationFlow: Codable {
  var kind: String
  var status: String
  var flowId: String?
  var url: String?
  var userCode: String?
  var message: String
  var expiresAt: String?
  var callbackInput: Bool?
}
struct IntegrationConnectInput: Encodable {
  var profile: String
  var fields: [String: String]
}
struct CustomMcpResponse: Decodable {
  var flow: IntegrationFlow?
  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if let value = try? container.decode(IntegrationFlow.self) { flow = value }
    else { _ = try container.decode(IntegrationConnection.self); flow = nil }
  }
}
struct CustomMcpRequest: Encodable {
  var profile: String
  var name: String
  var url: String
  var auth: String
  var token: String?
}
private struct IntegrationBrowser: Identifiable { let id = UUID(); var url: URL }
private struct IntegrationSafariView: UIViewControllerRepresentable {
  var url: URL
  func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
  func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

struct IntegrationsView: View {
  var botId: String?
  @EnvironmentObject private var store: AppStore
  @Environment(\.scenePhase) private var scenePhase
  @State private var selectedProfile = ""
  @State private var catalog: IntegrationCatalog?
  @State private var error: String?
  @State private var busy = false
  @State private var editing: IntegrationConnection?
  @State private var fields: [String: String] = [:]
  @State private var flow: IntegrationFlow?
  @State private var browser: IntegrationBrowser?
  @State private var callback = ""
  @State private var disconnecting: IntegrationConnection?
  @State private var showDisconnect = false
  @State private var custom = false
  @State private var mcpName = ""
  @State private var mcpURL = ""
  @State private var mcpAuth = "none"
  @State private var mcpToken = ""
  private var profile: String { botId ?? selectedProfile }
  private var flowKey: String { "integration.flow.\(store.scope ?? "").\(profile)" }
  var body: some View {
    Form {
      if botId == nil {
        Section {
          Picker("Connections for", selection: $selectedProfile) {
            ForEach(store.bootstrap?.bots ?? []) { Text($0.name).tag($0.id) }
          }
        } footer: { Text("Connections belong to the selected assistant's Hermes profile. Their permissions are checked separately.") }
      }
      if let error {
        Section {
          Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
          Button("Refresh status") { Task { await refresh() } }
        }
      }
      if let flow { flowSection(flow) }
      if let catalog {
        ForEach(categories(catalog), id: \.self) { category in
          Section(categoryLabel(category)) {
            ForEach(catalog.connections.filter { $0.category == category }) { connection in
              connectionRow(connection, canManage: catalog.canManage)
            }
          }
        }
        if catalog.connections.isEmpty { Text("Hermes has not reported connections for this assistant.").foregroundStyle(.secondary) }
        if catalog.canManage {
          Section { Button("Add custom MCP connection", systemImage: "plus") { custom = true } }
        }
      } else if busy { ProgressView("Loading connections…") }
      else if profile.isEmpty { Text("Create an assistant before connecting its services.") }
      Section {
        NavigationLink { AppleDeviceConnectionsView(botId: profile) } label: {
          Label("Apple Calendar & Reminders", systemImage: "calendar")
        }
      } footer: { Text("Choose data on this iPhone and share it with an assistant. Sharing requires this app to be open.") }
    }.navigationTitle("Integrations").navigationBarTitleDisplayMode(.inline)
      .disabled(store.sessionExpired)
      .refreshable { await refresh() }
      .task(id: profile) {
        guard !profile.isEmpty else {
          selectedProfile = store.selectedBotId ?? store.bootstrap?.bots.first?.id ?? ""
          return
        }
        catalog = nil
        flow = nil
        if let flowId = UserDefaults.standard.string(forKey: flowKey) {
          flow = IntegrationFlow(kind: "instructions", status: "pending", flowId: flowId, message: "Restoring sign-in status…")
        }
        await refresh()
        while !Task.isCancelled {
          do { try await Task.sleep(for: .seconds(flow?.status == "pending" ? 2 : 15)) } catch { return }
          if scenePhase == .active { await refreshFlow(); if flow?.status != "pending" { await refresh() } }
        }
      }
      .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await refreshFlow(); await refresh() } } }
      .sheet(item: $browser, onDismiss: { Task { await refreshFlow(); await refresh() } }) { IntegrationSafariView(url: $0.url).ignoresSafeArea() }
      .sheet(item: $editing, onDismiss: { if let url = safeURL(flow?.url), flow?.status == "pending" { browser = IntegrationBrowser(url: url) } }) { connection in
        NavigationStack {
          Form {
            Section {
              ForEach(connection.setup) { field in
                if let options = field.options { Picker(field.label, selection: fieldBinding(field.key)) { ForEach(options, id: \.value) { Text($0.label).tag($0.value) } } }
                else if field.kind == "secret" { SecureField(field.label, text: fieldBinding(field.key)) }
                else { TextField(field.label, text: fieldBinding(field.key)).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(field.kind == "url" ? .URL : .default) }
              }
            } footer: { Text("Credentials stay with Hermes. Secret fields are cleared after saving.") }
            if let error { Text(error).foregroundStyle(.red) }
            Button("Connect") { Task { await operate(connection, "connect"); if error == nil { editing = nil; fields = [:] } } }
              .disabled(busy || connection.setup.contains { $0.required && (fields[$0.key] ?? "").trimmingCharacters(in: .whitespaces).isEmpty })
          }.navigationTitle("Connect \(connection.name)").toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { editing = nil; fields = [:] }.disabled(busy) }
          }
        }
      }
      .sheet(isPresented: $custom, onDismiss: { mcpToken = ""; if let url = safeURL(flow?.url), flow?.status == "pending" { browser = IntegrationBrowser(url: url) } }) { customForm }
      .confirmationDialog("Disconnect \(disconnecting?.name ?? "this connection")? Assistants using it will lose access.", isPresented: $showDisconnect, titleVisibility: .visible) {
        Button("Disconnect", role: .destructive) { if let connection = disconnecting { Task { await operate(connection, "disconnect") } } }
      }
  }
  @ViewBuilder private func connectionRow(_ connection: IntegrationConnection, canManage: Bool) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top) {
        Text(connection.name).font(.headline)
        Spacer()
        Text(connection.statusLabel).font(.caption).foregroundStyle(connection.status == "connected" ? Palette.accent : .secondary)
      }
      if let account = connection.account { Text(account).font(.subheadline).textSelection(.enabled) }
      Text(connection.detail).font(.footnote).foregroundStyle(.secondary)
      Text("Managed by \(connection.owner)").font(.caption).foregroundStyle(.secondary)
      if !connection.botIds.isEmpty { Text("Assistants: \(connection.botIds.map { id in store.bootstrap?.bots.first { $0.id == id }?.name ?? id }.joined(separator: ", "))").font(.caption).foregroundStyle(.secondary) }
      if let date = connection.checkedAt.flatMap(ServerDate.parse) { Text("Last checked \(date.formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(.secondary) }
      else { Text("Not checked yet").font(.caption).foregroundStyle(.secondary) }
      if !connection.permissions.isEmpty {
        DisclosureGroup("Access & permissions") {
          ForEach(connection.permissions) { permission in
            LabeledContent(permission.name, value: permission.granted == true ? "Granted" : permission.granted == false ? "Missing" : "Not checked").font(.caption)
          }
        }.font(.footnote)
      }
      if connection.actions.connect {
        Button(["not_connected", "unsupported"].contains(connection.status) ? "Connect" : "Reconnect") {
          fields = Dictionary(uniqueKeysWithValues: connection.setup.compactMap { field in field.defaultValue.map { (field.key, $0) } })
          if connection.setup.isEmpty { Task { await operate(connection, "connect") } } else { editing = connection }
        }.disabled(busy || !canManage || flow?.status == "pending")
      }
      if connection.actions.check { Button("Check connection") { Task { await operate(connection, "check") } }.disabled(busy) }
      if connection.actions.disconnect {
        Button("Disconnect", role: .destructive) { disconnecting = connection; showDisconnect = true }.disabled(busy || !canManage)
      }
    }.padding(.vertical, 8).buttonStyle(.borderless)
  }
  @ViewBuilder private func flowSection(_ value: IntegrationFlow) -> some View {
    Section(value.status == "pending" ? "Finish connecting your account" : "Sign-in status") {
      Text(value.message)
      if let code = value.userCode { LabeledContent("Sign-in code", value: code).textSelection(.enabled) }
      if value.status == "pending" {
        if let url = safeURL(value.url) { Button("Open sign-in") { browser = IntegrationBrowser(url: url) } }
        if value.callbackInput == true {
          TextField("Returned browser address", text: $callback).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
          Button("Finish connection") { Task { await finishFlow(cancel: false) } }.disabled(busy || callback.isEmpty)
        }
        Button("Cancel sign-in", role: .destructive) { Task { await finishFlow(cancel: true) } }.disabled(busy)
      } else { Button("Dismiss") { flow = nil } }
    }
  }
  private var customForm: some View {
    NavigationStack {
      Form {
        TextField("Connection name", text: $mcpName).textInputAutocapitalization(.never).autocorrectionDisabled()
        Text("Use letters, numbers, underscores, or hyphens, up to 80 characters.").font(.caption).foregroundStyle(.secondary)
        TextField("https://server-address", text: $mcpURL).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
        Picker("Sign-in method", selection: $mcpAuth) {
          Text("No sign-in").tag("none"); Text("Sign in with browser").tag("oauth"); Text("Access token").tag("bearer")
        }.onChange(of: mcpAuth) { _, _ in mcpToken = "" }
        if mcpAuth == "bearer" { SecureField("Access token", text: $mcpToken) }
        if let error { Text(error).foregroundStyle(.red) }
        Button("Add connection") { Task { await addCustom() } }.disabled(busy || mcpName.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) == nil || mcpURL.isEmpty || mcpAuth == "bearer" && mcpToken.isEmpty)
      }.navigationTitle("Custom connection").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { custom = false }.disabled(busy) } }
    }
  }
  private func fieldBinding(_ key: String) -> Binding<String> { Binding(get: { fields[key] ?? "" }, set: { fields[key] = $0 }) }
  private func categories(_ value: IntegrationCatalog) -> [String] { value.connections.reduce(into: []) { if !$0.contains($1.category) { $0.append($1.category) } } }
  private func categoryLabel(_ category: String) -> String { ["productivity": "Accounts & productivity", "development": "Development & infrastructure", "files": "Files & storage", "home": "Home", "devices": "On your devices", "providers": "Models, search & images", "messaging": "Messaging", "custom": "Custom connections"][category] ?? category }
  private func safeURL(_ value: String?) -> URL? { guard let value, let url = URL(string: value), url.scheme == "https" || url.scheme == "http" && ["localhost", "127.0.0.1"].contains(url.host ?? "") else { return nil }; return url }
  private func actionError(_ error: Error) -> String {
    if let apiError = error as? APIError, apiError.status >= 500 { return "We couldn't confirm this connection change. Refresh status before trying again. The request won't be sent again automatically." }
    return error.localizedDescription
  }
  private func refresh() async {
    guard let api = store.api, !profile.isEmpty, !busy else { return }
    let currentProfile = profile
    busy = true; defer { busy = false }
    do { let value: IntegrationCatalog = try await api.get("/integrations?profile=\(APIClient.component(currentProfile))"); guard profile == currentProfile, store.api === api else { return }; catalog = value; error = nil }
    catch { self.error = error.localizedDescription; if (error as? APIError)?.status == 401 { store.report(error) } }
  }
  private func operate(_ connection: IntegrationConnection, _ action: String) async {
    guard let api = store.api, !busy else { return }
    busy = true; error = nil
    do {
      if action == "connect" {
        let value: IntegrationFlow = try await api.write("/integrations/\(APIClient.component(connection.id))/connect", IntegrationConnectInput(profile: profile, fields: fields))
        guard store.api === api, connection.profile == profile else { busy = false; return }
        fields = [:]; flow = value
        if let id = value.flowId, value.status == "pending" { UserDefaults.standard.set(id, forKey: flowKey) }
        if editing == nil, let url = safeURL(value.url) { browser = IntegrationBrowser(url: url) }
      } else if action == "disconnect" {
        let _: IntegrationFlow = try await api.write("/integrations/\(APIClient.component(connection.id))/disconnect", ["profile": profile])
      } else {
        let _: IntegrationConnection = try await api.write("/integrations/\(APIClient.component(connection.id))/\(action)", ["profile": profile])
      }
    } catch { self.error = actionError(error); if (error as? APIError)?.status == 401 { store.report(error) } }
    busy = false
    if error == nil { await refresh() }
  }
  private func refreshFlow() async {
    guard let api = store.api, let id = flow?.flowId, flow?.status == "pending", !busy else { return }
    do {
      let value: IntegrationFlow = try await api.get("/integrations/flows/\(APIClient.component(id))?profile=\(APIClient.component(profile))")
      guard flow?.flowId == id, store.api === api else { return }
      flow = value
      if value.status != "pending" { UserDefaults.standard.removeObject(forKey: flowKey); browser = nil; await refresh() }
    } catch { self.error = error.localizedDescription }
  }
  private func finishFlow(cancel: Bool) async {
    guard let api = store.api, let id = flow?.flowId, !busy else { return }
    busy = true; error = nil; defer { busy = false }
    do {
      let value: IntegrationFlow
      if cancel { value = try JSONDecoder().decode(IntegrationFlow.self, from: await api.data(path: "/api/integrations/flows/\(APIClient.component(id))?profile=\(APIClient.component(profile))", method: "DELETE")) }
      else { value = try await api.write("/integrations/flows/\(APIClient.component(id))/callback", ["profile": profile, "callbackUrl": callback]) }
      guard flow?.flowId == id, store.api === api else { return }
      flow = value; callback = ""
      if value.status != "pending" { UserDefaults.standard.removeObject(forKey: flowKey); browser = nil }
    } catch { self.error = error.localizedDescription }
  }
  private func addCustom() async {
    guard let api = store.api, !busy else { return }
    busy = true; error = nil
    do {
      let response: CustomMcpResponse = try await api.write("/integrations/mcp", CustomMcpRequest(profile: profile, name: mcpName, url: mcpURL, auth: mcpAuth, token: mcpAuth == "bearer" ? mcpToken : nil))
      if let value = response.flow { flow = value; if let id = value.flowId, value.status == "pending" { UserDefaults.standard.set(id, forKey: flowKey) } }
      mcpToken = ""; custom = false; mcpName = ""; mcpURL = ""
    } catch { self.error = actionError(error) }
    busy = false
    if error == nil { await refresh() }
  }
}
