import SwiftUI

/// Keeps the App Group's notification sender pictures in step with the signed-in account's
/// assistants; see `NotificationSenders`. Only changed avatars are drawn again, assistants that
/// left lose their picture, and signing out or switching accounts removes the previous account's
/// pictures and its donated messages. Only the signed-in account's notifications are decorated.
/// Portraits are photos the app loads with its sign-in, so they get no picture and iOS shows the
/// assistant's initials instead.
@MainActor struct SenderAvatars {
  var root: URL?
  var render: @MainActor (AvatarConfig, String) -> Data? = { SenderAvatars.png($0, name: $1) }
  /// Deletes an account's donated notification messages when its pictures go.
  var forget: (String) -> Void = { NotificationSenders.forget(account: $0) }
  private static let indexName = "index.json"

  /// `account` is the server's account marker for the signed-in person, or nil after sign-out.
  func sync(account: String?, bots: [Bot]) {
    guard let root else { return }
    let manager = FileManager.default
    let keep = account.flatMap { NotificationSenders.directory(account: $0, root: root) }
    for folder in (try? manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
    where folder.standardizedFileURL != keep?.standardizedFileURL {
      try? manager.removeItem(at: folder)
      forget(folder.lastPathComponent)
    }
    guard let account, let keep else { return }
    let indexURL = keep.appendingPathComponent(Self.indexName)
    let previous = (try? Data(contentsOf: indexURL)).flatMap { try? JSONDecoder().decode([String: String].self, from: $0) } ?? [:]
    var next: [String: String] = [:]
    try? manager.createDirectory(at: keep, withIntermediateDirectories: true)
    for bot in bots {
      guard let file = NotificationSenders.avatarURL(account: account, botId: bot.id, root: root) else { continue }
      let avatar = bot.avatar ?? AvatarConfig()
      guard avatar.mode != .portrait, let print = Self.fingerprint(avatar) else {
        try? manager.removeItem(at: file)
        continue
      }
      if previous[bot.id] == print, manager.fileExists(atPath: file.path) {
        next[bot.id] = print
        continue
      }
      guard let data = render(avatar, bot.name) else { continue }
      // Read while the device is locked after its first unlock, when notifications arrive.
      if (try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])) != nil {
        next[bot.id] = print
      }
    }
    for gone in Set(previous.keys).subtracting(bots.map(\.id)) {
      if let file = NotificationSenders.avatarURL(account: account, botId: gone, root: root) { try? manager.removeItem(at: file) }
    }
    if next != previous, let data = try? JSONEncoder().encode(next) {
      try? data.write(to: indexURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
  }

  private static func fingerprint(_ avatar: AvatarConfig) -> String? {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    return (try? encoder.encode(avatar)).map { String(decoding: $0, as: UTF8.self) }
  }
  /// A still avatar on a light tint of its own color, the way a contact photo fills its circle.
  static func png(_ avatar: AvatarConfig, name: String) -> Data? {
    let view = ZStack {
      Color.white
      Color(hex: avatar.color ?? "#1084FE").opacity(0.18)
      AvatarView(avatar: avatar, size: 72, name: name, forceReducedMotion: true)
    }
    .frame(width: 96, height: 96)
    .environment(\.colorScheme, .light)
    let renderer = ImageRenderer(content: view)
    renderer.scale = 3
    return renderer.uiImage?.pngData()
  }
}

extension AppStore {
  /// Called with the widget snapshot: the same account and assistants, the same sign-out rule.
  func syncSenderAvatars(_ bootstrap: Bootstrap?) {
    senderAvatars?.sync(account: bootstrap.map { NotificationActions.accountMarker($0.user.id) }, bots: bootstrap?.bots ?? [])
  }
}
