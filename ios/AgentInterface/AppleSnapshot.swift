import Foundation

struct AppleSnapshotEvent: Codable, Sendable {
  var calendar: String
  var title: String
  var start: Date
  var end: Date
  var allDay: Bool
}
struct AppleSnapshotReminder: Codable, Sendable {
  var list: String
  var title: String
  var due: Date?
  /// A Gregorian calendar day, not a midnight instant.
  var dueDate: String? = nil
}
struct AppleDeviceSnapshot: Codable, Sendable {
  var source = "Apple Calendar and Reminders, explicitly selected on this iPhone"
  var capturedAt: Date
  var windowStart: Date
  var windowEnd: Date
  var events: [AppleSnapshotEvent]
  var reminders: [AppleSnapshotReminder]
  var timeZone = TimeZone.current.identifier
  var note = "This is a snapshot, not a live connection. Refresh and share again for current data. Event notes and locations, attendees, and account identifiers are omitted. Date-only reminders use dueDate as YYYY-MM-DD and have no due time."
  var itemSummary: String { "\(AppleSnapshotDates.count(events.count, "event")) · \(AppleSnapshotDates.count(reminders.count, "reminder"))" }
  func data() throws -> Data {
    guard let zone = TimeZone(identifier: timeZone) else {
      throw EncodingError.invalidValue(timeZone, .init(codingPath: [], debugDescription: "Unknown snapshot time zone."))
    }
    let style = Date.ISO8601FormatStyle(timeZoneSeparator: .colon, timeZone: zone)
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .custom { date, encoder in
      var container = encoder.singleValueContainer()
      try container.encode(date.formatted(style))
    }
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    return try encoder.encode(self)
  }
}

/// Snapshot conversion and presentation without EventKit access or SwiftUI.
enum AppleSnapshotDates {
  typealias ReminderItem = (reminder: AppleSnapshotReminder, key: Date?)
  private static func calendar(_ zone: TimeZone) -> Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    return calendar
  }
  static func reminder(list: String, title: String, components: DateComponents?, zone: TimeZone) -> ReminderItem {
    guard var components, let year = components.year, let month = components.month, let day = components.day else {
      return (AppleSnapshotReminder(list: list, title: title, due: nil), nil)
    }
    if components.hour == nil && components.minute == nil && components.second == nil {
      let key = calendar(zone).date(from: DateComponents(year: year, month: month, day: day))
      return (AppleSnapshotReminder(list: list, title: title, due: nil, dueDate: String(format: "%04d-%02d-%02d", year, month, day)), key)
    }
    let clock = calendar(components.timeZone ?? zone)
    // A floating time belongs to the capture zone, not the attached calendar's zone.
    components.calendar = nil
    components.timeZone = nil
    let key = clock.date(from: components)
    return (AppleSnapshotReminder(list: list, title: title, due: key), key)
  }
  static func includes(_ key: Date?, start: Date, exclusiveEnd: Date, undated: Bool) -> Bool {
    guard let key else { return undated }
    return key >= start && key < exclusiveEnd
  }
  static func ordered(_ items: [ReminderItem]) -> [AppleSnapshotReminder] {
    items.sorted { left, right in
      switch (left.key, right.key) {
      case (.none, .some): return false
      case (.some, .none): return true
      case let (.some(a), .some(b)) where a != b: return a < b
      default: break
      }
      let a = left.reminder, b = right.reminder
      if (a.dueDate != nil) != (b.dueDate != nil) { return a.dueDate != nil }
      let titles = a.title.localizedStandardCompare(b.title)
      if titles != .orderedSame { return titles == .orderedAscending }
      return a.list.localizedStandardCompare(b.list) == .orderedAscending
    }.map(\.reminder)
  }
  private static func formatter(zone: TimeZone, locale: Locale, time: DateFormatter.Style) -> DateFormatter {
    let formatter = DateFormatter()
    formatter.locale = locale
    formatter.timeZone = zone
    formatter.dateStyle = .medium
    formatter.timeStyle = time
    return formatter
  }
  static func dayLine(_ date: Date, zone: TimeZone, locale: Locale = .autoupdatingCurrent) -> String {
    formatter(zone: zone, locale: locale, time: .none).string(from: date)
  }
  static func instantLine(_ date: Date, zone: TimeZone, locale: Locale = .autoupdatingCurrent) -> String {
    formatter(zone: zone, locale: locale, time: .short).string(from: date)
  }
  static func eventLine(_ event: AppleSnapshotEvent, zone: TimeZone, locale: Locale = .autoupdatingCurrent) -> String {
    let formatter = DateIntervalFormatter()
    formatter.locale = locale
    formatter.timeZone = zone
    formatter.dateStyle = .medium
    formatter.timeStyle = event.allDay ? .none : .short
    if event.allDay {
      let clock = calendar(zone)
      let start = clock.startOfDay(for: event.start)
      let last = clock.startOfDay(for: event.end.addingTimeInterval(-1))
      if start == last { return "All day · \(dayLine(start, zone: zone, locale: locale))" }
      return "All day · \(formatter.string(from: start, to: last))"
    }
    return formatter.string(from: event.start, to: event.end)
  }
  static func reminderLine(_ reminder: AppleSnapshotReminder, zone: TimeZone, locale: Locale = .autoupdatingCurrent) -> String {
    if let due = reminder.due { return "Due \(instantLine(due, zone: zone, locale: locale))" }
    if let day = reminder.dueDate {
      let parts = day.split(separator: "-").compactMap { Int($0) }
      if parts.count == 3, let date = calendar(zone).date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) {
        return "Due \(dayLine(date, zone: zone, locale: locale))"
      }
      return "Due \(day)"
    }
    return "No due date"
  }
  static func count(_ n: Int, _ noun: String) -> String { "\(n) \(noun)\(n == 1 ? "" : "s")" }
}
