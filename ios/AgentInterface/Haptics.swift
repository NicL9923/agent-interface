import SwiftUI

/// The few moments that earn a tap on the wrist: kept subtle and on system conventions, so a
/// reply finishing is quieter than a failure.
enum Haptic: Equatable {
  case sent, replied, decided, failed
  var feedback: SensoryFeedback {
    switch self {
    case .sent: .impact(weight: .light)
    case .replied: .success
    case .decided: .impact(weight: .medium)
    case .failed: .error
    }
  }
}
/// A haptic as the store announces it. The number keeps two of the same kind in a row distinct.
struct HapticEvent: Equatable {
  var number: Int
  var kind: Haptic
}
extension AppStore {
  func buzz(_ kind: Haptic) {
    hapticCount += 1
    haptic = HapticEvent(number: hapticCount, kind: kind)
  }
}
extension View {
  /// Plays the store's haptics. Home hosts it once for every screen.
  func storeHaptics(_ event: HapticEvent?) -> some View {
    sensoryFeedback(trigger: event) { _, new in new?.kind.feedback }
  }
}
