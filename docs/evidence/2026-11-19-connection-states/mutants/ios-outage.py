# ios/AgentInterface/ConnectionOutage.swift
MUTANTS = [
    # Grace one millisecond short.
    (
        "static let grace: Duration = .seconds(3)",
        "static let grace: Duration = .milliseconds(2_999)",
    ),
    # Lasting one millisecond early.
    (
        "static let lastingAfter: Duration = .seconds(10)",
        "static let lastingAfter: Duration = .milliseconds(9_999)",
    ),
    # The minimum second one millisecond short.
    (
        "static let minimumShown: Duration = .seconds(1)",
        "static let minimumShown: Duration = .milliseconds(999)",
    ),
    # A definite loss waits out the grace period like any other.
    (
        "phase: definite ? .shown : .grace, lasting: definite",
        "phase: .grace, lasting: definite",
    ),
    # A definite loss starts in its one-line form.
    (
        "phase: definite ? .shown : .grace, lasting: definite",
        "phase: definite ? .shown : .grace, lasting: false",
    ),
    # A loss that returns while its notice lingers is not the same outage.
    ("      case .lingering: held.phase = .shown\n", "      case .lingering: break\n"),
    # Becoming definite inside the grace period changes nothing.
    (
        "      case .grace where definite: held.phase = .shown; held.shownAt = now\n",
        "      case .grace where definite: break\n",
    ),
    # Becoming definite never explains the notice.
    (
        "      if definite { held.lasting = true }\n",
        "      if false { held.lasting = true }\n",
    ),
    # A loss that ends inside its grace period is kept.
    ("    case .grace: timed = nil\n", "    case .grace: break\n"),
    # Nothing counts as a recovery.
    ("      recoveries += 1\n", ""),
    # Nothing lingers.
    (
        "      if now - held.shownAt < Self.minimumShown { timed?.phase = .lingering } else { timed = nil }",
        "      timed = nil",
    ),
    # Another scope inherits the outage.
    ("    if let held = timed, held.scope != scope { timed = nil }\n", ""),
    # Lasting counted from when the notice was drawn.
    (
        "    case .shown: return held.lasting ? nil : held.since + Self.lastingAfter",
        "    case .shown: return held.lasting ? nil : held.shownAt + Self.lastingAfter",
    ),
    # The minimum second counted from when the loss began.
    (
        "    case .lingering: return held.shownAt + Self.minimumShown",
        "    case .lingering: return held.since + Self.minimumShown",
    ),
    # A late notice keeps the time it fell due as the moment it was drawn.
    (
        "      case .grace: held.phase = .shown; held.shownAt = now\n",
        "      case .grace: held.phase = .shown\n",
    ),
    # A deadline exactly reached is not taken.
    (
        "    while let due = deadline, due <= now, var held = timed {",
        "    while let due = deadline, due < now, var held = timed {",
    ),
    # A lingering notice is still news.
    ("  var spoken: Bool { shown && !lingering }", "  var spoken: Bool { shown }"),
    # The first retry two seconds after the failure.
    (
        "  static let delays: [Duration] = [1, 2, 4, 8, 16, 30].map",
        "  static let delays: [Duration] = [2, 2, 4, 8, 16, 30].map",
    ),
    # Retries one step behind.
    (
        "    delays[min(max(failures, 1), delays.count) - 1]",
        "    delays[min(failures, delays.count - 1)]",
    ),
]
