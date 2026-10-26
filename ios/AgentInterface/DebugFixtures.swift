#if DEBUG
  import Foundation
  import UserNotifications

  /// UI test transport only. Shipping Release builds contain no fixture transport.
  /// Simulator results validate native interaction, not Hermes or APNs execution.
  @MainActor enum DebugFixtures {
    static func configure(_ store: AppStore) async -> Bool {
      let environment = ProcessInfo.processInfo.environment
      if environment["AGENT_INTERFACE_UI_RESET"] == "1" {
        UserDefaults.standard.removeObject(forKey: DeviceDefaults.host)
        store.host = ""
      }
      guard environment["AGENT_INTERFACE_UI_FIXTURE"] == "1" else { return false }
      VoiceController.fixtureRecording = true
      let config = URLSessionConfiguration.ephemeral
      config.protocolClasses = [FixtureProtocol.self]
      let session = URLSession(configuration: config)
      let identifier = environment["AGENT_INTERFACE_UI_SCOPE"] ?? UUID().uuidString.lowercased()
      let client = APIClient(
        baseURL: URL(string: "https://\(identifier).native-fixture.invalid")!, session: session)
      client.token = "native-ui-fixture"
      store.api = client
      store.host = client.baseURL.absoluteString
      store.authConfig = AuthConfig(googleClientId: nil, localDevAuth: true, nativeAuthVersion: 1)
      if environment["AGENT_INTERFACE_UI_SHARE"] == "1",let root=ShareInbox.root {
        try? FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        let scope=Data((client.baseURL.absoluteString + "|native-test").utf8).base64URLEncoded
        let capture=SharedCapture(id:UUID().uuidString,scope:scope,botId:"ranch",text:"https://example.invalid/shared-page",files:[],createdAt:Date())
        try? JSONEncoder().encode(capture).write(to:root.appendingPathComponent(capture.id + ".json"),options:.atomic)
      }
      // Seeded under the lock its requests take, so no request reads it half written.
      FixtureProtocol.lock.withLock {
        if let preferences = FixtureProtocol.designFixture?["preferences"] as? [String: Any] {
          FixtureProtocol.preferences.merge(preferences) { _, new in new }
        }
        if environment["AGENT_INTERFACE_UI_AUTOMATION"] == "1" {
          FixtureProtocol.automation = AutomationDebugFixture()
          FixtureProtocol.routines = [["id": "trial", "botId": "ranch", "name": "Morning brief trial",
            "prompt": "Inspect the pasture.", "schedule": "0 7 * * *", "enabled": false, "recipientIds": [],
            "provider": "openrouter", "model": "fixture-fast", "contextFrom": ["self"]]]
        }
        if environment["AGENT_INTERFACE_UI_COORDINATION"] == "1" {
          FixtureProtocol.messages = [
            ["id": "cron", "role": "user", "text": "Scheduled job handoff: hay, water, and bunny check", "origin": ["kind": "scheduled", "visibility": "activity", "title": "Bunny care"]],
            ["id": "answer", "role": "assistant", "text": "Start with the bunnies, then choose one small task.\n\n- Top up hay.\n- Refresh water.", "origin": ["kind": "scheduled", "visibility": "conversation"]],
            ["id": "dm", "role": "user", "text": "Message from 🤖 Planner (@planner): Peppers are covered.", "origin": ["kind": "agent", "visibility": "activity", "name": "Planner"]],
            ["id": "child", "role": "user", "text": "Hay and pellets are stocked.", "origin": ["kind": "subagent", "visibility": "activity", "title": "Supply check completed"]],
            ["id": "process", "role": "user", "text": "Inventory process exited successfully.", "origin": ["kind": "process", "visibility": "activity"]],
            ["id": "diagnostic", "role": "assistant", "text": "Internal delivery retry details.", "origin": ["kind": "diagnostic", "visibility": "activity"]],
          ]
        }
        if environment["AGENT_INTERFACE_UI_RECALL"] == "1" {
          // Two of this person's messages and one from another household member, for prompt recall.
          FixtureProtocol.messages = [
            ["id": "recall-1", "role": "user", "text": "Fixture first note: check the hay", "sender": ["id": "native-test", "name": "Local test member"]],
            ["id": "recall-1-reply", "role": "assistant", "text": "Hay is stocked."],
            ["id": "recall-other", "role": "user", "text": "Fixture note from someone else", "sender": ["id": "native-test-two", "name": "Second test member"]],
            ["id": "recall-2", "role": "user", "text": "Fixture second note: water the garden", "sender": ["id": "native-test", "name": "Local test member"]],
            ["id": "recall-2-reply", "role": "assistant", "text": "Garden watered."],
          ]
        }
        if environment["AGENT_INTERFACE_UI_GROUP"] == "1" {
          FixtureProtocol.groupRooms = [["room_id": "fixture-room", "name": "Supper planning", "members": [
            ["member_id": "ranch", "profile": "ranch", "handle": "ranch", "display_name": "Ranch hand"],
            ["member_id": "kitchen", "profile": "kitchen", "handle": "kitchen", "display_name": "Kitchen companion"]]]]
          FixtureProtocol.groupEvents = [
            ["event_id": "group-1", "seq": 1, "kind": "message.user", "created_at": 1_790_000_000, "sender": ["id": "native-test-two", "name": "Second test member"],
             "payload": ["text": "What should we cook on Sunday?", "thread_id": "thread-1"]],
            ["event_id": "group-2", "seq": 2, "kind": "message.member", "created_at": 1_790_000_060, "actor": ["kind": "member", "id": "kitchen"],
             "payload": ["text": "Brisket, if the smoker is free.", "thread_id": "thread-1", "member_id": "kitchen"]],
          ]
        }
        if environment["AGENT_INTERFACE_UI_LONG_HISTORY"] == "1" {
          // Enough turns for three history pages, with replies tall enough to scroll.
          FixtureProtocol.messages = (1...60).flatMap { turn -> [[String: Any]] in
            [["id": "prompt-\(turn)", "role": "user", "text": "Fixture question \(turn)"],
             ["id": "reply-\(turn)", "role": "assistant", "text": "Fixture answer \(turn).\n\n" + Array(repeating: "A line of synthetic history so each turn takes some room.", count: 4).joined(separator: "\n\n")]]
          }
        }
        if environment["AGENT_INTERFACE_UI_MIXED_TOOL"] == "1" {
          FixtureProtocol.preferences["presentation"] = "advanced"
          FixtureProtocol.messages = [
            ["id": "mixed", "role": "assistant", "text": "Fixture single visible reply", "reasoning": "Fixture grouped reasoning", "toolCall": ["id": "mixed-call", "name": "fixture_search", "status": "completed", "result": "Fixture tool result"]],
            ["id": "tool-file", "role": "assistant", "text": "", "toolCall": ["id": "file-call", "name": "fixture_file_tool", "status": "completed", "result": "Fixture file result"], "files": [["id": "fixture-file", "name": "Fixture output.txt", "mime": "text/plain"]]],
          ]
        }
        // Transcript fixtures (chat UX catch-up, I1): a finished turn whose work folds, with
        // timestamps for its duration, a code block and a table; a failed turn to retry.
        if environment["AGENT_INTERFACE_UI_WORK"] == "1" {
          FixtureProtocol.preferences["presentation"] = environment["AGENT_INTERFACE_UI_WORK_PRESENTATION"] ?? "simple"
          FixtureProtocol.messages = TranscriptFixtures.work
        }
        if environment["AGENT_INTERFACE_UI_RETRY"] != nil { FixtureProtocol.messages = TranscriptFixtures.failed }
        if let presentation = environment["AGENT_INTERFACE_UI_LONG_TOOL"] {
          FixtureProtocol.preferences["presentation"] = presentation
          let output = (1...120).map { "Fixture output line \($0): synthetic tool details stay readable and scroll inside this receipt." }.joined(separator: "\n") + "\nEND OF FIXTURE OUTPUT"
          FixtureProtocol.messages = [
            ["id": "intro", "role": "assistant", "text": "Fixture tools have finished."],
            ["id": "short-tool", "role": "tool", "text": "Short fixture tool result", "toolCall": ["id": "short-call", "name": "fixture_short", "status": "completed", "result": "Short fixture tool result"]],
            ["id": "long-tool", "role": "tool", "text": output, "toolCall": ["id": "long-call", "name": "fixture_long", "status": "completed", "result": output]],
            ["id": "final", "role": "assistant", "text": "Fixture final answer follows the tool results."],
          ]
        }
      }
      if environment["AGENT_INTERFACE_UI_PUSH"] == "1" {
        // iOS permission starts undecided; Enable grants it, as tapping Allow would.
        var status = UNAuthorizationStatus.notDetermined
        NotificationController.shared.useFixtureSystem(permissions: NotificationPermissions(
          status: { status }, request: { status = .authorized; return true }))
      }
      await store.refreshBootstrap()
      if environment["AGENT_INTERFACE_UI_HOME"] != "1" { await store.select(store.selectedBotId) }
      store.startPolling()
      return true
    }
  }
  private final class FixtureProtocol: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    nonisolated(unsafe) static var automation = AutomationDebugFixture()
    // The fixture server's state. Unchecked because `lock` guards every access: requests read and
    // write it only inside `startLoading`, and `configure` seeds it under the same lock.
    nonisolated(unsafe) static var messages: [[String: Any]] = [
      [
        "id": "welcome", "role": "assistant",
        "text":
          "# Your household assistant\n\nI can help with everyday questions, images, and documents. **Your conversation stays here.**\n\n| Task | Result |\n| --- | --- |\n| Read PDF | Ready |\n| Generate image | |\n\n```swift\nlet answer = 42\n```",
        "createdAt": "2026-09-30T12:30:00.125Z",
      ]
    ]
    nonisolated(unsafe) static var receipts: [String: [String: Any]] = [:]
    nonisolated(unsafe) static var questionAnswered = false
    nonisolated(unsafe) static var questionFailed = false
    nonisolated(unsafe) static var approvalFailed = false
    nonisolated(unsafe) static var approvalChoice: String?
    nonisolated(unsafe) static var retried = false
    nonisolated(unsafe) static var retryClaim: [String: Any]?
    nonisolated(unsafe) static var draft: [String: Any] = ["text": "", "attachments": []]
    nonisolated(unsafe) static var readPosition: [String: Any] = [:]
    nonisolated(unsafe) static var preferences: [String: Any] = [
      "startPage": "assistant", "presentation": "simple", "theme": ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_THEME"] ?? "system", "favorites": [], "sections": [],
      "followBots": [],
    ]
    nonisolated(unsafe) static var items: [[String: Any]] = [
      [
        "id": "web", "name": "Web search",
        "description": "Search the web when current information matters.", "enabled": true,
      ],
      [
        "id": "shell", "name": "Terminal", "description": "Run commands on the assistant's server.",
        "enabled": false,
      ],
    ]
    nonisolated(unsafe) static var routines: [[String: Any]] = ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_EXPERIENCE"] == "1" ? [["id": "trial", "botId": "ranch", "name": "Morning brief trial", "prompt": "Report today's tasks. Do not modify anything.", "schedule": "0 7 * * *", "enabled": false, "recipientIds": []]] : []
    nonisolated(unsafe) static var trialRequestId: String?
    nonisolated(unsafe) static var trialCount = 0
    nonisolated(unsafe) static var groupRooms: [[String: Any]] = []
    nonisolated(unsafe) static var groupEvents: [[String: Any]] = []
    /// An assistant's answer to the last group message, announced on the next watching stream.
    nonisolated(unsafe) static var groupReplyPending = false
    /// Who has the shared desktop: an assistant until this person takes over.
    nonisolated(unsafe) static var computerControl: [String: Any] = ["kind": "bot", "name": "Ranch hand"]
    nonisolated(unsafe) static var desktopTickets = 0
    static var groupState: [String: Any] { ["room": groupRooms.first ?? [:], "driver_status": ["working": false, "blocked": false, "pending_actions": []]] }
    nonisolated(unsafe) static var memoryEntries: [[String: Any]] = [["id": "m1", "text": "Weeknight dinners under 30 minutes"]]
    nonisolated(unsafe) static var vaultItems: [[String: Any]] = [["id": "fixture-login", "kind": "login", "label": "Fixture school portal", "origin": "https://school.example.test", "createdAt": "2026-10-02T12:00:00Z", "identifier": "fixture.parent@example.test", "identifierType": "email", "hasOtp": false, "backend": "local", "canRemove": true]]
    nonisolated(unsafe) static var secureIndex = 0
    nonisolated(unsafe) static var vaultUnlocked = false
    nonisolated(unsafe) static var sourceEnabled = true
    nonisolated(unsafe) static var todayReads = 0
    nonisolated(unsafe) static var todayFrontier = "0"
    nonisolated(unsafe) static var todaySince = "2026-09-30T13:30:00Z"
    nonisolated(unsafe) static var cardState: [String: Any] = ["checkedIds": [], "notes": [:]]
    nonisolated(unsafe) static var upgradePhase = "idle"
    nonisolated(unsafe) static var upgradeOperation = "check"
    nonisolated(unsafe) static var integrationChecked = false
    nonisolated(unsafe) static var integrationDisconnected = false
    nonisolated(unsafe) static var upgradeReadsRemaining = 0
    nonisolated(unsafe) static var avatar: [String: Any] = [
      "mode": "geometric", "shape": "blob", "color": "#1084FE", "eyes": "oval", "accessory": "none",
    ]
    /// Assistants made through New assistant, and how many of their avatar saves should fail.
    nonisolated(unsafe) static var createdBots: [[String: Any]] = []
    nonisolated(unsafe) static var avatarFailures = ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_AVATAR_FAILURE"] == "1" ? 1 : 0
    static let currentRevision = "3f9c2a71b0d4e8f6a5c3b2d1e0f9a8b7c6d5e4f3"
    static let candidateRevision = "8e1d4c7b2a9f6e3d0c5b8a7f4e1d2c3b6a9f0e8d"
    nonisolated(unsafe) static var preferencesFailures = ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_PREFERENCES_FAILURE"] == "1" ? 1 : 0
    nonisolated(unsafe) static var inference: [String: Any] = ["reasoning": "medium", "speed": "normal"]
    nonisolated(unsafe) static var ranchModel = (provider: "openrouter", model: "configured-model")
    /// Fixed, so opening the unread chat reads it until a newer reply arrives.
    static let personalReplyAt = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-600))
    // Immutable JSON, read only by requests while FixtureProtocol.lock is held.
    nonisolated(unsafe) static let designFixture = (ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_DESIGN_FIXTURE"] ?? ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_TODAY_DESIGN"])
      .flatMap { $0.data(using: .utf8) }
      .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    static var bots: [[String: Any]] {
      if let bots = designFixture?["bots"] as? [[String: Any]] { return bots }
      return [
        [
          "id": "ranch", "name": "Ranch hand", "description": "Everyday household help",
          "model": ranchModel.model,
          "provider": ranchModel.provider, "shared": true, "activity": "idle", "avatar": avatar, "sessionId": "ranch-canonical",
          "lastMessage": ["text": "The north gate battery needs replacing.", "at": ISO8601DateFormatter().string(from: Date())],
        ],
        [
          "id": "kitchen", "name": "Kitchen companion", "model": "configured-model", "shared": true,
          "activity": "idle",
          "avatar": [
            "mode": "mascot", "family": "bear", "color": "#FF9800", "eyes": "round",
            "accessory": "none",
          ],
        ],
        [
          "id": "personal", "name": "My assistant", "model": "configured-model", "shared": false,
          "ownerId": "native-test", "activity": "idle", "unread": true,
          "lastMessage": ["text": "Your library books are due Friday.", "at": personalReplyAt],
        ],
      ] + createdBots
    }
    nonisolated(unsafe) static let user: [String: Any] = [
      "id": "native-test", "name": "Local test member", "email": "test@localhost.invalid",
    ]
    override class func canInit(with request: URLRequest) -> Bool {
      request.url?.host?.hasSuffix(".native-fixture.invalid") == true
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
      Self.lock.lock()
      defer { Self.lock.unlock() }
      let path = request.url!.path
      if let encoded = (Self.designFixture?["images"] as? [String: String])?[path], let data = Data(base64Encoded: encoded) {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
        return
      }
      let method = request.httpMethod ?? "GET"
      var object: Any = ["ok": true]
      var status = 200
      let body: [String: Any]
      if let data = request.httpBody {
        body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
      } else if let stream = request.httpBodyStream {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
          let count = stream.read(&buffer, maxLength: buffer.count)
          if count <= 0 { break }
          data.append(buffer, count: count)
        }
        body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
      } else {
        body = [:]
      }
      if path == "/api/events", let room = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "group" })?.value {
        // A watching stream: one notice when an assistant answered, then the stream ends and the
        // app reconnects, as after a dropped connection.
        var stream = ": watching\n\n"
        if Self.groupReplyPending {
          Self.groupReplyPending = false
          Self.groupEvents.append(["event_id": "group-reply-\(Self.groupEvents.count + 1)", "seq": Self.groupEvents.count + 1, "kind": "message.member",
            "created_at": Date().timeIntervalSince1970, "actor": ["kind": "member", "id": "ranch"],
            "payload": ["text": "Fixture live reply: the smoker is free Sunday.", "thread_id": "thread-1", "member_id": "ranch"]])
          stream += "event: group\ndata: {\"roomId\":\"\(room)\",\"latestSeq\":\(Self.groupEvents.count)}\n\n"
        }
        respond(raw: Data(stream.utf8), type: "text/event-stream")
        return
      }
      if path.hasPrefix("/api/voice/audio/") {
        // Ten seconds of quiet, so a test can stop the reply while it plays.
        respond(raw: Self.silence(seconds: 10), type: "audio/wav")
        return
      }
      if let fixture = Self.automation.response(path: path, method: method, body: body, url: request.url!) {
        status = fixture.status; object = fixture.object
      } else if path.hasSuffix("/voice/transcribe") {
        object = ["text": "Fixture transcript: check the north gate."]
      } else if path.hasSuffix("/voice/speak") {
        object = ["url": "/api/voice/audio/\(UUID().uuidString.lowercased())", "mime": "audio/wav", "expiresAt": "2026-10-02T12:05:00Z"]
      } else if path == "/api/search", let hits = TranscriptFixtures.searchHits(request.url!, Self.messages) {
        object = ["hits": hits, "unavailableBots": []]
      } else if path == "/api/search" {
        // The second hit is in Ranch hand's current conversation, so it opens the live chat.
        object = ["hits":[["botId":"ranch","botName":"Ranch","sessionId":"history-1","title":"Saved dinner plan","snippet":"Five easy dinners and a grocery list.","messageId":"history-saved","offset":0],
          ["botId":"ranch","botName":"Ranch","sessionId":"ranch-canonical","title":"Your household assistant","snippet":"I can help with everyday questions.","messageId":"welcome","offset":0]],"unavailableBots":[]]
      } else if path.contains("/history/") {
        // A person's Markdown stays literal, an assistant's exchange is its card, and the saved
        // reply sits below the fold so opening it has to scroll there.
        let filler: [[String: Any]] = (1...12).map { ["id": "history-filler-\($0)", "role": "assistant", "text": "History filler \($0).\n\n" + Array(repeating: "Earlier dinner planning notes.", count: 6).joined(separator: "\n\n")] }
        let lead: [[String: Any]] = [["id":"history-reply","role":"assistant","text":"Fixture: five easy dinners."],
          ["id":"history-user","role":"user","text":"Use **only** pantry staples"],
          ["id":"history-agent","role":"user","text":"Pantry list is ready","origin":["kind":"agent","visibility":"conversation","name":"Kitchen companion"]]]
        let saved: [[String: Any]] = [["id":"history-saved","role":"assistant","text":"Fixture saved reply: brisket on Sunday."]]
        if ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_MISSING_SEARCH_TARGET"] == "1",
          URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.contains(where: { $0.name == "messageId" }) == true {
          status = 404; object = ["error":"The original message is no longer available in Hermes."]
        } else {
          object = ["botId":"ranch","sessionId":"history-1","offset":0,"hasMore":false,"messages":lead + filler + saved]
        }
      } else if path == "/api/saved" {
        if method == "POST" { object = ["id":"saved-1","botId":"ranch","kind":"session","sessionId":"history-1","title":"Saved conversation","createdAt":"2026-10-02T12:00:00Z"] }
        else { object = [["id":"saved-1","botId":"ranch","kind":"session","sessionId":"history-1","title":"Saved conversation","createdAt":"2026-10-02T12:00:00Z"],
          ["id":"saved-2","botId":"ranch","kind":"session","sessionId":"history-1","messageId":"history-saved","offset":0,"title":"Brisket reply","createdAt":"2026-10-02T12:05:00Z"]] }
      } else if path.hasSuffix("/starters") {
        object = [["id":"meals","title":"Plan dinners","prompt":"Help me plan five easy dinners. Ask about our preferences first."]]
      } else if path == "/api/automations" {
        object = ["routines":[["id":"routine-1","botId":"ranch","name":"Morning report","prompt":"Report","schedule":"0 7 * * *","enabled":true,"recipientIds":["fixture-user"],"nextRunAt":"2026-10-03T12:00:00Z","lastStatus":"delivery_failed","lastDeliveryError":"Fixture: notification destination unavailable"]],"usage":[["botId":"ranch","sessions":4,"inputTokens":1200,"outputTokens":400,"actualCost":NSNull(),"estimatedCost":0.02,"partial":true]],"unavailableBots":[]]
      } else if path == "/api/bootstrap" {
        if ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_LIVE_ACTIVITY"] == "1" {
          Self.preferences["presentation"] = "advanced"
        }
        object = [
          "user": Self.user,
          "household": [
            Self.user,
            [
              "id": "native-test-two", "name": "Second test member",
              "email": "two@localhost.invalid",
            ],
          ], "bots": Self.bots, "preferences": Self.preferences,
          "connection": ["connected": true, "code": "ready", "version": Self.currentRevision, "revisionDate": "2026-10-14T16:20:00Z"],
          "csrfToken": NSNull(),
          "capabilities": Dictionary(
            uniqueKeysWithValues: CapabilityKey.allCases.map { ($0.rawValue, ["supported": true]) }),
        ]
        if Self.designFixture?["approvalSupported"] as? Bool == false {
          var bootstrap = object as! [String: Any]
          var capabilities = bootstrap["capabilities"] as! [String: Any]
          capabilities["approvals"] = ["supported": false, "reason": Self.designFixture?["unsupportedReason"] ?? "Approval decisions are unavailable."]
          bootstrap["capabilities"] = capabilities; object = bootstrap
        }
        if Self.designFixture?["retrySupported"] as? Bool == false {
          var bootstrap = object as! [String: Any]
          var capabilities = bootstrap["capabilities"] as! [String: Any]
          capabilities["idempotency"] = ["supported": false, "reason": "This Hermes connection cannot look up requests."]
          bootstrap["capabilities"] = capabilities; object = bootstrap
        }
        // A distributed build newer than any local build, so the update banner shows.
        if ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_APP_UPDATE"] == "1" {
          object = (object as! [String: Any]).merging(["nativeApp": ["latestBuild": 999, "updateUrl": "https://testflight.apple.com/join/FIXTURE"]]) { $1 }
        }
        if ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_OUTAGE"] == "1" {
          status = 503; object = ["error": "Fixture: the app server is unreachable"]
        } else if ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_DISCONNECTED"] == "1" {
          // A fresh installation whose Hermes connection was never set up.
          object = (object as! [String: Any]).merging(["bots": [], "connection": ["connected": false, "code": "not_configured", "detail": "Fixture: Hermes is not configured."]]) { $1 }
        }
      } else if path.hasSuffix("/conversation") {
        object = [
          "botId": path.components(separatedBy: "/")[3], "messages": Self.messages,
          "activity": ["state": "idle"], "approvals": [], "files": [], "attention": [],
          "draft": Self.draft, "readPosition": Self.readPosition,
        ]
        if let conversation = Self.designFixture?["conversation"] as? [String: Any] {
          object = Self.questionAnswered && Self.designFixture?["screen"] as? String == "questions"
            ? Self.designFixture?["afterAnswer"] ?? conversation : conversation
          if Self.designFixture?["screen"] as? String == "approvals", Self.designFixture?["holdDecision"] as? Bool != true, let choice = Self.approvalChoice {
            object = Self.designFixture?[choice == "approved" ? "afterApproved" : "afterDenied"] ?? conversation
          }
        }
        if Self.designFixture?["screen"] as? String == "recovery" {
          var value = (Self.retried ? Self.designFixture?["afterRetry"] : Self.designFixture?["conversation"]) as! [String: Any]
          value["draft"] = Self.draft
          if let claim = Self.retryClaim { value["retry"] = claim }
          object = value
        }
        if let questions = ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_QUESTION"] {
          // "2" asks three questions: one choice, several choices, and a written answer.
          let asked: [[String: Any]] = questions == "2" ? TranscriptFixtures.questions : [["id": "plan", "prompt": "Your plan", "options": ["First", "Second"]]]
          object = ["botId": "ranch", "messages": Self.questionAnswered ? Self.messages : [],
            "activity": ["state": Self.questionAnswered ? "idle" : "blocked"], "approvals": [], "files": [],
            "attention": Self.questionAnswered ? [] : [["id": "fixture-question", "kind": "clarify", "title": "Which plan?", "detail": "Choose a suggestion or write your own answer.", "questions": asked]],
            "draft": Self.draft]
        }
        if ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_RETRY"] != nil {
          var value = object as! [String: Any]
          value["activity"] = ["state": Self.retried ? "idle" : "failed", "detail": Self.retried ? NSNull() as Any : "The weather service did not answer." as Any]
          if let claim = Self.retryClaim { value["retry"] = claim }
          object = value
        }
        if ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_LONG_HISTORY"] == "1" {
          // The server's history window (src/shared/history.ts): `start` pins the oldest loaded
          // message, `turns` adds that many turns above it, and no start means the latest page.
          let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
          let start = query.first { $0.name == "start" }?.value
          var turns = Int(query.first { $0.name == "turns" }?.value ?? "") ?? 0
          var end = start.flatMap { id in Self.messages.firstIndex { $0["id"] as? String == id } } ?? -1
          if end < 0 { end = Self.messages.count; turns = max(turns, 20) }
          var from = end
          while from > 0 && turns > 0 { from -= 1; if Self.messages[from]["role"] as? String == "user" { turns -= 1 } }
          var window = object as! [String: Any]
          window["messages"] = Array(Self.messages[from...]); window["earlier"] = from; window["earlierFiles"] = 0
          window["sessionId"] = TranscriptFixtures.longSession
          object = window
        }
        if ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_LIVE_ACTIVITY"] == "1" {
          object = [
            "botId": path.components(separatedBy: "/")[3],
            "messages": [["id": "fixture-answer", "role": "assistant", "text": "I'll check the current weather for the ranch.", "reasoning": "Fixture exposed reasoning: current weather needs a fresh forecast."]],
            "activity": ["state": "working", "detail": "Checking the latest forecast"],
            "toolCalls": [["id": "fixture-search", "name": "web_search", "arguments": "{\"query\":\"Texas ranch weather forecast\"}", "status": "running"]],
            "approvals": [], "files": [], "attention": [], "draft": Self.draft, "readPosition": Self.readPosition,
          ]
        }
        if ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_EXPERIENCE"] == "1" {
          object = ["botId": path.components(separatedBy: "/")[3], "messages": [["id": "fixture-cards", "role": "assistant", "text": "Fixture grocery suggestion.\n```agent-ui\n{\"version\":1,\"cards\":[{\"id\":\"groceries\",\"type\":\"checklist\",\"title\":\"Grocery checklist\",\"items\":[{\"id\":\"milk\",\"text\":\"Milk\"}]}]}\n```"]], "activity": ["state": "idle"], "approvals": [], "files": [], "attention": [], "draft": Self.draft, "readPosition": Self.readPosition]
        }
        if ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_INLINE_UI"] == "1" {
          let html = "<h3>Hay supply planner</h3><p>Explicit simulator fixture.</p><button id='compare' onclick=\"document.getElementById('days').textContent='40 days';document.getElementById('extra').hidden=false\">Compare supply</button><p id='days'>24 days</p><p id='extra' hidden>At half a bale per day, twenty bales lasts forty days.</p>"
          let payload: [String: Any] = ["version": 1, "title": "Hay supply planner", "html": html]
          let data = try! JSONSerialization.data(withJSONObject: payload)
          let text = "Twelve bales lasts about 24 days. Compare a larger supply below.\n\n```wildbots-html\n" + String(decoding: data, as: UTF8.self) + "\n```"
          object = ["botId": path.components(separatedBy: "/")[3], "messages": [["id": "inline-fixture", "role": "assistant", "text": text]], "activity": ["state": "idle"], "approvals": [], "files": [], "attention": [], "draft": Self.draft, "readPosition": Self.readPosition]
        }
        if ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_VAULT"] == "1" {
          let requests: [[String: Any]] = [
            ["method": "vault.save_login", "origin": "https://school.example.test", "site": "Fixture school portal"],
            ["method": "vault.code", "site": "Fixture school portal", "hint": "Enter the fixture verification code."],
            ["method": "vault.unlock_prompt", "backend": "bitwarden", "displayName": "Bitwarden fixture"],
            ["method": "secret", "envVar": "FIXTURE_API_TOKEN", "prompt": "Enter an explicit fixture token."]
          ]
          var attention: [[String: Any]] = []
          if Self.secureIndex < requests.count {
            var secure = requests[Self.secureIndex]; secure["epoch"] = "fixture-epoch"; secure["sessionId"] = "fixture-session"
            attention = [["id": "fixture-secure-\(Self.secureIndex)", "kind": "secure", "title": "Hermes needs secure input", "detail": "Explicit simulator fixture request.", "secure": secure]]
          }
          object = ["botId": path.components(separatedBy: "/")[3], "sessionId": "fixture-session", "messages": [["id": "vault-fixture", "role": "assistant", "text": "Fixture browser task needs a login. Enter it in the secure request below."]], "activity": ["state": attention.isEmpty ? "idle" : "blocked"], "approvals": [], "files": [], "attention": attention, "draft": Self.draft, "readPosition": Self.readPosition]
        }
      } else if path.hasSuffix("/vault") {
        object = ["botId": path.components(separatedBy: "/")[3], "profile": "default", "scope": "profile", "owner": "Hermes", "notice": "Explicit simulator fixture. Logins belong to this Hermes profile and follow its household access.", "items": Self.vaultItems, "sources": [
          ["name": "local", "displayName": "Hermes saved logins", "enabled": true, "needsUnlock": false, "unlocked": true, "installed": true, "canToggle": false, "canUnlock": false, "canLock": false],
          ["name": "onepassword", "displayName": "1Password", "enabled": false, "needsUnlock": true, "unlocked": false, "installed": false, "canToggle": false, "canUnlock": false, "canLock": false],
          ["name": "bitwarden", "displayName": "Bitwarden fixture", "enabled": Self.sourceEnabled, "needsUnlock": true, "unlocked": Self.vaultUnlocked, "installed": true, "canToggle": true, "canUnlock": Self.sourceEnabled && !Self.vaultUnlocked, "canLock": Self.vaultUnlocked]
        ]]
      } else if path.hasSuffix("/approvals/fixture-approval"), method == "POST", Self.designFixture?["screen"] as? String == "approvals" {
        if let error = Self.designFixture?["decisionError"] as? String, !Self.approvalFailed {
          Self.approvalFailed = true; status = 503; object = ["error": error]
        } else {
          Self.approvalChoice = body["decision"] as? String
          object = ["ok": true]
        }
      } else if path.hasSuffix("/requests/fixture-question"), method == "POST" {
        if let error = Self.designFixture?["answerError"] as? String, !Self.questionFailed {
          Self.questionFailed = true; status = 503; object = ["error": error]
        } else {
          Self.questionAnswered = true
          let answers = body["answers"] as? [String: String] ?? [:]
          Self.messages = [["id": "answer-received", "role": "assistant", "text": answers.count > 1
            ? answers.keys.sorted().map { "\($0): \(answers[$0] ?? "")" }.joined(separator: "; ")
            : "Received plan: \(answers["plan"] ?? "")"]]
          object = ["ok": true]
        }
      } else if path.hasSuffix("/vault/logins"), method == "POST" {
        Self.vaultItems.append(["id": "added-login", "kind": "login", "label": body["label"] ?? "", "origin": body["origin"] ?? "", "createdAt": "2026-10-02T12:00:00Z", "identifier": body["identifier"] ?? "", "identifierType": body["identifierType"] ?? "username", "hasOtp": false, "backend": "local", "canRemove": true])
        if ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_VAULT_ADD_CANCELLED"] == "1" {
          client?.urlProtocol(self, didFailWithError: URLError(.cancelled)); return
        }
        object = ["id": "added-login"]
      } else if path.contains("/vault/logins/"), method == "DELETE" {
        Self.vaultItems.removeAll { $0["id"] as? String == request.url!.lastPathComponent }; object = ["removed": true]
      } else if path.hasSuffix("/bitwarden/unlock") {
        if ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_VAULT_UNLOCK_FAILS"] == "1" {
          status = 503; object = ["error": "Fixture connection lost during unlock"]
        } else { Self.vaultUnlocked = true }
      } else if path.hasSuffix("/bitwarden/lock") {
        Self.vaultUnlocked = false
      } else if path.hasSuffix("/sources/bitwarden"), method == "PUT" {
        Self.sourceEnabled = body["enabled"] as? Bool ?? false
      } else if path.contains("/secure-requests/") {
        if ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_SECURE_UNCERTAIN"] == "1" {
          status = 502; object = ["error": "Synthetic secret echo must never appear: fixture-password"]
        } else {
          Self.secureIndex += 1; object = ["status": "ok"]
        }
      } else if path == "/api/groups" {
        if method == "POST" {
          let room: [String: Any] = ["room_id": body["requestId"] ?? "room", "name": body["name"] ?? "Group", "members": (body["botIds"] as? [String] ?? []).map { id -> [String: Any] in ["member_id": id, "profile": id, "handle": id, "display_name": Self.bots.first { $0["id"] as? String == id }?["name"] ?? id] }]
          Self.groupRooms.append(room); object = ["room": room]
        } else { object = ["supported": true, "canSend": true, "rooms": Self.groupRooms] }
      } else if path.hasPrefix("/api/groups/") {
        if path.hasSuffix("/messages") {
          let event: [String: Any] = ["event_id": body["requestId"] ?? "event", "seq": Self.groupEvents.count + 1, "kind": "message.user", "created_at": Date().timeIntervalSince1970, "payload": ["text": body["text"] ?? "", "thread_id": body["threadId"] ?? "thread-1"],
            "sender": ["id": "native-test", "name": "Local test member"]]
          Self.groupEvents.append(event); object = ["accepted": true]
          if ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_GROUP"] == "1" { Self.groupReplyPending = true }
        } else if path.hasSuffix("/log") {
          var page: [String: Any] = ["events": Self.groupEvents, "cursor": Self.groupEvents.count, "has_more": false]
          // Like the app server, `state=1` brings the room state along.
          if request.url?.query?.contains("state=1") == true { page["state"] = Self.groupState }
          object = page
        } else { object = Self.groupState }
      } else if path.contains("/routines/") && path.hasSuffix("/results") {
        object = [["id": "fixture-run", "title": "Morning brief", "startedAt": "2026-10-02T12:00:00Z", "previewOnly": false]]
      } else if path.contains("/routines/") && path.contains("/results/") {
        object = ["messages": [["id": "fixture-output", "role": "assistant", "text": "Fixture saved routine output: the pasture gate is closed."]], "previewOnly": false]
      } else if path == "/api/today", let overview = Self.designFixture?["overview"] {
        // Design-only transport states. A pending response lets the tour capture real loading UI.
        if Self.designFixture?["mode"] as? String == "loading" { return }
        Self.todayReads += 1
        if Self.designFixture?["mode"] as? String == "stale", Self.todayReads > 1 {
          status = 503; object = ["error": "Fixture connection interrupted."]
        } else { object = overview }
      } else if path == "/api/today" {
        let events: [[String: Any]] = Self.todayFrontier == "0" ? [["id": "fixture-completed", "botId": "ranch", "kind": "completed", "title": "Fixture routine completed", "occurredAt": "2026-10-01T13:00:00Z"]] : Self.todayFrontier == "1" ? [["id": "fixture-late-import", "botId": "ranch", "kind": "completed", "title": "Fixture late imported completion", "occurredAt": "2026-09-28T13:00:00Z"]] : []
        object = ["generatedAt": "2026-10-01T13:30:00Z", "since": Self.todaySince, "frontier": Self.todayFrontier == "0" ? "1" : "2", "hasMore": Self.todayFrontier == "0", "items": [["botId": "ranch", "botName": "Ranch hand", "activity": ["state": "done"], "approvals": [], "attention": [], "files": [], "latestMessage": ["id": "fixture-today", "text": "Fixture: pasture inspection finished.", "createdAt": "2026-10-01T13:00:00Z"]]], "events": events, "unavailableBots": []]
      } else if path == "/api/today/seen" {
        let expectedFrontier = Self.todayFrontier == "0" ? "1" : "2"
        if body["frontier"] as? String != expectedFrontier || body["seenAt"] as? String != "2026-10-01T13:30:00Z" {
          status = 400; object = ["error": "Acknowledge the exact returned snapshot frontier and time"]
        } else { Self.todayFrontier = expectedFrontier; Self.todaySince = body["seenAt"] as? String ?? Self.todaySince }
      } else if path.hasSuffix("/memory") || path.hasSuffix("/memory/memory") {
        if method == "PATCH" { Self.memoryEntries = (body["entries"] as? [[String: Any]] ?? []).enumerated().map { index, entry in var entry = entry; if entry["id"] == nil { entry["id"] = "m-new-\(index)" }; return entry } }
        if method == "DELETE" { Self.memoryEntries.removeAll { $0["id"] as? String == body["entryId"] as? String } }
        object = ["botId": "ranch", "profile": "default", "scope": "profile", "owner": "Hermes", "documents": [["target": "memory", "label": "Memory", "revision": "fixture-revision", "enabled": true, "entries": Self.memoryEntries, "charLimit": 2200, "charCount": 42]], "notice": "Explicit simulator fixture. Saved edits refresh at the next safe turn boundary without changing chat history."]
      } else if path.contains("/cards/") && path.hasSuffix("/state") {
        if method == "PUT" { Self.cardState = body }
        object = Self.cardState
      } else if path.hasSuffix("/run") && path.hasPrefix("/api/routines/") {
        let nextId = body["requestId"] as? String ?? ""
        if nextId == Self.trialRequestId { status = 409; object = ["error": "A completed run needs a new request ID"] }
        else {
          Self.trialCount += 1; Self.trialRequestId = nextId
          if Self.trialCount == 1 { status = 503; object = ["error": "Fixture uncertain admission"] }
          else { object = ["requestId": nextId, "routineId": "trial", "botId": "ranch", "status": "completed", "message": "Fixture second run uses a fresh request ID", "startedAt": "2026-10-01T13:00:00Z", "finishedAt": "2026-10-01T13:01:00Z"] }
        }
      } else if path.contains("/runs/") && path.hasPrefix("/api/routines/") {
        object = ["requestId": Self.trialRequestId ?? "", "routineId": "trial", "botId": "ranch", "status": "completed", "message": "Fixture first run completed", "startedAt": "2026-10-01T13:00:00Z", "finishedAt": "2026-10-01T13:01:00Z"]
      } else if path == "/api/routines/templates" {
        object = [["id": "morning", "name": "Morning brief", "schedule": "0 7 * * *", "description": "Fixture morning brief from connected sources.", "prompt": "Read the calendar and report today's household tasks. Do not modify anything."]]
      } else if path == "/api/routines/preview" {
        object = ["botId": "ranch", "schedule": body["schedule"] ?? "0 7 * * *", "timezone": "America/Chicago", "nextRuns": ["2026-10-02T12:00:00Z", "2026-10-03T12:00:00Z", "2026-10-04T12:00:00Z"], "kind": "cron"]
      } else if path == "/api/integrations" {
        object = ["profile": "ranch", "canManage": true, "connections": [
          ["id": "workspace", "name": "Google Workspace", "category": "productivity", "owner": "Hermes", "profile": "ranch", "account": "test@localhost.invalid", "status": Self.integrationDisconnected ? "not_connected" : Self.integrationChecked ? "connected" : "configured", "detail": "Explicit simulator fixture. Credentials are configured; permissions are checked separately.", "permissions": [["id": "drive", "name": "Drive", "granted": NSNull()]], "actions": ["connect": true, "check": true, "disconnect": !Self.integrationDisconnected], "setup": [], "capabilities": [], "botIds": ["ranch"]],
          ["id": "github", "name": "GitHub", "category": "development", "owner": "Hermes", "profile": "ranch", "status": "expired", "detail": "This fixture account needs to sign in again.", "permissions": [], "actions": ["connect": true, "check": true, "disconnect": false], "setup": [], "capabilities": [], "botIds": ["ranch"]]
        ]]
      } else if path.hasPrefix("/api/integrations/") && path.hasSuffix("/disconnect") {
        Self.integrationDisconnected = true
        object = ["kind": "instructions", "status": "approved", "message": "Removed this profile's local Google grant."]
      } else if path.hasPrefix("/api/integrations/") && path.hasSuffix("/check") {
        Self.integrationChecked = true
        object = ["id": "workspace", "name": "Google Workspace", "category": "productivity", "owner": "Hermes", "profile": "ranch", "status": "connected", "detail": "Fixture check passed.", "permissions": [], "actions": ["connect": true, "check": true, "disconnect": false], "setup": [], "capabilities": [], "botIds": ["ranch"]]
      } else if path == "/api/computer" {
        let unavailable = ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_COMPUTER_UNAVAILABLE"] == "1"
        object = ["available": !unavailable, "running": !unavailable, "browserReady": !unavailable, "label": "Fixture host",
          "reason": unavailable ? "The fixture desktop is stopped." as Any : NSNull(),
          "control": Self.computerControl,
          "terminal": ["available": false, "target": ""]]
      } else if path == "/api/computer/desktop", method == "POST" {
        Self.desktopTickets += 1
        object = ["path": "/api/computer/desktop/ws?ticket=fixture-\(Self.desktopTickets)",
          "expiresAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(30)), "viewerId": body["viewerId"] ?? "fixture-viewer-000001"]
      } else if path == "/api/computer/control", method == "POST" {
        Self.computerControl = body["action"] as? String == "take" ? ["kind": "human", "name": "Local test member", "mine": true] : ["kind": "idle"]
        object = ["available": true, "running": true, "browserReady": true, "label": "Fixture host", "reason": NSNull(),
          "control": Self.computerControl, "terminal": ["available": false, "target": ""]]
      } else if path.hasPrefix("/api/hermes/upgrade") {
        if path.hasSuffix("/control") {
          Self.upgradePhase = "recovering"
          Self.upgradeReadsRemaining = 1
        } else if path.hasSuffix("/check") {
          Self.upgradeOperation = "check"
          Self.upgradePhase = "qualifying"
          Self.upgradeReadsRemaining = 1
        } else if path.hasSuffix("/install") {
          Self.upgradeOperation = "install"
          Self.upgradePhase = "installing"
          Self.upgradeReadsRemaining = 3
          if ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_UPGRADE_UNCERTAIN"] == "1" {
            status = 503
          }
        } else if Self.upgradeReadsRemaining > 0 {
          Self.upgradeReadsRemaining -= 1
        } else {
          switch Self.upgradePhase {
          case "qualifying": Self.upgradePhase = "ready"
          case "installing": Self.upgradePhase = "verifying"; Self.upgradeReadsRemaining = 1
          case "verifying": Self.upgradePhase = "succeeded"
          case "recovering": Self.upgradePhase = "cancelled"
          default: break
          }
        }
        if ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_UPGRADE_FAILED"] == "1", Self.upgradePhase == "idle" { Self.upgradePhase = "failed"; Self.upgradeOperation = "install" }
        let phase = Self.upgradePhase
        let fixtureChecks: [[String: Any]] = phase == "idle" ? [] : [["id": "compatibility", "label": "App compatibility", "status": phase == "qualifying" ? "running" : "passed", "detail": "Explicit simulator fixture, not a real Hermes upgrade."]]
        let fixtureMessage: String
        switch phase {
        case "idle": fixtureMessage = "Check the shared installation for a compatible update."
        case "succeeded": fixtureMessage = "Fixture update verified. Conversations are preserved."
        case "ready": fixtureMessage = "The candidate passed compatibility checks."
        default: fixtureMessage = "The server is \(phase) the fixture installation."
        }
        // Real revisions are commit hashes with commit dates; the app leads with the date.
        let oldRevision: [String: Any] = ["revision": Self.currentRevision, "committedAt": "2026-10-14T16:20:00Z"]
        let newRevision: [String: Any] = ["revision": Self.candidateRevision, "committedAt": "2026-10-20T18:05:00Z", "notesUrl": "https://example.com/hermes/releases"]
        let upgrade: [String: Any] = [
          "available": true, "phase": phase,
          "current": phase == "succeeded" ? newRevision : oldRevision,
          "candidate": newRevision,
          "message": fixtureMessage,
          "checks": fixtureChecks,
          "canCheck": ["idle", "ready", "succeeded"].contains(phase),
          "canInstall": phase == "ready", "canRetry": phase == "failed", "canCancel": phase == "failed" || phase == "qualifying", "canRestartService": phase == "failed", "operationId": "fixture-update", "operation": Self.upgradeOperation, "busyBots": [],
        ]
        if status == 503 {
          object = ["error": "Fixture connection lost during update admission"]
        } else {
          object = upgrade
        }
      } else if path.hasSuffix("/draft") {
        if method == "PUT" { Self.draft = body }
        object = Self.draft
      } else if path.hasSuffix("/read-position") {
        if method == "PUT" { Self.readPosition = body }
        object = Self.readPosition
      } else if path == "/api/connection/retry" {
        object = ["connected": true, "code": "ready", "version": Self.currentRevision, "revisionDate": "2026-10-14T16:20:00Z"]
      } else if path.hasSuffix("/messages"), let retryOf = body["retryOf"] as? String {
        // A retry repeats the person's message and, this time, the assistant answers. The draft stays.
        let id = body["requestId"] as? String ?? UUID().uuidString
        // "refused": Hermes refuses the retry, which the conversation then records as its claim.
        if ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_RETRY"] == "refused" || Self.designFixture?["retryMode"] as? String == "refused" {
          let receipt: [String: Any] = ["requestId": id, "status": "rejected", "message": "The gate service is offline."]
          Self.retryClaim = receipt.merging(["retryOf": retryOf]) { $1 }
          Self.receipts[id] = receipt
          object = receipt
        } else if Self.designFixture?["retryMode"] as? String == "checking" {
          let receipt: [String: Any] = ["requestId": id, "status": "uncertain"]
          Self.retryClaim = receipt.merging(["retryOf": retryOf]) { $1 }; Self.receipts[id] = receipt; object = receipt
        } else {
          Self.retried = true
          Self.messages += [["id": id, "role": "user", "text": body["text"] ?? "", "sender": ["id": "native-test", "name": "Local test member"]],
            ["id": "retry-answer", "role": "assistant", "text": "Retried \(retryOf): the north gate is closed and the battery reads 80%."]]
          let receipt: [String: Any] = ["requestId": id, "status": "accepted", "messageId": id]
          Self.receipts[id] = receipt
          object = receipt
        }
      } else if path.hasSuffix("/messages") {
        let id = body["requestId"] as? String ?? UUID().uuidString
        Self.messages.append([
          "id": id, "role": "user", "text": body["text"] ?? "",
          "sender": ["id": "native-test", "name": "Local test member"],
        ])
        Self.draft = ["text": "", "attachments": []]
        let receipt: [String: Any] = ["requestId": id, "status": "accepted", "messageId": id]
        Self.receipts[id] = receipt
        object = receipt
      } else if path.hasPrefix("/api/submissions/") {
        object =
          Self.receipts[request.url!.lastPathComponent] ?? [
            "requestId": request.url!.lastPathComponent, "status": "uncertain",
          ]
      } else if path.hasSuffix("/tools") || path.hasSuffix("/skills") {
        if ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_CATALOG_FAILURE"] == "1",
          method == "GET"
        {
          status = 503
          object = ["error": "Catalog unavailable for this test"]
        } else if method == "GET" {
          object = Self.items
        } else {
          let ids = body["ids"] as? [String] ?? []
          Self.items = Self.items.map {
            var item = $0
            item["enabled"] = ids.contains(item["id"] as? String ?? "")
            return item
          }
        }
      } else if path == "/api/preferences/models" {
        Self.preferences["modelFavorites"] = body["modelFavorites"]
        object = ["modelFavorites": Self.preferences["modelFavorites"] ?? []]
      } else if path.hasSuffix("/inference") {
        if method == "PATCH" { for (key, value) in body { Self.inference[key] = value } }
        object = Self.inference
      } else if path == "/api/preferences" {
        if method == "PATCH" && Self.preferencesFailures > 0 {
          Self.preferencesFailures -= 1; status = 503; object = ["error": "Fixture settings save failed"]
        } else {
          if method == "PATCH" { let favorites = Self.preferences["modelFavorites"]; Self.preferences = body; Self.preferences["modelFavorites"] = favorites }
          object = Self.preferences
        }
      } else if path.hasSuffix("/avatar"), let index = Self.createdBots.firstIndex(where: { path.hasPrefix("/api/bots/\($0["id"] as? String ?? "")/") }) {
        if Self.avatarFailures > 0 {
          Self.avatarFailures -= 1; status = 503; object = ["error": "Fixture avatar save failed"]
        } else {
          Self.createdBots[index]["avatar"] = body
          object = body
        }
      } else if path.hasSuffix("/avatar") {
        Self.avatar = body
        object = body
      } else if path == "/api/routines", method == "GET" {
        object = Self.routines
      } else if path == "/api/routines" || path.hasPrefix("/api/routines/") {
        if method == "DELETE" {
          Self.routines.removeAll { $0["id"] as? String == request.url!.lastPathComponent }
        } else {
          var routine = body
          routine["id"] = method == "POST" ? UUID().uuidString : request.url!.lastPathComponent
          Self.routines.removeAll { $0["id"] as? String == routine["id"] as? String }
          Self.routines.append(routine)
          object = routine
        }
      } else if path == "/api/native/live-activity" {
        // Unavailable unless asked for, so other tests never start a real Live Activity.
        if method == "GET" {
          let now = Date().timeIntervalSince1970
          object = ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_ACTIVITY_SERVER"] == "1"
            ? ["available": true, "state": ["title": "Ranch hand needs you", "activeCount": 2, "attentionCount": 1, "updatedAt": now, "rows": [
              ["botId": "ranch", "name": "Ranch hand", "phase": "waiting", "status": "Needs approval", "detail": "Order hay delivery", "since": now - 95, "color": "#1084FE"],
              ["botId": "kitchen", "name": "Kitchen companion", "phase": "working", "status": "Working", "detail": "Planning this week's dinners", "since": now - 312, "color": "#FF9800"],
            ]] as [String: Any]]
            : ["available": false, "state": ["title": "", "activeCount": 0, "attentionCount": 0, "updatedAt": now, "rows": []] as [String: Any]]
        }
      } else if path == "/api/native/push/config" {
        object = ["available": ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_PUSH"] == "1", "environment": "sandbox"]
      } else if path.hasPrefix("/api/bots/"), path.split(separator: "/").count == 3, method == "GET" {
        var detail = Self.bots.first { $0["id"] as? String == path.components(separatedBy: "/").last } ?? Self.bots[0]
        detail["instructions"] = detail["instructions"] ?? "Be clear and useful."
        detail["enabledMcpServers"] = ["existing-calendar"]
        detail["enabledTools"] = ["terminal"]
        detail["enabledSkills"] = []
        object = detail
      } else if path == "/api/bots", method == "POST" {
        var bot = body
        bot["id"] = "created-\(Self.createdBots.count + 1)"
        bot["activity"] = "idle"
        bot.removeValue(forKey: "confirmModel")
        Self.createdBots.append(bot)
        object = bot
      } else if path == "/api/models" {
        object = ["provider": "openrouter", "model": Self.ranchModel.model, "providers": [
          ["id": "openrouter", "name": "OpenRouter", "authenticated": true, "models": [
            ["id": "configured-model", "name": "Configured model", "available": true],
            ["id": "fixture-fast", "name": "Fixture fast model", "available": true],
          ]],
        ]]
      } else if path.hasPrefix("/api/bots/"), method == "PATCH" {
        if request.url!.lastPathComponent == "ranch", let model = body["model"] as? String {
          Self.ranchModel = (body["provider"] as? String ?? Self.ranchModel.provider, model)
        }
        var bot = body
        bot["id"] = request.url!.lastPathComponent
        bot["activity"] = "idle"
        object = bot
      }
      let data =
        (try? JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed]))
        ?? Data()
      let response = HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: nil,
        headerFields: ["Content-Type": "application/json"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
    private func respond(raw data: Data, type: String) {
      let response = HTTPURLResponse(
        url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": type])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    }
    /// An 8 kHz, 8-bit mono WAV of silence.
    static func silence(seconds: Int) -> Data {
      let samples = 8_000 * seconds
      var data = Data("RIFF".utf8)
      func append(_ value: UInt32) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
      func append(_ value: UInt16) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
      append(UInt32(36 + samples))
      data.append(Data("WAVEfmt ".utf8))
      append(UInt32(16)); append(UInt16(1)); append(UInt16(1)); append(UInt32(8_000)); append(UInt32(8_000))
      append(UInt16(1)); append(UInt16(8))
      data.append(Data("data".utf8))
      append(UInt32(samples))
      data.append(Data(repeating: 128, count: samples))
      return data
    }
  }

  /// Transcript fixtures for the chat UX catch-up (I1). Explicit synthetic content.
  enum TranscriptFixtures {
    static let longSession = "fixture-long-session"
    static var questions: [[String: Any]] { [
      ["id": "plan", "prompt": "Your plan", "options": ["First", "Second"]],
      ["id": "extras", "prompt": "What should come along?", "options": ["Hay", "Water", "Feed"], "multiple": true],
      ["id": "note", "prompt": "Anything else?"],
    ] }
    static var work: [[String: Any]] { [
      ["id": "work-prompt", "role": "user", "text": "Check the north gate and show me the battery script.", "createdAt": "2026-10-24T15:00:00.000Z",
       "sender": ["id": "native-test", "name": "Local test member"]],
      ["id": "work-search", "role": "assistant", "text": "", "createdAt": "2026-10-24T15:00:04.000Z",
       "toolCall": ["id": "work-call", "name": "web_search", "arguments": "{\"query\":\"north gate battery\"}", "status": "completed",
         "result": "{\"ok\":true}", "startedAt": "2026-10-24T15:00:04.000Z", "completedAt": "2026-10-24T15:00:21.000Z"]],
      ["id": "work-child", "role": "assistant", "text": "", "createdAt": "2026-10-24T15:01:30.000Z",
       "toolCall": ["id": "work-delegate", "name": "delegate_task", "arguments": "{\"goal\":\"Review the gate sensor log\"}", "status": "completed",
         "result": "Gate sensor log reviewed.", "startedAt": "2026-10-24T15:00:30.000Z", "completedAt": "2026-10-24T15:01:30.000Z"]],
      ["id": "work-answer", "role": "assistant", "createdAt": "2026-10-24T15:02:14.000Z", "reasoning": "The gate log shows a low battery.\nA replacement script is simplest.",
       "text": "The north gate battery is low. Here is the check script:\n\n```swift\n// Reads the gate battery\nlet level = try await gate.battery()\nif level < 0.2 { print(\"Replace soon: \\(level)\") }\n```\n\n| Gate | Battery |\n| --- | ---: |\n| North | 18% |\n| South, back | 76% |"],
    ] }
    static var failed: [[String: Any]] { [
      ["id": "retry-prompt", "role": "user", "text": "Is the north gate closed?", "sender": ["id": "native-test", "name": "Local test member"]],
      ["id": "retry-tool", "role": "tool", "text": "Weather service timed out.", "toolCall": ["id": "retry-call", "name": "gate_status", "status": "failed", "error": "Timed out"]],
    ] }
    /// `GET /search?q=&botId=` against the long history, as the server matches words. Other
    /// searches keep the general fixture's answer.
    static func searchHits(_ url: URL, _ messages: [[String: Any]]) -> [[String: Any]]? {
      let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
      guard ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_LONG_HISTORY"] == "1",
        let botId = query.first(where: { $0.name == "botId" })?.value, let q = query.first(where: { $0.name == "q" })?.value
      else { return nil }
      return messages.enumerated().compactMap { index, message in
        guard let text = message["text"] as? String, text.localizedStandardContains(q), let id = message["id"] as? String else { return nil }
        return ["botId": botId, "botName": "Ranch hand", "sessionId": longSession, "title": "Fixture history", "snippet": text, "messageId": id, "offset": index]
      }
    }
  }
#endif
