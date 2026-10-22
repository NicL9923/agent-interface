import Foundation

/// The household's Hermes update as the web's update panel shows it: its status, and the check,
/// install and recovery requests. The store owns one and resets it with the account.
@MainActor @Observable
final class HermesUpgrade {
  @ObservationIgnored weak var store: AppStore?
  private(set) var status: UpgradeStatus?
  private(set) var busy = false
  private(set) var error: String?
  private(set) var installUncertain = false
  /// True only while a check, install or recovery request is in flight, not for status polls.
  private(set) var submitting = false
  @ObservationIgnored private var request: UpgradeInstallRequest?

  func reset() {
    status = nil
    busy = false
    error = nil
    installUncertain = false
    submitting = false
    request = nil
  }
  func refresh() async {
    await operation(nil)
  }
  func check() async {
    guard status?.canCheck == true else { return }
    await operation("check")
  }
  func install(candidateRevision: String) async {
    guard status?.canInstall == true, !installUncertain, status?.candidate?.revision == candidateRevision else { return }
    if request?.candidateRevision != candidateRevision {
      request = UpgradeInstallRequest(candidateRevision: candidateRevision, requestId: UUID().uuidString)
    }
    await operation("install")
  }
  func control(_ action: String, operationId: String) async {
    guard let status, status.operationId == operationId, !installUncertain else { return }
    let permitted = action == "retry" ? status.canRetry : action == "cancel" ? status.canCancel : action == "restart_service" ? status.canRestartService : false
    guard permitted == true else { return }
    await operation(action)
  }
  private func operation(_ action: String?) async {
    guard let store, let api = store.api, api.token != nil, !store.sessionExpired, !busy else { return }
    let currentGeneration = store.generation
    busy = true
    submitting = action != nil
    defer { if currentGeneration == store.generation { busy = false; submitting = false } }
    do {
      let value: UpgradeStatus
      if action == "install", let request {
        value = try await api.write("/hermes/upgrade/install", request)
      } else if let action, ["retry", "cancel", "restart_service"].contains(action), let operationId = status?.operationId {
        value = try await api.write("/hermes/upgrade/control", UpgradeControlRequest(action: action, operationId: operationId, requestId: UUID().uuidString))
      } else if action == "check" {
        value = try await api.write("/hermes/upgrade/check", [String: String]())
      } else {
        value = try await api.get("/hermes/upgrade")
      }
      guard currentGeneration == store.generation else { return }
      status = value
      error = nil
      installUncertain = false
      if ["succeeded", "failed", "rolled_back"].contains(value.phase) { request = nil }
    } catch {
      guard currentGeneration == store.generation, !(error is CancellationError) else { return }
      let code = (error as? APIError)?.status
      if code == 401 { store.report(error) }
      if code == 404 {
        self.error = "This app server doesn't support Hermes updates yet. Ask the self-hoster to update the app server."
      } else {
        self.error = error.localizedDescription
      }
      if action != nil, code == nil || code == 0 || (code ?? 0) >= 500 {
        installUncertain = true
        self.error = "The update request may have reached the server. Refresh its status before trying again. \(error.localizedDescription)"
      }
    }
  }
}
