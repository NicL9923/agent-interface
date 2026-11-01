import SwiftUI

/// Which provider mark a Hermes provider slug gets, the same table as `src/shared/provider-icon.ts`.
/// Slugs and aliases come from Hermes, so `claude`, `google`, `grok` and `chatgpt` still land on a
/// mark. A custom or unknown provider gets the generic one. The marks are the asset catalog's
/// `provider-*` images, drawn from the same path data as the web; a web test keeps them in step.
/// Anthropic, Google, OpenRouter, Ollama, Mistral AI and DeepSeek come from Simple Icons (CC0 1.0),
/// OpenAI from Simple Icons 13.21.0, and xAI, Nous and the generic mark are simple original glyphs.
enum ProviderIconKey: String, CaseIterable {
  case anthropic, openai, google, xai, openrouter, nous, ollama, mistral, deepseek, generic
  var assetName: String { "provider-\(rawValue)" }
  /// A slug matches a name when it is that name, or starts with it and a `-`, `_` or `.`.
  private static let names: [(ProviderIconKey, [String])] = [
    (.anthropic, ["anthropic", "claude"]), (.openai, ["openai", "chatgpt"]), (.google, ["google", "gemini", "vertex"]),
    (.xai, ["xai", "x-ai", "x.ai", "grok"]), (.openrouter, []), (.nous, ["nous"]), (.ollama, ["ollama"]),
    (.mistral, ["mistral"]), (.deepseek, ["deepseek"]),
  ]
  static func key(for provider: String?) -> ProviderIconKey {
    let slug = (provider ?? "").trimmingCharacters(in: .whitespaces).lowercased()
    if slug == "openrouter" { return .openrouter }
    return names.first { _, names in
      names.contains { slug == $0 || (slug.hasPrefix($0) && "-_.".contains(slug.dropFirst($0.count).first ?? " ")) }
    }?.0 ?? .generic
  }
}

/// A small monochrome provider mark in the current foreground color. The model's name beside it is
/// the label, so it is hidden from VoiceOver.
struct ProviderIcon: View {
  var provider: String?
  var size: CGFloat = 14
  var body: some View {
    Image(ProviderIconKey.key(for: provider).assetName).renderingMode(.template).resizable().scaledToFit()
      .frame(width: size, height: size).accessibilityHidden(true)
  }
}

/// The model chip under the assistant's name in an Advanced chat: the provider's mark, the model's
/// display name and a caret. It opens the model, reasoning and speed picker.
struct ModelChipButton: View {
  var bot: Bot
  var disabled: Bool
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        ProviderIcon(provider: bot.provider)
        Text(bot.modelName ?? bot.model).lineLimit(1)
        Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).accessibilityHidden(true)
      }.font(.caption).foregroundStyle(Palette.muted).padding(.horizontal, 10).frame(height: 26)
        .overlay(Capsule().stroke(Palette.line, lineWidth: 1))
        // The capsule stays light, and the touch target reaches 44 points.
        .frame(minHeight: 44).contentShape(Rectangle())
    }.buttonStyle(.plain).disabled(disabled).opacity(disabled ? 0.6 : 1)
      .accessibilityLabel("Model: \(bot.modelName ?? bot.model)").accessibilityHint("Change the model, reasoning and speed")
      .accessibilityIdentifier("chatModel")
  }
}
