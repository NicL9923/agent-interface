import SwiftUI

/// Every mascot except bear, fox and sprout is a character. This mirrors
/// src/components/character-avatars.tsx and uses the existing motion, face projection,
/// reduced-motion and accessibility rig. tests/avatar-component.test.ts parses `heads`,
/// `hatAnchors` and `cheekless` below, so keep their literal formats.
enum CharacterAvatarArt {
  /// Characters without an outline here use the shared mascot head.
  static let heads: [String: String] = [
    "cactus": "M50 10 C70 10 82 22 82 42 V84 Q82 96 70 96 H30 Q18 96 18 84 V42 C18 22 30 10 50 10Z",
    "pumpkin": "M50 24 C32 13 8 27 7 56 C6 80 21 94 50 94 C79 94 94 80 93 56 C92 27 68 13 50 24Z",
    "ghost": "M50 12 C73 12 88 29 88 52 V83 Q88 92 81 90 Q76 87 71 91 Q65 96 60 91 Q55 86 50 91 Q45 96 40 91 Q35 86 29 91 Q24 95 19 90 Q12 92 12 83 V52 C12 29 27 12 50 12Z",
    "leprechaun": "M50 22 C75 22 90 41 90 62 C90 82 75 96 50 96 C25 96 10 82 10 62 C10 41 25 22 50 22Z",
    "santa": "M50 22 C75 22 90 41 90 62 C90 82 75 96 50 96 C25 96 10 82 10 62 C10 41 25 22 50 22Z",
    "rudolph": "M50 25 C74 25 89 43 88 65 C88 85 73 97 50 97 C27 97 12 85 12 65 C11 43 26 25 50 25Z",
    "turkey": "M50 30 C69 30 82 45 82 62 C86 76 80 94 50 95 C20 94 14 76 18 62 C18 45 31 30 50 30Z",
    "bunny": "M50 31 C74 31 87 46 87 65 C87 84 72 96 50 96 C28 96 13 84 13 65 C13 46 26 31 50 31Z",
    "snowman": "M50 13 C74 13 92 31 92 55 C92 79 74 96 50 96 C26 96 8 79 8 55 C8 31 26 13 50 13Z",
  ]
  /// A smaller cowboy hat leaves a character's own cap, ears and antlers visible.
  static let hatAnchors: [String: (top: Double, hat: Double)] = [
    "leprechaun": (top: -3, hat: 0.45),
    "santa": (top: -3, hat: 0.45),
    "rudolph": (top: 24, hat: 0.45),
    "bunny": (top: 31, hat: 0.4),
  ]
  /// Characters whose own markings take the place of blushing cheeks.
  static let cheekless: Set<String> = ["pumpkin", "owl"]

  static let pandaFace = "#FBF7EF"
  /// The head's own fill: a panda's face stays white while its ears and patches take the chosen color.
  static func headColor(_ family: String, _ color: String) -> String {
    family == "panda" ? pandaFace : color
  }
  static let raccoonMask = "#3A3236"
  static let owlDisc = "#FFF3DB"
  /// What sits behind the eyes, so their ink contrasts with the patch, mask or disc.
  static func eyeSurroundColor(_ family: String, _ color: String) -> String {
    family == "raccoon" ? raccoonMask : family == "owl" ? owlDisc : color
  }

  // MARK: Shared drawing helpers
  static func circle(_ x: Double, _ y: Double, _ r: Double) -> Path { ellipse(x, y, r, r) }
  static func ellipse(_ x: Double, _ y: Double, _ rx: Double, _ ry: Double) -> Path {
    Path(ellipseIn: CGRect(x: x-rx, y: y-ry, width: rx*2, height: ry*2))
  }
  static func stroke(_ width: Double) -> StrokeStyle {
    StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round)
  }
  private static func fill(_ layer: GraphicsContext, _ path: Path, _ hex: String, opacity: Double = 1) {
    var context = layer
    context.opacity *= opacity
    context.fill(path, with: .color(Color(hex: hex)))
  }
  private static func line(_ layer: GraphicsContext, _ path: Path, _ hex: String, _ width: Double, opacity: Double = 1) {
    var context = layer
    context.opacity *= opacity
    context.stroke(path, with: .color(Color(hex: hex)), style: stroke(width))
  }
  /// The head turns by squashing its attachments toward the face's center line.
  private static func turned(_ layer: GraphicsContext, yaw: Double) -> GraphicsContext {
    var context = layer
    context.translateBy(x: 50, y: 0)
    context.scaleBy(x: max(abs(cos(yaw)), 0.3), y: 1)
    context.translateBy(x: -50, y: 0)
    return context
  }
  /// One part per side, drawn for the left side with outward toward -x.
  private static func pair(
    _ layer: GraphicsContext, dx: Double, y: Double = 0, yaw: Double,
    art: (GraphicsContext, Double) -> Void
  ) {
    let depth = max(abs(cos(yaw)), 0.3)
    for direction in [-1.0, 1.0] {
      let p = AvatarMotion.project(direction * dx, yaw: yaw, radius: 44)
      var side = layer
      side.translateBy(x: 50 + p.x, y: y)
      side.scaleBy(x: depth * -direction, y: 1)
      art(side, direction)
    }
  }
  /// The two-curve animal mouth under a nose, with a stem, opening into a smile when happy.
  private static func animalMouth(_ layer: GraphicsContext, y: Double, mouth: Double, happy: Double, stroke hex: String) {
    line(layer, SVGPath.parse("M50 \(y - 4) V\(y) M42.5 \(y) Q46.25 \(y + 4 * mouth) 50 \(y) Q53.75 \(y + 4 * mouth) 57.5 \(y)"), hex, 1.8, opacity: 1 - happy)
    if happy > 0.01 { fill(layer, SVGPath.parse("M44 \(y) Q50 \(y + 10) 56 \(y)Z"), hex, opacity: happy) }
  }

  // MARK: Static shapes
  private static let nose = SVGPath.parse("M45.5 66 Q50 63 54.5 66 Q53 70.5 50 71 Q47 70.5 45.5 66Z")
  private static let raccoonMaskPath = SVGPath.parse("M19 -5 C12 -10 -6 -11 -14 -4 C-18 0 -17 7 -12 9 C-4 11 8 6 19 4Z")
  private static let raccoonEar = SVGPath.parse("M-18 40 C-20 26 -17 12 -11 8 C-6 6 4 14 12 24Z")
  private static let raccoonEarInner = SVGPath.parse("M-13 32 C-14 23 -12 15 -9 13 C-5 13 0 18 4 23Z")
  private static let owlTuft = SVGPath.parse("M-12 36 C-16 26 -21 16 -26 8 C-20 9 -16 11 -13 14 C-13 10 -12 7 -10 4 C-7 13 0 20 8 26Z")
  private static let owlTuftInner = SVGPath.parse("M-12 29 C-14 24 -17 19 -20 14 C-16 15 -13 18 -11 21 C-10 18 -10 15 -9 13 C-7 19 -3 23 1 26Z")
  private static let cactusArm = SVGPath.parse("M2 76 H-8 Q-16 76 -16 68 V44 Q-16 37 -10.5 37 Q-5 37 -5 44 V64 H2Z")
  private static let cactusArmRib = SVGPath.parse("M-10.5 42 V68")
  private static let dinoPlate = SVGPath.parse("M-8 -38 Q-4 -56 0 -57 Q4 -56 8 -38Z")
  private static let batWing = SVGPath.parse("M4 44 C-4 36 -14 30 -24 28 C-23 37 -22 45 -24 54 C-19 51 -15 52 -13 57 C-10 53 -6 53 -4 58 C-1 54 2 53 5 56Z")
  private static let batWingBones = SVGPath.parse("M3 47 L-22 31 M3 50 L-13 55 M4 52 L-4 57")
  private static let batEar = SVGPath.parse("M-19 40 C-23 24 -22 10 -17 2 C-8 8 2 16 10 24Z")
  private static let batEarInner = SVGPath.parse("M-14 31 C-16 22 -16 14 -14 9 C-9 13 -3 18 2 23Z")
  private static let eagleCollar = SVGPath.parse("M10 70 C4 84 14 98 30 98 L34 92 L40 100 L46 93 L50 101 L54 93 L60 100 L66 92 L70 98 C86 98 96 84 90 70Z")
  static let featherShaft = SVGPath.parse("M0 -53 V-8")
  static let pumpkinStem = SVGPath.parse("M44 25 C47 18 45 11 48 5 L57 8 C52 16 55 21 56 26Z")
  static let pumpkinLeaf = SVGPath.parse("M53 15 C59 3 74 2 80 9 C73 18 62 20 53 15Z")
  static let pumpkinVein = SVGPath.parse("M56 14 Q65 9 74 9")
  static let bunnyEar = SVGPath.parse("M-11 45 C-20 29 -15 0 -6 0 C6 0 8 24 5 43Z")
  static let bunnyEarInner = SVGPath.parse("M-7 35 C-11 24 -10 10 -6 8 C0 10 1 24 -1 35Z")
  static let antler = SVGPath.parse("M0 31 L-2 17 L4 8 L2 0 M-2 17 L-12 10 L-11 2 M4 8 L13 5 L15 -2")
  static let rudolphEar = SVGPath.parse("M0 33 C6 18 20 17 24 23 C20 32 12 37 0 38Z")
  static let rudolphEarInner = SVGPath.parse("M6 31 Q14 22 19 24 Q15 31 6 33Z")
  static let pumpkinRibs = SVGPath.parse("M34 26 C24 45 24 75 36 90 M66 26 C76 45 76 75 64 90")
  static let pumpkinTeeth = SVGPath.parse("M44 78 L44 83 L49 83 L49 79 M55 79 L55 83 L60 83 L60 77")
  static let beard = SVGPath.parse("M13 63 Q24 58 31 67 Q50 74 69 67 Q76 58 87 63 C88 79 72 98 50 100 C28 98 12 79 13 63Z")
  static let mustache = SVGPath.parse("M29 71 Q34 61 50 66 Q66 61 71 71 Q61 80 50 72 Q39 80 29 71Z")
  static let wattle = SVGPath.parse("M51 69 C65 70 63 88 56 87 C49 86 54 77 49 74Z")
  static let beak = SVGPath.parse("M41 64 Q50 61 59 64 L50 75Z")
  static let bunnyNose = SVGPath.parse("M45 67 Q50 64 55 67 L50 73Z")
  static let whiskers = SVGPath.parse("M42 72 L22 68 M42 76 L20 77 M58 72 L78 68 M58 76 L80 77")
  static let teeth = SVGPath.parse("M46 78 H54 V85 Q50 88 46 85Z")
  static let toothSeam = SVGPath.parse("M50 79 V86")
  static let santaCap = SVGPath.parse("M17 30 C21 9 49 -2 69 6 Q80 8 87 23 L76 28 Q69 12 60 18 L72 31Z")
  static let capTrim = SVGPath.parse("M19 27 Q49 20 74 28 L76 37 Q49 32 17 37Z")
  static let bow = SVGPath.parse("M50 91 Q31 80 29 91 Q29 103 48 96 M50 91 Q69 80 71 91 Q71 103 52 96Z")
  private static let owlBeak = SVGPath.parse("M44.5 61 Q50 58.5 55.5 61 L50 72Z")
  private static let raccoonMuzzle = SVGPath.parse("M50 63 C44 66 34 66 28 70 C33 84 42 90 50 90 C58 90 67 84 72 70 C66 66 56 66 50 63Z")
  private static let owlBeakLines = SVGPath.parse("M40 80 L43 83 L46 80 M47 85 L50 88 L53 85 M54 80 L57 83 L60 80")
  private static let cactusRibs = SVGPath.parse("M30 16 Q23 55 30 96 M70 16 Q77 55 70 96")
  private static let cactusSpines = SVGPath.parse("M27 28 L24 26 M73 28 L76 26 M25 80 L22 81 M75 80 L78 81 M43 86 L42 89 M57 86 L58 89")
  private static let dinoTooth = SVGPath.parse("M55.5 79.2 L60.5 78.4 L58.6 83.6Z")
  private static let batNose = SVGPath.parse("M46.5 64 Q50 62 53.5 64 Q52.5 67 50 67 Q47.5 67 46.5 64Z")
  private static let batFangs = SVGPath.parse("M45 71.2 L46.5 75 L48 71.6Z M52 71.6 L53.5 75 L55 71.2Z")
  private static let eagleBeak = SVGPath.parse("M40 61 Q50 56 60 61 Q63 70 56 78 Q53 81 52 77 Q51 72 50 70 Q44 70 40 61Z")
  private static let leprechaunBeard = SVGPath.parse("M10 54 Q16 72 30 79 Q40 83 50 81 Q60 83 70 79 Q84 72 90 54 C94 86 74 106 50 106 C26 106 6 86 10 54Z")
  private static let leprechaunCurls = SVGPath.parse("M22 80 Q26 88 32 90 M40 88 Q44 95 50 96 M60 88 Q56 95 50 96 M78 80 Q74 88 68 90")
  private static let carrot = SVGPath.parse("M47 61 Q45.5 64.5 48 67 L64 65.5 Q65 64.5 64 63.8Z")
  private static let hatCrown = SVGPath.parse("M30 4 H70 L67 30 H33Z")
  private static let hatBand = SVGPath.parse("M33 22 H67 L66.4 28 H33.6Z")
  private static let hatBrim = SVGPath.parse("M14 30 Q50 22 86 30 Q88 36 82 36 Q50 30 18 36 Q12 36 14 30Z")
  private static let earmuffBand = SVGPath.parse("M10 52 C10 6 90 6 90 52")
  private static let scarfTail = SVGPath.parse("M64 90 L69 107 L79 105 L74 88Z")
  private static let scarfWrap = SVGPath.parse("M16 82 Q50 96 84 82 L86 91 Q50 106 14 91Z")
  private static let scarfStripes = SVGPath.parse("M30 89.5 L32 98 M50 92.5 V101 M70 89.5 L68 98")

  // MARK: Eye surround
  /// Painted behind each eye in eye coordinates, so a patch, mask or disc follows eye spacing and
  /// the head's turn. `side` is 1 for the left eye; the art is drawn for the left eye, inward to +x.
  static func eyeSurround(_ eye: GraphicsContext, family: String, side: Double, color: String, scaleX: Double, scale: Double) {
    var context = eye
    context.scaleBy(x: scaleX * side, y: scale)
    if family == "panda" {
      context.translateBy(x: -1.5, y: 2.5)
      context.rotate(by: .degrees(38))
      fill(context, ellipse(0, 0, 9.5, 13.5), color)
    } else if family == "raccoon" {
      fill(context, raccoonMaskPath, raccoonMask)
    } else if family == "owl" {
      fill(context, circle(0, 0, 12.5), owlDisc)
      line(context, circle(0, 0, 12.5), AvatarMotion.tint(color, -0.25), 2)
    }
  }

  // MARK: Back
  /// Identity parts behind the head, carried by the same body animation rig.
  static func back(_ layer: GraphicsContext, family: String, color: String, yaw: Double) {
    let depth = max(abs(cos(yaw)), 0.3)
    let centered = AvatarMotion.project(0, yaw: yaw).x
    switch family {
    case "panda":
      pair(layer, dx: 31, yaw: yaw) { side, _ in fill(side, circle(0, 24, 14), color) }
    case "raccoon":
      pair(layer, dx: 30, yaw: yaw) { side, _ in
        fill(side, raccoonEar, color)
        fill(side, raccoonEarInner, AvatarMotion.tint(color, 0.5))
      }
    case "owl":
      pair(layer, dx: 28, yaw: yaw) { side, _ in
        fill(side, owlTuft, color)
        fill(side, owlTuftInner, AvatarMotion.tint(color, -0.25))
      }
    case "cactus":
      pair(layer, dx: 30, yaw: yaw) { side, direction in
        var arm = side
        arm.translateBy(x: 0, y: direction > 0 ? 8 : 0)
        fill(arm, cactusArm, color)
        line(arm, cactusArmRib, AvatarMotion.tint(color, -0.18), 1.6, opacity: 0.7)
      }
    case "dinosaur":
      var plates = layer
      plates.translateBy(x: 50 + centered, y: 56)
      plates.scaleBy(x: depth, y: 1)
      for angle in [-50.0, -25, 0, 25, 50] {
        var plate = plates
        plate.rotate(by: .degrees(angle))
        let size = 1.05 - abs(angle) / 200
        plate.scaleBy(x: size, y: size)
        fill(plate, dinoPlate, AvatarMotion.tint(color, -0.28))
      }
    case "bat":
      pair(layer, dx: 34, yaw: yaw) { side, _ in
        fill(side, batWing, AvatarMotion.tint(color, -0.25))
        line(side, batWingBones, AvatarMotion.tint(color, -0.5), 1.3)
      }
      pair(layer, dx: 28, yaw: yaw) { side, _ in
        fill(side, batEar, color)
        fill(side, batEarInner, "#E8A0B4")
      }
    case "ghost":
      let edge = AvatarMotion.bodyEdge(color)
      pair(layer, dx: 36, yaw: yaw) { side, _ in
        var arm = side
        arm.translateBy(x: -5, y: 58)
        arm.rotate(by: .degrees(-32))
        fill(arm, ellipse(0, 0, 9, 5.5), color)
        if let edge { line(arm, ellipse(0, 0, 9, 5.5), edge, 2.2) }
      }
    case "eagle":
      var collar = layer
      collar.translateBy(x: centered * 0.3, y: 0)
      fill(collar, eagleCollar, "#6B4A2F")
    case "turkey":
      var fan = layer
      fan.translateBy(x: 50, y: 78)
      fan.scaleBy(x: max(abs(cos(yaw)), 0.25), y: 1)
      for (index, angle) in [-60.0, -40, -20, 0, 20, 40, 60].enumerated() {
        var feather = fan
        feather.rotate(by: .degrees(angle))
        fill(feather, ellipse(0, -31, 10, 29), ["#B84E32", "#D88736", "#F3BF58"][index % 3])
        line(feather, featherShaft, "#6C4130", 1.7, opacity: 0.38)
      }
    case "pumpkin":
      var stem = layer
      stem.translateBy(x: centered * 0.25, y: 0)
      fill(stem, pumpkinStem, "#52713A")
      fill(stem, pumpkinLeaf, "#6C9348")
      line(stem, pumpkinVein, "#A9C56C", 1.7)
    case "bunny", "rudolph":
      let bunny = family == "bunny"
      for direction in [-1.0, 1] {
        let p = AvatarMotion.project(direction * (bunny ? 15 : 27), yaw: yaw, radius: 44)
        var ear = layer
        ear.translateBy(x: 50 + p.x, y: bunny ? 0 : 8)
        ear.scaleBy(x: depth * (bunny ? -direction : direction), y: 1)
        if bunny {
          fill(ear, bunnyEar, color)
          fill(ear, bunnyEarInner, "#EDA6AF")
        } else {
          line(ear, antler, "#66452D", 4.5)
          fill(ear, rudolphEar, color)
          fill(ear, rudolphEarInner, AvatarMotion.tint(color, 0.45))
        }
      }
    default: break
    }
  }

  // MARK: Face
  /// Face markings are drawn inside the head's clip and projected with its eyes.
  static func face(_ layer: GraphicsContext, family: String, color: String, ink: Color, mouth: Double, happy: Double) {
    func inkFill(_ path: Path, opacity: Double = 1) {
      var context = layer
      context.opacity *= opacity
      context.fill(path, with: .color(ink))
    }
    func inkLine(_ path: Path, _ width: Double, opacity: Double = 1) {
      var context = layer
      context.opacity *= opacity
      context.stroke(path, with: .color(ink), style: stroke(width))
    }
    switch family {
    case "panda":
      fill(layer, nose, "#2b201b")
      animalMouth(layer, y: 74, mouth: mouth, happy: happy, stroke: "#2b201b")
    case "raccoon":
      fill(layer, ellipse(35, 41, 8, 4), "#FFF3DB", opacity: 0.9)
      fill(layer, ellipse(65, 41, 8, 4), "#FFF3DB", opacity: 0.9)
      fill(layer, raccoonMuzzle, "#FFF3DB")
      fill(layer, nose, "#2b201b")
      animalMouth(layer, y: 74, mouth: mouth, happy: happy, stroke: "#2b201b")
    case "owl":
      line(layer, owlBeakLines, AvatarMotion.tint(color, 0.35), 1.6)
      fill(layer, owlBeak, "#F2A93B")
    case "cactus":
      line(layer, cactusRibs, AvatarMotion.tint(color, -0.18), 2, opacity: 0.6)
      line(layer, cactusSpines, "#FFF3DB", 1.4, opacity: 0.85)
      inkLine(SVGPath.parse("M45 66 Q50 \(66 + 6 * mouth) 55 66"), 2.4, opacity: 1 - happy)
      if happy > 0.01 { inkFill(SVGPath.parse("M44 65 Q50 75 56 65 Q50 67.5 44 65Z"), opacity: happy) }
    case "dinosaur":
      fill(layer, ellipse(50, 75, 25, 14), AvatarMotion.tint(color, 0.35))
      fill(layer, ellipse(44, 69, 1.8, 1.3), AvatarMotion.tint(color, -0.45))
      fill(layer, ellipse(56, 69, 1.8, 1.3), AvatarMotion.tint(color, -0.45))
      line(layer, SVGPath.parse("M36 78 Q50 \(78 + 7 * mouth) 64 78"), "#2b201b", 2, opacity: 1 - happy)
      if happy > 0.01 { fill(layer, SVGPath.parse("M36 77 Q50 92 64 77 Q50 81 36 77Z"), "#2b201b", opacity: happy) }
      fill(layer, dinoTooth, "#FFFDF7")
    case "bat":
      fill(layer, batNose, AvatarMotion.tint(color, -0.4))
      inkLine(SVGPath.parse("M43 71 Q50 \(71 + 5 * mouth) 57 71"), 2, opacity: 1 - happy)
      if happy > 0.01 { inkFill(SVGPath.parse("M43 70 Q50 81 57 70Z"), opacity: happy) }
      fill(layer, batFangs, "#FFFDF7")
    case "ghost":
      inkFill(ellipse(50, 66, 4.5, 4.5 + 1.5 * mouth), opacity: 1 - happy)
      fill(layer, ellipse(50, 68 + 1.2 * mouth, 2.6, 1.6), "#F28FA0", opacity: 1 - happy)
      if happy > 0.01 { inkFill(SVGPath.parse("M43 63 Q50 74 57 63Z"), opacity: happy) }
    case "eagle":
      fill(layer, eagleBeak, "#F2B233")
      line(layer, SVGPath.parse("M42 65 Q50 \(67 + 3 * mouth) 58 65"), "#B97A1E", 1.5)
      fill(layer, ellipse(54, 61.5, 1.4, 0.9), "#B97A1E")
    case "leprechaun":
      fill(layer, leprechaunBeard, "#D9692E")
      line(layer, leprechaunCurls, "#B9531F", 1.6, opacity: 0.7)
      fill(layer, ellipse(50, 66, 5.5, 4.5), AvatarMotion.tint(color, -0.12))
      line(layer, SVGPath.parse("M43 73 Q50 \(73 + 5 * mouth) 57 73"), "#704737", 2.1, opacity: 1 - happy)
      if happy > 0.01 { fill(layer, SVGPath.parse("M43 72 Q50 82 57 72Z"), "#704737", opacity: happy) }
    case "snowman":
      let curve = mouth + 0.5 * happy
      for dx in [-10.0, -5, 0, 5, 10] {
        let t = dx / 10
        fill(layer, circle(50 + dx, 73 + (1 - t * t) * 4 * curve, 1.7), "#2B2B2B")
      }
      fill(layer, carrot, "#F28C28")
    case "pumpkin":
      line(layer, pumpkinRibs, AvatarMotion.tint(color, -0.35), 2.5, opacity: 0.5)
      inkFill(SVGPath.parse("M32 71 Q50 \(78 + 6 * mouth) 68 71 L65 81 L57 81 L55 87 L45 87 L43 81 L35 81Z"))
      fill(layer, pumpkinTeeth, color)
    case "santa":
      fill(layer, beard, "#FFF3DB")
      fill(layer, ellipse(50, 63, 7, 5.5), AvatarMotion.tint(color, -0.08))
      fill(layer, mustache, "#FFFDF7")
      line(layer, SVGPath.parse("M43 80 Q50 \(80 + 5 * mouth) 57 80"), "#704737", 2.1)
    case "turkey":
      fill(layer, wattle, "#D95145")
      fill(layer, beak, "#FFB548")
      line(layer, SVGPath.parse("M46 69 Q50 \(70 + 2 * mouth) 54 69"), "#8D5930", 1.6)
    case "bunny", "rudolph":
      let bunny = family == "bunny"
      fill(layer, ellipse(50, 75, bunny ? 21 : 20, bunny ? 13 : 16), "#FFF3DB")
      if bunny {
        fill(layer, bunnyNose, "#D98291")
        line(layer, whiskers, "#9F8F7A", 1.5)
        fill(layer, teeth, "#FFFDF7")
        line(layer, teeth, "#C5B5A0", 1)
        line(layer, toothSeam, "#C5B5A0", 1)
      } else {
        fill(layer, circle(50, 68, 7.5), "#E94F49")
        fill(layer, ellipse(47.5, 65.5, 2.7, 1.8), "#FFF3DB", opacity: 0.75)
      }
      animalMouth(layer, y: 77, mouth: mouth, happy: happy, stroke: "#66452D")
    default: break
    }
  }

  // MARK: Front
  /// Hats, scarves and blooms drawn over the head, outside its clip.
  static func front(_ layer: GraphicsContext, family: String, yaw: Double) {
    let centered = AvatarMotion.project(0, yaw: yaw).x
    switch family {
    case "cactus":
      var bloom = layer
      bloom.translateBy(x: centered * 0.3, y: 0)
      for angle in [0.0, 72, 144, 216, 288] {
        var petal = bloom
        petal.translateBy(x: 61, y: 11)
        petal.rotate(by: .degrees(angle))
        petal.translateBy(x: -61, y: -11)
        fill(petal, ellipse(61, 7, 3, 5), "#FF7FA8")
      }
      fill(bloom, circle(61, 11, 2.8), "#FFD15C")
    case "leprechaun":
      let hat = turned(layer, yaw: yaw)
      fill(hat, hatCrown, "#2E8B57")
      fill(hat, hatBand, "#1F1F1F")
      line(hat, Path(roundedRect: CGRect(x: 45, y: 21.5, width: 10, height: 7), cornerRadius: 1), "#F2C14E", 2)
      fill(hat, hatBrim, "#257A4B")
      for x in [37.0, 41] { fill(hat, circle(x, 13, 2.6), "#7BD389") }
      fill(hat, circle(39, 9.6, 2.6), "#7BD389")
    case "snowman":
      let muffs = turned(layer, yaw: yaw)
      line(muffs, earmuffBand, "#E25A6A", 4.5)
      for x in [10.0, 90] {
        fill(muffs, circle(x, 54, 9.5), "#F07C8A")
        fill(muffs, circle(x, 54, 5), "#F7A9B3")
      }
      var scarf = layer
      scarf.translateBy(x: centered * 0.5, y: 0)
      fill(scarf, scarfTail, "#2F66AA")
      fill(scarf, scarfWrap, "#3F7CC8")
      line(scarf, scarfStripes, "#9CC3EE", 2)
    case "santa":
      let cap = turned(layer, yaw: yaw)
      fill(cap, santaCap, "#D34434")
      fill(cap, capTrim, "#FFF3DB")
      fill(cap, circle(86, 27, 8), "#FFFDF7")
    case "bunny":
      var ribbon = layer
      ribbon.translateBy(x: centered * 0.7, y: 0)
      fill(ribbon, bow, "#A888CD")
      fill(ribbon, circle(50, 93, 4), "#CBB2E5")
    default: break
    }
  }
}
