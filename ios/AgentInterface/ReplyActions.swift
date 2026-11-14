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
  @Environment(\.dynamicTypeSize) private var typeSize
  var body: some View {
    NavigationStack {
      SelectableTextView(text: SelectableText(size: typeSize).attributed(message))
        .ignoresSafeArea(.container, edges: .bottom)
        .navigationTitle("Select text").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }.presentationDragIndicator(.visible)
  }
}
private struct SelectableTextView: UIViewRepresentable {
  var text: NSAttributedString
  final class Coordinator { var shown: NSAttributedString? }
  func makeCoordinator() -> Coordinator { Coordinator() }
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
  /// Compared with what was last set rather than the view's own text, which UIKit normalizes, so
  /// a render that changes nothing keeps the reader's selection.
  func updateUIView(_ view: UITextView, context: Context) {
    guard context.coordinator.shown != text else { return }
    context.coordinator.shown = text
    view.attributedText = text
  }
}
/// A message as styled text for `SelectTextSheet`. A person's own message is plain, as the
/// transcript shows it. A reply renders its Markdown: inline styles become fonts, lists keep their
/// bullets and numbers, tables become tab-separated rows, and cards become their visible text.
/// An inline view keeps only its title: its page is a web view, which selects text itself.
struct SelectableText {
  /// The reader's text size, so the sheet follows a change made while it is open.
  var size: DynamicTypeSize = .large
  private var traits: UITraitCollection { UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(size)) }
  private func font(_ style: UIFont.TextStyle) -> UIFont { UIFont.preferredFont(forTextStyle: style, compatibleWith: traits) }
  private var body: UIFont { font(.body) }

  func attributed(_ message: Message) -> NSAttributedString {
    guard message.isReply else { return plain(message.text) }
    let result = NSMutableAttributedString()
    for part in ReplyCards.parse(message.text, inlineUi: message.role == "assistant" && !message.isProgressLine) {
      var chunk = NSMutableAttributedString()
      if let markdown = part.markdown { chunk = blocks(MarkdownCache.shared.blocks(markdown), indent: 0) }
      else if let inline = part.inline { chunk = plain(inline.title) }
      else if let cards = part.cards { chunk = plain(cards.map(Self.cardText).joined(separator: "\n\n")) }
      guard chunk.length > 0 else { continue }
      if result.length > 0 { result.append(plain("\n\n")) }
      result.append(chunk)
    }
    return result
  }
  /// The words a card shows, in the order it shows them.
  static func cardText(_ card: ReplyCard) -> String {
    var lines = [card.title]
    if card.type == "event", let start = card.start.flatMap(ServerDate.parse) {
      lines.append(When.format(start, relative: false)
        + (card.end.flatMap(ServerDate.parse).map { " to " + When.format($0, relative: false, from: start) } ?? ""))
    }
    lines += [card.location, card.description].compactMap { $0 }
    if let to = card.to { lines.append("To: " + to.joined(separator: ", ")) }
    if let cc = card.cc { lines.append("Cc: " + cc.joined(separator: ", ")) }
    if let subject = card.subject { lines.append("Subject: " + subject) }
    if let body = card.body { lines.append(body) }
    for item in card.items ?? [] { lines += [item.time, item.text ?? item.title, item.detail].compactMap { $0 } }
    lines += (card.fields ?? []).map(\.label)
    return lines.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.joined(separator: "\n")
  }
  private func plain(_ text: String, font: UIFont? = nil) -> NSMutableAttributedString {
    NSMutableAttributedString(string: text, attributes: [.font: font ?? body, .foregroundColor: UIColor.label])
  }
  /// Blocks a blank line apart, or a line apart inside a list item, which the transcript keeps tight.
  private func blocks(_ blocks: [MarkdownBlock], indent: CGFloat, separator: String = "\n\n") -> NSMutableAttributedString {
    let result = NSMutableAttributedString()
    for block in blocks {
      let chunk = self.block(block, indent: indent)
      guard chunk.length > 0 else { continue }
      if result.length > 0 { result.append(plain(separator)) }
      result.append(chunk)
    }
    return result
  }
  private func block(_ block: MarkdownBlock, indent: CGFloat) -> NSMutableAttributedString {
    let chunk: NSMutableAttributedString
    switch block {
    case .paragraph(let text): chunk = inline(text, font: body)
    case .heading(let level, let text):
      chunk = inline(text, font: Self.bold(font(level == 1 ? .title2 : level == 2 ? .title3 : .headline)))
    case .code(_, let text):
      chunk = plain(text, font: .monospacedSystemFont(ofSize: body.pointSize * 0.9, weight: .regular))
    case .quote(let inner):
      chunk = blocks(inner, indent: indent + 16)
      chunk.addAttribute(.foregroundColor, value: UIColor.secondaryLabel, range: NSRange(location: 0, length: chunk.length))
      return chunk
    case .list(let list):
      chunk = NSMutableAttributedString()
      for (index, item) in list.items.enumerated() {
        if chunk.length > 0 { chunk.append(plain("\n")) }
        let marker = switch item.task {
          case true?: "☑ "
          case false?: "☐ "
          case nil: list.start.map { "\($0 + index). " } ?? "• "
        }
        chunk.append(listItem(item, marker: marker, indent: indent))
      }
      return chunk
    case .rule: chunk = plain("———")
    case .table(let table):
      // Each cell is its own Markdown, as in the transcript, so one cell's mark never pairs with another's.
      let rows = [table.header.map { inline($0, font: Self.bold(body)) }] + table.rows.map { $0.map { inline($0, font: body) } }
      // A tab stop past each column's widest cell lines the columns up as a grid.
      let style = NSMutableParagraphStyle()
      style.firstLineHeadIndent = indent
      style.headIndent = indent
      style.tabStops = []  // A new style starts with default stops every 28 points.
      var edge = indent
      for column in 0..<max(table.header.count - 1, 0) {
        edge += (rows.map { $0.indices.contains(column) ? ceil($0[column].size().width) : 0 }.max() ?? 0) + 24
        style.tabStops.append(NSTextTab(textAlignment: .natural, location: edge))
      }
      chunk = NSMutableAttributedString()
      for (index, cells) in rows.enumerated() {
        if index > 0 { chunk.append(plain("\n")) }
        for (column, cell) in cells.enumerated() {
          if column > 0 { chunk.append(plain("\t")) }
          chunk.append(cell)
        }
      }
      chunk.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: chunk.length))
      return chunk
    }
    if indent > 0 {
      let style = NSMutableParagraphStyle()
      style.firstLineHeadIndent = indent
      style.headIndent = indent
      chunk.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: chunk.length))
    }
    return chunk
  }
  /// The marker hangs in the margin so wrapped lines align with the item's text. A paragraph's
  /// style is read from its first character, so one style covers the marker and the whole first
  /// paragraph, keeping a deeper indent the first block already has, such as a quote's.
  private func listItem(_ item: MarkdownListItem, marker: String, indent: CGFloat) -> NSMutableAttributedString {
    let markerWidth = (marker as NSString).size(withAttributes: [.font: body]).width
    let content = blocks(item.blocks, indent: indent + markerWidth, separator: "\n")
    let first = (content.string as NSString).paragraphRange(for: NSRange(location: 0, length: 0))
    let existing = content.length > 0 ? content.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle : nil
    content.insert(plain(marker), at: 0)
    // Copied, so the first block's own settings, such as a table's tab stops, carry over.
    let style = (existing?.mutableCopy() as? NSMutableParagraphStyle) ?? NSMutableParagraphStyle()
    style.firstLineHeadIndent = indent
    style.headIndent = max(existing?.headIndent ?? 0, indent + markerWidth)
    content.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: (marker as NSString).length + first.length))
    return content
  }
  /// Inline Markdown through the transcript's own parser, with its styles as UIKit fonts.
  private func inline(_ text: String, font: UIFont) -> NSMutableAttributedString {
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
