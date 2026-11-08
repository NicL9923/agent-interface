// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "WildBotsMac",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "WildBotsMac", targets: ["WildBotsMac"]),
    .library(name: "WildBotsMacCore", targets: ["WildBotsMacCore"]),
  ],
  targets: [
    // Everything that can run headlessly: protocol, policy, confinement, journal, link state machine.
    .target(name: "WildBotsMacCore"),
    // The menu bar app: SwiftUI screens and the macOS services that need a logged-in session.
    .executableTarget(name: "WildBotsMac", dependencies: ["WildBotsMacCore"]),
    // Tests share fixtures across tasks freely; the code under test keeps Swift 6 checking.
    .testTarget(
      name: "WildBotsMacCoreTests", dependencies: ["WildBotsMacCore"], swiftSettings: [.swiftLanguageMode(.v5)]),
  ]
)
