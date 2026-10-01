import EventKit
import SwiftUI

struct AppleSnapshotEvent: Codable {
  var calendar: String
  var title: String
  var start: Date
  var end: Date
  var allDay: Bool
}
struct AppleSnapshotReminder: Codable {
  var list: String
  var title: String
  var due: Date?
}
struct AppleDeviceSnapshot: Codable {
  var source = "Apple Calendar and Reminders, explicitly selected on this iPhone"
  var capturedAt: Date
  var windowStart: Date
  var windowEnd: Date
  var events: [AppleSnapshotEvent]
  var reminders: [AppleSnapshotReminder]
  var note = "This is a snapshot, not a live connection. Refresh and share again for current data. Notes, locations, attendees, and account identifiers are omitted."
  func data() throws -> Data {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    return try encoder.encode(self)
  }
}

@MainActor final class AppleDeviceConnection: ObservableObject {
  private let eventStore = EKEventStore()
  @Published var calendars: [EKCalendar] = []
  @Published var lists: [EKCalendar] = []
  @Published var calendarStatus = EKEventStore.authorizationStatus(for: .event)
  @Published var reminderStatus = EKEventStore.authorizationStatus(for: .reminder)
  func refreshAccess() {
    calendarStatus = EKEventStore.authorizationStatus(for: .event)
    reminderStatus = EKEventStore.authorizationStatus(for: .reminder)
    calendars = calendarStatus == .fullAccess ? eventStore.calendars(for: .event) : []
    lists = reminderStatus == .fullAccess ? eventStore.calendars(for: .reminder) : []
  }
  func requestCalendar() async throws { _ = try await eventStore.requestFullAccessToEvents(); refreshAccess() }
  func requestReminders() async throws { _ = try await eventStore.requestFullAccessToReminders(); refreshAccess() }
  static func includesReminder(due: Date?, start: Date, exclusiveEnd: Date, undated: Bool) -> Bool {
    guard let due else { return undated }
    return due >= start && due < exclusiveEnd
  }
  func snapshot(calendars selectedCalendars: Set<String>, lists selectedLists: Set<String>, start: Date, end: Date, undated: Bool) async throws -> AppleDeviceSnapshot {
    refreshAccess()
    guard start <= end, end <= Calendar.current.date(byAdding: .day, value: 90, to: start)! else { throw APIError(message: "Choose a date window of 90 days or less.", status: 400) }
    let allowedCalendars = calendars.filter { selectedCalendars.contains($0.calendarIdentifier) }
    let allowedLists = lists.filter { selectedLists.contains($0.calendarIdentifier) }
    guard !allowedCalendars.isEmpty || !allowedLists.isEmpty else { throw APIError(message: "Choose at least one calendar or reminder list you have allowed.", status: 400) }
    let events = allowedCalendars.isEmpty ? [] : eventStore.events(matching: eventStore.predicateForEvents(withStart: start, end: end, calendars: allowedCalendars))
      .sorted { $0.startDate < $1.startDate }.map { AppleSnapshotEvent(calendar: $0.calendar.title, title: $0.title ?? "Untitled event", start: $0.startDate, end: $0.endDate, allDay: $0.isAllDay) }
    var reminders: [AppleSnapshotReminder] = []
    if !allowedLists.isEmpty {
      let predicate = eventStore.predicateForReminders(in: allowedLists)
      let fetched: [EKReminder] = await withCheckedContinuation { continuation in
        eventStore.fetchReminders(matching: predicate) { continuation.resume(returning: $0 ?? []) }
      }
      reminders = fetched.filter { reminder in
        guard !reminder.isCompleted else { return false }
        return Self.includesReminder(due: reminder.dueDateComponents?.date, start: start, exclusiveEnd: end, undated: undated)
      }.map { AppleSnapshotReminder(list: $0.calendar.title, title: $0.title ?? "Untitled reminder", due: $0.dueDateComponents?.date) }
        .sorted { ($0.due ?? .distantFuture) < ($1.due ?? .distantFuture) }
    }
    return AppleDeviceSnapshot(capturedAt: Date(), windowStart: start, windowEnd: end, events: events, reminders: reminders)
  }
}

struct AppleDeviceConnectionsView: View {
  var botId: String
  @EnvironmentObject private var store: AppStore
  @Environment(\.scenePhase) private var scenePhase
  @StateObject private var connection = AppleDeviceConnection()
  @State private var selectedCalendars: Set<String> = []
  @State private var selectedLists: Set<String> = []
  @State private var start = Calendar.current.startOfDay(for: Date())
  @State private var end = Calendar.current.date(byAdding: .day, value: 14, to: Calendar.current.startOfDay(for: Date()))!
  @State private var undated = false
  @State private var snapshot: AppleDeviceSnapshot?
  @State private var busy = false
  @State private var error: String?
  @State private var notice: String?
  @State private var confirmShare = false
  private var botName: String { store.bootstrap?.bots.first { $0.id == botId }?.name ?? "this assistant" }
  private var sharedKey: String { "apple.lastShared.\(store.scope ?? "").\(botId)" }
  var body: some View {
    Form {
      Section {
        Label("On this iPhone", systemImage: "iphone").font(.headline)
        Text("Choose calendars and reminder lists, preview a snapshot, then add it to \(botName)'s conversation.").foregroundStyle(.secondary)
        if let time = UserDefaults.standard.object(forKey: sharedKey) as? Date {
          Text("Last added to draft \(time.formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(.secondary)
        }
      } footer: { Text("Hermes cannot read this phone while the app is closed. Nothing is shared until you send the snapshot in your conversation.") }
      Section("Calendar access") {
        accessLabel(connection.calendarStatus)
        if connection.calendarStatus != .fullAccess {
          Button("Allow calendar access") { perform { try await connection.requestCalendar() } }
        }
        ForEach(connection.calendars, id: \.calendarIdentifier) { calendar in
          Toggle(calendar.title, isOn: membership(calendar.calendarIdentifier, calendars: true))
        }
      }
      Section("Reminders access") {
        accessLabel(connection.reminderStatus)
        if connection.reminderStatus != .fullAccess {
          Button("Allow reminders access") { perform { try await connection.requestReminders() } }
        }
        ForEach(connection.lists, id: \.calendarIdentifier) { list in Toggle(list.title, isOn: membership(list.calendarIdentifier, calendars: false)) }
        Toggle("Include reminders with no due date", isOn: $undated).onChange(of: undated) { _, _ in snapshot = nil }
      }
      if connection.calendarStatus == .denied || connection.reminderStatus == .denied {
        Section { Button("Open iOS permission settings") { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } } }
      }
      Section {
        DatePicker("From", selection: $start, displayedComponents: .date).onChange(of: start) { _, value in
          if end < value || end > Calendar.current.date(byAdding: .day, value: 89, to: value)! { end = Calendar.current.date(byAdding: .day, value: 14, to: value)! }
          snapshot = nil
        }
        DatePicker("Through", selection: $end, in: start...(Calendar.current.date(byAdding: .day, value: 89, to: start)!), displayedComponents: .date).onChange(of: end) { _, _ in snapshot = nil }
        Button(snapshot == nil ? "Preview selected data" : "Refresh selected data") {
          perform {
            snapshot = try await connection.snapshot(calendars: selectedCalendars, lists: selectedLists, start: start, end: Calendar.current.date(byAdding: .day, value: 1, to: end)!, undated: undated)
            notice = nil
          }
        }.disabled(selectedCalendars.isEmpty && selectedLists.isEmpty)
      } header: { Text("Date window") } footer: { Text("Choose up to 90 days. Only event titles, times, reminder titles, due dates, and selected list names are included. Completed reminders are omitted.") }
      if let snapshot {
        Section("Review before sharing") {
          Text("\(snapshot.events.count) events · \(snapshot.reminders.count) reminders")
          Text("Refreshed \(snapshot.capturedAt.formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(.secondary)
          DisclosureGroup("Preview snapshot") {
            ForEach(Array(snapshot.events.enumerated()), id: \.offset) { _, event in
              VStack(alignment: .leading) { Text(event.title); Text("\(event.calendar) · \(event.start.formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(.secondary) }
            }
            ForEach(Array(snapshot.reminders.enumerated()), id: \.offset) { _, reminder in
              VStack(alignment: .leading) { Text(reminder.title); Text(reminder.list).font(.caption).foregroundStyle(.secondary) }
            }
          }
          Button("Share with \(botName)") { confirmShare = true }.disabled(!store.connected || !store.supports("uploads") || botId.isEmpty)
        }
      }
      if let error { Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) } }
      if let notice { Section { Label(notice, systemImage: "checkmark.circle").foregroundStyle(Palette.accent) } }
    }.navigationTitle("Calendar & Reminders").navigationBarTitleDisplayMode(.inline).disabled(busy)
      .onAppear { connection.refreshAccess() }
      .onChange(of: scenePhase) { _, phase in if phase == .active { connection.refreshAccess(); snapshot = nil } }
      .confirmationDialog("Add this selected snapshot to \(botName)'s draft?", isPresented: $confirmShare, titleVisibility: .visible) {
        Button("Add snapshot to draft") {
          perform {
            guard let snapshot else { return }
            try await store.attachAppleSnapshot(snapshot.data(), botId: botId)
            UserDefaults.standard.set(Date(), forKey: sharedKey)
            notice = "Snapshot added to \(botName)'s draft. Open the conversation and send it when you're ready."
          }
        }
      } message: { Text("Everyone who can access this assistant can read the snapshot after you send it. Existing draft text is kept.") }
  }
  private func accessLabel(_ status: EKAuthorizationStatus) -> some View {
    Label(status == .fullAccess ? "Allowed on this iPhone" : status == .denied ? "Permission denied" : status == .restricted ? "Restricted by iOS" : "Not allowed yet", systemImage: status == .fullAccess ? "checkmark.circle" : "lock").font(.footnote).foregroundStyle(.secondary)
  }
  private func membership(_ id: String, calendars: Bool) -> Binding<Bool> {
    Binding(get: { (calendars ? selectedCalendars : selectedLists).contains(id) }, set: { selected in
      if calendars { if selected { selectedCalendars.insert(id) } else { selectedCalendars.remove(id) } }
      else { if selected { selectedLists.insert(id) } else { selectedLists.remove(id) } }
      snapshot = nil
    })
  }
  private func perform(_ work: @escaping () async throws -> Void) {
    guard !busy else { return }
    busy = true; error = nil
    Task { defer { busy = false }; do { try await work() } catch { self.error = error.localizedDescription } }
  }
}
