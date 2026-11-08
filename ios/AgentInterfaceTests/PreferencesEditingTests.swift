import XCTest
@testable import AgentInterface

final class PreferencesEditingTests: XCTestCase {
  private func preferences(_ sections: [BotSection]) -> Preferences {
    var value = Preferences()
    value.sections = sections
    return value
  }
  private let house = BotSection(id: "house", name: "Around the house", botIds: ["ranch"])
  private let kids = BotSection(id: "kids", name: "Kids", botIds: ["tutor"])

  func testMovingABotLeavesItInExactlyOneSection() {
    // Older data could list an assistant in two sections; one move settles it.
    var start = preferences([house, kids])
    start.sections[1].botIds.append("ranch")
    let moved = start.moving(bot: "ranch", toSection: "kids")
    XCTAssertEqual(moved.sections.map(\.botIds), [[], ["tutor", "ranch"]])
    XCTAssertEqual(moved.section(of: "ranch")?.id, "kids")
    let removed = moved.moving(bot: "ranch", toSection: nil)
    XCTAssertNil(removed.section(of: "ranch"))
    XCTAssertEqual(removed.sections.map(\.botIds), [[], ["tutor"]])
  }

  func testMovingToAMissingSectionOnlyRemovesTheBot() {
    let moved = preferences([house]).moving(bot: "ranch", toSection: "gone")
    XCTAssertEqual(moved.sections.map(\.botIds), [[]])
  }

  func testFollowingIsASetWithoutDuplicates() {
    let once = Preferences().settingFollow("ranch", true).settingFollow("ranch", true)
    XCTAssertEqual(once.followBots, ["ranch"])
    XCTAssertTrue(once.isFollowing("ranch"))
    XCTAssertEqual(once.settingFollow("ranch", false).followBots, [])
  }

  func testAddingASectionTrimsAndRefusesBlankNamesAndTheLimit() throws {
    XCTAssertNil(Preferences().addingSection(named: "   "))
    let added = try XCTUnwrap(Preferences().addingSection(named: "  Kids  ", id: "k"))
    XCTAssertEqual(added.sections, [BotSection(id: "k", name: "Kids", botIds: [])])
    let long = try XCTUnwrap(Preferences().addingSection(named: String(repeating: "a", count: 150)))
    XCTAssertEqual(long.sections[0].name.count, Preferences.sectionNameLimit)
    let full = preferences((0..<Preferences.sectionLimit).map { BotSection(id: "\($0)", name: "S\($0)", botIds: []) })
    XCTAssertFalse(full.canAddSection)
    XCTAssertNil(full.addingSection(named: "One more"))
  }

  func testRenamingKeepsTypingButCapsLengthAndBlankNamesStillRead() {
    let renamed = preferences([house]).renamingSection("house", to: "")
    XCTAssertEqual(renamed.sections[0].name, "")
    XCTAssertEqual(renamed.sections[0].displayName, "Untitled section")
    XCTAssertEqual(renamed.renamingSection("house", to: String(repeating: "b", count: 120)).sections[0].name.count, 100)
  }

  func testReorderingMatchesListMoveSemantics() {
    let c = BotSection(id: "c", name: "C", botIds: [])
    let start = preferences([house, kids, c])
    XCTAssertEqual(start.movingSections(fromOffsets: [0], toOffset: 3).sections.map(\.id), ["kids", "c", "house"])
    XCTAssertEqual(start.movingSections(fromOffsets: [2], toOffset: 0).sections.map(\.id), ["c", "house", "kids"])
    XCTAssertEqual(start.movingSections(fromOffsets: [0, 1], toOffset: 3).sections.map(\.id), ["c", "house", "kids"])
    XCTAssertEqual(start.movingSections(fromOffsets: [1], toOffset: 1).sections.map(\.id), ["house", "kids", "c"])
  }

  func testRemovingASectionReturnsItsAssistantsToTheRemainingList() {
    let bots = ["ranch", "tutor"].map { Bot(id: $0, name: $0, model: "m", shared: true, activity: .idle) }
    let removed = preferences([house, kids]).removingSection("house")
    XCTAssertEqual(removed.assistantGroups(bots).map(\.id), ["section:kids", "remaining"])
    XCTAssertEqual(removed.assistantGroups(bots).last?.bots.map(\.id), ["ranch"])
  }

  func testSummariesCountPlainly() {
    XCTAssertEqual(HomeSummary.following(0), "Not following any assistants")
    XCTAssertEqual(HomeSummary.following(1), "Following 1 assistant")
    XCTAssertEqual(HomeSummary.following(3), "Following 3 assistants")
    XCTAssertEqual(HomeSummary.assistants(0), "No assistants")
    XCTAssertEqual(HomeSummary.assistants(2), "2 assistants")
  }
}

final class HermesRevisionTextTests: XCTestCase {
  private let revision = "3f9c2a71b0d4e8f6a5c3b2d1e0f9a8b7c6d5e4f3"
  private let us = Locale(identifier: "en_US")
  private let utc = TimeZone(identifier: "UTC")!

  func testDateLeadsAndTheShortHashStaysAsDetail() {
    let date = HermesRevisionText.date("2026-10-20T18:05:00Z", locale: us, timeZone: utc)
    XCTAssertEqual(date, "Oct 20, 2026")
    XCTAssertEqual(HermesRevisionText.title(revision: revision, version: nil, date: date), "Released Oct 20, 2026")
    XCTAssertEqual(HermesRevisionText.detail(revision: revision, version: nil, date: date), "3f9c2a7")
    XCTAssertEqual(HermesRevisionText.detail(revision: revision, version: "0.9.5", date: date), "0.9.5 · 3f9c2a7")
  }

  func testWithoutADateTheVersionOrShortHashStandsIn() {
    XCTAssertNil(HermesRevisionText.date(nil))
    XCTAssertNil(HermesRevisionText.date("not a date"))
    XCTAssertEqual(HermesRevisionText.title(revision: revision, version: "0.9.5", date: nil), "0.9.5")
    XCTAssertEqual(HermesRevisionText.title(revision: revision, version: nil, date: nil), "3f9c2a7")
    XCTAssertNil(HermesRevisionText.detail(revision: revision, version: nil, date: nil))
  }

  func testOlderServersDecodeAndTheFooterFallsBackToTheShortHash() throws {
    let old = try JSONDecoder().decode(RuntimeStatus.self, from: Data(#"{"connected":true,"version":"\#(revision)"}"#.utf8))
    XCTAssertEqual(old.hermesLabel, "Hermes 3f9c2a7")
    XCTAssertNil(old.hermesDetail)
    let dated = try JSONDecoder().decode(RuntimeStatus.self, from: Data(#"{"connected":true,"version":"\#(revision)","revisionDate":"2026-10-14T16:20:00Z"}"#.utf8))
    XCTAssertEqual(dated.hermesDetail, "3f9c2a7")
    XCTAssertTrue(dated.hermesLabel?.hasPrefix("Hermes released ") == true)
    let revision = try JSONDecoder().decode(UpgradeRevision.self, from: Data(#"{"revision":"\#(revision)","committedAt":"2026-10-20T18:05:00.000Z"}"#.utf8))
    XCTAssertNotNil(revision.releaseDate)
    XCTAssertEqual(revision.displayDetail, "3f9c2a7")
  }
}
