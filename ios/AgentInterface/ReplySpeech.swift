import AVFoundation
import MediaPlayer
import SwiftUI

/// Reads one assistant reply aloud at a time for the whole transcript, as the web's `useReplySpeech`
/// does, with the app server's configured voice. Replies over 12,000 characters are refused instead
/// of being cut short. The audio is released when another reply starts, when recording starts and
/// when the chat closes. It keeps playing with the phone locked or another app open, and the Lock
/// Screen and Control Center show it with pause, play and stop.
@MainActor @Observable final class SpeechController: NSObject, AVAudioPlayerDelegate {
  static let maxSpokenText = 12_000
  static let maxVoiceBytes = 8 * 1024 * 1024
  /// Preparing is the request and download, ready is audio that has not started or has finished and
  /// can play again, speaking is playing.
  enum Phase: Equatable { case preparing, ready, speaking }
  struct Current: Equatable { var id: String; var phase: Phase }
  struct Failure: Equatable { var id: String; var text: String }
  private(set) var current: Current?
  /// Why a reply could not be spoken. It stays until the next try on any reply.
  private(set) var failure: Failure?
  @ObservationIgnored var api: APIClient?
  @ObservationIgnored var botId = ""
  /// The assistant's name for the Lock Screen's Now Playing.
  @ObservationIgnored var botName = ""
  @ObservationIgnored private var player: AVAudioPlayer?
  @ObservationIgnored private var request: Task<Void, Never>?
  /// Bumped by every new action, so a late result from an earlier one is ignored.
  @ObservationIgnored private var generation = 0
  @ObservationIgnored private var sessionActive = false
  /// The Lock Screen's handlers while this controller holds audio, removed with it.
  @ObservationIgnored private var remoteTargets: [(MPRemoteCommand, Any)] = []

  /// Starts speaking the reply, plays prepared audio again, or stops this reply. Another reply's
  /// playback stops first.
  func toggle(_ reply: Message) {
    if let current, current.id == reply.id {
      if current.phase == .ready { play(reply.id, fromStart: true) } else { cancel() }
      return
    }
    speak(reply)
  }
  func cancel() {
    generation += 1
    request?.cancel()
    request = nil
    releaseAudio()
    current = nil
  }
  func reset() {
    cancel()
    failure = nil
  }

  private func speak(_ reply: Message) {
    guard let api else { return }
    guard reply.text.utf16.count <= Self.maxSpokenText else {
      failure = Failure(id: reply.id, text: "This reply is too long to read aloud. Ask for a shorter summary.")
      return
    }
    generation += 1
    let run = generation
    let botId = botId
    request?.cancel()
    releaseAudio()
    failure = nil
    current = Current(id: reply.id, phase: .preparing)
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
        do { data = try await api.data(path: playback.url) } catch let problem as APIError where problem.code != "CONNECTION_UNAVAILABLE" {
          throw APIError(message: "This audio reply expired. Select Listen to reply to prepare it again.", status: problem.status)
        }
        guard generation == run else { return }
        guard !data.isEmpty, data.count <= Self.maxVoiceBytes else {
          throw APIError(message: "The spoken reply could not be loaded.", status: 0)
        }
        guard let value = try? AVAudioPlayer(data: data, fileTypeHint: Self.fileType(playback.mime)) else {
          current = nil
          failure = Failure(id: reply.id, text: "This device could not play the spoken reply.")
          return
        }
        value.delegate = self
        player = value
        play(reply.id, fromStart: true)
      } catch {
        if generation == run, !(error is CancellationError) {
          current = nil
          failure = Failure(id: reply.id, text: (error as? LocalizedError)?.errorDescription ?? "The reply could not be spoken.")
        }
      }
    }
  }
  /// Plays the prepared audio from the start, or, after a pause from the Lock Screen, from there.
  private func play(_ id: String, fromStart: Bool) {
    guard let player else { return }
    failure = nil
    current = Current(id: id, phase: .preparing)
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(.playback, mode: .spokenAudio)
    try? session.setActive(true)
    sessionActive = true
    if fromStart { player.currentTime = 0 }
    if player.play() {
      current = Current(id: id, phase: .speaking)
      showNowPlaying(player)
    } else {
      current = Current(id: id, phase: .ready)
      failure = Failure(id: id, text: "Audio could not start. Select Play audio to try again.")
    }
  }
  nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    let finished = SentPlayer(player)
    Task { @MainActor in
      guard self.player === finished.value, let current = self.current, current.phase == .speaking else { return }
      // The prepared audio stays, so Play audio replays it without another request.
      self.current = Current(id: current.id, phase: .ready)
      self.deactivateSession()
      self.hideNowPlaying()
    }
  }
  nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
    let failed = SentPlayer(player)
    Task { @MainActor in
      guard self.player === failed.value, let id = self.current?.id else { return }
      self.releaseAudio()
      self.current = nil
      self.failure = Failure(id: id, text: "This device could not play the spoken reply.")
    }
  }
  private func releaseAudio() {
    player?.delegate = nil
    player?.stop()
    player = nil
    deactivateSession()
    hideNowPlaying()
  }
  /// Pauses where it is, as the Lock Screen's pause does. Play audio in the chat starts over.
  private func pause() {
    guard let player, let current, current.phase == .speaking else { return }
    player.pause()
    self.current = Current(id: current.id, phase: .ready)
    MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
    MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPNowPlayingInfoPropertyElapsedPlaybackTime] = player.currentTime
    MPNowPlayingInfoCenter.default().playbackState = .paused
  }
  private func showNowPlaying(_ player: AVAudioPlayer) {
    MPNowPlayingInfoCenter.default().nowPlayingInfo = [
      MPMediaItemPropertyTitle: botName.isEmpty ? "Assistant reply" : "Reply from \(botName)",
      MPMediaItemPropertyArtist: "WildBots",
      MPMediaItemPropertyPlaybackDuration: player.duration,
      MPNowPlayingInfoPropertyElapsedPlaybackTime: player.currentTime,
      MPNowPlayingInfoPropertyPlaybackRate: 1.0,
      MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
    ]
    MPNowPlayingInfoCenter.default().playbackState = .playing
    guard remoteTargets.isEmpty else { return }
    let center = MPRemoteCommandCenter.shared()
    // iOS does not promise which thread calls these, so each hops to the main actor. A command that
    // arrives after the audio was released finds no player and does nothing.
    func handle(_ command: MPRemoteCommand, _ action: @escaping @MainActor @Sendable (SpeechController) -> Void) {
      let target = command.addTarget { @Sendable [weak self] _ in
        Task { @MainActor in
          guard let self, self.player != nil else { return }
          action(self)
        }
        return .success
      }
      command.isEnabled = true
      remoteTargets.append((command, target))
    }
    handle(center.pauseCommand) { $0.pause() }
    handle(center.playCommand) { speech in speech.current.map { speech.play($0.id, fromStart: false) } }
    handle(center.togglePlayPauseCommand) { speech in
      if speech.current?.phase == .speaking { speech.pause() } else { speech.current.map { speech.play($0.id, fromStart: false) } }
    }
    handle(center.stopCommand) { $0.cancel() }
  }
  private func hideNowPlaying() {
    for (command, target) in remoteTargets { command.removeTarget(target) }
    remoteTargets = []
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    MPNowPlayingInfoCenter.default().playbackState = .stopped
  }
  private func deactivateSession() {
    guard sessionActive else { return }
    sessionActive = false
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
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
/// A delegate callback's player, taken to the main actor only to compare its identity there.
private struct SentPlayer: @unchecked Sendable {
  let value: AVAudioPlayer
  init(_ value: AVAudioPlayer) { self.value = value }
}

/// The line under a message: its time or delivery status, and its actions. A person's own message
/// is on the right with its bubble, a reply on the left. A reply made of several parts shows the time
/// once, under the last, while each part keeps its own actions.
struct MessageMetaRow: View {
  var message: Message
  var own: Bool
  /// Omitted for the parts of a reply before the last.
  var when: String?
  var delivery: SentEcho.Status?
  var actions: Bool
  @Environment(SpeechController.self) private var speech: SpeechController?
  @Environment(\.transcriptConnected) private var connected
  @State private var copied = false
  private var reply: Bool { message.role == "assistant" }
  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 0) {
        if own { Spacer(minLength: 0) }
        if own { actionButtons }
        stamp
        if !own { actionButtons }
        if !own { Spacer(minLength: 0) }
      }.foregroundStyle(Palette.messageMetadata).font(.caption2).frame(minHeight: actions ? 44 : 20)
      if let speech, let failure = speech.failure, failure.id == message.id {
        Text(failure.text).font(.caption).foregroundStyle(Palette.danger)
          .frame(maxWidth: .infinity, alignment: own ? .trailing : .leading).accessibilityIdentifier("speechError")
      }
    }
  }
  @ViewBuilder private var stamp: some View {
    if let delivery {
      Text(delivery == .sending ? "Sending…" : "Not confirmed yet")
    } else if let when {
      WhenText(value: when)
    }
  }
  @ViewBuilder private var actionButtons: some View {
    if actions {
      HStack(spacing: 0) {
        button(copied ? "checkmark" : "doc.on.doc", label: copied ? "Copied" : reply ? "Copy reply" : "Copy message", id: "copyMessage", action: copy)
        if reply, let speech { listen(speech) }
      }
    }
  }
  private func listen(_ speech: SpeechController) -> some View {
    let phase = speech.current?.id == message.id ? speech.current?.phase : nil
    let label = switch phase {
    case .preparing?: "Preparing spoken reply"
    case .speaking?: "Stop speaking"
    case .ready?: "Play audio"
    case nil: "Listen to reply"
    }
    return Button { speech.toggle(message) } label: {
      Group {
        if phase == .preparing { ProgressView().controlSize(.small) }
        else { Image(systemName: phase == .speaking ? "stop.fill" : "speaker.wave.2").font(.system(size: 15)) }
      }.frame(width: 44, height: 44).contentShape(Rectangle())
    }.buttonStyle(.plain).accessibilityLabel(label).accessibilityIdentifier("listenToReply")
      // Preparing can be cancelled too, so the button never dead-ends while audio loads.
      .disabled(!connected && phase == nil)
  }
  private func button(_ symbol: String, label: String, id: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: symbol).font(.system(size: 15)).frame(width: 44, height: 44).contentShape(Rectangle())
    }.buttonStyle(.plain).accessibilityLabel(label).accessibilityIdentifier(id)
  }
  private func copy() {
    UIPasteboard.general.string = message.text
    copied = true
    AccessibilityNotification.Announcement("Copied.").post()
    Task {
      try? await Task.sleep(for: .seconds(2))
      copied = false
    }
  }
}
