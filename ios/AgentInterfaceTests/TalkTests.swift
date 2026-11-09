import XCTest

@testable import AgentInterface

/// Records what the tool loop asks of its host, and answers asks from a queue the test sets.
@MainActor private final class LoopHost: TalkLoopHost {
  var sent: [[String: Any]] = []
  var phases: [TalkPhase] = []
  var shown: [TalkCaptions] = []
  var problems: [String] = []
  var asks: [(id: String, request: String)] = []
  var answers: [Result<TalkAnswer, Error>] = []
  var activity_ = 0
  private var ids = 0
  func send(_ event: [String: Any]) { sent.append(event) }
  func ask(requestId: String, request: String) async throws -> TalkAnswer {
    asks.append((requestId, request))
    guard !answers.isEmpty else { throw Refused() }
    return try answers.removeFirst().get()
  }
  func phase(_ phase: TalkPhase) { phases.append(phase) }
  func captions(_ captions: TalkCaptions) { shown.append(captions) }
  func activity() { activity_ += 1 }
  func problem(_ message: String) { problems.append(message) }
  func newId() -> String { ids += 1; return "00000000-0000-4000-8000-00000000000\(ids)" }
  var types: [String] { sent.map { $0["type"] as? String ?? "" } }
  /// The text of each conversation item sent, function outputs and system notes alike.
  var items: [String] {
    sent.compactMap { event in
      guard let item = event["item"] as? [String: Any] else { return nil }
      if let output = item["output"] as? String { return output }
      return ((item["content"] as? [[String: Any]])?.first?["text"] as? String)
    }
  }
}

private struct Refused: LocalizedError { var errorDescription: String? { "Talk is not allowed here." } }

@MainActor final class TalkLoopTests: XCTestCase {
  private func loop(_ host: LoopHost, sleeps: @escaping (Duration) async throws -> Void = { _ in }) -> TalkLoop {
    TalkLoop(host: host, name: "Ranch", sleep: sleeps)
  }
  private func call(_ arguments: String, id: String = "call-1", name: String = TalkLoop.tool) -> [String: Any] {
    ["type": "response.function_call_arguments.done", "name": name, "call_id": id, "arguments": arguments]
  }

  func testAResponseRequestedWhileOneIsActiveWaitsForItToEnd() {
    let host = LoopHost(), loop = loop(host)
    loop.respond()
    loop.respond()
    XCTAssertEqual(host.types, ["response.create"], "A second response.create while one is active would fail")
    loop.handle(["type": "response.done"])
    XCTAssertEqual(host.types, ["response.create", "response.create"])
  }

  func testARaceWithTheServersOwnResponseQueuesInsteadOfShowingAProblem() {
    let host = LoopHost(), loop = loop(host)
    loop.handle(["type": "response.created"])
    loop.handle(["type": "error", "error": ["code": "conversation_already_has_active_response", "message": "busy"]])
    XCTAssertTrue(host.problems.isEmpty)
    loop.handle(["type": "response.done"])
    XCTAssertEqual(host.types, ["response.create"], "The queued response goes once the active one ends")
    loop.handle(["type": "error", "error": ["code": "server_error", "message": "The voice model failed."]])
    XCTAssertEqual(host.problems, ["The voice model failed."])
  }

  func testCaptionsKeepTheLatestWordsFromEachSide() {
    let host = LoopHost(), loop = loop(host)
    loop.handle(["type": "conversation.item.input_audio_transcription.completed", "transcript": "  Is the gate shut? "])
    loop.handle(["type": "response.output_audio_transcript.delta", "delta": "Let me "])
    loop.handle(["type": "response.output_audio_transcript.delta", "delta": "check."])
    XCTAssertEqual(host.shown.last, TalkCaptions(you: "Is the gate shut?", assistant: "Let me check."))
    XCTAssertEqual(host.phases.last, .speaking)
    loop.handle(["type": "response.output_audio_transcript.done", "transcript": "Let me check."])
    // A new response starts a new caption instead of running on from the last.
    loop.handle(["type": "response.output_audio_transcript.delta", "delta": "It is shut."])
    XCTAssertEqual(host.shown.last?.assistant, "It is shut.")
  }

  func testASpokenRequestIsAskedOnceAndItsAnswerSpoken() async throws {
    let host = LoopHost(), loop = loop(host)
    host.answers = [.success(TalkAnswer(state: .done, text: "The gate is shut."))]
    loop.handle(call(#"{"request":" Is the gate shut? "}"#))
    try await until { host.types.contains("conversation.item.create") }
    XCTAssertEqual(host.asks.map(\.request), ["Is the gate shut?"])
    XCTAssertEqual(host.items, ["Ranch answered: The gate is shut."])
    XCTAssertEqual((host.sent.first?["item"] as? [String: Any])?["call_id"] as? String, "call-1")
    XCTAssertEqual(host.types.last, "response.create")
    XCTAssertEqual(host.phases.first, .working)
  }

  func testAnEmptyOrUnreadableRequestIsNeverSent() async throws {
    for arguments in ["not json", #"{"request":"   "}"#, #"{"other":"x"}"#] {
      let host = LoopHost(), loop = loop(host)
      loop.handle(call(arguments))
      try await until { !host.items.isEmpty }
      XCTAssertTrue(host.asks.isEmpty, arguments)
      XCTAssertEqual(host.items, ["No request was given. Ask the person what they need."], arguments)
    }
  }

  func testAnotherToolIsRefusedWithoutAsking() {
    let host = LoopHost(), loop = loop(host)
    loop.handle(call(#"{"request":"x"}"#, name: "search_web"))
    XCTAssertTrue(host.asks.isEmpty)
    XCTAssertEqual(host.items, ["That tool is not available. Answer without it."])
  }

  func testWorkStillRunningIsFollowedWithTheSameRequestIdUntilItEnds() async throws {
    let host = LoopHost()
    var pauses: [Duration] = []
    let loop = loop(host, sleeps: { pauses.append($0) })
    host.answers = [.success(TalkAnswer(state: .working)), .success(TalkAnswer(state: .working)),
      .success(TalkAnswer(state: .needsApproval, text: "Delete the logs")), .success(TalkAnswer(state: .done, text: "Done."))]
    loop.handle(call(#"{"request":"Clean up the logs"}"#))
    try await until { host.asks.count == 4 && host.items.count == 3 }
    XCTAssertEqual(Set(host.asks.map(\.id)).count, 1, "Following never sends the request again under a new ID")
    XCTAssertEqual(pauses, [TalkLoop.follow, TalkLoop.follow, TalkLoop.decisionFollow])
    XCTAssertEqual(host.items[0], "Ranch is still working on it. Tell the person the answer will follow, then wait.")
    XCTAssertTrue(host.items[1].contains("waiting for an approval on screen: Delete the logs"), host.items[1])
    XCTAssertTrue(host.items[2].hasSuffix("Ranch answered: Done. Tell the person now, briefly."), host.items[2])
    XCTAssertEqual(host.items.count, 3, "A repeated working state is not announced again")
  }

  func testAFailureBeforeAnAnswerAnswersTheCallAndAfterOneIsSaidSeparately() async throws {
    let first = LoopHost(), loop1 = loop(first)
    first.answers = [.failure(Refused())]
    loop1.handle(call(#"{"request":"x"}"#))
    try await until { !first.items.isEmpty }
    XCTAssertEqual((first.sent.first?["item"] as? [String: Any])?["type"] as? String, "function_call_output")
    XCTAssertTrue(first.items[0].contains("could not reach Ranch: Talk is not allowed here."), first.items[0])

    let second = LoopHost(), loop2 = loop(second)
    second.answers = [.success(TalkAnswer(state: .working)), .failure(Refused())]
    loop2.handle(call(#"{"request":"x"}"#))
    try await until { second.items.count == 2 }
    let note = second.sent.compactMap { $0["item"] as? [String: Any] }.last
    XCTAssertEqual(note?["type"] as? String, "message", "A call is answered once; a later failure is a new message")
    XCTAssertEqual(note?["role"] as? String, "system")
  }

  func testDisposingStopsFollowingWithoutAnotherWord() async throws {
    let host = LoopHost()
    let gate = AsyncStream<Void>.makeStream()
    let loop = loop(host, sleeps: { _ in for await _ in gate.stream { return } })
    host.answers = [.success(TalkAnswer(state: .working)), .success(TalkAnswer(state: .done, text: "late"))]
    loop.handle(call(#"{"request":"x"}"#))
    try await until { host.items.count == 1 }
    loop.dispose()
    gate.continuation.yield()
    gate.continuation.finish()
    // An absence check: nothing may be sent after Talk ended.
    try await Task.sleep(for: .milliseconds(100))
    XCTAssertEqual(host.items.count, 1)
    XCTAssertEqual(host.asks.count, 1)
  }
}

final class TalkPlaybackTests: XCTestCase {
  func testAnItemQueuedBehindAnotherLeavesTheFirstToBeCutWhereItPlays() {
    var ledger = TalkPlaybackLedger()
    // A filler plays from 0 to 24,000 (one second); the answer queues behind it.
    ledger.schedule(item: "filler", frames: 24_000, at: 0)
    ledger.schedule(item: "answer", frames: 48_000, at: 12_000)
    XCTAssertEqual(ledger.unheard(at: 18_000), [.init(item: "filler", milliseconds: 750), .init(item: "answer", milliseconds: 0)],
      "The filler is cut where it plays, and the answer never reached is cut to nothing")
    XCTAssertEqual(ledger.unheard(at: 36_000), [.init(item: "answer", milliseconds: 500)])
    XCTAssertEqual(ledger.unheard(at: 72_000), [], "Finished audio needs no truncation")
  }

  func testSilenceWhileThePlayerRanDryIsNotHeard() {
    var ledger = TalkPlaybackLedger()
    // 100 ms of one item, a 900 ms stall, then 100 ms more of the same item.
    ledger.schedule(item: "a", frames: 2_400, at: 0)
    ledger.schedule(item: "a", frames: 2_400, at: 24_000)
    XCTAssertEqual(ledger.unheard(at: 25_200), [.init(item: "a", milliseconds: 150)])
    ledger.reset()
    XCTAssertEqual(ledger.unheard(at: 25_200), [])
  }

  func testPCMBecomesFloatsLittleEndian() {
    let samples: [Int16] = [0, 16_384, -32_768, 32_767]
    let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
    XCTAssertEqual(TalkPCM.floats(data), [0, 0.5, -1, Float(32_767) / 32_768])
    XCTAssertEqual(TalkPCM.floats(Data([1])), [], "A half sample is dropped")
  }

  @MainActor func testTheSocketSendsOnlyTheSecretToOpenAI() {
    let request = RealtimeSocket.request(secret: "ek_test", model: "gpt-realtime-2.1")
    XCTAssertEqual(request.url?.absoluteString, "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1")
    XCTAssertEqual(request.allHTTPHeaderFields, ["Authorization": "Bearer ek_test"])
  }
}

/// A Realtime connection the test drives.
@MainActor private final class FakeSocket: TalkTransport {
  var opened: (secret: String, model: String)?
  var sent: [[String: Any]] = []
  var closes = 0
  private var event: (@MainActor (String) -> Void)?
  private var closed: (@MainActor (String) -> Void)?
  func open(secret: String, model: String, event: @escaping @MainActor (String) -> Void, closed: @escaping @MainActor (String) -> Void) {
    opened = (secret, model); self.event = event; self.closed = closed
  }
  func send(_ text: String) {
    if let value = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] { sent.append(value) }
  }
  func close() { closes += 1 }
  func emit(_ value: [String: Any]) { event?(String(data: try! JSONSerialization.data(withJSONObject: value), encoding: .utf8)!) }
  func drop(_ message: String) { closed?(message) }
}

@MainActor private final class FakeAudio: TalkAudioIO {
  var starts = 0, stops = 0
  var played: [(Data, String)] = []
  var muted: Bool?
  var heard: [TalkPlaybackLedger.Heard] = []
  var chunk: (@Sendable (Data) -> Void)?
  var failed: (@MainActor (String) -> Void)?
  var cut: (@MainActor ([TalkPlaybackLedger.Heard]) -> Void)?
  var refuse: Error?
  func start(chunk: @escaping @Sendable (Data) -> Void, failed: @escaping @MainActor (String) -> Void,
    cut: @escaping @MainActor ([TalkPlaybackLedger.Heard]) -> Void) throws {
    if let refuse { throw refuse }
    starts += 1; self.chunk = chunk; self.failed = failed; self.cut = cut
  }
  func play(_ pcm: Data, item: String) { played.append((pcm, item)) }
  func interrupt() -> [TalkPlaybackLedger.Heard] { defer { heard = [] }; return heard }
  func setMuted(_ muted: Bool) { self.muted = muted }
  func stop() { stops += 1 }
}

@MainActor final class TalkControllerTests: XCTestCase {
  private let session = #"{"clientSecret":"ek_fixture","expiresAt":1790000000,"model":"gpt-realtime-2.1","voice":"cedar"}"#

  override func setUp() async throws { MicrophoneOwnership.shared.owner = nil }
  override func tearDown() async throws { MicrophoneOwnership.shared.owner = nil }

  private func talk(_ server: FakeServer, socket: FakeSocket, audio: FakeAudio, allowed: Bool = true,
    clock: @escaping () -> Date = Date.init, sleep: @escaping (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) -> TalkController {
    let talk = TalkController()
    talk.api = server.api()
    talk.botId = "ranch hand"
    talk.botName = "Ranch"
    talk.makeTransport = { socket }
    talk.makeAudio = { audio }
    talk.permission = { allowed }
    talk.now = clock
    talk.sleep = sleep
    return talk
  }

  func testStartMintsASessionOpensTheVoiceAndOnlyThenTheMicrophone() async throws {
    let server = FakeServer { _ in .init(body: self.session) }
    let socket = FakeSocket(), audio = FakeAudio()
    let talk = talk(server, socket: socket, audio: audio)
    talk.start()
    XCTAssertEqual(talk.status, .connecting)
    XCTAssertNotNil(MicrophoneOwnership.shared.owner, "Talk owns the microphone, so recording and read aloud wait")
    try await until { socket.opened != nil }
    XCTAssertEqual(server.lastRequest?.url?.absoluteString.hasSuffix("/api/bots/ranch%20hand/talk/session"), true, "The assistant's ID is one escaped path segment")
    XCTAssertEqual(server.lastRequest?.httpMethod, "POST")
    XCTAssertEqual(socket.opened?.secret, "ek_fixture")
    XCTAssertEqual(socket.opened?.model, "gpt-realtime-2.1")
    XCTAssertEqual(audio.starts, 0, "No audio goes out before the voice session exists")
    socket.emit(["type": "session.created"])
    XCTAssertEqual(audio.starts, 1)
    XCTAssertEqual(talk.status, .live(.listening))
    audio.chunk?(Data([1, 0, 2, 0]))
    try await until { !socket.sent.isEmpty }
    XCTAssertEqual(socket.sent.first?["type"] as? String, "input_audio_buffer.append")
    XCTAssertEqual(socket.sent.first?["audio"] as? String, Data([1, 0, 2, 0]).base64EncodedString())
  }

  func testTheVoiceIsPlayedAndInterruptedSpeechIsTruncatedToWhatWasHeard() async throws {
    let server = FakeServer { _ in .init(body: self.session) }
    let socket = FakeSocket(), audio = FakeAudio()
    let talk = talk(server, socket: socket, audio: audio)
    talk.start()
    try await until { socket.opened != nil }
    socket.emit(["type": "session.created"])
    socket.emit(["type": "response.output_audio.delta", "item_id": "item-7", "delta": Data([0, 64]).base64EncodedString()])
    XCTAssertEqual(audio.played.first?.1, "item-7")
    XCTAssertEqual(audio.played.first?.0, Data([0, 64]))
    audio.heard = [.init(item: "item-7", milliseconds: 1_250), .init(item: "item-8", milliseconds: 0)]
    socket.emit(["type": "input_audio_buffer.speech_started"])
    let truncates = socket.sent.filter { $0["type"] as? String == "conversation.item.truncate" }
    XCTAssertEqual(truncates.map { $0["item_id"] as? String }, ["item-7", "item-8"], "A queued item the person never reached is cut too")
    XCTAssertEqual(truncates.map { $0["audio_end_ms"] as? Int }, [1_250, 0])
    XCTAssertEqual(truncates.first?["content_index"] as? Int, 0)
    // Speech with nothing playing truncates nothing.
    socket.emit(["type": "input_audio_buffer.speech_started"])
    XCTAssertEqual(socket.sent.filter { $0["type"] as? String == "conversation.item.truncate" }.count, 2)
    // A headset change that dropped queued voice tells the model what was heard, and Talk goes on.
    audio.cut?([.init(item: "item-9", milliseconds: 400)])
    XCTAssertEqual(socket.sent.last?["item_id"] as? String, "item-9")
    XCTAssertEqual(socket.sent.last?["audio_end_ms"] as? Int, 400)
    XCTAssertTrue(talk.live)
  }

  func testMuteAndEndReleaseEverything() async throws {
    let server = FakeServer { _ in .init(body: self.session) }
    let socket = FakeSocket(), audio = FakeAudio()
    let talk = talk(server, socket: socket, audio: audio)
    talk.start()
    try await until { socket.opened != nil }
    socket.emit(["type": "session.created"])
    talk.toggleMute()
    XCTAssertEqual(audio.muted, true)
    XCTAssertTrue(talk.muted)
    talk.end()
    XCTAssertEqual(talk.status, .idle)
    XCTAssertFalse(talk.muted)
    XCTAssertEqual(socket.closes, 1)
    XCTAssertEqual(audio.stops, 1)
    XCTAssertNil(MicrophoneOwnership.shared.owner)
    // A late event from the ended run changes nothing.
    socket.emit(["type": "response.created"])
    XCTAssertEqual(talk.status, .idle)
  }

  func testEachRefusalSaysWhyAndHoldsNothing() async throws {
    let denied = FakeServer { _ in .init(body: self.session) }, socket = FakeSocket(), audio = FakeAudio()
    let first = talk(denied, socket: socket, audio: audio, allowed: false)
    first.start()
    try await until { first.status == .idle }
    XCTAssertEqual(first.error, "Microphone permission was denied. Allow it in iOS Settings, then start Talk again.")
    XCTAssertTrue(denied.requests.isEmpty, "No session is minted without the microphone")
    XCTAssertNil(MicrophoneOwnership.shared.owner)

    let signedOut = FakeServer { _ in .init(status: 409, body: #"{"error":"Sign in to ChatGPT in Hermes to use live Talk."}"#) }
    let second = talk(signedOut, socket: socket, audio: audio)
    second.start()
    try await until { second.status == .idle }
    XCTAssertEqual(second.error, "Sign in to ChatGPT in Hermes to use live Talk.")
    XCTAssertNil(socket.opened)

    let server = FakeServer { _ in .init(body: self.session) }
    let broken = FakeAudio(); broken.refuse = APIError(message: "No microphone was found. Connect one, then start Talk again.", status: 0)
    let third = talk(server, socket: socket, audio: broken)
    third.start()
    try await until { socket.opened != nil }
    socket.emit(["type": "session.created"])
    XCTAssertEqual(third.error, "No microphone was found. Connect one, then start Talk again.")
    XCTAssertEqual(third.status, .idle)
    XCTAssertGreaterThan(socket.closes, 0)
    XCTAssertNil(MicrophoneOwnership.shared.owner)
  }

  func testADroppedConnectionOrLostAudioEndsTalkWithItsReason() async throws {
    let server = FakeServer { _ in .init(body: self.session) }
    let socket = FakeSocket(), audio = FakeAudio()
    let talk = talk(server, socket: socket, audio: audio)
    talk.start()
    try await until { socket.opened != nil }
    socket.emit(["type": "session.created"])
    socket.drop("The voice connection closed. Start Talk again.")
    XCTAssertEqual(talk.status, .idle)
    XCTAssertEqual(talk.error, "The voice connection closed. Start Talk again.")

    socket.opened = nil
    talk.start()
    try await until { socket.opened != nil }
    socket.emit(["type": "session.created"])
    audio.failed?("Talk ended when another app took the audio.")
    XCTAssertEqual(talk.status, .idle)
    XCTAssertEqual(talk.error, "Talk ended when another app took the audio.")
  }

  func testEndingWhileTheSessionIsMintedNeverOpensTheVoice() async throws {
    let server = FakeServer { _ in .init(body: self.session) }
    let release = server.hold(path: "/api/bots/ranch hand/talk/session")
    let socket = FakeSocket(), audio = FakeAudio()
    let talk = talk(server, socket: socket, audio: audio)
    talk.start()
    try await until { !server.requests.isEmpty }
    talk.end()
    release()
    // An absence check: the stale session must not open a connection.
    try await Task.sleep(for: .milliseconds(200))
    XCTAssertNil(socket.opened)
    XCTAssertEqual(talk.status, .idle)
  }

  func testQuietAndLongTalksEndByThemselves() async throws {
    for (quiet, notice) in [(true, "Talk ended after five quiet minutes."), (false, "Talk ended after 30 minutes. Start it again to keep talking.")] {
      let server = FakeServer { _ in .init(body: self.session) }
      let socket = FakeSocket(), audio = FakeAudio()
      var clock = Date(timeIntervalSince1970: 1_800_000_000)
      let ticks = AsyncStream<Void>.makeStream()
      let talk = talk(server, socket: socket, audio: audio, clock: { clock }, sleep: { _ in
        for await _ in ticks.stream { return }
        throw CancellationError()
      })
      talk.start()
      try await until { socket.opened != nil }
      socket.emit(["type": "session.created"])
      if !quiet {
        // Speaking every few minutes keeps it open until the hard limit.
        for _ in 0..<7 {
          clock += 4 * 60
          socket.emit(["type": "input_audio_buffer.speech_started"])
          ticks.continuation.yield()
          try await Task.sleep(for: .milliseconds(20))
          XCTAssertTrue(talk.live)
        }
        clock += 3 * 60
      } else {
        clock += 4 * 60 + 59
        ticks.continuation.yield()
        // An absence check: just under five minutes must not end it.
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(talk.live)
        clock += 1
      }
      ticks.continuation.yield()
      try await until { !talk.live }
      XCTAssertEqual(talk.notice, notice)
      XCTAssertEqual(talk.error, "")
      ticks.continuation.finish()
    }
  }

  func testRecordingOrReadAloudHoldingTheMicrophoneKeepsTalkFromStarting() {
    let server = FakeServer { _ in .init(body: self.session) }
    let talk = talk(server, socket: FakeSocket(), audio: FakeAudio())
    MicrophoneOwnership.shared.owner = UUID()
    talk.start()
    XCTAssertEqual(talk.status, .idle)
    XCTAssertTrue(server.requests.isEmpty)
  }

  func testStartingTalkStopsAReplyBeingReadAloud() {
    let server = FakeServer { _ in .init(body: self.session) }
    let talk = talk(server, socket: FakeSocket(), audio: FakeAudio())
    var stopped = false
    MicrophoneOwnership.shared.stopPlayback = { stopped = true }
    defer { MicrophoneOwnership.shared.stopPlayback = nil }
    talk.start()
    XCTAssertTrue(stopped)
  }
}
