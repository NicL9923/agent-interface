import SwiftUI

/// Button tasks outlive SwiftUI's `.task`. Capture this predicate before starting either kind
/// of request, so closing and reopening a sheet cannot revive an earlier response.
@MainActor @Observable final class HermesAutomationLifetime {
  private var visible = true
  private var generation = UUID()
  func appear() { visible = true }
  func disappear() { visible = false; generation = UUID() }
  var current: @MainActor () -> Bool {
    let started = generation
    return { self.visible && self.generation == started && !Task.isCancelled }
  }
}

@MainActor @Observable final class HermesLearningLoader<Value> {
  var value: Value?
  var loading = false
  var error: String?
  var needsReload = true
  let lifetime = HermesAutomationLifetime()

  func load(
    _ store: AppStore, control: HermesAutomationControls, suffix: String,
    validate: @MainActor (Value) throws -> Void
  ) async where Value: Decodable & SendableMetatype {
    let current = lifetime.current
    guard !loading, current(), control.isCurrent(store) else { return }
    loading = true; error = nil; value = nil; needsReload = true
    defer { loading = false }
    let outcome = await control.attempt(store, current: current) { context -> Value in
      let next: Value = try await context.api.get(control.path + suffix)
      try validate(next)
      return next
    }
    switch outcome {
    case .success(let next)?: value = next; needsReload = false
    case .failure(let error)?: self.error = error.localizedDescription
    case nil: break
    }
  }
}

private func hermesSkillSource(_ origin: String) -> String {
  "Source: " + (origin.isEmpty ? "Not reported" : origin.prefix(1).uppercased() + String(origin.dropFirst()))
}

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
      Text("Inspect reusable instructions and review changes the assistant wants to save.")
        .font(.subheadline).foregroundStyle(Palette.muted).listRowBackground(Color.clear)
      HermesAutomationStatus(control: control)
      if let state = control.value?.skills {
        if !state.supported {
          Section { Text(state.reason ?? "Learning review is unavailable on this Hermes installation.").foregroundStyle(Palette.muted) }
        } else {
          policy(state)
          pendingChanges(state)
          installedSkills(state)
        }
      }
    }.householdListBackground().accessibilityIdentifier("automation.learning")
      .task { control.appear(foreground: false); await control.refresh(store) }
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
        Text("Only an integration administrator can change the skill write policy.").font(.footnote).foregroundStyle(Palette.muted)
      }
      Text("When enabled, Hermes stages new skills, edits and deletions for review.").font(.footnote).foregroundStyle(Palette.muted)
    }
  }
  private func pendingChanges(_ state: HermesAutomationOverview.Skills) -> some View {
    Section("Pending changes (\(state.pending.count))") {
      if state.pending.isEmpty { Text("No skill changes waiting for review.").foregroundStyle(Palette.muted) }
      ForEach(state.pending) { item in
        Button { pending = item } label: {
          VStack(alignment: .leading, spacing: 4) {
            Text(item.summary.isEmpty ? item.id : item.summary).foregroundStyle(Color.primary)
            Text(hermesSkillSource(item.origin)).font(.caption).foregroundStyle(Palette.muted)
            Text("Review change").font(.subheadline)
          }.padding(.vertical, 4)
        }.disabled(control.busy).accessibilityIdentifier("automation.pendingSkill.\(item.id)")
      }
    }
  }
  private func installedSkills(_ state: HermesAutomationOverview.Skills) -> some View {
    Section("Installed skills") {
      if state.installed.isEmpty { Text("No installed skills reported.").foregroundStyle(Palette.muted) }
      ForEach(state.installed) { item in
        Button { installed = item } label: {
          VStack(alignment: .leading, spacing: 4) {
            Text(item.name).foregroundStyle(Color.primary)
            if !item.description.isEmpty { Text(item.description).font(.caption).foregroundStyle(Palette.muted) }
            Text("Read skill").font(.subheadline)
          }.padding(.vertical, 4)
        }.disabled(control.busy).accessibilityIdentifier("automation.installedSkill.\(item.id)")
      }
    }
  }
  private func setPolicy(_ required: Bool) {
    Task { _ = await control.changeOK(store, "/skills/policy", HermesPolicyInput(approvalRequired: required), method: "PUT") }
  }
}

private struct HermesSkillReader: View {
  var control: HermesAutomationControls
  var skill: HermesInstalledSkill
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var loader = HermesLearningLoader<HermesSkillContent>()
  var body: some View {
    NavigationStack {
      Form {
        Section {
          Text(skill.name).font(.headline)
          if !skill.description.isEmpty { Text(skill.description).font(.footnote) }
          if loader.loading { ProgressView("Loading skill content") }
          if let error = loader.error { ErrorBanner(message: error) }
          Button("Reload skill") { Task { await load() } }.disabled(loader.loading)
        }
        if let value = loader.value {
          Section("Skill content") {
            HermesAutomationDocument(text: value.content.isEmpty ? "This skill has no content." : value.content)
            if value.truncated { Text("Preview truncated. Open Hermes for the full skill.").foregroundStyle(Palette.danger) }
          }
        }
      }.householdListBackground().navigationTitle("Installed skill").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        .task { loader.lifetime.appear(); await load() }
        .onDisappear { loader.lifetime.disappear() }
    }
  }
  @MainActor private func load() async {
    await loader.load(store, control: control, suffix: "/skills/content?name=\(APIClient.component(skill.name))") { next in
      guard next.name == skill.name else { throw APIError(message: "The returned skill did not match this request.", status: 502) }
    }
  }
}

private struct HermesSkillReview: View {
  var control: HermesAutomationControls
  var pending: HermesPendingSkill
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var loader = HermesLearningLoader<HermesSkillDiff>()
  private var available: Bool { control.value?.skills.pending.contains { $0.id == pending.id } == true }
  private var disabled: Bool { control.disabled || !store.connected || loader.loading || loader.needsReload || !available }
  var body: some View {
    NavigationStack {
      Form {
        HermesAutomationStatus(control: control)
        Section {
          Text(pending.summary.isEmpty ? pending.id : pending.summary).font(.headline)
          Text(hermesSkillSource(pending.origin)).font(.caption).foregroundStyle(Palette.muted)
          if loader.loading { ProgressView("Loading pending diff") }
          if let error = loader.error { ErrorBanner(message: error) }
          if !available { Text("This change is no longer pending. Refresh status to check the current list.").foregroundStyle(.secondary) }
          if loader.needsReload { Text("Reload and review the current diff before making another decision.").font(.footnote) }
          Button("Reload diff") { Task { await load() } }.disabled(loader.loading || control.busy || !available)
        }
        if let value = loader.value { diffSection(value) }
      }.householdListBackground().navigationTitle("Review skill change").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() }.disabled(control.busy) } }
        .interactiveDismissDisabled(control.busy).task { loader.lifetime.appear(); await load() }
        .onDisappear { loader.lifetime.disappear() }
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
    await loader.load(store, control: control, suffix: "/skills/pending/\(APIClient.component(pending.id))") { next in
      guard next.id == pending.id else { throw APIError(message: "The returned diff did not match this request.", status: 502) }
    }
  }
  private func decide(_ choice: HermesSkillDecision.Choice) {
    guard !disabled, let value = loader.value, let input = value.decision(choice) else { return }
    let current = loader.lifetime.current
    Task {
      let changed = await control.changeOK(store, "/skills/pending/\(APIClient.component(value.id))", input, current: current)
      guard current(), control.isCurrent(store) else { return }
      if changed { dismiss() } else { loader.needsReload = true }
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
