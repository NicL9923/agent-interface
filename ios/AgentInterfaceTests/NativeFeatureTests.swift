import UserNotifications
import os
import XCTest

@testable import AgentInterface

/// Notification sender pictures, the Talk to assistant control's links and on-device transcription.
@MainActor final class NativeFeatureTests: XCTestCase {
  private func temporaryDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("native-features-\(UUID().uuidString)", isDirectory: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
  }
  private func bot(_ id: String, _ avatar: AvatarConfig?) -> Bot {
    Bot(id: id, name: id.capitalized, model: "m", shared: true, avatar: avatar, activity: .idle)
  }

  func testSenderPicturesFollowTheAccountAndRedrawOnlyChangedAvatars() throws {
    let root = temporaryDirectory()
    var drawn: [String] = [], forgotten: [String] = []
    var avatars = SenderAvatars(root: root) { avatar, name in drawn.append(name); return Data((avatar.color ?? "").utf8) }
    avatars.forget = { forgotten.append($0) }
    let one = NotificationActions.accountMarker("one"), two = NotificationActions.accountMarker("two")
    var orange = AvatarConfig(); orange.color = "#FF9800"
    var portrait = AvatarConfig(); portrait.mode = .portrait
    avatars.sync(account: one, bots: [bot("kitchen", orange), bot("garden", nil), bot("porch", portrait)])
    let kitchen = try XCTUnwrap(NotificationSenders.avatarURL(account: one, botId: "kitchen", root: root))
    XCTAssertEqual(try Data(contentsOf: kitchen), Data("#FF9800".utf8))
    XCTAssertEqual(drawn, ["Kitchen", "Garden"], "A portrait is a photo the extension cannot load, so it gets no picture")
    XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(NotificationSenders.avatarURL(account: one, botId: "porch", root: root)).path))

    drawn = []
    avatars.sync(account: one, bots: [bot("kitchen", orange), bot("garden", nil)])
    XCTAssertEqual(drawn, [], "Unchanged avatars are not drawn again")
    var green = orange; green.color = "#4CAF50"
    avatars.sync(account: one, bots: [bot("kitchen", green)])
    XCTAssertEqual(drawn, ["Kitchen"])
    XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(NotificationSenders.avatarURL(account: one, botId: "garden", root: root)).path),
      "An assistant that left loses its picture")

    XCTAssertEqual(forgotten, [])
    avatars.sync(account: two, bots: [bot("kitchen", green)])
    XCTAssertFalse(FileManager.default.fileExists(atPath: kitchen.path), "Another sign-in removes the previous account's pictures")
    XCTAssertEqual(forgotten, [one], "and its donated messages")
    avatars.sync(account: nil, bots: [])
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [])
    XCTAssertEqual(forgotten, [one, two])
  }

  func testSenderPicturesNeverLeaveTheirFolder() {
    XCTAssertTrue(NotificationSenders.isAccountMarker(NotificationActions.accountMarker("one")))
    for marker in ["../../../../tmp", "0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", ""] {
      XCTAssertNil(NotificationSenders.avatarURL(account: marker, botId: "kitchen", root: temporaryDirectory()), marker)
    }
    let root = temporaryDirectory()
    let url = NotificationSenders.avatarURL(account: "0123456789abcdef", botId: "../../escape", root: root)
    XCTAssertEqual(url?.deletingLastPathComponent().standardizedFileURL.path, root.appendingPathComponent("0123456789abcdef").standardizedFileURL.path)
  }

  func testRealAvatarRendersToAPicture() throws {
    var avatar = AvatarConfig(); avatar.color = "#FF9800"
    let data = try XCTUnwrap(SenderAvatars.png(avatar, name: "Kitchen"))
    let image = try XCTUnwrap(UIImage(data: data))
    XCTAssertEqual(image.size.width * image.scale, 288)
    // For visual review: TEST_RUNNER_AGENT_INTERFACE_SCREENSHOT_DIR writes sample pictures there.
    if let directory = ProcessInfo.processInfo.environment["AGENT_INTERFACE_SCREENSHOT_DIR"] {
      for (index, family) in [nil, AvatarFamily.fox, .owl].enumerated() {
        var value = avatar; value.mode = family == nil ? .geometric : .mascot; value.family = family
        try SenderAvatars.png(value, name: "Kitchen")?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("sender-\(index).png"))
      }
    }
  }

  func testNotificationsWithoutAnAssistantOrForAnotherAccountStayAsSent() async throws {
    let root = temporaryDirectory()
    let signedIn = NotificationActions.accountMarker("one")
    try FileManager.default.createDirectory(at: try XCTUnwrap(NotificationSenders.directory(account: signedIn, root: root)), withIntermediateDirectories: true)
    for info in [["url": "/?view=today", "account": signedIn], ["url": "/?bot=kitchen", "botId": "kitchen", "account": "not-a-marker"],
      ["url": "/?bot=kitchen", "botId": "kitchen", "account": NotificationActions.accountMarker("signed-out")]] {
      let content = UNMutableNotificationContent()
      content.title = "Kitchen"
      content.userInfo = info
      let sent = ObjectIdentifier(content)
      let unchanged = await withCheckedContinuation { done in
        NotificationSenders.decorate(content, root: root) { done.resume(returning: ObjectIdentifier($0) == sent) }
      }
      XCTAssertTrue(unchanged, "\(info)")
    }
  }

  func testADonationFinishingAfterSignOutIsDeletedAndTheNotificationStaysAsSent() async throws {
    let root = temporaryDirectory()
    let account = NotificationActions.accountMarker("one")
    let folder = try XCTUnwrap(NotificationSenders.directory(account: account, root: root))
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let content = UNMutableNotificationContent()
    content.title = "Kitchen"
    content.userInfo = ["url": "/?bot=kitchen", "botId": "kitchen", "account": account]
    let sent = ObjectIdentifier(content), forgotten = OSAllocatedUnfairLock(initialState: [String]())
    let unchanged = await withCheckedContinuation { done in
      NotificationSenders.decorate(content, root: root, donate: { _, finished in
        // The app signs this account out while iOS records the donation.
        try? FileManager.default.removeItem(at: folder)
        finished(nil)
      }, forget: { account in forgotten.withLock { $0.append(account) } }) { done.resume(returning: ObjectIdentifier($0) == sent) }
    }
    XCTAssertTrue(unchanged)
    XCTAssertEqual(forgotten.withLock { $0 }, [account])
  }

  func testTalkLinksCarryListenIntoTheChatPath() throws {
    XCTAssertEqual(DeepLink.relativePath(for: DeepLink.bot("kitchen", listen: true)), "/?bot=kitchen&listen=1")
    XCTAssertEqual(DeepLink.relativePath(for: URL(string: "agentinterface://open?bot=kitchen&listen=yes")!), "/?bot=kitchen")
    XCTAssertNil(DeepLink.relativePath(for: URL(string: "agentinterface://open?listen=1")!))
    let origin = URL(string: "https://app.example.test")!
    XCTAssertEqual(NotificationController.botId(from: "/?bot=kitchen&listen=1", origin: origin), "kitchen")
    XCTAssertTrue(ListenRequest(botId: "kitchen", scope: "one", at: Date()).fresh())
    XCTAssertFalse(ListenRequest(botId: "kitchen", scope: "one", at: Date().addingTimeInterval(-ListenRequest.patience)).fresh())
  }

  func testControlLinkWaitsForTheAppOnceWhenRunOutsideIt() async throws {
    let location = temporaryDirectory().appendingPathComponent("pending-link.json")
    let previous = IntentLinks.handler
    defer { IntentLinks.handler = previous }
    IntentLinks.handler = nil
    let link = DeepLink.bot("kitchen", listen: true)
    let asked = Date()
    await IntentLinks.open(link, store: location)
    let pending = try XCTUnwrap(IntentLinks.takePending(from: location))
    XCTAssertEqual(pending.url, link)
    XCTAssertEqual(pending.at.timeIntervalSince(asked), 0, accuracy: 1, "The hand-off keeps when the control was used")
    XCTAssertNil(IntentLinks.takePending(from: location), "A waiting link opens once")
    await IntentLinks.open(link, store: location)
    XCTAssertNil(IntentLinks.takePending(from: location, now: Date().addingTimeInterval(IntentLinks.patience)), "A stale link is dropped")

    var opened: [URL] = []
    IntentLinks.handler = { opened.append($0) }
    await IntentLinks.open(link, store: location)
    XCTAssertEqual(opened, [link])
    XCTAssertNil(IntentLinks.takePending(from: location), "In the app the link opens at once instead of waiting")
  }

  func testAPushedActivityEndsBesideTheAppsOwnOrForAnotherAccount() {
    XCTAssertTrue(LiveActivityController.shouldEnd(scope: "one", signedIn: "one", among: [(id: "local", scope: "one")]))
    XCTAssertFalse(LiveActivityController.shouldEnd(scope: "one", signedIn: "one", among: []), "The first activity is kept")
    XCTAssertTrue(LiveActivityController.shouldEnd(scope: "one", signedIn: "two", among: []), "A start that arrived after sign-out goes")
    XCTAssertTrue(LiveActivityController.shouldEnd(scope: "one", signedIn: nil, among: []),
      "Nobody signed in here, as after an offline sign-out")
    XCTAssertFalse(LiveActivityController.shouldEnd(scope: "one", signedIn: "one", among: [(id: "old", scope: "two")]),
      "Another account's leftover is ended by the foreground check, not by keeping this one out")
  }

  func testOnDeviceTranscriptionComesFirstAndTheServerCoversWhatItCannot() async throws {
    let server = FakeServer { _ in .init(body: #"{"text":"Check the pasture gate","provider":"fixture"}"#) }
    let voice = VoiceController()
    voice.api = server.api(token: "fixture-token")
    voice.botId = "ranch"
    var transcripts: [String] = []
    voice.onTranscript = { transcripts.append($0) }

    voice.localTranscriber = LocalTranscriber { _ in "Open the north gate" }
    voice.transcribe(Data([1, 2, 3]))
    try await until { voice.state == .idle && !transcripts.isEmpty }
    XCTAssertEqual(transcripts, ["Open the north gate"])
    XCTAssertNil(server.lastRequest, "On-device speech never uploads the recording")

    for local in [LocalTranscriber { _ in nil }, LocalTranscriber { _ in "" }] {
      transcripts = []
      voice.localTranscriber = local
      voice.transcribe(Data([1, 2, 3]))
      try await until { voice.state == .idle && !transcripts.isEmpty }
      XCTAssertEqual(transcripts, ["Check the pasture gate"])
    }
    XCTAssertEqual(server.lastRequest?.url?.path, "/api/bots/ranch/voice/transcribe")
  }
}
