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
