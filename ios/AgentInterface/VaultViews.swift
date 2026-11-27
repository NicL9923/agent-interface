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
extension VaultLogin {
  /// Where the login lives, worded like the web panel.
  var backendLabel: String { backend == "local" ? "WildBots vault" : backend == "onepassword" ? "1Password" : "Bitwarden" }
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
  var statusText: String {
    if !installed { return "CLI is not installed" }
    if name == "local" { return "Available to this assistant" }
    if !enabled { return "Disabled" }
    return unlocked ? "Unlocked for this profile" : "Locked"
  }
}
struct VaultSecret: Codable, Identifiable {
  var name: String
  var createdAt: String
  var updatedAt: String
  var canRemove: Bool
  var id: String { name }
}
struct ProfileVault: Codable {
  var botId: String
  var profile: String
  var scope: String
  var owner: String
  var notice: String
  var items: [VaultLogin]
  var secrets: [VaultSecret]?
  var sources: [VaultSource]
}
struct AddVaultLogin: Encodable {
  /// The web form starts on Email, the most common way to sign in.
  static let defaultIdentifierType = "email"
  var label: String
  var origin: String
  var identifierType: String
  var identifier: String
  var password: String
  var otpSecret: String? = nil
}
struct AddVaultSecret: Encodable {
  var name: String
  var value: String
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
  /// A login the assistant asked for by address, with no browser page.
  var explicit: ExplicitLoginRequest?
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
/// Everything but the requester is the assistant's own text. Hermes checks only the address.
struct ExplicitLoginRequest: Codable, Equatable {
  struct Requester: Codable, Equatable { var id: String; var name: String? }
  var label: String
  var purpose: String
  var profile: String
  /// The member whose task asked. Only they may answer or cancel.
  var requestedBy: Requester?
  func answerable(by userId: String?) -> Bool { requestedBy == nil || requestedBy?.id == userId }
}
struct SecureRequestAnswer: Encodable {
  var epoch: String
  var sessionId: String
  var method: String
  var cancel: Bool?
  var identifier: String?
  var password: String?
  var value: String?
  /// An explicit-origin answer repeats the address its card showed.
  var origin: String?
  init(request: SecureRequest, identifier: String, value: String, cancel: Bool) {
    epoch = request.epoch; sessionId = request.sessionId; method = request.method
    if cancel { self.cancel = true }
    else if request.method == "vault.save_login" {
      self.identifier = identifier; password = value
      if request.explicit != nil { origin = request.origin }
    }
    else { self.value = value }
  }
}
struct SecureRequestResult: Decodable { var status: String }
struct AddedVaultLogin: Decodable { var id: String }
struct AddedVaultSecret: Decodable { var name: String }
struct RemovedVaultLogin: Decodable { var removed: Bool }

/// Errors from credential operations never expose arbitrary upstream response text.
enum VaultSafety {
  static func error(_ error: Error) -> Error {
    if error is CancellationError { return error }
    let status = (error as? APIError)?.status ?? 502
    let message: String
    switch status {
    case 401, 403: message = "Sign in again or ask the household administrator for access."
    case 404, 409: message = "This request changed or expired. Refresh its status in WildBots."
    case 400, 422: message = "WildBots could not accept these fields. Review them and try again."
    case 429: message = "Another credential operation is running. Wait for it to finish, then refresh its status."
    default: message = "Could not confirm the result from WildBots. Refresh its status before trying again."
    }
    return APIError(message: message, status: status)
  }
  static func uncertain(_ error: Error) -> Bool {
    guard let status = (error as? APIError)?.status else { return true }
    return status == 0 || status >= 500
  }
  static let invalidOriginMessage = "Enter the website address through the hostname, such as https://example.com."
  static let invalidSecretNameMessage = "Secret names use letters, numbers, dots, dashes, and underscores, up to 128 characters."
  /// Shown after a change whose outcome is unknown. Everything stays locked until a reload succeeds.
  static let unconfirmedChange = "WildBots could not confirm this change. Reload and review the saved entries before trying again. Secret fields have been cleared."
  static func validOrigin(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: trimmed), ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host?.isEmpty == false,
      url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, ["", "/"].contains(url.path) else { return false }
    return true
  }
  static func validSecretName(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.range(of: #"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"#, options: .regularExpression) != nil
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
  func addVaultSecret(botId: String, secret: AddVaultSecret) async throws {
    do { let _: AddedVaultSecret = try await write("/bots/\(Self.component(botId))/vault/secrets", secret) }
    catch { throw VaultSafety.error(error) }
  }
  func removeVaultSecret(botId: String, name: String) async throws {
    do { let _: RemovedVaultLogin = try decodeVault(await data(path: "/api/bots/\(Self.component(botId))/vault/secrets/\(Self.component(name))", method: "DELETE")) }
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
  @Environment(AppStore.self) private var store
  @Environment(\.scenePhase) private var scenePhase
  @State private var selectedBot = ""
  @State private var catalog: ProfileVault?
  @State private var busy = false
  @State private var error: String?
  @State private var notice: String?
  @State private var adding = false
  @State private var addingSecret = false
  @State private var removing: VaultLogin?
  @State private var showRemove = false
  @State private var removingSecret: VaultSecret?
  @State private var showRemoveSecret = false
  @State private var unlocking: VaultSource?
  @State private var unlockPassword = ""
  /// A failed change may or may not have reached the server, so actions stay locked until a reload succeeds.
  @State private var uncertain = false
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
      if let error { Section { ErrorBanner(message: error, dismiss: { self.error = nil }) } }
      if let notice { Section { Text(notice).foregroundStyle(Palette.accent) } }
      if let catalog {
        Section {
          Text("Assistant: \(catalog.profile)").font(.subheadline.bold())
          Text(catalog.notice).font(.footnote).foregroundStyle(.secondary)
          Text("Usernames, site details, and secret names are visible metadata. Passwords and secret values are encrypted in WildBots outside chat.").font(.footnote).foregroundStyle(.secondary)
        }
        Section("Saved logins") {
          if catalog.items.isEmpty { Text("No saved logins in the enabled sources.").foregroundStyle(.secondary) }
          ForEach(catalog.items) { login in
            VStack(alignment: .leading, spacing: 6) {
              Text(login.label).font(.headline)
              Text(login.origin).font(.footnote).textSelection(.enabled)
              Text(login.identifier).font(.subheadline).textSelection(.enabled)
              Text(login.backendLabel).font(.caption).foregroundStyle(.secondary)
              if login.hasOtp { Text("Includes a saved authenticator secret.").font(.caption).foregroundStyle(.secondary) }
              if login.canRemove {
                Button("Remove login", role: .destructive) { removing = login; showRemove = true }
                  .accessibilityIdentifier("vault.remove.\(login.id)")
              }
            }.padding(.vertical, 5).buttonStyle(.borderless)
          }
          Button("Add login", systemImage: "plus") { adding = true }.accessibilityIdentifier("vault.add")
        }.disabled(uncertain)
        Section("Saved secrets") {
          let secrets = catalog.secrets ?? []
          if secrets.isEmpty { Text("No saved API keys or custom secrets for this assistant.").foregroundStyle(.secondary) }
          ForEach(secrets) { secret in
            VStack(alignment: .leading, spacing: 6) {
              Text(secret.name).font(.headline.monospaced()).textSelection(.enabled)
              Text("WildBots vault").font(.caption).foregroundStyle(.secondary)
              if secret.canRemove {
                Button("Remove secret", role: .destructive) { removingSecret = secret; showRemoveSecret = true }
                  .accessibilityIdentifier("vault.removeSecret.\(secret.name)")
              }
            }.padding(.vertical, 5).buttonStyle(.borderless)
          }
          Button("Add secret", systemImage: "plus") { addingSecret = true }.accessibilityIdentifier("vault.addSecret")
        }.disabled(uncertain)
        Section {
          ForEach(catalog.sources) { source in
            VStack(alignment: .leading, spacing: 8) {
              HStack { Text(source.displayName).font(.headline); Spacer(); Text(source.statusText).font(.caption).foregroundStyle(.secondary) }
              if source.installed && source.canToggle {
                Button(source.enabled ? "Disable source" : "Enable source") {
                  run(success: source.enabled ? "Vault source disabled." : "Vault source enabled.") { api, id in try await api.setVaultSource(botId: id, source: source.name, enabled: !source.enabled) }
                }
              }
              if source.installed && source.canUnlock { Button("Unlock \(source.displayName)") { unlockPassword = ""; unlocking = source } }
              if source.installed && source.canLock {
                Button("Lock \(source.displayName)") { run(success: "Vault source locked.") { api, id in try await api.lockVaultSource(botId: id, source: source.name) } }
              }
            }.buttonStyle(.borderless).padding(.vertical, 5)
          }
        } header: { Text("Password sources") } footer: { Text("WildBots encrypts saved logins and secrets at rest. Local saved credentials do not have a separate master unlock.") }
          .disabled(uncertain)
      } else if busy { ProgressView("Loading logins…") }
      else if profileBot.isEmpty { Text("Create an assistant before managing its logins.") }
      if !profileBot.isEmpty { Section { Button("Reload logins") { Task { await refresh() } }.disabled(busy).accessibilityIdentifier("vault.reload") } }
    }.navigationTitle("Passwords & logins").navigationBarTitleDisplayMode(.inline)
      .accessibilityIdentifier("vaultForm")
      .disabled(busy || store.sessionExpired || !store.connected)
      .refreshable { await refresh() }
      .task(id: identity) {
        clear(); catalog = nil; error = nil; notice = nil; uncertain = false
        if profileBot.isEmpty { selectedBot = store.selectedBotId ?? store.bootstrap?.bots.first?.id ?? ""; return }
        await refresh()
      }
      .onChange(of: scenePhase) { _, phase in if phase != .active { clear() } }
      .onDisappear { clear() }
      .confirmationDialog("Remove \(removing?.label ?? "this login") from WildBots? This assistant will lose access to it.", isPresented: $showRemove, titleVisibility: .visible) {
        Button("Remove login", role: .destructive) { if let item = removing { run(success: "Login removed from WildBots.") { api, id in try await api.removeVaultLogin(botId: id, itemId: item.id) } } }
      }
      .confirmationDialog("Remove secret \(removingSecret?.name ?? "this secret") from WildBots? This assistant will lose access to it.", isPresented: $showRemoveSecret, titleVisibility: .visible) {
        Button("Remove secret", role: .destructive) { if let secret = removingSecret { run(success: "Secret removed from WildBots.") { api, id in try await api.removeVaultSecret(botId: id, name: secret.name) } } }
      }
      .sheet(isPresented: $adding, onDismiss: { Task { await refresh() } }) {
        if let api = store.api {
          AddVaultLoginView(api: api, botId: profileBot, identity: identity, onSaved: { notice = "Login saved in WildBots." },
            onUncertain: { uncertain = true; error = VaultSafety.unconfirmedChange }).appStore(store)
        }
      }
      .sheet(isPresented: $addingSecret, onDismiss: { Task { await refresh() } }) {
        if let api = store.api {
          AddVaultSecretView(api: api, botId: profileBot, identity: identity, onSaved: { notice = "Secret saved in WildBots." },
            onUncertain: { uncertain = true; error = VaultSafety.unconfirmedChange }).appStore(store)
        }
      }
      .sheet(item: $unlocking, onDismiss: { unlockPassword = "" }) { source in
        NavigationStack {
          Form {
            Section {
              SecureField("Master password", text: $unlockPassword).textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive().accessibilityIdentifier("vault.unlockPassword")
            } footer: { Text("Sent directly to WildBots to unlock \(source.displayName) for this assistant. It is not sent as a chat message.") }
            if let error { Text(error).foregroundStyle(.red).accessibilityIdentifier("vault.unlockError") }
          }.navigationTitle("Unlock \(source.displayName)").navigationBarTitleDisplayMode(.inline)
            .toolbar {
              ToolbarItem(placement: .cancellationAction) { Button("Cancel") { unlocking = nil; unlockPassword = "" }.disabled(busy) }
              ToolbarItem(placement: .confirmationAction) {
                Button("Unlock") { unlock(source) }.disabled(busy || uncertain || unlockPassword.isEmpty).accessibilityIdentifier("vault.unlock")
              }
            }.interactiveDismissDisabled(busy)
        }
      }
  }
  private func clear() { generation = UUID(); unlockPassword = ""; unlocking = nil; adding = false; addingSecret = false; busy = false }
  /// The sheet stays open until Hermes answers, so a failure shows where the password was typed.
  private func unlock(_ source: VaultSource) {
    let password = unlockPassword; unlockPassword = ""
    Task {
      if await perform(success: "Vault source unlocked for this profile.", { api, id in try await api.unlockVaultSource(botId: id, source: source.name, password: password) }) {
        unlocking = nil
      }
    }
  }
  private func refresh() async {
    guard let api = store.api, !profileBot.isEmpty else { return }
    let id = profileBot, scope = identity, current = generation
    busy = true; defer { if current == generation { busy = false } }
    do {
      let value = try await api.vault(botId: id)
      guard current == generation, scope == identity, store.api === api else { return }
      catalog = value; error = nil; uncertain = false
    } catch {
      guard current == generation, scope == identity, !(error is CancellationError) else { return }
      self.error = VaultSafety.error(error).localizedDescription
    }
  }
  private func run(success: String, _ operation: @escaping (APIClient, String) async throws -> Void) {
    Task { _ = await perform(success: success, operation) }
  }
  /// Returns true only when the change succeeded and the reload that follows it ran.
  private func perform(success: String, _ operation: @escaping (APIClient, String) async throws -> Void) async -> Bool {
    guard let api = store.api, store.connected, !busy, !uncertain else { return false }
    let id = profileBot, scope = identity, current = generation
    busy = true; error = nil; notice = nil
    defer { if current == generation { busy = false } }
    do {
      try await operation(api, id)
      guard current == generation, scope == identity, store.api === api else { return false }
      notice = success
      await refresh()
      return true
    } catch {
      guard current == generation, scope == identity, !(error is CancellationError) else { return false }
      if VaultSafety.uncertain(error) {
        uncertain = true
        self.error = VaultSafety.unconfirmedChange
      } else {
        self.error = VaultSafety.error(error).localizedDescription
      }
      return false
    }
  }
}

private struct AddVaultLoginView: View {
  let api: APIClient
  let botId: String
  let identity: String
  var onSaved: () -> Void
  var onUncertain: () -> Void
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @State private var label = ""
  @State private var origin = ""
  @State private var identifierType = AddVaultLogin.defaultIdentifierType
  @State private var identifier = ""
  @State private var password = ""
  @State private var otpSecret = ""
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
          if !origin.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !VaultSafety.validOrigin(origin) {
            Text(VaultSafety.invalidOriginMessage).font(.caption).foregroundStyle(.red).accessibilityIdentifier("vault.originError")
          }
          Text("Use the exact website, such as https://example.com, without a page path. WildBots checks the website before filling credentials.").font(.caption).foregroundStyle(.secondary)
          Picker("Identifier type", selection: $identifierType) { Text("Email").tag("email"); Text("Username").tag("username"); Text("Phone").tag("phone") }
          TextField("Username, email or phone", text: $identifier).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("vault.loginIdentifier")
          SecureField("Password", text: $password).textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive().accessibilityIdentifier("vault.loginPassword")
          SecureField("Authenticator secret (optional)", text: $otpSecret).textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive().accessibilityIdentifier("vault.loginOtpSecret")
        } footer: { Text("Saved in this assistant's encrypted WildBots vault. The identifier is visible metadata; passwords and authenticator secrets stay outside chat.") }
        if let error { Section { Text(error).foregroundStyle(.red) } }
        if uncertain { Section { Text("Close this form and refresh saved logins to review the result before adding again.").font(.footnote) } }
        Button("Save login") { save() }.disabled(busy || uncertain || !store.connected || label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !VaultSafety.validOrigin(origin) || identifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty).accessibilityIdentifier("vault.saveLogin")
      }.accessibilityIdentifier("vaultAddForm").navigationTitle("Add login").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { clear(); dismiss() } } }
        .onChange(of: scenePhase) { _, phase in if phase != .active { clear(); dismiss() } }
        .onChange(of: store.scope) { _, _ in clear(); dismiss() }
        .onDisappear { clear() }
    }
  }
  private func clear() { password = ""; otpSecret = ""; identifier = ""; generation = UUID() }
  private func save() {
    guard !busy, !uncertain, store.api === api else { return }
    let trimmedOtp = otpSecret.trimmingCharacters(in: .whitespacesAndNewlines)
    let login = AddVaultLogin(
      label: label.trimmingCharacters(in: .whitespacesAndNewlines),
      origin: origin.trimmingCharacters(in: .whitespacesAndNewlines),
      identifierType: identifierType,
      identifier: identifier.trimmingCharacters(in: .whitespacesAndNewlines),
      password: password,
      otpSecret: trimmedOtp.isEmpty ? nil : trimmedOtp
    )
    password = ""; otpSecret = ""; identifier = ""; busy = true; error = nil
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
        if uncertain { onUncertain() }
        self.error = error is CancellationError ? "Could not confirm the result from WildBots. Review saved logins before adding again." : VaultSafety.error(error).localizedDescription
      }
    }
  }
}

private struct AddVaultSecretView: View {
  let api: APIClient
  let botId: String
  let identity: String
  var onSaved: () -> Void
  var onUncertain: () -> Void
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @State private var name = ""
  @State private var value = ""
  @State private var busy = false
  @State private var error: String?
  @State private var uncertain = false
  @State private var generation = UUID()
  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Secret name (e.g. API_TOKEN)", text: $name).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("vault.secretName")
          if !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !VaultSafety.validSecretName(name) {
            Text(VaultSafety.invalidSecretNameMessage).font(.caption).foregroundStyle(.red).accessibilityIdentifier("vault.secretNameError")
          }
          SecureField("Secret value", text: $value).textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive().accessibilityIdentifier("vault.secretValue")
        } footer: { Text("Encrypted in this assistant's WildBots vault and available to its tools by name. Saving an existing name replaces its value.") }
        if let error { Section { Text(error).foregroundStyle(.red) } }
        if uncertain { Section { Text("Close this form and refresh saved secrets to review the result before adding again.").font(.footnote) } }
        Button("Save secret") { save() }.disabled(busy || uncertain || !store.connected || !VaultSafety.validSecretName(name) || value.isEmpty).accessibilityIdentifier("vault.saveSecret")
      }.accessibilityIdentifier("vaultAddSecretForm").navigationTitle("Add secret").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { clear(); dismiss() } } }
        .onChange(of: scenePhase) { _, phase in if phase != .active { clear(); dismiss() } }
        .onChange(of: store.scope) { _, _ in clear(); dismiss() }
        .onDisappear { clear() }
    }
  }
  private func clear() { value = ""; generation = UUID() }
  private func save() {
    guard !busy, !uncertain, store.api === api else { return }
    let secret = AddVaultSecret(name: name.trimmingCharacters(in: .whitespacesAndNewlines), value: value)
    value = ""; busy = true; error = nil
    let current = generation
    Task {
      defer { if current == generation { busy = false } }
      do {
        try await api.addVaultSecret(botId: botId, secret: secret)
        guard current == generation, store.api === api, identity == (store.scope ?? "") + "|" + botId else { return }
        onSaved(); dismiss()
      } catch {
        guard current == generation, store.api === api, identity == (store.scope ?? "") + "|" + botId else { return }
        uncertain = VaultSafety.uncertain(error)
        if uncertain { onUncertain() }
        self.error = error is CancellationError ? "Could not confirm the result from WildBots. Review saved secrets before adding again." : VaultSafety.error(error).localizedDescription
      }
    }
  }
}

/// Only request bindings and outcome flags live here. Never credential values.
@MainActor enum SecureRequestOutcomes { static var uncertain: Set<String> = [] }
@MainActor @Observable final class SecureRequestInput {
  var identifier = ""
  var value = ""
  var busy = false
  var message: String?
  var blocked = false
  /// What the card shows while an answer is on its way: the visible identifier, never the secret.
  var sendingIdentifier: String?
  var sendingCancel = false
  /// The confirmation after Hermes took the answer.
  var accepted: String?
  @ObservationIgnored private var generation = UUID()
  func clear() { identifier = ""; value = "" }
  func sceneChanged(to phase: ScenePhase) { if phase == .background { clear() } }
  func teardown() { clear(); generation = UUID(); busy = false; sendingIdentifier = nil }
  func bind(_ key: String) {
    clear(); generation = UUID(); busy = false; sendingIdentifier = nil; sendingCancel = false; accepted = nil
    blocked = SecureRequestOutcomes.uncertain.contains(key)
    message = blocked ? "Could not confirm the result from WildBots. Refresh this request before taking another action." : nil
  }
  func submit(api: APIClient, botId: String, requestId: String, request: SecureRequest, key: String, cancel: Bool, assistant: String = "The assistant",
    current: @escaping () -> Bool, refresh: @escaping () async -> Void) {
    guard !busy, !blocked, accepted == nil, request.supported else { clear(); return }
    let answer = SecureRequestAnswer(request: request, identifier: identifier, value: value, cancel: cancel)
    sendingIdentifier = cancel ? "" : identifier.trimmingCharacters(in: .whitespacesAndNewlines); sendingCancel = cancel
    clear(); busy = true; message = nil
    let nonce = generation
    SecureRequestOutcomes.uncertain.insert(key)
    Task {
      defer { if nonce == generation { sendingIdentifier = nil } }
      do {
        let result = try await api.answerSecureRequest(botId: botId, requestId: requestId, answer: answer)
        SecureRequestOutcomes.uncertain.remove(key)
        guard nonce == generation, current() else { return }
        busy = false; blocked = true
        if result.status == "expired" {
          message = "This request had already closed, so WildBots didn't use what you entered. It may have timed out, been stopped, or closed when someone sent a message."
        } else {
          let text = cancel ? "Request cancelled. \(assistant) will continue without it."
            : request.method == "vault.save_login" ? "Login saved. \(assistant) is continuing." : "Sent securely. \(assistant) is continuing."
          accepted = text
          SettledRequests.shared.remember(botId: botId, requestId: requestId, text: text)
          AccessibilityNotification.Announcement(text).post()
        }
        await refresh()
      } catch {
        let uncertain = VaultSafety.uncertain(error)
        if !uncertain { SecureRequestOutcomes.uncertain.remove(key) }
        guard nonce == generation, current() else { return }
        busy = false
        blocked = uncertain || [404, 409].contains((error as? APIError)?.status ?? 0)
        message = error is CancellationError ? "Could not confirm the result from WildBots. Refresh this request before taking another action." : VaultSafety.error(error).localizedDescription
        if [404, 409].contains((error as? APIError)?.status ?? 0) { await refresh() }
      }
    }
  }
}
struct SecureAttentionView: View {
  var request: Attention
  var botId: String
  @Environment(AppStore.self) private var store
  @Environment(\.scenePhase) private var scenePhase
  @State private var input = SecureRequestInput()
  private var key: String { [store.scope ?? "", botId, request.id, request.secure?.binding ?? ""].joined(separator: "|") }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let secure = request.secure, let explicit = secure.explicit, !explicit.answerable(by: store.bootstrap?.user.id) {
        ExplicitLoginDetails(origin: secure.origin ?? "", request: explicit, assistantName: assistantName)
        Text("Waiting for \(explicit.requestedBy?.name ?? "the household member who started this task"). Only they can save or cancel this login.")
          .font(.footnote).accessibilityIdentifier("secure.waiting")
        Text("Messages you send reach \(assistantName ?? "the assistant") after they answer.").font(.caption).foregroundStyle(.secondary)
      } else if let secure = request.secure {
        if secure.method == "vault.save_login" {
          if let explicit = secure.explicit {
            ExplicitLoginDetails(origin: secure.origin ?? "", request: explicit, assistantName: assistantName)
          } else {
            Text("Save login for \(secure.site ?? "this site")").font(.subheadline.bold())
            Text(secure.origin ?? "").font(.footnote).textSelection(.enabled)
          }
          TextField("Username or email", text: input.sendingIdentifier.map { .constant($0) } ?? $input.identifier).textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("secure.identifier").disabled(input.busy || input.blocked)
        } else if secure.method == "vault.unlock_prompt" {
          Text("Unlock \(secure.displayName ?? "password source") in WildBots").font(.subheadline.bold())
        } else if secure.method == "vault.code" {
          if let site = secure.site { Text(site).font(.subheadline.bold()) }
          if let hint = secure.hint { Text(hint).font(.footnote) }
        } else if secure.method == "secret" {
          Text(secure.envVar ?? "").font(.subheadline.bold())
          Text(secure.prompt ?? "").font(.footnote)
        }
        SecureField(input.sendingIdentifier != nil && !input.sendingCancel ? "••••••••••" : fieldLabel(secure), text: $input.value).textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive().accessibilityIdentifier("secure.value").disabled(input.busy || input.blocked)
        Text("Sent directly to WildBots, outside chat and the model's context. Login identifiers remain visible metadata.").font(.caption).foregroundStyle(.secondary)
        if let accepted = input.accepted {
          Label(accepted, systemImage: "checkmark").font(.subheadline.weight(.semibold)).foregroundStyle(Palette.accent).accessibilityIdentifier("secure.accepted")
        } else if let message = input.message { Text(message).font(.footnote).accessibilityIdentifier("secure.status") }
        if input.blocked { if input.accepted == nil { Button("Refresh request") { Task { await store.refreshConversation() } }.disabled(input.busy) } }
        else {
          HStack {
            Button { submit(cancel: false) } label: {
              if input.sendingIdentifier != nil && !input.sendingCancel { HStack(spacing: 6) { ProgressView(); Text("Sending securely…") } } else { Text("Send securely") }
            }.buttonStyle(.accentProminent).disabled(input.busy || input.value.isEmpty || (secure.method == "vault.save_login" && input.identifier.isEmpty))
              .accessibilityIdentifier("secure.submit")
            Button(input.sendingCancel && input.busy ? "Cancelling…" : "Cancel request", role: .destructive) { submit(cancel: true) }.disabled(input.busy).accessibilityIdentifier("secure.cancel")
          }
          Text("Need to change something? Send a message instead. That cancels this request so \(assistantName ?? "the assistant") can read it and ask again.")
            .font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("secure.replyHint")
        }
      }
    }.disabled(!store.connected || scenePhase == .background)
      .onAppear { input.bind(key) }
      .onChange(of: key) { _, new in input.bind(new) }
      .onChange(of: request.secure) { _, _ in input.bind(key) }
      .onChange(of: scenePhase) { _, phase in input.sceneChanged(to: phase) }
      .onDisappear { input.teardown() }
  }
  private var assistantName: String? { store.bootstrap?.bots.first { $0.id == botId }?.name }
  private func fieldLabel(_ secure: SecureRequest) -> String {
    switch secure.method {
    case "vault.save_login": "Password"
    case "vault.code": "Verification code"
    case "vault.unlock_prompt": "Master password"
    default: "Secret value"
    }
  }
  private func submit(cancel: Bool) {
    guard let api = store.api, let secure = request.secure, store.connected,
      secure.explicit?.answerable(by: store.bootstrap?.user.id) != false else { input.clear(); return }
    let binding = key, token = api.token
    input.submit(api: api, botId: botId, requestId: request.id, request: secure, key: binding, cancel: cancel, assistant: assistantName ?? "The assistant",
      current: { store.api === api && api.token == token && key == binding && !store.sessionExpired },
      refresh: { await store.refreshConversation() })
  }
}

/// What the assistant asked for, as the web card shows it. The address is the only part Hermes checks.
struct ExplicitLoginDetails: View {
  var origin: String
  var request: ExplicitLoginRequest
  var assistantName: String?
  private var asker: String {
    let assistant = assistantName.flatMap { $0 == request.profile ? nil : "\($0) (\(request.profile))" } ?? request.profile
    return request.requestedBy?.name.map { "\(assistant) for \($0)" } ?? assistant
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Save a login for \(request.label)").font(.subheadline.bold())
      LabeledContent("Address") {
        Text(origin).font(.footnote.monospaced()).textSelection(.enabled).accessibilityIdentifier("secure.origin")
      }
      Text("WildBots has not opened or checked this address." + (origin.hasPrefix("http://") ? " It does not use HTTPS." : ""))
        .font(.caption).foregroundStyle(.secondary)
      LabeledContent("Asked by", value: asker)
      LabeledContent("Reason, in the assistant's words") { Text(request.purpose).font(.footnote) }
      Text("Saved in this assistant's encrypted WildBots vault until someone removes it in Logins. The assistant gets a handle and the username, never the password. WildBots fills the password only on pages at exactly this address.")
        .font(.caption).foregroundStyle(.secondary)
      Text("Household members with access to this assistant, and tools running on the WildBots server, can use saved logins.")
        .font(.caption).foregroundStyle(.secondary)
    }.accessibilityElement(children: .contain).accessibilityIdentifier("secure.explicit")
  }
}

/// Requests this device just settled. A settled card folds to one line, and that line stays a
/// moment after Hermes stops listing the request, so the outcome never vanishes with the card.
/// Holds only the confirmation text, never entered values.
@MainActor @Observable final class SettledRequests {
  static let shared = SettledRequests()
  struct Item: Identifiable, Equatable {
    var id: String { botId + "|" + requestId }
    var botId: String
    var requestId: String
    var text: String
    /// The card has shown its confirmation and now shows only this line.
    var collapsed = false
    /// Still shown after Hermes stops listing the request.
    var lingering = true
  }
  private(set) var items: [Item] = []
  func remember(botId: String, requestId: String, text: String) {
    let item = Item(botId: botId, requestId: requestId, text: text)
    items.removeAll { $0.id == item.id }
    items.append(item)
    Task {
      // Timer: the confirmation reads in the card, then folds to its line.
      try? await Task.sleep(for: .seconds(1.2))
      update(item.id) { $0.collapsed = true }
      // Timer: how long the line outlasts a request Hermes no longer lists.
      try? await Task.sleep(for: .seconds(1.3))
      update(item.id) { $0.lingering = false }
      try? await Task.sleep(for: .seconds(60))
      items.removeAll { $0.id == item.id }
    }
  }
  func item(botId: String, requestId: String) -> Item? { items.first { $0.botId == botId && $0.requestId == requestId } }
  func lingering(botId: String, listed: Set<String>) -> [Item] {
    items.filter { $0.botId == botId && $0.lingering && !listed.contains($0.requestId) }
  }
  private func update(_ id: String, _ change: (inout Item) -> Void) {
    guard let index = items.firstIndex(where: { $0.id == id }) else { return }
    change(&items[index])
  }
}

/// The one line a settled request leaves.
struct SettledReceiptRow: View {
  var text: String
  var body: some View {
    Label(text, systemImage: "checkmark").font(.subheadline).padding(.horizontal, 14).padding(.vertical, 10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.accentSoft, in: RoundedRectangle(cornerRadius: 10))
      .accessibilityIdentifier("settledReceipt")
  }
}

/// Whether a message this person sends closes a request so the assistant reads it, as the web
/// composer says. A login asked for by address stays with the member whose task asked.
enum WaitingInput {
  static func closes(_ request: Attention, userId: String?) -> Bool {
    guard request.kind != "official" else { return false }
    guard let requester = request.secure?.explicit?.requestedBy else { return true }
    return requester.id == userId
  }
  static func placeholder(_ conversation: Conversation?, userId: String?) -> String? {
    guard let conversation, conversation.activity.state == .blocked else { return nil }
    let requests = conversation.attention ?? []
    if requests.contains(where: { closes($0, userId: userId) }) { return "Or reply here instead…" }
    if let owner = requests.compactMap({ $0.secure?.explicit?.requestedBy }).first {
      return "Your message waits for \(owner.name ?? "the person who asked")…"
    }
    return nil
  }
}
