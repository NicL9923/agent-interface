import XCTest

@testable import AgentInterface

/// Checks the avatar catalog the app draws, AvatarCatalog.swift, and the fixed paths in
/// AvatarPathData.swift against the web's. tests/avatar-art-parity.test.ts writes both the catalog
/// and the answer key in Avatar/avatar-art.json from src/components/avatar-shapes.ts and Avatar.tsx.
/// After an intended web change, run `UPDATE_AVATAR_ART=1 npx vitest run tests/avatar-art-parity.test.ts`,
/// commit both files, and match AvatarPathData.swift until this passes.
final class AvatarArtParityTests: XCTestCase {
  private struct Entry: Decodable, Equatable {
    var id: String
    var label: String
  }
  private struct Group: Decodable, Equatable {
    var id: String
    var label: String
    var shapes: [Entry]
  }
  private struct Legacy: Decodable, Equatable {
    var shape: String
    var was: String?
    var now: String?
  }
  /// A face as the web writes it: `cx`, `spacing` and `radius` may be absent.
  private struct Face: Decodable {
    var cx: Double?
    var cy: Double
    var scale: Double
    var spacing: Double?
    var radius: Double?
    var top: Double
    var hat: Double
  }
  private struct Shape: Decodable {
    var path: String
    var face: Face
  }
  private struct Art: Decodable {
    var modes: [String]
    var groups: [Group]
    var seasonalColors: [String: String]
    var legacyMascots: [String: Legacy]
    var colors: [String]
    var eyes: [String]
    var accessories: [String]
    var shapes: [String: Shape]
    var paths: [String]
  }

  private func art() throws -> Art {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("Avatar", isDirectory: true)
      .appendingPathComponent("avatar-art.json")
    return try JSONDecoder().decode(Art.self, from: Data(contentsOf: url))
  }

  func testCatalogListsMatchTheWeb() throws {
    let web = try art()
    XCTAssertEqual([AvatarMode.geometric, .portrait].map(\.rawValue), web.modes)
    XCTAssertEqual(
      AvatarCatalog.groups.map { group in
        Group(id: group.id, label: group.label, shapes: group.shapes.map { Entry(id: $0.rawValue, label: $0.label) })
      }, web.groups)
    XCTAssertEqual(AvatarConfig.shapes.map(\.rawValue), web.groups.flatMap { $0.shapes.map(\.id) })
    XCTAssertEqual(
      Dictionary(uniqueKeysWithValues: AvatarCatalog.seasonalColors.map { ($0.key.rawValue, $0.value) }),
      web.seasonalColors)
    XCTAssertEqual(
      AvatarCatalog.legacyMascots.mapValues { Legacy(shape: $0.shape.rawValue, was: $0.was, now: $0.now) },
      web.legacyMascots)
    XCTAssertEqual(AvatarConfig.colors, web.colors)
    XCTAssertEqual(AvatarEyes.all.map(\.rawValue), web.eyes)
    XCTAssertEqual(AvatarAccessory.all.map(\.rawValue), web.accessories)
  }
  func testEveryShapesOutlineAndFaceMatchTheWeb() throws {
    let web = try art()
    XCTAssertEqual(Set(AvatarCatalog.art.keys.map(\.rawValue)), Set(web.shapes.keys))
    for (id, expected) in web.shapes {
      let art = try XCTUnwrap(AvatarCatalog.art[AvatarShape(rawValue: id)], id)
      XCTAssertEqual(art.path, expected.path, id)
      // The web leaves out a default; the catalog writes it in, as the web rig applies it.
      let face = expected.face
      XCTAssertEqual(
        art.face,
        AvatarCatalog.Face(
          cx: face.cx ?? 50, cy: face.cy, scale: face.scale, spacing: face.spacing ?? 30 * face.scale,
          radius: face.radius ?? AvatarMotion.faceRadius, top: face.top, hat: face.hat), id)
    }
  }
  /// Web paths the app draws another way. The scan in tests/avatar-art-parity.test.ts picks up the
  /// "M" that starts the web's morph polygon. The four state-badge glyphs are SF Symbols in
  /// AvatarView's badge; neither app badges a lost connection any more, and the web keeps that
  /// glyph's path only in `StateGlyph`.
  private static let drawnOtherwise: Set<String> = [
    "M",
    "M4 8.4 L6.9 11.2 L12.2 5.2",
    "M5.8 6.1 Q5.9 3.6 8.1 3.6 Q10.4 3.7 10.4 5.8 Q10.4 7.4 8.1 8.3 V9.3",
    "M6 4.5 V11.5 M10 4.5 V11.5",
    "M8 3.8 V8.8",
  ]
  func testFixedPathsAreExactlyTheOnesTheWebDraws() throws {
    let web = Set(try art().paths)
    XCTAssertTrue(Self.drawnOtherwise.isSubset(of: web), "Stale exclusions: \(Self.drawnOtherwise.subtracting(web))")
    XCTAssertEqual(Set(AvatarPathData.allCases.map(\.rawValue)), web.subtracting(Self.drawnOtherwise))
  }
}
