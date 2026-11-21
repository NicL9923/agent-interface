# ios/AgentInterface/AppStore+Sending.swift, the review's fixes
MUTANTS = [
    # Finding 1: retrying an uncertain send skips the connection.
    (
        "    guard let api, let id = selectedBotId, !sending, connected else { return }",
        "    guard let api, let id = selectedBotId, !sending else { return }",
    ),
    # Finding 1: a confirmed Stop posts after a loss.
    (
        "    guard selectedBotId == botId, connected else { return false }",
        "    guard selectedBotId == botId else { return false }",
    ),
    # Finding 1: a Stop for a chat no longer on screen posts.
    (
        "    guard selectedBotId == botId, connected else { return false }",
        "    guard connected else { return false }",
    ),
]
