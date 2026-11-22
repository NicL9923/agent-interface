import Foundation

/// When a lost connection goes on screen, ported from the web's `src/app/outage.ts`.
///
/// Most losses end inside the grace period: a deploy's restart, a network handoff, a phone waking
/// before its radio does. Actions that need the connection are refused from the first moment
/// (`AppStore.connected`); only the notice, the dimmed assistants and the announcement wait.
///
/// It is a value with no clock of its own. `update` takes each change of `down`, `advance` takes
/// each deadline the owner's timer reaches, and both are given the time. A timer that runs late,
/// as in a suspended app, moves each step later and skips none.
///
/// The web needs a "due" step between the grace period and the notice, because a React render and
/// its effects can see different moments. Here every change runs on the main actor one at a time,
/// so a loss whose grace period has passed is shown by the same call that finds it still down.
struct Outage: Equatable {
  typealias Instant = ContinuousClock.Instant
  /// How long a loss stays off the screen.
  static let grace: Duration = .seconds(3)
  /// How long a loss lasts before the notice adds its reason, a retry and details. Until then it
  /// is one plain line, because the app is already retrying and there is nothing for the person to do.
  static let lastingAfter: Duration = .seconds(10)
  /// The least time a notice stays once it shows, so one answered right after never flashes.
  static let minimumShown: Duration = .seconds(1)

  private enum Phase: Equatable { case grace, shown, lingering }
  /// One outage: whose it is, where it stands, when it began and when it was drawn.
  private struct Timed: Equatable {
    var scope: String
    var phase: Phase
    var lasting: Bool
    var since: Instant
    var shownAt: Instant
  }
  private var timed: Timed?
  /// How many losses that were on screen have ended because the connection came back. One that
  /// never showed, or was left behind with its scope, is not counted: nothing came back that anyone
  /// was told was gone.
  private(set) var recoveries = 0

  /// The loss is on screen, which it still is for its minimum time after it ends.
  var shown: Bool { timed.map { $0.phase != .grace } ?? false }
  /// It has gone on long enough, or is certain enough, to explain itself and offer a retry.
  var lasting: Bool { shown && timed?.lasting == true }
  /// The loss is over, and its notice is only staying out its minimum time.
  var lingering: Bool { timed?.phase == .lingering }
  /// A loss is being timed and is not on screen yet.
  var pending: Bool { timed?.phase == .grace }
  /// The loss itself, without the second its notice lingers: what VoiceOver is told.
  var spoken: Bool { shown && !lingering }

  /// `down` is whether the thing is lost now. A `definite` loss, which waiting cannot fix or which
  /// never worked in this session, shows at once and counts as lasting. `scope` names what the loss
  /// is a loss of, such as the open chat: when it changes, the outage being timed is dropped, so its
  /// notice does not linger over the next scope and nothing counts as a recovery.
  mutating func update(down: Bool, definite: Bool = false, scope: String = "", at now: Instant) {
    if let held = timed, held.scope != scope { timed = nil }
    if down {
      guard var held = timed else {
        timed = Timed(scope: scope, phase: definite ? .shown : .grace, lasting: definite, since: now, shownAt: now)
        return
      }
      switch held.phase {
      // Down again while its notice lingers is the same outage going on, timed from when it began.
      case .lingering: held.phase = .shown
      // Certain before its grace period ended: it stops waiting.
      case .grace where definite: held.phase = .shown; held.shownAt = now
      default: break
      }
      // Becoming certain explains a notice already on screen; its minimum time still counts from
      // when it was drawn. A loss that stops being certain keeps the form it has.
      if definite { held.lasting = true }
      timed = held
      return
    }
    guard let held = timed else { return }
    switch held.phase {
    // Never shown, so simply over. A loss that ends as its grace period does is not drawn now.
    case .grace: timed = nil
    case .lingering: break
    case .shown:
      recoveries += 1
      if now - held.shownAt < Self.minimumShown { timed?.phase = .lingering } else { timed = nil }
    }
  }
  /// When the next step falls due, or nil when nothing waits on the clock.
  var deadline: Instant? {
    guard let held = timed else { return nil }
    switch held.phase {
    case .grace: return held.since + Self.grace
    case .shown: return held.lasting ? nil : held.since + Self.lastingAfter
    case .lingering: return held.shownAt + Self.minimumShown
    }
  }
  /// Takes every step whose time has come by `now`. The grace period exists only while the loss is
  /// down, so ending it shows the loss, and its minimum time counts from now, when it is drawn.
  mutating func advance(to now: Instant) {
    while let due = deadline, due <= now, var held = timed {
      switch held.phase {
      case .grace: held.phase = .shown; held.shownAt = now
      case .shown: held.lasting = true
      case .lingering: timed = nil; continue
      }
      timed = held
    }
  }
}

/// How long after each failure in a row the app reads again, as the web's `READ_RETRY_MS`. The last
/// wait repeats while reads keep failing. The poll loop waits the same after failed bootstraps.
enum ReadRetry {
  static let delays: [Duration] = [1, 2, 4, 8, 16, 30].map { .seconds($0) }
  /// The wait after `failures` failed reads in a row. Zero failures has no wait of its own.
  static func delay(after failures: Int) -> Duration {
    delays[min(max(failures, 1), delays.count) - 1]
  }
}
