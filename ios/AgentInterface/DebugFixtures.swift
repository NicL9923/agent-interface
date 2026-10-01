#if DEBUG
  import Foundation

  /// UI test transport only. Shipping Release builds contain no fixture transport.
  /// Simulator results validate native interaction, not Hermes or APNs execution.
  @MainActor enum DebugFixtures {
    static func configure(_ store: AppStore) async -> Bool {
      let environment = ProcessInfo.processInfo.environment
      if environment["AGENT_INTERFACE_UI_RESET"] == "1" {
        UserDefaults.standard.removeObject(forKey: "connection.host")
        store.host = ""
      }
      guard environment["AGENT_INTERFACE_UI_FIXTURE"] == "1" else { return false }
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
      await store.refreshBootstrap()
      store.startPolling()
      return true
    }
  }
  private final class FixtureProtocol: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    static var messages: [[String: Any]] = [
      [
        "id": "welcome", "role": "assistant",
        "text":
          "# Your household assistant\n\nI can help with everyday questions, images, and documents. **Your conversation stays here.**\n\n| Task | Result |\n| --- | --- |\n| Read PDF | Ready |\n| Generate image | |\n\n```swift\nlet answer = 42\n```",
        "createdAt": "2026-09-30T12:30:00.125Z",
      ]
    ]
    static var receipts: [String: [String: Any]] = [:]
    static var draft: [String: Any] = ["text": "", "attachments": []]
    static var readPosition: [String: Any] = [:]
    static var preferences: [String: Any] = [
      "presentation": "simple", "theme": "system", "favorites": [], "sections": [],
      "followBots": [],
    ]
    static var items: [[String: Any]] = [
      [
        "id": "web", "name": "Web search",
        "description": "Search the web when current information matters.", "enabled": true,
      ],
      [
        "id": "shell", "name": "Terminal", "description": "Run commands on the assistant's server.",
        "enabled": false,
      ],
    ]
    static var routines: [[String: Any]] = []
    static var upgradePhase = "idle"
    static var integrationChecked = false
    static var integrationDisconnected = false
    static var upgradeReadsRemaining = 0
    static var avatar: [String: Any] = [
      "mode": "geometric", "shape": "blob", "color": "#1084FE", "eyes": "oval", "accessory": "none",
    ]
    static var bots: [[String: Any]] {
      [
        [
          "id": "ranch", "name": "Ranch hand", "description": "Everyday household help",
          "instructions": "Be clear and useful.", "model": "configured-model",
          "provider": "openrouter", "shared": true, "activity": "idle", "avatar": avatar,
          "enabledMcpServers": ["existing-calendar"],
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
          "ownerId": "native-test", "activity": "idle",
        ],
      ]
    }
    static let user: [String: Any] = [
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
      if path == "/api/bootstrap" {
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
          "connection": ["connected": true, "code": "ready", "version": "UI fixture"],
          "csrfToken": NSNull(),
          "capabilities": Dictionary(
            uniqueKeysWithValues: [
              "chat", "steering", "approvals", "uploads", "generatedFiles", "botConfiguration",
              "tools", "skills", "routines", "durableEvents", "idempotency", "imageGeneration",
              "stop", "portraitGeneration", "avatarMetadata",
            ].map { ($0, ["supported": true]) }),
        ]
      } else if path.hasSuffix("/conversation") {
        object = [
          "botId": path.components(separatedBy: "/")[3], "messages": Self.messages,
          "activity": ["state": "idle"], "approvals": [], "files": [], "attention": [],
          "draft": Self.draft, "readPosition": Self.readPosition,
        ]
        if ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_LIVE_ACTIVITY"] == "1" {
          object = [
            "botId": path.components(separatedBy: "/")[3],
            "messages": [["id": "fixture-answer", "role": "assistant", "text": "I'll check the current weather for the ranch.", "reasoning": "Fixture exposed reasoning: current weather needs a fresh forecast."]],
            "activity": ["state": "working", "detail": "Checking the latest forecast"],
            "toolCalls": [["id": "fixture-search", "name": "web_search", "arguments": "{\"query\":\"Texas ranch weather forecast\"}", "status": "running"]],
            "approvals": [], "files": [], "attention": [], "draft": Self.draft, "readPosition": Self.readPosition,
          ]
        }
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
      } else if path.hasPrefix("/api/hermes/upgrade") {
        if path.hasSuffix("/control") {
          Self.upgradePhase = "recovering"
          Self.upgradeReadsRemaining = 1
        } else if path.hasSuffix("/check") {
          Self.upgradePhase = "qualifying"
          Self.upgradeReadsRemaining = 1
        } else if path.hasSuffix("/install") {
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
        if ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_UPGRADE_FAILED"] == "1", Self.upgradePhase == "idle" { Self.upgradePhase = "failed" }
        let phase = Self.upgradePhase
        let fixtureChecks: [[String: Any]] = phase == "idle" ? [] : [["id": "compatibility", "label": "App compatibility", "status": phase == "qualifying" ? "running" : "passed", "detail": "Explicit simulator fixture, not a real Hermes upgrade."]]
        let fixtureMessage: String
        switch phase {
        case "idle": fixtureMessage = "Check the shared installation for a compatible update."
        case "succeeded": fixtureMessage = "Fixture update verified. Conversations are preserved."
        case "ready": fixtureMessage = "The candidate passed compatibility checks."
        default: fixtureMessage = "The server is \(phase) the fixture installation."
        }
        let upgrade: [String: Any] = [
          "available": true, "phase": phase,
          "current": ["revision": phase == "succeeded" ? "fixture-new-revision" : "fixture-old-revision", "version": phase == "succeeded" ? "Fixture 2.0" : "Fixture 1.0"],
          "candidate": ["revision": "fixture-new-revision", "version": "Fixture 2.0"],
          "message": fixtureMessage,
          "checks": fixtureChecks,
          "canCheck": ["idle", "ready", "succeeded"].contains(phase),
          "canInstall": phase == "ready", "canRetry": phase == "failed", "canCancel": phase == "failed", "canRestartService": phase == "failed", "operationId": "fixture-update", "busyBots": [],
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
        object = ["connected": true, "code": "ready", "version": "UI fixture"]
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
      } else if path == "/api/preferences" {
        if method == "PATCH" { Self.preferences = body }
        object = Self.preferences
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
      } else if path == "/api/native/push/config" {
        object = ["available": false, "environment": "sandbox"]
      } else if path == "/api/bots", method == "POST" {
        var bot = body
        bot["id"] = "created"
        bot["activity"] = "idle"
        object = bot
      } else if path.hasPrefix("/api/bots/"), method == "PATCH" {
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
  }
#endif
