import Foundation

// The profile controls use a different contract from the household /automations overview.
struct HermesAutomationOverview: Decodable {
  var botId: String
  var owner: String
  var canManageTriggers: Bool?
  var canManageLearningPolicy: Bool?
  var goals: Goals
  var tasks: Tasks
  var triggers: Triggers
  var skills: Skills
  struct Goals: Decodable {
    var supported: Bool; var reason: String?; var goal: HermesGoal?
    var resume: HermesGoalResumeReceipt?; var interruptionPending: Bool?
  }
  struct Tasks: Decodable {
    var supported: Bool; var reason: String?; var items: [HermesTask]
    var truncated: Bool?; var limit: Int?
  }
  struct Triggers: Decodable {
    var supported: Bool; var reason: String?; var items: [HermesSubscription]; var platformEnabled: Bool
  }
  struct Skills: Decodable {
    var supported: Bool; var reason: String?; var installed: [HermesInstalledSkill]
    var pending: [HermesPendingSkill]; var approvalRequired: Bool
  }
}
struct HermesGoal: Decodable {
  var title: String; var status: String; var turnsUsed: Int; var maxTurns: Int; var pausedReason: String?
}
struct HermesGoalResumeReceipt: Decodable {
  var requestId: String; var status: String; var runId: String?; var message: String?
}
struct HermesGoalResumeInput: Encodable { var requestId: String; var reviewedInterruption: Bool? }
struct HermesGoalResumeIntent {
  private(set) var requestId: String?
  init(requestId: String? = nil) {
    self.requestId = requestId.flatMap { UUID(uuidString: $0) == nil ? nil : $0 }
  }
  mutating func prepare(reviewedInterruption: Bool = false) -> HermesGoalResumeInput {
    if requestId == nil { requestId = UUID().uuidString }
    return HermesGoalResumeInput(requestId: requestId!, reviewedInterruption: reviewedInterruption ? true : nil)
  }
  mutating func resolve(_ receipt: HermesGoalResumeReceipt?) {
    guard let receipt, receipt.requestId == requestId,
      ["accepted", "rejected"].contains(receipt.status) else { return }
    requestId = nil
  }
}
struct HermesTask: Decodable, Identifiable {
  var id: String; var title: String; var body: String; var status: String; var priority: Int
  var assignee: String?; var owner: String; var dependencies: [String]; var blockedReason: String?
}
func hermesLikelyCreatedTask(_ knownIds: Set<String>, _ title: String, _ items: [HermesTask]) -> HermesTask? {
  items.first { !knownIds.contains($0.id) && $0.title == title }
}
struct HermesSubscription: Decodable, Identifiable {
  var id: String; var description: String; var events: [String]; var routineId: String
  var enabled: Bool; var url: String; var secretSet: Bool; var revision: String
}
func hermesLikelyCreatedTrigger(_ knownIds: Set<String>, _ draftId: String, _ items: [HermesSubscription]) -> HermesSubscription? {
  guard !knownIds.contains(draftId) else { return nil }
  return items.first { $0.id == draftId }
}
func hermesTriggerSubtitle(_ trigger: HermesSubscription, routines: [Routine], loading: Bool, error: String?) -> String {
  let status = trigger.enabled ? "Enabled" : "Disabled"
  if loading { return status + " · Routine loading…" }
  if error != nil { return status + " · Routine ID: " + trigger.routineId }
  guard let routine = routines.first(where: { $0.id == trigger.routineId }) else { return status + " · Routine not found" }
  return status + " · " + routine.name + (routine.enabled ? "" : " (paused)")
}
struct HermesInstalledSkill: Decodable, Identifiable {
  var name: String; var description: String
  var id: String { name }
}
struct HermesPendingSkill: Decodable, Identifiable {
  var id: String; var summary: String; var origin: String; var revision: String
}
struct HermesSkillContent: Decodable { var name: String; var content: String; var truncated: Bool }
struct HermesSkillDiff: Decodable {
  var id: String; var diff: String; var revision: String; var truncated: Bool
  /// A decision always names the revision of the actual displayed diff, never the list row.
  func decision(_ value: HermesSkillDecision.Choice) -> HermesSkillDecision? {
    guard value != .approve || !truncated else { return nil }
    return HermesSkillDecision(revision: revision, decision: value)
  }
}
struct HermesSkillDecision: Encodable {
  enum Choice: String, Encodable { case approve, reject }
  var revision: String; var decision: Choice
}
struct HermesGoalInput: Encodable { var title: String; var maxTurns: Int }
struct HermesTaskDraft: Encodable, Equatable {
  var title = ""; var body = ""; var priority = 0; var assignee: String?
  var dependencies: [String] = []
  var valid: Bool {
    !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && title.utf16.count <= 500 && body.utf16.count <= 20_000
      && (-100...100).contains(priority) && dependencies.count <= 20
  }
}
struct HermesTaskCreate: Encodable {
  var requestId: String; var title: String; var body: String; var priority: Int
  var assignee: String?; var dependencies: [String]
  init(draft: HermesTaskDraft, requestId: String) {
    self.requestId = requestId; title = draft.title; body = draft.body
    priority = draft.priority; assignee = draft.assignee; dependencies = draft.dependencies
  }
  enum CodingKeys: String, CodingKey { case requestId, title, body, priority, assignee, dependencies }
  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(requestId, forKey: .requestId); try c.encode(title, forKey: .title)
    try c.encode(body, forKey: .body); try c.encode(priority, forKey: .priority)
    try c.encode(assignee, forKey: .assignee); try c.encode(dependencies, forKey: .dependencies)
  }
}
/// Preparing the same create intent again preserves the UUID after an unconfirmed response.
/// A deliberate edit creates a different intent. Nothing prepares or resends itself.
struct HermesTaskCreationIntent {
  private var draft: HermesTaskDraft?
  private var request: HermesTaskCreate?
  mutating func prepare(_ value: HermesTaskDraft) -> HermesTaskCreate {
    if value == draft, let request { return request }
    let next = HermesTaskCreate(draft: value, requestId: UUID().uuidString)
    draft = value; request = next
    return next
  }
}
struct HermesTaskUpdate: Encodable {
  var title: String; var body: String; var priority: Int; var assignee: String?
  init(_ draft: HermesTaskDraft) {
    title = draft.title; body = draft.body; priority = draft.priority; assignee = draft.assignee
  }
  enum CodingKeys: String, CodingKey { case title, body, priority, assignee }
  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(title, forKey: .title); try c.encode(body, forKey: .body)
    try c.encode(priority, forKey: .priority)
    // Explicit null clears the assignment. An omitted field would preserve it.
    try c.encode(assignee, forKey: .assignee)
  }
}
struct HermesTaskAction: Encodable {
  enum Action: String, Encodable { case start, block, unblock, requestReview = "request_review" }
  var action: Action; var reason: String?; var reviewer: String?
}
struct HermesDependencyInput: Encodable { var remove: Bool }
struct HermesTriggerInput: Encodable {
  var id: String; var description: String; var events: [String]; var routineId: String
  var idProblem: String? {
    guard !id.isEmpty else { return nil }
    return id.range(of: #"^[a-z0-9][a-z0-9_-]{0,79}$"#, options: .regularExpression) == nil
      ? "Use 1 to 80 lowercase letters, digits, underscores or hyphens. Start with a letter or digit." : nil
  }
  var eventsProblem: String? {
    let completed = events.last == "" ? Array(events.dropLast()) : events
    guard !completed.isEmpty else { return nil }
    if completed.count > 20 { return "Use at most 20 event names." }
    if completed.contains(where: { $0.range(of: #"^[A-Za-z0-9_.*:-]{1,100}$"#, options: .regularExpression) == nil }) {
      return "Each event name must use 1 to 100 letters, digits, _, ., *, : or -."
    }
    return nil
  }
  var valid: Bool {
    !id.isEmpty && idProblem == nil && description.utf16.count <= 1000 && !routineId.isEmpty
      && (1...20).contains(events.count) && events.allSatisfy { !$0.isEmpty } && eventsProblem == nil
  }
}
struct HermesTriggerUpdate: Encodable {
  var description: String; var events: [String]; var routineId: String; var revision: String
  init(_ value: HermesTriggerInput, revision: String) {
    description = value.description; events = value.events; routineId = value.routineId
    self.revision = revision
  }
}
struct HermesTriggerToggle: Encodable { var enabled: Bool; var revision: String }
struct HermesRevisionInput: Encodable { var revision: String }
struct HermesPolicyInput: Encodable { var approvalRequired: Bool }
struct HermesTriggerResult: Decodable { var subscription: HermesSubscription; var secret: String? }

/// Deliberately not Codable. Signing secrets exist only while the foreground Work tab is open.
struct HermesTransientSecret {
  private(set) var triggerId: String?
  private(set) var value: String?
  private(set) var url: String?
  private(set) var revealed = false
  private(set) var inspected = false
  mutating func receive(_ result: HermesTriggerResult) {
    guard let secret = result.secret else { return }
    value = secret; url = result.subscription.url; triggerId = result.subscription.id; revealed = false; inspected = false
  }
  mutating func reveal(_ show: Bool) { revealed = value != nil && show; if revealed { inspected = true } }
  mutating func markCopied() { if value != nil { inspected = true } }
  mutating func clear() { value = nil; url = nil; triggerId = nil; revealed = false; inspected = false }
}
