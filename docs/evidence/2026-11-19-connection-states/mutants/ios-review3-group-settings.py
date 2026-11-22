# ios/AgentInterface/GroupSettingsView.swift, the third review round's fixes
MUTANTS = [
    # Finding 9: a room's settings Save does not check the household.
    (
        "    await run(busy: busy, error: error, household: true) {",
        "    await run(busy: busy, error: error) {",
    ),
]
