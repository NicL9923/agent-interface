import SwiftUI

/// Every fixed SVG path the avatars draw apart from the shape outlines, copied from
/// src/components/Avatar.tsx. The raw value is the path string itself, so AvatarArtParityTests can
/// compare the set with the paths tests/avatar-art-parity.test.ts finds there. The outlines come
/// from AvatarCatalog.swift.
enum AvatarPathData: String, CaseIterable {
  case hatCrown = "M-20 -2 Q-21 -20 -10 -21 Q0 -16 10 -21 Q21 -20 20 -2Z"
  case hatBand = "M-20.3 -7 Q0 -3 20.3 -7 L20 -2 Q0 2 -20 -2Z"
  case hatBrim = "M-37 -4 Q-34 5 0 5 Q34 5 37 -4 Q38 -8 33 -6 Q0 2 -33 -6 Q-38 -8 -37 -4Z"
  case bang = "M42.5 21 Q50 12 57.5 21 L54.5 61 Q50 68 45.5 61Z"
  case spark = "M0 -10 L3.2 -3.2 L10 0 L3.2 3.2 L0 10 L-3.2 3.2 L-10 0 L-3.2 -3.2Z"
  case happyEye = "M-7 3 Q0 -8 7 3"
  case handle = "M8 8 L19 19"
  case lensGlint = "M-6 -3 Q-5 -6 -2 -7"
  case keyboard = "M-27 4 H27 L24 10 H-24Z"
  case pageLeft = "M0 -10 Q-12 -15 -24 -11 V7 Q-12 3 0 8Z"
  case pageRight = "M0 -10 Q12 -15 24 -11 V7 Q12 3 0 8Z"
  case textLines = "M-19 -6 Q-11 -9 -4 -6 M-19 -1 Q-11 -4 -4 -1 M4 -6 Q11 -9 19 -6 M4 -1 Q11 -4 19 -1"
  case spine = "M-25 8 Q-12 4 0 9 Q12 4 25 8"
  case eraser = "M-3.2 -22 H3.2 V-25.5 Q3.2 -27 0 -27 Q-3.2 -27 -3.2 -25.5Z"
  case tip = "M-3.2 0 L0 6 L3.2 0Z"

  /// The parsed path, built once.
  var path: Path { Self.parsed[self]! }
  private static let parsed = Dictionary(uniqueKeysWithValues: allCases.map { ($0, SVGPath.parse($0.rawValue)) })
}
