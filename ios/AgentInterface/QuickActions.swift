import UIKit

/// Home Screen Quick Actions (`UIApplicationShortcutItem`) for long-pressing the WildBots icon:
/// Today, Search, and Talk to the signed-in account's main or first pinned assistant.
@MainActor enum QuickActions {
  static let todayType = "dev.agentinterface.ios.quick.today"
  static let searchType = "dev.agentinterface.ios.quick.search"
  static let talkType = "dev.agentinterface.ios.quick.talk"
  static let botIdKey = "botId"

  /// Builds the dynamic shortcut items for the current signed-in household (or basic items when signed out).
  static func items(for bootstrap: Bootstrap?) -> [UIApplicationShortcutItem] {
    var result: [UIApplicationShortcutItem] = [
      UIApplicationShortcutItem(
        type: todayType,
        localizedTitle: "Today",
        localizedSubtitle: "What's new and waiting",
        icon: UIApplicationShortcutIcon(systemImageName: "calendar")
      ),
      UIApplicationShortcutItem(
        type: searchType,
        localizedTitle: "Search",
        localizedSubtitle: "Past answers and saved items",
        icon: UIApplicationShortcutIcon(systemImageName: "magnifyingglass")
      ),
    ]
    if let bootstrap, let pinned = preferredAssistant(in: bootstrap) {
      result.append(
        UIApplicationShortcutItem(
          type: talkType,
          localizedTitle: "Talk to \(pinned.name)",
          localizedSubtitle: "Start a voice message",
          icon: UIApplicationShortcutIcon(systemImageName: "waveform"),
          userInfo: [botIdKey: pinned.id as NSSecureCoding]
        )
      )
    }
    return result
  }

  /// Main assistant first, then the first pinned assistant in home order. Nil when none are pinned.
  static func preferredAssistant(in bootstrap: Bootstrap) -> Bot? {
    if let main = bootstrap.preferences.mainAssistant(bootstrap.bots) { return main }
    return bootstrap.preferences.pinnedAssistants(bootstrap.bots).first
  }

  /// Publishes dynamic Home Screen shortcuts to `UIApplication`. No-op during unit tests.
  static func sync(_ bootstrap: Bootstrap?) {
    guard ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }
    UIApplication.shared.shortcutItems = items(for: bootstrap)
  }

  /// Maps a tapped Home Screen Quick Action to the same `DeepLink` URL every external entry uses.
  static func url(for item: UIApplicationShortcutItem) -> URL? {
    switch item.type {
    case todayType:
      return DeepLink.today
    case searchType:
      return DeepLink.search
    case talkType:
      guard let botId = item.userInfo?[botIdKey] as? String, !botId.isEmpty else { return nil }
      return DeepLink.bot(botId, listen: true)
    default:
      return nil
    }
  }
}

/// Scene delegate attached via `AppDelegate.application(_:configurationForConnecting:options:)`
/// so Home Screen Quick Actions work on both cold launch and warm resume under SwiftUI's `App` lifecycle.
final class QuickActionSceneDelegate: NSObject, UIWindowSceneDelegate {
  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    if let shortcut = connectionOptions.shortcutItem, let url = QuickActions.url(for: shortcut) {
      Task { @MainActor in await NotificationController.shared.open(url) }
    }
  }

  func windowScene(
    _ windowScene: UIWindowScene,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    guard let url = QuickActions.url(for: shortcutItem) else {
      completionHandler(false)
      return
    }
    Task { @MainActor in
      await NotificationController.shared.open(url)
      completionHandler(true)
    }
  }
}
