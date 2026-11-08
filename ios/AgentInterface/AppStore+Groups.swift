import SwiftUI

// The household's group chat catalog, which home lists beside the assistants.
extension AppStore {
  /// How often home rereads the catalog while it shows. The household stream's `groups` notice,
  /// sent on every connect and on each change, brings changes at once, so this only covers a
  /// notice lost to a stream that failed unnoticed.
  static let groupsFallbackInterval: Duration = .seconds(300)
  /// An older server never sends `groups`, so home keeps the 30-second poll it always had until one arrives.
  static let groupsUnnotifiedInterval: Duration = .seconds(30)
  /// Home's poll for this account's server: slow once its stream has shown it pushes catalog changes.
  var groupsPollInterval: Duration {
    scope != nil && groupNoticeScope == scope ? Self.groupsFallbackInterval : Self.groupsUnnotifiedInterval
  }
  /// Reads the room catalog for home. A failure keeps the rooms already shown; the next poll tries again.
  func refreshGroups() async {
    let id = UUID(); groupLoadId = id
    let result = await attempt(current: { [weak self] in self?.groupLoadId == id }) { try await $0.api.get("/groups") as GroupCatalog }
    guard case .success(let value)? = result, value != groupCatalog else { return }
    groupCatalog = value
  }
  /// A room just made shows at once; the next read of the catalog replaces this copy.
  func groupRoomCreated(_ room: GroupRoom) {
    guard var catalog = groupCatalog else { return }
    catalog.rooms.removeAll { $0.id == room.id }
    catalog.rooms.append(room)
    groupCatalog = catalog
    Task { await refreshGroups() }
  }
}
