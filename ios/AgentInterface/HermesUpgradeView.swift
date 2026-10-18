import SwiftUI

struct HermesUpgradeView: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.scenePhase) private var scenePhase
  @State private var confirmedRevision: String?
  @State private var showInstallConfirmation = false
  @State private var recoveryAction: String?
  /// The operation on screen when the confirmation opened. Confirming acts on it alone, so a newer
  /// operation started elsewhere meanwhile is never cancelled or restarted by mistake.
  @State private var recoveryOperation: String?
  @State private var showRecoveryConfirmation = false
  @State private var detailsExpanded = false
  private var status: UpgradeStatus? { store.upgradeStatus }
  /// Everything that must not be tapped while a request or recovery is unresolved.
  private var locked: Bool { store.upgradeBusy || store.sessionExpired || store.upgradeInstallUncertain }
  var body: some View {
    Form {
      summarySection
      actionSection
      recoverySection
      errorSection
      detailsSection
    }.navigationTitle("Hermes updates").navigationBarTitleDisplayMode(.inline)
      .task(id: status?.inProgress == true) {
        await store.refreshUpgrade()
        while !Task.isCancelled {
          do {
            try await Task.sleep(for: .seconds(store.upgradeStatus?.inProgress == true ? 2 : 15))
          } catch { return }
          if scenePhase == .active { await store.refreshUpgrade() }
        }
      }
      .onChange(of: status?.stopped == true, initial: true) { _, stopped in if stopped { detailsExpanded = true } }
      .refreshable { await store.refreshUpgrade() }
      .confirmationDialog("Update the household's Hermes installation?", isPresented: $showInstallConfirmation, titleVisibility: .visible) {
        Button("Install update") {
          guard let revision = confirmedRevision else { return }
          Task { await store.installUpgrade(candidateRevision: revision) }
        }
      } message: {
        Text("The server will update and verify Hermes. If verification fails, it will try to restore the previous version.")
      }
      .confirmationDialog(
        recoveryAction == "cancel" ? "Cancel this update and restore a working version?"
          : "Restart the Hermes service and check the connection? This may briefly disconnect everyone.",
        isPresented: $showRecoveryConfirmation, titleVisibility: .visible
      ) {
        Button(recoveryAction == "cancel" ? "Yes, cancel update" : "Yes, restart Hermes", role: recoveryAction == "cancel" ? .destructive : nil) {
          guard let action = recoveryAction, let operationId = recoveryOperation else { return }
          Task { await store.controlUpgrade(action, operationId: operationId) }
        }
        Button("Keep current state", role: .cancel) {}
      }
  }

  // MARK: Sections

  private var summarySection: some View {
    Section {
      VStack(alignment: .leading, spacing: 12) {
        Label(status?.title ?? "Hermes updates", systemImage: statusSymbol)
          .font(.title3.bold()).accessibilityAddTraits(.isHeader)
        Text(status?.description(loading: store.upgradeBusy) ?? placeholder).foregroundStyle(.secondary)
        if store.upgradeSubmitting || store.upgradeInstallUncertain || status?.inProgress == true {
          ProgressView().accessibilityLabel(status?.title ?? "Working")
        }
      }.padding(.vertical, 8)
      if let status, status.phase != "idle" { stepList(status) }
      LabeledContent("Running now", value: status?.current?.displayVersion ?? store.bootstrap?.connection.version ?? "Checking…")
      if let candidate = status?.candidate {
        LabeledContent(status?.phase == "ready" ? "Checked update" : "Update", value: candidate.displayVersion)
        if let notes = candidate.notesUrl, let url = URL(string: notes), url.scheme == "https" {
          Link("What's new", destination: url)
        }
      }
      if let status, !status.busyBots.isEmpty { Text(busyMessage(status)).foregroundStyle(Palette.attention) }
    }
  }
  private var placeholder: String {
    store.upgradeBusy ? "Getting the current version and update status…" : "Find the newest Hermes and test it before installing it."
  }
  private func busyMessage(_ status: UpgradeStatus) -> String {
    let names = status.busyBots.map { id in store.bootstrap?.bots.first { $0.id == id }?.name ?? id }
    return "Finish active work before upgrading: \(names.joined(separator: ", "))."
  }
  private func stepList(_ status: UpgradeStatus) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(status.steps, id: \.name) { step in
        Label(step.name, systemImage: stepSymbol(step.state))
          .foregroundStyle(step.state == .failed ? Color.red : Color.primary)
          .accessibilityElement(children: .ignore)
          .accessibilityLabel("\(step.name): \(stepSpoken(step.state))")
          .accessibilityIdentifier("upgradeStep.\(step.name)")
      }
    }.padding(.vertical, 4)
  }
  private var actionSection: some View {
    Section {
      Button {
        guard let status else { return }
        if status.installsNext, let candidate = status.candidate {
          confirmedRevision = candidate.revision
          showInstallConfirmation = true
        } else {
          Task { await store.checkUpgrade() }
        }
      } label: {
        HStack {
          Text(status?.actionLabel(submitting: store.upgradeSubmitting, uncertain: store.upgradeInstallUncertain) ?? "Check for an update")
          Spacer()
          if store.upgradeSubmitting || status?.inProgress == true { ProgressView() }
        }
      }.disabled(primaryDisabled)
        .accessibilityIdentifier(status?.installsNext == true ? "installHermesUpdate" : "checkHermesUpdate")
      if let status, status.canStopCheck {
        Button("Stop checking") { control("cancel") }
          .disabled(locked).accessibilityIdentifier("stopHermesCheck")
      }
    } footer: {
      Text(status?.actionHint(uncertain: store.upgradeInstallUncertain)
        ?? "A check finds the newest Hermes and tests it in a separate copy. Nothing is installed until you choose Install.")
    }
  }
  private var primaryDisabled: Bool {
    guard let status else { return true }
    return locked || status.inProgress || !status.available || !(status.installsNext ? status.canInstall : status.canCheck)
  }
  @ViewBuilder private var recoverySection: some View {
    if let status, status.showsRecovery {
      Section {
        if status.canRetry == true && status.isInstall {
          Button("Check and try again") { control("retry") }.accessibilityIdentifier("retryHermesUpdate")
        }
        if status.canRestartService == true {
          Button("Restart Hermes") { confirm("restart_service") }.accessibilityIdentifier("restartHermesService")
        }
        if status.canCancel == true && status.isInstall {
          Button("Cancel update", role: .destructive) { confirm("cancel") }.accessibilityIdentifier("cancelHermesUpdate")
        }
      } header: { Text(status.inProgress ? "Need to stop this update?" : "Get back on track") } footer: {
        Text(status.inProgress ? "Cancellation waits for a safe stopping point and checks the previous version."
          : "Recovery checks the connection before assistants can work again.")
      }.disabled(locked)
    }
  }
  @ViewBuilder private var errorSection: some View {
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
  }
  @ViewBuilder private var detailsSection: some View {
    if let status, !status.checks.isEmpty {
      Section {
        DisclosureGroup(isExpanded: $detailsExpanded) {
          ForEach(status.checks) { check in
            VStack(alignment: .leading, spacing: 4) {
              Label(check.label, systemImage: checkSymbol(check.status))
              Text(check.summary).font(.caption).foregroundStyle(.secondary)
            }.padding(.vertical, 4)
          }
          if let reference = status.error {
            Text("Update reference: \(reference)").font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
          }
        } label: {
          HStack {
            Text("Test details")
            Spacer()
            Text("\(status.checksPassed) of \(status.checks.count) passed").font(.caption).foregroundStyle(.secondary)
          }
        }.accessibilityIdentifier("upgradeTestDetails")
      } footer: {
        if let checked = status.checkedAt, let date = ServerDate.parse(checked) {
          Text("Last checked \(date.formatted(date: .abbreviated, time: .shortened))")
        }
      }
    }
  }

  // MARK: Actions and symbols

  private func confirm(_ action: String) {
    recoveryAction = action
    recoveryOperation = status?.operationId
    showRecoveryConfirmation = recoveryOperation != nil
  }
  private func control(_ action: String) {
    guard let operationId = status?.operationId else { return }
    Task { await store.controlUpgrade(action, operationId: operationId) }
  }
  private var statusSymbol: String {
    switch status?.phase {
    case "succeeded": "checkmark.circle"
    case "rolled_back": "arrow.uturn.backward.circle"
    case "failed", "blocked": "exclamationmark.circle"
    default: "arrow.down.circle"
    }
  }
  private func stepSymbol(_ state: UpgradeStatus.StepState) -> String {
    switch state {
    case .done: "checkmark.circle.fill"
    case .active: "arrow.trianglehead.2.clockwise.rotate.90.circle"
    case .failed: "exclamationmark.circle.fill"
    case .waiting: "circle"
    }
  }
  private func stepSpoken(_ state: UpgradeStatus.StepState) -> String {
    switch state {
    case .done: "done"
    case .active: "in progress"
    case .failed: "stopped"
    case .waiting: "not started"
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
