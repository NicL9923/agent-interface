# ios/AgentInterface/AvatarView.swift
MUTANTS = [
    # The question mark comes back.
    ("    state != .disconnected\n      && (portrait", "    true\n      && (portrait"),
    # A lost connection dims as much as a stopped task.
    ("    case .disconnected: (0.45, 0.9)", "    case .disconnected: (0.25, 0.88)"),
]
