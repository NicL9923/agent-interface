import SwiftUI

struct VaultLogin: Codable, Identifiable {
  var id: String
  var kind: String
  var label: String
  var origin: String
  var createdAt: String
  var identifier: String
  var identifierType: String
  var hasOtp: Bool
  var backend: String
  var canRemove: Bool
}
struct VaultSource: Codable, Identifiable {
  var name: String
  var displayName: String
  var enabled: Bool
  var needsUnlock: Bool
  var unlocked: Bool
  var installed: Bool
  var canToggle: Bool
  var canUnlock: Bool
  var canLock: Bool
  var id: String { name }
}
struct ProfileVault: Codable {
  var botId: String
  var profile: String
  var scope: String
  var owner: String
  var notice: String
  var items: [VaultLogin]
  var sources: [VaultSource]
}
struct AddVaultLogin: Encodable {
  var label: String
  var origin: String
  var identifierType: String
  var identifier: String
  var password: String
}
struct SecureRequest: Codable, Equatable {
  var epoch: String
  var sessionId: String
  var method: String
  var origin: String?
  var site: String?
  var hint: String?
  var backend: String?
  var displayName: String?
  var envVar: String?
  var prompt: String?
  var supported: Bool {
    guard !epoch.isEmpty, !sessionId.isEmpty else { return false }
    switch method {
    case "vault.save_login": return origin?.isEmpty == false && site?.isEmpty == false
    case "vault.code": return true
    case "vault.unlock_prompt": return ["onepassword", "bitwarden"].contains(backend ?? "") && displayName?.isEmpty == false
    case "secret": return envVar?.isEmpty == false && prompt != nil
    default: return false
    }
  }
  var binding: String { [epoch, sessionId, method].joined(separator: "|") }
}
struct SecureRequestAnswer: Encodable {
  var epoch: String
  var sessionId: String
  var method: String
  var cancel: Bool?
  var identifier: String?
  var password: String?
  var value: String?
  init(request: SecureRequest, identifier: String, value: String, cancel: Bool) {
    epoch = request.epoch; sessionId = request.sessionId; method = request.method
    if cancel { self.cancel = true }
    else if request.method == "vault.save_login" { self.identifier = identifier; password = value }
    else { self.value = value }
  }
}
struct SecureRequestResult: Decodable { var status: String }
struct AddedVaultLogin: Decodable { var id: String }
struct RemovedVaultLogin: Decodable { var removed: Bool }

/// Errors from credential operations never expose arbitrary upstream response text.
enum VaultSafety {
  static func error(_ error: Error) -> Error {
    if error is CancellationError { return error }
    let status = (error as? APIError)?.status ?? 502
    let message: String
    switch status {
    case 401, 403: message = "Sign in again or ask the household administrator for access."
    case 404, 409: message = "This request changed or expired. Refresh its status in Hermes."
    case 400, 422: message = "Hermes could not accept these fields. Review them and try again."
    case 429: message = "Another credential operation is running. Wait for it to finish, then refresh its status."
    default: message = "Could not confirm the result from Hermes. Refresh its status before trying again."
    }
    return APIError(message: message, status: status)
  }
  static func uncertain(_ error: Error) -> Bool {
    guard let status = (error as? APIError)?.status else { return true }
    return status == 0 || status >= 500
  }
  static func validOrigin(_ text: String) -> Bool {
    guard let url = URL(string: text), ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host?.isEmpty == false,
      url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, ["", "/"].contains(url.path) else { return false }
    return true
  }
}
extension APIClient {
  func vault(botId: String) async throws -> ProfileVault {
    do { return try await get("/bots/\(Self.component(botId))/vault") }
    catch { throw VaultSafety.error(error) }
  }
  func addVaultLogin(botId: String, login: AddVaultLogin) async throws {
    do { let _: AddedVaultLogin = try await write("/bots/\(Self.component(botId))/vault/logins", login) }
    catch { throw VaultSafety.error(error) }
  }
  func removeVaultLogin(botId: String, itemId: String) async throws {
    do { let _: RemovedVaultLogin = try decodeVault(await data(path: "/api/bots/\(Self.component(botId))/vault/logins/\(Self.component(itemId))", method: "DELETE")) }
    catch { throw VaultSafety.error(error) }
  }
  func setVaultSource(botId: String, source: String, enabled: Bool) async throws {
    do { let _: EmptyResponse = try await write("/bots/\(Self.component(botId))/vault/sources/\(Self.component(source))", ["enabled": enabled], method: "PUT") }
    catch { throw VaultSafety.error(error) }
  }
  func unlockVaultSource(botId: String, source: String, password: String) async throws {
    do { let _: EmptyResponse = try await write("/bots/\(Self.component(botId))/vault/sources/\(Self.component(source))/unlock", ["password": password]) }
    catch { throw VaultSafety.error(error) }
  }
  func lockVaultSource(botId: String, source: String) async throws {
    do { let _: EmptyResponse = try await write("/bots/\(Self.component(botId))/vault/sources/\(Self.component(source))/lock", [String: String]()) }
    catch { throw VaultSafety.error(error) }
  }
  func answerSecureRequest(botId: String, requestId: String, answer: SecureRequestAnswer) async throws -> SecureRequestResult {
    do { return try await write("/bots/\(Self.component(botId))/secure-requests/\(Self.component(requestId))", answer) }
    catch { throw VaultSafety.error(error) }
  }
  private func decodeVault<T: Decodable>(_ data: Data) throws -> T { try JSONDecoder().decode(T.self, from: data) }
}

struct VaultView: View {
  var botId: String?
  @EnvironmentObject private var store: AppStore
  @Environment(\.scenePhase) private var scenePhase
  @State private var selectedBot = ""
  @State private var catalog: ProfileVault?
  @State private var busy = false
  @State private var error: String?
  @State private var notice: String?
  @State private var adding = false
  @State private var removing: VaultLogin?
  @State private var showRemove = false
  @State private var unlocking: VaultSource?
  @State private var unlockPassword = ""
  @State private var generation = UUID()
  private var profileBot: String { botId ?? selectedBot }
  private var identity: String { (store.scope ?? "") + "|" + profileBot }
  var body: some View {
    Form {
      if botId == nil {
        Section {
          Picker("Logins for", selection: $selectedBot) {
            ForEach(store.bootstrap?.bots ?? []) { Text($0.name).tag($0.id) }
          }
        }
      }
      if let error { Section { ErrorBanner(message: error, dismiss: { self.error = nil }); Button("Refresh status") { Task { await refresh() } } } }
      if let notice { Section { Text(notice).foregroundStyle(Palette.accent) } }
      if let catalog {
        Section {
          Text("Hermes profile: \(catalog.profile)").font(.subheadline.bold())
          Text(catalog.notice).font(.footnote).foregroundStyle(.secondary)
          Text("Usernames and site details are visible metadata. Passwords are handled by Hermes outside the model's context.").font(.footnote).foregroundStyle(.secondary)
        }
        Section("Saved logins") {
          if catalog.items.isEmpty { Text("No logins reported by Hermes.").foregroundStyle(.secondary) }
          ForEach(catalog.items) { login in
            VStack(alignment: .leading, spacing: 6) {
              Text(login.label).font(.headline)
              Text(login.origin).font(.footnote).textSelection(.enabled)
              Text(login.identifier).font(.subheadline).textSelection(.enabled)
              Text(sourceName(login.backend) + (login.hasOtp ? " · Authenticator configured" : "")).font(.caption).foregroundStyle(.secondary)
              if login.canRemove {
                Button("Remove login", role: .destructive) { removing = login; showRemove = true }
                  .accessibilityIdentifier("vault.remove.\(login.id)")
              }
            }.padding(.vertical, 5).buttonStyle(.borderless)
          }
          Button("Add login", systemImage: "plus") { adding = true }.accessibilityIdentifier("vault.add")
        }
        Section {
          ForEach(catalog.sources) { source in
            VStack(alignment: .leading, spacing: 8) {
              HStack { Text(source.displayName).font(.headline); Spacer(); Text(sourceStatus(source)).font(.caption).foregroundStyle(.secondary) }
              if source.installed && source.canToggle { Button(source.enabled ? "Disable source" : "Enable source") { run { api, id in try await api.setVaultSource(botId: id, source: source.name, enabled: !source.enabled) } } }
              if source.installed && source.canUnlock { Button("Unlock \(source.displayName)") { unlockPassword = ""; unlocking = source } }
              if source.installed && source.canLock { Button("Lock \(source.displayName)") { run { api, id in try await api.lockVaultSource(botId: id, source: source.name) } } }
            }.buttonStyle(.borderless).padding(.vertical, 5)
          }
        } header: { Text("Password sources") } footer: { Text("Hermes owns encryption and password-source sessions. Local saved logins do not have a separate master unlock. External source unlocks expire with Hermes's session policy.") }
      } else if busy { ProgressView("Loading logins…") }
      else if profileBot.isEmpty { Text("Create an assistant before managing its logins.") }
    }.navigationTitle("Passwords & logins").navigationBarTitleDisplayMode(.inline)
      .accessibilityIdentifier("vaultForm")
      .disabled(busy || store.sessionExpired || !store.connected)
      .refreshable { await refresh() }
      .task(id: identity) {
        clear(); catalog = nil; error = nil; notice = nil
        if profileBot.isEmpty { selectedBot = store.selectedBotId ?? store.bootstrap?.bots.first?.id ?? ""; return }
        await refresh()
      }
      .onChange(of: scenePhase) { _, phase in if phase != .active { clear() } }
      .onDisappear { clear() }
      .confirmationDialog("Remove \(removing?.label ?? "this login") from this Hermes profile? Assistants using this profile will lose access to it.", isPresented: $showRemove, titleVisibility: .visible) {
        Button("Remove login", role: .destructive) { if let item = removing { run { api, id in try await api.removeVaultLogin(botId: id, itemId: item.id) } } }
      }
      .sheet(isPresented: $adding, onDismiss: { Task { await refresh() } }) {
        if let api = store.api {
          AddVaultLoginView(api: api, botId: profileBot, identity: identity, onSaved: { notice = "Login saved in Hermes." }).environmentObject(store)
        }
      }
      .sheet(item: $unlocking, onDismiss: { unlockPassword = "" }) { source in
        NavigationStack {
          Form {
            Section {
              SecureField("Master password", text: $unlockPassword).textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive().accessibilityIdentifier("vault.unlockPassword")
            } footer: { Text("Sent directly to Hermes to unlock \(source.displayName) for this profile. It is not sent as a chat message.") }
            if let error { Text(error).foregroundStyle(.red) }
          }.navigationTitle("Unlock \(source.displayName)").navigationBarTitleDisplayMode(.inline)
            .toolbar {
              ToolbarItem(placement: .cancellationAction) { Button("Cancel") { unlocking = nil; unlockPassword = "" } }
              ToolbarItem(placement: .confirmationAction) {
                Button("Unlock") {
                  let password = unlockPassword; unlockPassword = ""
                  run { api, id in try await api.unlockVaultSource(botId: id, source: source.name, password: password) }
                  unlocking = nil
                }.disabled(busy || unlockPassword.isEmpty).accessibilityIdentifier("vault.unlock")
              }
            }
        }
      }
  }
  private func clear() { generation = UUID(); unlockPassword = ""; unlocking = nil; adding = false; busy = false }
  private func sourceName(_ name: String) -> String { catalog?.sources.first { $0.name == name }?.displayName ?? name }
  private func sourceStatus(_ source: VaultSource) -> String {
    if !source.installed { return "Unavailable on Hermes" }
    if !source.enabled { return "Disabled" }
    if source.needsUnlock && !source.unlocked { return "Locked" }
    return "Ready"
  }
  private func refresh() async {
    guard let api = store.api, !profileBot.isEmpty else { return }
    let id = profileBot, scope = identity, current = generation
    busy = true; defer { if current == generation { busy = false } }
    do {
      let value = try await api.vault(botId: id)
      guard current == generation, scope == identity, store.api === api else { return }
      catalog = value; error = nil
    } catch {
      guard current == generation, scope == identity, !(error is CancellationError) else { return }
      self.error = VaultSafety.error(error).localizedDescription
    }
  }
  private func run(_ operation: @escaping (APIClient, String) async throws -> Void) {
    guard let api = store.api, store.connected, !busy else { return }
    let id = profileBot, scope = identity, current = generation
    busy = true; error = nil; notice = nil
    Task {
      defer { if current == generation { busy = false } }
      do {
        try await operation(api, id)
        guard current == generation, scope == identity, store.api === api else { return }
        await refresh()
      } catch {
        guard current == generation, scope == identity, !(error is CancellationError) else { return }
        self.error = VaultSafety.error(error).localizedDescription
      }
    }
  }
}

private struct AddVaultLoginView: View {
  let api: APIClient
  let botId: String
  let identity: String
  var onSaved: () -> Void
  @EnvironmentObject private var store: AppStore
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @State private var label = ""
  @State private var origin = ""
  @State private var identifierType = "username"
  @State private var identifier = ""
  @State private var password = ""
  @State private var busy = false
  @State private var error: String?
  @State private var uncertain = false
  @State private var generation = UUID()
  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Login name", text: $label).accessibilityIdentifier("vault.loginLabel")
          TextField("https://site.example", text: $origin).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("vault.loginOrigin")
          Text("Use only the site's address, such as https://example.com.").font(.caption).foregroundStyle(.secondary)
          Picker("Identifier type", selection: $identifierType) { Text("Username").tag("username"); Text("Email").tag("email"); Text("Phone").tag("phone") }
          TextField("Username, email or phone", text: $identifier).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("vault.loginIdentifier")
          SecureField("Password", text: $password).textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive().accessibilityIdentifier("vault.loginPassword")
        } footer: { Text("Saved in the assistant's Hermes profile. The identifier is visible metadata; the password stays outside the model's context. Household access follows this Hermes profile.") }
        if let error { Section { Text(error).foregroundStyle(.red) } }
        if uncertain { Section { Text("Close this form and refresh saved logins to review the result before adding again.").font(.footnote) } }
        Button("Save login") { save() }.disabled(busy || uncertain || !store.connected || label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !VaultSafety.validOrigin(origin) || identifier.isEmpty || password.isEmpty).accessibilityIdentifier("vault.saveLogin")
      }.accessibilityIdentifier("vaultAddForm").navigationTitle("Add login").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { clear(); dismiss() } } }
        .onChange(of: scenePhase) { _, phase in if phase != .active { clear(); dismiss() } }
        .onChange(of: store.scope) { _, _ in clear(); dismiss() }
        .onDisappear { clear() }
    }
  }
  private func clear() { password = ""; identifier = ""; generation = UUID() }
  private func save() {
    guard !busy, !uncertain, store.api === api else { return }
    let login = AddVaultLogin(label: label.trimmingCharacters(in: .whitespacesAndNewlines), origin: origin.trimmingCharacters(in: .whitespacesAndNewlines), identifierType: identifierType, identifier: identifier, password: password)
    password = ""; identifier = ""; busy = true; error = nil
    let current = generation
    Task {
      defer { if current == generation { busy = false } }
      do {
        try await api.addVaultLogin(botId: botId, login: login)
        guard current == generation, store.api === api, identity == (store.scope ?? "") + "|" + botId else { return }
        onSaved(); dismiss()
      } catch {
        guard current == generation, store.api === api, identity == (store.scope ?? "") + "|" + botId else { return }
        uncertain = VaultSafety.uncertain(error)
        self.error = error is CancellationError ? "Could not confirm the result from Hermes. Review saved logins before adding again." : VaultSafety.error(error).localizedDescription
      }
    }
  }
}

/// Only request bindings and outcome flags live here. Never credential values.
@MainActor enum SecureRequestOutcomes { static var uncertain: Set<String> = [] }
@MainActor final class SecureRequestInput: ObservableObject {
  @Published var identifier = ""
  @Published var value = ""
  @Published var busy = false
  @Published var message: String?
  @Published var blocked = false
  private var generation = UUID()
  func clear() { identifier = ""; value = "" }
  func teardown() { clear(); generation = UUID(); busy = false }
  func bind(_ key: String) { clear(); generation = UUID(); busy = false; blocked = SecureRequestOutcomes.uncertain.contains(key); message = blocked ? "Could not confirm the result from Hermes. Refresh this request before taking another action." : nil }
  func submit(api: APIClient, botId: String, requestId: String, request: SecureRequest, key: String, cancel: Bool, current: @escaping () -> Bool, refresh: @escaping () async -> Void) {
    guard !busy, !blocked, request.supported else { clear(); return }
    let answer = SecureRequestAnswer(request: request, identifier: identifier, value: value, cancel: cancel)
    clear(); busy = true; message = nil
    let nonce = generation
    SecureRequestOutcomes.uncertain.insert(key)
    Task {
      do {
        let result = try await api.answerSecureRequest(botId: botId, requestId: requestId, answer: answer)
        SecureRequestOutcomes.uncertain.remove(key)
        guard nonce == generation, current() else { return }
        busy = false; blocked = true
        message = result.status == "expired" ? "This request expired. Refresh to see the current request." : "Response sent directly to Hermes."
        await refresh()
      } catch {
        let uncertain = VaultSafety.uncertain(error)
        if !uncertain { SecureRequestOutcomes.uncertain.remove(key) }
        guard nonce == generation, current() else { return }
        busy = false
        blocked = uncertain || [404, 409].contains((error as? APIError)?.status ?? 0)
        message = error is CancellationError ? "Could not confirm the result from Hermes. Refresh this request before taking another action." : VaultSafety.error(error).localizedDescription
      }
    }
  }
}
struct SecureAttentionView: View {
  var request: Attention
  var botId: String
  @EnvironmentObject private var store: AppStore
  @Environment(\.scenePhase) private var scenePhase
  @StateObject private var input = SecureRequestInput()
  private var key: String { [store.scope ?? "", botId, request.id, request.secure?.binding ?? ""].joined(separator: "|") }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let secure = request.secure {
        if secure.method == "vault.save_login" {
          Text("Save login for \(secure.site ?? "this site")").font(.subheadline.bold())
          Text(secure.origin ?? "").font(.footnote).textSelection(.enabled)
          TextField("Username or email", text: $input.identifier).textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("secure.identifier").disabled(input.busy || input.blocked)
        } else if secure.method == "vault.unlock_prompt" {
          Text("Unlock \(secure.displayName ?? "password source") in Hermes").font(.subheadline.bold())
        } else if secure.method == "vault.code" {
          if let site = secure.site { Text(site).font(.subheadline.bold()) }
          if let hint = secure.hint { Text(hint).font(.footnote) }
        } else if secure.method == "secret" {
          Text(secure.envVar ?? "").font(.subheadline.bold())
          Text(secure.prompt ?? "").font(.footnote)
        }
        SecureField(fieldLabel(secure), text: $input.value).textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive().accessibilityIdentifier("secure.value").disabled(input.busy || input.blocked)
        Text("Sent directly to Hermes, outside chat and the model's context. Login identifiers remain visible metadata. Access follows the assistant's Hermes profile.").font(.caption).foregroundStyle(.secondary)
        if let message = input.message { Text(message).font(.footnote).accessibilityIdentifier("secure.status") }
        if input.blocked { Button("Refresh request") { Task { await store.refreshConversation() } }.disabled(input.busy) }
        else {
          HStack {
            Button("Send securely") { submit(cancel: false) }.buttonStyle(.borderedProminent).disabled(input.busy || input.value.isEmpty || (secure.method == "vault.save_login" && input.identifier.isEmpty))
              .accessibilityIdentifier("secure.submit")
            Button("Cancel request", role: .destructive) { submit(cancel: true) }.disabled(input.busy).accessibilityIdentifier("secure.cancel")
          }
        }
      }
    }.disabled(!store.connected || scenePhase != .active)
      .onAppear { input.bind(key) }
      .onChange(of: key) { _, new in input.bind(new) }
      .onChange(of: request.secure) { _, _ in input.bind(key) }
      .onChange(of: scenePhase) { _, phase in if phase != .active { input.clear() } }
      .onDisappear { input.teardown() }
  }
  private func fieldLabel(_ secure: SecureRequest) -> String {
    switch secure.method {
    case "vault.save_login": "Password"
    case "vault.code": "Verification code"
    case "vault.unlock_prompt": "Master password"
    default: "Secret value"
    }
  }
  private func submit(cancel: Bool) {
    guard let api = store.api, let secure = request.secure, store.connected else { input.clear(); return }
    let binding = key, token = api.token
    input.submit(api: api, botId: botId, requestId: request.id, request: secure, key: binding, cancel: cancel,
      current: { store.api === api && api.token == token && key == binding && !store.sessionExpired },
      refresh: { await store.refreshConversation() })
  }
}
