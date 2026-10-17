import XCTest
@testable import AgentInterface

final class WhenTests: XCTestCase {
  private var calendar: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "America/Chicago")!
    return calendar
  }()
  private let locale = Locale(identifier: "en_US")
  // Friday, October 16, 2026 at 9:00 PM in Chicago.
  private lazy var now = calendar.date(from: DateComponents(year: 2026, month: 10, day: 16, hour: 21))!

  private func at(_ day: Int, _ hour: Int, _ minute: Int = 0, month: Int = 10, year: Int = 2026) -> Date {
    calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
  }
  private func when(_ date: Date, inline: Bool = false, relative: Bool = true, from: Date? = nil) -> String {
    When.format(date, now: now, inline: inline, relative: relative, from: from, calendar: calendar, locale: locale)
  }

  func testRelativeLabelsWithinAnHourMatchWeb() {
    XCTAssertEqual(when(now.addingTimeInterval(-20)), "Just now")
    XCTAssertEqual(when(now.addingTimeInterval(-600)), "10 min ago")
    XCTAssertEqual(when(now.addingTimeInterval(59 * 60 + 30)), "In 59 min")
    XCTAssertEqual(when(now.addingTimeInterval(-600), relative: false), "Today, 8:50\u{202F}PM")
  }

  func testDayLabelsMatchWeb() {
    XCTAssertEqual(when(at(16, 8, 5)), "Today, 8:05\u{202F}AM")
    XCTAssertEqual(when(at(15, 21, 48)), "Yesterday, 9:48\u{202F}PM")
    XCTAssertEqual(when(at(17, 7)), "Tomorrow, 7:00\u{202F}AM")
    XCTAssertEqual(when(at(13, 9)), "Tue 9:00\u{202F}AM")
    XCTAssertEqual(when(at(2, 11)), "Oct 2, 11:00\u{202F}AM")
    XCTAssertEqual(when(at(2, 11, year: 2025)), "Oct 2, 2025")
    XCTAssertEqual(when(at(15, 21, 48), inline: true), "yesterday, 9:48\u{202F}PM")
    XCTAssertEqual(when(at(13, 9), inline: true), "Tue 9:00\u{202F}AM")
    XCTAssertEqual(when(at(13, 10), from: at(13, 9)), "10:00\u{202F}AM")
  }

  func testListDatesMatchWeb() {
    let list = { (date: Date) in When.listDate(date, now: self.now, calendar: self.calendar, locale: self.locale) }
    XCTAssertEqual(list(at(16, 8, 5)), "8:05\u{202F}AM")
    XCTAssertEqual(list(at(15, 23)), "Yesterday")
    XCTAssertEqual(list(at(12, 9)), "Mon")
    XCTAssertEqual(list(at(2, 9)), "Oct 2")
    XCTAssertEqual(list(at(2, 9, year: 2025)), "Oct 2, 2025")
  }
}
