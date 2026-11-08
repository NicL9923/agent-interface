import AppKit
import SwiftUI
import WildBotsMacCore

@main
struct WildBotsApp: App {
  @State private var model: AppModel? = WildBotsApp.makeModel()
  /// Why the app could not start, such as a journal it cannot read. Nothing connects or runs then.
  @MainActor static var startupError = "WildBots could not open its data folder in Application Support."

  @MainActor static func makeModel() -> AppModel? {
    do {
      let model = try AppModel()
      model.start()
      return model
    } catch {
      NSLog("WildBots for Mac could not start: \(error)")
      startupError = (error as? ActionError)?.message ?? "WildBots could not start: \(error.localizedDescription)"
      return nil
    }
  }

  var body: some Scene {
    MenuBarExtra {
      if let model {
        MenuContent().environment(model)
      } else {
        Text(WildBotsApp.startupError)
        Button("Quit") { NSApp.terminate(nil) }
      }
    } label: {
      // Filled while an assistant is working.
      Image(systemName: (model?.activeCount ?? 0) > 0 ? "bolt.horizontal.circle.fill" : "bolt.horizontal.circle")
    }
    .menuBarExtraStyle(.menu)

    Window("WildBots for Mac", id: "main") {
      if let model {
        MainView().environment(model)
      } else {
        Text(WildBotsApp.startupError).padding()
      }
    }
    .windowResizability(.contentMinSize)
  }
}
