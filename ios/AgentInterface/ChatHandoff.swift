import AppIntents
import Foundation

/// The open chat as Handoff and Siri see it. Another device signed in to the same Apple Account picks
/// it up: the app there if it has one, or the household's web page at the same link. On iOS 18.2 and
/// later it also names the assistant on screen, so Siri knows which one "this" is.
enum ChatHandoff {
  static let activityType = "dev.agentinterface.ios.chat"

  static func describe(_ activity: NSUserActivity, bot: Bot, server: URL?) {
    activity.title = bot.name
    activity.isEligibleForHandoff = true
    // Spotlight already lists assistants by name; a second entry per visit would only clutter it.
    activity.isEligibleForSearch = false
    activity.isEligibleForPrediction = false
    activity.targetContentIdentifier = bot.id
    activity.userInfo = ["bot": bot.id]
    activity.webpageURL = server.flatMap { webLink(server: $0, botId: bot.id) }
    if #available(iOS 18.2, *) { activity.appEntityIdentifier = EntityIdentifier(for: AssistantEntity(id: bot.id, name: bot.name)) }
  }
  /// The web client's link to a chat, as notifications carry it.
  static func webLink(server: URL, botId: String) -> URL? {
    var components = URLComponents(url: server, resolvingAgainstBaseURL: false)
    components?.path = "/"
    components?.queryItems = [URLQueryItem(name: "bot", value: botId)]
    return components?.url
  }
  /// The relative link a chat or Today page on this household's server opens, from a universal link
  /// or a page handed off from Safari. Another server's link is not one of ours.
  static func relativePath(for url: URL, server: URL) -> String? {
    guard url.scheme?.lowercased() == server.scheme?.lowercased(), url.host?.lowercased() == server.host?.lowercased(),
      url.port == server.port, url.path.isEmpty || url.path == "/",
      let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery,
      let link = URL(string: "agentinterface://open?" + query)
    else { return nil }
    return DeepLink.relativePath(for: link)
  }
}

extension NotificationController {
  /// A chat picked up from another device, from the app there by its activity or from Safari by its page.
  func continueActivity(_ activity: NSUserActivity) async {
    if activity.activityType == ChatHandoff.activityType, let botId = activity.userInfo?["bot"] as? String, !botId.isEmpty {
      return await open(DeepLink.bot(botId))
    }
    guard let url = activity.webpageURL else { return }
    await openWebLink(url)
  }
  /// A universal link to this household's web client. A link to another server says so instead of
  /// opening something else here.
  func openWebLink(_ url: URL) async {
    let server = store?.api?.baseURL ?? UserDefaults.standard.string(forKey: DeviceDefaults.host).flatMap { try? ConnectionAddress.parse($0) }
    guard let server else { return }
    guard let path = ChatHandoff.relativePath(for: url, server: server) else {
      if url.host?.lowercased() != server.host?.lowercased() {
        store?.notice = "That link is for \(url.host ?? "another server"), but WildBots is connected to \(server.host ?? "this server")."
      }
      return
    }
    pendingURL = path
    await openPendingConversation()
  }
}
