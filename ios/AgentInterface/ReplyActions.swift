import SwiftUI

/// Whole-answer actions also appear as named VoiceOver actions.
struct ReplyActions: ViewModifier {
  var message: Message
  @Environment(AppStore.self) private var store: AppStore?
  @Environment(\.transcriptConnected) private var connected
  @Environment(SpeechController.self) private var speech: SpeechController?
  @State private var saving = false
  @State private var saved = false
  @State private var selecting = false
  private var eligible: Bool {
    message.role == "assistant" && !message.isProgressLine && !message.isInternalActivity && !message.isToolActivity
      && !message.id.hasSuffix("-inflight") && !message.text.isEmpty
  }
  /// A person's own message offers Copy alone, as on the web.
  private var ownMessage: Bool {
    message.role == "user" && message.isHumanMessage && !message.id.hasSuffix("-inflight") && !message.text.isEmpty
  }
  func body(content: Content) -> some View {
    if ownMessage {
      content.contextMenu {
        Button("Copy message", systemImage: "doc.on.doc", action: copy)
        Button("Select text", systemImage: "character.cursor.ibeam") { selecting = true }
      }
        .accessibilityAction(named: "Copy message", copy)
        .accessibilityAction(named: "Select text") { selecting = true }
        .sheet(isPresented: $selecting) { SelectTextSheet(message: message) }
    } else if eligible {
      content.contextMenu {
        Button("Copy answer", systemImage: "doc.on.doc", action: copy)
        Button("Select text", systemImage: "character.cursor.ibeam") { selecting = true }
        if let speech {
          Button(listenTitle(speech), systemImage: "speaker.wave.2") { speech.toggle(message) }
            .disabled(!connected && speech.current?.id != message.id)
        }
        Button("Quote in reply", systemImage: "text.quote", action: quote)
        ShareLink(item: message.text) { Label("Share answer", systemImage: "square.and.arrow.up") }
        Button(saved ? "Reply saved" : saving ? "Saving…" : "Save reply", systemImage: "bookmark", action: save)
          .disabled(saving || saved || !connected)
      }
      .accessibilityAction(named: "Copy answer", copy)
      .accessibilityAction(named: speech?.current?.id == message.id ? "Stop speaking" : "Listen to reply") { speech?.toggle(message) }
      .accessibilityAction(named: "Quote in reply", quote)
      .accessibilityAction(named: "Save reply", save)
      .accessibilityAction(named: "Select text") { selecting = true }
      .sheet(isPresented: $selecting) { SelectTextSheet(message: message) }
    } else { content }
  }
  private func listenTitle(_ speech: SpeechController) -> String {
    switch speech.current?.id == message.id ? speech.current?.phase : nil {
    case .preparing?, .speaking?: "Stop speaking"
    case .ready?: "Play audio"
    case nil: "Listen to reply"
    }
  }
  private func copy() {
    UIPasteboard.general.string = message.text
    AccessibilityNotification.Announcement("Answer copied.").post()
  }
  private func quote() {
    guard let store, let botId = store.selectedBotId else { return }
    switch store.quoteInReply(message.text, botId: botId) {
    case .added: AccessibilityNotification.Announcement("Quote added to your draft.").post()
    case .waiting: store.notice = ReplyQuote.waitingNotice; AccessibilityNotification.Announcement(ReplyQuote.waitingNotice).post()
    case .refused: break
    }
  }
  private func save() {
    guard connected && store?.connected == true else {
      AccessibilityNotification.Announcement("Reconnect to save this reply.").post()
      return
    }
    guard !saving, !saved, let store, let botId = store.selectedBotId,
      let session = store.conversation?.sessionId, let api = store.api, store.connected else { return }
    let scope = store.scope
    saving = true
    Task {
      defer { saving = false }
      do {
        let _: SavedItem = try await api.write("/saved", SavedPointer(botId: botId, kind: "session", sessionId: session,
          messageId: message.id, title: DiscoveryView.replyTitle(message.text)))
        guard store.scope == scope else { return }
        saved = true
        store.notice = "Saved. Find it in Search > Saved items."
        AccessibilityNotification.Announcement("Reply saved.").post()
      } catch { if store.scope == scope { store.report(error) } }
    }
  }
}

/// The message in a text view that selects any range, which SwiftUI's `Text` cannot: its
/// `.textSelection` copies a whole block at a time. Replies show as rendered, without Markdown
/// marks, so a selection copies the words the reader saw.
struct SelectTextSheet: View {
  var message: Message
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      SelectableTextView(text: SelectableText.attributed(message))
        .ignoresSafeArea(.container, edges: .bottom)
        .navigationTitle("Select text").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }.presentationDragIndicator(.visible)
  }
}
private struct SelectableTextView: UIViewRepresentable {
  var text: NSAttributedString
  func makeUIView(context: Context) -> UITextView {
    let view = UITextView()
    view.isEditable = false
    view.isSelectable = true
    view.alwaysBounceVertical = true
    view.backgroundColor = .clear
    view.textContainerInset = UIEdgeInsets(top: 16, left: 16, bottom: 32, right: 16)
    view.dataDetectorTypes = []
    view.accessibilityIdentifier = "selectableMessage"
    return view
  }
  func updateUIView(_ view: UITextView, context: Context) {
    if view.attributedText != text { view.attributedText = text }
  }
}
/// A message as styled text for `SelectTextSheet`. A person's own message is plain, as the
/// transcript shows it. A reply renders its Markdown: inline styles become fonts, lists keep their
/// bullets and numbers, tables become tab-separated rows, and cards become their visible text.
enum SelectableText {
  static func attributed(_ message: Message) -> NSAttributedString {
    let body = UIFont.preferredFont(forTextStyle: .body)
    guard message.isReply else {
      return NSAttributedString(string: message.text, attributes: [.font: body, .foregroundColor: UIColor.label])
    }
    let result = NSMutableAttributedString()
    for part in ReplyCards.parse(message.text, inlineUi: message.role == "assistant" && !message.isProgressLine) {
      var chunk = NSMutableAttributedString()
      if let markdown = part.markdown { chunk = blocks(MarkdownCache.shared.blocks(markdown), indent: 0) }
      else if let inline = part.inline { chunk = plain(inline.title, font: body) }
      else if let cards = part.cards { chunk = plain(cards.map(cardText).joined(separator: "\n\n"), font: body) }
      guard chunk.length > 0 else { continue }
      if result.length > 0 { result.append(plain("\n\n", font: body)) }
      result.append(chunk)
    }
    return result
  }
  private static func cardText(_ card: ReplyCard) -> String {
    ([card.title] + (card.items ?? []).map { $0.text ?? $0.title ?? "" } + [card.subject].compactMap { $0 }
      + (card.fields ?? []).map(\.label)).filter { !$0.isEmpty }.joined(separator: "\n")
  }
  private static func plain(_ text: String, font: UIFont) -> NSMutableAttributedString {
    NSMutableAttributedString(string: text, attributes: [.font: font, .foregroundColor: UIColor.label])
  }
  /// Blocks a blank line apart, or a line apart inside a list item, which the transcript keeps tight.
  private static func blocks(_ blocks: [MarkdownBlock], indent: CGFloat, separator: String = "\n\n") -> NSMutableAttributedString {
    let result = NSMutableAttributedString()
    for block in blocks {
      let chunk = self.block(block, indent: indent)
      guard chunk.length > 0 else { continue }
      if result.length > 0 { result.append(plain(separator, font: UIFont.preferredFont(forTextStyle: .body))) }
      result.append(chunk)
    }
    return result
  }
  private static func block(_ block: MarkdownBlock, indent: CGFloat) -> NSMutableAttributedString {
    let body = UIFont.preferredFont(forTextStyle: .body)
    let chunk: NSMutableAttributedString
    switch block {
    case .paragraph(let text): chunk = inline(text, font: body)
    case .heading(let level, let text):
      let style: UIFont.TextStyle = level == 1 ? .title2 : level == 2 ? .title3 : .headline
      chunk = inline(text, font: bold(UIFont.preferredFont(forTextStyle: style)))
    case .code(_, let text):
      chunk = plain(text, font: .monospacedSystemFont(ofSize: body.pointSize * 0.9, weight: .regular))
    case .quote(let inner):
      chunk = blocks(inner, indent: indent + 16)
      chunk.addAttribute(.foregroundColor, value: UIColor.secondaryLabel, range: NSRange(location: 0, length: chunk.length))
      return chunk
    case .list(let list):
      chunk = NSMutableAttributedString()
      for (index, item) in list.items.enumerated() {
        let marker = switch item.task {
        case true?: "☑ "
        case false?: "☐ "
        case nil: list.start.map { "\($0 + index). " } ?? "• "
        }
        let markerWidth = (marker as NSString).size(withAttributes: [.font: body]).width
        let content = blocks(item.blocks, indent: indent + markerWidth, separator: "\n")
        content.insert(plain(marker, font: body), at: 0)
        // The marker hangs in the margin so wrapped lines align with the item's text.
        let style = NSMutableParagraphStyle()
        style.firstLineHeadIndent = indent
        style.headIndent = indent + markerWidth
        content.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: (marker as NSString).length))
        if chunk.length > 0 { chunk.append(plain("\n", font: body)) }
        chunk.append(content)
      }
      return chunk
    case .rule: chunk = plain("———", font: body)
    case .table(let table):
      chunk = inline(table.header.joined(separator: "\t"), font: bold(body))
      for row in table.rows {
        chunk.append(plain("\n", font: body))
        chunk.append(inline(row.joined(separator: "\t"), font: body))
      }
    }
    if indent > 0 {
      let style = NSMutableParagraphStyle()
      style.firstLineHeadIndent = indent
      style.headIndent = indent
      chunk.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: chunk.length))
    }
    return chunk
  }
  /// Inline Markdown through the transcript's own parser, with its styles as UIKit fonts.
  private static func inline(_ text: String, font: UIFont) -> NSMutableAttributedString {
    let value = MarkdownCache.shared.attributed(text)
    let result = NSMutableAttributedString()
    for run in value.runs {
      let intent = run.inlinePresentationIntent ?? []
      var runFont = intent.contains(.code) ? UIFont.monospacedSystemFont(ofSize: font.pointSize * 0.9, weight: .regular) : font
      var traits = runFont.fontDescriptor.symbolicTraits
      if intent.contains(.stronglyEmphasized) { traits.insert(.traitBold) }
      if intent.contains(.emphasized) { traits.insert(.traitItalic) }
      if let descriptor = runFont.fontDescriptor.withSymbolicTraits(traits) { runFont = UIFont(descriptor: descriptor, size: runFont.pointSize) }
      var attributes: [NSAttributedString.Key: Any] = [.font: runFont, .foregroundColor: UIColor.label]
      if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
      if let link = run.link { attributes[.link] = link }
      result.append(NSAttributedString(string: String(value[run.range].characters), attributes: attributes))
    }
    return result
  }
  private static func bold(_ font: UIFont) -> UIFont {
    font.fontDescriptor.withSymbolicTraits(.traitBold).map { UIFont(descriptor: $0, size: font.pointSize) } ?? font
  }
}

/// A reply quoted into the draft as a Markdown block quote, with a blank line below for the answer.
enum ReplyQuote {
  enum Outcome { case added, waiting, refused }
  static let waitingNotice = "The quote joins your draft once your message is sent."
  static func block(_ text: String) -> String {
    let lines = text.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: .newlines)
    return lines.map { $0.isEmpty ? ">" : "> " + $0 }.joined(separator: "\n") + "\n\n"
  }
}
extension AppStore {
  /// Quotes a reply into this assistant's draft through the path Share and Siri text take: it joins
  /// the draft at once when the draft can take it, and otherwise waits, as while a send to this
  /// assistant is unsettled, because a draft and its send are told apart by content.
  @discardableResult func quoteInReply(_ text: String, botId: String) -> ReplyQuote.Outcome {
    guard let scope, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .refused }
    let waits = holdsAdditions(botId) || selectedBotId != botId || !draftReady
    guard hold(DraftAddition(source: .share, botId: botId, text: ReplyQuote.block(text), scope: scope)) else { return .refused }
    return waits ? .waiting : .added
  }
}
