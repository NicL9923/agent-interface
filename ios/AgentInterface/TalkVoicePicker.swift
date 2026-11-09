import AVFoundation
import SwiftUI

/// The Realtime voices live Talk can use, mirroring `TALK_VOICES` in src/shared/voice.ts.
enum TalkVoice {
  static let all = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]
  static let `default` = "marin"
  static func title(_ voice: String) -> String { voice.prefix(1).uppercased() + voice.dropFirst() }
  /// The note under the picker when this server cannot run live Talk. A server that does not
  /// report the capability at all says nothing, as the web picker does.
  static func unavailableNote(_ capability: Capability?) -> String? {
    guard let capability, !capability.supported else { return nil }
    return "Live Talk isn't available yet. \(capability.reason ?? "")".trimmingCharacters(in: .whitespaces)
  }
  /// The public, static sample for one voice. It needs no sign-in.
  static func samplePath(_ voice: String) -> String { "/voice-previews/\(voice).m4a" }
}

private struct VoiceChoice: Decodable { var voice: String }

/// Saving an assistant's Talk voice and playing its samples, as the web's VoicePicker does. A choice
/// saves at once and rolls back with the reason if it fails. One sample plays at a time, and
/// starting one stops a reply being read aloud.
@MainActor @Observable final class TalkVoiceModel {
  private(set) var chosen: String
  private(set) var saving: String?
  private(set) var error = ""
  private(set) var playing: String?
  private(set) var failed: String?
  @ObservationIgnored var api: APIClient?
  @ObservationIgnored private let botId: String
  @ObservationIgnored private var player: AVAudioPlayer?
  @ObservationIgnored private var sample: Task<Void, Never>?
  @ObservationIgnored private var generation = 0
  @ObservationIgnored private let playbackOwner = UUID()

  init(botId: String, voice: String?) {
    self.botId = botId
    chosen = voice ?? TalkVoice.default
  }

  /// Follows the saved voice the server reports, unless a save is in flight.
  func sync(_ voice: String?) {
    if saving == nil { chosen = voice ?? TalkVoice.default }
  }

  /// Saves `voice`; true when the server accepted it.
  @discardableResult func choose(_ voice: String) async -> Bool {
    guard voice != chosen, saving == nil, let api else { return false }
    let previous = chosen
    chosen = voice; saving = voice; error = ""
    defer { saving = nil }
    do {
      let _: VoiceChoice = try await api.write("/bots/\(APIClient.component(botId))/voice", ["voice": voice], method: "PUT")
      return true
    } catch {
      chosen = previous
      self.error = "\(TalkVoice.title(voice)) wasn't saved: \((error as? LocalizedError)?.errorDescription ?? "try again.")"
      return false
    }
  }

  /// Plays this voice's sample, or stops it when it is the one playing.
  func toggleSample(_ voice: String) {
    let same = playing == voice
    stop()
    failed = nil
    guard !same, let api, MicrophoneOwnership.shared.owner == nil else { return }
    // A reply being read aloud would play over the sample.
    let audio = MicrophoneOwnership.shared
    audio.stopPlayback?()
    audio.playbackOwner = playbackOwner
    audio.stopPlayback = { [weak self] in self?.stop() }
    generation += 1
    let run = generation
    playing = voice
    sample = Task {
      do {
        let data = try await api.data(path: TalkVoice.samplePath(voice), authenticated: false)
        guard generation == run else { return }
        let value = try AVAudioPlayer(data: data)
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio)
        try? session.setActive(true)
        player = value
        guard value.play() else { throw CancellationError() }
        // Samples are short; when this one ends the button returns to Play.
        try await Task.sleep(for: .seconds(value.duration + 0.2))
        if generation == run { stop() }
      } catch {
        guard generation == run, !(error is CancellationError && Task.isCancelled) else { return }
        stop()
        failed = voice
      }
    }
  }

  /// Stops the sample. Safe to call when nothing plays.
  func stop() {
    generation += 1
    sample?.cancel()
    sample = nil
    if player != nil {
      player?.stop()
      player = nil
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    playing = nil
    let audio = MicrophoneOwnership.shared
    if audio.playbackOwner == playbackOwner { audio.playbackOwner = nil; audio.stopPlayback = nil }
  }
}

/// The "Voice for live Talk" section of an assistant's Profile settings.
struct TalkVoiceSection: View {
  let bot: Bot
  @Environment(AppStore.self) private var store
  @State private var model: TalkVoiceModel

  init(bot: Bot) {
    self.bot = bot
    _model = State(initialValue: TalkVoiceModel(botId: bot.id, voice: bot.voice))
  }
  private var savedVoice: String? { store.bootstrap?.bots.first { $0.id == bot.id }?.voice ?? bot.voice }

  var body: some View {
    Section {
      if let note = TalkVoice.unavailableNote(store.bootstrap?[capability: .liveVoice]) {
        Text(note).font(.footnote).foregroundStyle(Palette.muted).accessibilityIdentifier("talkVoiceUnavailable")
      }
      if !model.error.isEmpty {
        Text(model.error).font(.footnote).foregroundStyle(Palette.danger).accessibilityIdentifier("talkVoiceError")
      }
      ForEach(TalkVoice.all, id: \.self) { voice in row(voice) }
    } header: {
      Text("Voice for live Talk").font(.subheadline.weight(.semibold)).foregroundStyle(Palette.muted)
    } footer: {
      Text("How \(bot.name) sounds when you talk with it out loud. Choosing a voice saves it for everyone in the household.")
        .foregroundStyle(Palette.muted)
    }
    .task(id: store.api.map(ObjectIdentifier.init)) { model.api = store.api }
    .onChange(of: savedVoice) { _, voice in model.sync(voice) }
    .onDisappear { model.stop() }
  }

  private func row(_ voice: String) -> some View {
    let selected = model.chosen == voice
    return VStack(alignment: .leading, spacing: 4) {
      HStack {
        Button {
          Task { if await model.choose(voice) { await store.refreshBootstrap() } }
        } label: {
          HStack {
            Text(TalkVoice.title(voice)).foregroundStyle(.primary)
            if voice == TalkVoice.default { Text("Default").font(.caption).foregroundStyle(Palette.muted) }
            if model.saving == voice { Text("Saving…").font(.caption).foregroundStyle(Palette.muted) }
            Spacer()
            if selected { Image(systemName: "checkmark").foregroundStyle(Palette.accent) }
          }.contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(model.saving != nil)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("voiceOption.\(voice)")
        let playing = model.playing == voice
        Button { model.toggleSample(voice) } label: {
          Image(systemName: playing ? "stop.fill" : "play.fill").foregroundStyle(Palette.accent).frame(minWidth: 44, minHeight: 44)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(playing ? "Stop \(TalkVoice.title(voice)) sample" : "Play \(TalkVoice.title(voice)) sample")
        .accessibilityIdentifier("voiceSample.\(voice)")
      }
      if model.failed == voice {
        Text("This sample could not play.").font(.caption).foregroundStyle(Palette.danger)
      }
    }
  }
}
