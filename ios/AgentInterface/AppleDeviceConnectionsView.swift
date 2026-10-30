import EventKit
import SwiftUI

@MainActor @Observable final class AppleDeviceConnection {
  @ObservationIgnored private let eventStore = EKEventStore()
  var calendars: [EKCalendar] = []
  var lists: [EKCalendar] = []
  var calendarStatus = EKEventStore.authorizationStatus(for: .event)
  var reminderStatus = EKEventStore.authorizationStatus(for: .reminder)
  func refreshAccess() {
    calendarStatus = EKEventStore.authorizationStatus(for: .event)
    reminderStatus = EKEventStore.authorizationStatus(for: .reminder)
    calendars = calendarStatus == .fullAccess ? eventStore.calendars(for: .event) : []
    lists = reminderStatus == .fullAccess ? eventStore.calendars(for: .reminder) : []
  }
  func requestCalendar() async throws { _ = try await eventStore.requestFullAccessToEvents(); refreshAccess() }
  func requestReminders() async throws { _ = try await eventStore.requestFullAccessToReminders(); refreshAccess() }
  func snapshot(calendars selectedCalendars: Set<String>, lists selectedLists: Set<String>, start: Date, end: Date, undated: Bool) async throws -> AppleDeviceSnapshot {
    let zone = TimeZone.current
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
      // Read on EventKit's queue: the reminders themselves cannot cross to the main actor, their values can.
      let fetched: [AppleSnapshotDates.ReminderItem] = await withCheckedContinuation { continuation in
        // Explicitly Sendable: EventKit calls back on its own queue, never the main actor.
        eventStore.fetchReminders(matching: predicate) { @Sendable found in
          let items = (found ?? []).filter { !$0.isCompleted }.map {
            AppleSnapshotDates.reminder(list: $0.calendar.title, title: $0.title ?? "Untitled reminder", components: $0.dueDateComponents, zone: zone)
          }.filter { AppleSnapshotDates.includes($0.key, start: start, exclusiveEnd: end, undated: undated) }
          continuation.resume(returning: items)
        }
      }
      reminders = AppleSnapshotDates.ordered(fetched)
    }
    return AppleDeviceSnapshot(capturedAt: Date(), windowStart: start, windowEnd: end, events: events, reminders: reminders, timeZone: zone.identifier)
  }
}

struct AppleDeviceConnectionsView: View {
  var botId: String
  @Environment(AppStore.self) private var store
  @Environment(\.scenePhase) private var scenePhase
  @State private var connection = AppleDeviceConnection()
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
  @State private var previewExpanded = true
  private var botName: String { store.bootstrap?.bots.first { $0.id == botId }?.name ?? "this assistant" }
  private var sharedKey: String { "apple.lastShared.\(store.scope ?? "").\(botId)" }
  var body: some View {
    ScrollViewReader { captureScroll in
    Form {
      Section {
        Label("On this iPhone", systemImage: "iphone").font(.headline)
        Text("Choose calendars and reminder lists, preview a snapshot, then add it to \(botName)'s draft.").foregroundStyle(.secondary)
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
        if connection.reminderStatus == .fullAccess {
          Toggle("Include reminders with no due date", isOn: $undated).onChange(of: undated) { _, _ in snapshot = nil }
        }
      }
      if connection.calendarStatus == .denied || connection.reminderStatus == .denied {
        Section { Button("Open iOS permission settings") { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } } }
      }
      Section {
        DatePicker("From", selection: $start, displayedComponents: .date).id("appleDateWindow").onChange(of: start) { _, value in
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
      } header: { Text("Date window") } footer: {
        VStack(alignment: .leading, spacing: 6) {
          if selectedCalendars.isEmpty && selectedLists.isEmpty { Text("Allow access and choose a calendar or list to preview.") }
          Text("Choose up to 90 days. Only event titles, times, reminder titles, due dates, and selected calendar and list names, and the snapshot time zone are included. Completed reminders are omitted.")
        }.fixedSize(horizontal: false, vertical: true)
      }
      if let snapshot {
        Section("Review before sharing") {
          Text(snapshot.itemSummary)
          Text("Refreshed \(AppleSnapshotDates.instantLine(snapshot.capturedAt, zone: TimeZone(identifier: snapshot.timeZone) ?? .current))").font(.caption).foregroundStyle(.secondary)
          DisclosureGroup("Preview snapshot", isExpanded: $previewExpanded) {
            ForEach(Array(snapshot.events.enumerated()), id: \.offset) { _, event in
              VStack(alignment: .leading) { Text(event.title); Text(event.calendar).font(.caption).foregroundStyle(.secondary); Text(AppleSnapshotDates.eventLine(event, zone: TimeZone(identifier: snapshot.timeZone) ?? .current)).font(.caption).foregroundStyle(.secondary) }
            }
            ForEach(Array(snapshot.reminders.enumerated()), id: \.offset) { _, reminder in
              VStack(alignment: .leading) { Text(reminder.title); Text(reminder.list).font(.caption).foregroundStyle(.secondary); Text(AppleSnapshotDates.reminderLine(reminder, zone: TimeZone(identifier: snapshot.timeZone) ?? .current)).font(.caption).foregroundStyle(.secondary) }
            }
          }
          Button("Add to \(botName)'s draft…") { confirmShare = true }.disabled(!store.connected || !store.supports(.uploads) || botId.isEmpty)
        }
      }
      if let error { Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) } }
      if let notice { Section { Label(notice, systemImage: "checkmark.circle").foregroundStyle(Palette.accent) } }
    }.householdListBackground().navigationTitle("Calendar & Reminders").navigationBarTitleDisplayMode(.inline).disabled(busy)
      .onAppear {
        connection.refreshAccess()
        #if DEBUG
        if DebugFixtures.captureApplePage && ProcessInfo.processInfo.environment["AGENT_INTERFACE_UI_CAPTURE_APPLE_DATE"] == "1" {
          Task { try? await Task.sleep(for: .milliseconds(500)); captureScroll.scrollTo("appleDateWindow", anchor: .top) }
        }
        #endif
      }
      .onChange(of: snapshot?.capturedAt) { _, _ in
        if let snapshot { previewExpanded = snapshot.events.count + snapshot.reminders.count <= 20 }
      }
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
      } message: {
        if let snapshot {
          Text("\(snapshot.itemSummary), from \(AppleSnapshotDates.dayLine(snapshot.windowStart, zone: TimeZone(identifier: snapshot.timeZone) ?? .current)) through \(AppleSnapshotDates.dayLine(snapshot.windowEnd.addingTimeInterval(-1), zone: TimeZone(identifier: snapshot.timeZone) ?? .current)), in \(snapshot.timeZone). Everyone who can access this assistant can read them after you send the draft. Existing draft text is kept.")
        }
      }
    }
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
