import XCTest
@testable import AgentInterface

/// A live reply's growth notices against the web's src/shared/inflight.ts, through the vectors both
/// clients read: Vectors/inflight-delta.json.
@MainActor final class InflightDeltaTests: XCTestCase {
  private struct Vectors: Decodable {
    struct Case: Decodable { var name: String; var held: Inflight?; var delta: InflightDelta; var result: Inflight? }
    var cases: [Case]
  }
  private func vectors() throws -> [Vectors.Case] {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Vectors/inflight-delta.json")
    return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url)).cases
  }

  func testGrowthNoticesMatchTheSharedVectors() throws {
    let cases = try vectors()
    XCTAssertFalse(cases.isEmpty)
    for vector in cases {
      let next = vector.held?.extended(by: vector.delta)
      XCTAssertEqual(next, vector.result, vector.name)
      // Code unit for code unit, as JavaScript sees it: Swift's == would also accept a differently
      // composed text.
      XCTAssertEqual(next.map { Array($0.message.text.utf16) }, vector.result.map { Array($0.message.text.utf16) }, vector.name)
      XCTAssertEqual(next.map { Array(($0.message.reasoning ?? "").utf16) }, vector.result.map { Array(($0.message.reasoning ?? "").utf16) }, vector.name)
    }
  }
}
