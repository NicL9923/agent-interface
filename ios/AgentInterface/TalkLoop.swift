import Foundation

/// Live Talk's shared vocabulary, mirroring `src/shared/voice.ts`.
enum TalkState: String, Decodable, Equatable {
  case done, working, needsApproval, needsAnswer, interrupted, refused
  /// `done`, `interrupted` and `refused` are final; the others mean ask again with the same request ID.
  var final: Bool { self == .done || self == .interrupted || self == .refused }
}
/// What a working assistant has newly said it is doing. `ids` names every new progress line so the app can
/// report them heard, and `text` is the newest, already plain and short enough to say aloud.
struct TalkProgress: Decodable, Equatable {
  var ids: [String]
  var text: String
}
struct TalkAnswer: Decodable, Equatable {
  var state: TalkState
  var text: String?
  /// Rides on a `working` answer, which the server returns as soon as a new progress line exists.
  var progress: TalkProgress? = nil
}
/// A short-lived credential for one Realtime call, from `POST /bots/:id/talk/session`.
struct TalkSession: Decodable, Equatable {
  var clientSecret: String
  var expiresAt: Int
  var model: String
  var voice: String
}
/// What the person sees: who is talking, or what the assistant is doing.
enum TalkPhase: Equatable { case listening, thinking, working, speaking }
struct TalkCaptions: Equatable {
  var you = ""
  var assistant = ""
}

/// What the tool loop needs from the live connection and the app server.
@MainActor protocol TalkLoopHost: AnyObject {
  /// Sends one client event over the Realtime connection.
  func send(_ event: [String: Any])
  /// `POST /bots/:id/talk/ask`. The same request ID never sends twice. `heard` names the progress lines already said.
  func ask(requestId: String, request: String, heard: [String]) async throws -> TalkAnswer
  func phase(_ phase: TalkPhase)
  func captions(_ captions: TalkCaptions)
  /// The person spoke or the assistant answered, which keeps an idle Talk open.
  func activity()
  /// A Realtime error the person should see. Talk keeps going unless the host ends it.
  func problem(_ message: String)
  func newId() -> String
}

/// The Realtime tool loop, as the web's `TalkLoop` in `src/app/talk-loop.ts`. The voice model calls
/// ask_assistant; this sends the request to the assistant as the person's message and speaks its
/// answer. A response.create sent while another response is active fails, so one is queued until
/// the current response is done.
@MainActor final class TalkLoop {
  static let tool = "ask_assistant"
  /// A run can take a while; Talk still ends on its own idle and hard limits.
  static let maxFollow: TimeInterval = 10 * 60
  /// The server waits on a running request, but answers a pending decision or an unconfirmed send
  /// at once, so asking again waits here first.
  static let follow: Duration = .seconds(2)
  static let decisionFollow: Duration = .seconds(5)

  private weak var host: TalkLoopHost?
  private let name: String
  private let now: () -> Date
  private let sleep: (Duration) async throws -> Void
  private var active = false
  private var queued = false
  private(set) var disposed = false
  private var you = ""
  private var assistant = ""
  private var assistantDone = false
  private var following = 0
  private var calls: [Task<Void, Never>] = []
  /// The newest progress line of each request that came while a response was active, held until it ends. An
  /// answer that arrives first drops it, so the person hears the answer, not what was done on the way to it.
  private var held: [(requestId: String, text: String)] = []
  /// Every progress line said in this Talk, for every request: a steered request shares its run with the one
  /// before it, so a line must not be said once for each. Oldest first, and only the newest are reported.
  private var heard: [String] = []
  /// As `MAX_HEARD_LINES` in `src/shared/voice.ts`, which the server enforces.
  static let maxHeard = 500

  init(host: TalkLoopHost, name: String, now: @escaping () -> Date = Date.init,
    sleep: @escaping (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
    self.host = host
    self.name = name
    self.now = now
    self.sleep = sleep
  }

  func dispose() {
    disposed = true
    for call in calls { call.cancel() }
    calls = []
  }

  /// Asks for a spoken response now, or after the current one ends.
  func respond() {
    guard !disposed else { return }
    if active { queued = true; return }
    // Counted active at once, so a second call before response.created waits its turn.
    active = true
    host?.send(["type": "response.create"])
  }

  func handle(_ event: [String: Any]) {
    guard !disposed, let host else { return }
    switch event["type"] as? String {
    case "input_audio_buffer.speech_started":
      host.activity(); host.phase(following > 0 ? .working : .listening)
    case "conversation.item.input_audio_transcription.completed":
      you = Self.string(event["transcript"]).trimmingCharacters(in: .whitespacesAndNewlines); assistant = ""; show()
    case "response.created":
      active = true; host.phase(.thinking)
    case "response.output_audio_transcript.delta":
      if assistant.isEmpty || assistantDone { assistant = ""; assistantDone = false }
      assistant += Self.string(event["delta"]); host.phase(.speaking); show()
    case "response.output_audio_transcript.done":
      if let transcript = event["transcript"] as? String { assistant = transcript }
      assistantDone = true; host.activity(); show()
    case "response.done":
      active = false
      host.phase(following > 0 ? .working : .listening)
      if queued { queued = false; respond() } else { flushHeld() }
    case "response.function_call_arguments.done":
      let callId = Self.string(event["call_id"])
      if event["name"] as? String == Self.tool {
        let raw = Self.string(event["arguments"])
        let task = Task { [weak self] in
          guard let self else { return }
          await self.call(callId, raw)
        }
        calls.append(task)
      } else {
        output(callId, "That tool is not available. Answer without it.")
      }
    case "error":
      let error = event["error"] as? [String: Any] ?? [:]
      // Our response.create raced one the server started itself; send it after that one ends.
      if error["code"] as? String == "conversation_already_has_active_response" { queued = true; return }
      // A cancel that crossed the response's own end changes nothing.
      if error["code"] as? String == "response_cancel_not_active" { return }
      active = false
      queued = false
      host.phase(following > 0 ? .working : .listening)
      host.problem((error["message"] as? String).map { String($0.prefix(300)) } ?? "The voice service reported a problem.")
    default: break
    }
  }

  private static func string(_ value: Any?) -> String {
    switch value {
    case let text as String: text
    case nil, is NSNull: ""
    case let other?: "\(other)"
    }
  }
  private func show() { host?.captions(TalkCaptions(you: you, assistant: assistant)) }

  private func output(_ callId: String, _ output: String) {
    host?.send(["type": "conversation.item.create", "item": ["type": "function_call_output", "call_id": callId, "output": output]])
    respond()
  }

  private func say(_ text: String) {
    host?.send(["type": "conversation.item.create",
      "item": ["type": "message", "role": "system", "content": [["type": "input_text", "text": text]]]])
    respond()
  }

  /// Says the oldest held progress line now that no response is active.
  private func flushHeld() {
    guard !held.isEmpty else { return }
    say(held.removeFirst().text)
  }

  /// Says a new progress line at once when the voice is free, else holds the newest until it is.
  private func narrate(_ requestId: String, _ request: String, _ answer: TalkAnswer) {
    guard answer.progress != nil else { return }
    let text = "About the earlier request \"\(String(request.prefix(200)))\": \(spoken(answer)) Tell the person now, briefly."
    if active || queued {
      held.removeAll { $0.requestId == requestId }
      held.append((requestId, text))
    } else { say(text) }
  }

  func spoken(_ answer: TalkAnswer) -> String {
    let text = answer.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    switch answer.state {
    case .done: return text.isEmpty ? "\(name) finished without a reply to read. The chat shows what happened." : "\(name) answered: \(text)"
    case .refused: return "\(name) could not take this request\(text.isEmpty ? "." : ": \(text)")"
    case .interrupted: return "\(name)'s work on this was interrupted. Suggest checking the chat."
    case .needsApproval:
      return "\(name) is waiting for an approval on screen\(text.isEmpty ? "" : ": \(text)"). Tell the person to check the screen. The answer follows once they decide."
    case .needsAnswer: return "\(name) has a question waiting on screen\(text.isEmpty ? "" : ": \(text)"). Tell the person to check the screen to answer it."
    case .working:
      if let progress = answer.progress {
        return "\(name) is working on it and says: \"\(progress.text)\" Tell the person that in one short sentence, in your own words, then wait. The answer will follow."
      }
      return "\(name) is still working on it. Tell the person the answer will follow, then wait."
    }
  }

  private func call(_ callId: String, _ raw: String) async {
    let parsed = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any]
    let request = Self.string(parsed?["request"]).trimmingCharacters(in: .whitespacesAndNewlines)
    guard !request.isEmpty else { output(callId, "No request was given. Ask the person what they need."); return }
    guard let host else { return }
    let requestId = host.newId()
    following += 1
    host.phase(.working)
    // A request that ends, with its answer or a failure, leaves no held line: it would only be old news.
    defer { held.removeAll { $0.requestId == requestId }; following -= 1 }
    var answered = false
    func hear(_ answer: TalkAnswer) {
      for id in answer.progress?.ids ?? [] { heard.removeAll { $0 == id }; heard.append(id) }
      if heard.count > Self.maxHeard { heard.removeFirst(heard.count - Self.maxHeard) }
    }
    do {
      var answer = try await host.ask(requestId: requestId, request: request, heard: heard)
      if disposed || Task.isCancelled { return }
      hear(answer)
      output(callId, spoken(answer))
      answered = true
      let started = now()
      var told = answer.state
      // Keep asking with the same ID until it is final; nothing is sent twice.
      while !answer.state.final && now().timeIntervalSince(started) < Self.maxFollow {
        try await sleep(answer.state == .working ? Self.follow : Self.decisionFollow)
        if disposed || Task.isCancelled { return }
        answer = try await host.ask(requestId: requestId, request: request, heard: heard)
        if disposed || Task.isCancelled { return }
        hear(answer)
        if answer.state.final || answer.state != told && answer.state != .working {
          say("About the earlier request \"\(String(request.prefix(200)))\": \(spoken(answer)) Tell the person now, briefly.")
          told = answer.state
        } else { narrate(requestId, request, answer) }
      }
    } catch {
      if disposed || error is CancellationError || Task.isCancelled { return }
      let message = (error as? LocalizedError)?.errorDescription ?? "The request could not be sent."
      let text = "The request could not reach \(name): \(message) Tell the person, and suggest typing it in the chat."
      // A call is answered once; a failure while following up is said as a new message.
      if answered { say(text) } else { output(callId, text) }
    }
  }
}
