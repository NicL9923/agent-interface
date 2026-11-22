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
  static let onAccent = Color.adaptive(light: "#FFFDF7", dark: "#1B211E")
  static let accentSoft = Color.adaptive(light: "#DCE9DF", dark: "#2A4435")
  static let attention = Color.adaptive(light: "#9B6733", dark: "#EBC188")
  static let danger = Color.adaptive(light: "#A33C32", dark: "#FAAFA0")
  static let muted = Color.adaptive(light: "#697268", dark: "#A6B4A7")
  static let messageMetadata = Color.adaptive(light: "#5F685E", dark: "#A6B4A7")
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
  /// A reply bubble: the ink color at 7% over the surface, mixed in OKLab as the web's `color-mix`
  /// does (ink #282C27 over #FAF8F2, and #F1EFDF over #1B211E in dark).
  static let replyBubble = Color.adaptive(light: "#EAE8E2", dark: "#272D29")
  /// A bubble's edge with Increase Contrast on: at least 3:1 against the surface in both appearances.
  static let bubbleBorder = muted
  /// A block quote's text: at least 4.5:1 on the reply bubble's fill as well as on the surface, which
  /// `muted` misses in light (4.07:1 on #EAE8E2). ChatBubblesTests checks every color a bubble holds.
  static let quote = messageMetadata
  /// Secondary text inside a bubble, such as a file's size or a task's empty box. The system's secondary
  /// label reads at 3.2:1 on the bubble fills in light.
  static let bubbleSecondary = messageMetadata
}

/// A small tool the avatar holds while Hermes runs a recognizable kind of tool. It mirrors
/// `avatarProp` in src/components/avatar-motion.ts, including the order of the checks.
enum AvatarProp: String, CaseIterable, Equatable {
  case search, computer, read, write

  /// Name fragments per prop, checked in case order. Each list is the web's regex alternation.
  static let tools: [(AvatarProp, [String])] = [
    (.search, ["search", "find", "grep", "lookup", "fetch", "extract", "browse", "browser", "navigate", "crawl", "scrape", "vision"]),
    (.computer, ["terminal", "shell", "bash", "exec", "process", "code", "computer", "ssh", "command"]),
    (.read, ["read", "view", "skill", "open", "load", "list"]),
    (.write, ["write", "patch", "edit", "create", "save", "update", "note", "todo", "memory", "remind", "draft", "generate"]),
  ]
  /// Picks a prop from a Hermes tool name; unknown tools keep the plain working motion.
  static func from(tool: String?) -> AvatarProp? {
    guard let name = tool?.lowercased(), !name.isEmpty else { return nil }
    return tools.first { _, fragments in fragments.contains { name.contains($0) } }?.0
  }
  /// The prop for the most recent running tool call, as the web conversation chooses it.
  static func from(toolCalls: [ToolCall]?) -> AvatarProp? {
    from(tool: toolCalls?.last { $0.status == "running" }?.name)
  }
}

/// Pure motion model for the avatar rig. It mirrors src/components/avatar-motion.ts number
/// for number. Time is seconds since the avatar entered its current state. Which named gestures
/// play, and when, arrives as a `Plan` from `AvatarConductor`, which keeps any two bots from
/// playing the same one at once.
enum AvatarMotion {
  static let tau = Double.pi * 2
  static let celebration = 1.8
  /// One working loop at an even pace: a scan, then a spin.
  static let workCycle = 3.8
  static let workSpin = 0.95
  /// One sweep of the working scan, which is also the usual wait between spins.
  static let workScan = workCycle - workSpin
  /// Pondering between thinking beats, and the beat itself: an idea or a tumble.
  static let thinkPonder = 5.0
  static let thinkBeat = 1.4
  /// One thinking loop: ponder one way, glance the other, then a beat.
  static let thinkCycle = thinkPonder + thinkBeat
  /// The eyes glance toward the beat's side this long before the beat.
  static let glanceLead = 1.8
  /// Seconds between idle gestures, on average.
  static let idleGesture = 9.0
  static let idleGestureLength = 1.4
  /// Radius of the imaginary sphere the face is painted on, in body units.
  static let faceRadius = 42.0
  static let expressionTime = 0.09
  static let morphTime = 0.13
  static let shapeDuration = 0.28
  /// States whose meaning is "nothing is happening right now" never move. An unrecognized
  /// state also stays still, because motion would claim activity the app cannot confirm.
  static let frozenStates: Set<ActivityState> = [.disconnected, .interrupted, .unknown]

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
    /// Vertical turn of the face, in radians; a full turn rolls the eyes over the top and back.
    var pitch = 0.0
    /// Momentary eye size, for a pop of surprise.
    var eyeScale = 1.0
    /// Emphasis marks beside the head, from 0 (none) to 1.
    var ticks = 0.0
    /// Which side the marks appear on: -1 left, 1 right.
    var tickSide = 1.0
  }
  static let restingPose = Pose()

  /// Named gestures. Idle avatars tilt, peek, hop or double take; working ones spin; thinking
  /// ones end each loop in an idea or a tumble; a completion twirls or cheers; a failure shakes;
  /// a block nudges its exclamation mark; and any state change can boop.
  enum GestureKind: String, CaseIterable, Sendable {
    case tilt, peek, hop, doubleTake, spin, idea, tumble, twirl, cheer, shake, nudge, boop

    var length: Double {
      switch self {
      case .tilt, .peek, .hop, .doubleTake: AvatarMotion.idleGestureLength
      case .spin: AvatarMotion.workSpin
      case .idea, .tumble: AvatarMotion.thinkBeat
      case .twirl, .cheer: AvatarMotion.celebration
      case .shake, .boop: 0.45
      case .nudge: 0.5
      }
    }
    /// Gestures that read alike share a look: a working spin and a completion twirl both spin
    /// with trails, a cheer is two hops, and a double take and an idea both pop wide eyes and
    /// marks. Only one bot at a time may show a look.
    var look: String {
      switch self {
      case .cheer: "hop"
      case .doubleTake, .idea: "marks"
      case .twirl: "spin"
      default: rawValue
      }
    }
  }
  /// A granted gesture: what, toward which side (-1 left, 1 right), and when, in seconds since
  /// state entry.
  struct Gesture: Equatable, Sendable {
    var kind: GestureKind
    var side: Double
    var start: Double
  }
  struct Plan: Equatable, Sendable {
    /// The current or next gesture in this state.
    var gesture: Gesture? = nil
    /// The gesture before it, whose expression may still be easing out.
    var previous: Gesture? = nil
    /// When the state-change boop starts, if it plays at all.
    var boop: Double? = nil
    /// This bot's own offset and pace for its continuous loops, so bots never move in step.
    var phase = 0.0
    var tempo = 1.0
  }
  /// A lone avatar with no gestures, as in a still preview or a pure-model test.
  static let soloPlan = Plan()
  /// What one bot is doing in one state: when it entered the state, in seconds since the
  /// reference date, and its plan. Every avatar of that bot in that state reads the same cue.
  struct Cue: Equatable, Sendable {
    var since: Double
    var plan: Plan
  }
  /// The clock that drives a bot's continuous loops: wander, breath, scan, sway and blinks.
  static func motionClock(_ t: Double, _ plan: Plan) -> Double { t * plan.tempo + 60 * plan.phase }
  /// Seconds into `gesture` at t, or -1 when it is not playing then.
  static func into(_ gesture: Gesture?, _ t: Double, _ kind: GestureKind? = nil) -> Double {
    guard let gesture, kind == nil || gesture.kind == kind else { return -1 }
    let u = t - gesture.start
    return u >= 0 && u < gesture.kind.length ? u : -1
  }

  /// Whether the drawing timeline can stop. Frozen states never tick; a failure
  /// ticks only while its entry shake and expression settle.
  static func timelinePaused(
    _ state: ActivityState, reduceMotion: Bool, visible: Bool, active: Bool, settling: Bool
  ) -> Bool {
    if reduceMotion || !visible || !active || frozenStates.contains(state) { return true }
    return state == .failed && !settling
  }

  /// How long an idle avatar waits between frames while only its slow loops move.
  static let idleFrame = 0.083
  static let blinkPeriod = 4.6
  static let blinkLength = 0.16
  static let wanderSpan = 2.8
  /// Whether an idle avatar only breathes and sways from t until t + ahead seconds. Those loops
  /// move well under a pixel a frame, so they can be drawn about twelve times a second. A blink, a
  /// shift of gaze, a gesture or an arrival's pop needs every frame. Only how often the pose is
  /// drawn depends on this, never the pose itself. Mirrors the web's `idleQuietAt`.
  static func idleQuietAt(_ t: Double, _ plan: Plan, ahead: Double) -> Bool {
    func overlaps(_ start: Double, _ length: Double, _ from: Double, _ to: Double) -> Bool {
      start < to && start + length > from
    }
    let from = motionClock(t, plan), to = motionClock(t + ahead, plan)
    var k = floor(from / blinkPeriod) - 1
    while k <= floor(to / blinkPeriod) {
      let at = k * blinkPeriod + 1.4 + hash(k) * 2.4
      for start in hash(k + 7) > 0.72 ? [at, at + 0.28] : [at] where overlaps(start, blinkLength, from, to) {
        return false
      }
      k += 1
    }
    // The eyes blend to a new target over 0.24 s and the head follows 0.18 s later.
    var n = floor(from / wanderSpan)
    while n <= floor(to / wanderSpan) {
      if overlaps(n * wanderSpan, 0.42, from, to) { return false }
      n += 1
    }
    for gesture in [plan.gesture, plan.previous].compactMap({ $0 })
    where overlaps(gesture.start, gesture.kind.length, t, t + ahead) {
      return false
    }
    return plan.boop.map { !overlaps($0, 0.8, t, t + ahead) } ?? true
  }
  /// Seconds between drawn frames: `idleFrame` while an idle avatar stays quiet until its next
  /// frame, otherwise full rate, at most 30 frames a second for small avatars and in Low Power Mode.
  static func frameInterval(size: Double, lowPower: Bool, quiet: Bool) -> Double {
    quiet ? idleFrame : size >= 56 && !lowPower ? 1.0 / 60 : 1.0 / 30
  }

  static func blinkAt(_ t: Double) -> Double {
    var openness = 1.0
    let base = floor(t / blinkPeriod)
    for k in [base - 1, base] {
      let at = k * blinkPeriod + 1.4 + hash(k) * 2.4
      for start in hash(k + 7) > 0.72 ? [at, at + 0.28] : [at] {
        let d = t - start
        if d >= 0 && d < blinkLength { openness = min(openness, 1 - sin(Double.pi * d / blinkLength) * 0.92) }
      }
    }
    return openness
  }

  static func wander(_ t: Double, span: Double = wanderSpan) -> (x: Double, y: Double) {
    func target(_ segment: Double) -> (Double, Double) {
      hash(segment + 13) < 0.35 ? (0, 0) : (hash(segment) * 2 - 1, (hash(segment + 31) * 2 - 1) * 0.5)
    }
    let segment = floor(t / span)
    let blend = smoothstep((t - segment * span) / 0.24)
    let from = target(segment - 1)
    let to = target(segment)
    return (from.0 + (to.0 - from.0) * blend, from.1 + (to.1 - from.1) * blend)
  }

  /// 0 to 1 over [start, end], eased.
  static func span(_ t: Double, _ start: Double, _ end: Double) -> Double {
    smoothstep((t - start) / (end - start))
  }
  /// Up then back down over [start, end]: 0 at both ends, 1 in the middle.
  static func hump(_ t: Double, _ start: Double, _ end: Double) -> Double {
    t <= start || t >= end ? 0 : sin(Double.pi * (t - start) / (end - start))
  }

  /// Thinking: eyes shrink to dots and look up to one side, then dart to the other with the body
  /// following a beat later. Each loop ends in a beat: a squash and pop of wide eyes with
  /// emphasis marks (an idea), or a hop that rolls the face over the top (a tumble). The beat's
  /// side is where the eyes end up, and the next loop starts looking there.
  static func thinkPose(_ start: Pose, _ t: Double, _ c: Double, _ beat: Gesture?) -> Pose {
    var pose = start
    let side = beat?.side ?? 1
    // The eyes switch sides in 0.14 s; the head follows over 0.4 s.
    let glance = (beat?.start ?? 0) - glanceLead
    func toward(_ from: Double, _ to: Double) -> Double {
      beat == nil ? -1 : 2 * span(t, glance + from, glance + to) - 1
    }
    let eyes = side * toward(0, 0.14)
    let head = side * toward(0.06, 0.46)
    let drift = sin(c * 1.1)
    pose.gazeX = eyes * (0.5 + 0.12 * drift)
    pose.gazeY = -0.8 + 0.08 * sin(c * 0.9)
    pose.yaw = head * 0.2
    pose.roll = head * 5 + drift * 1.2
    let b = sin(c * 2.1)
    pose.scaleY *= 1 + 0.016 * b
    pose.scaleX *= 1 - 0.01 * b
    pose.lift = -1.5 - b
    let u = into(beat, t)
    guard let beat, u >= 0 else { return pose }
    // Both beats start from a squash that gathers the body.
    let squash = hump(u, 0, 0.42)
    pose.scaleY *= 1 - 0.08 * squash
    pose.scaleX *= 1 + 0.05 * squash
    if beat.kind == .idea {
      let pop = hump(u, 0.3, 0.85)
      pose.scaleY *= 1 + 0.07 * pop
      pose.scaleX *= 1 - 0.035 * pop
      pose.lift -= 4 * pop
      // The idea lands facing forward with wide eyes, marks on the side it was looking.
      let forward = span(u, 0.25, 0.5) * (1 - span(u, 1.05, 1.4))
      pose.gazeX *= 1 - 0.8 * forward
      pose.gazeY += 0.55 * forward
      pose.yaw *= 1 - forward
      pose.roll *= 1 - 0.7 * forward
      pose.eyeScale = u < 0.3 ? 1 : 1 + 0.22 * pow(hump(u, 0.3, 1.3), 0.6)
      pose.ticks = u < 0.32 ? 0 : popIn((u - 0.32) / 0.3) * (1 - span(u, 0.95, 1.3))
      pose.tickSide = side
    } else {
      let s = clamp((u - 0.3) / 0.8)
      pose.pitch = tau * easeInOut(s)
      pose.lift -= 3.5 * sin(Double.pi * s)
      pose.gazeY *= 1 - hump(u, 0.3, 1.1)
    }
    return pose
  }

  /// A stable number per name, for motion that cannot go through the conductor, such as a
  /// portrait's ring.
  static func motionSeed(_ name: String) -> Double {
    var seed = 0
    for unit in name.utf16 { seed = (seed * 31 + Int(unit)) % 997 }
    return Double(seed)
  }
  /// A portrait ring's offset into its turn, as a fraction, and its pace, so rings never turn
  /// in step.
  static func ringOffset(_ name: String) -> (phase: Double, pace: Double) {
    let seed = motionSeed(name)
    return (hash(seed + 41), 0.9 + 0.2 * hash(seed + 43))
  }
  /// Now and then an idle avatar does something small: a curious head tilt, a peek to one side,
  /// a hop, or a double take with emphasis marks. Each lasts about 1.4 s.
  static func idleGesturePose(_ start: Pose, _ t: Double, _ gesture: Gesture?) -> Pose {
    var pose = start
    let g = into(gesture, t)
    guard let gesture, g >= 0 else { return pose }
    let side = gesture.side
    let e = span(g, 0, 0.25) * (1 - span(g, 1.05, 1.4))
    switch gesture.kind {
    case .tilt:  // A curious tilt toward one side, eyes a little wider.
      pose.roll += side * 13 * e
      pose.gazeX += (side * 0.6 - pose.gazeX) * e
      pose.gazeY += (-0.3 - pose.gazeY) * e
      pose.eyeScale = 1 + 0.12 * e
    case .peek:  // A peek: the head turns a quarter so the far eye shrinks.
      pose.yaw += (side * 0.55 - pose.yaw) * e
      pose.gazeX += (side * 0.9 - pose.gazeX) * e
      pose.shiftX += side * 1.5 * e
    case .hop:  // A hop: gather, spring up, land.
      let gather = hump(g, 0, 0.22) + hump(g, 0.62, 0.86)
      let air = hump(g, 0.18, 0.66)
      pose.scaleY *= 1 - 0.09 * gather + 0.06 * air
      pose.scaleX *= 1 + 0.06 * gather - 0.03 * air
      pose.lift -= 7 * air
      pose.eyeScale = 1 + 0.1 * air
      pose.blink = 1
    case .doubleTake:  // A double take: a glance, back, then wide eyes and marks.
      let glance = hump(g, 0, 0.3)
      pose.gazeX += (side * 0.9 - pose.gazeX) * glance
      pose.yaw += side * 0.25 * glance
      let take = span(g, 0.32, 0.42) * (1 - span(g, 1.05, 1.4))
      let fade = 1 - span(g, 1.05, 1.4)
      pose.eyeScale = g < 0.32 ? 1 : 1 + 0.26 * popIn((g - 0.32) / 0.25) * fade
      pose.gazeX *= 1 - take
      pose.lift -= 2.5 * hump(g, 0.32, 0.6)
      pose.ticks = g < 0.36 ? 0 : popIn((g - 0.36) / 0.3) * (1 - span(g, 0.95, 1.3))
      pose.tickSide = side
      pose.blink = 1
    default: break
    }
    return pose
  }

  /// A short damped "boop" that acknowledges a state change, starting `u` seconds ago.
  static func arrival(_ u: Double) -> Double { u < 0 ? 1 : 1 + 0.07 * exp(-u * 7) * sin(u * 24) }

  /// A completion's double spin with trails, marks popping at the end.
  static func twirl(_ pose: inout Pose, _ u: Double) {
    let s = u / celebration
    pose.yaw = tau * 2 * easeOut(s)
    pose.sweep = pose.yaw
    pose.trails = s < 0.8 ? 1 : (1 - s) / 0.2
    pose.lift += -7 * abs(sin(Double.pi * s * 2)) * (1 - s * 0.4)
    pose.roll += 14 * sin(s * tau * 1.5) * (1 - s)
    pose.scaleY *= 1 - 0.06 * sin(tau * 2 * s) * (1 - s)
    pose.blink = 1
    pose.ticks = s < 0.82 ? 0 : popIn((u - celebration * 0.82) / 0.3)
  }
  /// A completion's other celebration: two hops leaning one way then the other, marks on landing.
  static func cheer(_ pose: inout Pose, _ u: Double, _ side: Double) {
    let first = hump(u, 0.16, 0.56)
    let second = hump(u, 0.68, 1.08)
    let air = first + second
    let gather = hump(u, 0, 0.2) + hump(u, 0.52, 0.72) + hump(u, 1.04, 1.24)
    pose.scaleY *= 1 - 0.1 * gather + 0.07 * air
    pose.scaleX *= 1 + 0.07 * gather - 0.035 * air
    pose.lift -= 8 * air
    pose.roll += side * 9 * (first - second)
    pose.eyeScale = 1 + 0.14 * air
    pose.blink = 1
    pose.ticks = u < 1.1 ? 0 : popIn((u - 1.1) / 0.3)
  }

  /// Where the held prop sits in avatar units, and its tilt in degrees.
  struct PropPlacement: Equatable {
    var x: Double
    var y: Double
    var rotate: Double
  }
  static func propMotion(_ prop: AvatarProp, _ t: Double) -> PropPlacement {
    switch prop {
    case .search:
      PropPlacement(x: 72 + sin(t * 1.6) * 9, y: 70 + sin(t * 3.2) * 2.5, rotate: -8 + sin(t * 1.6) * 6)
    case .computer: PropPlacement(x: 50, y: 88 - abs(sin(t * 9)) * 0.5, rotate: 0)
    case .read: PropPlacement(x: 50, y: 86 + sin(t * 1.4) * 1, rotate: sin(t * 0.7) * 2)
    case .write:
      PropPlacement(x: 74 + sin(t * 7) * 2.5, y: 78 + cos(t * 7) * 1.2 + sin(t * 0.9) * 2, rotate: 0)
    }
  }
  /// The held prop's springy entrance scale, 0 at its first frame and settling at 1.
  static func popIn(_ t: Double) -> Double {
    let x = clamp(t)
    return 1 + 2.2 * pow(x - 1, 3) + 1.2 * pow(x - 1, 2)
  }

  /// Replaces the working scan and spin with a calm pose that watches the prop.
  static func propPose(_ start: Pose, _ prop: AvatarProp, _ t: Double) -> Pose {
    var pose = start
    let motion = propMotion(prop, t)
    // Reading eyes sweep across a line, then hop back to start the next one.
    func line(_ rate: Double) -> Double {
      let u = (t * rate).truncatingRemainder(dividingBy: 1)
      return u < 0.85 ? -0.6 + 1.2 * (u / 0.85) : 0.6 - 1.2 * smoothstep((u - 0.85) / 0.15)
    }
    let b = sin(t * 1.9)
    pose.scaleY *= 1 + 0.014 * b
    pose.scaleX *= 1 - 0.008 * b
    pose.lift = -0.8 * b
    switch prop {
    case .search:
      pose.gazeX = (motion.x - 72) / 12
      pose.gazeY = 0.4
      pose.roll = (motion.x - 72) * 0.25
    case .write:
      pose.gazeX = 0.55 + sin(t * 7) * 0.12
      pose.gazeY = 0.7
      pose.roll = 3
    case .computer, .read:
      pose.gazeX = line(prop == .computer ? 0.7 : 0.4)
      pose.gazeY = 0.85
      pose.lift += prop == .computer ? -abs(sin(t * 9)) * 0.5 : 0
    }
    pose.yaw = pose.gazeX * 0.12
    return pose
  }

  /// The pose at t seconds into `state`. `plan` says which named gestures this bot plays and
  /// when, and the pace of its continuous loops; without one the avatar only runs its loops.
  static func pose(
    _ state: ActivityState, _ t: Double, reduce: Bool, prop: AvatarProp? = nil,
    plan: Plan = soloPlan
  ) -> Pose {
    if reduce || frozenStates.contains(state) { return restingPose }
    let c = motionClock(t, plan)
    let g = plan.gesture
    let pop = plan.boop.map { arrival(t - $0) } ?? 1
    var pose = Pose(scaleX: pop, scaleY: pop, blink: blinkAt(c))
    func breathe(_ rate: Double, _ depth: Double) -> Double {
      let b = sin(c * rate)
      pose.scaleY *= 1 + depth * b
      pose.scaleX *= 1 - depth * 0.6 * b
      return b
    }
    switch state {
    case .idle:
      let b = breathe(1.7, 0.012)
      let w = wander(c)
      // The eyes lead; the head turns and leans after them.
      let lag = wander(c - 0.18)
      pose.lift = -0.6 * b
      pose.roll = sin(c * 0.55) * 1.6 + lag.x * 2.5
      pose.gazeX = w.x
      pose.gazeY = w.y
      pose.yaw = lag.x * 0.2
      return idleGesturePose(pose, t, g)
    case .thinking:
      return thinkPose(pose, t, c, g)
    case .working:
      if let prop { return propPose(pose, prop, c) }
      // The scan eases in, because this bot's scan may enter partway through a sweep.
      let scan = sin(tau * c / workScan) * smoothstep(t / 0.5)
      pose.yaw = 0.6 * scan
      pose.gazeX = 0.5 * scan
      pose.lift = -abs(sin(c * 6.5)) * 1.6
      pose.roll = sin(c * 6.5) * 1.2
      let u = into(g, t, .spin)
      if u >= 0 {
        // The scan hands over to the spin and takes back after it, so a spin can start anywhere.
        let s = u / workSpin
        let keep = 1 - span(u, 0, 0.2) * (1 - span(u, workSpin - 0.2, workSpin))
        pose.sweep = tau * easeInOut(s)
        pose.yaw = pose.sweep + pose.yaw * keep
        pose.gazeX *= keep
        pose.roll *= keep
        pose.trails = sin(Double.pi * s)
        pose.lift = pose.lift * keep - 3 * sin(Double.pi * s)
        pose.blink = 1
      }
    case .waiting:
      let b = breathe(1.1, 0.018)
      pose.lift = 0.8 + 0.8 * b
      pose.roll = sin(c * 0.4) * 2.5
      pose.gazeX = sin(c * 0.35) * 0.4
      pose.gazeY = 0.6
    case .blocked:
      let w = into(g, t, .nudge)
      pose.symbolTilt = w < 0 ? 0 : 9 * sin(w / 0.5 * tau * 2) * (1 - w / 0.5)
    case .done:
      let b = breathe(1.5, 0.012)
      pose.lift = -0.5 * b
      pose.roll = sin(c * 0.7) * 2
      // A celebration may wait its turn; one that never got a turn settles without marks.
      let u = g.map { t - $0.start } ?? -1
      pose.tickSide = g?.side ?? 1
      if let g, u >= 0, u < celebration {
        if g.kind == .cheer { cheer(&pose, u, g.side) } else { twirl(&pose, u) }
      } else if u >= celebration {
        pose.ticks = 1 - span(u, celebration + 0.3, celebration + 0.7)
      }
    case .failed:
      let u = into(g, t, .shake)
      pose.shiftX = u < 0 ? 0 : 3 * sin(u * 42) * (1 - u / 0.45)
      pose.lift = 1.5 * smoothstep(t / 0.3)
      pose.scaleY *= 1 - 0.03 * smoothstep(t / 0.3)
      pose.blink = 1
    case .disconnected, .interrupted, .unknown: break
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
    /// 0 = the style's own eyes, 1 = small round dots, as when concentrating.
    var dot: Double
  }
  /// Whether `beat` is an idea in its wide-eyed moment at `t`.
  static func ideaBeat(_ beat: Gesture?, at t: Double) -> Bool {
    guard let beat, beat.kind == .idea else { return false }
    return t - beat.start > 0.2 && t - beat.start < 1.1
  }
  static func expression(for state: ActivityState, at t: Double, plan: Plan = soloPlan)
    -> Expression
  {
    switch state {
    case .thinking:
      // Dots while pondering; the idea beat opens them wide again.
      let idea = ideaBeat(plan.gesture, at: t) || ideaBeat(plan.previous, at: t)
      return Expression(
        open: idea ? 1.1 : 1, tilt: 0, happy: 0, dot: idea ? 0 : 1)
    case .working: return Expression(open: 0.82, tilt: 0, happy: 0, dot: 0)
    case .waiting: return Expression(open: 0.36, tilt: 0, happy: 0, dot: 0)
    case .blocked: return Expression(open: 1.1, tilt: 0, happy: 0, dot: 0)
    case .done:
      // Excited until most of the way through a celebration, which may have waited its turn.
      return t < (plan.gesture?.start ?? 0) + celebration * 0.75
        ? Expression(open: 1.1, tilt: 0, happy: 0, dot: 0)
        : Expression(open: 1, tilt: 0, happy: 1, dot: 0)
    case .failed: return Expression(open: 0.62, tilt: 14, happy: 0, dot: 0)
    case .disconnected: return Expression(open: 0.7, tilt: 0, happy: 0, dot: 0)
    case .interrupted: return Expression(open: 0.5, tilt: 0, happy: 0, dot: 0)
    case .unknown: return Expression(open: 1, tilt: 0, happy: 0, dot: 0)
    case .idle: return Expression(open: 1, tilt: 0, happy: 0, dot: 0)
    }
  }
  /// Frame-rate independent approach toward a target expression.
  static func approach(_ current: Expression, _ target: Expression, _ dt: Double) -> Expression {
    let k = 1 - exp(-dt / expressionTime)
    return Expression(
      open: current.open + (target.open - current.open) * k,
      tilt: current.tilt + (target.tilt - current.tilt) * k,
      happy: current.happy + (target.happy - current.happy) * k,
      dot: current.dot + (target.dot - current.dot) * k)
  }
  /// Moments in (from, to) when a state's target expression changes: the done state's switch
  /// to happy eyes, and the wide-eyed moments of the plan's idea beats.
  static func expressionSwitches(
    _ state: ActivityState, from: Double, to: Double, plan: Plan = soloPlan
  ) -> [Double] {
    var edges: [Double] = []
    switch state {
    case .done: edges = [(plan.gesture?.start ?? 0) + celebration * 0.75]
    case .thinking:
      for beat in [plan.previous, plan.gesture] {
        if let beat, beat.kind == .idea { edges += [beat.start + 0.2, beat.start + 1.1] }
      }
    default: break
    }
    return edges.filter { $0 > from && $0 < to }
  }
  /// The closed form of repeatedly applying `approach` from `start` since the state change.
  /// The target holds between its switches, so each stretch approaches its own target. Only
  /// the last few seconds matter, because the approach forgets the start within a second.
  static func expression(
    from start: Expression, toward state: ActivityState, after t: Double, plan: Plan = soloPlan
  ) -> Expression {
    var from = 0.0
    var current = start
    if t > 4 {
      from = t - 4
      current = expression(for: state, at: from, plan: plan)
    }
    for edge in expressionSwitches(state, from: from, to: t, plan: plan) + [t] {
      let target = expression(for: state, at: (from + edge) / 2, plan: plan)
      current = approach(current, target, edge - from)
      from = edge
    }
    return current
  }

  /// How far the body has turned into the blocked exclamation.
  struct Morph: Equatable {
    var bang: Double
  }
  static func morphTarget(_ state: ActivityState) -> Morph {
    Morph(bang: state == .blocked ? 1 : 0)
  }
  static func morph(from start: Morph, toward state: ActivityState, after t: Double) -> Morph {
    let target = morphTarget(state)
    let k = exp(-t / morphTime)
    return Morph(bang: target.bang + (start.bang - target.bang) * k)
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
  /// The eyes' height on the face sphere turned by `pitch`: `y` from the face center, the
  /// vertical squash, and whether they face the viewer. A full turn rolls them over the top.
  struct PitchProjection: Equatable {
    var y: Double
    var scale: Double
    var visible: Bool
  }
  static func pitchEyes(_ pitch: Double, radius: Double = faceRadius) -> PitchProjection {
    let depth = cos(pitch)
    return PitchProjection(y: -radius * sin(pitch), scale: max(depth, 0.02), visible: depth > 0.02)
  }
  /// Where a face's parts sit in one pose, by the rig formulas in src/components/Avatar.tsx. The
  /// eyes sit around the anchor's `cx`, and a glance or turn is scaled to the anchor's `radius`, the
  /// half-width of the part the face sits on, so a narrow rocket's eyes stay on its hull.
  struct FaceRig: Equatable {
    struct Eye: Equatable {
      /// -1 for the eye on the left, 1 for the one on the right.
      var direction: Double
      /// The eye's center in the 0-100 box.
      var x: Double
      var projection: Projection
    }
    var eyeY: Double
    var eyes: [Eye]
    /// The middle of the face as it turns, where the glasses bridge sits.
    var center: Projection
    var centerX: Double
    var roll: PitchProjection
    /// Where the cowboy hat's origin sits, and its size.
    var hatX: Double
    var hatY: Double
    var hatScale: Double
    /// How much tuned eyes shrink, and draw closer, to stay on the part the face sits on. 1 for
    /// every shape at default tuning.
    var fit: Double
  }
  /// Half the width of each eye style at full size. A style this build does not know draws as the pill.
  static func eyeHalfWidth(_ eyes: AvatarEyes) -> Double {
    switch eyes {
    case .oval: 5.5
    case .round: 7.5
    case .visor, .spark: 10
    default: 5.5
    }
  }
  static func faceRig(
    _ face: AvatarCatalog.Face, pose: Pose, state: ActivityState, eyes: AvatarEyes = .oval,
    eyeWidth: Double = 1, eyeSpacing: Double = 1
  ) -> FaceRig {
    let reach = face.radius / faceRadius
    // Tuned eyes stop growing at the edge of the part the face sits on. A visor at full width and
    // spacing fits the blob, but on a paint brush it would run past the bristles and be cut off.
    let widest = eyeHalfWidth(eyes) * face.scale * eyeWidth
    let spread = face.spacing / 2 * eyeSpacing
    let fit = min(1, (face.radius - 1) / (spread + widest))
    let eyeOffset = spread * fit
    let center = project(pose.gazeX * 2 * reach, yaw: pose.yaw, radius: face.radius)
    let eyes = [-1.0, 1.0].map { direction in
      let p = project(direction * eyeOffset + pose.gazeX * 4 * reach, yaw: pose.yaw, radius: face.radius)
      return FaceRig.Eye(direction: direction, x: face.cx + p.x, projection: p)
    }
    return FaceRig(
      eyeY: face.cy + pose.gazeY * 3 * reach + (state == .waiting ? 2 * reach : 0), eyes: eyes,
      center: center, centerX: face.cx + center.x, roll: pitchEyes(pose.pitch, radius: face.radius),
      hatX: face.cx, hatY: face.top + 15 * face.hat, hatScale: face.hat, fit: fit)
  }
  /// Near features look a little larger than far ones as the face turns.
  static func perspective(_ depth: Double) -> Double { 0.86 + 0.14 * depth }
  /// Emphasis marks: three short strokes fanning out from beside the top of the head on `side`,
  /// growing with `level`. Returned as path data in avatar units, as on the web.
  static func tickMarks(level: Double, side: Double, top: Double) -> [String] {
    if level <= 0.01 { return [] }
    let cx = 50 + side * 34
    let cy = max(top, 4) + 8
    return [-84.0, -52, -20].map { degrees in
      let a = degrees * Double.pi / 180
      let dx = cos(a) * side
      let dy = sin(a)
      let r0 = 6 + 3 * level
      let r1 = r0 + 9 * level
      func f(_ v: Double) -> String { String(format: "%.2f", v) }
      return "M\(f(cx + dx * r0)) \(f(cy + dy * r0)) L\(f(cx + dx * r1)) \(f(cy + dy * r1))"
    }
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
  /// Readable eye color for any body color, including custom picks. Eyes are cream cutouts while
  /// cream holds at least 2:1 against the body, which every palette color does; otherwise the
  /// stronger of cream and dark ink wins.
  static func faceInk(_ color: String) -> String {
    let light = "#fff9ee"
    let dark = "#2b201b"
    guard let body = luminance(color) else { return light }
    func score(_ ink: String) -> Double { contrast(body, luminance(ink) ?? 0) }
    return score(light) >= 2 || score(light) >= score(dark) ? light : dark
  }
  /// Very light bodies get a soft edge so they keep their shape on the light theme's cream surface.
  static func bodyEdge(_ color: String) -> String? {
    guard let body = luminance(color), body > 0.7 else { return nil }
    return tint(color, -0.16)
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
    /// Whether `since` marks a state change rather than the view appearing.
    var entered = false
    static func entering(_ state: ActivityState, at date: Date) -> Snapshot {
      Snapshot(
        state: state, since: date, expression: AvatarMotion.expression(for: state, at: 0),
        morph: AvatarMotion.morphTarget(state))
    }
  }
  struct Frame {
    var t: Double
    /// The bot's own loop clock, which also drives a held prop.
    var clock = 0.0
    var pose: Pose
    var expression: Expression
    var morph: Morph
    var trailLevel: Double
    var sweep: Double
    /// The prop held in this frame. Only a working avatar holds one.
    var prop: AvatarProp? = nil
    /// Seconds since the prop last changed, which drives its pop-in. Still avatars report 1.
    var propAge = 1.0
  }
  /// `prop` is the tool the caller wants held and `propSince` when it last changed. `cue` comes
  /// from `AvatarConductor`; without one the avatar counts from its own state change and plays
  /// no named gestures.
  static func frame(
    _ snapshot: Snapshot, at date: Date, still: Bool, prop: AvatarProp? = nil,
    propSince: Date = .distantPast, cue: Cue? = nil
  ) -> Frame {
    let state = snapshot.state
    let held = state == .working ? prop : nil
    if still {
      return Frame(
        t: 0, pose: restingPose, expression: expression(for: state, at: .infinity),
        morph: morphTarget(state), trailLevel: 0, sweep: 0, prop: held)
    }
    let since = cue?.since ?? snapshot.since.timeIntervalSinceReferenceDate
    let plan = cue?.plan ?? soloPlan
    let t = max(0, date.timeIntervalSinceReferenceDate - since)
    let pose = self.pose(state, t, reduce: false, prop: held, plan: plan)
    let carry = snapshot.carry * (1 - smoothstep(t / 0.6))
    return Frame(
      t: t, clock: motionClock(t, plan), pose: pose,
      expression: expression(from: snapshot.expression, toward: state, after: t, plan: plan),
      morph: morph(from: snapshot.morph, toward: state, after: t),
      trailLevel: max(pose.trails, carry),
      sweep: pose.trails >= carry ? pose.sweep : snapshot.carrySweep + t * 7,
      prop: held, propAge: max(0, date.timeIntervalSince(propSince)))
  }
  static func next(
    _ snapshot: Snapshot, to state: ActivityState, at date: Date, still: Bool,
    prop: AvatarProp? = nil, cue: Cue? = nil
  ) -> Snapshot {
    let current = frame(snapshot, at: date, still: still, prop: prop, cue: cue)
    return Snapshot(
      state: state, since: date, expression: current.expression, morph: current.morph,
      carry: current.trailLevel, carrySweep: current.sweep, entered: true)
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

/// Every avatar outline, with its outside sampled into 72 equal perimeter positions so any shape
/// can morph into any other without a discontinuous path replacement.
enum AvatarGeometry {
  static func svg(_ shape: AvatarShape) -> String { shape.art.path }
  /// An outline without its holes, such as a mug's handle. A shape morphs along its outside only:
  /// walking a hole after the outside would draw a line between the two.
  static func outside(_ d: String) -> String {
    guard let end = d.firstIndex(of: "Z") else { return d }
    return String(d[...end])
  }
  /// Where an avatar's face sits: its shape's anchor, or the blob's for a shape this build does not know.
  static func face(for avatar: AvatarConfig) -> AvatarCatalog.Face { avatar.drawnShape.art.face }
  static let paths = Dictionary(uniqueKeysWithValues: AvatarConfig.shapes.map { ($0, SVGPath.parse(svg($0))) })
  static let cached = Dictionary(uniqueKeysWithValues: AvatarConfig.shapes.map { ($0, points($0)) })
  /// The exact outline, holes and all, drawn whenever no morph is under way.
  static func path(_ shape: AvatarShape) -> Path { paths[shape] ?? paths[.blob]! }
  static func sampled(_ shape: AvatarShape) -> PointVector { cached[shape] ?? cached[.blob]! }
  static func points(_ shape: AvatarShape) -> PointVector { points(of: outside(svg(shape))) }
  /// The outline drawn `progress` (eased, 0 to 1) into a morph from `from`: the samples on their
  /// way, then the exact outline, holes and all, once the morph lands or when there is none.
  static func body(_ shape: AvatarShape, from: PointVector?, progress: Double) -> Path {
    guard let from, progress < 1 else { return path(shape) }
    return from.mixed(with: sampled(shape), progress).polygon
  }
  static func points(of d: String) -> PointVector {
    var all: [CGPoint] = []
    var current = CGPoint.zero
    var start = CGPoint.zero
    SVGPath.parse(d).cgPath.applyWithBlock { elementPointer in
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
    var samples: [CGPoint] = []
    // Positions only move forward along the outline, so one walk over its segments places them all.
    var segment = 0
    var sum = 0.0
    for index in 0..<72 {
      let position = total * Double(index) / 72
      while sum + lengths[segment] < position && segment < lengths.count - 1 {
        sum += lengths[segment]
        segment += 1
      }
      let t = lengths[segment] == 0 ? 0 : (position - sum) / lengths[segment]
      let a = all[segment]
      let b = all[segment + 1]
      samples.append(CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t))
    }
    return PointVector(values: aligned(samples).flatMap { [Double($0.x), Double($0.y)] })
  }
  /// Twice the area the points enclose: positive when they run clockwise on screen, where y grows down.
  static func signedArea(_ points: [CGPoint]) -> Double {
    var sum = 0.0
    for (point, next) in zip(points, points.dropFirst() + points.prefix(1)) {
      sum += Double(point.x * next.y - next.x * point.y)
    }
    return sum
  }
  /// The same samples, clockwise, starting at the top: the sample nearest the vertical through the
  /// middle of the shape, among those above the middle. Like `alignSamples` in
  /// src/components/avatar-outline.ts. Sample `i` of one shape moves to sample `i` of the next, so
  /// two outlines that start on different sides or run opposite ways would cross over each other
  /// mid-morph and the body would collapse to a sliver.
  static func aligned(_ points: [CGPoint]) -> [CGPoint] {
    let ordered = signedArea(points) < 0 ? Array(points.reversed()) : points
    guard !ordered.isEmpty else { return ordered }
    let cx = ordered.reduce(0.0) { $0 + Double($1.x) } / Double(ordered.count)
    let cy = ordered.reduce(0.0) { $0 + Double($1.y) } / Double(ordered.count)
    var start: Int?
    for (i, point) in ordered.enumerated() where Double(point.y) < cy {
      guard let best = start.map({ ordered[$0] }) else { start = i; continue }
      let closer = abs(Double(point.x) - cx) - abs(Double(best.x) - cx)
      // Within a millionth of a unit two samples are equally central, and the higher one starts.
      if closer < -1e-6 || (closer <= 1e-6 && point.y < best.y) { start = i }
    }
    guard let start, start > 0 else { return ordered }
    return Array(ordered[start...] + ordered[..<start])
  }
}

/// Static artwork from src/components/Avatar.tsx, parsed once.
private enum AvatarArt {
  static let hatCrown = AvatarPathData.hatCrown.path
  static let hatBand = AvatarPathData.hatBand.path
  static let hatBrim = AvatarPathData.hatBrim.path
  static let bang = AvatarPathData.bang.path
  static let spark = AvatarPathData.spark.path
  static let happyEye = AvatarPathData.happyEye.path
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

/// The held props from `PropArt` in src/components/Avatar.tsx. Their colors are fixed, as on
/// the web, so a prop reads the same on any body color and in light or dark appearance.
private enum AvatarPropArt {
  static let handle = AvatarPathData.handle.path
  static let lensGlint = AvatarPathData.lensGlint.path
  static let screen = Path(
    roundedRect: CGRect(x: -21, y: -23, width: 42, height: 27), cornerRadius: 4, style: .circular)
  static let keyboard = AvatarPathData.keyboard.path
  static let pageLeft = AvatarPathData.pageLeft.path
  static let pageRight = AvatarPathData.pageRight.path
  static let textLines = AvatarPathData.textLines.path
  static let spine = AvatarPathData.spine.path
  static let paper = Path(
    roundedRect: CGRect(x: -15, y: 2, width: 26, height: 20), cornerRadius: 2.5, style: .circular)
  static let pencil = Path(
    roundedRect: CGRect(x: -3.2, y: -22, width: 6.4, height: 22), cornerRadius: 1.2,
    style: .circular)
  static let eraser = AvatarPathData.eraser.path
  static let tip = AvatarPathData.tip.path
  static let ink = Color(hex: "#2b201b")

  static func style(_ width: Double) -> StrokeStyle {
    StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round)
  }
  /// Fills a shape and traces it with the web's dark outline.
  static func outlined(_ context: GraphicsContext, _ path: Path, _ fill: String) {
    context.fill(path, with: .color(Color(hex: fill)))
    context.stroke(path, with: .color(ink), style: style(2.2))
  }

  /// Draws a prop in avatar units, positioned by `propMotion` and scaled by `grow`.
  static func draw(_ root: GraphicsContext, prop: AvatarProp, t: Double, grow: Double) {
    let place = AvatarMotion.propMotion(prop, t)
    let scale = grow * (prop == .search ? 1.3 : 1)
    guard scale > 0.001 else { return }
    var context = root
    context.translateBy(x: place.x, y: place.y)
    context.rotate(by: .degrees(place.rotate))
    context.scaleBy(x: scale, y: scale)
    switch prop {
    case .search:
      context.stroke(handle, with: .color(ink), style: style(6.5))
      context.stroke(handle, with: .color(Color(hex: "#b07a4a")), style: style(3.6))
      let lens = AvatarArt.circle(0, 0, 11)
      context.fill(lens, with: .color(Color(hex: "#d9f2ff").opacity(0.55)))
      context.stroke(lens, with: .color(ink), style: style(3.4))
      context.stroke(lensGlint, with: .color(.white.opacity(0.9)), style: style(2))
    case .computer:
      outlined(context, screen, "#cfd5dc")
      context.fill(AvatarArt.circle(0, -10, 3), with: .color(Color(hex: "#9aa4ae")))
      outlined(context, keyboard, "#aab3bc")
      context.fill(
        AvatarArt.circle(16, 7, 1.1), with: .color(Color(hex: "#7bd88f").opacity(0.5 + 0.5 * sin(t * 5))))
    case .read:
      outlined(context, pageLeft, "#fff8ec")
      outlined(context, pageRight, "#fff8ec")
      context.stroke(textLines, with: .color(Color(hex: "#b9ab96")), style: style(1.4))
      context.stroke(spine, with: .color(Color(hex: "#c0503a")), style: style(3))
    case .write:
      var note = context
      note.translateBy(x: 0, y: 12)
      note.rotate(by: .degrees(-8))
      note.translateBy(x: 0, y: -12)
      outlined(note, paper, "#fff8ec")
      // The first line writes itself out, then starts over.
      var lines = Path()
      lines.move(to: CGPoint(x: -10, y: 9))
      lines.addLine(to: CGPoint(x: -10 + 16 * (t * 0.5).truncatingRemainder(dividingBy: 1), y: 9))
      lines.move(to: CGPoint(x: -10, y: 15))
      lines.addLine(to: CGPoint(x: 2, y: 15))
      note.stroke(lines, with: .color(Color(hex: "#9db7d6")), style: style(1.6))
      var pen = context
      pen.rotate(by: .degrees(38))
      outlined(pen, pencil, "#ffc94a")
      outlined(pen, eraser, "#f28fa0")
      outlined(pen, tip, "#f2d1a8")
    }
  }
}

/// Draws one frame of a drawn avatar, a silhouette with eyes, in the web's 116-unit viewBox.
struct AvatarArtwork {
  var avatar: AvatarConfig
  var state: ActivityState
  var frame: AvatarMotion.Frame
  var body: Path
  var bodyColor: Color
  /// The avatar's point size. Emphasis marks are lost at list sizes, so only larger ones draw them.
  var size: Double = 48

  func draw(_ root: GraphicsContext) {
    let pose = frame.pose
    let face = frame.expression
    let bang = frame.morph.bang
    let symbolic = bang
    let colorHex = avatar.color ?? "#1084FE"
    let color = Color(hex: colorHex)
    let eyes = avatar.eyes ?? .oval
    let accessory = avatar.accessory ?? .plain
    let anchor = AvatarGeometry.face(for: avatar)
    let edge = AvatarMotion.bodyEdge(colorHex)
    let ink = Color(hex: AvatarMotion.faceInk(colorHex))
    let eyeScale = anchor.scale
    let eyeWidth = avatar.eyeWidth ?? 1
    let eyeHeight = avatar.eyeHeight ?? 1
    let rig = AvatarMotion.faceRig(
      anchor, pose: pose, state: state, eyes: eyes, eyeWidth: eyeWidth, eyeSpacing: avatar.eyeSpacing ?? 1)
    let fit = rig.fit
    let eyeY = rig.eyeY
    let center = rig.center
    let open = max(face.open * pose.blink * eyeHeight * eyeScale, 0.04)
    // A pitched face rolls everything painted on it around the sphere.
    let roll = rig.roll
    // Dots replace pills outright; other eye styles shrink toward a dot instead.
    let drawsPill = ![.spark, .visor, .round].contains(eyes)
    let dotShrink = drawsPill ? 1 + 0.12 * face.dot : 1 - 0.3 * face.dot
    let pillHeight = 25 - 14 * face.dot
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
        // Nonzero filling leaves a hole, such as a mug's handle, wound against the outside open.
        layer.fill(body, with: .color(bodyColor))

        var faceLayer = layer
        faceLayer.clip(to: body)
        // The clip stays on the body while the painted face rolls beneath it.
        faceLayer.translateBy(x: 0, y: anchor.cy + roll.y)
        faceLayer.scaleBy(x: 1, y: roll.scale)
        faceLayer.translateBy(x: 0, y: -anchor.cy)
        for placed in roll.visible ? rig.eyes : [] {
          let p = placed.projection
          guard p.visible else { continue }
          let side = -placed.direction
          // Near eyes read a little larger as the face turns, and a pop of surprise grows both.
          let grow = AvatarMotion.perspective(p.scale) * pose.eyeScale * dotShrink * fit
          var eye = faceLayer
          eye.translateBy(x: placed.x, y: eyeY)
          if face.happy < 0.999 {
            var shape = eye
            shape.opacity = 1 - face.happy
            let squint = 1 + (1 - min(face.open, 1)) * 0.4
            let widthScale = p.scale * eyeWidth * eyeScale * grow * squint
            shape.scaleBy(x: widthScale, y: open * grow)
            if eyes == .spark {
              shape.fill(AvatarArt.spark, with: .color(ink))
            } else if eyes == .visor {
              shape.fill(
                Path(
                  roundedRect: CGRect(x: -10, y: -4.5, width: 20, height: 9), cornerRadius: 4.5,
                  style: .circular), with: .color(ink))
            } else if eyes == .round {
              shape.fill(AvatarArt.circle(0, 0, 7.5), with: .color(ink))
            } else {
              shape.rotate(by: .degrees(face.tilt * side))
              shape.fill(
                Path(
                  roundedRect: CGRect(x: -5.5, y: -pillHeight / 2, width: 11, height: pillHeight),
                  cornerRadius: 5.5,
                  style: .circular), with: .color(ink))
            }
          }
          if face.happy > 0.01 {
            var arc = eye
            arc.opacity = face.happy
            arc.scaleBy(x: p.scale * eyeWidth * eyeScale * fit, y: eyeScale * fit)
            arc.stroke(AvatarArt.happyEye, with: .color(ink), style: stroke(4.5))
          }
          if accessory == .glasses {
            eye.stroke(
              AvatarArt.ellipse(0, 0, 12.5 * eyeScale * p.scale * fit, 12.5 * eyeScale * fit),
              with: .color(ink), lineWidth: 2.5)
          }
        }
        if accessory == .glasses && center.visible && roll.visible {
          var bridge = Path()
          bridge.move(to: CGPoint(x: rig.centerX - 4 * center.scale, y: eyeY - 2))
          bridge.addQuadCurve(
            to: CGPoint(x: rig.centerX + 4 * center.scale, y: eyeY - 2),
            control: CGPoint(x: rig.centerX, y: eyeY - 5))
          faceLayer.stroke(bridge, with: .color(ink), style: stroke(2.5))
        }
        if let edge {
          layer.stroke(body, with: .color(Color(hex: edge)), style: StrokeStyle(lineWidth: 2.2))
        }
        if accessory == .hat {
          var hat = layer
          hat.translateBy(x: rig.hatX, y: rig.hatY)
          hat.scaleBy(x: rig.hatScale, y: rig.hatScale)
          hat.fill(AvatarArt.hatCrown, with: .color(Color(hex: "#3a2f28")))
          hat.fill(AvatarArt.hatBand, with: .color(Color(hex: "#b48156")))
          hat.fill(AvatarArt.hatBrim, with: .color(Color(hex: "#302925")))
        }
        if size >= 40 && pose.ticks > 0.01 {
          var marks = layer
          marks.opacity = min(pose.ticks, 1)
          for d in AvatarMotion.tickMarks(level: pose.ticks, side: pose.tickSide, top: anchor.top) {
            marks.stroke(SVGPath.parse(d), with: .color(bodyColor), style: stroke(4.2))
          }
        }
        trails(front: true)
      }
    }
    // A held prop pops in when Hermes starts a new kind of tool. It sits outside the body's
    // transform, so the avatar sways and looks at it while the prop keeps its own motion.
    if let prop = frame.prop {
      var held = root
      held.opacity = AvatarMotion.smoothstep(frame.propAge / 0.2)
      if held.opacity > 0.001 {
        held.drawLayer { context in
          AvatarPropArt.draw(
            context, prop: prop, t: frame.clock, grow: AvatarMotion.popIn(frame.propAge / 0.4))
        }
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
      // The symbol stands in for the body, so a very light one keeps the body's soft edge.
      symbol.drawLayer { context in
        for mark in [AvatarArt.bang, AvatarArt.circle(50, 79, 7.5)] {
          context.fill(mark, with: .color(color))
          if let edge { context.stroke(mark, with: .color(Color(hex: edge)), style: StrokeStyle(lineWidth: 2.2)) }
        }
      }
    }
  }
}

/// Low Power Mode, which caps every avatar at 30 frames a second.
@MainActor @Observable final class LowPowerMode {
  static let shared = LowPowerMode()
  private(set) var enabled = ProcessInfo.processInfo.isLowPowerModeEnabled
  @ObservationIgnored private var observer: (any NSObjectProtocol)?
  private init() {
    // Posted on any thread; the value is read again on the main actor.
    observer = NotificationCenter.default.addObserver(
      forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main
    ) { _ in
      Task { @MainActor in LowPowerMode.shared.enabled = ProcessInfo.processInfo.isLowPowerModeEnabled }
    }
  }
}

struct AvatarView: View {
  var avatar: AvatarConfig
  var state: ActivityState
  var size: CGFloat
  var name: String
  var forceReducedMotion: Bool
  /// A tool to hold while working, such as a magnifying glass during a search. Portraits and
  /// other states ignore it, as on the web.
  var prop: AvatarProp?
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
  /// Whether this idle avatar drew its last frame with nothing but slow loops ahead of it.
  @State private var idleQuiet = false
  private let power = LowPowerMode.shared
  @State private var changes = 0
  @State private var propSince = Date()
  /// Stands in for a name, so unnamed avatars each count as their own bot.
  @State private var instance = UUID().uuidString
  /// The bot's name when the caller gave one; without a bot ID, avatars with it share gestures.
  private let botName: String?
  /// The bot's stable ID. Two bots can share a name; their avatars must still move independently.
  private let botId: String?

  init(
    avatar: AvatarConfig = AvatarConfig(), state: ActivityState = .idle, size: CGFloat = 48,
    name: String? = nil, botId: String? = nil, forceReducedMotion: Bool = false, prop: AvatarProp? = nil
  ) {
    self.avatar = avatar
    self.state = state
    self.size = size
    self.name = name ?? "Assistant"
    botName = name
    self.botId = botId
    self.forceReducedMotion = forceReducedMotion
    self.prop = prop
    _snapshot = State(initialValue: .entering(state, at: Date()))
  }

  private var reduceMotion: Bool { systemReduceMotion || forceReducedMotion }
  private var portrait: Bool { avatar.mode == .portrait }
  private var heldProp: AvatarProp? { portrait ? nil : prop }
  /// Who the conductor sees: the conductor keeps different bots from gesturing alike.
  private var owner: String { AvatarView.motionOwner(botId: botId, name: botName, instance: instance) }
  /// Who the conductor sees: a bot's ID wins over its name; an avatar with neither is its own bot.
  static func motionOwner(botId: String?, name: String?, instance: String) -> String {
    if let botId { return "bot:" + botId }
    if let name { return "name:" + name }
    return "avatar-" + instance
  }
  /// This bot's cue for `snapshot`'s state, or nil while the avatar is still.
  private func cue(_ snapshot: AvatarMotion.Snapshot, still: Bool, at date: Date)
    -> AvatarMotion.Cue?
  {
    still
      ? nil
      : AvatarConductor.shared.cue(
        owner: owner, state: snapshot.state, since: snapshot.since.timeIntervalSinceReferenceDate,
        entered: snapshot.entered, held: heldProp != nil,
        now: date.timeIntervalSinceReferenceDate)
  }
  private var geometry: AvatarShape { avatar.drawnShape }
  private var colorHex: String { avatar.color ?? "#1084FE" }
  private var frozen: Bool { AvatarMotion.frozenStates.contains(state) }
  private func still(_ state: ActivityState) -> Bool {
    reduceMotion || !visible || portrait || AvatarMotion.frozenStates.contains(state)
  }
  /// A lost connection is the app's state, said once by the connection notice: its assistants
  /// only dim, without a badge, as on the web.
  private var showsBadge: Bool { Self.badged(state, portrait: portrait) }
  static func badged(_ state: ActivityState, portrait: Bool) -> Bool {
    state != .disconnected
      && (portrait
        ? ![.idle, .thinking, .working].contains(state)
        : [.done, .failed, .interrupted, .unknown].contains(state))
  }
  /// How much the avatar is quieted: a lost connection lightly, a stopped or unknown state more.
  static func dim(_ state: ActivityState) -> (saturation: Double, opacity: Double) {
    switch state {
    case .disconnected: (0.45, 0.9)
    case .interrupted, .unknown: (0.25, 0.88)
    default: (1, 1)
    }
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
    .saturation(Self.dim(state).saturation).opacity(Self.dim(state).opacity)
    // Losing and regaining the connection eases in and out over 400 ms, as the web's filter does.
    .animation(.timingCurve(0.22, 1, 0.36, 1, duration: 0.4), value: state == .disconnected)
    .accessibilityElement(children: .ignore).accessibilityAddTraits(.isImage)
    .accessibilityLabel("\(name): \(state.label)")
    .onAppear { visible = true }
    .onDisappear { visible = false }
    .onChange(of: state) { old, new in
      let now = Date()
      snapshot = AvatarMotion.next(
        snapshot, to: new, at: now, still: still(old), prop: heldProp,
        cue: cue(snapshot, still: still(old), at: now))
      changes += 1
    }
    .onChange(of: prop) { propSince = Date() }
    .onChange(of: geometry) { old, _ in
      let now = Date()
      morphFrom = changeAnimates ? bodyPoints(at: now, previous: old) : nil
      morphAt = now
      changes += 1
    }
    .onChange(of: colorHex) { old, _ in
      colorFrom = changeAnimates ? old : nil
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
    let interval = AvatarMotion.frameInterval(
      size: Double(size), lowPower: power.enabled, quiet: idleQuiet && state == .idle && !settling)
    return TimelineView(.animation(minimumInterval: interval, paused: paused)) { timeline in
      let date = paused ? Date() : timeline.date
      let isStill = still(state)
      let current = cue(snapshot, still: isStill, at: date)
      let frame = AvatarMotion.frame(
        snapshot, at: date, still: isStill, prop: heldProp, propSince: propSince, cue: current)
      // Judged over the wait for the next slow frame, with room for that frame to run late.
      let quiet = state == .idle && !settling
        && current.map { AvatarMotion.idleQuietAt(frame.t, $0.plan, ahead: AvatarMotion.idleFrame + 0.02) } == true
      let artwork = AvatarArtwork(
        avatar: avatar, state: state, frame: frame,
        body: bodyPath(at: date), bodyColor: bodyColor(at: date),
        size: Double(size))
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
      .onChange(of: quiet, initial: true) { _, value in idleQuiet = value }
    }
  }

  private func morphProgress(_ date: Date) -> Double {
    AvatarMotion.smoothstep(date.timeIntervalSince(morphAt) / AvatarMotion.shapeDuration)
  }
  private func bodyPoints(at date: Date, previous: AvatarShape) -> PointVector {
    let target = AvatarGeometry.sampled(previous)
    guard let morphFrom, morphProgress(date) < 1 else { return target }
    return morphFrom.mixed(with: target, morphProgress(date))
  }
  private func bodyPath(at date: Date) -> Path {
    AvatarGeometry.body(geometry, from: morphFrom, progress: morphProgress(date))
  }
  private var changeAnimates: Bool {
    Self.animatesChange(state: state, reduceMotion: reduceMotion, visible: visible, active: scenePhase == .active)
  }
  /// Whether a new shape or color moves into place: only while frames will come to carry it. A
  /// frozen, hidden or reduced-motion avatar draws only when something changes, so a morph it began
  /// would hold its first frame, the old shape's samples and the old color, for the second a change
  /// keeps settling.
  static func animatesChange(state: ActivityState, reduceMotion: Bool, visible: Bool, active: Bool) -> Bool {
    // A change starts the settling window, so a failed avatar animates it too.
    !AvatarMotion.timelinePaused(state, reduceMotion: reduceMotion, visible: visible, active: active, settling: true)
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
        // Each bot's ring turns at its own offset and pace, so rings never turn in step.
        let offset = AvatarMotion.ringOffset(owner)
        let period = (state == .working ? 1.1 : 2.6) * offset.pace
        let turn =
          spinning
          ? (timeline.date.timeIntervalSinceReferenceDate / period + offset.phase)
            .truncatingRemainder(dividingBy: 1) : 0
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
    case .idle, .disconnected, .interrupted, .unknown: EmptyView()
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
    case .unknown: "questionmark"
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
