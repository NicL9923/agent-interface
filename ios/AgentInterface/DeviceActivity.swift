import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// What this install tells the server about being in use, as `PUT /api/devices/activity` takes it.
struct DeviceActivityReport: Encodable, Equatable {
  var deviceId: String
  var state: String
  var idleMs: Int?
}

/// Whether the iPhone or iPad its person is using now is this one, so notifications go only to the
/// device in use (docs/native-api.md, Device activity). The app counts while it is in the
/// foreground and was touched in the last five minutes, on any screen.
@MainActor final class DeviceActivity {
  static let shared = DeviceActivity()
  /// The same constants as src/shared/device-activity.ts.
  nonisolated static let idle: TimeInterval = 5 * 60
  nonisolated static let heartbeat: TimeInterval = 15

  /// What to report now: `active` with the time since the last input while in use, `inactive` once
  /// that ends after it was reported, and nothing otherwise. Pure, so the boundary is testable.
  nonisolated static func decide(foreground: Bool, lastInput: Date, now: Date, reporting: Bool) -> (state: String, idleMs: Int?)? {
    let idle = max(0, now.timeIntervalSince(lastInput))
    // Whole milliseconds, never past the server's 299999: Date arithmetic can land a hair under a round value.
    if foreground && idle < Self.idle { return ("active", min(Int((idle * 1000).rounded()), Int(Self.idle * 1000) - 1)) }
    return reporting ? ("inactive", nil) : nil
  }

  weak var store: AppStore?
  var now: () -> Date = Date.init
  private(set) var lastInput = Date.distantPast
  private(set) var reporting = false
  private var foreground = false
  private var beat: Task<Void, Never>?
  private var reports: Task<Void, Never>?

  /// The app came to the foreground: opening it is use.
  func foregrounded() {
    foreground = true
    lastInput = now()
    update()
    beat?.cancel()
    beat = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(Self.heartbeat))
        guard !Task.isCancelled else { return }
        self?.update()
      }
    }
  }
  func backgrounded() {
    foreground = false
    beat?.cancel(); beat = nil
    update()
  }
  /// A touch, a key press or typing anywhere in the app.
  func input() {
    lastInput = now()
    if !reporting { update() }
  }
  /// Another account or a sign-out: the old session's activity ended on the server with it.
  func accountChanged() {
    reporting = false
    update()
  }
  func update() {
    guard let decision = Self.decide(foreground: foreground, lastInput: lastInput, now: now(), reporting: reporting) else { return }
    // Before sign-in finishes nothing is sent, so the next beat tries again.
    let sent = send(DeviceActivityReport(deviceId: NotificationController.shared.deviceId, state: decision.state, idleMs: decision.idleMs))
    reporting = sent ? decision.state == "active" : false
  }
  @discardableResult private func send(_ report: DeviceActivityReport) -> Bool {
    guard let store, let api = store.api, api.token != nil, store.bootstrap != nil, !store.sessionExpired else { return false }
    // A hint: a failed report, or a server without the route, only keeps the earlier routing. One
    // goes at a time, so stopping can never land after starting again.
    let previous = reports
    reports = Task {
      await previous?.value
      let _: EmptyResponse? = try? await api.write("/devices/activity", report, method: "PUT")
    }
    return true
  }
}

/// Watches every touch and key press in the app's window without taking part in it.
private final class InputWatcher: UIGestureRecognizer {
  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    Task { @MainActor in DeviceActivity.shared.input() }
    state = .failed
  }
  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent) {
    Task { @MainActor in DeviceActivity.shared.input() }
    super.pressesBegan(presses, with: event)
  }
  override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
  override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }
}
private final class WatcherInstaller: UIView {
  private let watcher: InputWatcher = {
    let watcher = InputWatcher(target: nil, action: nil)
    watcher.cancelsTouchesInView = false; watcher.delaysTouchesBegan = false; watcher.delaysTouchesEnded = false
    return watcher
  }()
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if let window, watcher.view !== window { window.addGestureRecognizer(watcher) }
  }
}
/// Installs the input watcher on the window that holds the app's views.
struct DeviceInputWatcher: UIViewRepresentable {
  func makeUIView(context: Context) -> UIView { let view = WatcherInstaller(); view.isUserInteractionEnabled = false; return view }
  func updateUIView(_ uiView: UIView, context: Context) {}
}
