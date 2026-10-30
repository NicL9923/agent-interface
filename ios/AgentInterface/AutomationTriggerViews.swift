import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// An injectable writer keeps clipboard behavior testable without reading the pasteboard.
struct HermesTriggerPasteboard {
  var write: (String, [UIPasteboard.OptionsKey: Any]) -> Void
  static var system: HermesTriggerPasteboard { HermesTriggerPasteboard { value, options in
    #if DEBUG
    if ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_DESIGN_FIXTURE"] != nil { return }
    #endif
    UIPasteboard.general.setItems([[UTType.utf8PlainText.identifier: value]], options: options)
  } }
  func copyURL(_ value: String) { write(value, [:]) }
  func copySecret(_ value: String, now: Date = Date()) {
    write(value, [.localOnly: true, .expirationDate: now.addingTimeInterval(300)])
  }
}

struct HermesUnhyphenatedText: UIViewRepresentable {
  var value: String
  var label: String
  var textStyle: UIFont.TextStyle = .body
  var selectable: Bool
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  init(value: String, label: String, textStyle: UIFont.TextStyle = .body, selectable: Bool = true) {
    self.value = value; self.label = label; self.textStyle = textStyle; self.selectable = selectable
  }
  func makeUIView(context: Context) -> UITextView {
    let view = UITextView()
    view.isEditable = false; view.isSelectable = selectable; view.isScrollEnabled = false
    view.isAccessibilityElement = true
    view.backgroundColor = .clear; view.textContainerInset = .zero
    view.textContainer.lineFragmentPadding = 0
    view.textContainer.lineBreakMode = .byCharWrapping
    view.adjustsFontForContentSizeCategory = true
    return view
  }
  func updateUIView(_ view: UITextView, context: Context) {
    _ = dynamicTypeSize
    view.isSelectable = selectable
    let style = NSMutableParagraphStyle(); style.lineBreakMode = .byCharWrapping; style.hyphenationFactor = 0
    let base = UIFont.monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: textStyle).pointSize, weight: .regular)
    view.attributedText = NSAttributedString(string: value, attributes: [.font: base, .paragraphStyle: style, .foregroundColor: UIColor(Palette.muted)])
    view.accessibilityLabel = label
  }
  func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
    guard let width = proposal.width else { return nil }
    return uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
  }
}

struct HermesTriggerSection: View {
  var control: HermesAutomationControls
  var state: HermesAutomationOverview.Triggers
  @Binding var expanded: Set<String>
  var create: () -> Void
  var edit: (HermesSubscription) -> Void
  var delete: (HermesSubscription) -> Void
  var pasteboard = HermesTriggerPasteboard.system
  @Environment(AppStore.self) private var store
  @State private var copyFeedback: String?
  private var canManage: Bool { control.value?.canManageTriggers == true }
  private var disabled: Bool { control.disabled || !store.connected || !canManage }
  @ViewBuilder var body: some View {
    if control.secret.value != nil { secretSection }
    Section {
      if let feedback = control.triggerFeedback, feedback.action == "delete" {
        Text(feedback.message).foregroundStyle(feedback.isError ? Palette.danger : Palette.muted)
          .accessibilityIdentifier("automation.triggerFeedback.deleted")
      }
      if !state.supported {
        Text(state.reason ?? "Event triggers are unavailable on this Hermes installation.").foregroundStyle(Palette.muted)
      } else {
        Text("Run an existing routine when a service sends Hermes a matching event.").font(.footnote).foregroundStyle(Palette.muted)
        if !canManage { Text("Only an integration administrator can change event triggers.").font(.footnote).foregroundStyle(Palette.muted) }
        if !state.platformEnabled { Text("The installer must enable Hermes's webhook channel before events can arrive.").font(.footnote).foregroundStyle(Palette.muted) }
        if control.loadingTriggerRoutines { ProgressView("Loading profile routines") }
        if let routineError = control.triggerRoutineError {
          ErrorBanner(message: routineError)
          Button("Retry routines") { Task { await control.loadTriggerRoutines(store) } }.disabled(control.loadingTriggerRoutines)
        }
        if state.items.isEmpty { Text("No event triggers yet.").foregroundStyle(Palette.muted) }
        ForEach(state.items) { trigger in triggerRows(trigger) }
        if canManage {
          Button("New event trigger", action: create)
            .disabled(disabled || control.loadingTriggerRoutines || control.triggerRoutines.isEmpty || control.secret.value != nil)
          if !control.loadingTriggerRoutines && control.triggerRoutineError == nil && control.triggerRoutines.isEmpty {
            Text("Create a routine in this assistant's Routines settings first.").font(.footnote).foregroundStyle(Palette.muted)
          }
        }
      }
    } header: { Text("Event triggers").foregroundStyle(Palette.muted) }
    .onChange(of: control.triggerFeedback?.message) { _, _ in
      if let feedback = control.triggerFeedback, feedback.action != "delete" { expanded.insert(feedback.id) }
    }
    .onChange(of: control.secret.triggerId) { _, _ in copyFeedback = nil }
  }
  private func copied(_ message: String) { copyFeedback = message; AccessibilityNotification.Announcement(message).post() }
  private var secretSection: some View {
    Section {
      VStack(alignment: .leading, spacing: 8) {
        Text("Save this signing secret now").font(.headline).accessibilityAddTraits(.isHeader)
        if let triggerId = control.secret.triggerId { Text("\(triggerId) was created and starts disabled.").font(.subheadline).foregroundStyle(Palette.muted) }
      }.id("automation.signingSecret")
      Text("Hermes shows it once. Configure the sending service with this URL and secret. Closing Work or leaving the app clears this display.").font(.footnote).foregroundStyle(Palette.muted)
      if let url = control.secret.url {
        VStack(alignment: .leading, spacing: 6) {
          Text("Webhook URL").font(.subheadline).foregroundStyle(Palette.muted)
          HermesUnhyphenatedText(value: url, label: "New trigger webhook URL: \(url)", textStyle: .caption1)
        }
        Button("Copy URL") { pasteboard.copyURL(url); copied("URL copied.") }
      }
      if let secret = control.secret.value {
        VStack(alignment: .leading, spacing: 6) {
          Text("Signing secret").font(.subheadline).foregroundStyle(Palette.muted)
          if control.secret.revealed { HermesUnhyphenatedText(value: secret, label: "Signing secret: \(secret)", selectable: false) }
          else { Text("Hidden").foregroundStyle(Palette.muted) }
        }
        Button(control.secret.revealed ? "Hide secret" : "Show secret") { control.secret.reveal(!control.secret.revealed) }
        Button("Copy secret") { pasteboard.copySecret(secret); control.secret.markCopied(); copied("Copied. The clipboard clears it in 5 minutes.") }
        if let copyFeedback { Text(copyFeedback).font(.footnote).foregroundStyle(Palette.muted) }
        VStack(alignment: .leading, spacing: 6) {
          Button("I've saved it") {
            let triggerId = control.secret.triggerId
            control.secret.clear()
            copyFeedback = nil
            if let triggerId { expanded.insert(triggerId); AccessibilityNotification.Announcement("\(triggerId) was created and starts disabled.").post() }
          }.disabled(!control.secret.inspected)
          if !control.secret.inspected { Text("Copy or show the secret first.").font(.footnote).foregroundStyle(Palette.muted) }
        }
      }
    }
      .privacySensitive().accessibilityIdentifier("automation.signingSecret")
      .onAppear { AccessibilityNotification.Announcement("Save this signing secret now. Hermes shows it once.").post() }
  }
  @ViewBuilder private func triggerRows(_ trigger: HermesSubscription) -> some View {
    let routine = control.triggerRoutines.first { $0.id == trigger.routineId }
    let missing = !control.loadingTriggerRoutines && control.triggerRoutineError == nil && routine == nil
    DisclosureGroup(isExpanded: Binding(get: { expanded.contains(trigger.id) }, set: { if $0 { expanded.insert(trigger.id) } else { expanded.remove(trigger.id) } })) {
      LabeledContent("Status") { Text(trigger.enabled ? "Enabled" : "Disabled").foregroundStyle(Palette.muted) }
      LabeledContent("Events") { Text(trigger.events.joined(separator: ", ")).foregroundStyle(Palette.muted) }
      LabeledContent("Routine") { Text(routine?.name ?? trigger.routineId).foregroundStyle(Palette.muted) }
      LabeledContent("Signing secret") { Text(trigger.secretSet ? "Configured" : "Not configured").foregroundStyle(Palette.muted) }
      Text("Webhook URL").font(.caption).foregroundStyle(Palette.muted)
      HermesUnhyphenatedText(value: trigger.url, label: "Webhook URL: \(trigger.url)", textStyle: .caption1)
      if canManage {
        Button(trigger.enabled ? "Disable trigger" : "Enable trigger") {
          Task { let _: HermesTriggerResult? = await control.changeTrigger(store, triggerId: trigger.id, "/triggers/\(APIClient.component(trigger.id))", HermesTriggerToggle(enabled: !trigger.enabled, revision: trigger.revision), method: "PATCH", action: trigger.enabled ? "disable" : "enable") }
        }.disabled(disabled || !trigger.enabled && (!state.platformEnabled || missing || control.loadingTriggerRoutines || control.triggerRoutineError != nil))
        Button("Edit trigger") { edit(trigger) }.disabled(disabled || control.loadingTriggerRoutines || control.triggerRoutineError != nil)
        Button("Delete trigger…", role: .destructive) { delete(trigger) }.disabled(disabled)
        if !trigger.enabled && !state.platformEnabled { Text("Can't enable until the installer turns on Hermes's webhook channel.").font(.footnote).foregroundStyle(Palette.muted) }
        if !trigger.enabled && missing { Text("Its routine is no longer available. Edit the trigger to choose another routine before enabling it.").font(.footnote).foregroundStyle(Palette.muted) }
        if !trigger.enabled && control.loadingTriggerRoutines { Text("Routines are still loading.").font(.footnote).foregroundStyle(Palette.muted) }
        if !trigger.enabled && control.triggerRoutineError != nil { Text("Routines couldn't load. Retry routines before enabling this trigger.").font(.footnote).foregroundStyle(Palette.muted) }
      }
      if let feedback = control.triggerFeedback, feedback.id == trigger.id, feedback.action != "delete" {
        Text(feedback.message).foregroundStyle(feedback.isError ? Palette.danger : Palette.muted).accessibilityIdentifier("automation.triggerFeedback.\(trigger.id)")
      }
    } label: {
      VStack(alignment: .leading, spacing: 3) {
        Text(trigger.description.isEmpty ? trigger.id : trigger.description)
        Text(hermesTriggerSubtitle(trigger, routines: control.triggerRoutines, loading: control.loadingTriggerRoutines, error: control.triggerRoutineError)).font(.caption).foregroundStyle(Palette.muted)
      }.accessibilityElement(children: .combine)
    }.accessibilityIdentifier("automation.trigger.\(trigger.id)")
  }
}

struct HermesTriggerEditor: View {
  var control: HermesAutomationControls
  var trigger: HermesSubscription?
  var reveal: (String) -> Void = { _ in }
  private var routines: [Routine] { control.triggerRoutines }
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @State private var lifetime = HermesAutomationLifetime()
  @State private var id: String
  @State private var description: String
  @State private var eventNames: String
  @State private var routineId: String
  @State private var knownIds: Set<String> = []
  @State private var submittedId = ""
  @State private var uncertain = false
  @FocusState private var focused: Field?
  private enum Field { case id, description, events }
  init(control: HermesAutomationControls, trigger: HermesSubscription?, reveal: @escaping (String) -> Void = { _ in }) {
    self.control = control; self.trigger = trigger; self.reveal = reveal
    _id = State(initialValue: trigger?.id ?? "")
    _description = State(initialValue: trigger?.description ?? "")
    _eventNames = State(initialValue: trigger?.events.joined(separator: ", ") ?? "")
    _routineId = State(initialValue: trigger?.routineId ?? control.triggerRoutines.first?.id ?? "")
  }
  private var input: HermesTriggerInput { HermesTriggerInput(id: id, description: description, events: eventNames.split(separator: ",", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }, routineId: routineId) }
  private var live: HermesSubscription? { trigger.flatMap { original in control.value?.triggers.items.first { $0.id == original.id } } }
  private var stale: Bool { trigger != nil && live?.revision != trigger?.revision }
  private var likely: HermesSubscription? {
    guard uncertain && !control.needsRefresh && !control.loading else { return nil }
    return hermesLikelyCreatedTrigger(knownIds, submittedId, control.value?.triggers.items ?? [])
  }
  private var disabled: Bool { control.disabled || !store.connected || control.value?.canManageTriggers != true || stale }
  var body: some View {
    NavigationStack {
      Form {
        HermesAutomationStatus(control: control, compact: true, suppressRefreshFootnote: true)
        if trigger != nil && !control.needsRefresh && control.error == nil {
          Section { Button("Refresh status") { Task { await control.manualRefresh(store) } }
            .disabled(control.busy || control.loading).accessibilityIdentifier("automation.refresh") }
        }
        if let feedback = control.triggerFeedback, feedback.id == (trigger?.id ?? submittedId), feedback.action == (trigger == nil ? "create" : "edit"), likely == nil, !(uncertain && !control.needsRefresh) {
          Section { Text(feedback.message).foregroundStyle(feedback.isError ? Palette.danger : Palette.muted) }
        }
        if let likely {
          Section { Text("\(likely.id) is now in Hermes. This request probably created it, but this app never received its signing secret. To get a secret, delete \(likely.id) and create it again.") }
        } else if uncertain && !control.needsRefresh && !control.loading {
          Section { Text("No trigger with this ID is in Hermes. Create trigger sends the same request again.").foregroundStyle(Palette.muted) }
        }
        if control.loadingTriggerRoutines || control.triggerRoutineError != nil {
          Section {
            if control.loadingTriggerRoutines { ProgressView("Loading profile routines") }
            if let error = control.triggerRoutineError { ErrorBanner(message: error); Button("Retry routines") { Task { await control.loadTriggerRoutines(store) } }.disabled(control.loadingTriggerRoutines) }
          }
        }
        if stale { Section { Text(live == nil ? "This trigger is no longer in Hermes." : "This trigger changed. Close this editor and review its current settings before editing again.").foregroundStyle(Palette.danger) } }
        fields.disabled(disabled || likely != nil || uncertain)
      }.householdListBackground().accessibilityIdentifier("automation.triggerEditor").navigationTitle(trigger == nil ? "New trigger" : "Edit trigger")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(control.busy) }
          ToolbarItem(placement: .confirmationAction) {
            if control.busy { ProgressView { Text(trigger == nil ? "Creating" : "Saving").foregroundStyle(Palette.muted) } }
            else { Button(likely != nil ? "Close" : trigger == nil ? "Create" : "Save") {
              if let likely { reveal(likely.id); dismiss() } else { save() }
            }.disabled(likely == nil && (disabled || control.loadingTriggerRoutines || !input.valid || !routines.contains { $0.id == routineId && $0.botId == control.botId })) }
          }
          ToolbarItemGroup(placement: .keyboard) {
            Spacer()
            Button { focused = nil } label: { Image(systemName: "keyboard.chevron.compact.down").font(.body).frame(width: 44, height: 44).contentShape(Rectangle()) }
              .buttonStyle(.plain).foregroundStyle(Palette.muted).accessibilityLabel("Hide keyboard").accessibilityIdentifier("automation.triggerEditor.hideKeyboard")
          }
        }.interactiveDismissDisabled(control.busy)
        .onChange(of: control.loading) { _, loading in
          if !loading, let likely { AccessibilityNotification.Announcement("\(likely.id) is now in Hermes. This app never received its signing secret.").post() }
          else if !loading, uncertain, !control.needsRefresh { AccessibilityNotification.Announcement("No trigger with this ID is in Hermes. Create trigger sends the same request again.").post() }
        }
        .onAppear { lifetime.appear() }.onDisappear { lifetime.disappear() }
    }
  }
  private func routineTitle(_ routine: Routine) -> String { routine.name + (routine.enabled ? "" : " (paused)") }
  private var selectedRoutineTitle: String {
    if let routine = routines.first(where: { $0.id == routineId }) { return routineTitle(routine) }
    return routineId.isEmpty ? "Choose a routine" : "Saved routine unavailable"
  }
  @ViewBuilder private var routineOptions: some View {
    Text("Choose a routine").tag("")
    if !routineId.isEmpty, !routines.contains(where: { $0.id == routineId }) { Text("Saved routine unavailable").tag(routineId).disabled(true) }
    ForEach(routines) { routine in Text(routineTitle(routine)).tag(routine.id) }
  }
  private var picker: some View {
    Picker("Routine", selection: $routineId) { routineOptions }
      .accessibilityIdentifier("automation.triggerRoutine")
  }
  private var wrappingPicker: some View {
    Menu {
      Picker("Routine", selection: $routineId) { routineOptions }.pickerStyle(.inline).labelsHidden()
    } label: {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(selectedRoutineTitle).lineLimit(nil).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 0)
        Image(systemName: "chevron.down")
      }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
    }.accessibilityLabel("Routine").accessibilityValue(selectedRoutineTitle)
      .accessibilityIdentifier("automation.triggerRoutine")
  }
  private var fields: some View {
    Section {
      if let trigger { LabeledContent("Trigger ID", value: trigger.id) }
      else {
        VStack(alignment: .leading, spacing: 6) {
          Text("Trigger ID")
          TextField("", text: $id, prompt: Text("lowercase-id").foregroundStyle(Palette.muted)).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focused, equals: .id).accessibilityLabel("Trigger ID").accessibilityIdentifier("automation.triggerID")
        }
        Text("Use 1 to 80 lowercase letters, digits, underscores or hyphens. Start with a letter or digit.").font(.caption).foregroundStyle(Palette.muted)
        if let problem = input.idProblem { Text(problem).foregroundStyle(Palette.danger) }
      }
      VStack(alignment: .leading, spacing: 6) {
        Text("Description (optional)")
        TextField("", text: $description, prompt: Text("What this trigger is for").foregroundStyle(Palette.muted), axis: .vertical).lineLimit(1...4).focused($focused, equals: .description).accessibilityLabel("Description (optional)").accessibilityIdentifier("automation.triggerDescription")
      }
      VStack(alignment: .leading, spacing: 6) {
        Text("Event names")
        TextField("", text: $eventNames, prompt: Text("issue.created, issue.closed").foregroundStyle(Palette.muted), axis: .vertical).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focused, equals: .events).accessibilityLabel("Event names").accessibilityIdentifier("automation.triggerEvents")
      }
      Text("Choose 1 to 20 event names, for example issue.created, issue.closed. Each name can contain letters, digits, _, ., *, : or -.").font(.caption).foregroundStyle(Palette.muted)
      if let problem = input.eventsProblem { Text(problem).foregroundStyle(Palette.danger) }
      if eventNames.trimmingCharacters(in: .whitespacesAndNewlines).hasSuffix(",") { Text("Remove the trailing comma before saving this trigger.").font(.caption).foregroundStyle(Palette.muted) }
      if dynamicTypeSize.isAccessibilitySize { VStack(alignment: .leading) { Text("Routine"); wrappingPicker } }
      else { picker }
      Text(trigger == nil ? "New triggers start disabled. The selected routine must also be enabled to run." : "The selected routine must also be enabled to run.").font(.footnote).foregroundStyle(Palette.muted)
      if description.utf16.count > 1000 { Text("Use at most 1,000 characters for the description.").foregroundStyle(Palette.danger) }
    } header: { Text("Trigger").foregroundStyle(Palette.muted) }
  }
  private func save() {
    let current = lifetime.current
    if trigger == nil && !uncertain { knownIds = Set(control.value?.triggers.items.map(\.id) ?? []); submittedId = id }
    Task {
      let result: HermesTriggerResult?
      if let trigger { result = await control.changeTrigger(store, triggerId: trigger.id, "/triggers/\(APIClient.component(trigger.id))", HermesTriggerUpdate(input, revision: trigger.revision), method: "PUT", action: "edit", current: current) }
      else { result = await control.changeTrigger(store, triggerId: submittedId, "/triggers", input, action: "create", current: current) }
      if result != nil { reveal(trigger?.id ?? submittedId); dismiss() }
      else if trigger == nil && control.needsRefresh && control.triggerFeedback?.message.hasPrefix("Not confirmed.") == true { uncertain = true }
    }
  }
}
