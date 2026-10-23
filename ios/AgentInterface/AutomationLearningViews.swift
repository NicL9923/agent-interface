import SwiftUI

struct HermesLearningView: View {
  let botId: String
  @Environment(AppStore.self) private var store
  @State private var control: HermesAutomationControls
  @State private var pending: HermesPendingSkill?
  @State private var installed: HermesInstalledSkill?
  @State private var allowingWrites = false
  init(botId: String) {
    self.botId = botId
    _control = State(initialValue: HermesAutomationControls(botId: botId))
  }
  var body: some View {
    Form {
      HermesAutomationStatus(control: control)
      if let state = control.value?.skills {
        if !state.supported {
          Section { Text(state.reason ?? "Learning review is unavailable on this Hermes installation.").foregroundStyle(.secondary) }
        } else {
          policy(state)
          pendingChanges(state)
          installedSkills(state)
        }
      }
    }.householdListBackground().accessibilityIdentifier("automation.learning")
      .task { control.appear(foreground: false); await control.refresh(store.api) }
      .onDisappear { control.disappear() }
      .sheet(item: $pending) { item in HermesSkillReview(control: control, pending: item) }
      .sheet(item: $installed) { item in HermesSkillReader(control: control, skill: item) }
      .confirmationDialog("Allow skill changes without review?", isPresented: $allowingWrites, titleVisibility: .visible) {
        Button("Allow changes without review", role: .destructive) { setPolicy(false) }
      } message: { Text("Hermes can save new skills, edits and deletions without asking for approval.") }
  }
  private func policy(_ state: HermesAutomationOverview.Skills) -> some View {
    Section("Skill write policy") {
      Toggle("Require approval before skill changes are saved", isOn: Binding(
        get: { state.approvalRequired }, set: { enabled in
          if enabled { setPolicy(true) } else { allowingWrites = true }
        }))
        .disabled(control.disabled || !store.connected || control.value?.canManageLearningPolicy == false)
        .accessibilityIdentifier("automation.learningPolicy")
      if control.value?.canManageLearningPolicy == false {
        Text("Only an integration administrator can change the skill write policy.").font(.footnote).foregroundStyle(.secondary)
      }
      Text("When enabled, Hermes stages new skills, edits and deletions for review.").font(.footnote).foregroundStyle(.secondary)
    }
  }
  private func pendingChanges(_ state: HermesAutomationOverview.Skills) -> some View {
    Section("Pending changes") {
      if state.pending.isEmpty { Text("No skill changes waiting for review.").foregroundStyle(.secondary) }
      ForEach(state.pending) { item in
        Button { pending = item } label: {
          VStack(alignment: .leading, spacing: 4) {
            Text(item.summary.isEmpty ? item.id : item.summary).foregroundStyle(Color.primary)
            Text(item.origin).font(.caption).foregroundStyle(.secondary)
            Text("Review change").font(.subheadline)
          }.padding(.vertical, 4)
        }.disabled(control.busy).accessibilityIdentifier("automation.pendingSkill.\(item.id)")
      }
    }
  }
  private func installedSkills(_ state: HermesAutomationOverview.Skills) -> some View {
    Section("Installed skills") {
      if state.installed.isEmpty { Text("No installed skills reported.").foregroundStyle(.secondary) }
      ForEach(state.installed) { item in
        Button { installed = item } label: {
          VStack(alignment: .leading, spacing: 4) {
            Text(item.name).foregroundStyle(Color.primary)
            if !item.description.isEmpty { Text(item.description).font(.caption).foregroundStyle(.secondary) }
            Text("Read skill").font(.subheadline)
          }.padding(.vertical, 4)
        }.disabled(control.busy).accessibilityIdentifier("automation.installedSkill.\(item.id)")
      }
    }
  }
  private func setPolicy(_ required: Bool) {
    Task { _ = await control.changeOK(store.api, "/skills/policy", HermesPolicyInput(approvalRequired: required), method: "PUT") }
  }
}

private struct HermesSkillReader: View {
  var control: HermesAutomationControls
  var skill: HermesInstalledSkill
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var value: HermesSkillContent?
  @State private var loading = false
  @State private var error: String?
  var body: some View {
    NavigationStack {
      Form {
        Section {
          Text(skill.name).font(.headline)
          if !skill.description.isEmpty { Text(skill.description).font(.footnote) }
          if loading { ProgressView("Loading skill content") }
          if let error { ErrorBanner(message: error) }
          Button("Reload skill") { Task { await load() } }.disabled(loading)
        }
        if let value {
          Section("Skill content") {
            HermesAutomationDocument(text: value.content.isEmpty ? "This skill has no content." : value.content)
            if value.truncated { Text("Preview truncated. Open Hermes for the full skill.").foregroundStyle(Palette.danger) }
          }
        }
      }.householdListBackground().navigationTitle("Installed skill").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        .task { await load() }
    }
  }
  @MainActor private func load() async {
    guard let api = store.api, !loading else { return }
    loading = true; error = nil; value = nil
    let scope = store.scope
    defer { loading = false }
    do {
      let next: HermesSkillContent = try await api.get(control.path + "/skills/content?name=\(APIClient.component(skill.name))")
      guard !Task.isCancelled, scope == store.scope else { return }
      guard next.name == skill.name else { throw APIError(message: "The returned skill did not match this request.", status: 502) }
      value = next
    } catch {
      if !Task.isCancelled, scope == store.scope { self.error = error.localizedDescription }
    }
  }
}

private struct HermesSkillReview: View {
  var control: HermesAutomationControls
  var pending: HermesPendingSkill
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var value: HermesSkillDiff?
  @State private var loading = false
  @State private var error: String?
  @State private var needsReload = false
  private var available: Bool { control.value?.skills.pending.contains { $0.id == pending.id } == true }
  private var disabled: Bool { control.disabled || !store.connected || loading || needsReload || !available }
  var body: some View {
    NavigationStack {
      Form {
        HermesAutomationStatus(control: control)
        Section {
          Text(pending.summary.isEmpty ? pending.id : pending.summary).font(.headline)
          Text(pending.origin).font(.caption).foregroundStyle(.secondary)
          if loading { ProgressView("Loading pending diff") }
          if let error { ErrorBanner(message: error) }
          if !available { Text("This change is no longer pending. Refresh status to check the current list.").foregroundStyle(.secondary) }
          if needsReload { Text("Reload and review the current diff before making another decision.").font(.footnote) }
          Button("Reload diff") { Task { await load() } }.disabled(loading || control.busy || !available)
        }
        if let value { diffSection(value) }
      }.householdListBackground().navigationTitle("Review skill change").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() }.disabled(control.busy) } }
        .interactiveDismissDisabled(control.busy).task { await load() }
    }
  }
  private func diffSection(_ value: HermesSkillDiff) -> some View {
    Section("Pending diff") {
      HermesAutomationDocument(text: value.diff.isEmpty ? "No textual diff." : value.diff)
      if value.truncated {
        Text("The diff is truncated. Review the full change in Hermes before approving.").foregroundStyle(Palette.danger)
      }
      Button("Approve change") { decide(.approve) }
        .disabled(disabled || value.truncated)
        .accessibilityIdentifier("automation.approveSkill")
      Button("Reject change", role: .destructive) { decide(.reject) }.disabled(disabled)
    }
  }
  @MainActor private func load() async {
    guard let api = store.api, !loading else { return }
    loading = true; error = nil; value = nil; needsReload = true
    let scope = store.scope
    defer { loading = false }
    do {
      let next: HermesSkillDiff = try await api.get(control.path + "/skills/pending/\(APIClient.component(pending.id))")
      guard !Task.isCancelled, scope == store.scope else { return }
      guard next.id == pending.id else { throw APIError(message: "The returned diff did not match this request.", status: 502) }
      value = next; needsReload = false
    } catch {
      if !Task.isCancelled, scope == store.scope { self.error = error.localizedDescription }
    }
  }
  private func decide(_ choice: HermesSkillDecision.Choice) {
    guard !disabled, let value, let input = value.decision(choice) else { return }
    Task {
      if await control.changeOK(store.api, "/skills/pending/\(APIClient.component(value.id))", input) { dismiss() }
      else { needsReload = true }
    }
  }
}

private struct HermesAutomationDocument: View {
  var text: String
  var body: some View {
    ScrollView(.horizontal) {
      Text(text).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
    }.accessibilityIdentifier("automation.document")
  }
}
