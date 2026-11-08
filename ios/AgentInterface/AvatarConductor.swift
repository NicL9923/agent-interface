import Foundation

/// Decides which named gesture each bot plays and when, so no two bots on screen ever show the
/// same look at once, and gives each bot its own pace for its continuous loops. It mirrors
/// src/components/avatar-conductor.ts; AvatarMotionParityTests replays the web's household.
/// Time is seconds on one clock the caller supplies.
@MainActor
final class AvatarConductor {
  typealias Kind = AvatarMotion.GestureKind
  /// The app's conductor; every animated avatar asks it for its cue each frame.
  static let shared = AvatarConductor()

  /// Seconds kept clear between two bots' turns at one look, so turns never touch.
  nonisolated static let turnGap = 0.3
  /// A completion celebrates within this long of finishing, or skips the celebration.
  nonisolated static let celebrationDelay = AvatarMotion.celebration + turnGap
  nonisolated static let boopDelay = 0.25
  nonisolated static let shakeDelay = 0.3
  /// Entry gestures belong to a state the avatar just entered, not one it scrolled back to.
  nonisolated static let entryGrace = 0.25
  /// A track nobody has asked about for this long is off screen; its future turns are given back.
  nonisolated static let lease = 0.5
  /// How long a finished turn still counts when an idle bot looks for a fresh gesture.
  nonisolated static let memory = 8.0
  /// A held prop replaces the working spin for this long after the last frame that held it.
  nonisolated static let calmTime = 0.25
  nonisolated static let idleKinds: [Kind] = [.tilt, .peek, .hop, .doubleTake]
  /// Filler gestures that can move later at no cost before they start. A thinking beat cannot,
  /// because its glance comes first.
  nonisolated static let movableKinds: Set<Kind> = Set(idleKinds + [.spin, .nudge])

  /// Each bot on screen gets a distinct voice, and each voice its own phase and pace.
  nonisolated static func voicePhase(_ voice: Int) -> Double {
    (Double(voice) * 0.618034).truncatingRemainder(dividingBy: 1)
  }
  nonisolated static func voiceTempo(_ voice: Int) -> Double {
    0.9 + 0.2 * (Double(voice) * 0.7548777 + 0.5).truncatingRemainder(dividingBy: 1)
  }

  private final class Turn {
    weak var track: Track?
    let owner: String
    let kind: Kind
    var start: Double
    var end: Double
    init(track: Track, kind: Kind, start: Double) {
      self.track = track
      owner = track.owner
      self.kind = kind
      self.start = start
      end = start + kind.length
    }
  }

  /// What one bot is doing in one state. Every avatar of that bot in that state reads it.
  private final class Track {
    let owner: String
    let state: ActivityState
    let since: Double
    let voice: Int
    var seen: Double
    var plan: AvatarMotion.Plan
    /// The current or next gesture.
    var turn: Turn?
    var boop: Turn?
    var count = 0
    /// Whether a celebration or shake may still be booked.
    var entryOpen: Bool
    /// Whether a celebration or shake took this track's booked turn, so it must book again.
    var bumped = false
    var calmUntil = -Double.infinity
    init(owner: String, state: ActivityState, since: Double, voice: Int, seen: Double) {
      self.owner = owner
      self.state = state
      self.since = since
      self.voice = voice
      self.seen = seen
      plan = AvatarMotion.Plan(
        phase: AvatarConductor.voicePhase(voice), tempo: AvatarConductor.voiceTempo(voice))
      entryOpen = seen - since <= AvatarConductor.entryGrace
    }
    /// Noise that differs per bot and per gesture.
    func noise(_ n: Double) -> Double { AvatarMotion.hash(Double(voice * 31 + count * 7) + n) }
  }

  private var tracks: [String: [ActivityState: Track]] = [:]
  private var voices: [String: Int] = [:]
  private var turns: [Turn] = []
  private var swept = -Double.infinity

  /// The cue for `owner` in `state`. `owner` names the bot, so its avatars share one cue;
  /// `since` is when this avatar entered the state, `entered` whether that was a change rather
  /// than an appearance, and `held` whether it holds a prop instead of spinning. Call once per
  /// frame.
  func cue(
    owner: String, state: ActivityState, since: Double, entered: Bool, held: Bool, now: Double
  ) -> AvatarMotion.Cue {
    if now - swept >= Self.lease / 2 { sweep(now) }
    let track: Track
    if let existing = tracks[owner]?[state] {
      track = existing
    } else {
      track = open(owner: owner, state: state, since: since, entered: entered, now: now)
      tracks[owner, default: [:]][state] = track
    }
    track.seen = now
    if held { calm(track, now) }
    if track.bumped { rebook(track, now) }
    if track.turn.map({ now >= $0.end }) ?? true { advance(track, now) }
    return AvatarMotion.Cue(since: track.since, plan: track.plan)
  }

  private func open(
    owner: String, state: ActivityState, since: Double, entered: Bool, now: Double
  ) -> Track {
    let voice: Int
    if let existing = voices[owner] {
      voice = existing
    } else {
      let taken = Set(voices.values)
      voice = (0...).first { !taken.contains($0) }!
      voices[owner] = voice
    }
    let track = Track(owner: owner, state: state, since: since, voice: voice, seen: now)
    if entered && track.entryOpen && !AvatarMotion.frozenStates.contains(state) {
      track.boop = book(track, [.boop], from: since, latest: since + Self.boopDelay)
      if let boop = track.boop { track.plan.boop = boop.start - since }
    }
    return track
  }

  /// Books this track's next gesture once the last one is over.
  private func advance(_ track: Track, _ now: Double) {
    let since = track.since
    let tempo = track.plan.tempo
    let last = track.turn
    let kinds: [Kind]
    let from: Double
    var latest = Double.infinity
    switch track.state {
    case .idle:
      // A gesture every 6 to 12 s, the first after the arrival settles.
      from =
        last.map { $0.start + AvatarMotion.idleGesture * (0.67 + 0.66 * track.noise(1)) }
        ?? max(since + 2.5 + 4 * track.noise(1), now + 1 + 2 * track.noise(2))
      kinds = freshest(track)
    case .working:
      if now < track.calmUntil { return }
      from = (last?.end ?? since) + AvatarMotion.workScan * tempo
      kinds = [.spin]
    case .thinking:
      // Beats alternate, and the glance before each one must still be ahead.
      from = max(
        (last?.end ?? since) + AvatarMotion.thinkPonder * tempo, now + AvatarMotion.glanceLead)
      kinds = track.count % 2 == 0 ? [.idea, .tumble] : [.tumble, .idea]
    case .blocked:
      from = last.map { $0.start + 2.6 * tempo } ?? since
      kinds = [.nudge]
    case .done, .failed:
      guard track.entryOpen else { return }
      track.entryOpen = false
      from = since
      latest = since + (track.state == .done ? Self.celebrationDelay : Self.shakeDelay)
      kinds = track.state == .done ? [.twirl, .cheer] : [.shake]
    case .waiting, .disconnected, .interrupted, .unknown:
      return
    }
    // A completion or failure answers an event, so it may move filler that has not started yet.
    guard
      let turn = book(
        track, kinds, from: max(from, now), latest: latest, bumpAt: latest < .infinity ? now : nil)
    else { return }
    // Thinking sides alternate, so each loop starts where the last one looked.
    let side: Double
    if track.state == .thinking {
      let first: Double = AvatarMotion.hash(Double(track.voice * 31) + 5) < 0.5 ? -1 : 1
      side = track.count % 2 == 0 ? first : -first
    } else {
      side = track.noise(3) < 0.5 ? -1 : 1
    }
    track.count += 1
    track.turn = turn
    track.plan.previous = track.plan.gesture
    track.plan.gesture = AvatarMotion.Gesture(kind: turn.kind, side: side, start: turn.start - since)
  }

  /// Idle kinds, least recently seen on another bot first, with this bot's last one at the end.
  private func freshest(_ track: Track) -> [Kind] {
    func seen(_ kind: Kind) -> Double {
      if kind == track.turn?.kind { return .infinity }
      var latest = -Double.infinity
      for turn in turns where turn.owner != track.owner && turn.kind.look == kind.look {
        latest = max(latest, turn.end)
      }
      return latest
    }
    let count = Self.idleKinds.count
    let rotate = Int(floor(track.noise(4) * Double(count)))
    struct Choice {
      var kind: Kind
      var seen: Double
      var order: Int
    }
    var choices: [Choice] = []
    for (i, kind) in Self.idleKinds.enumerated() {
      choices.append(Choice(kind: kind, seen: seen(kind), order: (i + rotate) % count))
    }
    choices.sort { a, b in a.seen != b.seen ? a.seen < b.seen : a.order < b.order }
    return choices.map(\.kind)
  }

  /// Books the kind that can start soonest at or after `from`, preferring earlier kinds on a
  /// tie, as long as it starts by `latest`. With `bumpAt`, filler booked to start after then
  /// moves out of the way instead.
  private func book(
    _ track: Track, _ kinds: [Kind], from: Double, latest: Double, bumpAt: Double? = nil
  ) -> Turn? {
    var best: Turn?
    for kind in kinds {
      let start = earliest(track.owner, kind, from: from, bumpAt: bumpAt)
      // The tolerance keeps a turn that ends exactly on the bound from rounding past it.
      if start <= latest + 1e-9 && (best.map { start < $0.start } ?? true) {
        best = Turn(track: track, kind: kind, start: start)
      }
    }
    guard let best else { return nil }
    if let bumpAt {
      let bumped = turns.filter { movable($0, at: bumpAt) && clashes($0, best) }
      for turn in bumped { turn.track?.bumped = true }
      turns.removeAll { turn in bumped.contains { $0 === turn } }
    }
    turns.append(best)
    return best
  }

  /// Whether another bot's turn would show the same look within the gap of `taken`.
  private func clashes(_ turn: Turn, _ taken: Turn) -> Bool {
    turn.owner != taken.owner && turn.kind.look == taken.kind.look
      && taken.start < turn.end + Self.turnGap && taken.end + Self.turnGap > turn.start
  }
  private func movable(_ turn: Turn, at: Double) -> Bool {
    turn.start > at && Self.movableKinds.contains(turn.kind)
  }

  /// A bumped track books its gesture again, as soon as it fits after where it was.
  private func rebook(_ track: Track, _ now: Double) {
    track.bumped = false
    guard let old = track.turn, let gesture = track.plan.gesture else { return }
    let kinds = track.state == .idle ? freshest(track) : [old.kind]
    guard let turn = book(track, kinds, from: max(old.start, now), latest: .infinity) else { return }
    track.turn = turn
    track.plan.gesture = AvatarMotion.Gesture(
      kind: turn.kind, side: gesture.side, start: turn.start - track.since)
  }

  /// The first start at or after `from` when no other bot shows this kind's look, gap included.
  private func earliest(_ owner: String, _ kind: Kind, from: Double, bumpAt: Double?) -> Double {
    let look = kind.look
    let length = kind.length
    var start = from
    var moved = true
    while moved {
      moved = false
      for turn in turns where turn.owner != owner && turn.kind.look == look {
        if let bumpAt, movable(turn, at: bumpAt) { continue }
        if start < turn.end + Self.turnGap && start + length + Self.turnGap > turn.start {
          start = turn.end + Self.turnGap
          moved = true
        }
      }
    }
    return start
  }

  /// A held prop replaces the spin: drop a booked spin and end one under way.
  private func calm(_ track: Track, _ now: Double) {
    track.calmUntil = now + Self.calmTime
    guard track.state == .working, let turn = track.turn, now < turn.end else { return }
    yieldTurn(turn, now)
    track.plan.gesture = nil
    track.bumped = false
  }

  /// Gives back what is left of a turn: all of it if it has not started.
  private func yieldTurn(_ turn: Turn, _ now: Double) {
    if turn.start > now {
      turns.removeAll { $0 === turn }
      turn.start = now
    }
    turn.end = min(turn.end, now)
  }

  /// Closes tracks nobody has asked about lately and forgets turns too old to matter.
  private func sweep(_ now: Double) {
    swept = now
    for (owner, states) in tracks {
      var kept = states
      for (state, track) in states where now - track.seen > Self.lease {
        kept[state] = nil
        for turn in [track.turn, track.boop].compactMap({ $0 }) where turn.end > now {
          yieldTurn(turn, now)
        }
      }
      if kept.isEmpty {
        tracks[owner] = nil
        voices[owner] = nil
      } else if kept.count != states.count {
        tracks[owner] = kept
      }
    }
    turns.removeAll { $0.end <= now - Self.memory }
  }
}
