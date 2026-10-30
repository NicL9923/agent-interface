import Foundation

private struct CheckFailure: Error, CustomStringConvertible {
  var description: String
}
@main struct AppleSnapshotChecks {
  static func main() throws {
    func check(_ value: @autoclosure () -> Bool, _ message: String) throws {
      if !value() { throw CheckFailure(description: message) }
    }
    let chicago = TimeZone(identifier: "America/Chicago")!
    let sydney = TimeZone(identifier: "Australia/Sydney")!
    let locale = Locale(identifier: "en_US")
    let iso = ISO8601DateFormatter()
    func local(_ month: Int, _ day: Int, _ hour: Int = 0, _ minute: Int = 0, _ second: Int = 0, zone: TimeZone) -> Date {
      var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone
      return calendar.date(from: DateComponents(year: 2026, month: month, day: day, hour: hour, minute: minute, second: second))!
    }
    func components(_ day: Int, _ hour: Int? = nil) -> DateComponents {
      DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: hour == nil ? nil : 0)
    }
    let day = AppleSnapshotDates.reminder(list: "Home", title: "Date only", components: components(31), zone: chicago)
    try check(day.reminder.dueDate == "2026-10-31" && day.reminder.due == nil, "A day must not become a due instant")
    try check(day.key == iso.date(from: "2026-10-31T05:00:00Z"), "A date-only key uses the capture zone even without a component calendar")
    var foreignDay = components(31); foreignDay.timeZone = TimeZone(identifier: "Pacific/Auckland")
    let foreign = AppleSnapshotDates.reminder(list: "Home", title: "Foreign day", components: foreignDay, zone: chicago)
    try check(foreign.reminder.dueDate == "2026-10-31" && foreign.key == day.key, "A date-only timezone must not shift its day")
    var floating = components(31, 9)
    var utc = Calendar(identifier: .gregorian); utc.timeZone = TimeZone(secondsFromGMT: 0)!
    floating.calendar = utc
    let timed = AppleSnapshotDates.reminder(list: "Home", title: "Floating", components: floating, zone: chicago)
    try check(timed.key == iso.date(from: "2026-10-31T14:00:00Z"), "A floating time must ignore the attached calendar's timezone")
    var eastern = components(31, 9); eastern.timeZone = TimeZone(identifier: "America/New_York")
    let explicit = AppleSnapshotDates.reminder(list: "Home", title: "Eastern", components: eastern, zone: chicago)
    try check(explicit.key == iso.date(from: "2026-10-31T13:00:00Z") && explicit.reminder.dueDate == nil, "An explicit timezone must be respected for timed reminders")
    let undated = AppleSnapshotDates.reminder(list: "Home", title: "Undated", components: nil, zone: chicago)
    let partial = AppleSnapshotDates.reminder(list: "Home", title: "Partial", components: DateComponents(year: 2026, hour: 9), zone: chicago)
    try check(undated.key == nil && partial.key == nil && partial.reminder.due == nil, "Missing date fields must not invent a date")

    let start = local(10, 30, zone: chicago), end = local(11, 1, zone: chicago)
    let nextDay = AppleSnapshotDates.reminder(list: "Home", title: "Tomorrow", components: DateComponents(year: 2026, month: 11, day: 1), zone: chicago)
    let late = AppleSnapshotDates.reminder(list: "Home", title: "Late", components: DateComponents(year: 2026, month: 10, day: 31, hour: 23, minute: 59), zone: chicago)
    try check(AppleSnapshotDates.includes(day.key, start: start, exclusiveEnd: end, undated: false), "The Through day must be included")
    try check(AppleSnapshotDates.includes(late.key, start: start, exclusiveEnd: end, undated: false), "A late timed reminder on Through must be included")
    try check(!AppleSnapshotDates.includes(nextDay.key, start: start, exclusiveEnd: end, undated: true), "The day after Through must be excluded")
    try check(!AppleSnapshotDates.includes(nil, start: start, exclusiveEnd: end, undated: false) && AppleSnapshotDates.includes(nil, start: start, exclusiveEnd: end, undated: true), "Undated inclusion follows the selection")

    var a = day, b = day; a.reminder.title = "Same"; b.reminder.title = "Same"; a.reminder.list = "A"; b.reminder.list = "B"
    let midnight = AppleSnapshotDates.reminder(list: "Home", title: "Midnight", components: components(31, 0), zone: chicago)
    let ordered = AppleSnapshotDates.ordered([timed, undated, midnight, b, a])
    try check(ordered.prefix(2).map(\.list) == ["A", "B"], "Date-only entries precede a timed midnight, with deterministic list ties")
    try check(ordered.map(\.title) == ["Same", "Same", "Midnight", "Floating", "Undated"], "Sort by date, then precision, then names, with undated last")
    var alpha = day, zulu = day; alpha.reminder.title = "Alpha"; zulu.reminder.title = "Zulu"
    try check(AppleSnapshotDates.ordered([zulu, alpha]).map(\.title) == ["Alpha", "Zulu"], "Equal-day names sort predictably")

    let allDay = AppleSnapshotEvent(calendar: "Home", title: "All day", start: local(10, 31, zone: sydney), end: local(11, 1, zone: sydney), allDay: true)
    let snapshot = AppleDeviceSnapshot(capturedAt: allDay.start, windowStart: allDay.start, windowEnd: allDay.end, events: [allDay], reminders: [day.reminder], timeZone: sydney.identifier)
    let json = try JSONSerialization.jsonObject(with: snapshot.data()) as! [String: Any]
    let reminderJSON = (json["reminders"] as! [[String: Any]])[0]
    let eventJSON = (json["events"] as! [[String: Any]])[0]
    try check(reminderJSON["dueDate"] as? String == "2026-10-31" && reminderJSON["due"] == nil, "JSON must preserve a day without an invented time")
    try check(json["timeZone"] as? String == "Australia/Sydney", "The snapshot must carry its capture timezone")
    try check(eventJSON["start"] as? String == "2026-10-31T00:00:00+11:00", "All-day JSON must keep the correct local date and offset")
    try check(snapshot.itemSummary == "1 event · 1 reminder", "Snapshot counts must inflect")
    try check(AppleSnapshotDates.count(0, "event") == "0 events" && AppleSnapshotDates.count(1, "event") == "1 event" && AppleSnapshotDates.count(2, "event") == "2 events", "Counts handle zero, one and several")

    let dueLine = AppleSnapshotDates.reminderLine(day.reminder, zone: chicago, locale: locale)
    try check(dueLine.contains("Oct 31") && !dueLine.contains(":"), "The preview must not invent midnight for a date-only reminder")
    try check(AppleSnapshotDates.reminderLine(explicit.reminder, zone: chicago, locale: locale).contains("8:00"), "The timed preview must use the capture zone")
    try check(AppleSnapshotDates.reminderLine(undated.reminder, zone: chicago, locale: locale) == "No due date", "Undated preview must remain honest")
    let timedEvent = AppleSnapshotEvent(calendar: "Home", title: "Visit", start: local(10, 31, 9, zone: chicago), end: local(10, 31, 9, 30, zone: chicago), allDay: false)
    let timedLine = AppleSnapshotDates.eventLine(timedEvent, zone: chicago, locale: locale)
    try check(timedLine.components(separatedBy: "2026").count == 2 && timedLine.contains("9:00") && timedLine.contains("9:30"), "A same-day event should show its date once")
    let single = AppleSnapshotDates.eventLine(allDay, zone: sydney, locale: locale)
    try check(single == "All day · Oct 31, 2026", "A single-day event should not repeat the date")
    var several = allDay; several.start = local(10, 31, zone: chicago); several.end = local(11, 3, zone: chicago)
    let severalLine = AppleSnapshotDates.eventLine(several, zone: chicago, locale: locale)
    try check(severalLine.contains("Oct 31") && severalLine.contains("Nov 2") && !severalLine.contains("Nov 3"), "An exclusive all-day end must show the last included date")
    several.end = local(11, 2, 23, 59, 59, zone: chicago)
    try check(AppleSnapshotDates.eventLine(several, zone: chicago, locale: locale) == severalLine, "An end just before midnight should keep the same included days")
    var fallBack = allDay; fallBack.start = local(11, 1, zone: chicago); fallBack.end = local(11, 2, zone: chicago)
    try check(fallBack.end.timeIntervalSince(fallBack.start) == 25 * 3600, "The fixture must cross the fall-back transition")
    try check(AppleSnapshotDates.eventLine(fallBack, zone: chicago, locale: locale) == "All day · Nov 1, 2026", "A 25-hour all-day event still occupies one day")
    print("Apple snapshot conversion, window, sorting, encoding and presentation checks passed.")
  }
}
