# ios/AgentInterface/APIClient.swift
MUTANTS = [
    # A read that never reached the app says the draft is kept.
    ("      message: read\n", "      message: false\n"),
]
