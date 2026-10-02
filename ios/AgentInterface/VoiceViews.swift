import AVFoundation
import SwiftUI

@MainActor final class VoiceCapture: ObservableObject {
  @Published var recording = false
  @Published var seconds = 0
  private var recorder: AVAudioRecorder?
  private var timer: Task<Void, Never>?
  private var file: URL?
  func start() async throws {
    guard await AVAudioApplication.requestRecordPermission() else {
      throw APIError(message: "Allow microphone access in iOS Settings to record a voice message.", status: 400)
    }
    try Task.checkCancellation()
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
    try session.setActive(true)
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(UUID().uuidString).m4a")
    let value = try AVAudioRecorder(url: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 24_000, AVNumberOfChannelsKey: 1, AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue])
    guard value.record(forDuration: 120) else { try? session.setActive(false); throw APIError(message: "The microphone could not start recording.", status: 400) }
    recorder = value; file = url; seconds = 0; recording = true
    timer = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(1))
        guard !Task.isCancelled, let self else { return }
        self.seconds += 1
        if self.seconds >= 120 { self.stop(); return }
      }
    }
  }
  func stop() {
    let wasRecording = recording || recorder?.isRecording == true
    recorder?.stop(); recording = false; timer?.cancel(); timer = nil
    if wasRecording { try? AVAudioSession.sharedInstance().setActive(false) }
  }
  func data() throws -> Data {
    guard let file else { throw APIError(message: "Record a message first.", status: 400) }
    return try Data(contentsOf: file)
  }
  func clear() { stop(); recorder = nil; if let file { try? FileManager.default.removeItem(at: file) }; file = nil; seconds = 0 }
}

@MainActor final class SpokenReply: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
  @Published var speaking = false
  private let synthesizer = AVSpeechSynthesizer()
  private static weak var current: SpokenReply?
  override init() { super.init(); synthesizer.delegate = self }
  func toggle(_ text: String) {
    if speaking { stop(); return }
    Self.current?.stop(); Self.current = self
    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
    try? AVAudioSession.sharedInstance().setActive(true)
    let utterance = AVSpeechUtterance(string: String(text.prefix(12_000)))
    utterance.voice = AVSpeechSynthesisVoice(language: Locale.current.language.languageCode?.identifier)
    speaking = true; synthesizer.speak(utterance)
  }
  func stop() {
    synthesizer.stopSpeaking(at: .immediate); speaking = false
    if Self.current === self { Self.current = nil; try? AVAudioSession.sharedInstance().setActive(false) }
  }
  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { Task { @MainActor in self.speaking = false; if Self.current === self { Self.current = nil; try? AVAudioSession.sharedInstance().setActive(false) } } }
  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { Task { @MainActor in self.speaking = false } }
}

struct SpokenReplyButton: View {
  var text: String
  @StateObject private var speech = SpokenReply()
  var body: some View {
    Button(speech.speaking ? "Stop speaking" : "Read aloud", systemImage: speech.speaking ? "stop.circle" : "speaker.wave.2") { speech.toggle(text) }
      .font(.caption).onDisappear { speech.stop() }
  }
}

struct VoiceMessageSheet: View {
  var botId: String
  @EnvironmentObject private var store: AppStore
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @State private var recordTask: Task<Void, Never>?
  @StateObject private var capture = VoiceCapture()
  @State private var transcript = ""
  @State private var busy = false
  @State private var error: String?
  @State private var hasRecording = false
  var body: some View {
    NavigationStack {
      Form {
        Section {
          Text("Record up to two minutes. Your app server transcribes the audio using its configured provider. Review the text before adding it to your draft.").foregroundStyle(.secondary)
          if capture.recording { Label("Recording · \(capture.seconds)s", systemImage: "record.circle").foregroundStyle(.red) }
          Button(capture.recording ? "Stop recording" : "Record voice message", systemImage: capture.recording ? "stop.circle" : "mic") {
            if capture.recording { capture.stop(); hasRecording = true }
            else { busy = true; recordTask = Task { defer { busy = false }; do { capture.clear(); transcript = ""; hasRecording = false; try await capture.start() } catch { self.error = error.localizedDescription } } }
          }.disabled(busy)
          if hasRecording && !capture.recording {
            Button(busy ? "Transcribing…" : "Transcribe recording") { transcribe() }.disabled(busy || !store.connected)
          }
        }
        if let error { Section { ErrorBanner(message: error) } }
        if !transcript.isEmpty {
          Section("Review transcript") {
            TextEditor(text: $transcript).frame(minHeight: 160).accessibilityLabel("Voice transcript")
            Button("Add text to draft") {
              guard store.selectedBotId == botId, store.draftReady else { return }
              var draft = store.draft
              draft.text += (draft.text.isEmpty ? "" : "\n\n") + transcript
              store.updateDraft(draft); dismiss()
            }.disabled(busy || !store.draftReady || store.selectedBotId != botId)
            Text("Send the message from your conversation when you are ready.").font(.caption).foregroundStyle(.secondary)
          }
        }
      }.navigationTitle("Voice message").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        .onChange(of: capture.recording) { old, new in if old && !new { hasRecording = true } }
        .onChange(of: scenePhase) { _, phase in if phase != .active { recordTask?.cancel(); capture.stop() } }
        .onDisappear { recordTask?.cancel(); capture.clear() }
    }
  }
  private func transcribe() {
    guard let api = store.api else { return }
    let scope = store.scope
    busy = true; error = nil
    Task {
      defer { busy = false }
      do {
        let result = try await api.transcribe(botId: botId, audio: capture.data())
        guard store.scope == scope, store.api === api, store.selectedBotId == botId else { return }
        guard !result.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { error = "No speech was recognized. Try recording again."; return }
        transcript = result.text
      } catch { if store.scope == scope { self.error = error.localizedDescription } }
    }
  }
}

struct VoiceTranscript: Decodable { var text: String; var provider: String? }
extension APIClient {
  func transcribe(botId: String, audio: Data) async throws -> VoiceTranscript {
    guard audio.count <= 8 * 1024 * 1024 else { throw APIError(message: "Record a shorter voice message, no larger than 8 MB.", status: 400) }
    let boundary = "NativeVoice-\(UUID().uuidString)"
    var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"voice.m4a\"\r\nContent-Type: audio/mp4\r\n\r\n".utf8)
    body.append(audio); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
    return try JSONDecoder().decode(VoiceTranscript.self, from: await data(path: "/api/bots/\(Self.component(botId))/voice/transcribe", method: "POST", body: body, contentType: "multipart/form-data; boundary=\(boundary)"))
  }
}
