#if DEBUG
  import Foundation

  /// A scripted voice for UI tests, like the web's PREVIEW_TALK fixture: once the microphone opens,
  /// the person asks one question, the voice calls ask_assistant, and the assistant's answer from
  /// the fixture server is spoken back. Nothing reaches the microphone or OpenAI.
  @MainActor final class FixtureTalk: TalkTransport, TalkAudioIO {
    static let shared = FixtureTalk()
    static let question = "Is the north gate closed?"
    private var event: (@MainActor (String) -> Void)?
    private var script: Task<Void, Never>?
    private var answered = false

    func open(secret: String, model: String, event: @escaping @MainActor (String) -> Void, closed: @escaping @MainActor (String) -> Void) {
      self.event = event
      answered = false
      emit(["type": "session.created", "session": ["model": model]], after: .milliseconds(200))
    }
    func send(_ text: String) {
      guard let data = text.data(using: .utf8), let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
      let item = value["item"] as? [String: Any]
      if value["type"] as? String == "conversation.item.create", item?["type"] as? String == "function_call_output" {
        answered = true
        return
      }
      guard value["type"] as? String == "response.create", answered else { return }
      answered = false
      // Speaks the answer the tool returned, as the voice model reads it back.
      let output = "The north gate is closed."
      run([
        ["type": "response.created"],
        ["type": "response.output_audio_transcript.delta", "delta": output],
        ["type": "response.output_audio_transcript.done", "transcript": output],
        ["type": "response.done"],
      ])
    }
    func close() {
      script?.cancel(); script = nil
      event = nil
    }

    func start(chunk: @escaping @Sendable (Data) -> Void, failed: @escaping @MainActor (String) -> Void,
      cut: @escaping @MainActor ([TalkPlaybackLedger.Heard]) -> Void) throws {
      run([
        ["type": "input_audio_buffer.speech_started"],
        ["type": "conversation.item.input_audio_transcription.completed", "transcript": Self.question],
        ["type": "response.created"],
        ["type": "response.function_call_arguments.done", "name": TalkLoop.tool, "call_id": "fixture-call",
         "arguments": #"{"request":"\#(Self.question)"}"#],
        ["type": "response.done"],
      ])
    }
    func play(_ pcm: Data, item: String) {}
    func interrupt() -> [TalkPlaybackLedger.Heard] { [] }
    func setMuted(_ muted: Bool) {}
    func stop() { script?.cancel(); script = nil }

    private func emit(_ value: [String: Any], after delay: Duration) { run([value], after: delay) }
    private func run(_ values: [[String: Any]], after delay: Duration = .milliseconds(400)) {
      let previous = script
      script = Task { [weak self] in
        await previous?.value
        for value in values {
          // Simulated latency between the voice model's events.
          try? await Task.sleep(for: delay)
          guard !Task.isCancelled, let self, let event = self.event,
            let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8)
          else { return }
          event(text)
        }
      }
    }
  }
#endif
