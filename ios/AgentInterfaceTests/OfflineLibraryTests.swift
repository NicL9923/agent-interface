import XCTest
@testable import AgentInterface

private struct OfflineFixture<T: Decodable>: Decodable { var response: T }
final class OfflineLibraryTests: XCTestCase {
  private func fixture<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Contract/" + name + ".json")
    return try JSONDecoder().decode(OfflineFixture<T>.self, from: Data(contentsOf: url)).response
  }
  func testProtectedSnapshotExcludesAuthoritySecurePromptsAndStreamingContent() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let url = OfflineLibrary.url(origin: "https://one.test", token: "session", root: root)
    var bootstrap = try fixture("bootstrap", as: Bootstrap.self)
    bootstrap.csrfToken = "must-not-persist"
    var chat = try fixture("conversation", as: Conversation.self)
    chat.messages.append(Message(id: "stream-inflight", role: "assistant", text: "unfinished"))
    let snapshot = OfflineLibrary(savedAt: Date(), bootstrap: bootstrap, conversations: [chat.botId: chat], selected: chat.botId)
    snapshot.write(url)
    let restored = try XCTUnwrap(OfflineLibrary.read(url))
    XCTAssertFalse(restored.bootstrap.connection.connected)
    XCTAssertTrue(restored.bootstrap.capabilities.isEmpty)
    XCTAssertNil(restored.bootstrap.csrfToken)
    let copy = try XCTUnwrap(restored.conversations[chat.botId])
    XCTAssertNil(copy.attention); XCTAssertTrue(copy.approvals.isEmpty); XCTAssertNil(copy.draft); XCTAssertNil(copy.toolCalls)
    XCTAssertFalse(copy.messages.contains { $0.id == "stream-inflight" || $0.reasoning != nil || $0.toolCall != nil })
    XCTAssertFalse(String(decoding: try Data(contentsOf: url), as: UTF8.self).contains("must-not-persist"))
    XCTAssertNotEqual(url, OfflineLibrary.url(origin: "https://two.test", token: "session", root: root))
    XCTAssertNotEqual(url, OfflineLibrary.url(origin: "https://one.test", token: "different-account-session", root: root))
  }
  func testOldCorruptAndOversizedSnapshotsDoNotRestore() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let url = root.appendingPathComponent("snapshot.json")
    let snapshot = OfflineLibrary(savedAt: Date(timeIntervalSinceNow: -8 * 86400), bootstrap: try fixture("bootstrap", as: Bootstrap.self), conversations: [:])
    snapshot.write(url); XCTAssertNil(OfflineLibrary.read(url))
    try Data("broken".utf8).write(to: url); XCTAssertNil(OfflineLibrary.read(url))
    try Data(repeating: 0, count: OfflineLibrary.maximumBytes + 1).write(to: url); XCTAssertNil(OfflineLibrary.read(url))
  }
  func testByteBoundDropsWholeChatsRatherThanCuttingAnswers() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let url = root.appendingPathComponent("snapshot.json")
    var chat = try fixture("conversation", as: Conversation.self)
    chat.messages = [Message(id: "large", role: "assistant", text: String(repeating: "a", count: OfflineLibrary.maximumBytes + 100))]
    OfflineLibrary(savedAt: Date(), bootstrap: try fixture("bootstrap", as: Bootstrap.self), conversations: [chat.botId: chat], selected: chat.botId).write(url)
    XCTAssertTrue(try XCTUnwrap(OfflineLibrary.read(url)).conversations.isEmpty)
    XCTAssertLessThanOrEqual(try Data(contentsOf: url).count, OfflineLibrary.maximumBytes)
  }
}


extension OfflineLibraryTests {
  func testRewritingAnotherChatDoesNotExtendAnOldChatsRetention() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let url = root.appendingPathComponent("snapshot.json")
    let chat = try fixture("conversation", as: Conversation.self)
    let snapshot = OfflineLibrary(savedAt: Date(), bootstrap: try fixture("bootstrap", as: Bootstrap.self),
      conversations: ["old": chat, "fresh": chat], capturedAt: ["old": Date(timeIntervalSinceNow: -8 * 86400), "fresh": Date()])
    snapshot.write(url)
    let restored = try XCTUnwrap(OfflineLibrary.read(url))
    XCTAssertNil(restored.conversations["old"]); XCTAssertNotNil(restored.conversations["fresh"])
  }
}
