import AVFoundation
import Foundation

/// A live spoken conversation with one assistant, as the web's `useTalk`. The app server mints a
/// short-lived secret, the app streams the microphone to OpenAI's Realtime voice model over a
/// WebSocket, and each spoken request goes to the assistant as the person's own message. It owns
/// the microphone and speaker while it runs, so recording and reading replies aloud wait. It keeps
/// going with the screen locked, and ends on End, another assistant, leaving the chat, five quiet
/// minutes, 30 minutes, or another app taking the audio.
@MainActor @Observable final class TalkController {
  enum Status: Equatable {
    case idle, connecting
    case live(TalkPhase)
  }
  static let idleLimit: TimeInterval = 5 * 60
  static let maxLength: TimeInterval = 30 * 60
  static let checkEvery: Duration = .seconds(10)
  #if DEBUG
    /// UI tests talk to a scripted voice instead of the microphone and OpenAI.
    static var fixture = false
  #endif

  private(set) var status = Status.idle
  private(set) var captions = TalkCaptions()
  private(set) var muted = false
  /// Why Talk could not start or stopped. It stays until the next start or dismiss.
  private(set) var error = ""
  /// Why Talk ended by itself, such as a quiet spell.
  private(set) var notice = ""
  var live: Bool { status != .idle }

  @ObservationIgnored var api: APIClient?
  @ObservationIgnored var botId = ""
  @ObservationIgnored var botName = ""
  @ObservationIgnored var makeTransport: @MainActor () -> TalkTransport = { RealtimeSocket() }
  @ObservationIgnored var makeAudio: @MainActor () -> TalkAudioIO = { TalkEngine() }
  @ObservationIgnored var permission: @MainActor () async -> Bool = { await AVAudioApplication.requestRecordPermission() }
  @ObservationIgnored var now: () -> Date = Date.init
  @ObservationIgnored var sleep: (Duration) async throws -> Void = { try await Task.sleep(for: $0) }

  @ObservationIgnored private var generation = 0
  @ObservationIgnored private var transport: TalkTransport?
  @ObservationIgnored private var audio: TalkAudioIO?
  @ObservationIgnored private var loop: TalkLoop?
  @ObservationIgnored private var host: Host?
  @ObservationIgnored private var starting: Task<Void, Never>?
  @ObservationIgnored private var timer: Task<Void, Never>?
  @ObservationIgnored private var started = Date.distantPast
  @ObservationIgnored private var heard = Date.distantPast
  @ObservationIgnored private let owner = UUID()
  /// Voice items cut short, whose late audio is dropped.
  @ObservationIgnored private var cutItems: Set<String> = []
  /// Which response each voice item belongs to, and the responses still generating.
  @ObservationIgnored private var itemResponses: [String: String] = [:]
  @ObservationIgnored private var activeResponses: Set<String> = []

  init() {
    #if DEBUG
      if Self.fixture {
        makeTransport = { FixtureTalk.shared }
        makeAudio = { FixtureTalk.shared }
        permission = { true }
      }
    #endif
  }

  func start() {
    guard status == .idle, let api else { return }
    let microphone = MicrophoneOwnership.shared
    guard microphone.owner == nil || microphone.owner == owner else { return }
    generation += 1
    let run = generation
    // The microphone and speaker now belong to Talk: no recording, no reply read aloud.
    microphone.stopPlayback?()
    microphone.owner = owner
    error = ""; notice = ""; captions = TalkCaptions(); muted = false
    status = .connecting
    let botId = botId, name = botName
    starting = Task { [weak self] in
      guard let self else { return }
      guard await permission() else {
        if generation == run { fail("Microphone permission was denied. Allow it in iOS Settings, then start Talk again.") }
        return
      }
      guard generation == run else { return }
      do {
        let session: TalkSession = try await api.write("/bots/\(APIClient.component(botId))/talk/session", [String: String]())
        guard generation == run else { return }
        connect(session, name: name, run: run)
      } catch {
        guard generation == run, !(error is CancellationError) else { return }
        fail((error as? APIError)?.message ?? "Talk could not start. Try again, or type your message.")
      }
    }
  }

  private func connect(_ session: TalkSession, name: String, run: Int) {
    guard let api else { return }
    let transport = makeTransport()
    let host = Host(controller: self, api: api, botId: botId, run: run, transport: transport)
    self.transport = transport
    self.host = host
    loop = TalkLoop(host: host, name: name, now: now, sleep: sleep)
    transport.open(secret: session.clientSecret, model: session.model,
      event: { [weak self] text in self?.receive(text, run: run) },
      closed: { [weak self] message in
        guard let self, generation == run else { return }
        fail(message)
      })
  }

  /// Opens the microphone once the voice session exists, so no audio goes out before it is configured.
  private func open(run: Int) {
    guard audio == nil, let transport else { return }
    let audio = makeAudio()
    self.audio = audio
    do {
      try audio.start(
        chunk: { [weak transport] pcm in
          let event = #"{"type":"input_audio_buffer.append","audio":""# + pcm.base64EncodedString() + #""}"#
          Task { @MainActor in transport?.send(event) }
        },
        failed: { [weak self] message in
          guard let self, generation == run else { return }
          fail(message)
        },
        cut: { [weak self] lost in
          guard let self, generation == run else { return }
          // Nothing told the model to stop, as speech does, so the response is cancelled too.
          truncate(lost, cancel: true)
        })
    } catch {
      fail((error as? APIError)?.message ?? "The microphone could not start. Close other apps using it, then try again.")
      return
    }
    audio.setMuted(muted)
    started = now(); heard = started
    status = .live(.listening)
    timer = Task { [weak self] in
      while !Task.isCancelled {
        guard let pause = self?.sleep else { return }
        do { try await pause(Self.checkEvery) } catch { return }
        guard let self, generation == run else { return }
        let at = now()
        if at.timeIntervalSince(started) >= Self.maxLength { end("Talk ended after 30 minutes. Start it again to keep talking."); return }
        if at.timeIntervalSince(heard) >= Self.idleLimit { end("Talk ended after five quiet minutes."); return }
      }
    }
  }

  private func receive(_ text: String, run: Int) {
    guard generation == run, let data = text.data(using: .utf8),
      let event = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else { return }
    switch event["type"] as? String {
    case "session.created":
      open(run: run)
    case "response.created":
      if let id = (event["response"] as? [String: Any])?["id"] as? String { activeResponses.insert(id) }
    case "response.done":
      if let id = (event["response"] as? [String: Any])?["id"] as? String { activeResponses.remove(id) }
    case "response.output_audio.delta":
      // Audio still arriving for an item already cut would play its end after a gap.
      let item = event["item_id"] as? String ?? ""
      if let response = event["response_id"] as? String, !item.isEmpty { itemResponses[item] = response }
      if !cutItems.contains(item), let delta = event["delta"] as? String, let pcm = Data(base64Encoded: delta) {
        audio?.play(pcm, item: item)
      }
    case "input_audio_buffer.speech_started":
      // The person spoke over the voice: stop it now, and tell the model how much was heard so it
      // does not think the rest was said.
      if let audio { truncate(audio.interrupt(), cancel: false) }
    default: break
    }
    loop?.handle(event)
  }

  /// Cuts each item to what the person heard; one never reached is cut to nothing.
  private func truncate(_ lost: [TalkPlaybackLedger.Heard], cancel: Bool) {
    for heard in lost where !heard.item.isEmpty {
      cutItems.insert(heard.item)
      host?.send(["type": "conversation.item.truncate", "item_id": heard.item, "content_index": 0, "audio_end_ms": heard.milliseconds])
    }
    guard cancel else { return }
    // Only a response still generating a cut item; a newer answer already under way goes on.
    let responses = Set(lost.compactMap { itemResponses[$0.item] }).intersection(activeResponses)
    for response in responses.sorted() { host?.send(["type": "response.cancel", "response_id": response]) }
  }
  fileprivate func phase(_ phase: TalkPhase, run: Int) {
    guard generation == run, status != .idle else { return }
    status = .live(phase)
  }
  fileprivate func show(_ captions: TalkCaptions, run: Int) { if generation == run { self.captions = captions } }
  fileprivate func activity(run: Int) { if generation == run { heard = now() } }
  fileprivate func problem(_ message: String, run: Int) { if generation == run { error = message } }

  private func release() {
    generation += 1
    starting?.cancel(); starting = nil
    timer?.cancel(); timer = nil
    loop?.dispose(); loop = nil
    cutItems = []; itemResponses = [:]; activeResponses = []
    host = nil
    transport?.close(); transport = nil
    audio?.stop(); audio = nil
    if MicrophoneOwnership.shared.owner == owner { MicrophoneOwnership.shared.owner = nil }
    status = .idle
    muted = false
  }
  /// Ends Talk; `why` says so when it ended by itself.
  func end(_ why: String = "") {
    release()
    notice = why
  }
  private func fail(_ message: String) {
    release()
    error = message
  }
  func toggleMute() {
    guard let audio else { return }
    muted.toggle()
    audio.setMuted(muted)
  }
  func dismiss() { error = ""; notice = "" }
  /// Shows why Talk cannot start, without starting it.
  func explain(_ message: String) { notice = ""; error = message }

  /// The tool loop's view of one run. A late call from an ended run changes nothing.
  @MainActor private final class Host: TalkLoopHost {
    weak var controller: TalkController?
    let api: APIClient
    let botId: String
    let run: Int
    weak var transport: TalkTransport?
    init(controller: TalkController, api: APIClient, botId: String, run: Int, transport: TalkTransport) {
      self.controller = controller; self.api = api; self.botId = botId; self.run = run; self.transport = transport
    }
    func send(_ event: [String: Any]) {
      guard let data = try? JSONSerialization.data(withJSONObject: event), let text = String(data: data, encoding: .utf8) else { return }
      transport?.send(text)
    }
    func ask(requestId: String, request: String) async throws -> TalkAnswer {
      try await api.write("/bots/\(APIClient.component(botId))/talk/ask", ["requestId": requestId, "request": request])
    }
    func phase(_ phase: TalkPhase) { controller?.phase(phase, run: run) }
    func captions(_ captions: TalkCaptions) { controller?.show(captions, run: run) }
    func activity() { controller?.activity(run: run) }
    func problem(_ message: String) { controller?.problem(message, run: run) }
    func newId() -> String { UUID().uuidString.lowercased() }
  }
}
