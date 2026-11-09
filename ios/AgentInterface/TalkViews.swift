import SwiftUI

/// The composer's Talk button, beside Record voice. An older server reports no liveVoice, and then
/// there is no button at all.
struct TalkButton: View {
  var talk: TalkController
  var bot: Bot
  var capability: Capability?
  /// Another use of the microphone, such as a recording, is under way.
  var busy: Bool
  var connected: Bool
  var beforeStart: () -> Void = {}
  var body: some View {
    if let capability {
      Button {
        if talk.live { talk.end() }
        else if capability.supported { beforeStart(); talk.start() }
        else { talk.explain(capability.reason ?? "Live Talk is unavailable on this Hermes.") }
      } label: {
        Image(systemName: talk.live ? "waveform.circle.fill" : "waveform").font(.system(size: 20)).frame(width: 44, height: 44)
      }
      .accessibilityLabel(talk.live ? "End talk" : "Talk live with \(bot.name)")
      .accessibilityHint(talk.live ? "" : capability.supported ? "Talk with \(bot.name) out loud. It hears you and answers as you go." : capability.reason ?? "")
      .accessibilityAddTraits(talk.live ? .isSelected : [])
      .accessibilityIdentifier("talkButton")
      .disabled(!talk.live && (busy || !connected))
    }
  }
}

/// The live conversation above the composer: what is happening, the latest words from each side,
/// mute and end. Idle, it shows why Talk stopped until dismissed.
struct TalkPanel: View {
  var talk: TalkController
  var name: String
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    switch talk.status {
    case .idle:
      if !talk.error.isEmpty || !talk.notice.isEmpty { message }
    case .connecting, .live:
      live
    }
  }
  private var message: some View {
    let failed = !talk.error.isEmpty
    return HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: failed ? "exclamationmark.triangle" : "waveform").foregroundStyle(failed ? Palette.danger : Palette.muted)
        .accessibilityHidden(true)
      Text(failed ? talk.error : talk.notice).font(.footnote).foregroundStyle(failed ? Palette.danger : .primary)
        .frame(maxWidth: .infinity, alignment: .leading).accessibilityIdentifier("talkMessage")
      Button { talk.dismiss() } label: { Image(systemName: "xmark").font(.footnote.weight(.semibold)).frame(width: 32, height: 32) }
        .accessibilityLabel("Dismiss")
    }.padding(.horizontal, 12).padding(.vertical, 6)
      .background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
  }
  private var statusText: String {
    switch talk.status {
    case .idle: ""
    case .connecting: "Connecting…"
    case .live(.listening): "Listening"
    case .live(.thinking): "\(name) is thinking"
    case .live(.working): "\(name) is working on it"
    case .live(.speaking): "\(name) is speaking"
    }
  }
  private var live: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 10) {
        TalkMeter(active: talk.status != .connecting && !talk.muted)
        Text(statusText + (talk.muted ? " · muted" : "")).font(.subheadline.weight(.semibold))
          .frame(maxWidth: .infinity, alignment: .leading).accessibilityIdentifier("talkStatus")
          .accessibilityAddTraits(.updatesFrequently)
        Button { talk.toggleMute() } label: {
          Label(talk.muted ? "Unmute" : "Mute", systemImage: talk.muted ? "mic.slash" : "mic").font(.footnote.weight(.semibold))
        }.buttonStyle(.bordered).disabled(talk.status == .connecting)
          .accessibilityLabel("Mute microphone").accessibilityValue(talk.muted ? "On" : "Off")
        Button { talk.end() } label: { Label("End", systemImage: "stop.fill").font(.footnote.weight(.semibold)) }
          .buttonStyle(.borderedProminent).tint(Palette.danger).accessibilityLabel("End talk")
      }.dynamicTypeSize(...DynamicTypeSize.accessibility2)
      if !talk.captions.you.isEmpty || !talk.captions.assistant.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          if !talk.captions.you.isEmpty { caption("You", talk.captions.you) }
          if !talk.captions.assistant.isEmpty { caption(name, talk.captions.assistant) }
        }.accessibilityElement(children: .combine).accessibilityIdentifier("talkCaptions")
      }
      if !talk.error.isEmpty {
        Text(talk.error).font(.footnote).foregroundStyle(Palette.danger)
      }
    }.padding(12)
      .background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Palette.line, lineWidth: 1))
      .accessibilityElement(children: .contain).accessibilityLabel("Live talk with \(name)")
  }
  private func caption(_ who: String, _ text: String) -> some View {
    (Text(who + "  ").font(.caption.weight(.semibold)).foregroundStyle(Palette.muted) + Text(text).font(.footnote))
      .lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// Five bars that move while Talk listens or speaks, and rest when muted, connecting or with
/// Reduce Motion on.
private struct TalkMeter: View {
  var active: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var body: some View {
    TimelineView(.animation(minimumInterval: 1.0 / 12, paused: !active || reduceMotion)) { context in
      let time = context.date.timeIntervalSinceReferenceDate
      HStack(alignment: .center, spacing: 2) {
        ForEach(0..<5, id: \.self) { index in
          let level = active && !reduceMotion ? 0.35 + 0.65 * abs(sin(time * 3.1 + Double(index) * 0.9)) : 0.35
          Capsule().fill(Palette.accent).frame(width: 3, height: 18 * level)
        }
      }.frame(width: 23, height: 18)
    }.accessibilityHidden(true)
  }
}
