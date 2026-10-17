import Foundation

/// Timestamp labels shared with the web client's `src/time.ts`, in the viewer's time zone.
enum When {
  /// "Just now", "10 min ago", "In 59 min", then "Today, 9:48 PM", "Yesterday, …", a weekday or a date.
  /// `inline` lowercases a leading relative word for use inside a sentence ("Since yesterday, 6:38 PM").
  /// `relative: false` suits scheduled times such as calendar events, which read better as clock times and keep the time in other years.
  /// `from` omits the day when the value falls on the same day, as in a range end.
  static func format(
    _ date: Date, now: Date = .now, inline: Bool = false, relative: Bool = true, from: Date? = nil,
    calendar: Calendar = .current, locale: Locale = .current
  ) -> String {
    let time = clock(date, calendar: calendar, locale: locale)
    let minutes = Int(abs(date.timeIntervalSince(now)) / 60)
    let days = dayOffset(date, from: now, calendar: calendar)
    let label: String
    if relative && minutes < 60 {
      label = minutes < 1 ? "Just now" : date < now ? "\(minutes) min ago" : "In \(minutes) min"
    } else if let from, calendar.isDate(from, inSameDayAs: date) {
      label = time
    } else if days == 0 {
      label = "Today, \(time)"
    } else if days == -1 {
      label = "Yesterday, \(time)"
    } else if days == 1 {
      label = "Tomorrow, \(time)"
    } else if abs(days) < 7 {
      label = "\(formatted(date, "EEE", calendar: calendar, locale: locale)) \(time)"
    } else if calendar.component(.year, from: date) == calendar.component(.year, from: now) {
      label = "\(formatted(date, "MMMd", calendar: calendar, locale: locale)), \(time)"
    } else {
      label = formatted(date, "yMMMd", calendar: calendar, locale: locale) + (relative ? "" : ", \(time)")
    }
    guard inline, ["Just", "In ", "Today", "Yesterday", "Tomorrow"].contains(where: label.hasPrefix) else { return label }
    return label.prefix(1).lowercased() + label.dropFirst()
  }

  /// Short list label: a clock time today, then Yesterday, a weekday, or a date.
  static func listDate(_ date: Date, now: Date = .now, calendar: Calendar = .current, locale: Locale = .current) -> String {
    let days = -dayOffset(date, from: now, calendar: calendar)
    if days <= 0 { return clock(date, calendar: calendar, locale: locale) }
    if days == 1 { return "Yesterday" }
    if days < 7 { return formatted(date, "EEE", calendar: calendar, locale: locale) }
    return calendar.component(.year, from: date) == calendar.component(.year, from: now)
      ? formatted(date, "MMMd", calendar: calendar, locale: locale)
      : formatted(date, "yMMMd", calendar: calendar, locale: locale)
  }

  /// Parses a server timestamp and formats it, or returns an empty string for an unreadable value.
  static func format(_ value: String, now: Date = .now, inline: Bool = false, relative: Bool = true) -> String {
    ServerDate.parse(value).map { format($0, now: now, inline: inline, relative: relative) } ?? ""
  }

  private static func dayOffset(_ date: Date, from now: Date, calendar: Calendar) -> Int {
    calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
  }
  private static func clock(_ date: Date, calendar: Calendar, locale: Locale) -> String {
    formatted(date, "jmm", calendar: calendar, locale: locale)
  }
  private static func formatted(_ date: Date, _ template: String, calendar: Calendar, locale: Locale) -> String {
    let formatter = DateFormatter()
    formatter.calendar = calendar
    formatter.timeZone = calendar.timeZone
    formatter.locale = locale
    formatter.setLocalizedDateFormatFromTemplate(template)
    return formatter.string(from: date)
  }
}
