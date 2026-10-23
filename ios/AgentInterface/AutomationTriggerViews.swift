import SwiftUI

struct HermesTriggerSection: View {
  var control: HermesAutomationControls
  var state: HermesAutomationOverview.Triggers
  var create: () -> Void
  var edit: (HermesSubscription) -> Void
  @Environment(AppStore.self) private var store
  @State private var deleting: HermesSubscription?
  private var canManage: Bool { control.value?.canManageTriggers == true }
  private var disabled: Bool { control.disabled || !store.connected || !canManage }
  @ViewBuilder var body: some View {
    if control.secret.value != nil { secretSection }
    Section("Event triggers") {
      if !state.supported {
        Text(state.reason ?? "Event triggers are unavailable on this Hermes installation.").foregroundStyle(.secondary)
      } else {
        Text("Run an existing routine when a service sends Hermes a matching event.").font(.footnote).foregroundStyle(.secondary)
        if !canManage { Text("Only an integration administrator can change event triggers.").font(.footnote) }
        if !state.platformEnabled {
          Text("The installer must enable Hermes's webhook channel before events can arrive.").font(.footnote)
        }
        if control.loadingTriggerRoutines { ProgressView("Loading profile routines") }
        if let routineError = control.triggerRoutineError {
          ErrorBanner(message: routineError)
          Button("Retry routines") { Task { await control.loadTriggerRoutines(store.api) } }.disabled(control.loadingTriggerRoutines)
        }
        if state.items.isEmpty { Text("No event triggers yet.").foregroundStyle(.secondary) }
        ForEach(state.items) { trigger in triggerRows(trigger) }
        if canManage {
          Button("New event trigger", action: create)
            .disabled(disabled || control.loadingTriggerRoutines || control.triggerRoutines.isEmpty || control.secret.value != nil)
          if !control.loadingTriggerRoutines && control.triggerRoutineError == nil && control.triggerRoutines.isEmpty {
            Text("Create a routine in this assistant's Routines settings first.").font(.footnote).foregroundStyle(.secondary)
          }
        }
      }
    }
    .confirmationDialog("Delete this event trigger?", isPresented: Binding(
      get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
        if let deleting {
          Button("Delete trigger", role: .destructive) {
            Task {
              _ = await control.changeOK(store.api, "/triggers/\(APIClient.component(deleting.id))",
                HermesRevisionInput(revision: deleting.revision), method: "DELETE")
              self.deleting = nil
            }
          }
        }
      } message: { Text("Its routine stays saved. The sending service will stop reaching this trigger.") }
  }
  private var secretSection: some View {
    Section("Save this signing secret now") {
      Text("Hermes shows it once. Configure the sending service with this URL and secret. Closing Work or leaving the app clears this display.").font(.footnote)
      if let url = control.secret.url { Text(url).font(.caption.monospaced()).textSelection(.enabled) }
      if let secret = control.secret.value {
        if control.secret.revealed {
          Text(secret).font(.body.monospaced()).textSelection(.enabled)
            .accessibilityLabel("Signing secret: \(secret)")
        } else {
          Text("Signing secret hidden").foregroundStyle(.secondary)
        }
        Button(control.secret.revealed ? "Hide secret" : "Show secret") {
          control.secret.reveal(!control.secret.revealed)
        }
        Button("I've saved it") { control.secret.clear() }
      }
    }.privacySensitive().accessibilityIdentifier("automation.signingSecret")
  }
  @ViewBuilder private func triggerRows(_ trigger: HermesSubscription) -> some View {
    DisclosureGroup(trigger.description.isEmpty ? trigger.id : trigger.description) {
      LabeledContent("Status", value: trigger.enabled ? "Enabled" : "Disabled")
      LabeledContent("Events", value: trigger.events.joined(separator: ", "))
      LabeledContent("Routine", value: control.triggerRoutines.first { $0.id == trigger.routineId }?.name ?? trigger.routineId)
      LabeledContent("Signing secret", value: trigger.secretSet ? "Configured" : "Not configured")
      Text(trigger.url).font(.caption.monospaced()).textSelection(.enabled)
      if canManage {
        Button(trigger.enabled ? "Disable trigger" : "Enable trigger") {
          Task {
            let _: HermesTriggerResult? = await control.change(store.api, "/triggers/\(APIClient.component(trigger.id))",
              HermesTriggerToggle(enabled: !trigger.enabled, revision: trigger.revision), method: "PATCH")
          }
        }.disabled(disabled || !trigger.enabled && !state.platformEnabled)
        Button("Edit trigger") { edit(trigger) }.disabled(disabled || control.loadingTriggerRoutines || control.triggerRoutineError != nil)
        Button("Delete trigger", role: .destructive) { deleting = trigger }.disabled(disabled)
      }
    }
  }
}

struct HermesTriggerEditor: View {
  var control: HermesAutomationControls
  var trigger: HermesSubscription?
  private var routines: [Routine] { control.triggerRoutines }
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var id: String
  @State private var description: String
  @State private var eventNames: String
  @State private var routineId: String
  init(control: HermesAutomationControls, trigger: HermesSubscription?) {
    self.control = control; self.trigger = trigger
    _id = State(initialValue: trigger?.id ?? "")
    _description = State(initialValue: trigger?.description ?? "")
    _eventNames = State(initialValue: trigger?.events.joined(separator: ", ") ?? "")
    _routineId = State(initialValue: trigger?.routineId ?? control.triggerRoutines.first?.id ?? "")
  }
  private var input: HermesTriggerInput {
    HermesTriggerInput(id: id, description: description,
      events: eventNames.split(separator: ",", omittingEmptySubsequences: false)
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }, routineId: routineId)
  }
  private var stale: Bool {
    guard let trigger else { return false }
    return control.value?.triggers.items.first { $0.id == trigger.id }?.revision != trigger.revision
  }
  private var disabled: Bool {
    control.disabled || !store.connected || control.value?.canManageTriggers != true || stale
  }
  var body: some View {
    NavigationStack {
      Form {
        HermesAutomationStatus(control: control)
        Section {
          if control.loadingTriggerRoutines { ProgressView("Loading profile routines") }
          if let error = control.triggerRoutineError {
            ErrorBanner(message: error)
            Button("Retry routines") { Task { await control.loadTriggerRoutines(store.api) } }
              .disabled(control.loadingTriggerRoutines)
          }
        }
        if stale {
          Section { Text("This trigger changed. Close this editor and review its current settings before editing again.").foregroundStyle(Palette.danger) }
        }
        fields.disabled(disabled)
      }.householdListBackground().accessibilityIdentifier("automation.triggerEditor").navigationTitle(trigger == nil ? "New event trigger" : "Edit event trigger")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(control.busy) }
          ToolbarItem(placement: .confirmationAction) {
            Button(trigger == nil ? "Create disabled" : "Save trigger") { save() }
              .disabled(disabled || control.loadingTriggerRoutines || !input.valid || !routines.contains { $0.id == routineId && $0.botId == control.botId })
          }
        }.interactiveDismissDisabled(control.busy)
    }
  }
  private var fields: some View {
    Section("Trigger") {
      TextField("Trigger ID", text: $id).textInputAutocapitalization(.never).autocorrectionDisabled().disabled(trigger != nil)
        .accessibilityIdentifier("automation.triggerID")
      Text("Use 1 to 80 lowercase letters, digits, underscores or hyphens. Start with a letter or digit.").font(.caption).foregroundStyle(.secondary)
      TextField("Description", text: $description, axis: .vertical).lineLimit(1...4)
      TextField("Event names, separated by commas", text: $eventNames, axis: .vertical)
        .textInputAutocapitalization(.never).autocorrectionDisabled()
      Text("Choose 1 to 20 event names, for example issue.created, issue.closed. Each name can contain letters, digits, _, ., *, : or -.")
        .font(.caption).foregroundStyle(.secondary)
      Picker("Routine", selection: $routineId) {
        Text("Choose a routine").tag("")
        if !routineId.isEmpty, !routines.contains(where: { $0.id == routineId }) {
          Text("Saved routine unavailable").tag(routineId).disabled(true)
        }
        ForEach(routines) { routine in Text(routine.name + (routine.enabled ? "" : " (paused)")).tag(routine.id) }
      }
      Text("New triggers start disabled. The selected routine must also be enabled to run.").font(.footnote)
      if description.utf16.count > 1000 { Text("Use at most 1,000 characters for the description.").foregroundStyle(Palette.danger) }
    }
  }
  private func save() {
    Task {
      let result: HermesTriggerResult?
      if let trigger {
        result = await control.change(store.api, "/triggers/\(APIClient.component(trigger.id))",
          HermesTriggerUpdate(input, revision: trigger.revision), method: "PUT")
      } else {
        result = await control.change(store.api, "/triggers", input)
      }
      if result != nil { dismiss() }
    }
  }
}
