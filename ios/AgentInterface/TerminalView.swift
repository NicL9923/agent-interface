import AuthenticationServices
import SwiftUI
import WebKit

/// A single-use terminal attachment from `POST /api/computer/terminal`, good for 30 seconds.
struct TerminalTicket: Decodable, Equatable {
  var path: String
  var expiresAt: String
  /// What `POST /api/computer/terminal/end` names to end this person's shell.
  var sessionId: String?
  var target: String?
}
/// `POST /api/auth/native/confirm`: the sign-in is confirmed for the terminal's 2-hour window.
struct IdentityConfirmation: Decodable, Equatable { var confirmedAt: String }

/// The terminal screen opened from the transcript. `command` is offered for the person to paste at
/// the prompt, and never run.
struct TerminalOpening: Identifiable, Equatable {
  let id = UUID()
  var command: String?
}

/// The rules of the native terminal, apart from the view so they can be tested.
enum TerminalLink {
  static let pagePath = "/native/terminal"
  private static let ticketPrefix = "/api/computer/terminal/ws?ticket="
  /// The only address the terminal page connects to: the terminal socket with a 43-character
  /// base64url ticket. Anything else never reaches the web view.
  static func validPath(_ path: String) -> Bool {
    guard path.hasPrefix(ticketPrefix) else { return false }
    let ticket = path.dropFirst(ticketPrefix.count)
    return ticket.count == 43 && ticket.utf8.allSatisfy {
      ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) || $0 == 0x2D || $0 == 0x5F
    }
  }
  /// The ticket path travels in the fragment, which never reaches the server or its logs. The page
  /// reconnects when the path changes.
  static func fragment(path: String) -> String { "path=\(DesktopLink.encode(path))" }
  static func pageURL(base: URL, path: String) -> URL? {
    guard validPath(path) else { return nil }
    var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
    components?.path = pagePath
    components?.query = nil
    components?.percentEncodedFragment = fragment(path: path)
    return components?.url
  }
  /// The terminal may load only the app server's terminal page. Links in it open nothing.
  static func allows(_ url: URL, base: URL) -> Bool {
    guard url.scheme == base.scheme, url.host == base.host, url.port == base.port else { return url.absoluteString == "about:blank" }
    #if DEBUG
      if base.host?.hasSuffix(".native-fixture.invalid") == true { return true }
    #endif
    return url.path == pagePath
  }
  /// Whether a bridge message comes from the terminal page itself.
  static func trusts(scheme: String, host: String, port: Int, page: URL?, base: URL) -> Bool {
    guard scheme == base.scheme, host == base.host, (port == 0 ? nil : port) == base.port, let page,
      page.scheme != "about"
    else { return false }
    return allows(page, base: base)
  }

  enum Step: Hashable {
    case checking
    case unavailable(String)
    case confirm
    case shell
  }
  static let unavailableReason = "The system terminal is not available on this Hermes host yet."
  /// Where the screen is: waiting for the status, refused (not an administrator, turned off, not
  /// installed), asking the person to confirm it's them, or opening the shell. `reauthenticate` is
  /// the server's own 401 after the window closed; `confirmedHere` is a confirmation this screen
  /// just made, which a status read from before it cannot undo.
  static func step(_ status: ComputerStatus?, reauthenticate: Bool, confirmedHere: Bool) -> Step {
    guard let status else { return .checking }
    guard let terminal = status.terminal else { return .unavailable(unavailableReason) }
    guard terminal.available else {
      return .unavailable(terminal.reason?.isEmpty == false ? terminal.reason! : unavailableReason)
    }
    if reauthenticate || (terminal.confirmationRequired == true && !confirmedHere) { return .confirm }
    return .shell
  }
  /// A failure that another ticket will not fix, so the screen stops retrying and says why.
  static func retryable(_ failure: Error) -> Bool {
    guard let failure = failure as? APIError else { return true }
    return !(400..<500).contains(failure.status) || failure.status == 408 || failure.status == 429
  }
  /// The server's answer when the 2-hour window has closed.
  static func needsConfirmation(_ failure: Error) -> Bool {
    guard let failure = failure as? APIError else { return false }
    return failure.status == 401 && failure.code == "reauthentication_required"
  }
}

extension AppStore {
  /// Proves it is still this person: the system sign-in browser with the confirm wording, then the
  /// code and its PKCE proof go to `/auth/native/confirm` with this device's token.
  func confirmIdentity() async throws {
    guard let api, api.token != nil, !confirmingIdentity else { return }
    confirmingIdentity = true
    defer { confirmingIdentity = false; authSession = nil }
    let (code, pkce) = try await authorize(api: api, purpose: "confirm")
    try await redeemConfirmation(code: code, pkce: pkce, through: api)
  }
  func redeemConfirmation(code: String, pkce: PKCE, through client: APIClient) async throws {
    let _: IdentityConfirmation = try await client.write(
      "/auth/native/confirm", ["code": code, "state": pkce.state, "codeVerifier": pkce.verifier])
  }
}

/// The server's terminal page in a web view with no stored data. The page reports its connection
/// through the `terminal` message handler; navigation stays on the app server. The native keyboard
/// types into it, so the page never raises the web keyboard.
struct TerminalWebView: UIViewRepresentable {
  enum Event: Equatable {
    case connected, disconnected(String?), failed(String?), ended, error(String), focus
  }
  var base: URL
  var path: String
  var typing: DesktopTyping
  var event: (Event) -> Void
  func makeCoordinator() -> Coordinator { Coordinator(self) }
  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.userContentController.add(WeakScriptHandler(context.coordinator), name: "terminal")
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = context.coordinator
    view.isOpaque = false
    view.backgroundColor = .clear
    view.scrollView.isScrollEnabled = false
    view.scrollView.contentInsetAdjustmentBehavior = .never
    typing.webView = view
    return view
  }
  func updateUIView(_ view: WKWebView, context: Context) {
    context.coordinator.parent = self
    let fragment = TerminalLink.fragment(path: path)
    guard fragment != context.coordinator.applied else { return }
    if context.coordinator.loaded {
      // The page follows its fragment: a new path reconnects.
      view.evaluateJavaScript("location.hash = \(DesktopWebView.literal(fragment))")
      context.coordinator.applied = fragment
    } else if !context.coordinator.loading {
      context.coordinator.loading = true
      #if DEBUG
        if base.host?.hasSuffix(".native-fixture.invalid") == true {
          view.loadHTMLString(TerminalFixturePage.html, baseURL: base)
          return
        }
      #endif
      guard let url = TerminalLink.pageURL(base: base, path: path) else { context.coordinator.loading = false; return }
      context.coordinator.applied = fragment
      view.load(URLRequest(url: url))
    }
    // While the page loads, didFinish applies the latest fragment.
  }
  static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
    view.configuration.userContentController.removeScriptMessageHandler(forName: "terminal")
    view.stopLoading()
  }
  final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    var parent: TerminalWebView
    var loaded = false
    var loading = false
    var applied: String?
    init(_ parent: TerminalWebView) { self.parent = parent }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      loaded = true
      loading = false
      // A page loaded without the fragment, as the fixture page is, gets it now.
      let fragment = TerminalLink.fragment(path: parent.path)
      if applied != fragment {
        applied = fragment
        webView.evaluateJavaScript("location.hash = \(DesktopWebView.literal(fragment))")
      }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    private func failed(_ error: Error) {
      loading = false
      parent.event(.failed(error.localizedDescription))
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
      guard let url = action.request.url else { return .cancel }
      return TerminalLink.allows(url, base: parent.base) ? .allow : .cancel
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
      let origin = message.frameInfo.securityOrigin
      guard message.frameInfo.isMainFrame,
        TerminalLink.trusts(scheme: origin.protocol, host: origin.host, port: origin.port, page: message.webView?.url, base: parent.base),
        let body = message.body as? [String: Any], let type = body["type"] as? String
      else { return }
      if let event = Self.event(type: type, body: body) { parent.event(event) }
    }
    /// A page message as the screen sees it; unknown types and malformed fields are nothing.
    static func event(type: String, body: [String: Any]) -> Event? {
      let reason = body["reason"] as? String
      switch type {
      case "connected": return .connected
      case "disconnected": return .disconnected(reason)
      case "failed": return .failed(reason)
      case "ended": return .ended
      case "error": return (body["message"] as? String).map { .error($0) }
      case "focus": return .focus
      default: return nil
      }
    }
  }
}

/// Settings > Computer > Terminal: the household's system shell in the app. The server decides who
/// may open it. A sign-in older than 2 hours asks the person to confirm it's them first. The shell
/// keeps running on the server when this screen closes; End shell stops it.
struct TerminalView: View {
  /// An assistant's command, offered beside the shell for the person to paste. It is never run.
  var command: String? = nil
  init(command: String? = nil) {
    self.command = command
    _offered = State(initialValue: TerminalRequest.pasteable(command))
  }
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var scheme
  enum Phase: Equatable { case opening, connected, reconnecting, ended, failed(String) }
  @State private var ticket: TerminalTicket?
  @State private var sessionId: String?
  @State private var phase: Phase = .opening
  @State private var attempt = 0
  /// Bumped for each attachment, so a late answer for an earlier one changes nothing.
  @State private var epoch = 0
  @State private var reauthenticate = false
  @State private var confirmedHere = false
  @State private var confirming = false
  @State private var ending = false
  @State private var endAsked = false
  @State private var error: String?
  @State private var info: String?
  @State private var typing = DesktopTyping(bridge: .terminal)
  @State private var keyboard = false
  /// The assistant's command until the person pastes or dismisses it. It never arrives on its own:
  /// the persistent shell may be running a program that waits for one key, which pasted text could answer.
  @State private var offered: String?
  private var step: TerminalLink.Step {
    // A shell already on screen stays put when the status later asks for a new confirmation.
    if ticket != nil, !reauthenticate, phase != .ended { return .shell }
    return TerminalLink.step(store.computerStatus, reauthenticate: reauthenticate, confirmedHere: confirmedHere)
  }
  private var target: String { store.computerStatus?.terminal?.target ?? ticket?.target ?? "" }
  private struct Key: Hashable { var step: TerminalLink.Step; var scope: String? }
  var body: some View {
    VStack(spacing: 0) {
      switch step {
      case .checking: message("Checking the terminal", detail: "Looking up your access to the system terminal.", symbol: nil)
      case .unavailable(let reason): message("Terminal unavailable", detail: reason, symbol: "terminal").accessibilityIdentifier("terminalUnavailable")
      case .confirm: confirm
      case .shell: shell
      }
    }.background(Palette.surface(scheme))
      .background { DesktopKeyboard(shown: keyboard && phase == .connected, typing: typing) { keyboard = false }.frame(width: 0, height: 0).accessibilityHidden(true) }
      .navigationTitle("Terminal").navigationBarTitleDisplayMode(.inline)
      .task { await watchStatus() }
      .task(id: Key(step: step, scope: store.scope)) { if step == .shell, ticket == nil { await attach(fresh: true) } }
      .onChange(of: phase) { _, phase in if phase != .connected { keyboard = false } }
      .onDisappear {
        // A reconnect still waiting must not fetch tickets for a screen that is gone.
        epoch += 1
        keyboard = false
      }
      .confirmationDialog("End your shell?", isPresented: $endAsked, titleVisibility: .visible) {
        Button("End shell", role: .destructive) { Task { await endShell() } }
        Button("Keep it running", role: .cancel) {}
      } message: { Text("This stops everything running in it. Closing this screen keeps your shell running instead.") }
  }

  private func message(_ title: String, detail: String, symbol: String?) -> some View {
    VStack(spacing: 10) {
      if let symbol { Image(systemName: symbol).font(.title).foregroundStyle(Palette.muted) } else { ProgressView() }
      Text(title).font(.headline)
      Text(detail).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
    }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity).accessibilityElement(children: .combine)
  }
  private var confirm: some View {
    VStack(spacing: 14) {
      Image(systemName: "person.badge.shield.checkmark").font(.largeTitle).foregroundStyle(Palette.accent)
      Text("Confirm it's you").font(.title3.bold())
      Text("The terminal is a real shell on the Hermes host. Sign in again to open it. This lasts 2 hours.")
        .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
      if let error { Text(error).font(.footnote).foregroundStyle(Palette.attention).multilineTextAlignment(.center).accessibilityIdentifier("terminalNotice") }
      Button(confirming ? "Confirming…" : "Confirm with Google") { Task { await confirmIdentity() } }
        // The app server, not Hermes: the terminal is how an administrator repairs a Hermes that is down.
        .buttonStyle(.accentProminent).controlSize(.large).disabled(confirming || !signedIn)
        .accessibilityIdentifier("terminalConfirm")
    }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
  }
  private var shell: some View {
    VStack(spacing: 0) {
      HStack(alignment: .center, spacing: 12) {
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 6) {
            Circle().fill(phase == .connected ? Palette.accent : Palette.muted).frame(width: 8, height: 8).accessibilityHidden(true)
            Text(headline).font(.subheadline.weight(.semibold))
          }
          if !target.isEmpty { Text(target).font(.caption).foregroundStyle(.secondary) }
        }.frame(maxWidth: .infinity, alignment: .leading).accessibilityElement(children: .combine).accessibilityIdentifier("terminalStatus")
        Button(ending ? "Ending…" : "End shell") { endAsked = true }
          .buttonStyle(.bordered).disabled(ending || sessionId == nil || phase == .ended)
          .accessibilityIdentifier("terminalEnd")
      }.padding(12)
      if let message = error { notice(message) } else if let info {
        Text(info).font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 12).padding(.bottom, 8).accessibilityIdentifier("terminalInfo")
      }
      screen.frame(maxWidth: .infinity, maxHeight: .infinity)
      if let offered { offer(offered) }
      HStack(spacing: 4) {
        Button { keyboard.toggle() } label: { barIcon(keyboard ? "keyboard.chevron.compact.down" : "keyboard") }
          .disabled(phase != .connected)
          .accessibilityLabel(keyboard ? "Hide keyboard" : "Type in the terminal")
          .accessibilityIdentifier("terminalKeyboard")
        Button { Task { await pasteFromDevice() } } label: { barIcon("doc.on.clipboard") }
          .disabled(phase != .connected)
          .accessibilityLabel("Paste from \(UIDevice.current.localizedModel)").accessibilityIdentifier("terminalPaste")
        Spacer(minLength: 0)
      }.padding(.horizontal, 8).padding(.top, 4)
      Text("Closing this screen keeps your shell running. Tap ctrl, then c, to stop a command.")
        .font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(12)
    }
  }
  /// Signed in to the app server, whether or not Hermes is connected.
  private var signedIn: Bool { store.api?.token != nil && !store.sessionExpired && !store.appUnavailable }
  private func offer(_ command: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(command).font(.system(.footnote, design: .monospaced)).textSelection(.enabled).accessibilityIdentifier("terminalOffer")
      Text("Check the terminal is at a prompt first. Pasting doesn't run it; you press Return.").font(.caption).foregroundStyle(.secondary)
      HStack {
        Spacer()
        Button("Dismiss") { offered = nil }.accessibilityIdentifier("terminalOfferDismiss")
        Button("Paste at prompt") { Task { await pasteOffered(command) } }.buttonStyle(.borderedProminent)
          .disabled(phase != .connected).accessibilityIdentifier("terminalOfferPaste")
      }.frame(minHeight: 44)
    }.padding(10).background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
      .padding(.horizontal, 12).padding(.top, 8).accessibilityElement(children: .contain)
  }
  private var headline: String {
    switch phase {
    case .connected: "Your system terminal"
    case .ended: "Shell ended"
    default: "Connecting to your terminal"
    }
  }
  private func notice(_ message: String) -> some View {
    Text(message).font(.footnote).foregroundStyle(Palette.attention).frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 12).padding(.bottom, 8).accessibilityIdentifier("terminalNotice")
  }
  private func barIcon(_ symbol: String) -> some View {
    Image(systemName: symbol).font(.title3).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
  }
  @ViewBuilder private var screen: some View {
    ZStack {
      Color.black.opacity(scheme == .dark ? 0.4 : 0.06)
      if let api = store.api, let ticket {
        TerminalWebView(base: api.baseURL, path: ticket.path, typing: typing, event: received)
          .accessibilityLabel("System terminal").accessibilityIdentifier("terminalScreen")
      }
      if phase != .connected {
        VStack(spacing: 10) {
          Image(systemName: "terminal").font(.title).foregroundStyle(Palette.muted)
          Text(phaseLabel).font(.headline)
          if case .failed(let reason) = phase {
            Text(reason).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button("Reconnect") { Task { await attach(fresh: true) } }.buttonStyle(.bordered).accessibilityIdentifier("terminalReconnect")
          } else if phase == .ended {
            Text("Starting a terminal opens a new shell.").font(.footnote).foregroundStyle(.secondary)
            Button("Start terminal") { Task { await attach(fresh: true) } }.buttonStyle(.bordered).accessibilityIdentifier("terminalStart")
          } else { ProgressView() }
        }.padding(24).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16)).padding()
          .accessibilityElement(children: .contain).accessibilityIdentifier("terminalConnection")
      }
    }
  }
  private var phaseLabel: String {
    switch phase {
    case .opening: "Opening your shell"
    case .reconnecting: "Reconnecting terminal"
    case .ended: "Your shell has ended"
    case .failed: "Terminal connection unavailable"
    case .connected: ""
    }
  }

  private func watchStatus() async {
    while !Task.isCancelled {
      // The shell does not need the status; the steps before it do.
      if step != .shell { await store.refreshComputer() }
      // Timer: the status poll's interval while the terminal is not open.
      do { try await Task.sleep(for: .seconds(5)) } catch { return }
    }
  }
  private func confirmIdentity() async {
    guard !confirming else { return }
    confirming = true; error = nil
    defer { confirming = false }
    do {
      try await store.confirmIdentity()
      reauthenticate = false; confirmedHere = true
      await store.refreshComputer()
    } catch {
      self.error = Self.confirmMessage(error)
    }
  }
  /// What a failed confirmation says: the server's own reason. Closing the sign-in browser says nothing.
  static func confirmMessage(_ error: Error) -> String? {
    (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin ? nil : error.localizedDescription
  }

  /// Gets a ticket for the terminal page.
  private func attach(fresh: Bool = false) async {
    epoch += 1
    let current = epoch
    if fresh { attempt = 0; error = nil }
    phase = attempt == 0 ? .opening : .reconnecting
    switch await store.attempt(current: { epoch == current }, { context -> TerminalTicket in
      try await context.api.write("/computer/terminal", [String: String]())
    }) {
    case .success(let value)?:
      guard TerminalLink.validPath(value.path) else {
        phase = .failed("The server sent a terminal address this app will not open.")
        return
      }
      error = nil
      if let id = value.sessionId { sessionId = id }
      ticket = value
      await connectDeadline(value, epoch: current)
    case .failure(let failure)?:
      if TerminalLink.needsConfirmation(failure) {
        // The window closed since the status was read: ask again before another ticket.
        ticket = nil; reauthenticate = true; confirmedHere = false
        await store.refreshComputer()
      } else if TerminalLink.retryable(failure) { dropped(failure.localizedDescription, epoch: current) }
      else { phase = .failed(failure.localizedDescription) }
    case nil: break
    }
  }
  /// A ticket the page has not used before it expires is spent; get another.
  private func connectDeadline(_ value: TerminalTicket, epoch current: Int) async {
    guard let wait = DesktopLink.connectWait(expiresAt: value.expiresAt, now: Date()) else { return }
    // Timer: waits out the ticket's 30-second life before checking it connected.
    try? await Task.sleep(for: wait)
    guard !Task.isCancelled, epoch == current, phase != .connected, phase != .ended else { return }
    dropped("The terminal did not connect in time.", epoch: current)
  }
  private func dropped(_ reason: String, epoch current: Int) {
    guard epoch == current else { return }
    guard let delay = DesktopLink.retryDelay(attempt: attempt) else {
      phase = .failed(reason + " Reconnect to try again.")
      return
    }
    attempt += 1
    phase = .reconnecting
    Task {
      // Timer: the reconnect backoff.
      try? await Task.sleep(for: delay)
      guard epoch == current else { return }
      await attach()
    }
  }
  private func received(_ event: TerminalWebView.Event) {
    // Ending the shell closes its socket; that drop must not start another shell.
    if phase == .ended || ending { return }
    switch event {
    case .connected:
      phase = .connected; attempt = 0; error = nil
    case .disconnected(let reason), .failed(let reason):
      guard phase == .connected || phase == .opening || phase == .reconnecting else { return }
      dropped(Self.dropMessage(reason), epoch: epoch)
    case .ended:
      epoch += 1
      phase = .ended; keyboard = false
    case .error(let message): error = message
    case .focus: if phase == .connected { keyboard = true }
    }
  }
  static func dropMessage(_ reason: String?) -> String {
    reason == "invalid_ticket" ? "The terminal ticket was refused." : "Terminal disconnected. Reconnecting to your shell."
  }
  /// The assistant's command goes to the prompt as a paste when the person asks, so they read it before Return.
  /// The offer is taken before the paste starts, so a second tap while WebKit answers pastes nothing.
  private func pasteOffered(_ command: String) async {
    guard phase == .connected, offered == command else { return }
    offered = nil
    if await typing.paste(command) {
      info = "Pasted the command at the prompt. Read it, then press Return to run it."
    } else {
      // Nothing reached the shell, so the person can try again.
      if offered == nil { offered = command }
      info = "Couldn't paste the command. Wait for the terminal to connect, then try again."
    }
  }
  private func pasteFromDevice() async {
    guard phase == .connected else { return }
    guard let text = UIPasteboard.general.string, !text.isEmpty else {
      info = "Your \(UIDevice.current.localizedModel)'s clipboard has no text."
      return
    }
    let limit = DesktopTyping.pasteLimit
    info = await typing.paste(text)
      ? (text.unicodeScalars.count > limit ? "Pasted the first \(limit) characters." : "Pasted into the terminal.")
      : "Couldn't paste. Wait for the terminal to connect, then try again."
  }
  /// Ends the shell on the server. A failure leaves it running, so the screen reconnects to it.
  private func endShell() async {
    guard let sessionId, !ending else { return }
    ending = true; error = nil
    epoch += 1
    let current = epoch
    defer { ending = false }
    switch await store.attempt({ context -> EmptyResponse in
      try await context.api.write("/computer/terminal/end", ["sessionId": sessionId])
    }) {
    case .success?:
      epoch += 1
      ticket = nil; phase = .ended; keyboard = false
    case .failure(let failure)?:
      error = "Couldn't confirm whether your shell ended. \(failure.localizedDescription)"
      if epoch == current { await attach(fresh: true) }
    case nil: break
    }
  }
}

#if DEBUG
  /// UI test stand-in for the server's terminal page: it reports a connection for each ticket path,
  /// reports a tap as focus, and shows what the app typed or pasted, so the native keyboard can be
  /// exercised without a shell.
  enum TerminalFixturePage {
    static let html = """
      <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body{margin:0;font:600 17px ui-monospace,Menlo;display:grid;place-content:center;text-align:center;height:100vh;background:#111;color:#8f8}</style>
      <p id="mode">Fixture terminal</p><p id="typed"></p>
      <script>
      let connected=false,typed='';
      const post=m=>window.webkit.messageHandlers.terminal.postMessage(m);
      function apply(){const p=new URLSearchParams(location.hash.slice(1));if(!p.get('path'))return;connected=true;post({type:'connected'})}
      const show=()=>document.getElementById('typed').textContent='Typed: '+typed;
      window.terminalInput=i=>{if(!connected)return false;const k=i.key?'['+i.key+']':String(i.text);
      typed+=i.control?'[ctrl+'+k+']':k;show();return true};
      window.terminalPaste=t=>{if(!connected||typeof t!=='string'||!t)return false;typed+='[paste:'+t+']';show();return true};
      document.body.addEventListener('click',()=>post({type:'focus'}));
      addEventListener('hashchange',apply);apply()
      </script>
      """
  }
#endif

/// An assistant asking a person to use the system terminal. Its reason, the step it asks for and
/// the command are the assistant's own words. The person settles it with Done or Not now.
struct TerminalRequest: Codable, Equatable {
  var epoch: String
  var sessionId: String
  var reason: String
  var whatToDo: String
  var command: String? = nil
  /// The command as the app may paste it: one line of visible text. A command with a line break or
  /// any control or invisible character is never pasted, since a shell could run part of it before
  /// the person has read it. They can still copy it and decide.
  static func pasteable(_ command: String?) -> String? {
    guard let command, !command.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
    let hidden: Set<Unicode.GeneralCategory> = [.control, .format, .lineSeparator, .paragraphSeparator, .surrogate, .privateUse, .unassigned]
    return command.unicodeScalars.contains(where: { hidden.contains($0.properties.generalCategory) }) ? nil : command
  }
}
/// What a person chose: Done sends `done`, Not now sends `decline`.
struct TerminalDecision: Codable, Equatable {
  var decision: String
  var epoch: String
  var sessionId: String
  static let done = "done"
  static let decline = "decline"
  init(_ decision: String, for request: TerminalRequest) {
    self.decision = decision; epoch = request.epoch; sessionId = request.sessionId
  }
}
struct TerminalRequestResult: Decodable { var status: String }

/// The card for a terminal request. Open terminal opens the terminal and offers the command to paste
/// at the prompt; Done says the person finished; Not now declines.
struct TerminalRequestView: View {
  var request: Attention
  var terminal: TerminalRequest
  var botId: String
  @Environment(AppStore.self) private var store
  @State private var sending: String?
  @State private var copied = false
  @State private var error: String?
  private var name: String { store.bootstrap?.bots.first { $0.id == botId }?.name ?? "The assistant" }
  private var status: ComputerStatus.Terminal? { store.computerStatus?.terminal }
  /// Known only once the status has been read; until then the buttons stay usable and the server decides.
  private var refused: String? {
    guard store.computerStatus != nil else { return nil }
    guard let status else { return TerminalLink.unavailableReason }
    return status.available ? nil : (status.reason?.isEmpty == false ? status.reason : TerminalLink.unavailableReason)
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("\(name) needs you in the terminal").font(.subheadline.bold())
      ForEach([("Why", terminal.reason), ("What to do", terminal.whatToDo)], id: \.0) { label, value in
        VStack(alignment: .leading, spacing: 2) {
          Text(label).font(.caption).foregroundStyle(.secondary)
          Text(value).font(.subheadline).textSelection(.enabled)
        }.accessibilityElement(children: .combine)
      }
      if let command = terminal.command, !command.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          HStack {
            Text("Command").font(.caption).foregroundStyle(.secondary)
            Spacer()
            Button(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc") {
              UIPasteboard.general.string = command; copied = true
              AccessibilityNotification.Announcement("Copied the command.").post()
            }.font(.caption).accessibilityIdentifier("terminal.copy")
          }
          Text(command).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
            .accessibilityIdentifier("terminal.command")
        }
      }
      Text("In \(name)'s words. \(name) can't see your terminal. Check the command before you run it.")
        .font(.caption).foregroundStyle(.secondary)
      if let refused { Text(refused).font(.footnote).accessibilityIdentifier("terminal.state") }
      HStack {
        Button("Open terminal", systemImage: "terminal") {
          store.openTerminal = TerminalOpening(command: TerminalRequest.pasteable(terminal.command))
        }.buttonStyle(.accentProminent).controlSize(.large)
          .disabled(!store.connected || sending != nil || refused != nil).accessibilityIdentifier("terminal.open")
        Button { settle(TerminalDecision.done) } label: { action(sending == TerminalDecision.done ? "Sending…" : "Done") }
          .disabled(!store.connected || sending != nil || refused != nil).accessibilityIdentifier("terminal.done")
        Button { settle(TerminalDecision.decline) } label: { action(sending == TerminalDecision.decline ? "Sending…" : "Not now") }
          .disabled(!store.connected || sending != nil).accessibilityIdentifier("terminal.decline")
      }
      if let command = terminal.command, !command.isEmpty {
        Text(TerminalRequest.pasteable(command) != nil
          ? "Open terminal offers to paste the command at the prompt. It doesn't run it."
          : "This command has characters the app won't paste for you. Copy it and read it carefully.")
          .font(.caption).foregroundStyle(.secondary)
      }
      Text("Or send a message instead. That cancels this request so \(name) can read it.")
        .font(.caption).foregroundStyle(.secondary)
      if let error { Text(error).font(.footnote).foregroundStyle(Palette.attention).accessibilityIdentifier("terminal.error") }
    }.task { while !Task.isCancelled { await store.refreshComputer(); try? await Task.sleep(for: .seconds(10)) } }
      .accessibilityElement(children: .contain).accessibilityIdentifier("terminalRequest")
  }
  private func action(_ title: String) -> some View {
    Text(title).frame(minHeight: 44).padding(.horizontal, 8).contentShape(Rectangle())
  }
  private func settle(_ decision: String) {
    guard let api = store.api, sending == nil else { return }
    sending = decision; error = nil
    let id = request.id
    Task {
      defer { sending = nil }
      do {
        let path = "/bots/\(APIClient.component(botId))/terminal-requests/\(APIClient.component(id))"
        let result: TerminalRequestResult = try await api.write(path, TerminalDecision(decision, for: terminal))
        if result.status == "expired" { error = "This request had already closed. Refresh the conversation to see what happened."; return }
        let receipt = decision == TerminalDecision.done
          ? "You said you finished in the terminal. \(name) will check the result."
          : "You chose Not now. \(name) will continue without it."
        SettledRequests.shared.remember(botId: botId, requestId: id, text: receipt)
        await store.refreshConversation()
      } catch let failure as APIError where failure.status == 403 || failure.status == 404 || failure.status == 409 {
        error = failure.message
      } catch { self.error = "Couldn't reach Hermes. Try \(decision == TerminalDecision.done ? "Done" : "Not now") again." }
    }
  }
}
