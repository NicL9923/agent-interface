import AppKit
import SwiftUI
import WildBotsMacCore

@main
struct WildBotsApp: App {
  @State private var model: AppModel? = WildBotsApp.makeModel()

  static func makeModel() -> AppModel? {
    do {
      let model = try AppModel()
      model.start()
      return model
    } catch {
      NSLog("WildBots for Mac could not start: \(error)")
      return nil
    }
  }

  var body: some Scene {
    MenuBarExtra {
      if let model {
        MenuContent().environment(model)
      } else {
        Text("WildBots could not open its data folder.")
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
        Text("WildBots could not open its data folder in Application Support.").padding()
      }
    }
    .windowResizability(.contentMinSize)
  }
}
