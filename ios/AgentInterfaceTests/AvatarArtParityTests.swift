import XCTest

@testable import AgentInterface

/// Checks the avatar catalog and art repeated in Models.swift, AvatarVocabulary.swift,
/// AvatarView.swift, CharacterAvatarArt.swift and AvatarPathData.swift against the web's. The
/// answer key in Avatar/avatar-art.json comes from src/components/Avatar.tsx and
/// character-avatars.tsx, written by tests/avatar-art-parity.test.ts. After an intended web
/// change, run `UPDATE_AVATAR_ART=1 npx vitest run tests/avatar-art-parity.test.ts`, commit the
/// catalog, and match the Swift side until this passes. The app itself reads only its Swift copies.
final class AvatarArtParityTests: XCTestCase {
  private struct Entry: Decodable, Equatable {
    var id: String
    var label: String
  }
  private struct Anchor: Decodable, Equatable {
    var cy: Double
    var scale: Double
    var top: Double
    var hat: Double
  }
  private struct HatAnchor: Decodable, Equatable {
    var top: Double
    var hat: Double
  }
  private struct Art: Decodable {
    var modes: [String]
    var shapes: [String]
    var everydayFamilies: [Entry]
    var seasonalFamilies: [Entry]
    var seasonalColors: [String: String]
    var colors: [String]
    var eyes: [String]
    var accessories: [String]
    var silhouettes: [String: String]
    var faces: [String: Anchor]
    var characterHeads: [String: String]
    var characterAnchors: [String: Anchor]
    var characterHatAnchors: [String: HatAnchor]
    var cheekless: [String]
    var paths: [String]
  }

  private func art() throws -> Art {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("Avatar", isDirectory: true)
      .appendingPathComponent("avatar-art.json")
    return try JSONDecoder().decode(Art.self, from: Data(contentsOf: url))
  }
  private func anchor(_ value: AvatarGeometry.Anchor) -> Anchor {
    Anchor(cy: value.cy, scale: value.scale, top: value.top, hat: value.hat)
  }

  func testCatalogListsMatchTheWeb() throws {
    let web = try art()
    XCTAssertEqual([AvatarMode.geometric, .mascot, .portrait].map(\.rawValue), web.modes)
    XCTAssertEqual(AvatarConfig.shapes.map(\.rawValue), web.shapes)
    XCTAssertEqual(AvatarConfig.everydayFamilies.map { Entry(id: $0.id.rawValue, label: $0.label) }, web.everydayFamilies)
    XCTAssertEqual(AvatarConfig.seasonalFamilies.map { Entry(id: $0.id.rawValue, label: $0.label) }, web.seasonalFamilies)
    XCTAssertEqual(
      Dictionary(uniqueKeysWithValues: AvatarConfig.seasonalColors.map { ($0.key.rawValue, $0.value) }),
      web.seasonalColors)
    XCTAssertEqual(AvatarConfig.colors, web.colors)
    XCTAssertEqual(AvatarEyes.all.map(\.rawValue), web.eyes)
    XCTAssertEqual(AvatarAccessory.all.map(\.rawValue), web.accessories)
  }
  func testSeasonalCharactersAreSeparateFromTheEverydayOnes() {
    XCTAssertTrue(AvatarConfig.seasonalFamilies.allSatisfy { AvatarConfig.seasonalColors[$0.id] != nil })
    XCTAssertTrue(AvatarConfig.everydayFamilies.allSatisfy { AvatarConfig.seasonalColors[$0.id] == nil })
    XCTAssertEqual(
      AvatarConfig.families.map(\.id),
      AvatarConfig.everydayFamilies.map(\.id) + AvatarConfig.seasonalFamilies.map(\.id))
  }
  func testSilhouettesAndFacesMatchTheWeb() throws {
    let web = try art()
    XCTAssertEqual(Set(web.silhouettes.keys), Set(web.shapes + ["mascot"]))
    for shape in AvatarConfig.shapes {
      let expected = try XCTUnwrap(web.silhouettes[shape.rawValue], shape.rawValue)
      // The web draws the circle as an arc; native uses the same circle as four cubic quarters.
      XCTAssertEqual(
        AvatarGeometry.svg(shape),
        shape == .circle
          ? "M50 3 C75.96 3 97 24.04 97 50 C97 75.96 75.96 97 50 97 C24.04 97 3 75.96 3 50 C3 24.04 24.04 3 50 3Z"
          : expected, shape.rawValue)
      XCTAssertEqual(AvatarGeometry.faces[shape].map(anchor), web.faces[shape.rawValue], shape.rawValue)
    }
    XCTAssertEqual(AvatarGeometry.mascotHead, web.silhouettes["mascot"])
    XCTAssertEqual(anchor(AvatarGeometry.mascotFace), web.faces["mascot"])
    XCTAssertEqual(AvatarGeometry.faces.count, web.shapes.count)
  }
  func testCharacterHeadsFacesHatsAndCheeksMatchTheWeb() throws {
    let web = try art()
    XCTAssertEqual(
      Dictionary(uniqueKeysWithValues: CharacterAvatarArt.heads.map { ($0.key.rawValue, $0.value) }),
      web.characterHeads)
    XCTAssertEqual(
      Dictionary(uniqueKeysWithValues: AvatarGeometry.characterFaces.map { ($0.key.rawValue, anchor($0.value)) }),
      web.characterAnchors)
    XCTAssertEqual(
      Dictionary(uniqueKeysWithValues: CharacterAvatarArt.hatAnchors.map {
        ($0.key.rawValue, HatAnchor(top: $0.value.top, hat: $0.value.hat))
      }), web.characterHatAnchors)
    XCTAssertEqual(CharacterAvatarArt.cheekless.map(\.rawValue).sorted(), web.cheekless)
  }
  func testEveryFixedPathIsOneTheWebDraws() throws {
    // Native parses only absolute commands, so a web path that moves relative with `l` is
    // compared after the same rewrite.
    let web = Set(try art().paths.flatMap { [$0, Self.absolute($0)] })
    let missing = AvatarPathData.allCases.filter { !web.contains($0.rawValue) }
    XCTAssertTrue(missing.isEmpty, "Not in the web's avatar art: \(missing.map { "\($0)" })")
  }
  func testRelativeLinesBecomeAbsoluteOnes() {
    XCTAssertEqual(Self.absolute("M27 28 l-3 -2 M73 28 l3 -2 M43.5 86 l-1 3"), "M27 28 L24 26 M73 28 L76 26 M43.5 86 L42.5 89")
    XCTAssertEqual(Self.absolute("M1 2 L3 4 V5Z"), "M1 2 L3 4 V5Z")
  }
  /// Rewrites each relative `l dx dy` as the absolute `L x y`, leaving every other command as written.
  private static func absolute(_ d: String) -> String {
    guard d.contains("l") else { return d }
    let tokens = d.matches(of: /[A-Za-z]|-?\d+(?:\.\d+)?/).map { String($0.output) }
    var groups: [(command: String, args: [String])] = []
    for token in tokens {
      if token.first!.isLetter { groups.append((token, [])) } else { groups[groups.count - 1].args.append(token) }
    }
    var current = (x: 0.0, y: 0.0)
    func format(_ value: Double) -> String {
      var text = String(format: "%.4f", value)
      while text.hasSuffix("0") { text.removeLast() }
      if text.hasSuffix(".") { text.removeLast() }
      return text
    }
    return groups.map { command, args in
      let numbers = args.compactMap(Double.init)
      if command == "l" {
        var points: [String] = []
        for pair in stride(from: 0, to: numbers.count - 1, by: 2) {
          current = (current.x + numbers[pair], current.y + numbers[pair + 1])
          points.append("\(format(current.x)) \(format(current.y))")
        }
        return "L" + points.joined(separator: " ")
      }
      if numbers.count >= 2, ["M", "L", "Q", "C"].contains(command) {
        current = (numbers[numbers.count - 2], numbers[numbers.count - 1])
      }
      return command + args.joined(separator: " ")
    }.joined(separator: " ")
  }
}
