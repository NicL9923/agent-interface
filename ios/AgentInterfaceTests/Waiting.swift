import XCTest

/// How long a bounded wait gives a slow host, such as GitHub's macos-26 runner, before it gives up.
let waitDeadline: Duration = .seconds(10)

/// Polls `condition` until it holds or `timeout` passes, and returns whether it held. It runs on the
/// caller's actor, so the condition can read main-actor state directly.
func eventually(timeout: Duration = waitDeadline, isolation: isolated (any Actor)? = #isolation,
                _ condition: () -> Bool) async throws -> Bool {
    let deadline = ContinuousClock.now + timeout
    while !condition() {
        guard ContinuousClock.now < deadline else { return false }
        try await Task.sleep(for: .milliseconds(20))
    }
    return true
}

/// Waits for something to happen, then lets the test assert on it. A slower host gets time without a
/// fixed sleep, and the test fails here when the deadline passes first. Use it for every "wait, then
/// assert" step; keep a fixed sleep only to prove something does not happen.
func until(_ condition: () -> Bool, timeout: Duration = waitDeadline, isolation: isolated (any Actor)? = #isolation,
           file: StaticString = #filePath, line: UInt = #line) async throws {
    let held = try await eventually(timeout: timeout, isolation: isolation, condition)
    XCTAssertTrue(held, "Timed out after \(timeout) waiting for the condition", file: file, line: line)
}

/// Keeps fixed sleeps out of positive waits. A sleep that passes on the Mac mini can be too short on a
/// slow CI runner, so every remaining one must say on its line or the line before why it is fixed:
/// an absence check (nothing may happen in the window), a production timer it outlasts, or simulated
/// latency. Anything else belongs in `until`.
final class FixedWaitRuleTests: XCTestCase {
    func testEveryFixedSleepSaysWhyItIsNotABoundedWait() throws {
        let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" && $0.lastPathComponent != "Waiting.swift" }
        XCTAssertFalse(files.isEmpty, "The test sources are readable from \(directory.path)")
        // Every way Swift test code can block for a fixed time: Task.sleep with or without generic
        // arguments, Task.sleep(until:), usleep, sleep, Thread.sleep and Darwin.sleep.
        let sleep = /Task(<[^>]*>)?\.sleep\b|\busleep\(|(^|[^.\w])sleep\(|Thread\.sleep\b|Darwin\.sleep\(/
        let reason = /\/\/.*\b([Aa]bsence|[Tt]imer|[Ll]atency)\b/
        var unexplained: [String] = []
        for file in files {
            let lines = try String(contentsOf: file, encoding: .utf8).components(separatedBy: "\n")
            for (index, line) in lines.enumerated() where line.contains(sleep) {
                let previous = index > 0 ? lines[index - 1] : ""
                if !line.contains(reason) && !previous.contains(reason) {
                    unexplained.append("\(file.lastPathComponent):\(index + 1): \(line.trimmingCharacters(in: .whitespaces))")
                }
            }
        }
        for spelling in ["try await Task.sleep(for: .seconds(1))", "try await Task<Never, Never>.sleep(nanoseconds: 1)",
                         "try await Task.sleep(until: .now + .seconds(1))", "usleep(100)", "sleep(1)", "Darwin.sleep(1)",
                         "Thread.sleep(forTimeInterval: 1)"] {
            XCTAssertTrue(spelling.contains(sleep), "The rule recognizes \(spelling)")
        }
        XCTAssertFalse("value.sleepingSince = now".contains(sleep), "A property named sleep... is not a sleep")
        XCTAssertEqual(unexplained, [], """
            Wait for an outcome with `try await until { ... }`. A fixed sleep that only proves nothing \
            happens needs an "Absence", "Timer" or "Latency" comment on its line or the line before.
            """)
    }
}
