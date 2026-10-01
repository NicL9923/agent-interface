import SwiftUI

extension Color {
  init(hex: String) {
    let (r, g, b) = AvatarMotion.rgb(hex) ?? (0x10, 0x84, 0xFE)
    self.init(red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255)
  }
  /// A color that follows the system light or dark appearance.
  static func adaptive(light: String, dark: String) -> Color {
    Color(
      uiColor: UIColor { traits in
        let (r, g, b) = AvatarMotion.rgb(traits.userInterfaceStyle == .dark ? dark : light) ?? (0, 0, 0)
        return UIColor(
          red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: 1)
      })
  }
}
/// The web client's design tokens (src/styles.css), light and dark.
enum Palette {
  static let accent = Color.adaptive(light: "#246F59", dark: "#8BD2B2")
  static let accentSoft = Color.adaptive(light: "#DCE9DF", dark: "#2A4435")
  static let attention = Color.adaptive(light: "#9B6733", dark: "#EBC188")
  static let danger = Color.adaptive(light: "#A33C32", dark: "#FAAFA0")
  static let muted = Color.adaptive(light: "#697268", dark: "#A6B4A7")
  static let line = Color.adaptive(light: "#D9DED2", dark: "#3A483D")
  static func surface(_ scheme: ColorScheme) -> Color {
    Color(hex: scheme == .dark ? "#1B211E" : "#FAF8F2")
  }
  static func raised(_ scheme: ColorScheme) -> Color {
    Color(hex: scheme == .dark ? "#222C25" : "#FFFDF7")
  }
  static func rail(_ scheme: ColorScheme) -> Color {
    Color(hex: scheme == .dark ? "#151C18" : "#EEEEE6")
  }
  static func user(_ scheme: ColorScheme) -> Color {
    Color(hex: scheme == .dark ? "#2A3A2E" : "#E7EEE4")
  }
}

/// Pure motion model for the avatar rig. It mirrors src/components/avatar-motion.ts number
/// for number. Time is seconds since the avatar entered its current state.
enum AvatarMotion {
  static let tau = Double.pi * 2
  static let celebration = 1.8
  static let workCycle = 3.8
  static let workSpin = 0.95
  /// Radius of the imaginary sphere the face is painted on, in body units.
  static let faceRadius = 42.0
  static let expressionTime = 0.09
  static let morphTime = 0.13
  static let shapeDuration = 0.28
  /// States whose meaning is "nothing is happening right now" never move.
  static let frozenStates: Set<ActivityState> = [.disconnected, .interrupted]

  static func clamp(_ value: Double, _ low: Double = 0, _ high: Double = 1) -> Double {
    min(max(value, low), high)
  }
  static func smoothstep(_ t: Double) -> Double {
    let x = clamp(t)
    return x * x * (3 - 2 * x)
  }
  static func easeInOut(_ t: Double) -> Double {
    let x = clamp(t)
    return x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2
  }
  static func easeOut(_ t: Double) -> Double { 1 - pow(1 - clamp(t), 3) }
  /// Deterministic noise so motion is varied but reproducible in tests.
  static func hash(_ n: Double) -> Double {
    let x = sin(n * 127.1 + 311.7) * 43758.5453
    return x - floor(x)
  }

  struct Pose: Equatable {
    var yaw = 0.0
    var lift = 0.0
    var shiftX = 0.0
    var roll = 0.0
    var scaleX = 1.0
    var scaleY = 1.0
    var gazeX = 0.0
    var gazeY = 0.0
    var blink = 1.0
    var trails = 0.0
    var sweep = 0.0
    var symbolTilt = 0.0
  }
  static let restingPose = Pose()

  /// Whether the drawing timeline can stop. Frozen states never tick; a failure
  /// ticks only while its entry shake and expression settle.
  static func timelinePaused(
    _ state: ActivityState, reduceMotion: Bool, visible: Bool, active: Bool, settling: Bool
  ) -> Bool {
    if reduceMotion || !visible || !active || frozenStates.contains(state) { return true }
    return state == .failed && !settling
  }

  static func blinkAt(_ t: Double) -> Double {
    let period = 4.6
    var openness = 1.0
    let base = floor(t / period)
    for k in [base - 1, base] {
      let at = k * period + 1.4 + hash(k) * 2.4
      for start in hash(k + 7) > 0.72 ? [at, at + 0.28] : [at] {
        let d = t - start
        if d >= 0 && d < 0.16 { openness = min(openness, 1 - sin(Double.pi * d / 0.16) * 0.92) }
      }
    }
    return openness
  }

  static func wander(_ t: Double, span: Double = 2.8) -> (x: Double, y: Double) {
    func target(_ segment: Double) -> (Double, Double) {
      hash(segment + 13) < 0.35 ? (0, 0) : (hash(segment) * 2 - 1, (hash(segment + 31) * 2 - 1) * 0.5)
    }
    let segment = floor(t / span)
    let blend = smoothstep((t - segment * span) / 0.24)
    let from = target(segment - 1)
    let to = target(segment)
    return (from.0 + (to.0 - from.0) * blend, from.1 + (to.1 - from.1) * blend)
  }

  /// A short damped "boop" that acknowledges every state change.
  static func arrival(_ t: Double) -> Double { 1 + 0.07 * exp(-t * 7) * sin(t * 24) }

  static func pose(_ state: ActivityState, _ t: Double, reduce: Bool) -> Pose {
    if reduce || frozenStates.contains(state) { return restingPose }
    let pop = arrival(t)
    var pose = Pose(scaleX: pop, scaleY: pop, blink: blinkAt(t))
    func breathe(_ rate: Double, _ depth: Double) -> Double {
      let b = sin(t * rate)
      pose.scaleY *= 1 + depth * b
      pose.scaleX *= 1 - depth * 0.6 * b
      return b
    }
    switch state {
    case .idle:
      let b = breathe(1.7, 0.012)
      let w = wander(t)
      pose.lift = -0.6 * b
      pose.roll = sin(t * 0.55) * 1.6
      pose.gazeX = w.x
      pose.gazeY = w.y
      pose.yaw = w.x * 0.16
    case .thinking:
      pose.gazeX = sin(t * 1.3) * 0.5
      pose.gazeY = -0.8
    case .working:
      let u = t.truncatingRemainder(dividingBy: workCycle)
      let scanEnd = workCycle - workSpin
      if u < scanEnd {
        let scan = sin(tau * u / scanEnd)
        pose.yaw = 0.6 * scan
        pose.gazeX = 0.5 * scan
        pose.lift = -abs(sin(t * 6.5)) * 1.6
        pose.roll = sin(t * 6.5) * 1.2
      } else {
        let s = (u - scanEnd) / workSpin
        pose.yaw = tau * easeInOut(s)
        pose.sweep = pose.yaw
        pose.trails = sin(Double.pi * s)
        pose.lift = -3 * sin(Double.pi * s)
        pose.blink = 1
      }
    case .waiting:
      let b = breathe(1.1, 0.018)
      pose.lift = 0.8 + 0.8 * b
      pose.roll = sin(t * 0.4) * 2.5
      pose.gazeX = sin(t * 0.35) * 0.4
      pose.gazeY = 0.6
    case .blocked:
      let w = t.truncatingRemainder(dividingBy: 2.6)
      pose.symbolTilt = w < 0.5 ? 9 * sin(w / 0.5 * tau * 2) * (1 - w / 0.5) : 0
    case .done:
      if t < celebration {
        let s = t / celebration
        pose.yaw = tau * 2 * easeOut(s)
        pose.sweep = pose.yaw
        pose.trails = s < 0.8 ? 1 : (1 - s) / 0.2
        pose.lift = -7 * abs(sin(Double.pi * s * 2)) * (1 - s * 0.4)
        pose.roll = 14 * sin(s * tau * 1.5) * (1 - s)
        pose.scaleY *= 1 - 0.06 * sin(tau * 2 * s) * (1 - s)
        pose.blink = 1
      } else {
        let b = breathe(1.5, 0.012)
        pose.lift = -0.5 * b
        pose.roll = sin(t * 0.7) * 2
      }
    case .failed:
      pose.shiftX = t < 0.45 ? 3 * sin(t * 42) * (1 - t / 0.45) : 0
      pose.lift = 1.5 * smoothstep(t / 0.3)
      pose.scaleY *= 1 - 0.03 * smoothstep(t / 0.3)
      pose.blink = 1
    case .disconnected, .interrupted: break
    }
    return pose
  }

  struct Expression: Equatable {
    /// Eye openness multiplier.
    var open: Double
    /// Degrees each eye leans toward the center; positive reads as worried.
    var tilt: Double
    /// 0 = normal eyes, 1 = closed happy arcs.
    var happy: Double
    /// Mascot mouth curve: -1 frown, 0 flat, 1 smile.
    var mouth: Double
  }
  static func expression(for state: ActivityState, at t: Double) -> Expression {
    switch state {
    case .working: Expression(open: 0.82, tilt: 0, happy: 0, mouth: 0.3)
    case .waiting: Expression(open: 0.36, tilt: 0, happy: 0, mouth: 0)
    case .blocked: Expression(open: 1.1, tilt: 0, happy: 0, mouth: -0.2)
    case .done:
      t < celebration * 0.75
        ? Expression(open: 1.1, tilt: 0, happy: 0, mouth: 1)
        : Expression(open: 1, tilt: 0, happy: 1, mouth: 1)
    case .failed: Expression(open: 0.62, tilt: 14, happy: 0, mouth: -1)
    case .disconnected: Expression(open: 0.7, tilt: 0, happy: 0, mouth: 0)
    case .interrupted: Expression(open: 0.5, tilt: 0, happy: 0, mouth: 0)
    case .idle, .thinking: Expression(open: 1, tilt: 0, happy: 0, mouth: 0.6)
    }
  }
  /// Frame-rate independent approach toward a target expression.
  static func approach(_ current: Expression, _ target: Expression, _ dt: Double) -> Expression {
    let k = 1 - exp(-dt / expressionTime)
    return Expression(
      open: current.open + (target.open - current.open) * k,
      tilt: current.tilt + (target.tilt - current.tilt) * k,
      happy: current.happy + (target.happy - current.happy) * k,
      mouth: current.mouth + (target.mouth - current.mouth) * k)
  }
  /// The closed form of repeatedly applying `approach` from `start` since the state change,
  /// including the done state's switch to happy eyes partway through its celebration.
  static func expression(from start: Expression, toward state: ActivityState, after t: Double)
    -> Expression
  {
    let flip = celebration * 0.75
    if state == .done && t > flip {
      let middle = approach(start, expression(for: .done, at: 0), flip)
      return approach(middle, expression(for: .done, at: flip), t - flip)
    }
    return approach(start, expression(for: state, at: t), t)
  }

  /// How far the body has turned into the thinking dots or the blocked exclamation.
  struct Morph: Equatable {
    var dots: Double
    var bang: Double
  }
  static func morphTarget(_ state: ActivityState) -> Morph {
    Morph(dots: state == .thinking ? 1 : 0, bang: state == .blocked ? 1 : 0)
  }
  static func morph(from start: Morph, toward state: ActivityState, after t: Double) -> Morph {
    let target = morphTarget(state)
    let k = exp(-t / morphTime)
    return Morph(
      dots: target.dots + (start.dots - target.dots) * k,
      bang: target.bang + (start.bang - target.bang) * k)
  }

  struct Projection: Equatable {
    var x: Double
    var scale: Double
    var visible: Bool
  }
  /// Projects a face feature `dx` units from the face center onto a sphere turned by `yaw`.
  /// Features on the far side report `visible: false`.
  static func project(_ dx: Double, yaw: Double, radius: Double = faceRadius) -> Projection {
    let angle = yaw + asin(clamp(dx / radius, -1, 1))
    let depth = cos(angle)
    return Projection(x: radius * sin(angle), scale: max(depth, 0.02), visible: depth > 0.02)
  }

  /// Splits a trail segment on a tilted orbit into the arcs behind and in front of the body,
  /// so trails wrap around the avatar instead of floating on top of it.
  static func orbitArcs(
    head: Double, length: Double, rx: Double, ry: Double, tilt: Double, cx: Double = 50,
    cy: Double = 52
  ) -> (back: [[CGPoint]], front: [[CGPoint]]) {
    let cosT = cos(tilt)
    let sinT = sin(tilt)
    var back: [[CGPoint]] = []
    var front: [[CGPoint]] = []
    var run: [CGPoint] = []
    var runFront: Bool?
    func flush() {
      if run.count > 1 {
        if runFront == true { front.append(run) } else { back.append(run) }
      }
      run = []
    }
    let steps = 16
    for i in 0...steps {
      let psi = head - length + length * Double(i) / Double(steps)
      let lx = rx * cos(psi)
      let ly = ry * sin(psi)
      let point = CGPoint(x: cx + lx * cosT - ly * sinT, y: cy + lx * sinT + ly * cosT)
      let isFront = sin(psi) >= 0
      if let current = runFront, current != isFront {
        let last = run.last
        flush()
        if let last { run.append(last) }
      }
      runFront = isFront
      run.append(point)
    }
    flush()
    return (back, front)
  }

  static func rgb(_ color: String) -> (Int, Int, Int)? {
    var hex = color.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
    if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
    guard hex.count == 6, let value = Int(hex, radix: 16) else { return nil }
    return ((value >> 16) & 255, (value >> 8) & 255, value & 255)
  }
  static func luminance(_ color: String) -> Double? {
    guard let value = rgb(color) else { return nil }
    let (r, g, b) = value
    func channel(_ value: Int) -> Double {
      let c = Double(value) / 255
      return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }
  static func contrast(_ a: Double, _ b: Double) -> Double { (max(a, b) + 0.05) / (min(a, b) + 0.05) }
  /// Readable eye color for any body color, including custom picks. Each style keeps its
  /// signature ink (cream cutouts, dark mascot eyes) while it holds at least 2:1; otherwise
  /// the stronger ink wins. Every palette color keeps its signature ink.
  static func faceInk(_ color: String, mascot: Bool = false) -> String {
    let light = mascot ? "#fff3db" : "#fff9ee"
    let dark = "#2b201b"
    let preferred = mascot ? dark : light
    let other = mascot ? light : dark
    guard let body = luminance(color) else { return preferred }
    func score(_ ink: String) -> Double { contrast(body, luminance(ink) ?? 0) }
    return score(preferred) >= 2 || score(preferred) >= score(other) ? preferred : other
  }
  /// Mixes a hex color toward white (positive) or black (negative).
  static func tint(_ color: String, _ amount: Double) -> String {
    let hex = color.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
    guard hex.count == 6, let value = rgb(hex) else { return color }
    let (r, g, b) = value
    let target = amount > 0 ? 255.0 : 0
    func mix(_ c: Int) -> String {
      String(format: "%02x", Int((Double(c) + (target - Double(c)) * abs(amount)).rounded()))
    }
    return "#\(mix(r))\(mix(g))\(mix(b))"
  }

  /// Everything captured at a state change. Later frames are closed-form functions of this.
  struct Snapshot: Equatable {
    var state: ActivityState
    var since: Date
    var expression: Expression
    var morph: Morph
    /// Residual trails from the previous state keep sweeping while this one settles in.
    var carry = 0.0
    var carrySweep = 0.0
    static func entering(_ state: ActivityState, at date: Date) -> Snapshot {
      Snapshot(
        state: state, since: date, expression: AvatarMotion.expression(for: state, at: 0),
        morph: AvatarMotion.morphTarget(state))
    }
  }
  struct Frame {
    var t: Double
    var pose: Pose
    var expression: Expression
    var morph: Morph
    var trailLevel: Double
    var sweep: Double
  }
  static func frame(_ snapshot: Snapshot, at date: Date, still: Bool) -> Frame {
    let state = snapshot.state
    if still {
      return Frame(
        t: 0, pose: restingPose, expression: expression(for: state, at: .infinity),
        morph: morphTarget(state), trailLevel: 0, sweep: 0)
    }
    let t = max(0, date.timeIntervalSince(snapshot.since))
    let pose = self.pose(state, t, reduce: false)
    let carry = snapshot.carry * (1 - smoothstep(t / 0.6))
    return Frame(
      t: t, pose: pose, expression: expression(from: snapshot.expression, toward: state, after: t),
      morph: morph(from: snapshot.morph, toward: state, after: t),
      trailLevel: max(pose.trails, carry),
      sweep: pose.trails >= carry ? pose.sweep : snapshot.carrySweep + t * 7)
  }
  static func next(_ snapshot: Snapshot, to state: ActivityState, at date: Date, still: Bool)
    -> Snapshot
  {
    let current = frame(snapshot, at: date, still: still)
    return Snapshot(
      state: state, since: date, expression: current.expression, morph: current.morph,
      carry: current.trailLevel, carrySweep: current.sweep)
  }
}

/// A minimal absolute SVG path reader (M L H V Q C Z) so artwork matches the web strings.
enum SVGPath {
  private enum Token {
    case command(Character)
    case number(Double)
  }
  static func parse(_ d: String) -> Path {
    var tokens: [Token] = []
    var number = ""
    func flush() {
      if let value = Double(number) { tokens.append(.number(value)) }
      number = ""
    }
    for character in d {
      if character.isLetter {
        flush()
        tokens.append(.command(character))
      } else if character == "-" {
        flush()
        number = "-"
      } else if character.isNumber || character == "." {
        number.append(character)
      } else {
        flush()
      }
    }
    flush()
    var path = Path()
    var index = 0
    var command: Character = "M"
    var current = CGPoint.zero
    func value() -> Double {
      guard index < tokens.count, case .number(let v) = tokens[index] else { return 0 }
      index += 1
      return v
    }
    func point() -> CGPoint {
      let x = value()
      return CGPoint(x: x, y: value())
    }
    while index < tokens.count {
      if case .command(let c) = tokens[index] {
        command = c
        index += 1
        if c == "Z" || c == "z" { path.closeSubpath() }
        continue
      }
      switch command {
      case "M":
        current = point()
        path.move(to: current)
        command = "L"
      case "L":
        current = point()
        path.addLine(to: current)
      case "H":
        current.x = value()
        path.addLine(to: current)
      case "V":
        current.y = value()
        path.addLine(to: current)
      case "Q":
        let control = point()
        current = point()
        path.addQuadCurve(to: current, control: control)
      case "C":
        let c1 = point()
        let c2 = point()
        current = point()
        path.addCurve(to: current, control1: c1, control2: c2)
      default: index += 1
      }
    }
    return path
  }
}

struct PointVector: Equatable {
  var values: [Double]
  var magnitudeSquared: Double { values.reduce(0) { $0 + $1 * $1 } }
  func mixed(with other: PointVector, _ amount: Double) -> PointVector {
    PointVector(values: zip(values, other.values).map { $0 + ($1 - $0) * amount })
  }
  var polygon: Path {
    var p = Path()
    for i in stride(from: 0, to: values.count, by: 2) {
      let point = CGPoint(x: values[i], y: values[i + 1])
      if i == 0 { p.move(to: point) } else { p.addLine(to: point) }
    }
    p.closeSubpath()
    return p
  }
}

/// The web avatar's original silhouettes, sampled into 72 equal perimeter positions so every
/// shape can morph into any other without a discontinuous path replacement.
enum AvatarGeometry {
  static let mascotHead =
    "M50 14 C77 14 95 32 95 56 C95 81 76 95 50 95 C24 95 5 81 5 56 C5 32 23 14 50 14Z"
  static func svg(_ shape: String) -> String {
    switch shape {
    case "mascot": mascotHead
    case "drop": "M50 7 C42 16 13 42 13 64 C13 87 29 95 50 95 C71 95 87 82 87 62 C87 39 61 17 50 7Z"
    case "triangle": "M43 12 Q50 0 57 12 L95 78 Q103 94 85 94 H15 Q-3 94 5 78Z"
    case "cloud":
      "M20 40 C15 15 46 7 58 25 C78 9 104 29 91 50 C109 71 90 99 68 89 C48 108 19 95 23 79 C-1 72 0 46 20 40Z"
    case "capsule":
      "M48 5 H52 C75 5 84 18 84 40 V61 C84 83 73 96 52 96 H48 C26 96 16 84 16 61 V40 C16 18 26 5 48 5Z"
    case "pebble": "M22 9 C48 -4 86 7 94 32 C105 60 90 90 69 96 C36 105 2 88 4 63 C1 38 7 21 22 9Z"
    case "squircle": "M25 5 H75 Q95 5 95 25 V75 Q95 95 75 95 H25 Q5 95 5 75 V25 Q5 5 25 5Z"
    case "hex":
      "M28 8 Q32 5 37 5 H64 Q70 5 73 10 L95 43 Q99 50 95 57 L73 90 Q70 95 64 95 H36 Q30 95 27 90 L5 57 Q1 50 5 43Z"
    // The web draws an SVG arc from the top, clockwise; four cubic quarters match it.
    case "circle":
      "M50 3 C75.96 3 97 24.04 97 50 C97 75.96 75.96 97 50 97 C24.04 97 3 75.96 3 50 C3 24.04 24.04 3 50 3Z"
    default: "M50 3 C77 1 99 24 98 51 C100 77 79 99 51 98 C23 99 2 80 2 51 C2 25 21 3 50 3Z"
    }
  }
  static let paths = Dictionary(
    uniqueKeysWithValues: (AvatarConfig.shapes + ["mascot"]).map { ($0, SVGPath.parse(svg($0))) })
  static let cached = Dictionary(
    uniqueKeysWithValues: (AvatarConfig.shapes + ["mascot"]).map { ($0, points($0)) })
  static func path(_ shape: String) -> Path { paths[shape] ?? SVGPath.parse(svg(shape)) }
  static func sampled(_ shape: String) -> PointVector { cached[shape] ?? points(shape) }
  static func points(_ shape: String) -> PointVector {
    var all: [CGPoint] = []
    var current = CGPoint.zero
    var start = CGPoint.zero
    SVGPath.parse(svg(shape)).cgPath.applyWithBlock { elementPointer in
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
          let a = u * u * u
          let b = 3 * u * u * t
          let c = 3 * u * t * t
          let d = t * t * t
          all.append(
            CGPoint(
              x: a * from.x + b * c1.x + c * c2.x + d * end.x,
              y: a * from.y + b * c1.y + c * c2.y + d * end.y))
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
  /// Where each silhouette's face sits. Eyes follow the visual center of mass, so a triangle
  /// or drop looks out from its wide base instead of its point.
  struct Anchor {
    var cy: Double
    var scale: Double
    var top: Double
    var hat: Double
  }
  static let faces: [String: Anchor] = [
    "blob": Anchor(cy: 50, scale: 1, top: 3, hat: 1),
    "pebble": Anchor(cy: 50, scale: 1, top: 2, hat: 1),
    "squircle": Anchor(cy: 50, scale: 1, top: 5, hat: 1),
    "capsule": Anchor(cy: 47, scale: 0.9, top: 5, hat: 0.85),
    "triangle": Anchor(cy: 65, scale: 0.82, top: 3, hat: 0.6),
    "hex": Anchor(cy: 50, scale: 0.95, top: 5, hat: 0.95),
    "cloud": Anchor(cy: 55, scale: 0.95, top: 12, hat: 0.9),
    "drop": Anchor(cy: 63, scale: 0.9, top: 8, hat: 0.62),
    "circle": Anchor(cy: 50, scale: 1, top: 3, hat: 1),
    "mascot": Anchor(cy: 55, scale: 1, top: 15, hat: 0.82),
  ]
}

/// Static artwork from src/components/Avatar.tsx, parsed once.
private enum AvatarArt {
  /// Mouths change every frame, so they are built directly instead of parsed.
  static func sproutMouth(_ curve: Double) -> Path {
    var p = Path()
    p.move(to: CGPoint(x: 45, y: 70))
    p.addQuadCurve(to: CGPoint(x: 55, y: 70), control: CGPoint(x: 50, y: 70 + 6 * curve))
    return p
  }
  static func muzzleMouth(_ y: Double) -> Path {
    var p = Path()
    p.move(to: CGPoint(x: 50, y: 70.5))
    p.addLine(to: CGPoint(x: 50, y: 73))
    p.move(to: CGPoint(x: 43.5, y: 73))
    p.addQuadCurve(to: CGPoint(x: 50, y: 73), control: CGPoint(x: 46.75, y: y))
    p.addQuadCurve(to: CGPoint(x: 56.5, y: 73), control: CGPoint(x: 53.25, y: y))
    return p
  }
  static let foxEar = SVGPath.parse("M-19 42 L-14 5 Q-12 -1 -7.5 3 L14 23Z")
  static let foxEarInner = SVGPath.parse("M-13 31 L-10.5 11 L3 23Z")
  static let foxMuzzle = SVGPath.parse(
    "M50 60 C43 67 24 65 10 70 C16 86 33 96 50 96 C67 96 84 86 90 70 C76 65 57 67 50 60Z")
  static let nose = SVGPath.parse("M45.5 66 Q50 63 54.5 66 Q53 70.5 50 71 Q47 70.5 45.5 66Z")
  static let happyMouth = SVGPath.parse("M44 73 Q50 83 56 73 Q50 75.5 44 73Z")
  static let happySproutMouth = SVGPath.parse("M44 69 Q50 79 56 69 Q50 71.5 44 69Z")
  static let stem = SVGPath.parse("M50 18 Q48.5 10 51 3")
  static let leafLeft = SVGPath.parse("M50 10 C41 -1 27 1 24 7 C33 14 44 15 50 10Z")
  static let leafRight = SVGPath.parse("M51 7 C58 -4 73 -4 77 2 C69 9 58 11 51 7Z")
  static let veins = SVGPath.parse("M47 9.5 Q37 6 29 7 M54 6.5 Q63 2.5 72 2.5")
  static let hatCrown = SVGPath.parse("M-20 -2 Q-21 -20 -10 -21 Q0 -16 10 -21 Q21 -20 20 -2Z")
  static let hatBand = SVGPath.parse("M-20.3 -7 Q0 -3 20.3 -7 L20 -2 Q0 2 -20 -2Z")
  static let hatBrim = SVGPath.parse(
    "M-37 -4 Q-34 5 0 5 Q34 5 37 -4 Q38 -8 33 -6 Q0 2 -33 -6 Q-38 -8 -37 -4Z")
  static let bang = SVGPath.parse("M42.5 21 Q50 12 57.5 21 L54.5 61 Q50 68 45.5 61Z")
  static let spark = SVGPath.parse(
    "M0 -10 L3.2 -3.2 L10 0 L3.2 3.2 L0 10 L-3.2 3.2 L-10 0 L-3.2 -3.2Z")
  static let happyEye = SVGPath.parse("M-7 3 Q0 -8 7 3")
  static let trailColors = ["#ff729d", "#85bcfb", "#b790fc", "#92d899"].map { Color(hex: $0) }
  static let trailOrbits: [(Double, Double, Double)] = [
    (58, 13, -0.24), (56, 16, 0.16), (60, 11, 0.38), (54, 18, -0.48),
  ]
  static func circle(_ x: Double, _ y: Double, _ r: Double) -> Path {
    Path(ellipseIn: CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2))
  }
  static func ellipse(_ x: Double, _ y: Double, _ rx: Double, _ ry: Double) -> Path {
    Path(ellipseIn: CGRect(x: x - rx, y: y - ry, width: rx * 2, height: ry * 2))
  }
}

/// Draws one frame of a drawn (geometric or mascot) avatar in the web's 116-unit viewBox.
struct AvatarArtwork {
  var avatar: AvatarConfig
  var state: ActivityState
  var frame: AvatarMotion.Frame
  var still: Bool
  var body: Path
  var bodyColor: Color

  func draw(_ root: GraphicsContext) {
    let pose = frame.pose
    let face = frame.expression
    let dots = frame.morph.dots
    let bang = frame.morph.bang
    let symbolic = max(dots, bang)
    let mascot = avatar.mode == "mascot"
    let family = avatar.family ?? "sprout"
    let colorHex = avatar.color ?? "#1084FE"
    let color = Color(hex: colorHex)
    let eyes = avatar.eyes ?? "oval"
    let accessory = avatar.accessory ?? "none"
    let geometry = avatar.mode == "geometric" ? avatar.shape ?? "blob" : "mascot"
    let anchor = AvatarGeometry.faces[geometry] ?? AvatarGeometry.faces["blob"]!
    let inkHex = AvatarMotion.faceInk(colorHex, mascot: mascot)
    let ink = Color(hex: inkHex)
    let eyeScale = anchor.scale
    let eyeWidth = avatar.eyeWidth ?? 1
    let eyeHeight = avatar.eyeHeight ?? 1
    let eyeSpacing = avatar.eyeSpacing ?? 1
    let eyeY = anchor.cy + pose.gazeY * 3 + (state == .waiting ? 2 : 0)
    let eyeOffset = (mascot ? 17 : 15) * eyeSpacing * eyeScale
    let center = AvatarMotion.project(pose.gazeX * 2, yaw: pose.yaw)
    let open = max(face.open * pose.blink * eyeHeight * eyeScale, 0.04)
    let round = StrokeStyle(lineWidth: 1, lineCap: .round, lineJoin: .round)
    func stroke(_ width: Double) -> StrokeStyle {
      var style = round
      style.lineWidth = width
      return style
    }

    let bodyOpacity = 1 - AvatarMotion.smoothstep(symbolic)
    if bodyOpacity > 0.001 {
      var group = root
      group.opacity = bodyOpacity
      group.translateBy(x: pose.shiftX, y: pose.lift)
      group.translateBy(x: 50, y: 60)
      group.rotate(by: .degrees(pose.roll))
      group.translateBy(x: -50, y: -60)
      group.translateBy(x: 50, y: 94)
      group.scaleBy(x: pose.scaleX * (1 - 0.3 * bang), y: pose.scaleY)
      group.translateBy(x: -50, y: -94)
      let bodyScale = 1 - 0.45 * symbolic
      group.translateBy(x: 50, y: 50)
      group.scaleBy(x: bodyScale, y: bodyScale)
      group.translateBy(x: -50, y: -50)
      group.drawLayer { layer in
        let arcs =
          frame.trailLevel > 0.01
          ? AvatarArt.trailOrbits.enumerated().map { i, orbit in
            AvatarMotion.orbitArcs(
              head: -frame.sweep - Double(i) * 0.9, length: 1.5, rx: orbit.0, ry: orbit.1,
              tilt: orbit.2)
          } : []
        func trails(front: Bool) {
          guard !arcs.isEmpty else { return }
          var trail = layer
          trail.opacity = frame.trailLevel * 0.9
          trail.drawLayer { context in
            for (i, arc) in arcs.enumerated() {
              for run in front ? arc.front : arc.back {
                var path = Path()
                path.addLines(run)
                context.stroke(path, with: .color(AvatarArt.trailColors[i]), style: stroke(3))
              }
            }
          }
        }
        trails(front: false)
        if mascot && family != "sprout" {
          let inner = Color(
            hex: AvatarMotion.tint(colorHex, family == "fox" ? -0.35 : 0.45))
          for direction in [-1.0, 1.0] {
            let p = AvatarMotion.project(direction * 31, yaw: pose.yaw, radius: 44)
            var ear = layer
            ear.translateBy(x: 50 + p.x, y: 0)
            ear.scaleBy(x: max(abs(cos(pose.yaw)), 0.35) * (direction < 0 ? 1 : -1), y: 1)
            if family == "bear" {
              ear.fill(AvatarArt.circle(0, 24, 15), with: .color(color))
              ear.fill(AvatarArt.circle(0, 25, 8), with: .color(inner))
            } else {
              ear.fill(AvatarArt.foxEar, with: .color(color))
              ear.fill(AvatarArt.foxEarInner, with: .color(inner))
            }
          }
        }
        if mascot && family == "sprout" {
          var sprout = layer
          sprout.translateBy(x: AvatarMotion.project(0, yaw: pose.yaw).x * 0.3, y: 0)
          sprout.stroke(AvatarArt.stem, with: .color(Color(hex: "#3f7f55")), style: stroke(3))
          sprout.fill(AvatarArt.leafLeft, with: .color(Color(hex: "#4f9d69")))
          sprout.fill(AvatarArt.leafRight, with: .color(Color(hex: "#62b07a")))
          sprout.stroke(AvatarArt.veins, with: .color(Color(hex: "#a9d9b3")), style: stroke(1.2))
        }
        layer.fill(body, with: .color(bodyColor))

        var faceLayer = layer
        faceLayer.clip(to: body)
        let dark = Color(hex: "#2b201b")
        if mascot && center.visible {
          var muzzle = faceLayer
          muzzle.translateBy(x: 50 + center.x, y: 0)
          muzzle.scaleBy(x: center.scale, y: 1)
          muzzle.translateBy(x: -50, y: 0)
          let cream = Color(hex: "#fff3db")
          if family == "bear" { muzzle.fill(AvatarArt.ellipse(50, 71, 18, 13), with: .color(cream)) }
          if family == "fox" { muzzle.fill(AvatarArt.foxMuzzle, with: .color(cream)) }
          if family != "sprout" { muzzle.fill(AvatarArt.nose, with: .color(dark)) }
          var mouth = muzzle
          mouth.opacity = 1 - face.happy
          if family == "sprout" {
            mouth.stroke(AvatarArt.sproutMouth(face.mouth), with: .color(ink), style: stroke(2.4))
          } else {
            let curve = 73 + 4 * face.mouth
            mouth.stroke(AvatarArt.muzzleMouth(curve), with: .color(dark), style: stroke(2))
          }
          if face.happy > 0.01 {
            var smile = muzzle
            smile.opacity = face.happy
            smile.fill(
              family == "sprout" ? AvatarArt.happySproutMouth : AvatarArt.happyMouth,
              with: .color(dark))
          }
        }
        if mascot {
          for direction in [-1.0, 1.0] {
            let p = AvatarMotion.project(direction * 27, yaw: pose.yaw)
            guard p.visible else { continue }
            var cheek = faceLayer
            cheek.opacity = 0.42
            cheek.fill(
              AvatarArt.ellipse(50 + p.x, anchor.cy + 12, 6 * p.scale, 3.8),
              with: .color(Color(hex: "#ff7a8a")))
          }
        }
        for direction in [-1.0, 1.0] {
          let p = AvatarMotion.project(direction * eyeOffset + pose.gazeX * 4, yaw: pose.yaw)
          guard p.visible else { continue }
          let side = -direction
          var eye = faceLayer
          eye.translateBy(x: 50 + p.x, y: eyeY)
          if face.happy < 0.999 {
            var shape = eye
            shape.opacity = 1 - face.happy
            shape.scaleBy(
              x: p.scale * eyeWidth * eyeScale * (1 + (1 - min(face.open, 1)) * 0.4), y: open)
            if mascot && (eyes == "oval" || eyes == "round") {
              shape.fill(
                AvatarArt.ellipse(0, 0, eyes == "oval" ? 6.5 : 7.5, eyes == "oval" ? 8.5 : 7.5),
                with: .color(ink))
              if inkHex != "#fff3db" {
                shape.fill(AvatarArt.circle(-2 * side, -3.6, 2.5), with: .color(.white))
                var glint = shape
                glint.opacity *= 0.8
                glint.fill(AvatarArt.circle(2.4 * side, 2.8, 1.1), with: .color(.white))
              }
            } else if eyes == "spark" {
              shape.fill(AvatarArt.spark, with: .color(ink))
            } else if eyes == "visor" {
              shape.fill(
                Path(
                  roundedRect: CGRect(x: -10, y: -4.5, width: 20, height: 9), cornerRadius: 4.5,
                  style: .circular), with: .color(ink))
            } else if eyes == "round" {
              shape.fill(AvatarArt.circle(0, 0, 7.5), with: .color(ink))
            } else {
              shape.rotate(by: .degrees(face.tilt * side))
              shape.fill(
                Path(
                  roundedRect: CGRect(x: -5.5, y: -12.5, width: 11, height: 25), cornerRadius: 5.5,
                  style: .circular), with: .color(ink))
            }
          }
          if face.happy > 0.01 {
            var arc = eye
            arc.opacity = face.happy
            arc.scaleBy(x: p.scale * eyeWidth * eyeScale, y: eyeScale)
            arc.stroke(AvatarArt.happyEye, with: .color(ink), style: stroke(4.5))
          }
          if accessory == "glasses" {
            eye.stroke(
              AvatarArt.ellipse(0, 0, 12.5 * eyeScale * p.scale, 12.5 * eyeScale),
              with: .color(ink), lineWidth: 2.5)
          }
        }
        if accessory == "glasses" && center.visible {
          var bridge = Path()
          bridge.move(to: CGPoint(x: 50 + center.x - 4 * center.scale, y: eyeY - 2))
          bridge.addQuadCurve(
            to: CGPoint(x: 50 + center.x + 4 * center.scale, y: eyeY - 2),
            control: CGPoint(x: 50 + center.x, y: eyeY - 5))
          faceLayer.stroke(bridge, with: .color(ink), style: stroke(2.5))
        }
        if accessory == "hat" {
          var hat = layer
          hat.translateBy(x: 50, y: anchor.top + 15 * anchor.hat)
          hat.scaleBy(x: anchor.hat, y: anchor.hat)
          hat.fill(AvatarArt.hatCrown, with: .color(Color(hex: "#3a2f28")))
          hat.fill(AvatarArt.hatBand, with: .color(Color(hex: "#b48156")))
          hat.fill(AvatarArt.hatBrim, with: .color(Color(hex: "#302925")))
        }
        trails(front: true)
      }
    }
    if bang > 0.01 {
      var symbol = root
      symbol.opacity = AvatarMotion.smoothstep(bang)
      symbol.translateBy(x: 50, y: 80)
      symbol.rotate(by: .degrees(pose.symbolTilt))
      symbol.translateBy(x: 0, y: -30)
      symbol.scaleBy(x: 0.4 + 0.6 * bang, y: 0.4 + 0.6 * bang)
      symbol.translateBy(x: -50, y: -50)
      symbol.drawLayer { context in
        context.fill(AvatarArt.bang, with: .color(color))
        context.fill(AvatarArt.circle(50, 79, 7.5), with: .color(color))
      }
    }
    if dots > 0.01 {
      for i in 0..<3 {
        let offset = Double(i - 1)
        let wave = still ? 0.5 : max(0, sin(frame.t * 4.2 - Double(i) * 0.9))
        var dot = root
        dot.opacity =
          AvatarMotion.smoothstep(dots) * (still ? 1 - Double(i) * 0.25 : 0.5 + 0.5 * wave)
        dot.fill(
          AvatarArt.circle(50 + offset * 25 * dots, 50 - wave * 7 * dots, 8.5 * dots.squareRoot()),
          with: .color(color))
      }
    }
  }
}

struct AvatarView: View {
  var avatar: AvatarConfig
  var state: ActivityState
  var size: CGFloat
  var name: String
  var forceReducedMotion: Bool
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.colorScheme) private var scheme
  @State private var snapshot: AvatarMotion.Snapshot
  @State private var morphFrom: PointVector?
  @State private var morphAt = Date.distantPast
  @State private var colorFrom: String?
  @State private var colorAt = Date.distantPast
  @State private var visible = true
  @State private var settling = true
  @State private var changes = 0

  init(
    avatar: AvatarConfig = AvatarConfig(), state: ActivityState = .idle, size: CGFloat = 48,
    name: String = "Assistant", forceReducedMotion: Bool = false
  ) {
    self.avatar = avatar
    self.state = state
    self.size = size
    self.name = name
    self.forceReducedMotion = forceReducedMotion
    _snapshot = State(initialValue: .entering(state, at: Date()))
  }

  private var reduceMotion: Bool { systemReduceMotion || forceReducedMotion }
  private var portrait: Bool { avatar.mode == "portrait" }
  private var geometry: String { avatar.mode == "geometric" ? avatar.shape ?? "blob" : "mascot" }
  private var colorHex: String { avatar.color ?? "#1084FE" }
  private var frozen: Bool { AvatarMotion.frozenStates.contains(state) }
  private func still(_ state: ActivityState) -> Bool {
    reduceMotion || !visible || portrait || AvatarMotion.frozenStates.contains(state)
  }
  private var showsBadge: Bool {
    portrait
      ? ![.idle, .thinking, .working].contains(state)
      : [.done, .failed, .disconnected, .interrupted].contains(state)
  }

  var body: some View {
    ZStack(alignment: .bottomTrailing) {
      if portrait { portraitView } else { drawing }
      if showsBadge {
        // Frozen states arrive without the pop, matching their stillness.
        badge.id(state).transition(
          reduceMotion || frozen ? .identity : .scale(scale: 0.3).combined(with: .opacity))
      }
    }
    .frame(width: size, height: size)
    .animation(
      reduceMotion ? nil : .spring(response: 0.36, dampingFraction: 0.55), value: state)
    .saturation(frozen ? 0.25 : 1).opacity(frozen ? 0.88 : 1)
    .accessibilityElement(children: .ignore).accessibilityAddTraits(.isImage)
    .accessibilityLabel("\(name): \(state.label)")
    .onAppear { visible = true }
    .onDisappear { visible = false }
    .onChange(of: state) { old, new in
      let now = Date()
      snapshot = AvatarMotion.next(snapshot, to: new, at: now, still: still(old))
      changes += 1
    }
    .onChange(of: geometry) { old, _ in
      let now = Date()
      morphFrom = reduceMotion ? nil : bodyPoints(at: now, previous: old)
      morphAt = now
      changes += 1
    }
    .onChange(of: colorHex) { old, _ in
      colorFrom = reduceMotion ? nil : old
      colorAt = Date()
      changes += 1
    }
    .task(id: changes) {
      // Entry gestures, shape morphs, and expression smoothing finish within a second.
      settling = true
      try? await Task.sleep(for: .seconds(1))
      if !Task.isCancelled { settling = false }
    }
  }

  private var drawing: some View {
    let paused = AvatarMotion.timelinePaused(
      state, reduceMotion: reduceMotion, visible: visible, active: scenePhase == .active,
      settling: settling)
    return TimelineView(
      .animation(minimumInterval: size >= 56 ? 1 / 60 : 1 / 30, paused: paused)
    ) { timeline in
      let date = paused ? Date() : timeline.date
      let artwork = AvatarArtwork(
        avatar: avatar, state: state,
        frame: AvatarMotion.frame(snapshot, at: date, still: still(state)),
        still: still(state), body: bodyPath(at: date), bodyColor: bodyColor(at: date))
      // Motion can reach past the 116-unit box (trails, hops), as the web SVG overflows.
      let pad = size * 0.2
      Canvas { context, _ in
        var ctx = context
        ctx.translateBy(x: pad, y: pad)
        ctx.scaleBy(x: size / 116, y: size / 116)
        ctx.translateBy(x: 8, y: 8)
        artwork.draw(ctx)
      }
      .frame(width: size + pad * 2, height: size + pad * 2).padding(-pad)
    }
  }

  private func morphProgress(_ date: Date) -> Double {
    AvatarMotion.smoothstep(date.timeIntervalSince(morphAt) / AvatarMotion.shapeDuration)
  }
  private func bodyPoints(at date: Date, previous: String) -> PointVector {
    let target = AvatarGeometry.sampled(previous)
    guard let morphFrom, morphProgress(date) < 1 else { return target }
    return morphFrom.mixed(with: target, morphProgress(date))
  }
  private func bodyPath(at date: Date) -> Path {
    guard let morphFrom, morphProgress(date) < 1 else { return AvatarGeometry.path(geometry) }
    return morphFrom.mixed(with: AvatarGeometry.sampled(geometry), morphProgress(date)).polygon
  }
  private func bodyColor(at date: Date) -> Color {
    let progress = AvatarMotion.smoothstep(
      date.timeIntervalSince(colorAt) / AvatarMotion.shapeDuration)
    guard let colorFrom, progress < 1, let a = AvatarMotion.rgb(colorFrom),
      let b = AvatarMotion.rgb(colorHex)
    else { return Color(hex: colorHex) }
    func mix(_ x: Int, _ y: Int) -> Double { (Double(x) + Double(y - x) * progress) / 255 }
    return Color(red: mix(a.0, b.0), green: mix(a.1, b.1), blue: mix(a.2, b.2))
  }

  // Portraits never animate the face, so a ring carries their activity.
  private var portraitView: some View {
    ZStack {
      Circle().fill(Palette.rail(scheme))
      if let src = avatar.src, !src.isEmpty {
        AuthenticatedImage(path: src).scaledToFill().frame(width: size, height: size)
          .clipShape(Circle())
      } else {
        PortraitPlaceholder().clipShape(Circle())
      }
    }.frame(width: size, height: size)
      .overlay { ring.frame(width: size + 8, height: size + 8).allowsHitTesting(false) }
  }
  @ViewBuilder private var ring: some View {
    let width = 2.5
    switch state {
    case .working, .thinking:
      let spinning = !reduceMotion
      TimelineView(
        .animation(minimumInterval: 1 / 30, paused: !spinning || !visible || scenePhase != .active)
      ) { timeline in
        let period = state == .working ? 1.1 : 2.6
        let turn =
          spinning
          ? timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period)
            / period : 0
        ZStack {
          if state == .working {
            Circle().inset(by: width / 2).trim(from: 0, to: 0.32)
              .stroke(Palette.accent, lineWidth: width)
          } else {
            ForEach(0..<3) { i in
              Circle().inset(by: width / 2).trim(from: Double(i) / 3, to: Double(i) / 3 + 22 / 360)
                .stroke(Palette.accent, lineWidth: width)
            }
          }
        }.rotationEffect(.degrees(turn * 360 - 90))
      }
    case .waiting: Circle().strokeBorder(Palette.line, lineWidth: width)
    case .blocked: Circle().strokeBorder(Palette.attention, lineWidth: width)
    case .done: Circle().strokeBorder(Palette.accent, lineWidth: width)
    case .failed: Circle().strokeBorder(Palette.danger, lineWidth: width)
    case .idle, .disconnected, .interrupted: EmptyView()
    }
  }

  private var badge: some View {
    let diameter = min(max(15, size * 0.34), 26)
    let surface = Palette.surface(scheme)
    return Image(systemName: badgeSymbol)
      .font(.system(size: diameter * 0.52, weight: .heavy))
      .foregroundStyle(surface)
      .frame(width: diameter, height: diameter)
      .background(badgeColor, in: Circle())
      .background(Circle().fill(surface).padding(-2))
      .offset(x: 2, y: 2)
      .accessibilityHidden(true)
  }
  private var badgeSymbol: String {
    switch state {
    case .done: "checkmark"
    case .disconnected: "questionmark"
    case .interrupted, .waiting: "pause.fill"
    default: "exclamationmark"
    }
  }
  private var badgeColor: Color {
    switch state {
    case .done: Palette.accent
    case .failed: Palette.danger
    case .blocked: Palette.attention
    default: Palette.muted
    }
  }
}

/// A neutral head-and-shoulders mark for a portrait avatar that has no image yet.
private struct PortraitPlaceholder: View {
  var body: some View {
    Canvas { context, size in
      let s = min(size.width, size.height) / 80
      context.scaleBy(x: s, y: s)
      context.fill(
        Path(ellipseIn: CGRect(x: 25, y: 16, width: 30, height: 30)),
        with: .color(Palette.muted.opacity(0.55)))
      context.fill(
        SVGPath.parse("M12 80 C16 60 28 51 40 51 C52 51 64 60 68 80Z"),
        with: .color(Palette.muted.opacity(0.4)))
    }
  }
}
