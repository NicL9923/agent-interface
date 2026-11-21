# ios/AgentInterface/StoreRequests.swift, the second review round's fixes
MUTANTS = [
    # Finding 6: a household write starts without checking the connection.
    ("    if household, !householdReachable {", "    if false {"),
    # Finding 6: a refused household write takes the write's own failure wording.
    (
        "message.wrappedValue = error is ConnectionRefused ? error.localizedDescription : failure(error)",
        "message.wrappedValue = failure(error)",
    ),
    # Finding 6: `run` drops the household check on its way to `attempt`.
    (
        "attempt(busy: busy, household: household, current: current, work)",
        "attempt(busy: busy, current: current, work)",
    ),
]
