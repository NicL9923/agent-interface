import AVFoundation
import SwiftUI

enum VoiceState: Equatable {
  case idle, requesting, recording, transcribing, preparing, speaking
  /// The web's status line for each state.
  var label: String {
    switch self {
    case .idle: return ""
    case .requesting: return "Waiting for microphone permission…"
    case .recording: return "Recording"
    case .transcribing: return "Transcribing…"
    case .preparing: return "Preparing spoken reply…"
    case .speaking: return "Speaking"
    }
  }
}

/// The web's VoiceControls: a recording is transcribed as soon as it stops and its text joins the
/// draft, and a reply is read aloud with the app server's configured voice.
@MainActor @Observable final class VoiceController: NSObject, AVAudioPlayerDelegate, AVAudioRecorderDelegate {
  static let maxRecordingSeconds = 120
  static let maxVoiceBytes = 8 * 1024 * 1024
  static let maxSpokenText = 12_000
  #if DEBUG
    /// UI tests record a fixed clip instead of using the microphone.
    static var fixtureRecording = false
  #endif
  private(set) var state = VoiceState.idle
  var error = ""
  var notice = ""
  /// A recording kept after its transcription failed, for Retry transcription.
  private(set) var recording: Data? {
    didSet {
      guard let recordingURL else { return }
      if let recording {
        try? FileManager.default.createDirectory(at: recordingURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        var directory = recordingURL.deletingLastPathComponent()
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try? directory.setResourceValues(values)
        try? recording.write(to: recordingURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      } else { try? FileManager.default.removeItem(at: recordingURL) }
    }
  }
  @ObservationIgnored private(set) var recordingURL: URL?
  func restoreRecording(from url: URL?) {
    guard url != recordingURL else { return }
    recordingURL = url
    let audio = url.flatMap { path -> Data? in
      guard let size = try? path.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= Self.maxVoiceBytes else { return nil }
      return try? Data(contentsOf: path)
    }
    recording = audio.flatMap { $0.count <= Self.maxVoiceBytes ? $0 : nil }
    if recording != nil { notice = "Recording kept. Transcribe it when you're ready, or discard it." }
  }
  private(set) var playable = false
  private(set) var elapsed = 0
  @ObservationIgnored var api: APIClient?
  @ObservationIgnored var botId = ""
  @ObservationIgnored var onTranscript: (String) -> Void = { _ in }
  @ObservationIgnored private var recorder: AVAudioRecorder?
  @ObservationIgnored private var file: URL?
  @ObservationIgnored private var player: AVAudioPlayer?
  @ObservationIgnored private var timer: Task<Void, Never>?
  @ObservationIgnored private var request: Task<Void, Never>?
  /// Bumped by every new action, so a late result from an earlier one is ignored.
  @ObservationIgnored private var generation = 0
  @ObservationIgnored private var discarded = false
  @ObservationIgnored private var sessionActive = false

  /// Inactivity ends capture, but the captured speech stays available for review.
  /// Unlike Stop, this never starts a network request in the background.
  func preserveRecording() {
    guard state == .recording else {
      if state == .requesting { cancel() }
      return
    }
    #if DEBUG
      if Self.fixtureRecording {
        keepRecording(Data("fixture-recording".utf8))
        return
      }
    #endif
    recorder?.delegate = nil
    recorder?.stop()
    let audio = file.flatMap { try? Data(contentsOf: $0) }
    keepRecording(audio ?? Data())
  }
  private func keepRecording(_ audio: Data) {
    releaseRecorder()
    state = .idle
    guard !audio.isEmpty, audio.count <= Self.maxVoiceBytes else {
      error = "The recording could not be kept. Try recording again. Your draft is kept."
      return
    }
    recording = audio
    notice = "Recording kept. Transcribe it when you're ready, or discard it."
  }

  /// Stops whatever is happening and keeps the draft as it is.
  func cancel() {
    generation += 1
    discarded = true
    request?.cancel()
    request = nil
    releaseRecorder()
    releaseAudio()
    playable = false
    state = .idle
  }
  /// Clears everything, for another assistant or account.
  func reset() {
    cancel()
    recording = nil
    error = ""
    notice = ""
  }
  func discardRecording() {
    recording = nil
    error = ""
  }

  func startRecording() async {
    guard state == .idle else { return }
    generation += 1
    let run = generation
    discarded = false
    releaseAudio()
    playable = false
    error = ""
    notice = ""
    elapsed = 0
    state = .requesting
    #if DEBUG
      if Self.fixtureRecording {
        state = .recording
        startTimer(run)
        return
      }
    #endif
    guard await AVAudioApplication.requestRecordPermission() else {
      if generation == run {
        state = .idle
        error = "Microphone permission was denied. Allow it in iOS Settings, then try again."
      }
      return
    }
    guard generation == run else { return }
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
      try session.setActive(true)
      sessionActive = true
      let url = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(UUID().uuidString).m4a")
      let value = try AVAudioRecorder(url: url, settings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 24_000, AVNumberOfChannelsKey: 1,
        AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
      ])
      value.delegate = self
      guard value.record(forDuration: TimeInterval(Self.maxRecordingSeconds)) else {
        throw APIError(message: "No microphone was found. Connect one, then try again.", status: 0)
      }
      recorder = value
      file = url
      state = .recording
      startTimer(run)
    } catch {
      releaseRecorder()
      state = .idle
      self.error = Self.message(error)
    }
  }
  func stopRecording() {
    guard state == .recording else { return }
    #if DEBUG
      if Self.fixtureRecording {
        timer?.cancel()
        finishRecording(Data("fixture-recording".utf8))
        return
      }
    #endif
    // The recorder's delegate finishes the recording.
    recorder?.stop()
  }
  private func startTimer(_ run: Int) {
    timer?.cancel()
    timer = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(1))
        guard !Task.isCancelled, let self, self.generation == run, self.state == .recording else { return }
        self.elapsed += 1
        if self.elapsed >= Self.maxRecordingSeconds { self.stopRecording() }
      }
    }
  }
  nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
    Task { @MainActor in
      guard self.recorder === recorder else { return }
      let data = self.file.flatMap { try? Data(contentsOf: $0) }
      self.releaseRecorder()
      guard !self.discarded, self.state == .recording else { return }
      guard flag else {
        self.keepRecording(data ?? Data())
        if self.recording != nil { self.error = "Recording was interrupted. Your captured audio is kept for transcription." }
        return
      }
      self.finishRecording(data ?? Data())
    }
  }
  nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
    Task { @MainActor in
      guard self.recorder === recorder else { return }
      self.cancel()
      self.error = "The microphone stopped recording. Try recording again. Your draft is kept."
    }
  }
  private func finishRecording(_ data: Data) {
    guard !data.isEmpty else {
      state = .idle
      notice = "No audio was captured. Try recording again."
      return
    }
    guard data.count <= Self.maxVoiceBytes else {
      state = .idle
      error = "This recording reached the 8 MB limit. Try a shorter recording."
      return
    }
    recording = data
    transcribe(data)
  }
  func transcribe(_ audio: Data) {
    guard let api else { return }
    generation += 1
    let run = generation
    let botId = botId
    error = ""
    notice = ""
    state = .transcribing
    request = Task {
      defer {
        if generation == run {
          request = nil
          state = .idle
        }
      }
      do {
        let result = try await api.transcribe(botId: botId, audio: audio)
        guard generation == run else { return }
        recording = nil
        if result.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          notice = "No speech detected. Try recording again."
        } else {
          onTranscript(result.text)
          notice = "Added to your draft. Review it before sending."
        }
      } catch {
        if generation == run, !(error is CancellationError) {
          self.error = "\(Self.message(error)) Your recording is kept here for retry."
        }
      }
    }
  }

  /// Reads a reply aloud with the server's voice. Replies over 12,000 characters are refused, as
  /// on the web and the server, instead of being cut short.
  func speak(_ reply: Message) {
    guard state == .idle, let api else { return }
    guard reply.text.utf16.count <= Self.maxSpokenText else {
      error = "This reply is too long to read aloud. Ask for a shorter summary."
      return
    }
    generation += 1
    let run = generation
    let botId = botId
    releaseAudio()
    playable = false
    error = ""
    notice = ""
    state = .preparing
    request = Task {
      defer { if generation == run { request = nil } }
      do {
        let playback: VoicePlayback = try await api.write(
          "/bots/\(APIClient.component(botId))/voice/speak", ["messageId": reply.id])
        guard generation == run else { return }
        guard playback.url.range(of: #"^/api/voice/audio/[0-9a-f-]{36}$"#, options: .regularExpression) != nil else {
          throw APIError(message: "The app returned an invalid audio link.", status: 0)
        }
        let data: Data
        do { data = try await api.data(path: playback.url) } catch let failure as APIError where failure.code != "CONNECTION_UNAVAILABLE" {
          throw APIError(message: "This audio reply expired. Select Listen to reply to prepare it again.", status: failure.status)
        }
        guard generation == run else { return }
        guard !data.isEmpty, data.count <= Self.maxVoiceBytes else {
          throw APIError(message: "The spoken reply could not be loaded.", status: 0)
        }
        guard let player = try? AVAudioPlayer(data: data, fileTypeHint: Self.fileType(playback.mime)) else {
          state = .idle
          error = "This device could not play the spoken reply."
          return
        }
        player.delegate = self
        self.player = player
        playable = true
        play()
      } catch {
        if generation == run, !(error is CancellationError) {
          state = .idle
          self.error = Self.message(error)
        }
      }
    }
  }
  /// Plays the prepared reply again, or for the first time.
  func play() {
    guard let player else { return }
    error = ""
    state = .preparing
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(.playback, mode: .spokenAudio)
    try? session.setActive(true)
    sessionActive = true
    player.currentTime = 0
    if player.play() {
      state = .speaking
    } else {
      state = .idle
      error = "Audio could not start. Select Play audio to try again."
    }
  }
  nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    Task { @MainActor in
      guard self.player === player, self.state == .speaking else { return }
      self.state = .idle
      self.deactivateSession()
    }
  }
  nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
    Task { @MainActor in
      guard self.player === player else { return }
      self.releaseAudio()
      self.playable = false
      self.state = .idle
      self.error = "This device could not play the spoken reply."
    }
  }
  private func releaseRecorder() {
    timer?.cancel()
    timer = nil
    if let recorder {
      recorder.delegate = nil
      if recorder.isRecording { recorder.stop() }
    }
    recorder = nil
    if let file { try? FileManager.default.removeItem(at: file) }
    file = nil
    deactivateSession()
  }
  private func releaseAudio() {
    player?.delegate = nil
    player?.stop()
    player = nil
    deactivateSession()
  }
  private func deactivateSession() {
    guard sessionActive else { return }
    sessionActive = false
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
  private static func message(_ error: Error) -> String {
    (error as? LocalizedError)?.errorDescription ?? "Voice could not be completed. Your draft is kept."
  }
  private static func fileType(_ mime: String) -> String? {
    switch mime {
    case "audio/mpeg", "audio/mp3": return AVFileType.mp3.rawValue
    case "audio/wav", "audio/wave", "audio/x-wav": return AVFileType.wav.rawValue
    case "audio/mp4", "audio/m4a", "audio/x-m4a": return AVFileType.m4a.rawValue
    case "audio/aac": return "public.aac-audio"
    default: return nil
    }
  }
}

/// The record and listen buttons in the composer's tool row.
struct VoiceButtons: View {
  var voice: VoiceController
  var bot: Bot
  var reply: Message?
  var disabled: Bool
  var body: some View {
    if voice.state != .idle {
      AvatarView(avatar: bot.avatar ?? AvatarConfig(), size: 24, name: bot.name, forceReducedMotion: true)
        .accessibilityHidden(true)
    }
    if voice.state == .recording {
      Button("Stop recording · \(voice.elapsed)s") { voice.stopRecording() }
        .font(.footnote.weight(.semibold)).foregroundStyle(Palette.danger).frame(minHeight: 44)
    } else {
      Button { Task { await voice.startRecording() } } label: {
        Image(systemName: "mic").frame(width: 44, height: 44)
      }.accessibilityLabel("Record voice")
        .accessibilityHint("Record up to two minutes. Review the transcript before sending.")
        .disabled(disabled || voice.state != .idle || voice.recording != nil)
    }
    if let reply {
      Button { voice.speak(reply) } label: {
        Image(systemName: "speaker.wave.2").frame(width: 44, height: 44)
      }.accessibilityLabel("Listen to reply").disabled(disabled || voice.state != .idle)
    }
  }
}

/// The web's voice actions and status below the tool row.
struct VoicePanel: View {
  var voice: VoiceController
  var disabled: Bool
  var body: some View {
    let busy = voice.state != .idle
    if busy || voice.recording != nil || voice.playable || !voice.notice.isEmpty || !voice.error.isEmpty {
      VStack(alignment: .leading, spacing: 6) {
        actions(busy: busy)
        if busy || !voice.notice.isEmpty {
          Text(busy ? voice.state.label : voice.notice).font(.caption).foregroundStyle(.secondary)
        }
        if !voice.error.isEmpty {
          Text(voice.error).font(.caption).foregroundStyle(Palette.danger)
        }
      }.frame(maxWidth: .infinity, alignment: .leading)
    }
  }
  @ViewBuilder private func actions(busy: Bool) -> some View {
    HStack(spacing: 14) {
      if busy {
        Button(voice.state == .speaking ? "Stop speaking" : "Cancel voice") { voice.cancel() }
      }
      if let recording = voice.recording, !busy {
        Button(voice.error.isEmpty ? "Transcribe recording" : "Retry transcription") { voice.transcribe(recording) }.disabled(disabled)
        Button("Discard recording") { voice.discardRecording() }
      }
      if voice.playable && !busy {
        Button("Play audio") { voice.play() }.disabled(disabled)
      }
    }.font(.footnote).frame(minHeight: busy || voice.recording != nil || voice.playable ? 32 : 0)
  }
}

struct VoicePlayback: Decodable { var url: String; var mime: String; var expiresAt: String? }
struct VoiceTranscript: Decodable { var text: String; var provider: String? }
extension APIClient {
  func transcribe(botId: String, audio: Data) async throws -> VoiceTranscript {
    guard audio.count <= VoiceController.maxVoiceBytes else { throw APIError(message: "Audio recordings must be 8 MB or smaller.", status: 400) }
    let boundary = "NativeVoice-\(UUID().uuidString)"
    var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"voice.m4a\"\r\nContent-Type: audio/mp4\r\n\r\n".utf8)
    body.append(audio); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
    return try JSONDecoder().decode(VoiceTranscript.self, from: await data(path: "/api/bots/\(Self.component(botId))/voice/transcribe", method: "POST", body: body, contentType: "multipart/form-data; boundary=\(boundary)"))
  }
}
