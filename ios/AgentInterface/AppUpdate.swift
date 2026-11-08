import SwiftUI

/// Whether this installed build is behind the build the host distributes.
enum AppUpdate: Equatable {
  case upToDate
  case available(URL)
  /// `nil` when the server publishes nothing or this build number cannot be compared. An
  /// update link that is not HTTPS is never offered.
  static func evaluate(_ info: NativeAppInfo?, installedBuild: Int?) -> AppUpdate? {
    guard let info, let installedBuild else { return nil }
    if installedBuild >= info.latestBuild { return .upToDate }
    guard let url = URL(string: info.updateUrl), url.scheme?.lowercased() == "https", url.host?.isEmpty == false else { return nil }
    return .available(url)
  }
  static var installedBuild: Int? { (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String).flatMap { Int($0) } }
  static var installedVersion: String {
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
    let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
    return "Version \(version) (build \(build))"
  }
}
extension AppStore {
  var appUpdate: AppUpdate? { AppUpdate.evaluate(bootstrap?.nativeApp, installedBuild: AppUpdate.installedBuild) }
}

/// Stays until the update is installed: an old build can miss contract changes.
struct AppUpdateBanner: View {
  var url: URL
  @Environment(\.openURL) private var openURL
  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "arrow.down.app.fill").foregroundStyle(Palette.accent).accessibilityHidden(true)
      Text("A new version of WildBots is available").font(.footnote.weight(.medium))
        .frame(maxWidth: .infinity, alignment: .leading)
      Button("Update") { openURL(url) }.buttonStyle(.accentProminent).controlSize(.small).tint(Palette.accent)
        .accessibilityIdentifier("appUpdateButton")
    }.padding(.horizontal, 16).padding(.vertical, 8).background(Palette.accentSoft)
      .accessibilityElement(children: .contain).accessibilityIdentifier("appUpdateBanner")
  }
}

/// The Preferences About rows.
struct AppVersionRows: View {
  var update: AppUpdate?
  @Environment(\.openURL) private var openURL
  var body: some View {
    LabeledContent("App", value: AppUpdate.installedVersion)
    switch update {
    case .available(let url):
      HStack {
        Label("Update available", systemImage: "arrow.down.app.fill").foregroundStyle(Palette.accent)
        Spacer()
        Button("Update") { openURL(url) }.buttonStyle(.accentProminent).controlSize(.small)
          .accessibilityIdentifier("preferencesUpdateButton")
      }
    case .upToDate: Label("Up to date", systemImage: "checkmark.circle").foregroundStyle(.secondary)
    case nil: EmptyView()
    }
  }
}
