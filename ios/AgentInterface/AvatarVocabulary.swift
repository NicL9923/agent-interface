import Foundation

/// A name the server owns, such as an avatar shape. It is a struct rather than a closed enum so
/// a value this app version has never seen decodes, draws with the fallback art, and encodes back
/// unchanged. The app must not drop or rewrite what it does not know when it saves settings.
/// The known names are static members: `.blob` compiles, a misspelled `.bolb` does not.
protocol OpenVocabulary: RawRepresentable, Hashable, Codable, Sendable where RawValue == String {
  init(rawValue: String)
}
extension OpenVocabulary {
  init(from decoder: Decoder) throws {
    self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
  }
  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }
}

/// How an avatar is drawn: a character (a flat silhouette with eyes) or an uploaded portrait.
/// Retired mascots decode as characters; see `AvatarConfig.init(from:)`.
struct AvatarMode: OpenVocabulary {
  let rawValue: String
  init(rawValue: String) { self.rawValue = rawValue }
  static let geometric = Self(rawValue: "geometric")
  static let portrait = Self(rawValue: "portrait")
}

/// An avatar silhouette, like `avatarShapes` in src/shared/types.ts. The named shapes and their
/// art are generated into AvatarCatalog.swift.
struct AvatarShape: OpenVocabulary {
  let rawValue: String
  init(rawValue: String) { self.rawValue = rawValue }
  /// Every shape in picker order, group by group.
  static let all: [AvatarShape] = AvatarCatalog.groups.flatMap(\.shapes)
  /// The outline and face this shape draws with. One from newer data than this build draws as the blob.
  var art: AvatarCatalog.Art { AvatarCatalog.art[self] ?? AvatarCatalog.art[.blob]! }
  /// The name under its picker tile, and what VoiceOver calls it.
  var label: String { AvatarCatalog.labels[self] ?? rawValue.capitalized }
}

struct AvatarEyes: OpenVocabulary {
  let rawValue: String
  init(rawValue: String) { self.rawValue = rawValue }
  static let round = Self(rawValue: "round")
  static let oval = Self(rawValue: "oval")
  static let visor = Self(rawValue: "visor")
  static let spark = Self(rawValue: "spark")
  /// In picker order.
  static let all: [AvatarEyes] = [.oval, .round, .visor, .spark]
}

struct AvatarAccessory: OpenVocabulary {
  let rawValue: String
  init(rawValue: String) { self.rawValue = rawValue }
  /// No accessory. Not named `none`, which would read as the optional's nil.
  static let plain = Self(rawValue: "none")
  static let hat = Self(rawValue: "hat")
  static let glasses = Self(rawValue: "glasses")
  static let all: [AvatarAccessory] = [.plain, .hat, .glasses]
}
