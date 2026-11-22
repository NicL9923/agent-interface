# ios/AgentInterface/AppStore+Conversation.swift, the second review round's fixes
MUTANTS = [
    # Finding 2: a cancelled read never sets the retry it dropped again.
    ("      if readFailedFor == id, read == conversationReads {", "      if false {"),
    # Finding 2: a healthy chat's cancelled read sets a retry.
    (
        "      if readFailedFor == id, read == conversationReads {",
        "      if read == conversationReads {",
    ),
    # Finding 2: a cancelled read sets a retry though a newer read decides.
    (
        "      if readFailedFor == id, read == conversationReads {",
        "      if readFailedFor == id {",
    ),
]
