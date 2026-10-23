#if DEBUG
import Foundation

/// Synthetic transport state only. FixtureProtocol holds its lock for every access.
struct AutomationDebugFixture {
  private var goal: [String: Any] = ["title": "Inspect the north pasture", "status": "paused", "turnsUsed": 4, "maxTurns": 20]
  private var resume: [String: Any]?
  private var tasks: [[String: Any]] = []
  private var taskRequests: [String: String] = [:]
  private var pending = true
  private var approvalRequired = true
  private var interruptionPending = ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_AUTOMATION_INTERRUPTED"] == "1"
  private var policyFailures = ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_AUTOMATION_POLICY_FAILURE"] == "1" ? 1 : 0
  private var readOnlyPolicy: Bool { ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_AUTOMATION_READONLY_POLICY"] == "1" }
  private let detailRevision = String(repeating: "d", count: 64)
  private let base = "/api/bots/ranch/automation"
  private var overview: [String: Any] {
    var goals: [String: Any] = ["supported": true, "goal": goal.isEmpty ? NSNull() as Any : goal, "interruptionPending": interruptionPending]
    if let resume { goals["resume"] = resume }
    return ["botId": "ranch", "owner": "Hermes", "canManageTriggers": true, "canManageLearningPolicy": !readOnlyPolicy,
      "goals": goals, "tasks": ["supported": true, "items": tasks],
      "triggers": ["supported": true, "items": [], "platformEnabled": false],
      "skills": ["supported": true, "installed": [["name": "ranch/fences", "description": "Fixture pasture inspection instructions"]],
        "pending": pending ? [["id": "deadbeef", "summary": "Add fixture gate check", "origin": "agent", "revision": String(repeating: "c", count: 64)]] : [],
        "approvalRequired": approvalRequired]]
  }
  mutating func response(path: String, method: String, body: [String: Any], url: URL) -> (status: Int, object: Any)? {
    guard ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_AUTOMATION"] == "1",
      path == base || path.hasPrefix(base + "/") else { return nil }
    if path == base { return (200, overview) }
    if path == base + "/goal/resume" {
      guard let id = body["requestId"] as? String, UUID(uuidString: id) != nil else {
        return (400, ["error": "A stable resume UUID is required."])
      }
      if resume?["requestId"] as? String == id { return (200, overview) }
      if interruptionPending && body["reviewedInterruption"] as? Bool != true {
        return (409, ["error": "Review the interrupted conversation before resuming."])
      }
      let rejected = ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_AUTOMATION_REJECT_RESUME"] == "1"
      resume = ["requestId": id, "status": rejected ? "rejected" : "accepted",
        "message": rejected ? "Fixture continuation refused. The goal remains paused." : "Fixture continuation accepted."]
      goal["status"] = rejected ? "paused" : "active"
      if !rejected { goal["turnsUsed"] = 0; interruptionPending = false; resume?["runId"] = "fixture-goal-run" }
      return (200, overview)
    }
    if path == base + "/goal/pause" { goal["status"] = "paused"; return (200, overview) }
    if path == base + "/goal/clear" { goal = [:]; return (200, overview) }
    if path == base + "/goal" {
      goal = ["title": body["title"] ?? "", "maxTurns": body["maxTurns"] ?? 20, "turnsUsed": 0, "status": "paused"]
      return (200, overview)
    }
    if path == base + "/tasks", method == "POST" {
      guard let requestId = body["requestId"] as? String, UUID(uuidString: requestId) != nil else {
        return (400, ["error": "A stable task UUID is required."])
      }
      if let id = taskRequests[requestId], let task = tasks.first(where: { $0["id"] as? String == id }) { return (200, task) }
      let id = "fixture-task-\(tasks.count + 1)"
      let task: [String: Any] = ["id": id, "title": body["title"] ?? "", "body": body["body"] ?? "", "priority": body["priority"] ?? 0,
        "assignee": body["assignee"] ?? "ranch", "owner": "ranch", "status": "blocked", "dependencies": body["dependencies"] ?? []]
      taskRequests[requestId] = id; tasks.append(task)
      return (200, task)
    }
    if path.hasPrefix(base + "/tasks/") {
      let segments = path.dropFirst((base + "/tasks/").count).split(separator: "/")
      guard let id = segments.first.map(String.init), let index = tasks.firstIndex(where: { $0["id"] as? String == id }) else {
        return (404, ["error": "Fixture task not found."])
      }
      if path.hasSuffix("/actions") {
        let action = body["action"] as? String
        tasks[index]["status"] = action == "start" || action == "unblock" ? "ready" : action == "request_review" ? "in_review" : "blocked"
      } else if method == "PATCH" {
        for key in ["title", "body", "priority", "assignee"] { if let value = body[key] { tasks[index][key] = value } }
      }
      return (200, tasks[index])
    }
    if path == base + "/skills/content" {
      let name = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "name" }?.value ?? "ranch/fences"
      return (200, ["name": name, "content": "# Fixture fence inspection\nCheck the north gate.", "truncated": false])
    }
    if path == base + "/skills/pending/deadbeef" {
      if method == "GET" { return (200, ["id": "deadbeef", "diff": "+Check the north gate before opening the pasture.", "revision": detailRevision, "truncated": false]) }
      guard body["revision"] as? String == detailRevision else { return (409, ["error": "Use the loaded diff revision, not the list revision."]) }
      pending = false
      return (200, ["ok": true])
    }
    if path == base + "/skills/policy" {
      if readOnlyPolicy { return (403, ["error": "Only an integration administrator can change the skill write policy."]) }
      if policyFailures > 0 { policyFailures -= 1; return (503, ["error": "Fixture policy response lost."]) }
      approvalRequired = body["approvalRequired"] as? Bool ?? true
      return (200, ["ok": true])
    }
    if path == base + "/triggers", method == "POST" {
      return (200, ["subscription": ["id": body["id"] ?? "fixture-event", "description": body["description"] ?? "",
        "events": body["events"] ?? ["fixture.event"], "routineId": body["routineId"] ?? "trial", "enabled": false,
        "url": "https://synthetic.invalid/webhook/fixture-event", "secretSet": true, "revision": String(repeating: "b", count: 64)],
        "secret": "synthetic-ui-signing-secret"])
    }
    return (404, ["error": "No synthetic automation response for this operation."])
  }
}
#endif
