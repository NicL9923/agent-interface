import SwiftUI

@MainActor @Observable final class HermesAutomationControls {
  let botId: String
  var value: HermesAutomationOverview?
  var loading = false
  var busy = false
  var error: String?
  var notice: String?
  var needsRefresh = false
  var secret = HermesTransientSecret()
  var resumeIntent = HermesGoalResumeIntent()
  var triggerRoutines: [Routine] = []
  var loadingTriggerRoutines = false
  var triggerRoutineError: String?
  private var visible = true
  private var acceptsSecrets = false
  private var generation = UUID()
  private var resumeIntentKey: String?
  init(botId: String) { self.botId = botId }
  var path: String { "/bots/\(APIClient.component(botId))/automation" }
  var disabled: Bool { loading || busy || needsRefresh || value == nil }
  var canResume: Bool {
    guard value?.goals.goal?.status == "paused" else { return false }
    if let receipt = value?.goals.resume, receipt.status == "uncertain" {
      return receipt.requestId == resumeIntent.requestId
    }
    return true
  }
  var canStartNewResumeAttempt: Bool {
    guard value?.goals.goal?.status == "paused" else { return false }
    return value?.goals.resume?.status == "uncertain"
      || resumeIntent.requestId != nil && value?.goals.resume?.requestId != resumeIntent.requestId
  }
  /// Keep an unconfirmed resume's UUID through tab changes and app restarts, per account/profile.
  func restoreResumeIntent(key: String?) {
    guard key != resumeIntentKey else { return }
    resumeIntentKey = key
    resumeIntent = HermesGoalResumeIntent(requestId: key.flatMap { UserDefaults.standard.string(forKey: $0) })
  }
  private func saveResumeIntent() {
    guard let resumeIntentKey else { return }
    if let requestId = resumeIntent.requestId { UserDefaults.standard.set(requestId, forKey: resumeIntentKey) }
    else { UserDefaults.standard.removeObject(forKey: resumeIntentKey) }
  }
  func appear(foreground: Bool) { visible = true; acceptsSecrets = foreground }
  func foreground(_ active: Bool) {
    acceptsSecrets = active && visible
    if !active { secret.clear() }
  }
  func disappear() {
    visible = false; acceptsSecrets = false; generation = UUID(); secret.clear()
  }
  func loadTriggerRoutines(_ api: APIClient?) async {
    guard let api, !loadingTriggerRoutines, visible else { return }
    loadingTriggerRoutines = true; triggerRoutineError = nil
    let current = generation
    defer { loadingTriggerRoutines = false }
    do {
      let all: [Routine] = try await api.get("/routines")
      guard current == generation, visible, !Task.isCancelled else { return }
      triggerRoutines = all.filter { $0.botId == botId }
    } catch {
      if current == generation, visible, !Task.isCancelled {
        triggerRoutineError = "Could not load this assistant's routines. " + error.localizedDescription
      }
    }
  }
  @discardableResult func refresh(_ api: APIClient?) async -> Bool {
    guard let api, !loading, visible else { return false }
    loading = true
    let current = generation
    defer { loading = false }
    do {
      let next: HermesAutomationOverview = try await api.get(path)
      guard current == generation, visible else { return false }
      guard next.botId == botId else {
        throw APIError(message: "The server returned another assistant's controls. Refresh status.", status: 502)
      }
      value = next; error = nil; needsRefresh = false
      resumeIntent.resolve(next.goals.resume)
      saveResumeIntent()
      return true
    } catch {
      if current == generation, visible { self.error = error.localizedDescription; needsRefresh = true }
      return false
    }
  }
  /// Exactly one send. A failed response can hide a successful native write.
  func change<T: Decodable, V: Encodable>(
    _ api: APIClient?, _ suffix: String, _ input: V, method: String = "POST"
  ) async -> T? {
    guard let api, !disabled, visible else { return nil }
    busy = true; error = nil; notice = nil
    let current = generation
    defer { busy = false }
    do {
      let result: T = try await api.write(path + suffix, input, method: method)
      guard current == generation, visible else { return nil }
      if let trigger = result as? HermesTriggerResult, acceptsSecrets { secret.receive(trigger) }
      if suffix == "/goal" || suffix == "/goal/clear" {
        // A confirmed replacement or clear retires the preceding goal's resume intent.
        resumeIntent = HermesGoalResumeIntent(); saveResumeIntent()
      }
      if suffix == "/goal/resume", let overview = result as? HermesAutomationOverview {
        value = overview
        resumeIntent.resolve(overview.goals.resume)
        saveResumeIntent()
        needsRefresh = true
        let refreshed = await refresh(api)
        let currentReceipt = value?.goals.resume
        let receipt = currentReceipt?.requestId == overview.goals.resume?.requestId ? currentReceipt : overview.goals.resume
        switch receipt?.status {
        case "accepted":
          notice = receipt?.message ?? "Hermes accepted the goal continuation."
          if !refreshed { notice = (notice ?? "") + " Refresh status before making another change." }
        case "rejected":
          notice = nil
          self.error = receipt?.message ?? "Hermes refused this goal continuation. Review the conversation before trying again."
        default:
          notice = nil; needsRefresh = true
          self.error = (receipt?.message ?? "Hermes could not confirm this goal continuation.")
            + " Refresh status and review the conversation before trying again. Nothing will be sent again automatically."
        }
        return result
      }
      // The write has succeeded. Require a fresh overview even if its follow-up read fails.
      needsRefresh = true
      let refreshed = await refresh(api)
      notice = refreshed ? "Saved in Hermes." : "The change was saved. Refresh status before making another change."
      return result
    } catch {
      guard current == generation, visible else { return nil }
      let status = (error as? APIError)?.status
      // Native transitions can partially succeed before a conflict. Reconcile all failures.
      needsRefresh = true
      if status == nil || status == 0 || (status ?? 0) >= 500 || error is CancellationError {
        self.error = "We couldn't confirm this change. Refresh status and review it before trying again. Nothing will be sent again automatically."
      } else {
        self.error = error.localizedDescription + " Refresh status before trying again."
      }
      return nil
    }
  }
  func changeOK<V: Encodable>(
    _ api: APIClient?, _ suffix: String, _ input: V, method: String = "POST"
  ) async -> Bool {
    let result: EmptyResponse? = await change(api, suffix, input, method: method)
    return result != nil
  }
  func resume(_ api: APIClient?, reviewedInterruption: Bool = false) async {
    guard !disabled, canResume, value?.goals.interruptionPending != true || reviewedInterruption else { return }
    await sendResume(api, reviewedInterruption: reviewedInterruption)
  }
  /// A different request can repeat work. Only the explicit review form calls this method.
  func startNewResumeAttempt(
    _ api: APIClient?, reviewedConversation: Bool, acceptsRepeatedWork: Bool, reviewedInterruption: Bool
  ) async -> Bool {
    guard !disabled, canStartNewResumeAttempt, reviewedConversation, acceptsRepeatedWork,
      value?.goals.interruptionPending != true || reviewedInterruption else { return false }
    resumeIntent = HermesGoalResumeIntent(requestId: UUID().uuidString)
    saveResumeIntent()
    await sendResume(api, reviewedInterruption: reviewedInterruption)
    return true
  }
  private func sendResume(_ api: APIClient?, reviewedInterruption: Bool) async {
    let input = resumeIntent.prepare(reviewedInterruption: reviewedInterruption)
    saveResumeIntent()
    let result: HermesAutomationOverview? = await change(api, "/goal/resume", input)
    if let result { resumeIntent.resolve(result.goals.resume); saveResumeIntent() }
  }
}

struct HermesAutomationStatus: View {
  var control: HermesAutomationControls
  @Environment(AppStore.self) private var store
  var body: some View {
    Section {
      Text("Managed by Hermes").font(.caption).foregroundStyle(.secondary)
      if !store.connected { Text("Connect to Hermes to make changes.").foregroundStyle(.secondary) }
      if let error = control.error { ErrorBanner(message: error) }
      if let notice = control.notice { Text(notice).font(.footnote).accessibilityAddTraits(.updatesFrequently) }
      if control.loading { ProgressView("Refreshing assistant controls") }
      Button("Refresh status") { Task { await control.refresh(store.api) } }
        .disabled(control.busy || control.loading)
        .accessibilityIdentifier("automation.refresh")
      if control.needsRefresh { Text("Refresh and review the current status before making another change.").font(.footnote) }
    }
  }
}

private enum HermesWorkSheet: Identifiable {
  case createTask
  case taskDetail(HermesTask)
  case createTrigger
  case editTrigger(HermesSubscription)
  var id: String {
    switch self {
    case .createTask: return "create-task"
    case .taskDetail(let task): return "task:\(task.id)"
    case .createTrigger: return "create-trigger"
    case .editTrigger(let trigger): return "trigger:\(trigger.id)"
    }
  }
}

struct HermesWorkView: View {
  let botId: String
  @Environment(AppStore.self) private var store
  @Environment(\.scenePhase) private var scenePhase
  @State private var control: HermesAutomationControls
  @State private var sheet: HermesWorkSheet?
  init(botId: String) {
    self.botId = botId
    _control = State(initialValue: HermesAutomationControls(botId: botId))
  }
  var body: some View {
    Form {
      HermesAutomationStatus(control: control)
      if let value = control.value {
        HermesGoalSection(control: control, state: value.goals)
        HermesTaskSection(control: control, state: value.tasks,
          create: { sheet = .createTask }, open: { sheet = .taskDetail($0) })
        HermesTriggerSection(control: control, state: value.triggers,
          create: { sheet = .createTrigger }, edit: { sheet = .editTrigger($0) })
      }
    }.householdListBackground().accessibilityIdentifier("automation.work")
      .task {
        control.restoreResumeIntent(key: store.key(.goalResume, botId))
        control.appear(foreground: scenePhase == .active)
        await control.refresh(store.api)
      }
      .task(id: control.value?.triggers.supported) {
        if control.value?.triggers.supported == true { await control.loadTriggerRoutines(store.api) }
      }
      // Child page sheets keep Work mounted. This ends ownership when Work closes; a future
      // full-screen cover would need a lifecycle that keeps the shared controls alive beneath it.
      .onDisappear { control.disappear() }
      .onChange(of: scenePhase) { _, phase in control.foreground(phase == .active) }
      // Form sections are lazy. Keep the presenter and its state on the enclosing form so
      // recycling rows cannot tear down a presented editor or its parent sheet.
      .sheet(item: $sheet) { destination in workDestination(destination) }
  }
  @ViewBuilder private func workDestination(_ destination: HermesWorkSheet) -> some View {
    switch destination {
    case .createTask: HermesTaskEditor(control: control, task: nil)
    case .taskDetail(let task): HermesTaskDetail(control: control, initial: task)
    case .createTrigger: HermesTriggerEditor(control: control, trigger: nil)
    case .editTrigger(let trigger): HermesTriggerEditor(control: control, trigger: trigger)
    }
  }
}

private struct HermesGoalSection: View {
  var control: HermesAutomationControls
  var state: HermesAutomationOverview.Goals
  @Environment(AppStore.self) private var store
  @State private var editing = false
  @State private var clearing = false
  @State private var reviewedInterruption = false
  @State private var startingNewAttempt = false
  private var disabled: Bool { control.disabled || !store.connected }
  var body: some View {
    Section("Standing goal") {
      if !state.supported {
        Text(state.reason ?? "Goals are unavailable on this Hermes installation.").foregroundStyle(.secondary)
      } else {
        if let goal = state.goal {
          Text(goal.title).font(.headline)
          LabeledContent("Status", value: goal.status)
          LabeledContent("Continuation turns", value: "\(goal.turnsUsed) of \(goal.maxTurns)")
          if let reason = goal.pausedReason, !reason.isEmpty { Text(reason).font(.footnote) }
          if let resume = state.resume {
            Text("Last resume: \(resume.status)").font(.footnote).foregroundStyle(.secondary)
            if let message = resume.message { Text(message).font(.footnote) }
            if resume.status == "uncertain" {
              Text("Hermes has not confirmed the continuation. Refresh status and check the conversation before another resume.")
                .font(.footnote)
            }
          }
          if goal.status == "active" {
            Button("Pause goal") { Task { _ = await control.changeOK(store.api, "/goal/pause", [String: String]()) } }
              .disabled(disabled)
          } else {
            if state.interruptionPending == true {
              Toggle("I've reviewed the interrupted work in this conversation.", isOn: $reviewedInterruption)
                .disabled(disabled).accessibilityIdentifier("automation.reviewedInterruption")
            }
            Button(control.resumeIntent.requestId == nil ? "Resume goal" : "Retry same resume") {
              Task { await control.resume(store.api, reviewedInterruption: state.interruptionPending == true && reviewedInterruption) }
            }.disabled(disabled || !control.canResume || state.interruptionPending == true && !reviewedInterruption)
            if control.canStartNewResumeAttempt {
              Button("Start a new resume attempt") { startingNewAttempt = true }.disabled(disabled)
            }
          }
          Button("Replace goal") { editing = true }.disabled(disabled)
          Button("Clear goal", role: .destructive) { clearing = true }.disabled(disabled)
        } else {
          Text("No standing goal. A goal continues across turns until it finishes, pauses, or reaches its budget.")
            .foregroundStyle(.secondary)
          Button("Set a goal") { editing = true }.disabled(disabled)
        }
      }
    }
    .onChange(of: state.interruptionPending) { _, _ in reviewedInterruption = false }
    .onChange(of: state.goal?.status) { _, _ in reviewedInterruption = false }
    .sheet(isPresented: $editing) { HermesGoalEditor(control: control, goal: state.goal) }
    .sheet(isPresented: $startingNewAttempt) { HermesNewResumeAttempt(control: control) }
    .confirmationDialog("Clear this standing goal?", isPresented: $clearing, titleVisibility: .visible) {
      Button("Clear goal", role: .destructive) {
        Task { _ = await control.changeOK(store.api, "/goal/clear", [String: String]()) }
      }
    } message: { Text("The conversation stays saved.") }
  }
}

private struct HermesNewResumeAttempt: View {
  var control: HermesAutomationControls
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var reviewedConversation = false
  @State private var acceptsRepeatedWork = false
  @State private var reviewedInterruption = false
  private var interruptionPending: Bool { control.value?.goals.interruptionPending == true }
  private var canSubmit: Bool {
    !control.disabled && store.connected && control.canStartNewResumeAttempt
      && reviewedConversation && acceptsRepeatedWork && (!interruptionPending || reviewedInterruption)
  }
  var body: some View {
    NavigationStack {
      Form {
        HermesAutomationStatus(control: control)
        Section("Review the conversation first") {
          Text("Hermes has not confirmed the earlier attempt. It may still run. Starting a new attempt can repeat work.")
          Toggle("I've reviewed this conversation and the unconfirmed attempt.", isOn: $reviewedConversation)
          if interruptionPending {
            Toggle("I've reviewed the interrupted work in this conversation.", isOn: $reviewedInterruption)
          }
          Toggle("I understand a new attempt may repeat work.", isOn: $acceptsRepeatedWork)
        }.disabled(control.disabled || !store.connected)
      }.householdListBackground().navigationTitle("New resume attempt").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(control.busy) }
          ToolbarItem(placement: .confirmationAction) {
            Button("Start new attempt") {
              Task {
                if await control.startNewResumeAttempt(store.api, reviewedConversation: reviewedConversation,
                  acceptsRepeatedWork: acceptsRepeatedWork, reviewedInterruption: interruptionPending && reviewedInterruption) { dismiss() }
              }
            }.disabled(!canSubmit)
          }
        }.interactiveDismissDisabled(control.busy)
    }
  }
}

private struct HermesGoalEditor: View {
  var control: HermesAutomationControls
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var title: String
  @State private var maxTurns: Int
  @State private var confirmingReplacement = false
  private let existingGoal: Bool
  private var replacing: Bool { existingGoal || control.value?.goals.goal != nil }
  private let replacementWarning = "This resets turn progress and removes the existing goal's native subgoals, completion contracts and verification gates. The replacement is saved paused."
  init(control: HermesAutomationControls, goal: HermesGoal?) {
    self.control = control
    existingGoal = goal != nil
    _title = State(initialValue: goal?.title ?? "")
    _maxTurns = State(initialValue: goal?.maxTurns ?? 20)
  }
  var body: some View {
    NavigationStack {
      Form {
        HermesAutomationStatus(control: control)
        Section("Objective") {
          TextField("What should the assistant work toward?", text: $title, axis: .vertical).lineLimit(4...12)
          Stepper("Continuation turn budget: \(maxTurns)", value: $maxTurns, in: 1...1000)
          Text("Saves paused. Resume the goal when you are ready for the assistant to work.").font(.footnote)
          if replacing { Text(replacementWarning).font(.footnote).foregroundStyle(Palette.danger) }
          if title.utf16.count > 10_000 { Text("Use at most 10,000 characters.").foregroundStyle(Palette.danger) }
        }.disabled(control.disabled || !store.connected)
      }.householdListBackground().navigationTitle(replacing ? "Replace goal" : "Standing goal").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(control.busy) }
          ToolbarItem(placement: .confirmationAction) {
            Button(replacing ? "Replace goal" : "Save paused") {
              if replacing { confirmingReplacement = true } else { save() }
            }.disabled(control.disabled || !store.connected || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || title.utf16.count > 10_000)
          }
        }.interactiveDismissDisabled(control.busy)
        .confirmationDialog("Replace this standing goal?", isPresented: $confirmingReplacement, titleVisibility: .visible) {
          Button("Replace goal", role: .destructive) { save() }
        } message: { Text(replacementWarning) }
    }
  }
  private func save() {
    Task {
      if await control.changeOK(store.api, "/goal", HermesGoalInput(title: title, maxTurns: maxTurns), method: "PUT") { dismiss() }
    }
  }
}

private struct HermesTaskSection: View {
  var control: HermesAutomationControls
  var state: HermesAutomationOverview.Tasks
  var create: () -> Void
  var open: (HermesTask) -> Void
  @Environment(AppStore.self) private var store
  private var statuses: [String] {
    let preferred = ["blocked", "ready", "running", "review", "done", "cancelled"]
    let present = Set(state.items.map(\.status))
    return preferred.filter { present.contains($0) } + present.subtracting(preferred).sorted()
  }
  var body: some View {
    Section("Task board") {
      if !state.supported {
        Text(state.reason ?? "Task boards are unavailable on this Hermes installation.").foregroundStyle(.secondary)
      } else {
        if state.truncated == true {
          Text("Showing the newest \(state.limit ?? state.items.count) visible tasks. Older tasks are not shown.")
            .font(.footnote).foregroundStyle(.secondary)
        }
        if state.items.isEmpty { Text("No tasks yet.").foregroundStyle(.secondary) }
        ForEach(statuses, id: \.self) { status in
          DisclosureGroup("\(status.replacingOccurrences(of: "_", with: " ").capitalized) (\(state.items.filter { $0.status == status }.count))") {
            ForEach(state.items.filter { $0.status == status }) { task in
              Button { open(task) } label: {
                VStack(alignment: .leading, spacing: 4) {
                  Text(task.title).foregroundStyle(Color.primary)
                  Text("\(assignee(task.assignee)) · Priority \(task.priority)").font(.caption).foregroundStyle(.secondary)
                }.padding(.vertical, 4)
              }.accessibilityIdentifier("automation.task.\(task.id)")
            }
          }
        }
        Button("New task", action: create).disabled(control.disabled || !store.connected)
      }
    }
  }
  private func assignee(_ id: String?) -> String {
    store.bootstrap?.bots.first { $0.id == id }?.name ?? id ?? "Unassigned"
  }
}

private struct HermesAssigneePicker: View {
  var title: String
  @Binding var selection: String
  var emptyLabel: String
  @Environment(AppStore.self) private var store
  var body: some View {
    Picker(title, selection: $selection) {
      Text(emptyLabel).tag("")
      if !selection.isEmpty, store.bootstrap?.bots.contains(where: { $0.id == selection }) != true {
        Text("Saved assistant unavailable").tag(selection).disabled(true)
      }
      ForEach(store.bootstrap?.bots ?? []) { bot in Text(bot.name).tag(bot.id) }
    }
  }
}

private struct HermesTaskEditor: View {
  var control: HermesAutomationControls
  var task: HermesTask?
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var draft: HermesTaskDraft
  @State private var intent = HermesTaskCreationIntent()
  init(control: HermesAutomationControls, task: HermesTask?) {
    self.control = control; self.task = task
    _draft = State(initialValue: HermesTaskDraft(title: task?.title ?? "", body: task?.body ?? "",
      priority: task?.priority ?? 0, assignee: task == nil ? control.botId : task?.assignee, dependencies: task?.dependencies ?? []))
  }
  private var assignee: Binding<String> {
    Binding(get: { draft.assignee ?? "" }, set: { draft.assignee = $0.isEmpty ? nil : $0 })
  }
  private var eligibleAssignee: Bool {
    guard let assignee = draft.assignee else { return true }
    return store.bootstrap?.bots.contains { $0.id == assignee } == true
  }
  var body: some View {
    NavigationStack {
      Form {
        HermesAutomationStatus(control: control)
        fields.disabled(control.disabled || !store.connected)
        if task == nil { dependencies.disabled(control.disabled || !store.connected) }
      }.householdListBackground().accessibilityIdentifier("automation.taskEditor").navigationTitle(task == nil ? "New task" : "Edit task")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(control.busy) }
          ToolbarItem(placement: .confirmationAction) {
            Button(task == nil ? "Create task" : "Save task") { save() }
              .disabled(control.disabled || !store.connected || !draft.valid || !eligibleAssignee)
              .accessibilityIdentifier("automation.saveTask")
          }
        }.interactiveDismissDisabled(control.busy)
    }
  }
  private var fields: some View {
    Section("Task") {
      TextField("Title", text: $draft.title, axis: .vertical).lineLimit(1...4).accessibilityIdentifier("automation.taskTitle")
      TextField("Instructions", text: $draft.body, axis: .vertical).lineLimit(4...12).accessibilityIdentifier("automation.taskBody")
      HermesAssigneePicker(title: "Assigned assistant", selection: assignee,
        emptyLabel: "Unassigned")
      Stepper("Priority: \(draft.priority)", value: $draft.priority, in: -100...100)
      if draft.title.utf16.count > 500 { Text("Use at most 500 characters for the title.").foregroundStyle(Palette.danger) }
      if draft.body.utf16.count > 20_000 { Text("Use at most 20,000 characters for the instructions.").foregroundStyle(Palette.danger) }
      if task == nil { Text("Creates a blocked task. Start it explicitly when the instructions are ready.").font(.footnote) }
    }
  }
  private var dependencies: some View {
    Section("Wait for these tasks") {
      if control.value?.tasks.items.isEmpty != false { Text("No other tasks yet.").foregroundStyle(.secondary) }
      ForEach(control.value?.tasks.items ?? []) { item in
        Toggle(item.title, isOn: Binding(get: { draft.dependencies.contains(item.id) }, set: { selected in
          if selected { if !draft.dependencies.contains(item.id) { draft.dependencies.append(item.id) } }
          else { draft.dependencies.removeAll { $0 == item.id } }
        })).disabled(!draft.dependencies.contains(item.id) && draft.dependencies.count >= 20)
      }
      Text("Choose up to 20 dependencies.").font(.footnote).foregroundStyle(.secondary)
    }
  }
  private func save() {
    Task {
      let result: HermesTask?
      if let task {
        result = await control.change(store.api, "/tasks/\(APIClient.component(task.id))", HermesTaskUpdate(draft), method: "PATCH")
      } else {
        let request = intent.prepare(draft)
        result = await control.change(store.api, "/tasks", request)
      }
      if result != nil { dismiss() }
    }
  }
}

private struct HermesTaskDetail: View {
  var control: HermesAutomationControls
  var initial: HermesTask
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var editing = false
  @State private var reason = ""
  @State private var reviewer = ""
  @State private var dependency = ""
  private var task: HermesTask { control.value?.tasks.items.first { $0.id == initial.id } ?? initial }
  private var disabled: Bool {
    control.disabled || !store.connected || control.value?.tasks.items.contains { $0.id == initial.id } != true
  }
  private var path: String { "/tasks/\(APIClient.component(initial.id))" }
  var body: some View {
    NavigationStack {
      Form {
        HermesAutomationStatus(control: control)
        summary
        actions.disabled(disabled)
        dependencies.disabled(disabled)
      }.householdListBackground().accessibilityIdentifier("automation.taskDetail").navigationTitle("Task details").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() }.disabled(control.busy) } }
        .sheet(isPresented: $editing) { HermesTaskEditor(control: control, task: task) }
        .interactiveDismissDisabled(control.busy)
    }
  }
  private var summary: some View {
    Section {
      Text(task.title).font(.headline)
      Text(task.body.isEmpty ? "No additional instructions." : task.body).textSelection(.enabled)
      LabeledContent("Status", value: task.status)
        .accessibilityElement(children: .ignore).accessibilityLabel("Task status").accessibilityValue(task.status)
        .accessibilityIdentifier("automation.taskStatus")
      LabeledContent("Assigned assistant", value: store.bootstrap?.bots.first { $0.id == task.assignee }?.name ?? task.assignee ?? "Unassigned")
      LabeledContent("Priority", value: "\(task.priority)")
      if let reason = task.blockedReason { Text("Blocked: \(reason)").font(.footnote) }
      if control.value?.tasks.items.contains(where: { $0.id == initial.id }) != true {
        Text("This task is no longer available in the current board.").foregroundStyle(.secondary)
      }
      Button("Edit task") { editing = true }.disabled(disabled)
    }
  }
  private var actions: some View {
    Section("Move task") {
      TextField("Reason or review feedback", text: $reason, axis: .vertical).lineLimit(2...6)
      if reason.utf16.count > 2000 { Text("Use at most 2,000 characters.").foregroundStyle(Palette.danger) }
      HermesAssigneePicker(title: "Reviewer", selection: $reviewer, emptyLabel: "Choose an assistant")
      Button("Start task") { action(.start) }.disabled(reason.utf16.count > 2000)
      Button("Block task") { action(.block) }.disabled(!hasReason)
      Button("Unblock task") { action(.unblock) }.disabled(reason.utf16.count > 2000)
      Button("Request review") { action(.requestReview) }
        .disabled(reviewer.isEmpty || store.bootstrap?.bots.contains { $0.id == reviewer } != true || reason.utf16.count > 2000)
      if task.status == "review" {
        Text("The reviewing assistant can request changes through Hermes while it owns the review.").font(.footnote).foregroundStyle(.secondary)
      }
      Text("Hermes checks the task's current state and dependencies before changing it.").font(.footnote).foregroundStyle(.secondary)
    }
  }
  private var dependencies: some View {
    Section("Dependencies") {
      if task.dependencies.isEmpty { Text("None.").foregroundStyle(.secondary) }
      ForEach(task.dependencies, id: \.self) { id in
        VStack(alignment: .leading) {
          Text(control.value?.tasks.items.first { $0.id == id }?.title ?? id)
          Button("Remove dependency", role: .destructive) { changeDependency(id, remove: true) }
        }
      }
      Picker("Wait for task", selection: $dependency) {
        Text("Choose a task").tag("")
        ForEach((control.value?.tasks.items ?? []).filter { $0.id != task.id && !task.dependencies.contains($0.id) }) { item in
          Text(item.title).tag(item.id)
        }
      }
      Button("Add dependency") { changeDependency(dependency, remove: false) }
        .disabled(dependency.isEmpty || task.dependencies.count >= 20)
    }
  }
  private var hasReason: Bool { !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && reason.utf16.count <= 2000 }
  private func action(_ value: HermesTaskAction.Action) {
    let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    let input = HermesTaskAction(action: value, reason: trimmed.isEmpty ? nil : trimmed,
      reviewer: value == .requestReview && !reviewer.isEmpty ? reviewer : nil)
    Task {
      let result: HermesTask? = await control.change(store.api, path + "/actions", input)
      if result != nil { reason = ""; reviewer = "" }
    }
  }
  private func changeDependency(_ id: String, remove: Bool) {
    Task {
      let result: HermesTask? = await control.change(store.api, path + "/dependencies/\(APIClient.component(id))", HermesDependencyInput(remove: remove), method: "PUT")
      if result != nil { dependency = "" }
    }
  }
}
