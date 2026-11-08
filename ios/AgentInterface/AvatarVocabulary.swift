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

/// How an avatar is drawn: a geometric shape, a mascot character, or an uploaded portrait.
struct AvatarMode: OpenVocabulary {
  let rawValue: String
  init(rawValue: String) { self.rawValue = rawValue }
  static let geometric = Self(rawValue: "geometric")
  static let mascot = Self(rawValue: "mascot")
  static let portrait = Self(rawValue: "portrait")
}

/// Geometric silhouettes in picker order, like `avatarShapes` in src/shared/types.ts.
struct AvatarShape: OpenVocabulary {
  let rawValue: String
  init(rawValue: String) { self.rawValue = rawValue }
  static let blob = Self(rawValue: "blob")
  static let pebble = Self(rawValue: "pebble")
  static let squircle = Self(rawValue: "squircle")
  static let capsule = Self(rawValue: "capsule")
  static let triangle = Self(rawValue: "triangle")
  static let hex = Self(rawValue: "hex")
  static let cloud = Self(rawValue: "cloud")
  static let drop = Self(rawValue: "drop")
  static let circle = Self(rawValue: "circle")
  static let diamond = Self(rawValue: "diamond")
  static let sparkle = Self(rawValue: "sparkle")
  static let clover = Self(rawValue: "clover")
  static let heart = Self(rawValue: "heart")
  static let cookie = Self(rawValue: "cookie")
  static let pentagon = Self(rawValue: "pentagon")
  static let burst = Self(rawValue: "burst")
  static let alien = Self(rawValue: "alien")
  static let ghost = Self(rawValue: "ghost")
  static let flower = Self(rawValue: "flower")
  static let sun = Self(rawValue: "sun")
  static let all: [AvatarShape] = [
    .blob, .pebble, .squircle, .capsule, .triangle, .hex, .cloud, .drop, .circle, .diamond,
    .sparkle, .clover, .heart, .cookie, .pentagon, .burst, .alien, .ghost, .flower, .sun,
  ]
}

/// Mascot characters, like `mascotFamilies` in src/shared/types.ts. The ghost is both a shape
/// and a character; the two types keep them apart.
struct AvatarFamily: OpenVocabulary {
  let rawValue: String
  init(rawValue: String) { self.rawValue = rawValue }
  static let bear = Self(rawValue: "bear")
  static let fox = Self(rawValue: "fox")
  static let sprout = Self(rawValue: "sprout")
  static let panda = Self(rawValue: "panda")
  static let raccoon = Self(rawValue: "raccoon")
  static let owl = Self(rawValue: "owl")
  static let cactus = Self(rawValue: "cactus")
  static let dinosaur = Self(rawValue: "dinosaur")
  static let leprechaun = Self(rawValue: "leprechaun")
  static let bunny = Self(rawValue: "bunny")
  static let eagle = Self(rawValue: "eagle")
  static let pumpkin = Self(rawValue: "pumpkin")
  static let bat = Self(rawValue: "bat")
  static let ghost = Self(rawValue: "ghost")
  static let turkey = Self(rawValue: "turkey")
  static let santa = Self(rawValue: "santa")
  static let rudolph = Self(rawValue: "rudolph")
  static let snowman = Self(rawValue: "snowman")
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

/// The outline an avatar morphs between. A character that shares a name with a shape, the ghost,
/// still gets its own silhouette.
enum AvatarBody: Hashable {
  case shape(AvatarShape)
  case mascot
  case character(AvatarFamily)
}
