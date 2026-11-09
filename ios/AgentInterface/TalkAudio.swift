import AVFoundation
import Foundation
import os

/// The microphone and speaker for live Talk.
@MainActor protocol TalkAudioIO: AnyObject {
  /// Opens the microphone and speaker. Each microphone chunk arrives as 24 kHz mono 16-bit PCM,
  /// off the main actor. `failed` reports a stop the person did not ask for.
  func start(chunk: @escaping @Sendable (Data) -> Void, failed: @escaping @MainActor (String) -> Void) throws
  /// Queues the voice's 24 kHz mono 16-bit PCM for one output item.
  func play(_ pcm: Data, item: String)
  /// Stops the voice at once. Answers the item still playing and how much of it was heard, so the
  /// voice model can forget what the person never heard.
  func interrupt() -> TalkPlaybackLedger.Heard?
  func setMuted(_ muted: Bool)
  func stop()
}

/// Which output item plays and how far it got, in the player's own sample clock. Content queued
/// after a gap starts at the clock's current time, not where earlier audio ended.
struct TalkPlaybackLedger: Equatable {
  struct Heard: Equatable { var item: String; var milliseconds: Int }
  static let rate: Double = 24_000
  private(set) var item: String?
  private var itemStart: Int64 = 0
  private var end: Int64 = 0

  mutating func schedule(item: String, frames: Int, at now: Int64) {
    if end < now { end = now }
    if item != self.item { self.item = item; itemStart = end }
    end += Int64(frames)
  }
  /// The item still playing at `now` and how much of it was heard; nil once its audio has finished.
  func heard(at now: Int64) -> Heard? {
    guard let item, now < end else { return nil }
    let frames = max(0, now - itemStart)
    return Heard(item: item, milliseconds: Int((Double(frames) * 1000 / Self.rate).rounded(.down)))
  }
  mutating func reset() { self = TalkPlaybackLedger() }
}

enum TalkPCM {
  /// Little-endian 16-bit samples as floats for the player.
  static func floats(_ data: Data) -> [Float] {
    let count = data.count / 2
    var result = [Float](repeating: 0, count: count)
    data.withUnsafeBytes { raw in
      for index in 0..<count {
        let sample = Int16(littleEndian: raw.loadUnaligned(fromByteOffset: index * 2, as: Int16.self))
        result[index] = Float(sample) / 32_768
      }
    }
    return result
  }
}

/// Whether the person muted the microphone, read on the audio thread.
private final class MuteFlag: Sendable {
  private let value = OSAllocatedUnfairLock(initialState: false)
  var muted: Bool {
    get { value.withLock { $0 } }
    set { value.withLock { $0 = newValue } }
  }
}

/// AVAudioEngine with Apple's voice processing, which cancels the voice's own echo, so the person
/// can interrupt it without headphones. The session keeps running with the screen locked.
@MainActor final class TalkEngine: TalkAudioIO {
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: TalkPlaybackLedger.rate, channels: 1, interleaved: false)!
  private let mute = MuteFlag()
  private var ledger = TalkPlaybackLedger()
  private var chunk: (@Sendable (Data) -> Void)?
  private var failed: (@MainActor (String) -> Void)?
  private var observers: [NSObjectProtocol] = []
  private var running = false
  private var sessionActive = false

  func start(chunk: @escaping @Sendable (Data) -> Void, failed: @escaping @MainActor (String) -> Void) throws {
    self.chunk = chunk
    self.failed = failed
    let session = AVAudioSession.sharedInstance()
    var options: AVAudioSession.CategoryOptions = [.defaultToSpeaker]
    if #available(iOS 26.0, *) { options.insert(.allowBluetoothHFP) } else { options.insert(.allowBluetooth) }
    try session.setCategory(.playAndRecord, mode: .voiceChat, options: options)
    try session.setActive(true)
    sessionActive = true
    try engine.inputNode.setVoiceProcessingEnabled(true)
    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: output)
    try begin()
    let center = NotificationCenter.default
    // A headset coming or going changes the engine's formats; it stops and needs a new tap.
    observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.restart() }
    })
    observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
      let began = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt == AVAudioSession.InterruptionType.began.rawValue
      MainActor.assumeIsolated { if began { self?.fail("Talk ended when another app took the audio.") } }
    })
  }

  private func begin() throws {
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      throw APIError(message: "No microphone was found. Connect one, then start Talk again.", status: 0)
    }
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 2_400, format: format, block: try Self.tap(from: format, mute: mute, chunk: chunk ?? { _ in }))
    engine.prepare()
    try engine.start()
    player.play()
    ledger.reset()
    running = true
  }

  /// Built away from the main actor: the engine calls it on its own audio thread.
  nonisolated private static func tap(from format: AVAudioFormat, mute: MuteFlag, chunk: @escaping @Sendable (Data) -> Void) throws
    -> AVAudioNodeTapBlock
  {
    guard let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: TalkPlaybackLedger.rate, channels: 1, interleaved: true),
      let converter = AVAudioConverter(from: format, to: target)
    else { throw APIError(message: "The microphone could not start. Close other apps using it, then try again.", status: 0) }
    nonisolated(unsafe) let unsafeConverter = converter
    return { buffer, _ in
      guard !mute.muted else { return }
      let capacity = AVAudioFrameCount((Double(buffer.frameLength) * target.sampleRate / format.sampleRate).rounded(.up)) + 16
      guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
      nonisolated(unsafe) var given = false
      var problem: NSError?
      let status = unsafeConverter.convert(to: out, error: &problem) { _, state in
        if given { state.pointee = .noDataNow; return nil }
        given = true
        state.pointee = .haveData
        return buffer
      }
      guard status != .error, out.frameLength > 0, let samples = out.int16ChannelData else { return }
      chunk(Data(bytes: samples[0], count: Int(out.frameLength) * 2))
    }
  }

  private func restart() {
    guard running else { return }
    engine.stop()
    do { try begin() } catch { fail("The microphone stopped. Start Talk again.") }
  }

  private var now: Int64 {
    guard let render = player.lastRenderTime, let time = player.playerTime(forNodeTime: render) else { return 0 }
    return time.sampleTime
  }

  func play(_ pcm: Data, item: String) {
    guard running else { return }
    let samples = TalkPCM.floats(pcm)
    guard !samples.isEmpty, let buffer = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: AVAudioFrameCount(samples.count)),
      let channel = buffer.floatChannelData
    else { return }
    buffer.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { channel[0].update(from: $0.baseAddress!, count: samples.count) }
    ledger.schedule(item: item, frames: samples.count, at: now)
    player.scheduleBuffer(buffer)
    if !player.isPlaying { player.play() }
  }

  func interrupt() -> TalkPlaybackLedger.Heard? {
    let heard = ledger.heard(at: now)
    player.stop()
    ledger.reset()
    if running { player.play() }
    return heard
  }

  func setMuted(_ muted: Bool) { mute.muted = muted }

  private func fail(_ message: String) {
    let failed = failed
    stop()
    failed?(message)
  }

  func stop() {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers = []
    chunk = nil
    failed = nil
    if running {
      running = false
      engine.inputNode.removeTap(onBus: 0)
      player.stop()
      engine.stop()
    }
    if sessionActive {
      sessionActive = false
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
  }
}
