#if DEBUG
import Foundation
import CryptoKit

/// Design-only transport. The adapter vocabulary is assumed from c3a0ee37/d23cc6b0;
/// the production 41dfcf2c native source was unavailable for this fixture.
struct WorkDesignFixture {
  private var overview: [String: Any]
  private let fixture: [String: Any]
  private let mode: String
  private var resumes: [String: [String: Any]] = [:]
  private var tasksByRequest: [String: [String: Any]] = [:]
  private var routes: [String: [String: Any]] = [:]
  private(set) var reads = 0
  private(set) var writes = 0
  init(_ fixture: [String: Any]) {
    self.fixture = fixture
    mode = fixture["mode"] as? String ?? "loaded"
    let states = fixture["workStates"] as! [String: [String: Any]]
    overview = states[mode] ?? fixture["work"] as! [String: Any]
    let config = fixture["workFixture"] as! [String: Any]
    let rawRoutes = config["triggerRoutes"] as! [[String: Any]]
    let triggers = ((fixture["work"] as! [String: Any])["triggers"] as! [String: Any])["items"] as! [[String: Any]]
    for (index, trigger) in triggers.enumerated() { routes[trigger["id"] as! String] = rawRoutes[index] }
  }
  private var messages: [String: String] { fixture["workMessages"] as! [String: String] }
  private var config: [String: Any] { fixture["workFixture"] as! [String: Any] }
  private func error(_ key: String, _ status: Int = 409) -> (status: Int, object: Any) { (status, ["error": messages[key]!]) }
  private func exact(_ body: [String: Any], _ required: [String], _ optional: [String] = []) {
    let keys = Set(body.keys)
    precondition(Set(required).isSubset(of: keys) && keys.isSubset(of: Set(required + optional)), "Unexpected Work body keys: \(keys.sorted())")
  }
  private func digest(_ route: [String: Any]) -> String {
    let data = try! JSONSerialization.data(withJSONObject: route, options: [.sortedKeys, .withoutEscapingSlashes])
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
  private func audit(_ event: [String: Any]) {
    guard let path = ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_WORK_AUDIT_PATH"] else { return }
    let data = try! JSONSerialization.data(withJSONObject: event, options: [.sortedKeys])
    let handle = try! FileHandle(forWritingTo: URL(fileURLWithPath: path))
    defer { try? handle.close() }
    try! handle.seekToEnd(); try! handle.write(contentsOf: data + Data("\n".utf8))
  }
  mutating func response(path: String, method: String, body: [String: Any]) -> (status: Int, object: Any)? {
    let prefix = "/api/bots/ranch/automation"
    guard path.hasPrefix(prefix) else { return nil }
    let suffix = String(path.dropFirst(prefix.count))
    if suffix.isEmpty && method == "GET" {
      reads += 1; print("DESIGN_WORK_READ count=\(reads) mode=\(mode)")
      audit(["method": method, "path": suffix, "read": reads])
      if mode == "load-error" { return error("noRuntime") }
      if mode == "trigger-external-change" && reads == 2 {
        var triggers = overview["triggers"] as! [String: Any], items = triggers["items"] as! [[String: Any]]
        let index = items.firstIndex { $0["id"] as? String == "freezer-alerts" }!
        let external = config["externalTriggerEdit"] as! [String: String]
        routes["freezer-alerts"]!["description"] = external["description"]!
        items[index]["description"] = external["description"]!; items[index]["revision"] = digest(routes["freezer-alerts"]!)
        precondition(items[index]["revision"] as? String == external["revision"])
        triggers["items"] = items; overview["triggers"] = triggers
      }
      return (200, overview)
    }
    var goals = overview["goals"] as! [String: Any]
    if method != "GET" {
      writes += 1
      print("DESIGN_WORK_WRITE \(method) \(suffix) \(body.keys.sorted()) requestId=\(body["requestId"] as? String ?? "-")")
      audit(["method": method, "path": suffix, "body": body])
    }
    if suffix == "/goal" && method == "PUT" {
      exact(body, ["title", "maxTurns"])
      guard let title = body["title"] as? String, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
        title.utf16.count <= 10000, let turns = body["maxTurns"] as? Int, (1...1000).contains(turns) else { fatalError("Invalid Work goal") }
      goals["goal"] = ["title": title.trimmingCharacters(in: .whitespacesAndNewlines), "status": "paused", "turnsUsed": 0, "maxTurns": turns, "pausedReason": messages["createdPaused"]!]
      goals.removeValue(forKey: "resume"); resumes.removeAll(); overview["goals"] = goals; return (200, overview)
    }
    if ["/goal/pause", "/goal/clear"].contains(suffix) && method == "POST" {
      exact(body, []); guard var goal = goals["goal"] as? [String: Any] else { fatalError("Missing Work goal") }
      if suffix == "/goal/clear" { goals["goal"] = NSNull(); goals.removeValue(forKey: "resume"); resumes.removeAll() }
      else { goal["status"] = "paused"; goals["goal"] = goal }
      overview["goals"] = goals; return (200, overview)
    }
    if suffix == "/goal/resume" && method == "POST" {
      exact(body, ["requestId"], ["reviewedInterruption"])
      guard let id = body["requestId"] as? String, UUID(uuidString: id) != nil,
        body["reviewedInterruption"] == nil || body["reviewedInterruption"] is Bool else { fatalError("Invalid Work resume") }
      if resumes[id] != nil { return (200, overview) }
      if goals["interruptionPending"] as? Bool == true && body["reviewedInterruption"] as? Bool != true { return error("interruption") }
      guard var goal = goals["goal"] as? [String: Any], goal["status"] as? String == "paused" else { fatalError("Resume requires paused goal") }
      let status = mode == "resume-uncertain" && resumes.isEmpty ? "uncertain" : mode == "resume-rejected" ? "rejected" : "accepted"
      var receipt: [String: Any] = ["requestId": id, "status": status]
      if status == "uncertain" { receipt["message"] = messages["uncertainResume"]! }
      else if status == "rejected" { receipt["message"] = messages["rejectedResume"]! }
      else { receipt["runId"] = "fixture-run"; goal["status"] = "active"; goal["turnsUsed"] = 0; goal.removeValue(forKey: "pausedReason"); goals["interruptionPending"] = false }
      if status != "accepted" { goal["turnsUsed"] = 0; goal["pausedReason"] = messages["resumeNotConfirmed"]! }
      goals["goal"] = goal; goals["resume"] = receipt; overview["goals"] = goals; resumes[id] = overview
      return (200, overview)
    }
    return otherResponse(suffix: suffix, method: method, body: body)
  }
  private mutating func otherResponse(suffix: String, method: String, body: [String: Any]) -> (status: Int, object: Any) {
    let parts = suffix.split(separator: "/").map(String.init)
    var taskSection = overview["tasks"] as! [String: Any]
    var tasks = taskSection["items"] as! [[String: Any]]
    let botIds = Set((fixture["bots"] as! [[String: Any]]).map { $0["id"] as! String })
    func persistTasks() { taskSection["items"] = tasks; overview["tasks"] = taskSection }
    if parts == ["tasks"] && method == "POST" {
      exact(body, ["requestId", "title"], ["body", "priority", "assignee", "dependencies"])
      guard let id = body["requestId"] as? String, UUID(uuidString: id) != nil,
        let title = body["title"] as? String, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, title.utf16.count <= 500 else { fatalError("Invalid Work task") }
      if let previous = tasksByRequest[id] {
        return (200, tasks.first { $0["id"] as? String == previous["id"] as? String }!)
      }
      precondition(body["dependencies"] == nil || body["dependencies"] is [String])
      precondition(body["body"] == nil || body["body"] is String)
      precondition(body["priority"] == nil || body["priority"] is Int)
      let dependencies = body["dependencies"] as? [String] ?? []
      precondition(dependencies.count <= 20 && dependencies.allSatisfy { id in tasks.contains { $0["id"] as? String == id } })
      let assignee = body["assignee"] ?? "ranch"
      precondition(assignee is NSNull || (assignee as? String).map(botIds.contains) == true)
      let priority = body["priority"] as? Int ?? 0, text = body["body"] as? String ?? ""
      precondition((-100...100).contains(priority) && text.utf16.count <= 20000)
      let task: [String: Any] = ["id": String(format: "t_%08x", tasks.count + 1), "title": title.trimmingCharacters(in: .whitespacesAndNewlines), "body": text, "priority": priority, "assignee": assignee, "owner": "ranch", "dependencies": dependencies, "status": "blocked"]
      if (fixture["workFixture"] as? [String: Any])?["taskOrder"] as? String == "newest-first" { tasks.insert(task, at: 0) } else { tasks.append(task) }; persistTasks(); tasksByRequest[id] = task
      return mode == "task-create-uncertain" ? error("catchAll", 502) : (200, task)
    }
    if parts.count >= 2 && parts[0] == "tasks" {
      guard let index = tasks.firstIndex(where: { $0["id"] as? String == parts[1] }) else { fatalError("Unknown Work task") }
      if parts.count == 2 && method == "GET" { return (200, tasks[index]) }
      if tasks[index]["status"] as? String == "running" { return error("claimedTask") }
      if parts.count == 2 && method == "PATCH" {
        exact(body, [], ["title", "body", "priority", "assignee"]); precondition(!body.isEmpty)
        precondition(body["title"] == nil || body["title"] is String)
        precondition(body["body"] == nil || body["body"] is String)
        precondition(body["priority"] == nil || body["priority"] is Int)
        if let title = body["title"] as? String { precondition(!title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && title.utf16.count <= 500) }
        if let text = body["body"] as? String { precondition(text.utf16.count <= 20000) }
        if let priority = body["priority"] as? Int { precondition((-100...100).contains(priority)) }
        if let assignee = body["assignee"] { precondition(assignee is NSNull || (assignee as? String).map(botIds.contains) == true) }
        if mode == "task-edit-refreshed-running" {
          tasks[index]["status"] = "running"; persistTasks(); return error("claimedTask")
        }
        tasks[index].merge(body) { _, new in new }; persistTasks(); return (200, tasks[index])
      }
      if parts.count == 3 && parts[2] == "actions" && method == "POST" {
        exact(body, ["action"], ["reason", "reviewer"])
        guard let action = body["action"] as? String, ["start", "block", "unblock", "request_review"].contains(action) else { fatalError("Invalid Work action") }
        if action == "block" {
          guard let reason = body["reason"] as? String, !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return error("blockReason", 400) }
          tasks[index]["status"] = "blocked"; tasks[index]["blockedReason"] = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
          let status = tasks[index]["status"] as! String
          if ["start", "unblock"].contains(action) && !["todo", "blocked"].contains(status) { return error("refusedTransition") }
          let dependencies = tasks[index]["dependencies"] as! [String]
          if dependencies.contains(where: { id in !tasks.contains { $0["id"] as? String == id && $0["status"] as? String == "done" } }) { return error("refusedTransition") }
          if action == "request_review" {
            guard let reviewer = body["reviewer"] as? String, botIds.contains(reviewer) else { fatalError("Invalid Work reviewer") }
            tasks[index]["status"] = "review"; tasks[index]["assignee"] = reviewer
          } else { tasks[index]["status"] = "ready" }
          tasks[index].removeValue(forKey: "blockedReason")
        }
        persistTasks(); return (200, tasks[index])
      }
      if parts.count == 4 && parts[2] == "dependencies" && method == "PUT" {
        exact(body, ["remove"]); guard let remove = body["remove"] as? Bool, parts[3] != parts[1], tasks.contains(where: { $0["id"] as? String == parts[3] }) else { fatalError("Invalid Work dependency") }
        var dependencies = (tasks[index]["dependencies"] as! [String]).filter { $0 != parts[3] }
        if !remove { dependencies.append(parts[3]) }; tasks[index]["dependencies"] = dependencies
        persistTasks(); return (200, tasks[index])
      }
    }
    if parts.first == "triggers" {
      if overview["canManageTriggers"] as? Bool != true { return error("triggerNonAdmin", 403) }
      var triggerSection = overview["triggers"] as! [String: Any]
      var triggers = triggerSection["items"] as! [[String: Any]]
      let id = parts.count == 2 ? parts[1] : body["id"] as? String ?? ""
      let index = triggers.firstIndex { $0["id"] as? String == id }
      if method == "POST" && parts.count == 1 {
        exact(body, ["id", "description", "events", "routineId"])
        if index != nil { return error("duplicateTrigger") }
        precondition(id.range(of: "^[a-z0-9][a-z0-9_-]{0,79}$", options: .regularExpression) != nil)
      } else { precondition(index != nil, "Unknown Work trigger") }
      if (method == "POST" && parts.count == 1) || (method == "PUT" && parts.count == 2) {
        if method == "PUT" { exact(body, ["description", "events", "routineId", "revision"]) }
        guard let description = body["description"] as? String, description.utf16.count <= 1000,
          let events = body["events"] as? [String], (1...20).contains(events.count),
          events.allSatisfy({ $0.range(of: "^[A-Za-z0-9_.*:-]{1,100}$", options: .regularExpression) != nil }),
          let routine = body["routineId"] as? String,
          (fixture["routines"] as! [[String: Any]]).contains(where: { $0["id"] as? String == routine && $0["botId"] as? String == "ranch" }) else { fatalError("Invalid Work trigger") }
      } else if method == "PATCH" && parts.count == 2 { exact(body, ["enabled", "revision"]); precondition(body["enabled"] is Bool) }
      else if method == "DELETE" && parts.count == 2 { exact(body, ["revision"]) }
      else { fatalError("Unsupported Work trigger operation") }
      if method != "POST" && body["revision"] as? String != triggers[index!]["revision"] as? String { return error("triggerCAS") }
      if method == "DELETE" { triggers.remove(at: index!); routes.removeValue(forKey: id); triggerSection["items"] = triggers; overview["triggers"] = triggerSection; return (200, ["ok": true]) }
      if method == "PATCH", body["enabled"] as? Bool == true, triggerSection["platformEnabled"] as? Bool != true { return error("platformDisabled") }
      if method == "POST" {
        let native: [String: Any] = ["profile": "ranch", "secret": config["syntheticSecret"]!, "enabled": false, "created_at": "2026-10-01T00:00:00Z", "deliver": "log", "description": body["description"]!, "events": body["events"]!, "cron_job": body["routineId"]!]
        routes[id] = native
        let subscription: [String: Any] = ["id": id, "description": body["description"]!, "events": body["events"]!, "routineId": body["routineId"]!, "enabled": false, "url": "https://hooks.example.invalid/p/ranch/webhooks/" + id, "secretSet": true, "revision": digest(native)]
        triggers.append(subscription); triggerSection["items"] = triggers; overview["triggers"] = triggerSection
        if config["gate"] as? String == "W3-triggers" && mode == "trigger-create-uncertain" { return error("catchAll", 502) }
        return (200, ["subscription": subscription, "secret": config["syntheticSecret"]!])
      }
      var native = routes[id]!, subscription = triggers[index!]
      if method == "PATCH" { native["enabled"] = body["enabled"]!; subscription["enabled"] = body["enabled"]! }
      else { native["description"] = body["description"]!; native["events"] = body["events"]!; native["cron_job"] = body["routineId"]!; subscription["description"] = body["description"]!; subscription["events"] = body["events"]!; subscription["routineId"] = body["routineId"]! }
      routes[id] = native; subscription["revision"] = digest(native); triggers[index!] = subscription; triggerSection["items"] = triggers; overview["triggers"] = triggerSection
      return (200, ["subscription": subscription])
    }
    fatalError("Unsupported Work route \(method) \(suffix)")
  }
}
#endif
