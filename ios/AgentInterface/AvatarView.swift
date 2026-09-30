import SwiftUI

extension Color {
  init(hex: String) {
    let value =
      UInt64(hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) ?? 0x1084FE
    self.init(
      red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255,
      blue: Double(value & 255) / 255)
  }
}
enum Palette {
  static let accent = Color(
    uiColor: UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor(red: 0.545, green: 0.824, blue: 0.698, alpha: 1)
        : UIColor(red: 0.14, green: 0.44, blue: 0.35, alpha: 1)
    })
  static func surface(_ scheme: ColorScheme) -> Color {
    Color(hex: scheme == .dark ? "#1B211E" : "#FAF8F2")
  }
  static func raised(_ scheme: ColorScheme) -> Color {
    Color(hex: scheme == .dark ? "#222C25" : "#FFFDF7")
  }
  static func user(_ scheme: ColorScheme) -> Color {
    Color(hex: scheme == .dark ? "#2A3A2E" : "#E7EEE4")
  }
}

/// The same original silhouettes as the web avatar, sampled into equal perimeter
/// positions so every shape can morph without a discontinuous path replacement.
struct AvatarGeometry {
  static let cached = Dictionary(uniqueKeysWithValues: AvatarConfig.shapes.map { ($0, points($0)) })
  static func path(_ shape: String) -> CGPath {
    let p = CGMutablePath()
    func m(_ x: Double, _ y: Double) { p.move(to: CGPoint(x: x, y: y)) }
    func l(_ x: Double, _ y: Double) { p.addLine(to: CGPoint(x: x, y: y)) }
    func c(_ a: Double, _ b: Double, _ d: Double, _ e: Double, _ x: Double, _ y: Double) {
      p.addCurve(
        to: CGPoint(x: x, y: y), control1: CGPoint(x: a, y: b), control2: CGPoint(x: d, y: e))
    }
    func q(_ a: Double, _ b: Double, _ x: Double, _ y: Double) {
      p.addQuadCurve(to: CGPoint(x: x, y: y), control: CGPoint(x: a, y: b))
    }
    switch shape {
    case "drop":
      m(50, 7)
      c(42, 16, 13, 42, 13, 64)
      c(13, 87, 29, 95, 50, 95)
      c(71, 95, 87, 82, 87, 62)
      c(87, 39, 61, 17, 50, 7)
    case "triangle":
      m(43, 12)
      q(50, 0, 57, 12)
      l(95, 78)
      q(103, 94, 85, 94)
      l(15, 94)
      q(-3, 94, 5, 78)
    case "cloud":
      m(20, 40)
      c(15, 15, 46, 7, 58, 25)
      c(78, 9, 104, 29, 91, 50)
      c(109, 71, 90, 99, 68, 89)
      c(48, 108, 19, 95, 23, 79)
      c(-1, 72, 0, 46, 20, 40)
    case "capsule":
      m(48, 5)
      l(52, 5)
      c(75, 5, 84, 18, 84, 40)
      l(84, 61)
      c(84, 83, 73, 96, 52, 96)
      l(48, 96)
      c(26, 96, 16, 84, 16, 61)
      l(16, 40)
      c(16, 18, 26, 5, 48, 5)
    case "pebble":
      m(22, 9)
      c(48, -4, 86, 7, 94, 32)
      c(105, 60, 90, 90, 69, 96)
      c(36, 105, 2, 88, 4, 63)
      c(1, 38, 7, 21, 22, 9)
    case "squircle":
      m(25, 5)
      l(75, 5)
      q(95, 5, 95, 25)
      l(95, 75)
      q(95, 95, 75, 95)
      l(25, 95)
      q(5, 95, 5, 75)
      l(5, 25)
      q(5, 5, 25, 5)
    case "hex":
      m(28, 8)
      q(32, 5, 37, 5)
      l(64, 5)
      q(70, 5, 73, 10)
      l(95, 43)
      q(99, 50, 95, 57)
      l(73, 90)
      q(70, 95, 64, 95)
      l(36, 95)
      q(30, 95, 27, 90)
      l(5, 57)
      q(1, 50, 5, 43)
    case "circle": p.addEllipse(in: CGRect(x: 3, y: 3, width: 94, height: 94))
    default:
      m(50, 3)
      c(77, 1, 99, 24, 98, 51)
      c(100, 77, 79, 99, 51, 98)
      c(23, 99, 2, 80, 2, 51)
      c(2, 25, 21, 3, 50, 3)
    }
    p.closeSubpath()
    return p
  }
  static func points(_ shape: String) -> PointVector {
    var all: [CGPoint] = []
    var current = CGPoint.zero
    var start = CGPoint.zero
    path(shape).applyWithBlock { elementPointer in
      let element = elementPointer.pointee
      switch element.type {
      case .moveToPoint:
        current = element.points[0]
        start = current
        all.append(current)
      case .addLineToPoint:
        current = element.points[0]
        all.append(current)
      case .addQuadCurveToPoint:
        let from = current
        let control = element.points[0]
        let end = element.points[1]
        for i in 1...30 {
          let t = Double(i) / 30
          let u = 1 - t
          all.append(
            CGPoint(
              x: u * u * from.x + 2 * u * t * control.x + t * t * end.x,
              y: u * u * from.y + 2 * u * t * control.y + t * t * end.y))
        }
        current = end
      case .addCurveToPoint:
        let from = current
        let c1 = element.points[0]
        let c2 = element.points[1]
        let end = element.points[2]
        for i in 1...40 {
          let t = Double(i) / 40
          let u = 1 - t
          all.append(
            CGPoint(
              x: u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t
                * end.x,
              y: u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t
                * end.y))
        }
        current = end
      case .closeSubpath: all.append(start)
      @unknown default: break
      }
    }
    let lengths = zip(all, all.dropFirst()).map { hypot($1.x - $0.x, $1.y - $0.y) }
    let total = lengths.reduce(0, +)
    var values: [Double] = []
    for index in 0..<72 {
      let position = total * Double(index) / 72
      var sum = 0.0
      for segment in lengths.indices {
        if sum + lengths[segment] >= position || segment == lengths.count - 1 {
          let t = lengths[segment] == 0 ? 0 : (position - sum) / lengths[segment]
          let a = all[segment]
          let b = all[segment + 1]
          values.append(a.x + (b.x - a.x) * t)
          values.append(a.y + (b.y - a.y) * t)
          break
        }
        sum += lengths[segment]
      }
    }
    return PointVector(values: values)
  }
}
struct PointVector: VectorArithmetic {
  var values: [Double]
  static var zero: Self { Self(values: Array(repeating: 0, count: 144)) }
  static func + (lhs: Self, rhs: Self) -> Self { Self(values: zip(lhs.values, rhs.values).map(+)) }
  static func - (lhs: Self, rhs: Self) -> Self { Self(values: zip(lhs.values, rhs.values).map(-)) }
  mutating func scale(by rhs: Double) { values = values.map { $0 * rhs } }
  var magnitudeSquared: Double { values.reduce(0) { $0 + $1 * $1 } }
}
struct AvatarBody: Shape {
  var points: PointVector
  var animatableData: PointVector {
    get { points }
    set { points = newValue }
  }
  func path(in rect: CGRect) -> Path {
    var p = Path()
    for i in stride(from: 0, to: points.values.count, by: 2) {
      let point = CGPoint(
        x: (points.values[i] + 8) / 116 * rect.width,
        y: (points.values[i + 1] + 8) / 116 * rect.height)
      if i == 0 { p.move(to: point) } else { p.addLine(to: point) }
    }
    p.closeSubpath()
    return p
  }
}
struct AvatarView: View {
  var avatar = AvatarConfig()
  var state: ActivityState = .idle
  var size: CGFloat = 48
  var name = "Assistant"
  var forceReducedMotion = false
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  private var reduceMotion: Bool { systemReduceMotion || forceReducedMotion }
  @Environment(\.scenePhase) private var scenePhase
  @State private var started = Date()
  @State private var points = AvatarGeometry.points("blob")
  @State private var settleUntil = Date.distantPast
  @State private var visible = true
  var body: some View {
    TimelineView(
      .animation(
        minimumInterval: 1 / 30,
        paused: reduceMotion || !visible || scenePhase != .active || !state.animates
          || avatar.mode == "portrait")
    ) { timeline in
      let phase = reduceMotion ? 0 : timeline.date.timeIntervalSince(started)
      ZStack(alignment: .bottomTrailing) {
        if avatar.mode == "portrait" {
          AuthenticatedImage(path: avatar.src ?? "").scaledToFill().frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.28))
        } else {
          illustration(phase: phase, now: timeline.date)
        }
        if avatar.mode == "portrait"
          || [.done, .failed, .interrupted, .disconnected].contains(state)
        {
          Image(systemName: stateSymbol).font(.system(size: max(10, size * 0.2), weight: .bold))
            .padding(3).background(.background, in: Circle()).accessibilityHidden(true)
        }
      }
    }
    .frame(width: size, height: size)
    .accessibilityElement(children: .ignore).accessibilityLabel("\(name): \(state.label)")
    .onAppear {
      visible = true
      points = AvatarGeometry.points(avatar.shape ?? "blob")
    }
    .onDisappear { visible = false }
    .onChange(of: avatar.shape) { _, shape in
      withAnimation(reduceMotion ? nil : .timingCurve(0.22, 1, 0.36, 1, duration: 0.28)) {
        points = AvatarGeometry.points(shape ?? "blob")
      }
    }
    .onChange(of: state) { old, new in
      started = Date()
      settleUntil =
        (old == .working || old == .done) && new == .waiting
        ? Date().addingTimeInterval(0.6) : .distantPast
    }
  }
  var stateSymbol: String {
    switch state {
    case .done: "checkmark"
    case .failed, .blocked: "exclamationmark"
    case .interrupted, .waiting: "pause.fill"
    case .disconnected: "questionmark"
    case .thinking: "ellipsis"
    case .working: "arrow.trianglehead.2.clockwise.rotate.90"
    case .idle: "circle.fill"
    }
  }
  private func illustration(phase: Double, now: Date) -> some View {
    let yaw =
      reduceMotion
      ? 0
      : state == .working
        ? phase * 3.9 : state == .done && phase < 2.5 ? phase * 8.5 : sin(phase * 0.7) * 0.15
    let lift =
      reduceMotion
      ? 0
      : state == .working
        ? sin(phase * 10) * 0.9
        : state == .done && phase < 2.5 ? -abs(sin(phase * 5)) * 6 : sin(phase * 0.8) * 0.4
    let roll =
      reduceMotion ? 0 : state == .done && phase < 2.5 ? sin(phase * 4) * 48 : sin(phase * 0.6) * 2
    let pitch =
      reduceMotion ? 1 : state == .done && phase < 2.5 ? 0.5 + 0.5 * abs(cos(phase * 5)) : 1
    let color = Color(hex: avatar.color ?? "#1084FE")
    return ZStack {
      ZStack {
        if avatar.mode == "mascot" { mascotEars(color: color) }
        AvatarBody(points: avatar.mode == "mascot" ? AvatarGeometry.cached["blob"]! : points).fill(
          color)
        if avatar.mode == "mascot" {
          Ellipse().fill(Color(hex: "#FFF3DB")).frame(width: size * 0.60, height: size * 0.43)
            .offset(y: size * 0.16)
          Text("ᴗ").font(.system(size: size * 0.25, weight: .medium)).foregroundStyle(
            Color(hex: "#402A24")
          ).offset(y: size * 0.16)
        }
        HStack(spacing: size * 0.17 * (avatar.eyeSpacing ?? 1)) {
          eye(phase: phase, first: true)
          eye(phase: phase, first: false)
        }.foregroundStyle(avatar.mode == "mascot" ? Color(hex: "#332620") : Color(hex: "#FFF9EE"))
          .scaleEffect(x: max(abs(cos(yaw)), 0.03), y: 1)
          .offset(x: sin(yaw) * size * 38 / 116, y: state == .waiting ? size * 3 / 116 : 0)
          .opacity(cos(yaw) > 0 ? 1 : 0)
          .frame(width: size, height: size).mask(
            AvatarBody(points: avatar.mode == "mascot" ? AvatarGeometry.cached["blob"]! : points))
        if avatar.accessory == "hat" {
          HatShape().fill(Color(hex: "#302925")).frame(width: size * 0.65, height: size * 0.25)
            .offset(y: -size * 0.30)
        }
        if avatar.accessory == "glasses" {
          HStack(spacing: size * 0.04) {
            Circle().stroke(lineWidth: 2)
            Circle().stroke(lineWidth: 2)
          }.frame(width: size * 0.5, height: size * 0.22).offset(x: sin(yaw) * size * 38 / 116)
            .opacity(cos(yaw) > 0 ? 1 : 0)
        }
        if !reduceMotion
          && (state == .working || state == .done && phase < 2.5 || now < settleUntil)
        {
          ForEach(0..<4) { i in
            Ellipse().trim(from: 0.08, to: 0.27).stroke(
              Color(hex: ["#FF729D", "#85BCFB", "#B790FC", "#92D899"][i]),
              style: StrokeStyle(lineWidth: size * 0.025, lineCap: .round)
            ).frame(width: size * 0.98, height: size * 0.28).rotationEffect(
              .degrees(Double(i) * 47 + phase * 150)
            ).opacity(now < settleUntil ? max(0, settleUntil.timeIntervalSince(now) / 0.6) : 0.8)
          }
        }
      }.offset(y: lift * size / 116).rotationEffect(.degrees(roll)).scaleEffect(x: 1, y: pitch)
        .opacity(state == .thinking || state == .blocked ? 0 : 1)
      HStack(spacing: size * 0.1) {
        ForEach(0..<3) { i in
          Circle().fill(color).frame(width: size * 0.12, height: size * 0.12).scaleEffect(
            reduceMotion ? 1 : 1 + sin(phase * 5 - Double(i) * 1.6) * 0.2
          ).opacity(reduceMotion ? 0.65 : 0.55 + sin(phase * 5 - Double(i) * 1.6) * 0.4)
        }
      }.opacity(state == .thinking ? 1 : 0)
      VStack(spacing: size * 0.08) {
        Capsule().fill(color).frame(width: size * 0.11, height: size * 0.38)
        Circle().fill(color).frame(width: size * 0.10, height: size * 0.10)
      }.opacity(state == .blocked ? 1 : 0)
    }.animation(reduceMotion ? nil : .easeInOut(duration: 0.28), value: state)
      .animation(reduceMotion ? nil : .easeInOut(duration: 0.28), value: avatar)
  }
  @ViewBuilder private func eye(phase: Double, first: Bool) -> some View {
    let blink = reduceMotion || phase.truncatingRemainder(dividingBy: 5.7) < 5.48 ? 1.0 : 0.12
    let height =
      (state == .waiting ? 0.38 : state == .failed ? 0.52 : state == .done ? 0.65 : 1) * blink
      * (avatar.eyeHeight ?? 1)
    Group {
      switch avatar.eyes {
      case "round": Circle().frame(width: size * 0.12, height: size * 0.12)
      case "visor": Capsule().frame(width: size * 0.16, height: size * 0.07)
      case "spark": SparkShape().frame(width: size * 0.16, height: size * 0.16)
      default:
        Capsule().frame(width: size * 0.086, height: size * 0.19).rotationEffect(
          .degrees(state == .failed ? (first ? 25 : -25) : state == .waiting ? 8 : 0))
      }
    }.scaleEffect(x: avatar.eyeWidth ?? 1, y: height)
  }
  @ViewBuilder private func mascotEars(color: Color) -> some View {
    if avatar.family == "bear" {
      HStack(spacing: size * 0.27) {
        Circle().fill(color)
        Circle().fill(color)
      }.frame(width: size * 0.83, height: size * 0.3).offset(y: -size * 0.26)
    } else if avatar.family == "fox" {
      HStack(spacing: size * 0.31) {
        TriangleShape().fill(color)
        TriangleShape().fill(color)
      }.frame(width: size * 0.86, height: size * 0.4).offset(y: -size * 0.28)
    } else {
      HStack(spacing: 0) {
        Ellipse().fill(Color(hex: "#458D63")).rotationEffect(.degrees(30))
        Ellipse().fill(Color(hex: "#458D63")).rotationEffect(.degrees(-30))
      }.frame(width: size * 0.65, height: size * 0.18).offset(y: -size * 0.38)
    }
  }
}
struct TriangleShape: Shape {
  func path(in r: CGRect) -> Path {
    Path { p in
      p.move(to: CGPoint(x: r.midX, y: r.minY))
      p.addLine(to: CGPoint(x: r.maxX, y: r.maxY))
      p.addLine(to: CGPoint(x: r.minX, y: r.maxY))
      p.closeSubpath()
    }
  }
}
struct SparkShape: Shape {
  func path(in r: CGRect) -> Path {
    Path { p in
      for (i, v) in [
        [0.5, 0], [0.65, 0.35], [1, 0.5], [0.65, 0.65], [0.5, 1], [0.35, 0.65], [0, 0.5],
        [0.35, 0.35],
      ].enumerated() {
        let point = CGPoint(x: v[0] * r.width, y: v[1] * r.height)
        if i == 0 { p.move(to: point) } else { p.addLine(to: point) }
      }
      p.closeSubpath()
    }
  }
}
struct HatShape: Shape {
  func path(in r: CGRect) -> Path {
    Path { p in
      p.move(to: CGPoint(x: 0, y: r.height * 0.8))
      p.addQuadCurve(
        to: CGPoint(x: r.width, y: r.height * 0.8), control: CGPoint(x: r.midX, y: r.height * 1.3))
      p.addLine(to: CGPoint(x: r.width * 0.8, y: r.height * 0.5))
      p.addLine(to: CGPoint(x: r.width * 0.75, y: 0))
      p.addLine(to: CGPoint(x: r.midX, y: r.height * 0.2))
      p.addLine(to: CGPoint(x: r.width * 0.25, y: 0))
      p.addLine(to: CGPoint(x: r.width * 0.2, y: r.height * 0.5))
      p.closeSubpath()
    }
  }
}
