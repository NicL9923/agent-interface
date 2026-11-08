import AppKit
import AuthenticationServices
import CoreGraphics
import Foundation
import IOKit.ps
import IOKit.pwr_mgt
import ImageIO
import Network
import ScreenCaptureKit
import ServiceManagement
import UniformTypeIdentifiers
import UserNotifications
import WildBotsMacCore

/// Screenshots of the main display through ScreenCaptureKit, at most `maxWidth` pixels wide.
struct ScreenCaptureProvider: ScreenshotProvider {
  func capture(maxWidth: Int) async throws -> Screenshot {
    guard CGPreflightScreenCaptureAccess() else {
      throw ActionError(.permissionNeeded, "WildBots needs Screen Recording permission in System Settings > Privacy & Security.")
    }
    let content: SCShareableContent
    do {
      content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    } catch {
      throw ActionError(.permissionNeeded, "macOS refused screen capture: \(error.localizedDescription)")
    }
    guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
      throw ActionError(.failed, "No display is available to capture.")
    }
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let pixelWidth = Double(filter.contentRect.width) * Double(filter.pointPixelScale)
    let pixelHeight = Double(filter.contentRect.height) * Double(filter.pointPixelScale)
    let width = min(Double(maxWidth), pixelWidth)
    let configuration = SCStreamConfiguration()
    configuration.width = Int(width.rounded())
    configuration.height = Int((width * pixelHeight / max(pixelWidth, 1)).rounded())
    configuration.showsCursor = true
    let image: CGImage
    do {
      image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    } catch {
      throw ActionError(.failed, "The screenshot failed: \(error.localizedDescription)")
    }
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, UTType.png.identifier as CFString, 1, nil) else {
      throw ActionError(.failed, "The screenshot could not be encoded.")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw ActionError(.failed, "The screenshot could not be encoded.") }
    return Screenshot(png: data as Data, width: image.width, height: image.height)
  }
}

enum ScreenAccess {
  static var current: ScreenPermission {
    if CGPreflightScreenCaptureAccess() { return .granted }
    return UserDefaults.standard.bool(forKey: "screenAccessRequested") ? .denied : .unknown
  }
  static func request() {
    UserDefaults.standard.set(true, forKey: "screenAccessRequested")
    if !CGRequestScreenCaptureAccess(),
      let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
    {
      NSWorkspace.shared.open(url)
    }
  }
}

/// Watches the screen lock, wake from sleep, network changes and power source.
@MainActor final class SystemWatcher {
  private var observers: [NSObjectProtocol] = []
  private let monitor = NWPathMonitor()
  private var timer: Timer?
  private var sawFirstPath = false
  var onLockChange: (Bool) -> Void = { _ in }
  var onWakeOrNetwork: () -> Void = {}
  var onTick: () -> Void = {}

  nonisolated static var screenIsLocked: Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    return session["CGSSessionScreenIsLocked"] as? Bool ?? false
  }

  nonisolated static var onACPower: Bool {
    guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
      let type = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue()
    else { return true }
    return (type as String) == kIOPMACPowerKey
  }

  private func networkChanged() {
    // The first update describes the current network, not a change.
    if sawFirstPath { onWakeOrNetwork() } else { sawFirstPath = true }
  }

  func start() {
    let distributed = DistributedNotificationCenter.default()
    observers.append(
      distributed.addObserver(forName: .init("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.onLockChange(true) }
      })
    observers.append(
      distributed.addObserver(forName: .init("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.onLockChange(false) }
      })
    let workspace = NSWorkspace.shared.notificationCenter
    for name in [NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification] {
      observers.append(
        workspace.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
          MainActor.assumeIsolated { self?.onWakeOrNetwork() }
        })
    }
    monitor.pathUpdateHandler = { [weak self] path in
      guard path.status == .satisfied else { return }
      Task { @MainActor in self?.networkChanged() }
    }
    monitor.start(queue: .global(qos: .utility))
    timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.onTick() }
    }
  }
}

/// Holds a PreventUserIdleSystemSleep assertion while it should, and releases it otherwise.
@MainActor final class AwakeKeeper {
  private var assertion: IOPMAssertionID = 0
  private(set) var holding = false

  func update(shouldHold: Bool) {
    if shouldHold, !holding {
      let result = IOPMAssertionCreateWithName(
        kIOPMAssertPreventUserIdleSystemSleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn),
        "WildBots for Mac keeps this Mac available to your assistants while plugged in" as CFString, &assertion)
      holding = result == kIOReturnSuccess
    } else if !shouldHold, holding {
      IOPMAssertionRelease(assertion)
      holding = false
    }
  }
}

enum Notifier {
  static var available: Bool { Bundle.main.bundleIdentifier != nil }

  static func requestPermission() {
    guard available else { return }
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
  }

  static func unattended(_ entry: ActivityEntry) {
    guard available else { return }
    let content = UNMutableNotificationContent()
    content.title = "\(entry.assistantName ?? entry.assistantId) acted unattended"
    content.body = "\(ActivityText.verb(entry.action)): \(entry.detail)" + (entry.outcome == "ok" ? "" : " (\(entry.outcome))")
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: entry.id, content: content, trigger: nil))
  }

  static func unlinked(_ reason: String) {
    guard available else { return }
    let content = UNMutableNotificationContent()
    content.title = "WildBots for Mac"
    content.body = reason
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "unlinked", content: content, trigger: nil))
  }
}

enum LoginItem {
  static var enabled: Bool { SMAppService.mainApp.status == .enabled }
  static func set(_ on: Bool) throws {
    if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
  }
}

enum MacInfo {
  static var model: String? {
    var size = 0
    sysctlbyname("hw.model", nil, &size, nil, 0)
    guard size > 0 else { return nil }
    var buffer = [UInt8](repeating: 0, count: size)
    sysctlbyname("hw.model", &buffer, &size, nil, 0)
    return String(decoding: buffer.prefix { $0 != 0 }, as: UTF8.self)
  }
  static var osVersion: String {
    let version = ProcessInfo.processInfo.operatingSystemVersion
    return "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
  }
  static var appVersion: String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
  }
  static var name: String { Host.current().localizedName ?? "Mac" }
}

/// The system sign-in browser, as on iOS: an ephemeral session with callback scheme `agentinterface`.
@MainActor final class SignInBrowser: NSObject, ASWebAuthenticationPresentationContextProviding {
  private var session: ASWebAuthenticationSession?

  func authorize(url: URL) async throws -> URL {
    defer { session = nil }
    return try await withCheckedThrowingContinuation { continuation in
      let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "agentinterface") { @Sendable url, error in
        if let url {
          continuation.resume(returning: url)
        } else {
          continuation.resume(throwing: error ?? HouseholdError(message: "Sign-in was cancelled.", status: 0))
        }
      }
      session.presentationContextProvider = self
      session.prefersEphemeralWebBrowserSession = true
      self.session = session
      if !session.start() {
        continuation.resume(throwing: HouseholdError(message: "Could not open the system sign-in browser.", status: 0))
      }
    }
  }

  nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    MainActor.assumeIsolated { NSApp.keyWindow ?? NSApp.windows.first { $0.isVisible } ?? ASPresentationAnchor() }
  }
}
