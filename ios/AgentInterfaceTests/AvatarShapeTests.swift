import SwiftUI
import XCTest

@testable import AgentInterface

/// The flat-silhouette avatars, mirroring tests/avatar-legacy.test.ts, avatar-component.test.ts and
/// avatar-editor.test.ts: retired mascots read as shapes, faces sit on each shape's anchor, shapes
/// with holes morph along their outside, and a seasonal shape brings its color.
final class AvatarShapeTests: XCTestCase {
  private func decode(_ json: String) throws -> AvatarConfig {
    try JSONDecoder().decode(AvatarConfig.self, from: Data(json.utf8))
  }

  func testARetiredMascotDecodesAsItsShapeAndKeepsEveryChoice() throws {
    let fox = try decode(##"{"mode":"mascot","family":"raccoon","shape":"blob","color":"#111111","eyes":"spark","accessory":"glasses","eyeWidth":1.2,"eyeHeight":0.8,"eyeSpacing":1.3}"##)
    XCTAssertEqual(fox, AvatarConfig(
      mode: .geometric, shape: .fox, color: "#111111", eyes: .spark, accessory: .glasses, eyeWidth: 1.2,
      eyeHeight: 0.8, eyeSpacing: 1.3, src: nil, origin: nil))
    // Saving it writes the shape, never the retired family.
    let saved = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(fox)) as? [String: Any])
    XCTAssertNil(saved["family"])
    XCTAssertEqual(saved["mode"] as? String, "geometric")
    XCTAssertEqual(saved["shape"] as? String, "fox")
  }
  func testASeasonalMascotsFixedFaceColorBecomesItsShapesColor() throws {
    for (json, shape, color) in [
      // Its own fixed color, in any case, becomes the shape's.
      (##"{"mode":"mascot","family":"santa","color":"#f2b08b"}"##, AvatarShape.santaHat, "#FF263C"),
      (##"{"mode":"mascot","family":"eagle","color":"#F7F3EA"}"##, .star, "#FF9800"),
      // A color someone chose stays, and so does the fixed color of a mascot that had no swap.
      (##"{"mode":"mascot","family":"santa","color":"#111111"}"##, .santaHat, "#111111"),
      (##"{"mode":"mascot","family":"bunny","color":"#F2B08B"}"##, .bunny, "#F2B08B"),
    ] {
      let avatar = try decode(json)
      XCTAssertEqual(avatar.shape, shape, json)
      XCTAssertEqual(avatar.color, color, json)
    }
    XCTAssertNil(try decode(##"{"mode":"mascot","family":"santa"}"##).color, "No color is not a match")
  }
  func testAMascotFamilyNoBuildHadDecodesAsTheBlob() throws {
    for json in [
      ##"{"mode":"mascot","family":"yeti","color":"#111111"}"##,
      ##"{"mode":"mascot","color":"#111111"}"##,
      ##"{"mode":"mascot","family":7,"color":"#111111"}"##,
    ] {
      let avatar = try decode(json)
      XCTAssertEqual(avatar.mode, .geometric, json)
      XCTAssertEqual(avatar.shape, .blob, json)
      XCTAssertEqual(avatar.color, "#111111", json)
    }
  }
  func testAnAvatarThatIsNotAMascotDecodesUnchanged() throws {
    // A family beside a shape is not a mascot; the shape stands.
    let mug = try decode(##"{"mode":"geometric","shape":"mug","family":"fox","color":"#F2B08B"}"##)
    XCTAssertEqual(mug.shape, .mug)
    XCTAssertEqual(mug.color, "#F2B08B")
    let portrait = try decode(##"{"mode":"portrait","src":"/api/files/a","origin":"uploaded"}"##)
    XCTAssertEqual(portrait.mode, .portrait)
    XCTAssertNil(portrait.shape)
    XCTAssertEqual(portrait.src, "/api/files/a")
  }
  func testABotFromAnOlderServerArrivesWithItsMascotConverted() throws {
    let bots = try JSONDecoder().decode([Bot].self, from: Data(##"""
      [{"id":"k","name":"Kitchen","model":"m","shared":true,"activity":"idle","avatar":{"mode":"mascot","family":"dinosaur","color":"#00BCA6","eyes":"round","accessory":"hat"}}]
      """##.utf8))
    XCTAssertEqual(bots[0].avatar?.drawnShape, .dino)
    XCTAssertEqual(bots[0].avatar?.accessory, .hat)
  }

  func testAMascotWithAMalformedShapeStillDecodes() throws {
    // An older server's mascot: its shape field is never read, so a bad one cannot fail the roster.
    let bots = try JSONDecoder().decode([Bot].self, from: Data(##"""
      [{"id":"k","name":"Kitchen","model":"m","shared":true,"activity":"idle","avatar":{"mode":"mascot","family":"bear","shape":7,"color":"#111111"}}]
      """##.utf8))
    XCTAssertEqual(bots[0].avatar?.drawnShape, .bear)
    XCTAssertEqual(bots[0].avatar?.color, "#111111")
    // Any other mode still refuses a shape that is not a name.
    XCTAssertThrowsError(try decode(##"{"mode":"geometric","shape":7,"color":"#111111"}"##))
  }

  func testAnOffCenterFaceSitsOnItsAnchor() throws {
    let mug = try XCTUnwrap(AvatarCatalog.art[.mug]?.face)
    XCTAssertNotEqual(mug.cx, 50, "The mug looks out from its cup, left of the handle")
    let rig = AvatarMotion.faceRig(mug, pose: AvatarMotion.restingPose, state: .idle, eyeSpacing: 1)
    XCTAssertEqual(rig.eyes[0].x, mug.cx - mug.spacing / 2, accuracy: 1e-9)
    XCTAssertEqual(rig.eyes[1].x, mug.cx + mug.spacing / 2, accuracy: 1e-9)
    XCTAssertEqual(rig.centerX, mug.cx, accuracy: 1e-9, "The glasses bridge sits between the eyes")
    XCTAssertEqual([rig.hatX, rig.hatY, rig.hatScale], [mug.cx, mug.top + 15 * mug.hat, mug.hat])
    // The spacing slider spreads the eyes around the same middle.
    let wide = AvatarMotion.faceRig(mug, pose: AvatarMotion.restingPose, state: .idle, eyeSpacing: 1.5)
    XCTAssertEqual(wide.eyes[1].x - wide.eyes[0].x, mug.spacing * 1.5, accuracy: 1e-9)
    XCTAssertEqual((wide.eyes[0].x + wide.eyes[1].x) / 2, mug.cx, accuracy: 1e-9)
  }
  func testANarrowFaceTurnsAndGlancesWithinItsOwnRadius() throws {
    let rocket = try XCTUnwrap(AvatarCatalog.art[.rocket]?.face)
    XCTAssertLessThan(rocket.radius, AvatarMotion.faceRadius)
    var pose = AvatarMotion.restingPose
    pose.yaw = 0.9
    pose.gazeY = 1
    let rig = AvatarMotion.faceRig(rocket, pose: pose, state: .idle, eyeSpacing: 1)
    // Turned this far on the default sphere, an eye would sit 37 units out, well off the hull.
    for eye in rig.eyes where eye.projection.visible {
      XCTAssertLessThanOrEqual(abs(eye.x - rocket.cx), rocket.radius)
    }
    // A glance and the waiting droop travel in proportion to the narrower face.
    let reach = rocket.radius / AvatarMotion.faceRadius
    XCTAssertEqual(rig.eyeY, rocket.cy + 3 * reach, accuracy: 1e-9)
    let waiting = AvatarMotion.faceRig(rocket, pose: pose, state: .waiting, eyeSpacing: 1)
    XCTAssertEqual(waiting.eyeY, rocket.cy + 5 * reach, accuracy: 1e-9)
  }

  func testAShapeWithAHoleMorphsAlongItsOutsideAndDrawsTheHoleWhenStill() throws {
    let mug = AvatarGeometry.svg(.mug)
    let outside = AvatarGeometry.outside(mug)
    XCTAssertTrue(mug.hasPrefix(outside))
    XCTAssertLessThan(outside.count, mug.count, "The handle is a second contour")
    XCTAssertEqual(AvatarGeometry.sampled(.mug), AvatarGeometry.points(of: outside))
    XCTAssertNotEqual(AvatarGeometry.sampled(.mug), AvatarGeometry.points(of: mug))
    XCTAssertEqual(AvatarGeometry.outside("M0 0 L1 0 L1 1"), "M0 0 L1 0 L1 1", "An open path is all outside")
    for shape in [AvatarShape.mug, .palette, .wateringCan] {
      // The middle of the hole: filled by the morph's polygon, open in the exact outline.
      let hole = String(AvatarGeometry.svg(shape).dropFirst(outsideContour(of: shape).count))
      let numbers = hole.split { !"-.0123456789".contains($0) }.compactMap { Double($0) }
      let xs = stride(from: 0, to: numbers.count, by: 2).map { numbers[$0] }
      let ys = stride(from: 1, to: numbers.count, by: 2).map { numbers[$0] }
      let middle = CGPoint(x: (xs.min()! + xs.max()!) / 2, y: (ys.min()! + ys.max()!) / 2)
      XCTAssertFalse(AvatarGeometry.path(shape).contains(middle, eoFill: false), shape.rawValue)
      XCTAssertTrue(AvatarGeometry.sampled(shape).polygon.contains(middle, eoFill: false), shape.rawValue)
    }
  }
  func testTheDrawnBodyLandsOnTheExactOutlineHoleAndAll() throws {
    // What the view draws: halfway, the samples on their way; at the end, the mug with its handle open.
    let blob = AvatarGeometry.sampled(.blob)
    XCTAssertNotEqual(AvatarGeometry.body(.mug, from: blob, progress: 0.5), AvatarGeometry.path(.mug))
    let landed = AvatarGeometry.body(.mug, from: blob, progress: AvatarMotion.smoothstep(1))
    XCTAssertEqual(landed, AvatarGeometry.path(.mug))
    XCTAssertFalse(landed.contains(holeCenter(.mug), eoFill: false))
    XCTAssertEqual(AvatarGeometry.body(.mug, from: nil, progress: 0), AvatarGeometry.path(.mug), "No morph draws the outline")
  }
  /// The middle of a shape's hole in the 0-100 box.
  private func holeCenter(_ shape: AvatarShape) -> CGPoint {
    let hole = String(AvatarGeometry.svg(shape).dropFirst(outsideContour(of: shape).count))
    let numbers = hole.split { !"-.0123456789".contains($0) }.compactMap { Double($0) }
    let xs = stride(from: 0, to: numbers.count, by: 2).map { numbers[$0] }
    let ys = stride(from: 1, to: numbers.count, by: 2).map { numbers[$0] }
    return CGPoint(x: (xs.min()! + xs.max()!) / 2, y: (ys.min()! + ys.max()!) / 2)
  }
  @MainActor func testAFrozenAvatarsViewShowsItsNewShapeAndColorWithoutWaitingForAMorph() async throws {
    let before = AvatarConfig(shape: .blob, color: "#1084FE"), after = AvatarConfig(shape: .mug, color: "#FF6700")
    for state in [ActivityState.interrupted, .disconnected, .unknown] {
      let stage = try HostedAvatar(before, state), fresh = try HostedAvatar(after, state)
      defer { stage.close(); fresh.close() }
      try await until { stage.difference(from: fresh) > 0.05 }
      stage.show(after, state)
      // Production timer: longer than the 280 ms morph, shorter than the second a change keeps settling.
      try await Task.sleep(for: .milliseconds(500))
      XCTAssertLessThan(stage.difference(from: fresh), 0.005, state.rawValue)
    }
  }
  @MainActor func testTheViewsMorphLandsWithTheMugsHandleOpen() async throws {
    let stage = try HostedAvatar(AvatarConfig(shape: .blob, color: "#1084FE"), .idle)
    defer { stage.close() }
    let hole = holeCenter(.mug)
    try await until { !stage.isBackground(hole) }
    stage.show(AvatarConfig(shape: .mug, color: "#1084FE"), .idle)
    // The samples carry no hole, so the handle opens only once the view draws the exact outline.
    try await until { stage.isBackground(hole) }
    XCTAssertFalse(stage.isBackground(CGPoint(x: 41, y: 75)), "The cup itself is drawn")
  }
  func testAChangeOnlyMovesIntoPlaceWhileFramesCanCarryIt() {
    XCTAssertTrue(AvatarView.animatesChange(state: .idle, reduceMotion: false, visible: true, active: true))
    XCTAssertTrue(AvatarView.animatesChange(state: .failed, reduceMotion: false, visible: true, active: true),
      "A change starts the failed avatar's settling frames")
    // A frozen, reduced, hidden or backgrounded avatar draws once, so a morph would stop on its first frame.
    for state in [ActivityState.interrupted, .disconnected, .unknown] {
      XCTAssertFalse(AvatarView.animatesChange(state: state, reduceMotion: false, visible: true, active: true), state.rawValue)
    }
    XCTAssertFalse(AvatarView.animatesChange(state: .idle, reduceMotion: true, visible: true, active: true))
    XCTAssertFalse(AvatarView.animatesChange(state: .idle, reduceMotion: false, visible: false, active: true))
    XCTAssertFalse(AvatarView.animatesChange(state: .idle, reduceMotion: false, visible: true, active: false))
  }
  private func outsideContour(of shape: AvatarShape) -> String { AvatarGeometry.outside(AvatarGeometry.svg(shape)) }

  private func points(_ vector: PointVector) -> [CGPoint] {
    stride(from: 0, to: vector.values.count, by: 2).map { CGPoint(x: vector.values[$0], y: vector.values[$0 + 1]) }
  }
  private func area(_ points: [CGPoint]) -> Double { abs(AvatarGeometry.signedArea(points)) }

  func testMorphSamplesStartAtTheTopAndRunClockwiseHoweverTheOutlineWasDrawn() {
    let square = [(10, 10), (30, 10), (50, 10), (50, 30), (50, 50), (30, 50), (10, 50), (10, 30)]
      .map { CGPoint(x: $0.0, y: $0.1) }
    let aligned = AvatarGeometry.aligned(square)
    XCTAssertEqual(Array(aligned.prefix(2)), [CGPoint(x: 30, y: 10), CGPoint(x: 50, y: 10)])
    // The same square drawn counter-clockwise from its bottom right corner.
    let turned = Array((square[4...] + square[..<4]).reversed())
    XCTAssertLessThan(AvatarGeometry.signedArea(turned), 0)
    XCTAssertEqual(AvatarGeometry.aligned(turned), aligned)
    XCTAssertEqual(AvatarGeometry.aligned(aligned), aligned)
  }
  func testBetweenTwoEquallyCentralSamplesTheHigherOneStarts() {
    // A step in the top edge: (29, 10) and (31, 22) are each 1 unit from the middle at x 30.
    let stepped = [(10, 10), (29, 10), (31, 22), (50, 22), (50, 50), (10, 50)].map { CGPoint(x: $0.0, y: $0.1) }
    XCTAssertEqual(AvatarGeometry.aligned(stepped).first, CGPoint(x: 29, y: 10))
    // And the same when the lower of the two comes first round the outline.
    let mirrored = stepped.map { CGPoint(x: 60 - $0.x, y: $0.y) }
    XCTAssertEqual(AvatarGeometry.aligned(mirrored).first, CGPoint(x: 31, y: 10))
  }
  func testTheBlobStartsWhereItsOutlineDoesAndTheDropIsReversed() {
    XCTAssertEqual(points(AvatarGeometry.sampled(.blob)).first, CGPoint(x: 50, y: 3))
    // The drop is drawn counter-clockwise from its tip; unaligned, a blob would turn inside out on its way.
    let drop = points(AvatarGeometry.sampled(.drop))
    XCTAssertEqual(drop.first, CGPoint(x: 50, y: 7))
    XCTAssertGreaterThan(drop[18].x, 50)
  }
  func testNoMorphBetweenTwoShapesCollapsesTheBodyOnTheWay() {
    // Before the samples were aligned, a blob halfway to a reindeer had a quarter of its area.
    var thin: [String] = []
    let sampled = AvatarConfig.shapes.map { ($0, points(AvatarGeometry.sampled($0))) }
    for (from, a) in sampled {
      for (to, b) in sampled {
        let middle = zip(a, b).map { CGPoint(x: ($0.x + $1.x) / 2, y: ($0.y + $1.y) / 2) }
        if area(middle) < 0.8 * min(area(a), area(b)) { thin.append("\(from.rawValue) to \(to.rawValue)") }
      }
    }
    XCTAssertEqual(thin, [])
  }

  func testTunedEyesStopGrowingAtTheEdgeOfThePartTheFaceSitsOn() throws {
    // A visor at full width and spacing is 47 units across on a paint brush whose bristles are 43.
    let brush = try XCTUnwrap(AvatarCatalog.art[.paintBrush]?.face)
    let body = AvatarGeometry.path(.paintBrush)
    for yaw in [0.0, 0.3, -0.3] {
      var pose = AvatarMotion.restingPose
      pose.yaw = yaw
      let rig = AvatarMotion.faceRig(brush, pose: pose, state: .working, eyes: .visor, eyeWidth: 1.5, eyeSpacing: 1.5)
      XCTAssertLessThan(rig.fit, 1)
      let half = AvatarMotion.eyeHalfWidth(.visor) * brush.scale * 1.5 * rig.fit
      for eye in rig.eyes where eye.projection.visible {
        for x in [eye.x - half * eye.projection.scale, eye.x + half * eye.projection.scale] {
          XCTAssertTrue(body.contains(CGPoint(x: x, y: rig.eyeY), eoFill: false), "Eye edge \(x) at yaw \(yaw) is off the brush")
        }
      }
    }
    // The blob has room for them, so there they are as large and as far apart as chosen.
    let blob = try XCTUnwrap(AvatarCatalog.art[.blob]?.face)
    let roomy = AvatarMotion.faceRig(blob, pose: AvatarMotion.restingPose, state: .idle, eyes: .visor, eyeWidth: 1.5, eyeSpacing: 1.5)
    XCTAssertEqual(roomy.fit, 1)
    XCTAssertEqual(roomy.eyes[1].x - roomy.eyes[0].x, 45, accuracy: 1e-9)
    // Every shape keeps its full-size eyes at default tuning.
    for shape in AvatarConfig.shapes {
      for eyes in AvatarEyes.all {
        let face = shape.art.face
        XCTAssertEqual(AvatarMotion.faceRig(face, pose: AvatarMotion.restingPose, state: .idle, eyes: eyes).fit, 1, "\(shape.rawValue) \(eyes.rawValue)")
      }
    }
  }

  func testPickingASeasonalShapeBringsItsColorAndOthersKeepTheChosenOne() {
    let chosen = AvatarConfig(
      shape: .blob, color: "#111111", eyes: .spark, accessory: .glasses, eyeWidth: 1.2, eyeHeight: 0.8,
      eyeSpacing: 1.3)
    let pumpkin = chosen.selectingShape(.pumpkin)
    XCTAssertEqual(pumpkin.shape, .pumpkin)
    XCTAssertEqual(pumpkin.color, "#FF6700")
    XCTAssertEqual(pumpkin.eyes, .spark)
    XCTAssertEqual(pumpkin.accessory, .glasses)
    XCTAssertEqual([pumpkin.eyeWidth, pumpkin.eyeHeight, pumpkin.eyeSpacing], [1.2, 0.8, 1.3])
    // Clover and star were seasonal mascots once; as shapes they are everyday ones.
    for shape in [AvatarShape.mug, .clover, .star] {
      XCTAssertEqual(pumpkin.selectingShape(shape).color, "#FF6700", shape.rawValue)
    }
    XCTAssertEqual(pumpkin.selectingShape(.snowman).color, "#F4F8FB")
    // Picking the pumpkin again keeps a color chosen since, while its tile still shows it in orange.
    var blue = pumpkin
    blue.color = "#1084FE"
    XCTAssertEqual(blue.selectingShape(.pumpkin), blue)
    XCTAssertEqual(blue.showingShape(.pumpkin).color, "#FF6700")
  }

  /// One still frame of `avatar` in `state`, as RGBA bytes at twice the 116-unit box.
  @MainActor private func render(_ avatar: AvatarConfig, _ state: ActivityState) throws -> (pixels: [UInt8], frame: AvatarMotion.Frame) {
    let now = Date()
    let frame = AvatarMotion.frame(.entering(state, at: now), at: now, still: true)
    let size = 116.0
    let canvas = Canvas { context, _ in
      AvatarArtwork(
        avatar: avatar, state: state, frame: frame,
        body: AvatarGeometry.path(avatar.drawnShape), bodyColor: Color(hex: avatar.color ?? "#1084FE")
      ).draw(context)
    }.frame(width: size, height: size)
    let renderer = ImageRenderer(content: canvas)
    renderer.scale = 2
    let image = try XCTUnwrap(renderer.cgImage)
    let width = image.width, height = image.height
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
      guard let context = CGContext(
        data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return false }
      context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
      return true
    }
    XCTAssertTrue(drawn)
    return (pixels, frame)
  }
  /// Counts the opaque pixels of a blocked avatar's exclamation mark that are not its fill: the soft
  /// edge a very light body keeps.
  @MainActor private func edgePixels(_ color: String) throws -> (edge: Int, fill: Int) {
    let (pixels, frame) = try render(AvatarConfig(shape: .mug, color: color), .blocked)
    XCTAssertEqual(frame.morph.bang, 1, "Blocked shows the mark in place of the body")
    let fill = try XCTUnwrap(AvatarMotion.rgb(color))
    var counts = (edge: 0, fill: 0)
    for i in stride(from: 0, to: pixels.count, by: 4) where pixels[i + 3] == 255 {
      let distance = abs(Int(pixels[i]) - fill.0) + abs(Int(pixels[i + 1]) - fill.1) + abs(Int(pixels[i + 2]) - fill.2)
      if distance > 30 { counts.edge += 1 } else { counts.fill += 1 }
    }
    return counts
  }
  @MainActor func testAnEyeStyleThisBuildDoesNotHaveDrawsAsOvalEyes() throws {
    // Hermes metadata is not validated on the way in, so a newer or stray style can arrive.
    let laser = AvatarEyes(rawValue: "laser")
    let brush = try XCTUnwrap(AvatarCatalog.art[.paintBrush]?.face)
    // Tuned past the brush's edge, the fit depends on the style's width.
    XCTAssertEqual(
      AvatarMotion.faceRig(brush, pose: AvatarMotion.restingPose, state: .idle, eyes: laser, eyeWidth: 1.5, eyeSpacing: 1.5),
      AvatarMotion.faceRig(brush, pose: AvatarMotion.restingPose, state: .idle, eyes: .oval, eyeWidth: 1.5, eyeSpacing: 1.5))
    let oval = try render(AvatarConfig(shape: .blob, eyes: .oval), .idle).pixels
    let unknown = try render(AvatarConfig(shape: .blob, eyes: laser), .idle).pixels
    let round = try render(AvatarConfig(shape: .blob, eyes: .round), .idle).pixels
    XCTAssertTrue(unknown == oval, "The unknown style draws the oval pills")
    XCTAssertFalse(round == oval, "The eyes are in the picture")
  }
  @MainActor func testAVeryLightBodysBlockedMarkKeepsItsEdge() throws {
    XCTAssertNotNil(AvatarMotion.bodyEdge("#F4F4F4"))
    let light = try edgePixels("#F4F4F4")
    XCTAssertGreaterThan(light.fill, 0)
    XCTAssertGreaterThan(light.edge, 100, "The white mug's mark is outlined")
    XCTAssertNil(AvatarMotion.bodyEdge("#FF6700"))
    let saturated = try edgePixels("#FF6700")
    XCTAssertGreaterThan(saturated.fill, 0)
    XCTAssertEqual(saturated.edge, 0, "A saturated mark has no outline")
  }
}

/// The real avatar view in a window, so a test reads the pixels a person sees: its timeline, its
/// morph and its state changes included.
@MainActor private final class HostedAvatar {
  struct Content: View {
    var avatar: AvatarConfig
    var state: ActivityState
    var body: some View {
      AvatarView(avatar: avatar, state: state, size: 200, name: "Hosted avatar")
        .frame(width: 240, height: 240).background(Color.white).environment(\.scenePhase, .active)
    }
  }
  private let window: UIWindow
  private let host: UIHostingController<Content>

  init(_ avatar: AvatarConfig, _ state: ActivityState) throws {
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    host = UIHostingController(rootView: Content(avatar: avatar, state: state))
    host.safeAreaRegions = []
    window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 240, height: 240)
    window.overrideUserInterfaceStyle = .light
    window.rootViewController = host
    window.isHidden = false
    window.layoutIfNeeded()
  }
  func close() { window.isHidden = true }
  func show(_ avatar: AvatarConfig, _ state: ActivityState) { host.rootView = Content(avatar: avatar, state: state) }

  /// 240 by 240 RGBA pixels, one per point.
  func pixels() -> [UInt8] {
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.preferredRange = .standard
    let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
      window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
    }
    var bytes = [UInt8](repeating: 0, count: 240 * 240 * 4)
    bytes.withUnsafeMutableBytes { buffer in
      guard let image = image.cgImage, let context = CGContext(
        data: buffer.baseAddress, width: 240, height: 240, bitsPerComponent: 8, bytesPerRow: 240 * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return }
      context.draw(image, in: CGRect(x: 0, y: 0, width: 240, height: 240))
    }
    return bytes
  }
  /// The share of pixels that differ visibly from `other`'s.
  func difference(from other: HostedAvatar) -> Double {
    let a = pixels(), b = other.pixels()
    var changed = 0
    for i in stride(from: 0, to: a.count, by: 4) where (0..<3).contains(where: { abs(Int(a[i + $0]) - Int(b[i + $0])) > 24 }) {
      changed += 1
    }
    return Double(changed) / Double(240 * 240)
  }
  /// Whether the white behind the avatar shows at `point` in the 0-100 box.
  func isBackground(_ point: CGPoint) -> Bool {
    let x = Int(20 + (8 + point.x) / 116 * 200), y = Int(20 + (8 + point.y) / 116 * 200)
    let bytes = pixels(), i = (y * 240 + x) * 4
    return bytes[i] > 235 && bytes[i + 1] > 235 && bytes[i + 2] > 235
  }
}
