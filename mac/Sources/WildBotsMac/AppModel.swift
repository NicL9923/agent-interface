import AppKit
import AuthenticationServices
import Foundation
import Observation
import WildBotsMacCore

/// The live snapshot the dispatcher reads from its own threads.
final class SnapshotBox: @unchecked Sendable {
  private let lock = NSLock()
  private var value: LiveSnapshot
  init(_ value: LiveSnapshot) { self.value = value }
  var current: LiveSnapshot {
    get { lock.withLock { value } }
    set { lock.withLock { value = newValue } }
  }
}

enum Defaults {
  static let server = "serverAddress"
  static let notifyUnattended = "notifyUnattended"
  static let keepAwake = "keepAwakeOnPower"
}

@MainActor @Observable final class AppModel {
  // Linking
  var serverText = UserDefaults.standard.string(forKey: Defaults.server) ?? ""
  var macName = MacInfo.name
  var linking = false
  var error: String?
  private(set) var credential: DeviceCredential?
  private(set) var status: LinkStatus = .unlinked(reason: nil)

  // Policy
  private(set) var policy: PolicyDocument
  private(set) var folderErrors: [String: String] = [:]

  // Live state
  private(set) var activeCount = 0
  private(set) var activity: [ActivityEntry] = []
  private(set) var screenLocked = SystemWatcher.screenIsLocked
  private(set) var screenPermission = ScreenAccess.current
  private(set) var holdingAwake = false

  // Options
  private(set) var notifyUnattended: Bool
  private(set) var keepAwake: Bool
  private(set) var launchAtLogin = LoginItem.enabled

  func setNotifyUnattended(_ on: Bool) {
    notifyUnattended = on
    UserDefaults.standard.set(on, forKey: Defaults.notifyUnattended)
    if on { Notifier.requestPermission() }
  }

  func setKeepAwake(_ on: Bool) {
    keepAwake = on
    UserDefaults.standard.set(on, forKey: Defaults.keepAwake)
    updateAwake()
  }

  @ObservationIgnored let environment: HostEnvironment
  @ObservationIgnored private let credentials = KeychainCredentialStore()
  @ObservationIgnored private let policyURL: URL
  @ObservationIgnored private let snapshot: SnapshotBox
  @ObservationIgnored private let activityLog: ActivityLog
  @ObservationIgnored private let dispatcher: Dispatcher
  @ObservationIgnored private let journal: InvocationJournal
  @ObservationIgnored private var link: LinkClient!
  @ObservationIgnored private let watcher = SystemWatcher()
  @ObservationIgnored private let awake = AwakeKeeper()
  @ObservationIgnored private let browser = SignInBrowser()

  init() throws {
    environment = try HostEnvironment.current()
    let data = URL(fileURLWithPath: environment.appDataDir)
    policyURL = data.appendingPathComponent("policy.json")
    let loaded = PolicyDocument.load(from: policyURL)
    policy = loaded
    UserDefaults.standard.register(defaults: [Defaults.notifyUnattended: true, Defaults.keepAwake: false])
    notifyUnattended = UserDefaults.standard.bool(forKey: Defaults.notifyUnattended)
    keepAwake = UserDefaults.standard.bool(forKey: Defaults.keepAwake)
    snapshot = SnapshotBox(LiveSnapshot(policy: loaded, folders: []))
    let activityLog = ActivityLog(url: data.appendingPathComponent("activity.jsonl"))
    self.activityLog = activityLog
    let journal = try InvocationJournal(url: data.appendingPathComponent("journal.jsonl"))
    self.journal = journal
    let box = snapshot
    // The dispatcher reports from its own threads; hop to the main actor.
    let events: @Sendable (DispatchEvent) -> Void = { event in
      Task { @MainActor in AppModel.shared?.handle(event) }
    }
    let dispatcher = Dispatcher(
      journal: journal, activity: activityLog, environment: environment, screenshots: ScreenCaptureProvider(),
      snapshot: { box.current }, onEvent: events)
    self.dispatcher = dispatcher
    link = LinkClient(
      connector: URLSessionLinkConnector(), credentials: credentials, dispatcher: dispatcher, journal: journal,
      appVersion: MacInfo.appVersion, state: { box.current.macState },
      onStatus: { status in Task { @MainActor in AppModel.shared?.statusChanged(status) } },
      onRevoked: { Task { @MainActor in AppModel.shared?.revoked() } })
    credential = credentials.load()
    activity = activityLog.entries
    rebuildSnapshot()
  }

  /// The one model, for callbacks from the link and dispatcher threads.
  static weak var shared: AppModel?

  func start() {
    AppModel.shared = self
    watcher.onLockChange = { [weak self] locked in self?.setLocked(locked) }
    watcher.onWakeOrNetwork = { [weak self] in
      guard let self else { return }
      Task { await self.link.nudge() }
    }
    watcher.onTick = { [weak self] in self?.tick() }
    watcher.start()
    if notifyUnattended { Notifier.requestPermission() }
    if credential != nil { Task { await link.start() } }
    updateAwake()
  }

  // MARK: Linking

  var isLinked: Bool { credential != nil }

  func linkThisMac() async {
    error = nil
    guard let server = ServerAddress.normalize(serverText) else {
      error = "Enter the household address, such as https://agentui.example.com. Plain HTTP works only for this Mac itself."
      return
    }
    let request = EnrollmentRequest(name: macName, model: MacInfo.model, osVersion: MacInfo.osVersion, appVersion: MacInfo.appVersion)
    if let problem = request.validationError {
      error = problem
      return
    }
    UserDefaults.standard.set(server.absoluteString, forKey: Defaults.server)
    linking = true
    defer { linking = false }
    let api = HouseholdAPI(server: server)
    var token: String?
    do {
      try await api.requireNativeAuth()
      let pkce = try PKCE()
      let callback = try await browser.authorize(url: pkce.signInURL(server: server))
      let session = try await api.exchange(code: pkce.code(from: callback), pkce: pkce)
      token = session
      let assistants = (try? await api.personalAssistants(bearer: session)) ?? []
      let enrollment = try await api.enroll(request, bearer: session)
      let saved = DeviceCredential(
        server: server.absoluteString, deviceId: enrollment.deviceId, credential: enrollment.credential, name: enrollment.name)
      try credentials.save(saved)
      credential = saved
      try? journal.discardUnacknowledged()
      updatePolicy { $0.knownAssistants = assistants }
      dispatcher.open()
      await link.start()
    } catch {
      if (error as? ASWebAuthenticationSessionError)?.code != .canceledLogin { self.error = error.localizedDescription }
    }
    // The Mac keeps only its own credential; the sign-in session always ends here.
    if let token {
      do { try await api.logout(bearer: token) } catch {
        self.error = (self.error.map { $0 + " " } ?? "")
          + "Signing out the temporary session failed (\(error.localizedDescription)); it expires on its own."
      }
    }
  }

  /// Ends the link: stops what runs, revokes this Mac on the server with its own credential and
  /// deletes that credential. If the server cannot be reached, the Mac still forgets the credential
  /// and says to revoke it in WildBots Settings.
  func unlink() async {
    dispatcher.close()
    await link.stop()
    if let credential, let server = URL(string: credential.server) {
      do { try await HouseholdAPI(server: server).unlinkSelf(credential) } catch {
        self.error = "This Mac forgot its link, but the server could not be told (\(error.localizedDescription)). "
          + "Revoke it in WildBots Settings > Macs."
      }
    }
    credentials.delete()
    credential = nil
    status = .unlinked(reason: nil)
    updateAwake()
  }

  func reconnect() {
    Task {
      await link.stop()
      await link.start()
    }
  }

  private func statusChanged(_ status: LinkStatus) {
    self.status = status
    updateAwake()
  }

  private func revoked() {
    credential = nil
    Notifier.unlinked("This Mac was unlinked from WildBots. Assistants can no longer use it.")
    updateAwake()
  }

  // MARK: Policy

  func setPaused(_ paused: Bool) {
    updatePolicy { $0.paused = paused }
    if paused { dispatcher.cancelAll() }
  }

  func addFolder(_ url: URL) {
    switch FolderValidator.validate(url.path, home: environment.home) {
    case .failure(let refusal):
      error = refusal.description
    case .success(let path):
      guard !policy.folders.contains(where: { $0.path == path }) else { return }
      error = nil
      updatePolicy { $0.folders.append(FolderGrant(name: (path as NSString).lastPathComponent, path: path)) }
    }
  }

  func removeFolder(_ folder: FolderGrant) { updatePolicy { $0.folders.removeAll { $0.path == folder.path } } }

  func moveFolderToTop(_ folder: FolderGrant) {
    updatePolicy { policy in
      policy.folders.removeAll { $0.path == folder.path }
      policy.folders.insert(folder, at: 0)
    }
  }

  func addAssistant(id: String, name: String) {
    let id = id.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !id.isEmpty, policy.grant(for: id) == nil else { return }
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    updatePolicy { $0.grants.append(Grant(assistantId: id, assistantName: name.isEmpty ? id : name)) }
  }

  func setAbility(_ ability: Ability, _ on: Bool, for assistantId: String) {
    updatePolicy { policy in
      guard let index = policy.grants.firstIndex(where: { $0.assistantId == assistantId }) else { return }
      if on { policy.grants[index].abilities.insert(ability) } else { policy.grants[index].abilities.remove(ability) }
    }
  }

  func setUnattended(_ on: Bool, for assistantId: String) {
    updatePolicy { policy in
      guard let index = policy.grants.firstIndex(where: { $0.assistantId == assistantId }) else { return }
      policy.grants[index].unattended = on
    }
  }

  func removeAssistant(_ assistantId: String) { updatePolicy { $0.grants.removeAll { $0.assistantId == assistantId } } }

  /// The Activity list's one-click Allow: grants exactly the ability that was asked for.
  func allow(_ entry: ActivityEntry) {
    guard let ability = entry.allowSuggestion else { return }
    addAssistant(id: entry.assistantId, name: entry.assistantName ?? entry.assistantId)
    setAbility(ability, true, for: entry.assistantId)
  }

  func clearActivity() {
    activityLog.clear()
    activity = []
  }

  private func updatePolicy(_ change: (inout PolicyDocument) -> Void) {
    var next = policy
    change(&next)
    guard next != policy else { return }
    do {
      try next.save(to: policyURL)
    } catch {
      self.error = "Your change could not be saved: \(error.localizedDescription)"
      return
    }
    policy = next
    rebuildSnapshot()
    Task { await link.sendState() }
    updateAwake()
  }

  private func rebuildSnapshot() {
    var handles: [FolderHandle] = []
    var errors: [String: String] = [:]
    for folder in policy.folders {
      do { handles.append(try FolderHandle(name: folder.name, path: folder.path)) } catch {
        errors[folder.path] = (error as? ActionError)?.message ?? error.localizedDescription
      }
    }
    folderErrors = errors
    // A folder that cannot be opened is left out, so nothing resolves against a stale path.
    var effective = policy
    effective.folders = policy.folders.filter { errors[$0.path] == nil }
    snapshot.current = LiveSnapshot(policy: effective, folders: handles, screenLocked: screenLocked, screenPermission: screenPermission)
  }

  // MARK: System

  private func handle(_ event: DispatchEvent) {
    switch event {
    case .activeCount(let count):
      activeCount = count
    case .recorded(let entry):
      activity = activityLog.entries
      if entry.scheduled, !entry.wasRefused, notifyUnattended { Notifier.unattended(entry) }
    }
  }

  private func setLocked(_ locked: Bool) {
    guard locked != screenLocked else { return }
    screenLocked = locked
    rebuildSnapshot()
    Task { await link.sendState() }
  }

  private func tick() {
    let permission = ScreenAccess.current
    if permission != screenPermission {
      screenPermission = permission
      rebuildSnapshot()
      Task { await link.sendState() }
    }
    launchAtLogin = LoginItem.enabled
    updateAwake()
  }

  func requestScreenAccess() {
    ScreenAccess.request()
    tick()
  }

  func setLaunchAtLogin(_ on: Bool) {
    do { try LoginItem.set(on) } catch { self.error = "Open at login could not be changed: \(error.localizedDescription)" }
    launchAtLogin = LoginItem.enabled
  }

  /// Awake only while linked, not paused, on power, and switched on.
  private func updateAwake() {
    let hold = keepAwake && credential != nil && status == .linked && !policy.paused && SystemWatcher.onACPower
    awake.update(shouldHold: hold)
    holdingAwake = awake.holding
  }
}
