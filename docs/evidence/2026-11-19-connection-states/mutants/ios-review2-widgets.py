# ios/AgentInterface/WidgetSync.swift, the second review round's fixes
MUTANTS = [
    # Finding 4: a down roster that lists nobody empties the widgets.
    (
        "        guard var pruned = stored, !bootstrap.bots.isEmpty else { return }",
        "        guard var pruned = stored else { return }",
    ),
    # Finding 4: the widgets keep an assistant that left.
    ("        pruned.assistants.removeAll { !listed.contains($0.id) }\n", ""),
    # Finding 4: Spotlight and Siri keep it.
    ("        syncSystemSearch(pruned)\n", ""),
    # Finding 4: its notification picture stays.
    ("        syncSenderAvatars(bootstrap)\n        return", "        return"),
]
