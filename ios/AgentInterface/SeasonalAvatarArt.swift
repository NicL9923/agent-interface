import SwiftUI

/// Seasonal identity artwork mirrors src/components/seasonal-avatars.tsx.
/// It uses the existing motion, face projection, reduced-motion and accessibility rig.
enum SeasonalAvatarArt {
  static let heads: [String: String] = [
    "pumpkin": "M50 24 C32 13 8 27 7 56 C6 80 21 94 50 94 C79 94 94 80 93 56 C92 27 68 13 50 24Z",
    "santa": "M50 22 C75 22 90 41 90 62 C90 82 75 96 50 96 C25 96 10 82 10 62 C10 41 25 22 50 22Z",
    "rudolph": "M50 25 C74 25 89 43 88 65 C88 85 73 97 50 97 C27 97 12 85 12 65 C11 43 26 25 50 25Z",
    "turkey": "M50 30 C69 30 82 45 82 62 C86 76 80 94 50 95 C20 94 14 76 18 62 C18 45 31 30 50 30Z",
    "bunny": "M50 31 C74 31 87 46 87 65 C87 84 72 96 50 96 C28 96 13 84 13 65 C13 46 26 31 50 31Z",
  ]
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
  static let happyMouth = SVGPath.parse("M44 77 Q50 87 56 77Z")
  static let santaCap = SVGPath.parse("M17 30 C21 9 49 -2 69 6 Q80 8 87 23 L76 28 Q69 12 60 18 L72 31Z")
  static let capTrim = SVGPath.parse("M19 27 Q49 20 74 28 L76 37 Q49 32 17 37Z")
  static let bow = SVGPath.parse("M50 91 Q31 80 29 91 Q29 103 48 96 M50 91 Q69 80 71 91 Q71 103 52 96Z")
  static func circle(_ x: Double, _ y: Double, _ r: Double) -> Path { ellipse(x, y, r, r) }
  static func ellipse(_ x: Double, _ y: Double, _ rx: Double, _ ry: Double) -> Path {
    Path(ellipseIn: CGRect(x: x-rx, y: y-ry, width: rx*2, height: ry*2))
  }
  static func stroke(_ width: Double) -> StrokeStyle {
    StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round)
  }
  static func back(_ layer: GraphicsContext, family: String, color: String, yaw: Double) {
    let depth = max(abs(cos(yaw)), 0.3)
    if family == "turkey" {
      var fan = layer
      fan.translateBy(x: 50, y: 78)
      fan.scaleBy(x: max(abs(cos(yaw)), 0.25), y: 1)
      for (index, angle) in [-60.0, -40, -20, 0, 20, 40, 60].enumerated() {
        var feather = fan
        feather.rotate(by: .degrees(angle))
        feather.fill(ellipse(0, -31, 10, 29), with: .color(Color(hex: ["#B84E32", "#D88736", "#F3BF58"][index % 3])))
        feather.opacity *= 0.38
        feather.stroke(featherShaft, with: .color(Color(hex: "#6C4130")), style: stroke(1.7))
      }
    } else if family == "pumpkin" {
      var stem = layer
      stem.translateBy(x: AvatarMotion.project(0, yaw: yaw).x * 0.25, y: 0)
      stem.fill(pumpkinStem, with: .color(Color(hex: "#52713A")))
      stem.fill(pumpkinLeaf, with: .color(Color(hex: "#6C9348")))
      stem.stroke(pumpkinVein, with: .color(Color(hex: "#A9C56C")), style: stroke(1.7))
    } else if family == "bunny" || family == "rudolph" {
      for direction in [-1.0, 1] {
        let p = AvatarMotion.project(direction * (family == "bunny" ? 15 : 27), yaw: yaw, radius: 44)
        var ear = layer
        ear.translateBy(x: 50 + p.x, y: family == "bunny" ? 0 : 8)
        ear.scaleBy(x: depth * (family == "bunny" ? -direction : direction), y: 1)
        if family == "bunny" {
          ear.fill(bunnyEar, with: .color(Color(hex: color)))
          ear.fill(bunnyEarInner, with: .color(Color(hex: "#EDA6AF")))
        } else {
          ear.stroke(antler, with: .color(Color(hex: "#66452D")), style: stroke(4.5))
          ear.fill(rudolphEar, with: .color(Color(hex: color)))
          ear.fill(rudolphEarInner, with: .color(Color(hex: AvatarMotion.tint(color, 0.45))))
        }
      }
    }
  }
  static func face(_ layer: GraphicsContext, family: String, color: String, ink: Color, mouth: Double, happy: Double) {
    func fill(_ path: Path, _ hex: String) { layer.fill(path, with: .color(Color(hex: hex))) }
    func line(_ path: Path, _ hex: String, _ width: Double) { layer.stroke(path, with: .color(Color(hex: hex)), style: stroke(width)) }
    if family == "pumpkin" {
      var ribs = layer
      ribs.opacity *= 0.5
      ribs.stroke(pumpkinRibs, with: .color(Color(hex: AvatarMotion.tint(color, -0.35))), style: stroke(2.5))
      let smile = SVGPath.parse("M32 71 Q50 \(78 + 6 * mouth) 68 71 L65 81 L57 81 L55 87 L45 87 L43 81 L35 81Z")
      layer.fill(smile, with: .color(ink))
      fill(pumpkinTeeth, color)
    } else if family == "santa" {
      fill(beard, "#FFF3DB")
      fill(ellipse(50, 63, 7, 5.5), AvatarMotion.tint(color, -0.08))
      fill(mustache, "#FFFDF7")
      line(SVGPath.parse("M43 80 Q50 \(80 + 5 * mouth) 57 80"), "#704737", 2.1)
    } else if family == "turkey" {
      fill(wattle, "#D95145")
      fill(beak, "#FFB548")
      line(SVGPath.parse("M46 69 Q50 \(70 + 2 * mouth) 54 69"), "#8D5930", 1.6)
    } else if family == "bunny" || family == "rudolph" {
      let bunny = family == "bunny"
      fill(ellipse(50, 75, bunny ? 21 : 20, bunny ? 13 : 16), "#FFF3DB")
      if bunny {
        fill(bunnyNose, "#D98291")
        line(whiskers, "#9F8F7A", 1.5)
        fill(teeth, "#FFFDF7")
        line(teeth, "#C5B5A0", 1)
        line(toothSeam, "#C5B5A0", 1)
      } else {
        fill(circle(50, 68, 7.5), "#E94F49")
        var shine = layer
        shine.opacity *= 0.75
        shine.fill(ellipse(47.5, 65.5, 2.7, 1.8), with: .color(Color(hex: "#FFF3DB")))
      }
      var normal = layer
      normal.opacity *= 1 - happy
      normal.stroke(SVGPath.parse("M50 73 V77 M42.5 77 Q46.25 \(77 + 4 * mouth) 50 77 Q53.75 \(77 + 4 * mouth) 57.5 77"), with: .color(Color(hex: "#66452D")), style: stroke(1.8))
      if happy > 0.01 {
        var smile = layer
        smile.opacity *= happy
        smile.fill(happyMouth, with: .color(Color(hex: "#66452D")))
      }
    }
  }
  static func front(_ layer: GraphicsContext, family: String, yaw: Double) {
    var context = layer
    if family == "santa" {
      context.translateBy(x: 50, y: 0)
      context.scaleBy(x: max(abs(cos(yaw)), 0.3), y: 1)
      context.translateBy(x: -50, y: 0)
      context.fill(santaCap, with: .color(Color(hex: "#D34434")))
      context.fill(capTrim, with: .color(Color(hex: "#FFF3DB")))
      context.fill(circle(86, 27, 8), with: .color(Color(hex: "#FFFDF7")))
    } else if family == "bunny" {
      context.translateBy(x: AvatarMotion.project(0, yaw: yaw).x * 0.7, y: 0)
      context.fill(bow, with: .color(Color(hex: "#A888CD")))
      context.fill(circle(50, 93, 4), with: .color(Color(hex: "#CBB2E5")))
    }
  }
}
