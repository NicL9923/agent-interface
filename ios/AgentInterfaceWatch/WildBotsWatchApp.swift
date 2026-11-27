import SwiftUI

@main struct WildBotsWatchApp: App {
  @State private var session = WatchSessionManager.shared
  var body: some Scene {
    WindowGroup {
      WatchHomeView(session: session)
        .onAppear { session.start() }
    }
  }
}
