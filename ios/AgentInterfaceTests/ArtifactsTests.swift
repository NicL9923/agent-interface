import XCTest
@testable import AgentInterface

/// The file list and file links against the web's Artifacts panel and FileLink
/// (src/components/Artifacts.tsx, src/app/Conversation.tsx).
@MainActor final class ArtifactsTests: XCTestCase {
  private func file(_ id: String, _ mime: String = "text/plain", size: Int? = nil, url: String? = nil) -> FileRef {
    FileRef(id: id, name: id, mime: mime, size: size, url: url)
  }
  private func conversation(files: [FileRef], messages: [Message]) -> Conversation {
    Conversation(botId: "bot", messages: messages, activity: Activity(state: .idle), approvals: [], files: files)
  }

  /// The web's src/shared/artifacts.ts reads the same vectors, so chips and the panel agree on both clients.
  func testReplyFilesMatchTheSharedVectors() throws {
    struct Case: Decodable { var name: String; var messages: [Message]; var files: [FileRef]?; var earlier: [EarlierFiles.Entry]?; var artifacts: [[String]]; var replies: [String: [String]] }
    struct Vectors: Decodable { var cases: [Case] }
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Vectors/reply-artifacts.json")
    let cases = try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url)).cases
    XCTAssertFalse(cases.isEmpty)
    for vector in cases {
      let listed = Artifacts.list(conversation(files: vector.files ?? [], messages: vector.messages), earlier: vector.earlier ?? [])
      XCTAssertEqual(listed.map { [$0.id, $0.source.rawValue] }, vector.artifacts, vector.name)
      let chips = Artifacts.replyFiles(vector.messages, artifacts: listed, earlier: vector.earlier ?? [])
      XCTAssertEqual(chips.mapValues { $0.map(\.id) }, vector.replies, vector.name)
      for artifact in chips.values.flatMap({ $0 }) { XCTAssertTrue(listed.contains(artifact), vector.name) }
    }
  }

  func testAWindowAfterTheStartHasNoChipsUntilTheHistoryBeforeItIsKnownThenTheListsOwn() async throws {
    let photo = file("photo", "image/png"), fixed = file("fixed", "image/png")
    var window = conversation(files: [photo, fixed], messages: [
      Message(id: "q9", role: "user", text: "Fix the photo I sent", sender: Sender(id: "one", name: "One")),
      Message(id: "a9", role: "assistant", text: "Fixed", files: [photo, fixed]),
    ])
    window.earlier = 6
    XCTAssertEqual(Artifacts.windowReplyFiles(window, earlier: nil), [:], "Unknown history: no chip rather than a wrong one")
    let shared = [EarlierFiles.Entry(id: "q2", role: "user", files: [photo])]
    XCTAssertEqual(Artifacts.windowReplyFiles(window, earlier: shared).mapValues { $0.map(\.id) }, ["a9": ["fixed"]])
    window.earlier = 0
    XCTAssertEqual(Artifacts.windowReplyFiles(window, earlier: nil).mapValues { $0.map(\.id) }, ["a9": ["photo", "fixed"]])

    // The store reads the history before the window itself, and the chips follow it.
    let server = FakeServer { request in
      request.url?.path.hasSuffix("/files") == true ? .init(body: #"{"messages":[{"id":"q2","role":"user","files":[{"id":"photo","name":"photo","mime":"image/png"}]}]}"#) : .init()
    }
    let store = AppStore(); store.widgetSnapshotURL = nil; store.api = server.api()
    defer { FakeExchange.remove(host: server.origin.host!) }
    store.selectedBotId = "bot"
    window.earlier = 6
    store.conversation = window
    XCTAssertEqual(store.replyFiles, [:])
    try await until { store.replyFiles["a9"]?.map(\.id) == ["fixed"] }
    XCTAssertEqual(server.requests.first { $0.url?.path.hasSuffix("/files") == true }?.url?.query, "before=q9")
    XCTAssertEqual(store.conversationArtifacts.first { $0.id == "photo" }?.source, .shared, "The list agrees")
  }

  func testAFilePreviewUsesItsOwningSheetInsteadOfTheRootPresenter() async throws {
    let server = FakeServer { _ in .init(body: "Gate battery plan") }
    let store = AppStore(); store.widgetSnapshotURL = nil; store.api = server.api()
    var preview: PreviewFile?
    let task = store.open(file("plan.txt"), present: { preview = $0 })
    await task.value
    let value = try XCTUnwrap(preview)
    defer { try? FileManager.default.removeItem(at: value.url.deletingLastPathComponent()) }
    XCTAssertEqual(try String(contentsOf: value.url, encoding: .utf8), "Gate battery plan")
    XCTAssertNil(store.openedFile, "Only the sheet that requested the preview presents it")
    XCTAssertEqual(server.lastRequest?.url?.path, "/api/files/plan.txt")
  }

  func testAPreviewFailureIsReportedToItsOwningSheet() async {
    let server = FakeServer { _ in .init(status: 404, body: #"{"error":"This archived file is unavailable."}"#) }
    let store = AppStore(); store.widgetSnapshotURL = nil; store.api = server.api()
    var message: String?
    let task = store.open(file("missing.txt"), present: { _ in XCTFail("No preview exists for a failed request") },
      onError: { message = $0.localizedDescription })
    await task.value
    XCTAssertEqual(message, "This archived file is unavailable.")
    XCTAssertNil(store.openedFile)
  }

  func testSourcesFollowWhoSentTheFileInConversationOrder() {
    let earlier = [EarlierFiles.Entry(id: "e1", role: "user", files: [file("photo.png", "image/png")])]
    let value = conversation(
      files: [file("report.pdf", "application/pdf", size: 2048), file("loose.txt")],
      messages: [
        Message(id: "m1", role: "assistant", text: "", files: [file("report.pdf", "application/pdf")]),
        Message(id: "m2", role: "user", text: "", files: [file("photo.png", "image/png"), file("note.md", "text/markdown")]),
        Message(id: "m3", role: "assistant", text: "", files: [file("photo.png", "image/png")]),
      ])
    let artifacts = Artifacts.list(value, earlier: earlier)
    XCTAssertEqual(artifacts.map(\.id), ["photo.png", "report.pdf", "loose.txt", "note.md"])
    XCTAssertEqual(artifacts.map(\.source), [.shared, .generated, .artifact, .shared], "Shared once stays shared")
    XCTAssertEqual(artifacts[1].file.size, 2048, "The conversation's record keeps its size")
    XCTAssertTrue(Artifacts.list(nil).isEmpty)
  }

  func testKindsUseTheWebsExactTypeSets() {
    XCTAssertEqual(ArtifactKind.of(file("a", "image/png")), .image)
    XCTAssertEqual(ArtifactKind.of(file("a", "image/svg+xml")), .other)
    XCTAssertEqual(ArtifactKind.of(file("a", "text/html")), .other)
    XCTAssertEqual(ArtifactKind.of(file("a", "Text/Plain; charset=utf-8")), .text)
    XCTAssertEqual(ArtifactKind.of(file("a", "application/json")), .text)
    XCTAssertEqual(ArtifactKind.of(file("a", "application/pdf")), .document)
    XCTAssertEqual(ArtifactKind.of(file("a", "audio/x-wav")), .audio)
    XCTAssertEqual(ArtifactKind.of(file("a", "video/quicktime")), .other)
    XCTAssertEqual(ArtifactKind.allCases.map(\.label), ["All types", "Images", "Text", "Documents", "Audio", "Video", "Other files"])
  }

  func testFilterAndSizeLabels() {
    let artifacts = [Artifact(file: file("Hay.PNG", "image/png"), source: .shared), Artifact(file: file("hay.txt"), source: .generated)]
    XCTAssertEqual(Artifacts.filter(artifacts, query: " hay ", kind: .all).count, 2)
    XCTAssertEqual(Artifacts.filter(artifacts, query: "HAY", kind: .image).map(\.id), ["Hay.PNG"])
    XCTAssertTrue(Artifacts.filter(artifacts, query: "fence", kind: .all).isEmpty)
    XCTAssertEqual(Artifacts.size(nil), "")
    XCTAssertEqual(Artifacts.size(512), "512 B")
    XCTAssertEqual(Artifacts.size(1536), "1.5 KB")
    XCTAssertEqual(Artifacts.size(3 * 1024 * 1024), "3.0 MB")
  }

  func testOnlyTheAppsOwnFileRouteIsManagedAndOtherWebAddressesOpenExternally() {
    let origin = URL(string: "https://ranch.test")!
    XCTAssertEqual(file("a b").location(origin: origin), .managed)
    XCTAssertEqual(file("a b", url: "/api/files/a%20b").location(origin: origin), .managed)
    XCTAssertEqual(file("x", url: "https://ranch.test/api/files/x").location(origin: origin), .managed)
    XCTAssertEqual(file("x", url: "https://ranch.test/api/files/x?download=1").location(origin: origin),
      .external(URL(string: "https://ranch.test/api/files/x?download=1")!))
    XCTAssertEqual(file("x", url: "https://cdn.test/x.png").location(origin: origin), .external(URL(string: "https://cdn.test/x.png")!))
    XCTAssertEqual(file("x", url: "https://other.test/api/files/x").location(origin: origin), .external(URL(string: "https://other.test/api/files/x")!))
    XCTAssertEqual(file("x", url: "javascript:alert(1)").location(origin: origin), .unsupported)
    XCTAssertEqual(file("x", url: "https://user:secret@cdn.test/x").location(origin: origin), .unsupported)
    XCTAssertEqual(file("x", url: "file:///etc/hosts").location(origin: origin), .unsupported)
  }
}
