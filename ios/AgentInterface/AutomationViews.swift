import SwiftUI

@MainActor @Observable final class HermesAutomationControls {
  let botId: String
  var value: HermesAutomationOverview?
  var loading = false
  var busy = false
  var error: String?
  var notice: String?
  var needsRefresh = false
  var taskFeedback: HermesTaskFeedback?
  var triggerFeedback: HermesTriggerFeedback?
  var secret = HermesTransientSecret()
  var resumeIntent = HermesGoalResumeIntent()
  var triggerRoutines: [Routine] = []
  var loadingTriggerRoutines = false
  var triggerRoutineError: String?
  private var visible = true
  private var acceptsSecrets = false
  private var generation = UUID()
  private var resumeIntentKey: String?
  private weak var ownerStore: AppStore?
  private weak var ownerAPI: APIClient?
  private var ownerScope: String?
  private var bound = false
  private var secretGeneration = UUID()
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
    if !active { secretGeneration = UUID(); secret.clear() }
  }
  func disappear() {
    visible = false; acceptsSecrets = false; generation = UUID()
    secretGeneration = UUID(); secret.clear()
  }
  /// A controls instance belongs to the session that first loaded it. Never send old form
  /// values through a replacement client, even before SwiftUI removes the old view.
  func isCurrent(_ store: AppStore) -> Bool {
    visible && !Task.isCancelled && bound && ownerStore === store
      && ownerScope == store.scope && ownerAPI != nil && ownerAPI === store.api
  }
  func attempt<T>(
    _ store: AppStore, current: @escaping @MainActor () -> Bool = { true },
    _ work: @MainActor (RequestContext) async throws -> T
  ) async -> Result<T, Error>? {
    if !bound, let api = store.api {
      bound = true; ownerStore = store; ownerAPI = api; ownerScope = store.scope
    }
    let started = generation
    return await store.attempt(current: { self.isCurrent(store) && self.generation == started && current() }, work)
  }
  func loadTriggerRoutines(_ store: AppStore) async {
    guard !loadingTriggerRoutines else { return }
    loadingTriggerRoutines = true
    defer { loadingTriggerRoutines = false }
    let outcome = await attempt(store) { context -> [Routine] in
      try await context.api.get("/routines")
    }
    switch outcome {
    case .success(let all)?:
      triggerRoutines = all.filter { $0.botId == botId }; triggerRoutineError = nil
    case .failure(let error)?:
      triggerRoutineError = "Could not load this assistant's routines. " + error.localizedDescription
    case nil: break
    }
  }
  @discardableResult func refresh(
    _ store: AppStore, current: @escaping @MainActor () -> Bool = { true }
  ) async -> Bool {
    guard !loading else { return false }
    loading = true
    defer { loading = false }
    let outcome = await attempt(store, current: current) { context -> HermesAutomationOverview in
      let next: HermesAutomationOverview = try await context.api.get(self.path)
      guard next.botId == self.botId else {
        throw APIError(message: "The server returned another assistant's controls. Refresh status.", status: 502)
      }
      return next
    }
    switch outcome {
    case .success(let next)?:
      value = next; error = nil; needsRefresh = false
      resumeIntent.resolve(next.goals.resume); saveResumeIntent()
      return true
    case .failure(let error)?: self.error = error.localizedDescription; needsRefresh = true
    case nil: break
    }
    return false
  }
  /// Exactly one send. A failed or cancelled response can hide a successful native write.
  func change<T: Decodable & SendableMetatype, V: Encodable>(
    _ store: AppStore, _ suffix: String, _ input: V, method: String = "POST",
    current: @escaping @MainActor () -> Bool = { true }
  ) async -> T? {
    guard !disabled, isCurrent(store), current() else { return nil }
    busy = true; error = nil; notice = nil
    // Invalidate before dispatch. Cancellation must still require reconciliation before retry.
    needsRefresh = true
    defer { busy = false }
    let outcome = await attempt(store, current: current) { context -> T in
      let result: T = try await context.api.write(self.path + suffix, input, method: method)
      try context.checkCurrent()
      if suffix == "/goal" || suffix == "/goal/clear" {
        // A confirmed replacement or clear retires the preceding goal's resume intent.
        self.resumeIntent = HermesGoalResumeIntent(); self.saveResumeIntent()
      }
      let overview = suffix == "/goal/resume" ? result as? HermesAutomationOverview : nil
      if let overview {
        guard overview.botId == self.botId else {
          throw APIError(message: "The server returned another assistant's controls. Refresh status.", status: 502)
        }
        self.value = overview
        self.resumeIntent.resolve(overview.goals.resume); self.saveResumeIntent()
      }
      // The write has succeeded. Reconcile through the original session and check again after
      // the read, since the sheet, account or client can change during that second await.
      try context.checkCurrent()
      let refreshed = await self.refresh(store, current: context.isCurrent)
      try context.checkCurrent()
      if let overview {
        let currentReceipt = self.value?.goals.resume
        let receipt = currentReceipt?.requestId == overview.goals.resume?.requestId ? currentReceipt : overview.goals.resume
        switch receipt?.status {
        case "accepted":
          self.notice = receipt?.message ?? "Hermes accepted the goal continuation."
          if !refreshed { self.notice = (self.notice ?? "") + " Refresh status before making another change." }
        case "rejected":
          self.notice = nil
          self.error = receipt?.message ?? "Hermes refused this goal continuation. Review the conversation before trying again."
        default:
          self.notice = nil; self.needsRefresh = true
          self.error = (receipt?.message ?? "Hermes could not confirm this goal continuation.")
            + " Refresh status and review the conversation before trying again. Nothing will be sent again automatically."
        }
      } else {
        self.notice = refreshed ? "Saved in Hermes." : "The change was saved. Refresh status before making another change."
      }
      return result
    }
    switch outcome {
    case .success(let result)?: return result
    case .failure(let error)?:
      let status = (error as? APIError)?.status
      // Native transitions can partially succeed before a conflict. Reconcile all failures.
      needsRefresh = true
      if status == nil || status == 0 || (status ?? 0) >= 500 || error is CancellationError {
        self.error = "We couldn't confirm this change. Refresh status and review it before trying again. Nothing will be sent again automatically."
      } else {
        self.error = error.localizedDescription + " Refresh status before trying again."
      }
      return nil
    case nil: return nil
    }
  }
  /// Task refusals can follow a partial write, so reconcile before releasing the shared lock.
  func changeTask<V: Encodable>(
    _ store: AppStore, taskId: String, _ suffix: String, _ input: V, method: String = "POST",
    moved: Bool = false, edit: Bool = false, current: @escaping @MainActor () -> Bool = { true }
  ) async -> HermesTask? {
    guard !disabled, isCurrent(store), current() else { return nil }
    busy = true; error = nil; notice = nil; taskFeedback = nil; needsRefresh = true
    defer { busy = false }
    let outcome = await attempt(store, current: current) { context -> HermesTask? in
      let result: HermesTask
      do {
        result = try await context.api.write(self.path + suffix, input, method: method)
      } catch let refusal as APIError where refusal.status > 0 && refusal.status < 500 {
        try context.checkCurrent()
        let refreshed = await self.refresh(store, current: context.isCurrent)
        try context.checkCurrent()
        if refreshed {
          self.publishTaskFeedback(taskId, edit: edit, message: refusal.message + " Status refreshed.", isError: true)
        } else {
          self.error = refusal.message + " Refresh status before trying again."
          self.publishTaskFeedback(taskId, edit: edit, message: "Status could not be refreshed. Use Refresh status above.", isError: false)
        }
        return nil
      }
      try context.checkCurrent()
      let refreshed = await self.refresh(store, current: context.isCurrent)
      try context.checkCurrent()
      guard refreshed else {
        self.publishTaskFeedback(taskId, edit: edit, message: "Not confirmed. Use Refresh status above.", isError: false)
        return nil
      }
      let status = self.value?.tasks.items.first { $0.id == taskId }?.status
      let message = status.map { moved ? "Moved to \(hermesTaskStatusLabel($0))." : "Saved in Hermes." } ?? "Saved in Hermes."
      self.publishTaskFeedback(taskId, edit: edit, message: message, isError: false)
      return result
    }
    switch outcome {
    case .success(let result)?: return result
    case .failure(let failure)?:
      needsRefresh = true
      let status = (failure as? APIError)?.status
      if failure is CancellationError || status == nil || status == 0 || (status ?? 0) >= 500 {
        error = "We couldn't confirm this change. Refresh status and review it before trying again. Nothing will be sent again automatically."
      } else { error = failure.localizedDescription + " Refresh status before trying again." }
      publishTaskFeedback(taskId, edit: edit, message: "Not confirmed. Use Refresh status above.", isError: false)
      return nil
    case nil: return nil
    }
  }
  func changeTrigger<T: Decodable & SendableMetatype, V: Encodable>(
    _ store: AppStore, triggerId: String, _ suffix: String, _ input: V, method: String = "POST",
    action: String, current: @escaping @MainActor () -> Bool = { true }
  ) async -> T? {
    guard !disabled, isCurrent(store), current() else { return nil }
    busy = true; error = nil; notice = nil; triggerFeedback = nil; needsRefresh = true
    let secretStarted = secretGeneration
    defer { busy = false }
    let outcome = await attempt(store, current: current) { context -> T? in
      let result: T
      do { result = try await context.api.write(self.path + suffix, input, method: method) }
      catch let refusal as APIError where refusal.status > 0 && refusal.status < 500 {
        try context.checkCurrent()
        let refreshed = await self.refresh(store, current: context.isCurrent)
        try context.checkCurrent()
        if refreshed { self.publishTriggerFeedback(triggerId, refusal.message + " Status refreshed.", true, action) }
        else {
          self.error = refusal.message + " Refresh status before trying again."
          self.publishTriggerFeedback(triggerId, "Status could not be refreshed. Use Refresh status above.", true, action)
        }
        return nil
      }
      try context.checkCurrent()
      let refreshed = await self.refresh(store, current: context.isCurrent)
      try context.checkCurrent()
      if let trigger = result as? HermesTriggerResult, self.acceptsSecrets, self.secretGeneration == secretStarted {
        self.secret.receive(trigger)
      }
      let lostSecret = action == "create" && (result as? HermesTriggerResult)?.secret != nil && (!self.acceptsSecrets || self.secretGeneration != secretStarted)
      if refreshed {
        let message = lostSecret ? "\(triggerId) was created, but its signing secret was cleared when you left the app. To get a secret, delete \(triggerId) and create it again."
          : action == "delete" ? "Deleted \(triggerId)." : action == "enable" ? "Enabled." : action == "disable" ? "Disabled." : "Saved in Hermes."
        self.publishTriggerFeedback(triggerId, message, false, action)
      } else {
        let confirmed = action == "delete" ? "Deleted \(triggerId)." : action == "enable" ? "Enabled." : action == "disable" ? "Disabled." : "Saved."
        let message = lostSecret ? "\(triggerId) was created, but its signing secret was cleared when you left the app. To get a secret, delete \(triggerId) and create it again. Status could not refresh. Use Refresh status above."
          : confirmed + " Status could not refresh. Use Refresh status above."
        self.publishTriggerFeedback(triggerId, message, false, action)
      }
      return result
    }
    switch outcome {
    case .success(let result)?: return result
    case .failure(let failure)?:
      needsRefresh = true
      error = "We couldn't confirm this change. Refresh status and review it before trying again. Nothing will be sent again automatically."
      let message = action == "create" ? "Not confirmed. Hermes may have created this trigger. Use Refresh status above before trying again." : "Not confirmed. Use Refresh status above."
      publishTriggerFeedback(triggerId, message, true, action)
      _ = failure
      return nil
    case nil: return nil
    }
  }
  private func publishTriggerFeedback(_ id: String, _ message: String, _ isError: Bool, _ action: String) {
    triggerFeedback = HermesTriggerFeedback(id: id, message: message, isError: isError, action: action)
    AccessibilityNotification.Announcement(message).post()
  }
  private func publishTaskFeedback(_ taskId: String, edit: Bool, message: String, isError: Bool) {
    taskFeedback = HermesTaskFeedback(taskId: taskId, message: message, isError: isError, edit: edit)
    AccessibilityNotification.Announcement(message).post()
  }
  func manualRefresh(_ store: AppStore) async {
    taskFeedback = nil
    await refresh(store)
  }
  func changeOK<V: Encodable>(
    _ store: AppStore, _ suffix: String, _ input: V, method: String = "POST",
    current: @escaping @MainActor () -> Bool = { true }
  ) async -> Bool {
    let result: EmptyResponse? = await change(store, suffix, input, method: method, current: current)
    return result != nil
  }
  func resume(_ store: AppStore, reviewedInterruption: Bool = false) async {
    guard !disabled, isCurrent(store), canResume, value?.goals.interruptionPending != true || reviewedInterruption else { return }
    await sendResume(store, reviewedInterruption: reviewedInterruption)
  }
  /// A different request can repeat work. Only the explicit review form calls this method.
  func startNewResumeAttempt(
    _ store: AppStore, reviewedConversation: Bool, acceptsRepeatedWork: Bool, reviewedInterruption: Bool,
    current: @escaping @MainActor () -> Bool = { true }
  ) async -> Bool {
    guard !disabled, isCurrent(store), current(), canStartNewResumeAttempt, reviewedConversation, acceptsRepeatedWork,
      value?.goals.interruptionPending != true || reviewedInterruption else { return false }
    resumeIntent = HermesGoalResumeIntent(requestId: UUID().uuidString)
    saveResumeIntent()
    await sendResume(store, reviewedInterruption: reviewedInterruption, current: current)
    return isCurrent(store) && current()
  }
  private func sendResume(
    _ store: AppStore, reviewedInterruption: Bool, current: @escaping @MainActor () -> Bool = { true }
  ) async {
    let input = resumeIntent.prepare(reviewedInterruption: reviewedInterruption)
    saveResumeIntent()
    let _: HermesAutomationOverview? = await change(store, "/goal/resume", input, current: current)
  }
}

struct HermesAutomationStatus: View {
  var control: HermesAutomationControls
  var compact = false
  var work = false
  var showingReceipt = false
  var suppressRefreshFootnote = false
  var introduction: String?
  @Environment(AppStore.self) private var store
  // The goal card owns the server receipt. Keep any distinct reconciliation guidance here.
  private var displayedError: String? {
    guard let error = control.error else { return nil }
    guard let receipt = control.value?.goals.resume,
      work && ["rejected", "uncertain"].contains(receipt.status) || showingReceipt && receipt.status == "uncertain" else { return error }
    let message = receipt.message ?? (receipt.status == "rejected"
      ? "Hermes refused this goal continuation. Review the conversation before trying again."
      : "Hermes could not confirm this goal continuation.")
    guard !message.isEmpty, error.hasPrefix(message) else { return error }
    let remainder = String(error.dropFirst(message.count)).trimmingCharacters(in: .whitespacesAndNewlines)
    return remainder.isEmpty ? nil : remainder
  }
  var body: some View {
    if !work && !compact {
      Section {
        Text("Managed by Hermes").font(.caption).foregroundStyle(Palette.muted)
        if !store.connected { Text("Connect to Hermes to make changes.").foregroundStyle(Palette.muted) }
        if let error = control.error { ErrorBanner(message: error) }
        if let notice = control.notice { Text(notice).font(.footnote).accessibilityAddTraits(.updatesFrequently) }
        if control.loading { ProgressView("Refreshing assistant controls") }
        Button("Refresh status") { Task { await control.manualRefresh(store) } }
          .disabled(control.busy || control.loading).accessibilityIdentifier("automation.refresh")
        if control.needsRefresh { Text("Refresh and review the current status before making another change.").font(.footnote) }
      } header: {
        if let introduction { Text(introduction).font(.subheadline).foregroundStyle(Palette.muted).textCase(nil) }
      }
    } else if !compact || displayedError != nil || control.notice != nil || control.needsRefresh || control.loading || !store.connected {
      Section {
        if !compact { Text("Managed by Hermes").font(.caption).foregroundStyle(Palette.muted) }
        if !store.connected { Text("Connect to Hermes to make changes.").foregroundStyle(Palette.muted) }
        if let error = displayedError { ErrorBanner(message: error) }
        if let notice = control.notice { Text(notice).font(.footnote).accessibilityAddTraits(.updatesFrequently) }
        if control.loading {
          if work {
            ProgressView { Text(control.value == nil ? "Loading Work…" : "Refreshing…").foregroundStyle(Palette.muted) }
          } else { ProgressView("Refreshing assistant controls") }
        }
        if !compact || control.needsRefresh || displayedError != nil {
          if work && control.value == nil && control.error != nil {
            Button("Try loading again") { Task { await control.manualRefresh(store) } }
              .buttonStyle(.accentProminent).disabled(control.busy || control.loading)
              .accessibilityIdentifier("automation.refresh")
          } else {
            Button("Refresh status") { Task { await control.manualRefresh(store) } }
              .disabled(control.busy || control.loading).accessibilityIdentifier("automation.refresh")
          }
        }
        if !suppressRefreshFootnote && control.needsRefresh && control.value != nil && (!work || displayedError == nil) {
          Text("Refresh and review the current status before making another change.").font(.footnote)
            .foregroundStyle(Palette.muted)
        }
      }
    }
  }
}

private enum HermesWorkSheet: Identifiable {
  case goalEditor(HermesGoal?)
  case newResumeAttempt
  case clearGoal
  case createTask
  case taskDetail(HermesTask)
  case createTrigger
  case editTrigger(HermesSubscription)
  case deleteTrigger(HermesSubscription)
  var id: String {
    switch self {
    case .goalEditor: return "goal-editor"
    case .newResumeAttempt: return "new-resume-attempt"
    case .clearGoal: return "clear-goal"
    case .createTask: return "create-task"
    case .taskDetail(let task): return "task:\(task.id)"
    case .createTrigger: return "create-trigger"
    case .editTrigger(let trigger): return "trigger:\(trigger.id)"
    case .deleteTrigger(let trigger): return "delete-trigger:\(trigger.id)"
    }
  }
}

struct HermesWorkView: View {
  let botId: String
  @Environment(AppStore.self) private var store
  @Environment(\.scenePhase) private var scenePhase
  @State private var control: HermesAutomationControls
  @State private var sheet: HermesWorkSheet?
  @State private var pendingClearGoal = false
  @State private var pendingDeleteTrigger: HermesSubscription?
  @State private var expandedTriggers: Set<String> = []
  @State private var collapsedTaskStatuses: Set<String> = ["done"]
  init(botId: String) {
    self.botId = botId
    _control = State(initialValue: HermesAutomationControls(botId: botId))
  }
  var body: some View {
    ScrollViewReader { proxy in
    Form {
      HermesAutomationStatus(control: control, work: true)
      if let value = control.value {
        HermesGoalSection(control: control, state: value.goals,
          edit: { sheet = .goalEditor(value.goals.goal) },
          startNewAttempt: { sheet = .newResumeAttempt }, clear: { sheet = .clearGoal })
        HermesTaskSection(control: control, state: value.tasks, collapsedStatuses: $collapsedTaskStatuses,
          create: { sheet = .createTask }, open: { sheet = .taskDetail($0) })
        HermesTriggerSection(control: control, state: value.triggers, expanded: $expandedTriggers,
          create: { sheet = .createTrigger }, edit: { sheet = .editTrigger($0) }, delete: { sheet = .deleteTrigger($0) })
          .id("automation.triggers")
      }
    }.householdListBackground().accessibilityIdentifier("automation.work")
      .task {
        control.restoreResumeIntent(key: store.key(.goalResume, botId))
        control.appear(foreground: scenePhase == .active)
        await control.refresh(store)
      }
      .task(id: control.value?.triggers.supported) {
        if control.value?.triggers.supported == true { await control.loadTriggerRoutines(store) }
      }
      // Child page sheets keep Work mounted. This ends ownership when Work closes; a future
      // full-screen cover would need a lifecycle that keeps the shared controls alive beneath it.
      .onDisappear { control.disappear() }
      .onChange(of: control.triggerFeedback?.message) { _, _ in
        if control.triggerFeedback?.action == "delete" { proxy.scrollTo("automation.triggers", anchor: .top) }
      }
      .onChange(of: scenePhase) { _, phase in control.foreground(phase == .active) }
      // Form sections are lazy. Keep the presenter and its state on the enclosing form so
      // recycling rows cannot tear down a presented editor or its parent sheet.
      .sheet(item: $sheet, onDismiss: {
        if control.secret.value != nil { proxy.scrollTo("automation.signingSecret", anchor: .top) }
        if let trigger = pendingDeleteTrigger {
          pendingDeleteTrigger = nil
          Task { let _: EmptyResponse? = await control.changeTrigger(store, triggerId: trigger.id, "/triggers/\(APIClient.component(trigger.id))", HermesRevisionInput(revision: trigger.revision), method: "DELETE", action: "delete") }
        }
        if pendingClearGoal {
          pendingClearGoal = false
          Task { _ = await control.changeOK(store, "/goal/clear", [String: String]()) }
        }
      }) { destination in workDestination(destination) }
    }
  }
  @ViewBuilder private func workDestination(_ destination: HermesWorkSheet) -> some View {
    switch destination {
    case .goalEditor(let goal): HermesGoalEditor(control: control, goal: goal)
    case .newResumeAttempt: HermesNewResumeAttempt(control: control)
    case .clearGoal:
      AssistantConfirmationSheet(title: "Clear this standing goal?", message: "The conversation stays saved.",
        acceptLabel: "Clear goal", keepLabel: "Keep goal", destructive: true,
        accept: { pendingClearGoal = true; sheet = nil }, keep: { sheet = nil })
    case .createTask: HermesTaskEditor(control: control, task: nil, revealTaskGroup: { collapsedTaskStatuses.remove($0) })
    case .taskDetail(let task): HermesTaskDetail(control: control, initial: task)
    case .createTrigger: HermesTriggerEditor(control: control, trigger: nil, reveal: { expandedTriggers.insert($0) })
    case .editTrigger(let trigger): HermesTriggerEditor(control: control, trigger: trigger, reveal: { expandedTriggers.insert($0) })
    case .deleteTrigger(let trigger):
      AssistantConfirmationSheet(title: "Delete this event trigger?", message: "\(trigger.description.isEmpty ? trigger.id : trigger.description) will be removed. Its routine stays saved.",
        acceptLabel: "Delete trigger", keepLabel: "Keep trigger", destructive: true,
        accept: { pendingDeleteTrigger = trigger; sheet = nil }, keep: { sheet = nil })
    }
  }
}

/// A full-width primary action is reserved for an action the person can take now.
private struct HermesGoalActionStyle: ViewModifier {
  var primary: Bool
  @ViewBuilder func body(content: Content) -> some View {
    if primary { content.buttonStyle(.accentProminent) }
    else { content.buttonStyle(.bordered).tint(Color.primary) }
  }
}

private struct HermesGoalSection: View {
  var control: HermesAutomationControls
  var state: HermesAutomationOverview.Goals
  var edit: () -> Void
  var startNewAttempt: () -> Void
  var clear: () -> Void
  @Environment(AppStore.self) private var store
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @State private var reviewedInterruption = false
  private var disabled: Bool { control.disabled || !store.connected }
  private func statusLabel(_ status: String) -> String {
    switch status {
    case "active": "Active"
    case "paused": "Paused"
    case "done": "Done"
    default: status
    }
  }
  @ViewBuilder private func metadata(_ goal: HermesGoal) -> some View {
    let status = statusLabel(goal.status)
    let turns = "\(goal.turnsUsed) of \(goal.maxTurns) turns used"
    VStack(alignment: .leading, spacing: 8) {
      if dynamicTypeSize.isAccessibilitySize {
        VStack(alignment: .leading, spacing: 6) { statusBadge(status); Text(turns).monospacedDigit() }
      } else {
        HStack(alignment: .firstTextBaseline, spacing: 10) { statusBadge(status); Text(turns).monospacedDigit() }
      }
      if let reason = goal.pausedReason, !reason.isEmpty {
        Text(goal.status == "paused" ? "Paused: " + reason : reason)
          .fixedSize(horizontal: false, vertical: true)
      }
    }.font(.subheadline).foregroundStyle(Palette.muted).accessibilityElement(children: .combine)
  }
  private func statusBadge(_ value: String) -> some View {
    Text(value).font(.subheadline.weight(.semibold)).foregroundStyle(Color.primary)
      .padding(.horizontal, 9).padding(.vertical, 4).background(Palette.accentSoft, in: Capsule())
  }
  private func callout(_ title: String, message: String, danger: Bool = false) -> some View {
    let symbol = Image(systemName: danger ? "exclamationmark.circle" : "exclamationmark.triangle")
      .foregroundStyle(danger ? Palette.danger : Palette.attention).accessibilityHidden(true)
    let heading = Text(title).font(.subheadline.weight(.semibold)).accessibilityAddTraits(.isHeader)
      .accessibilityIdentifier("automation.goal.callout.title.\(title)")
    let paragraph = Text(message).font(.subheadline).fixedSize(horizontal: false, vertical: true)
    return Group {
      if dynamicTypeSize.isAccessibilitySize {
        VStack(alignment: .leading, spacing: 8) {
          HStack(alignment: .top, spacing: 10) { symbol; heading }
          paragraph
        }
      } else {
        HStack(alignment: .top, spacing: 10) {
          symbol.padding(.top, 2)
          VStack(alignment: .leading, spacing: 6) { heading; paragraph }
        }
      }
    }.foregroundStyle(Color.primary).accessibilityElement(children: .contain)
  }
  var body: some View {
    Group {
      Section {
        if !state.supported {
          Text(state.reason ?? "Goals are unavailable on this Hermes installation.").foregroundStyle(Palette.muted)
        } else if let goal = state.goal {
          VStack(alignment: .leading, spacing: 10) {
            Text(goal.title).font(.headline).fixedSize(horizontal: false, vertical: true)
            metadata(goal)
          }.padding(.vertical, 4)
          if let receipt = state.resume, receipt.status == "uncertain" || receipt.status == "rejected" {
            callout(receipt.status == "uncertain" ? "Resume not confirmed" : "Resume rejected",
              message: receipt.message ?? (receipt.status == "uncertain"
                ? "Hermes could not confirm this goal continuation. Review the conversation before trying again."
                : "Hermes refused this goal continuation. Review the conversation before trying again."),
              danger: receipt.status == "rejected")
          }
          if goal.status != "done" && goal.status != "active" && state.interruptionPending == true {
            callout("Review interrupted work", message: "Review the interrupted work in this assistant's conversation before resuming.")
            Toggle("I've reviewed the interrupted work in this conversation.", isOn: $reviewedInterruption)
              .disabled(disabled).accessibilityIdentifier("automation.reviewedInterruption")
          }
          if goal.status == "active" {
            Button { Task { _ = await control.changeOK(store, "/goal/pause", [String: String]()) } } label: {
              Text("Pause goal").frame(maxWidth: .infinity, minHeight: 44)
            }.modifier(HermesGoalActionStyle(primary: !disabled)).disabled(disabled).listRowSeparator(.hidden)
          } else if goal.status != "done" {
            let uncertain = state.resume?.status == "uncertain"
            let canResume = !disabled && control.canResume && (state.interruptionPending != true || reviewedInterruption)
            let label = uncertain ? "Check resume status" : control.resumeIntent.requestId == nil ? "Resume goal" : "Retry same resume"
            Button {
              Task { await control.resume(store, reviewedInterruption: state.interruptionPending == true && reviewedInterruption) }
            } label: { Text(label).frame(maxWidth: .infinity, minHeight: 44) }
              .modifier(HermesGoalActionStyle(primary: canResume && !uncertain)).disabled(!canResume).listRowSeparator(.hidden)
            if control.canStartNewResumeAttempt {
              Button(action: startNewAttempt) {
                Text("Start a new resume attempt").frame(maxWidth: .infinity, minHeight: 44)
              }.modifier(HermesGoalActionStyle(primary: !disabled && (uncertain || !control.canResume))).disabled(disabled).listRowSeparator(.hidden)
            }
          }
          Button(action: edit) { Text("Replace goal").frame(maxWidth: .infinity, minHeight: 44) }
            .buttonStyle(.bordered).tint(Color.primary).disabled(disabled).listRowSeparator(.hidden)
        } else {
          Text("No standing goal. A goal continues across turns until it finishes, pauses, or reaches its budget.")
            .foregroundStyle(Palette.muted)
          Button(action: edit) { Text("Set a goal").frame(maxWidth: .infinity, minHeight: 44) }
            .modifier(HermesGoalActionStyle(primary: !disabled)).disabled(disabled).listRowSeparator(.hidden)
        }
      } header: {
        Text("Standing goal").foregroundStyle(Palette.muted)
      }
      .onChange(of: state.interruptionPending) { _, _ in reviewedInterruption = false }
      .onChange(of: state.goal?.status) { _, _ in reviewedInterruption = false }
      if state.supported && state.goal != nil {
        Section {
          Button(role: .destructive, action: clear) {
            let label = Text("Clear goal").frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
            if disabled { label } else { label.foregroundStyle(Palette.danger) }
          }.disabled(disabled).accessibilityIdentifier("automation.goal.clear")
        }
      }
    }
  }
}

private struct HermesNewResumeAttempt: View {
  var control: HermesAutomationControls
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var lifetime = HermesAutomationLifetime()
  @State private var reviewedConversation = false
  @State private var acceptsRepeatedWork = false
  @State private var reviewedInterruption = false
  private var interruptionPending: Bool { control.value?.goals.interruptionPending == true }
  private var admissionMessage: String {
    guard let receipt = control.value?.goals.resume, receipt.status == "uncertain",
      let message = receipt.message, !message.isEmpty else { return "Hermes has not confirmed the earlier attempt." }
    return message
  }
  private var canSubmit: Bool {
    !control.disabled && store.connected && control.canStartNewResumeAttempt
      && reviewedConversation && acceptsRepeatedWork && (!interruptionPending || reviewedInterruption)
  }
  var body: some View {
    NavigationStack {
      Form {
        HermesAutomationStatus(control: control, compact: true, showingReceipt: true)
        Section {
          Text(admissionMessage).font(.subheadline).fixedSize(horizontal: false, vertical: true)
          Text("The earlier attempt may still run. Starting a new attempt can repeat work.")
            .fixedSize(horizontal: false, vertical: true)
          Toggle("I've reviewed this conversation and the unconfirmed attempt.", isOn: $reviewedConversation)
          if interruptionPending {
            Toggle("I've reviewed the interrupted work in this conversation.", isOn: $reviewedInterruption)
          }
          Toggle("I understand a new attempt may repeat work.", isOn: $acceptsRepeatedWork)
          Button {
            let current = lifetime.current
            Task {
              if await control.startNewResumeAttempt(store, reviewedConversation: reviewedConversation,
                acceptsRepeatedWork: acceptsRepeatedWork, reviewedInterruption: interruptionPending && reviewedInterruption, current: current) { dismiss() }
            }
          } label: { Text("Start new attempt").frame(maxWidth: .infinity, minHeight: 44) }
            .modifier(HermesGoalActionStyle(primary: canSubmit)).disabled(!canSubmit).listRowSeparator(.hidden)
            .accessibilityIdentifier("automation.goal.newAttempt.submit")
        } header: {
          Text("Review the conversation first").foregroundStyle(Palette.muted)
        }.disabled(control.disabled || !store.connected)
      }.householdListBackground().navigationTitle("New attempt").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(control.busy) }
        }.interactiveDismissDisabled(control.busy)
        .onAppear { lifetime.appear() }.onDisappear { lifetime.disappear() }
    }
  }
}

private struct HermesGoalEditor: View {
  var control: HermesAutomationControls
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var lifetime = HermesAutomationLifetime()
  @State private var title: String
  @State private var maxTurns: Int
  @State private var confirmingReplacement = false
  @State private var pendingReplacement = false
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
        HermesAutomationStatus(control: control, compact: true)
        Section {
          TextField("What should the assistant work toward?", text: $title, axis: .vertical).lineLimit(4...12)
            .accessibilityLabel("Objective").accessibilityIdentifier("automation.goal.objective")
          Stepper("Continuation turn budget: \(maxTurns)", value: $maxTurns, in: 1...1000)
          Text("Saves paused. Resume the goal when you are ready for the assistant to work.").font(.footnote)
          if replacing { Text(replacementWarning).font(.footnote).foregroundStyle(Palette.danger) }
          if title.utf16.count > 10_000 { Text("Use at most 10,000 characters.").foregroundStyle(Palette.danger) }
        } header: {
          Text("Objective").foregroundStyle(Palette.muted)
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
        .onAppear { lifetime.appear() }.onDisappear { lifetime.disappear() }
        .sheet(isPresented: $confirmingReplacement, onDismiss: {
          if pendingReplacement {
            pendingReplacement = false
            save()
          }
        }) {
          AssistantConfirmationSheet(title: "Replace this standing goal?", message: replacementWarning,
            acceptLabel: "Replace goal", keepLabel: "Keep editing", destructive: true,
            accept: { pendingReplacement = true; confirmingReplacement = false },
            keep: { confirmingReplacement = false })
        }
    }
  }
  private func save() {
    let current = lifetime.current
    Task {
      if await control.changeOK(store, "/goal", HermesGoalInput(title: title, maxTurns: maxTurns), method: "PUT", current: current) { dismiss() }
    }
  }
}

struct HermesTriggerFeedback {
  var id: String; var message: String; var isError: Bool; var action: String
}

struct HermesTaskFeedback {
  var taskId: String
  var message: String
  var isError: Bool
  var edit = false
}

private let hermesTaskStatusOrder = ["blocked", "running", "review", "ready", "todo", "scheduled", "triage"]
func hermesTaskStatusLabel(_ status: String) -> String {
  let labels = ["blocked": "Blocked", "running": "Running", "review": "In review", "ready": "Ready", "todo": "To do", "scheduled": "Scheduled", "triage": "Triage", "done": "Done"]
  return labels[status] ?? status.replacingOccurrences(of: "_", with: " ").capitalized
}
func hermesTaskStatusLess(_ a: String, _ b: String) -> Bool {
  func rank(_ status: String) -> Int {
    if status == "done" { return hermesTaskStatusOrder.count + 1 }
    return hermesTaskStatusOrder.firstIndex(of: status) ?? hermesTaskStatusOrder.count
  }
  let left = rank(a), right = rank(b)
  return left == right ? hermesTaskStatusLabel(a).localizedStandardCompare(hermesTaskStatusLabel(b)) == .orderedAscending : left < right
}

private struct HermesTaskSection: View {
  var control: HermesAutomationControls
  var state: HermesAutomationOverview.Tasks
  @Binding var collapsedStatuses: Set<String>
  var create: () -> Void
  var open: (HermesTask) -> Void
  @Environment(AppStore.self) private var store
  private var statuses: [String] { Set(state.items.map(\.status)).sorted(by: hermesTaskStatusLess) }
  var body: some View {
    Section {
      if !state.supported {
        Text(state.reason ?? "Task boards are unavailable on this Hermes installation.").foregroundStyle(Palette.muted)
      } else {
        if state.truncated == true {
          Text("Showing the newest \(state.limit ?? state.items.count) visible tasks. Older tasks are not shown.")
            .font(.footnote).foregroundStyle(Palette.muted)
        }
        if state.items.isEmpty { Text("No tasks yet.").foregroundStyle(Palette.muted) }
        ForEach(statuses, id: \.self) { status in
          DisclosureGroup(isExpanded: Binding(get: { !collapsedStatuses.contains(status) }, set: { expanded in
            if expanded { collapsedStatuses.remove(status) } else { collapsedStatuses.insert(status) }
          })) {
            ForEach(state.items.filter { $0.status == status }) { task in
              Button { open(task) } label: {
                VStack(alignment: .leading, spacing: 4) {
                  Text(task.title).foregroundStyle(Color.primary)
                  Text(assignee(task.assignee) + (task.priority == 0 ? "" : " · Priority \(task.priority)"))
                    .font(.caption).foregroundStyle(Palette.muted)
                }.padding(.vertical, 4)
              }.accessibilityIdentifier("automation.task.\(task.id)")
            }
          } label: { Text("\(hermesTaskStatusLabel(status)) (\(state.items.filter { $0.status == status }.count))") }
        }
        Button("New task", action: create).disabled(control.disabled || !store.connected)
      }
    } header: {
      Text("Task board").foregroundStyle(Palette.muted)
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
  private enum Field: Hashable { case title, instructions }
  var control: HermesAutomationControls
  var task: HermesTask?
  var revealTaskGroup: (String) -> Void
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var lifetime = HermesAutomationLifetime()
  @State private var draft: HermesTaskDraft
  @State private var intent = HermesTaskCreationIntent()
  @State private var knownIds: Set<String> = []
  @State private var submittedTitle = ""
  @State private var submittedDraft: HermesTaskDraft?
  @State private var uncertainCreate = false
  @FocusState private var focusedField: Field?
  init(control: HermesAutomationControls, task: HermesTask?, revealTaskGroup: @escaping (String) -> Void = { _ in }) {
    self.control = control; self.task = task; self.revealTaskGroup = revealTaskGroup
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
  private var liveTask: HermesTask? { task.flatMap { original in control.value?.tasks.items.first { $0.id == original.id } } }
  private var unavailable: Bool { task != nil && (liveTask == nil || liveTask?.status == "running") }
  private var likely: HermesTask? {
    guard uncertainCreate && !control.needsRefresh && !control.loading else { return nil }
    return hermesLikelyCreatedTask(knownIds, submittedTitle, control.value?.tasks.items ?? [])
  }
  var body: some View {
    NavigationStack {
      Form {
        HermesAutomationStatus(control: control, compact: true, suppressRefreshFootnote: true)
        if let task, let feedback = control.taskFeedback, feedback.taskId == task.id, feedback.edit {
          Section { if feedback.isError { ErrorBanner(message: feedback.message).accessibilityIdentifier("automation.taskFeedback") }
            else { Text(feedback.message).foregroundStyle(Palette.muted).accessibilityIdentifier("automation.taskFeedback") } }
        }
        if task != nil && unavailable {
          Section { Text(liveTask == nil ? "This task is no longer available in the current board." : "A Hermes worker is running this task. You can change it after the run finishes.").foregroundStyle(Palette.muted) }
        }
        if likely != nil {
          Section { Text("A task with this title appeared on the board. Hermes may have saved it. Close this form to review it.").accessibilityIdentifier("automation.taskCreateMatch") }
        } else if uncertainCreate && !control.needsRefresh && !control.loading && submittedDraft == draft {
          Section { Text("No new task with this title is visible. Create task sends the same request again.").foregroundStyle(Palette.muted) }
        }
        fields.disabled(control.disabled || !store.connected || likely != nil || unavailable)
        if task == nil { dependencies.disabled(control.disabled || !store.connected || likely != nil) }
      }.householdListBackground().accessibilityIdentifier("automation.taskEditor").navigationTitle(task == nil ? "New task" : "Edit task")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(control.busy) }
          ToolbarItem(placement: .confirmationAction) {
            if control.busy {
              ProgressView { Text(task == nil ? "Creating" : "Saving").foregroundStyle(Palette.muted) }
            }
            else {
              Button(likely != nil ? "Close" : task == nil ? "Create task" : "Save task") {
                if let likely { revealTaskGroup(likely.status); dismiss() } else { save() }
              }.disabled(control.disabled || !store.connected || (likely == nil && (!draft.valid || !eligibleAssignee || unavailable)))
                .accessibilityIdentifier("automation.saveTask")
            }
          }
          ToolbarItemGroup(placement: .keyboard) {
            Spacer()
            Button { focusedField = nil } label: {
              Image(systemName: "keyboard.chevron.compact.down").font(.body).frame(width: 44, height: 44)
                .contentShape(Rectangle())
            }.buttonStyle(.plain).foregroundStyle(Palette.muted).accessibilityLabel("Hide keyboard")
              .accessibilityIdentifier("automation.taskEditor.hideKeyboard")
          }
        }.interactiveDismissDisabled(control.busy)
        .onChange(of: control.loading) { _, loading in
          if !loading, likely != nil { AccessibilityNotification.Announcement("A task with this title appeared on the board. Hermes may have saved it. Close this form to review it.").post() }
          else if !loading, uncertainCreate, !control.needsRefresh, submittedDraft == draft {
            AccessibilityNotification.Announcement("No new task with this title is visible. Create task sends the same request again.").post()
          }
        }
        .onAppear { lifetime.appear() }.onDisappear { lifetime.disappear() }
    }
  }
  private var fields: some View {
    Section {
      VStack(alignment: .leading) {
        Text("Title")
        TextField("Title", text: $draft.title, prompt: Text("What needs doing?").foregroundStyle(Palette.muted), axis: .vertical).lineLimit(1...4).accessibilityIdentifier("automation.taskTitle")
          .focused($focusedField, equals: .title)
      }
      VStack(alignment: .leading) {
        Text("Instructions (optional)")
        TextField("Instructions", text: $draft.body, prompt: Text("Add instructions").foregroundStyle(Palette.muted), axis: .vertical).lineLimit(4...12).accessibilityIdentifier("automation.taskBody")
          .focused($focusedField, equals: .instructions)
      }
      HermesAssigneePicker(title: "Assigned assistant", selection: assignee, emptyLabel: "Unassigned")
      Stepper("Priority: \(draft.priority)", value: $draft.priority, in: -100...100)
      if draft.title.utf16.count > 500 { Text("Use at most 500 characters for the title.").foregroundStyle(Palette.danger) }
      if draft.body.utf16.count > 20_000 { Text("Use at most 20,000 characters for the instructions.").foregroundStyle(Palette.danger) }
      if task == nil { Text("Creates a blocked task. Start it explicitly when the instructions are ready.").font(.footnote).foregroundStyle(Palette.muted) }
    } header: { Text("Task").foregroundStyle(Palette.muted) }
  }
  private var dependencies: some View {
    Section {
      if control.value?.tasks.items.isEmpty != false { Text("No other tasks yet.").foregroundStyle(Palette.muted) }
      ForEach((control.value?.tasks.items ?? []).filter { $0.id != likely?.id }) { item in
        Toggle(isOn: Binding(get: { draft.dependencies.contains(item.id) }, set: { selected in
          if selected { if !draft.dependencies.contains(item.id) { draft.dependencies.append(item.id) } }
          else { draft.dependencies.removeAll { $0 == item.id } }
        })) { VStack(alignment: .leading) { Text(item.title); Text(hermesTaskStatusLabel(item.status)).font(.caption).foregroundStyle(Palette.muted) } }
          .disabled(!draft.dependencies.contains(item.id) && draft.dependencies.count >= 20)
      }
      Text("Choose up to 20 dependencies.").font(.footnote).foregroundStyle(Palette.muted)
    } header: { Text("Wait for these tasks (optional)").foregroundStyle(Palette.muted) }
  }
  private func save() {
    let current = lifetime.current
    Task {
      let result: HermesTask?
      if let task {
        result = await control.changeTask(store, taskId: task.id, "/tasks/\(APIClient.component(task.id))", HermesTaskUpdate(draft), method: "PATCH", edit: true, current: current)
      } else {
        knownIds = Set((control.value?.tasks.items ?? []).map(\.id))
        submittedTitle = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
        submittedDraft = draft
        let request = intent.prepare(draft)
        result = await control.change(store, "/tasks", request, current: current)
        if result == nil && control.needsRefresh { uncertainCreate = true }
      }
      if let result {
        if task == nil { revealTaskGroup(result.status); AccessibilityNotification.Announcement("Created \(result.title) in \(hermesTaskStatusLabel(result.status)).").post() }
        dismiss()
      }
    }
  }
}

private struct HermesTaskDetail: View {
  var control: HermesAutomationControls
  var initial: HermesTask
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @State private var lifetime = HermesAutomationLifetime()
  @State private var editing = false
  @State private var actionForm: ActionForm?
  @State private var reason = ""
  @State private var startNote = ""
  @State private var showStartNote = false
  @State private var reviewer = ""
  @State private var dependency = ""
  private enum ActionForm { case block, review }
  private var task: HermesTask { control.value?.tasks.items.first { $0.id == initial.id } ?? initial }
  private var running: Bool { task.status == "running" }
  private var disabled: Bool {
    control.disabled || !store.connected || control.value?.tasks.items.contains { $0.id == initial.id } != true
  }
  private var path: String { "/tasks/\(APIClient.component(initial.id))" }
  var body: some View {
    NavigationStack {
      ScrollViewReader { scroll in
      Form {
        if !control.busy { HermesAutomationStatus(control: control, compact: true) }
        summary
        dependencies
        actions
      }.householdListBackground().accessibilityIdentifier("automation.taskDetail").navigationTitle("Task details").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() }.disabled(control.busy) } }
        .sheet(isPresented: $editing) { HermesTaskEditor(control: control, task: task) }
        .interactiveDismissDisabled(control.busy)
        .onChange(of: control.busy) { _, busy in
          guard !busy, control.taskFeedback?.taskId == initial.id else { return }
          Task { @MainActor in
            await Task.yield()
            guard !control.busy, control.taskFeedback?.taskId == initial.id else { return }
            scroll.scrollTo(resultID, anchor: .bottom)
          }
        }
        .onAppear { lifetime.appear() }.onDisappear {
          lifetime.disappear()
          if control.taskFeedback?.taskId == initial.id { control.taskFeedback = nil }
        }
      }
    }
  }
  private var summary: some View {
    Section {
      Text(task.title).font(.headline)
      Text(task.body.isEmpty ? "No additional instructions." : task.body).textSelection(.enabled)
      LabeledContent("Status") { Text(hermesTaskStatusLabel(task.status)).foregroundStyle(Palette.muted) }
        .accessibilityElement(children: .ignore).accessibilityLabel("Task status").accessibilityValue(hermesTaskStatusLabel(task.status))
        .accessibilityIdentifier("automation.taskStatus")
      LabeledContent("Assigned assistant") { Text(store.bootstrap?.bots.first { $0.id == task.assignee }?.name ?? task.assignee ?? "Unassigned").foregroundStyle(Palette.muted) }
      if task.priority != 0 { LabeledContent("Priority") { Text("\(task.priority)").foregroundStyle(Palette.muted) } }
      if let reason = task.blockedReason {
        Label { Text("Blocked: \(reason)") } icon: { Image(systemName: "exclamationmark.triangle").accessibilityHidden(true) }
          .font(.subheadline).foregroundStyle(Palette.attention)
      }
      if control.value?.tasks.items.contains(where: { $0.id == initial.id }) != true {
        Text("This task is no longer available in the current board.").foregroundStyle(Palette.muted)
      }
      if !running { Button("Edit task") { control.taskFeedback = nil; editing = true }.disabled(disabled) }
      if control.taskFeedback?.edit == true { resultNotice }
    }
  }
  private var actions: some View {
    Section {
      if running {
        Text("A Hermes worker is running this task. You can change it after the run finishes.").foregroundStyle(Palette.muted)
      } else {
        Button("Start task") { action(.start) }
          .disabled(disabled || (showStartNote && startNote.utf16.count > 2000))
          .fontWeight(task.status == "blocked" || task.status == "todo" ? .semibold : .regular)
        Button("Block task…") { actionForm = .block; reason = ""; startNote = ""; showStartNote = false }.disabled(disabled)
        Button("Request review…") { actionForm = .review; reason = ""; reviewer = ""; startNote = ""; showStartNote = false }.disabled(disabled)
        if control.taskFeedback?.edit != true { resultNotice }
        if actionForm == .block {
          VStack(alignment: .leading) {
            Text("What is blocking this task?")
            TextField("What is blocking this task?", text: $reason, prompt: Text("Blocking reason").foregroundStyle(Palette.muted), axis: .vertical).lineLimit(2...6)
          }.disabled(disabled)
          Button("Block task") { action(.block) }.fontWeight(.semibold).disabled(disabled || !hasReason)
          Button("Cancel") { actionForm = nil; reason = "" }.disabled(disabled)
        } else if actionForm == .review {
          if dynamicTypeSize.isAccessibilitySize {
            HermesAssigneePicker(title: "Reviewer", selection: $reviewer, emptyLabel: "Choose an assistant").pickerStyle(.inline).disabled(disabled)
          } else {
            HermesAssigneePicker(title: "Reviewer", selection: $reviewer, emptyLabel: "Choose an assistant").disabled(disabled)
          }
          VStack(alignment: .leading) {
            Text("Notes for the reviewer (optional)")
            TextField("Notes for the reviewer (optional)", text: $reason, prompt: Text("Review notes").foregroundStyle(Palette.muted), axis: .vertical).lineLimit(2...6)
          }.disabled(disabled)
          Button("Request review") { action(.requestReview) }
            .fontWeight(.semibold)
            .disabled(disabled || reviewer.isEmpty || store.bootstrap?.bots.contains { $0.id == reviewer } != true || reason.utf16.count > 2000)
          Button("Cancel") { actionForm = nil; reason = ""; reviewer = "" }.disabled(disabled)
        } else {
          DisclosureGroup("Add an optional start note", isExpanded: $showStartNote) {
            VStack(alignment: .leading) {
              Text("Start note (optional)")
              TextField("Start note", text: $startNote, prompt: Text("Start note").foregroundStyle(Palette.muted), axis: .vertical).lineLimit(2...6)
            }.disabled(disabled)
          }
        }
        if reason.utf16.count > 2000 || (showStartNote && startNote.utf16.count > 2000) { Text("Use at most 2,000 characters.").foregroundStyle(Palette.danger) }
        if task.status == "review" {
          Text("The reviewing assistant can request changes through Hermes while it owns the review.").font(.footnote).foregroundStyle(Palette.muted)
        }
      }
      if running && control.taskFeedback?.edit != true { resultNotice }
      if !running { Text("Hermes checks the task's current state and dependencies before changing it.").font(.footnote).foregroundStyle(Palette.muted) }
    } header: {
      Text("Move task").foregroundStyle(Palette.muted)
    }
  }
  private var resultID: String { "task-result-\(initial.id)" }
  @ViewBuilder private var resultNotice: some View {
    if let feedback = control.taskFeedback, feedback.taskId == initial.id {
      Group {
        if feedback.isError { ErrorBanner(message: feedback.message).accessibilityElement(children: .combine).accessibilityIdentifier("automation.taskFeedback") }
        else { Text(feedback.message).font(.footnote).foregroundStyle(Palette.muted).accessibilityAddTraits(.updatesFrequently).accessibilityIdentifier("automation.taskFeedback") }
      }.id(resultID)
    }
  }
  private var dependencies: some View {
    Section {
      if task.dependencies.isEmpty { Text("None.").foregroundStyle(Palette.muted) }
      ForEach(task.dependencies, id: \.self) { id in
        let parent = control.value?.tasks.items.first { $0.id == id }
        VStack(alignment: .leading) {
          Text(parent.map { "\($0.title) · \(hermesTaskStatusLabel($0.status))" } ?? id)
          if !running {
            Button(role: .destructive) { changeDependency(id, remove: true) } label: {
              if disabled { Text("Remove dependency") }
              else { Text("Remove dependency").foregroundStyle(Palette.danger) }
            }.disabled(disabled).accessibilityLabel("Remove dependency on \(parent?.title ?? id)")
          }
        }
      }
      if !running {
        Picker("Wait for task", selection: $dependency) {
          Text("Choose a task").tag("")
          ForEach((control.value?.tasks.items ?? []).filter { $0.id != task.id && !task.dependencies.contains($0.id) }) { item in
            Text(item.title).tag(item.id)
          }
        }.disabled(disabled)
        Button("Add dependency") { changeDependency(dependency, remove: false) }
          .disabled(disabled || dependency.isEmpty || task.dependencies.count >= 20)
      }
    } header: {
      Text("Dependencies").foregroundStyle(Palette.muted)
    }
  }
  private var hasReason: Bool { !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && reason.utf16.count <= 2000 }
  private func action(_ value: HermesTaskAction.Action) {
    let note = value == .start ? (showStartNote ? startNote : "") : reason
    let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
    let input = HermesTaskAction(action: value, reason: trimmed.isEmpty ? nil : trimmed,
      reviewer: value == .requestReview && !reviewer.isEmpty ? reviewer : nil)
    let current = lifetime.current
    Task {
      let result = await control.changeTask(store, taskId: task.id, path + "/actions", input, moved: true, current: current)
      if result != nil { reason = ""; startNote = ""; reviewer = ""; actionForm = nil }
    }
  }
  private func changeDependency(_ id: String, remove: Bool) {
    let current = lifetime.current
    Task {
      let result = await control.changeTask(store, taskId: task.id, path + "/dependencies/\(APIClient.component(id))", HermesDependencyInput(remove: remove), method: "PUT", current: current)
      if result != nil { dependency = "" }
    }
  }
}
