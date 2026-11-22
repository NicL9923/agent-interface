# ios/AgentInterface/Models.swift
MUTANTS = [
    # Home captions every assistant "Connection lost".
    (
        "  var captioned: Bool { ![.idle, .done, .disconnected].contains(self) }",
        "  var captioned: Bool { ![.idle, .done].contains(self) }",
    ),
]
