import SwiftUI

struct HermesUpgradeView: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.scenePhase) private var scenePhase
  @State private var confirmedRevision: String?
  @State private var showInstallConfirmation = false
  @State private var recoveryAction: String?
  @State private var recoveryOperation: String?
  @State private var showRecoveryConfirmation = false
  var body: some View {
    Form {
      Section {
        VStack(alignment: .leading, spacing: 12) {
          Label(store.upgradeStatus?.title ?? "Hermes updates", systemImage: statusSymbol)
            .font(.title3.bold())
          if let status = store.upgradeStatus {
            Text(status.message).foregroundStyle(.secondary)
            if status.inProgress {
              ProgressView().accessibilityLabel(status.title)
            }
          } else if store.upgradeBusy {
            ProgressView("Loading update status…")
          } else {
            Text("Check and update the shared Hermes installation from this app.")
              .foregroundStyle(.secondary)
          }
        }.padding(.vertical, 8)
        if let current = store.upgradeStatus?.current {
          LabeledContent("Installed", value: current.displayVersion)
        }
        if let candidate = store.upgradeStatus?.candidate {
          LabeledContent("Available", value: candidate.displayVersion)
          if let notes = candidate.notesUrl, let url = URL(string: notes), url.scheme == "https" {
            Link("What's new", destination: url)
          }
        }
        if let status = store.upgradeStatus {
          if status.canInstall, let candidate = status.candidate {
            Button("Update Hermes") {
              confirmedRevision = candidate.revision
              showInstallConfirmation = true
            }.disabled(store.upgradeBusy || store.sessionExpired || store.upgradeInstallUncertain)
              .accessibilityIdentifier("installHermesUpdate")
          }
          if status.available && status.canCheck {
            Button(status.candidate == nil ? "Check for updates" : "Check again") {
              Task { await store.checkUpgrade() }
            }.disabled(store.upgradeBusy || store.sessionExpired || store.upgradeInstallUncertain)
              .accessibilityIdentifier("checkHermesUpdate")
          }
        }
      } footer: {
        Text("Updates affect the shared household installation. Your conversations stay saved. Hermes may disconnect briefly while it restarts.")
      }
      if let status = store.upgradeStatus, status.canRetry == true || status.canCancel == true || status.canRestartService == true {
        Section {
          if status.canRetry == true {
            Button("Retry update") { recover("retry", status: status) }
              .accessibilityIdentifier("retryHermesUpdate")
          }
          if status.canRestartService == true {
            Button("Restart Hermes") { recover("restart_service", status: status) }
              .accessibilityIdentifier("restartHermesService")
          }
          if status.canCancel == true {
            Button("Cancel update", role: .destructive) { recover("cancel", status: status) }
              .accessibilityIdentifier("cancelHermesUpdate")
          }
        } header: { Text("Update recovery") } footer: {
          Text("Recovery waits for a safe stopping point and checks the connection before assistants can work again.")
        }.disabled(store.upgradeBusy || store.sessionExpired || store.upgradeInstallUncertain)
      }
      if let error = store.upgradeError {
        Section {
          Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
          Button("Refresh update status") { Task { await store.refreshUpgrade() } }
            .disabled(store.upgradeBusy || store.sessionExpired)
            .accessibilityIdentifier("refreshHermesUpdate")
          if store.sessionExpired {
            Button("Sign in again") { Task { await store.signIn(); await store.refreshUpgrade() } }
          }
        }
      }
      if let status = store.upgradeStatus, !status.busyBots.isEmpty {
        Section("Assistants are busy") {
          Text("Let these assistants finish before updating Hermes.").foregroundStyle(.secondary)
          ForEach(status.busyBots, id: \.self) { id in
            Text(store.bootstrap?.bots.first { $0.id == id }?.name ?? id)
          }
        }
      }
      if let status = store.upgradeStatus, !status.checks.isEmpty {
        Section {
          DisclosureGroup("Compatibility checks") {
            ForEach(status.checks) { check in
              VStack(alignment: .leading, spacing: 4) {
                HStack {
                  Label(check.label, systemImage: checkSymbol(check.status))
                  Spacer()
                  Text(check.status.capitalized).font(.caption).foregroundStyle(.secondary)
                }
                if let detail = check.detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
              }.padding(.vertical, 4)
            }
          }
        } footer: {
          if let checked = status.checkedAt, let date = ServerDate.parse(checked) {
            Text("Last checked \(date.formatted(date: .abbreviated, time: .shortened))")
          }
        }
      }
    }.navigationTitle("Hermes updates").navigationBarTitleDisplayMode(.inline)
      .task(id: store.upgradeStatus?.inProgress == true) {
        await store.refreshUpgrade()
        while !Task.isCancelled {
          do {
            try await Task.sleep(for: .seconds(store.upgradeStatus?.inProgress == true ? 2 : 15))
          } catch { return }
          if scenePhase == .active { await store.refreshUpgrade() }
        }
      }
      .refreshable { await store.refreshUpgrade() }
      .confirmationDialog("Update the household's Hermes installation?", isPresented: $showInstallConfirmation, titleVisibility: .visible) {
        Button("Update Hermes") {
          guard let revision = confirmedRevision else { return }
          Task { await store.installUpgrade(candidateRevision: revision) }
        }
      } message: {
        Text("The server will update and verify Hermes. If verification fails, it will try to restore the previous version.")
      }
      .confirmationDialog(recoveryAction == "cancel" ? "Cancel this update and restore a working version?" : recoveryAction == "restart_service" ? "Restart Hermes and check the connection?" : "Retry this update?", isPresented: $showRecoveryConfirmation, titleVisibility: .visible) {
        Button(recoveryAction == "cancel" ? "Cancel update" : recoveryAction == "restart_service" ? "Restart Hermes" : "Retry update", role: recoveryAction == "cancel" ? .destructive : nil) {
          guard let action = recoveryAction, let operationId = recoveryOperation else { return }
          Task { await store.controlUpgrade(action, operationId: operationId) }
        }
      } message: {
        Text("This affects the household installation. The server verifies recovery before reopening work.")
      }
  }
  private func recover(_ action: String, status: UpgradeStatus) {
    guard let operationId = status.operationId else { return }
    recoveryAction = action
    recoveryOperation = operationId
    showRecoveryConfirmation = true
  }
  private var statusSymbol: String {
    switch store.upgradeStatus?.phase {
    case "succeeded": "checkmark.circle"
    case "failed", "blocked", "rolled_back": "exclamationmark.circle"
    default: "arrow.down.circle"
    }
  }
  private func checkSymbol(_ status: String) -> String {
    switch status {
    case "passed": "checkmark.circle"
    case "failed": "xmark.circle"
    case "running": "arrow.trianglehead.2.clockwise.rotate.90"
    default: "circle"
    }
  }
}
