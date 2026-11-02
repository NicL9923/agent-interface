import SwiftUI
import UIKit
import UniformTypeIdentifiers
import WebKit

/// Typing for the shared desktop. Text and keys go to the viewer page's `desktopInput`, which
/// sends nothing unless this viewer is connected and holds the desktop.
@MainActor final class DesktopTyping {
  /// The keys the page knows by name, the same as the web panel's.
  enum Key: String, CaseIterable { case enter, tab, backspace, escape, delete, left, up, right, down, home, end, pageUp, pageDown }
  enum Input: Equatable { case text(String), key(Key) }
  /// The viewer page, once its web view exists.
  weak var webView: WKWebView?
  func send(_ input: Input, control: Bool = false) {
    webView?.evaluateJavaScript(Self.script(input, control: control))
  }
  /// A call with its input as a JSON literal, so typed text can never end the statement.
  static func script(_ input: Input, control: Bool) -> String {
    var body: [String: Any] = [:]
    switch input {
    case .text(let text): body["text"] = text
    case .key(let key): body["key"] = key.rawValue
    }
    if control { body["control"] = true }
    let data = (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])) ?? Data("{}".utf8)
    return "window.desktopInput?.(\(String(decoding: data, as: UTF8.self))) === true"
  }
  /// Whether this web view holds the first responder, as after a tap on the desktop.
  var holdsFocus: Bool {
    guard let webView else { return false }
    func search(_ view: UIView) -> Bool { view.isFirstResponder || view.subviews.contains(where: search) }
    return search(webView)
  }
}

/// The system keyboard for the shared desktop, shown while `shown` is on; `hidden` reports that it
/// went away. Each key goes straight to the desktop: Return presses Enter and Delete presses
/// Backspace. A row above the keyboard adds Escape, Tab, a one-shot Control and arrows, and pastes
/// without a permission prompt. A tap on the desktop, which moves focus into the web view, keeps
/// the keyboard up so the field it picks takes the typing.
struct DesktopKeyboard: UIViewRepresentable {
  var shown: Bool
  var typing: DesktopTyping
  var hidden: () -> Void
  func makeCoordinator() -> Coordinator { Coordinator(self) }
  func makeUIView(context: Context) -> KeyView {
    let view = KeyView()
    view.coordinator = context.coordinator
    return view
  }
  func updateUIView(_ view: KeyView, context: Context) {
    context.coordinator.parent = self
    // Focus changes wait for the update to finish, as the composer's do: resigning reports back.
    if shown, !view.isFirstResponder {
      DispatchQueue.main.async { if view.window != nil, !view.becomeFirstResponder() { context.coordinator.parent.hidden() } }
    } else if !shown, view.isFirstResponder {
      DispatchQueue.main.async { _ = view.resignFirstResponder() }
    }
  }
  static func dismantleUIView(_ view: KeyView, coordinator: Coordinator) { view.resignFirstResponder() }

  @MainActor final class Coordinator {
    var parent: DesktopKeyboard
    /// The next key is sent with Control held, then this turns off.
    var control = false { didSet { onControl?(control) } }
    var onControl: ((Bool) -> Void)?
    init(_ parent: DesktopKeyboard) { self.parent = parent }
    func send(_ input: DesktopTyping.Input) {
      parent.typing.send(input, control: control)
      if control { control = false }
    }
    /// The keyboard went away. Done or leaving already turned `shown` off; a tap on the desktop
    /// moved focus into the web view, so take it back; anything else, such as the system, ends it.
    func resigned(_ view: KeyView) {
      control = false
      guard parent.shown else { return }
      DispatchQueue.main.async { [self] in
        guard parent.shown else { return }
        if view.window != nil, parent.typing.holdsFocus, view.becomeFirstResponder() { return }
        parent.hidden()
      }
    }
  }

  final class KeyView: UIView, UIKeyInput {
    weak var coordinator: Coordinator?
    override var canBecomeFirstResponder: Bool { true }
    override init(frame: CGRect) {
      super.init(frame: frame)
      isAccessibilityElement = false
      pasteConfiguration = UIPasteConfiguration(acceptableTypeIdentifiers: [UTType.plainText.identifier])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
    // Typing goes to another computer: no corrections, capitals or smart punctuation of its own.
    var autocorrectionType: UITextAutocorrectionType = .no
    var autocapitalizationType: UITextAutocapitalizationType = .none
    var spellCheckingType: UITextSpellCheckingType = .no
    var smartQuotesType: UITextSmartQuotesType = .no
    var smartDashesType: UITextSmartDashesType = .no
    var smartInsertDeleteType: UITextSmartInsertDeleteType = .no
    var inlinePredictionType: UITextInlinePredictionType = .no
    var keyboardType: UIKeyboardType = .asciiCapable
    // Delete stays on: the desktop's field, not this view, holds the text.
    var hasText: Bool { true }
    func insertText(_ text: String) { coordinator?.send(.text(text)) }
    func deleteBackward() { coordinator?.send(.key(.backspace)) }
    override func resignFirstResponder() -> Bool {
      let resigned = super.resignFirstResponder()
      if resigned { coordinator?.resigned(self) }
      return resigned
    }
    override func paste(itemProviders: [NSItemProvider]) {
      for provider in itemProviders where provider.canLoadObject(ofClass: String.self) {
        _ = provider.loadObject(ofClass: String.self) { [weak self] text, _ in
          guard let text else { return }
          DispatchQueue.main.async { self?.coordinator?.send(.text(text)) }
        }
      }
    }
    // A hardware keyboard's arrows and Escape, which never reach insertText.
    override var keyCommands: [UIKeyCommand]? {
      let keys: [(String, DesktopTyping.Key)] = [
        (UIKeyCommand.inputEscape, .escape), (UIKeyCommand.inputDelete, .delete), (UIKeyCommand.inputLeftArrow, .left), (UIKeyCommand.inputRightArrow, .right),
        (UIKeyCommand.inputUpArrow, .up), (UIKeyCommand.inputDownArrow, .down), (UIKeyCommand.inputHome, .home),
        (UIKeyCommand.inputEnd, .end), (UIKeyCommand.inputPageUp, .pageUp), (UIKeyCommand.inputPageDown, .pageDown),
      ]
      return keys.map { input, key in
        let command = UIKeyCommand(title: key.rawValue, action: #selector(hardwareKey(_:)), input: input, propertyList: key.rawValue)
        command.wantsPriorityOverSystemBehavior = true
        return command
      }
    }
    @objc private func hardwareKey(_ command: UIKeyCommand) {
      guard let name = command.propertyList as? String, let key = DesktopTyping.Key(rawValue: name) else { return }
      coordinator?.send(.key(key))
    }
    override var inputAccessoryView: UIView? {
      if let accessory { return accessory }
      let made = makeAccessory()
      accessory = made
      return made
    }
    private var accessory: UIView?
    private func makeAccessory() -> UIView {
      let bar = UIInputView(frame: CGRect(x: 0, y: 0, width: 0, height: 48), inputViewStyle: .keyboard)
      bar.allowsSelfSizing = true
      let row = UIStackView()
      row.axis = .horizontal
      row.spacing = 4
      row.translatesAutoresizingMaskIntoConstraints = false
      func key(_ title: String?, symbol: String?, label: String, id: String, _ action: @escaping () -> Void) -> UIButton {
        var configuration = UIButton.Configuration.gray()
        configuration.title = title
        if let symbol { configuration.image = UIImage(systemName: symbol) }
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8)
        let button = UIButton(configuration: configuration, primaryAction: UIAction { _ in action() })
        button.accessibilityLabel = label
        button.accessibilityIdentifier = id
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 40).isActive = true
        button.widthAnchor.constraint(greaterThanOrEqualToConstant: 40).isActive = true
        return button
      }
      row.addArrangedSubview(key("esc", symbol: nil, label: "Escape", id: "desktopKey.escape") { [weak self] in self?.coordinator?.send(.key(.escape)) })
      row.addArrangedSubview(key("tab", symbol: nil, label: "Tab", id: "desktopKey.tab") { [weak self] in self?.coordinator?.send(.key(.tab)) })
      let control = key("ctrl", symbol: nil, label: "Control", id: "desktopKey.control") { [weak self] in
        guard let coordinator = self?.coordinator else { return }
        coordinator.control.toggle()
      }
      control.accessibilityHint = "Holds Control for the next key"
      coordinator?.onControl = { [weak control] on in
        guard let control else { return }
        control.configuration = on ? .filled() : .gray()
        control.configuration?.title = "ctrl"
        control.configuration?.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8)
        control.accessibilityValue = on ? "On" : nil
        control.accessibilityTraits = on ? [.button, .selected] : .button
      }
      row.addArrangedSubview(control)
      for (symbol, label, name) in [("arrow.left", "Left arrow", DesktopTyping.Key.left), ("arrow.up", "Up arrow", .up),
        ("arrow.down", "Down arrow", .down), ("arrow.right", "Right arrow", .right)] {
        row.addArrangedSubview(key(nil, symbol: symbol, label: label, id: "desktopKey.\(name.rawValue)") { [weak self] in self?.coordinator?.send(.key(name)) })
      }
      let paste = UIPasteControl(configuration: {
        let configuration = UIPasteControl.Configuration()
        configuration.displayMode = .iconOnly
        configuration.cornerStyle = .medium
        return configuration
      }())
      paste.target = self
      paste.accessibilityIdentifier = "desktopKey.paste"
      paste.widthAnchor.constraint(equalToConstant: 44).isActive = true
      row.addArrangedSubview(paste)
      // The Computer toolbar's keyboard button hides the keyboard, so every key here fits on a
      // phone; the row scrolls on a narrower screen or with larger text.
      let scroller = UIScrollView()
      scroller.showsHorizontalScrollIndicator = false
      scroller.translatesAutoresizingMaskIntoConstraints = false
      scroller.addSubview(row)
      bar.addSubview(scroller)
      NSLayoutConstraint.activate([
        scroller.leadingAnchor.constraint(equalTo: bar.layoutMarginsGuide.leadingAnchor),
        scroller.trailingAnchor.constraint(equalTo: bar.layoutMarginsGuide.trailingAnchor),
        scroller.topAnchor.constraint(equalTo: bar.topAnchor, constant: 4),
        scroller.bottomAnchor.constraint(equalTo: bar.bottomAnchor, constant: -4),
        row.leadingAnchor.constraint(equalTo: scroller.contentLayoutGuide.leadingAnchor),
        row.trailingAnchor.constraint(equalTo: scroller.contentLayoutGuide.trailingAnchor),
        row.topAnchor.constraint(equalTo: scroller.contentLayoutGuide.topAnchor),
        row.bottomAnchor.constraint(equalTo: scroller.contentLayoutGuide.bottomAnchor),
        row.heightAnchor.constraint(equalTo: scroller.frameLayoutGuide.heightAnchor),
      ])
      return bar
    }
  }
}
