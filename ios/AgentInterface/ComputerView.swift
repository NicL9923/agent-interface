import SwiftUI
import WebKit

/// A single-use desktop attachment from `POST /api/computer/desktop`, good for 30 seconds.
struct DesktopTicket: Decodable, Equatable {
  var path: String
  var expiresAt: String
  var viewerId: String?
}

/// The rules of the native desktop viewer, apart from the view so they can be tested.
enum DesktopLink {
  /// The server's native viewer page with the ticket, control and touch mode in its fragment, which
  /// never reaches the server or its logs. The page reconnects when the path changes, only switches
  /// input on or off when `control` changes, and only its touch mode when `trackpad` does.
  static func pageURL(base: URL, path: String, control: Bool, trackpad: Bool = false) -> URL? {
    var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
    components?.path = "/native/computer"
    components?.query = nil
    components?.percentEncodedFragment = fragment(path: path, control: control, trackpad: trackpad)
    return components?.url
  }
  static func fragment(path: String, control: Bool, trackpad: Bool = false) -> String {
    "path=\(encode(path))&control=\(control ? 1 : 0)" + (trackpad ? "&trackpad=1" : "")
  }
  /// encodeURIComponent's escaping, which the page reverses.
  static func encode(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.!~*'()")) ?? ""
  }
  /// How long a page may take to connect with a ticket: until the ticket expires, and at least a
  /// second. A page that has not connected by then needs a fresh ticket. Nil for an unreadable expiry.
  static func connectWait(_ ticket: DesktopTicket, now: Date) -> Duration? { connectWait(expiresAt: ticket.expiresAt, now: now) }
  static func connectWait(expiresAt: String, now: Date) -> Duration? {
    guard let expires = ServerDate.parse(expiresAt) else { return nil }
    return .milliseconds(Int((max(1, expires.timeIntervalSince(now)) * 1000).rounded()))
  }
  /// How long to wait before reconnecting after a drop, growing with each failed attempt, or nil
  /// once it is time to stop and offer Reconnect.
  static func retryDelay(attempt: Int) -> Duration? {
    guard attempt < 5 else { return nil }
    return .seconds(min(8, 1 << attempt))
  }
  /// The viewer may load only the app server's viewer page. Links on the desktop open nothing.
  static func allows(_ url: URL, base: URL) -> Bool {
    // A blank page is the only page from elsewhere, as a web view starts on it.
    guard url.scheme == base.scheme, url.host == base.host, url.port == base.port else { return url.absoluteString == "about:blank" }
    #if DEBUG
      if base.host?.hasSuffix(".native-fixture.invalid") == true { return true }
    #endif
    return url.path == "/native/computer"
  }
  /// Whether a bridge message comes from the viewer page itself: the app server's origin, its
  /// default port written as 0 as WebKit does, and a page the viewer may load.
  static func trusts(scheme: String, host: String, port: Int, page: URL?, base: URL) -> Bool {
    guard scheme == base.scheme, host == base.host, (port == 0 ? nil : port) == base.port, let page,
      page.scheme != "about"
    else { return false }
    return allows(page, base: base)
  }
  /// Whether this person holds the desktop, so the viewer accepts their input.
  static func controlling(_ status: ComputerStatus?) -> Bool {
    status?.control.kind == "human" && status?.control.mine == true
  }
  /// Take over is off while another household member has control.
  static func canTake(_ status: ComputerStatus?) -> Bool {
    guard let status, status.available else { return false }
    return !(status.control.kind == "human" && status.control.mine != true)
  }
}

/// Settings > Computer: the shared desktop in the app, through the server's native viewer page.
/// The viewer watches until Take over; Hand back returns the desktop to the assistants. The bottom
/// bar has the keyboard, the clipboard and a ⋯ menu for trackpad mode and zoom; ? explains the
/// touch controls. The Terminal button opens the system terminal in a sheet, so the desktop keeps
/// running behind it.
struct ComputerView: View {
  /// Opened from an assistant's handoff request: take control as soon as the desktop connects, once.
  var take = false
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var scheme
  enum Phase: Equatable { case opening, connected, reconnecting, failed(String) }
  @State private var ticket: DesktopTicket?
  @State private var viewerId: String?
  @State private var phase: Phase = .opening
  @State private var attempt = 0
  @State private var desktop = DesktopControl()
  @State private var error: String?
  /// Bumped for each attachment, so a late answer for an earlier one changes nothing.
  @State private var epoch = 0
  @State private var tookOver = false
  @State private var typing = DesktopTyping()
  /// The system keyboard types into the desktop while this viewer has input.
  @State private var keyboard = false
  /// A finger moves a pointer instead of clicking where it lands. A per-device habit.
  @AppStorage("computerTrackpad") private var trackpad = false
  @State private var zoomed = false
  @State private var helpShown = false
  @State private var terminalShown = false
  /// The outcome of a clipboard action, until the next one or until input stops.
  @State private var info: String?
  private var status: ComputerStatus? { store.computerStatus }
  private var device: String { UIDevice.current.localizedModel }
  var body: some View {
    VStack(spacing: 0) {
      toolbar
      if let message = error ?? desktop.error ?? status?.reason { notice(message) }
      else if let info {
        Text(info).font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 12).padding(.bottom, 8).accessibilityIdentifier("computerInfo")
      }
      screen.frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay {
          if input {
            Rectangle().strokeBorder(Palette.accent, lineWidth: 2).allowsHitTesting(false)
          }
        }
      controlBar
      footer
    }.background(Palette.surface(scheme))
      .background { DesktopKeyboard(shown: keyboard, typing: typing) { keyboard = false }.frame(width: 0, height: 0).accessibilityHidden(true) }
      .onChange(of: input) { _, input in if !input { keyboard = false; info = nil } }
      .navigationTitle("Computer").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button { helpShown = true } label: { Image(systemName: "questionmark") }
            .accessibilityLabel("How to use the desktop").accessibilityIdentifier("computerHelp")
        }
      }
      .sheet(isPresented: $helpShown) { ComputerHelpSheet(device: device) }
      .sheet(isPresented: $terminalShown) {
        NavigationStack {
          TerminalView().toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { terminalShown = false }.accessibilityIdentifier("terminalClose") } }
        }.appStore(store)
      }
      .task { await watchStatus() }
      .task(id: store.scope) { await attach() }
      // Losing control elsewhere takes input away here at once, before the server fences it.
      .onChange(of: status) { _, status in desktop.statusChanged(status) }
      .onAppear { desktop.returned() }
      .onDisappear {
        // After a takeover still on its way, whatever this viewer holds goes back to the assistants.
        let store = store, desktop = desktop
        Task { await desktop.leave(store) }
        // A reconnect still waiting must not fetch tickets for a screen that is gone.
        epoch += 1
        keyboard = false
      }
  }
  private var toolbar: some View {
    HStack(alignment: .center, spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Circle().fill(phase == .connected ? Palette.accent : Palette.muted).frame(width: 8, height: 8).accessibilityHidden(true)
          Text(ownerLabel).font(.subheadline.weight(.semibold))
        }
        Text(controlHint)
          .font(.caption).foregroundStyle(.secondary)
      }.frame(maxWidth: .infinity, alignment: .leading).accessibilityElement(children: .combine)
        .accessibilityIdentifier("computerStatus")
      Button(desktop.submitting ? "Updating…" : desktop.held ? "Hand back" : "Take over") {
        Task { if desktop.held { await desktop.release(store) } else { await desktop.take(store) } }
      }.buttonStyle(.accentProminent).tint(desktop.held ? Palette.muted : Palette.accent)
        .disabled(desktop.submitting || viewerId == nil || !desktop.held && (phase != .connected || !DesktopLink.canTake(status)))
        .accessibilityIdentifier("computerControl")
    }.padding(12)
  }
  /// The keyboard and clipboard while this person holds the desktop; the ⋯ menu's touch settings always.
  private var controlBar: some View {
    HStack(spacing: 4) {
      if desktop.held {
        Button { keyboard.toggle() } label: { barIcon(keyboard ? "keyboard.chevron.compact.down" : "keyboard") }
          .disabled(!input)
          .accessibilityLabel(keyboard ? "Hide keyboard" : "Type on the desktop")
          .accessibilityHint("Keys go to the field selected on the desktop")
          .accessibilityIdentifier("computerKeyboard")
        Menu {
          Button("Copy to \(device)", systemImage: "doc.on.doc") { Task { await copyToDevice() } }
          Button("Paste from \(device)", systemImage: "doc.on.clipboard") { Task { await pasteFromDevice() } }
        } label: { barIcon("doc.on.clipboard") }
          .disabled(!input)
          .accessibilityLabel("Clipboard").accessibilityIdentifier("computerClipboard")
      }
      Spacer(minLength: 0)
      Menu {
        Toggle(isOn: $trackpad) { Label("Trackpad mode", systemImage: "cursorarrow.motionlines") }
        if trackpad { Button("Recenter pointer", systemImage: "scope") { typing.view(.recenter) } }
        if zoomed { Button("Reset zoom", systemImage: "arrow.down.right.and.arrow.up.left") { typing.view(.resetZoom) } }
      } label: { barIcon("ellipsis") }
        .accessibilityLabel("More").accessibilityIdentifier("computerMore")
    }.padding(.horizontal, 8).padding(.top, 4)
  }
  private func barIcon(_ symbol: String) -> some View {
    Image(systemName: symbol).font(.title3).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
  }
  private func copyToDevice() async {
    guard input else { return }
    guard let text = await typing.copied(), !text.isEmpty else {
      info = "Nothing is copied on the desktop yet. Copy there first, then try again."
      return
    }
    UIPasteboard.general.string = text
    announce("Copied the desktop's clipboard to your \(device).")
  }
  /// Reading the clipboard asks the person first, as iOS does for any app.
  private func pasteFromDevice() async {
    guard input else { return }
    guard let text = UIPasteboard.general.string, !text.isEmpty else {
      info = "Your \(device)'s clipboard has no text."
      return
    }
    if await typing.paste(text) {
      let limit = DesktopTyping.pasteLimit
      announce(text.unicodeScalars.count > limit ? "Pasted the first \(limit) characters." : "Pasted into the desktop.")
    } else {
      info = "Couldn't paste. Select a field on the desktop, then try again."
    }
  }
  private func announce(_ message: String) {
    info = message
    AccessibilityNotification.Announcement(message).post()
  }
  private var controlHint: String {
    if desktop.held { return "Assistants are paused. Tap a field, then the keyboard to type." }
    if status?.control.kind == "human" {
      return status?.control.mine == true ? "Take over to use it here." : "Take over is available after they hand back."
    }
    return "Take over to use the mouse and keyboard."
  }
  private var ownerLabel: String {
    if desktop.held { return "You have control" }
    if status?.control.kind == "human", status?.control.mine == true { return "Watching your desktop session" }
    return status.map(\.detail) ?? "Connecting to the computer"
  }
  private func notice(_ message: String) -> some View {
    Text(message).font(.footnote).foregroundStyle(Palette.attention).frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 12).padding(.bottom, 8).accessibilityIdentifier("computerNotice")
  }
  @ViewBuilder private var screen: some View {
    ZStack {
      Color.black.opacity(scheme == .dark ? 0.4 : 0.06)
      if let api = store.api, let ticket {
        DesktopWebView(base: api.baseURL, path: ticket.path, control: input, trackpad: trackpad, typing: typing, event: received)
          .accessibilityLabel(input ? "Shared desktop. You have control." : "Shared desktop. Watching.")
          .accessibilityIdentifier("computerScreen")
      }
      if phase != .connected {
        VStack(spacing: 10) {
          Image(systemName: "desktopcomputer").font(.title).foregroundStyle(Palette.muted)
          Text(phaseLabel).font(.headline)
          if case .failed(let reason) = phase {
            Text(reason).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button("Reconnect") { Task { await attach(fresh: true) } }.buttonStyle(.bordered).accessibilityIdentifier("computerReconnect")
          } else { ProgressView() }
        }.padding(24).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16)).padding()
          .accessibilityElement(children: .contain).accessibilityIdentifier("computerConnection")
      }
    }
  }
  /// The viewer takes input only while this viewer holds the desktop, no control change is on its
  /// way, and the page is connected; a dropped connection watches until it reconnects.
  private var input: Bool { desktop.input && phase == .connected }
  private var phaseLabel: String {
    switch phase {
    case .opening: "Opening desktop"
    case .reconnecting: "Reconnecting desktop"
    case .failed: "Desktop connection unavailable"
    case .connected: ""
    }
  }
  private var footer: some View {
    VStack(alignment: .leading, spacing: 8) {
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 16) { links }.fixedSize(horizontal: true, vertical: false)
        VStack(alignment: .leading, spacing: 12) { links }
      }.font(.footnote)
      Text("The desktop and browser logins stay on the server when you leave this screen.").font(.caption).foregroundStyle(.secondary)
    }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
  }
  @ViewBuilder private var links: some View {
    if let url = try? store.api?.url("/?computer=1") {
      Link(destination: url) { Label("Open in Safari", systemImage: "safari") }.accessibilityIdentifier("computerSafari")
    }
    Button { terminalShown = true } label: { Label("Terminal", systemImage: "terminal") }.accessibilityIdentifier("computerTerminal")
      .accessibilityHint("Opens the system terminal on the Hermes host")
  }
  /// The desktop's status every few seconds while this screen is open, as the web panel polls.
  private func watchStatus() async {
    while !Task.isCancelled {
      await store.refreshComputer()
      // Timer: the status poll's interval while the desktop is on screen.
      do { try await Task.sleep(for: .seconds(5)) } catch { return }
    }
  }
  /// Gets a ticket for the viewer page, keeping this screen's viewer identity across reconnects.
  private func attach(fresh: Bool = false) async {
    epoch += 1
    let current = epoch
    if fresh { attempt = 0 }
    phase = attempt == 0 ? .opening : .reconnecting
    let body = viewerId.map { ["viewerId": $0] } ?? [:]
    switch await store.attempt(current: { epoch == current }, { context -> DesktopTicket in
      try await context.api.write("/computer/desktop", body)
    }) {
    case .success(let value)?:
      error = nil
      if let id = value.viewerId { viewerId = id }
      if let viewerId { desktop.opened(store, viewerId: viewerId) }
      ticket = value
      await connectDeadline(value, epoch: current)
    case .failure(let failure)?: dropped(failure.localizedDescription, epoch: current)
    case nil: break
    }
  }
  /// A ticket the page has not used before it expires is spent; get another.
  private func connectDeadline(_ value: DesktopTicket, epoch current: Int) async {
    guard let wait = DesktopLink.connectWait(value, now: Date()) else { return }
    // Timer: waits out the ticket's 30-second life before checking it connected.
    try? await Task.sleep(for: wait)
    guard !Task.isCancelled, epoch == current, phase != .connected else { return }
    dropped("The desktop did not connect in time.", epoch: current)
  }
  private func dropped(_ reason: String, epoch current: Int) {
    guard epoch == current else { return }
    guard let delay = DesktopLink.retryDelay(attempt: attempt) else {
      phase = .failed(reason + " Reconnect, or open the computer in Safari.")
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
  private func received(_ event: DesktopWebView.Event) {
    switch event {
    case .connected:
      phase = .connected; attempt = 0; error = nil
      // A takeover from the transcript happens once; a failure leaves the person watching with the reason.
      if take && !tookOver {
        tookOver = true
        if !desktop.held && DesktopLink.canTake(status) { Task { await desktop.take(store) } }
      }
    case .zoom(let zoomed): self.zoomed = zoomed
    case .disconnected(let reason), .failed(let reason):
      guard phase == .connected || phase == .opening || phase == .reconnecting else { return }
      dropped(reason ?? "Desktop disconnected. Reconnecting in watch mode.", epoch: epoch)
    }
  }
}

/// The desktop's control from one screen's side. The screen's viewer, with the signed-in client
/// and account it was opened with, is captured once the desktop attaches. `held` is the server's
/// word: a takeover it confirmed sets it, and a hand back or an available status that says this
/// person no longer holds the desktop clears it. An unavailable status only stops input. Leaving
/// does not trust `held` either: once this screen has asked to take over, it waits for that
/// takeover to settle, whatever its result, then hands the viewer back through that same client,
/// so assistants are never left paused by a screen that is gone. A screen that only watched sends
/// nothing: the person's viewer identity is shared with their other screens, such as Safari, and a
/// release would take control away from the one they are using.
@MainActor @Observable final class DesktopControl {
  struct Viewer: Equatable {
    var id: String
    var client: APIClient
    var account: String?
    static func == (a: Self, b: Self) -> Bool { a.id == b.id && a.client === b.client && a.account == b.account }
  }
  private(set) var held = false
  /// The last status said the desktop is unavailable, so input waits until it is back.
  private(set) var unavailable = false
  private(set) var submitting = false
  private(set) var error: String?
  @ObservationIgnored private(set) var viewer: Viewer?
  @ObservationIgnored private var pendingTake: Task<Result<ComputerStatus, Error>, Never>?
  /// This screen asked to take over and has not handed back since: leaving owes a release.
  @ObservationIgnored private(set) var attempted = false
  @ObservationIgnored private(set) var left = false
  /// Whether the viewer takes the person's input now.
  var input: Bool { held && !unavailable && !submitting }
  /// The desktop attached with this viewer, through the store's current client and account. A
  /// different viewer than before, as after another account signed in, hands the earlier one back
  /// through its own client once its takeover, if any, settles.
  func opened(_ store: AppStore, viewerId: String) {
    guard let client = store.api else { return }
    let next = Viewer(id: viewerId, client: client, account: store.scope)
    guard next != viewer else { return }
    if let earlier = viewer, attempted {
      let pending = pendingTake
      Task { if let pending { _ = await pending.value }; await Self.handBack(store, earlier) }
    }
    held = false
    attempted = false
    viewer = next
  }
  private static func handBack(_ store: AppStore, _ viewer: Viewer) async {
    guard viewer.client.token != nil else { return }
    _ = await store.controlComputer("release", viewerId: viewer.id, through: viewer.client, scope: viewer.account)
  }
  /// Take over. Input stays off until the server confirms it; a takeover is never replayed after a failure.
  func take(_ store: AppStore) async {
    guard !submitting, !left, let viewer else { return }
    submitting = true
    error = nil
    attempted = true
    let task = Task { [weak self] () -> Result<ComputerStatus, Error> in
      let result = await store.controlComputer("take", viewerId: viewer.id, through: viewer.client, scope: viewer.account) {
        self?.left == false
      }
      // Recorded here, before anyone waiting on the takeover resumes, so leaving sees it.
      if case .success(let next) = result, self?.left == false, self?.viewer == viewer { self?.held = DesktopLink.controlling(next) }
      return result
    }
    pendingTake = task
    let result = await task.value
    pendingTake = nil
    submitting = false
    guard !left else { return }
    switch result {
    case .success: AccessibilityNotification.Announcement(held ? "You have control of the desktop." : "You are watching the desktop.").post()
    case .failure(let failure): error = failure.localizedDescription + " You are watching. Try Take over again."
    }
  }
  /// Hand back. Input stops at once; the desktop stays this viewer's until the server confirms.
  func release(_ store: AppStore) async {
    guard !submitting, !left, let viewer else { return }
    submitting = true
    error = nil
    defer { submitting = false }
    let result = await store.controlComputer("release", viewerId: viewer.id, through: viewer.client, scope: viewer.account) {
      [weak self] in self?.left == false
    }
    // A screen that is gone says nothing more.
    guard !left else { return }
    switch result {
    case .success:
      held = false
      attempted = false
      AccessibilityNotification.Announcement("You are watching the desktop.").post()
    case .failure(let failure): error = failure.localizedDescription
    }
  }
  /// The server's status changed. Losing control elsewhere ends it here at once; an unavailable
  /// status, as when Hermes could not be read, only stops input until the desktop is back.
  func statusChanged(_ status: ComputerStatus?) {
    guard let status else { return }
    unavailable = !status.available
    if status.available && held && !DesktopLink.controlling(status) { held = false }
  }
  func returned() { left = false }
  /// The screen is gone: once this screen asked to take over, after that takeover settles, hands
  /// back this viewer through the client it was opened with. Skipped when that client's sign-in is
  /// gone, since another account's client must never send it; sign-out waits for this, briefly,
  /// before it revokes the session.
  func leave(_ store: AppStore) async {
    left = true
    let cleanup = Task { [self] in
      if let pendingTake { _ = await pendingTake.value }
      guard attempted, let viewer else { return }
      await Self.handBack(store, viewer)
      held = false
      attempted = false
    }
    store.desktopCleanup = cleanup
    await cleanup.value
    if store.desktopCleanup == cleanup { store.desktopCleanup = nil }
  }
}

/// The server's native viewer page in a web view with no stored data. The page reports its
/// connection through the `computer` message handler; navigation stays on the app server.
struct DesktopWebView: UIViewRepresentable {
  enum Event: Equatable { case connected, disconnected(String?), failed(String?), zoom(Bool) }
  var base: URL
  var path: String
  var control: Bool
  var trackpad: Bool
  var typing: DesktopTyping
  var event: (Event) -> Void
  func makeCoordinator() -> Coordinator { Coordinator(self) }
  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.userContentController.add(WeakScriptHandler(context.coordinator), name: "computer")
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
    let fragment = DesktopLink.fragment(path: path, control: control, trackpad: trackpad)
    guard fragment != context.coordinator.applied else { return }
    if context.coordinator.loaded {
      // The page follows its fragment: a new path reconnects, a new control mode only switches input.
      view.evaluateJavaScript("location.hash = \(Self.literal(fragment))")
      context.coordinator.applied = fragment
    } else if !context.coordinator.loading {
      context.coordinator.loading = true
      #if DEBUG
        if base.host?.hasSuffix(".native-fixture.invalid") == true {
          view.loadHTMLString(DesktopFixturePage.html, baseURL: base)
          return
        }
      #endif
      guard let url = DesktopLink.pageURL(base: base, path: path, control: control, trackpad: trackpad) else { return }
      context.coordinator.applied = fragment
      view.load(URLRequest(url: url))
    }
    // While the page loads, an update leaves the fragment unapplied: didFinish applies the latest one.
    // Marking it applied here dropped a path or control change that arrived during the load.
  }
  static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
    view.configuration.userContentController.removeScriptMessageHandler(forName: "computer")
    view.stopLoading()
  }
  /// A JavaScript string literal, so the fragment cannot end the statement.
  static func literal(_ value: String) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: [value])) ?? Data("[\"\"]".utf8)
    return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
  }
  final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    var parent: DesktopWebView
    var loaded = false
    var loading = false
    var applied: String?
    init(_ parent: DesktopWebView) { self.parent = parent }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      loaded = true
      loading = false
      // A page loaded without the fragment, as the fixture page is, gets it now.
      let fragment = DesktopLink.fragment(path: parent.path, control: parent.control, trackpad: parent.trackpad)
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
    /// Only the viewer page itself, and its fragment changes, load here; links go nowhere.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
      guard let url = action.request.url else { return .cancel }
      return DesktopLink.allows(url, base: parent.base) ? .allow : .cancel
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
      let origin = message.frameInfo.securityOrigin
      guard message.frameInfo.isMainFrame,
        DesktopLink.trusts(scheme: origin.protocol, host: origin.host, port: origin.port, page: message.webView?.url, base: parent.base),
        let body = message.body as? [String: Any], let type = body["type"] as? String
      else { return }
      let reason = body["reason"] as? String
      switch type {
      case "connected": parent.event(.connected)
      case "disconnected": parent.event(.disconnected(reason))
      case "failed": parent.event(.failed(reason))
      case "zoom": parent.event(.zoom(body["zoomed"] as? Bool == true))
      default: break
      }
    }
  }
}

/// The content controller keeps its handlers alive; this keeps it from keeping the coordinator.
final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
  weak var target: WKScriptMessageHandler?
  init(_ target: WKScriptMessageHandler) { self.target = target }
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.userContentController(controller, didReceive: message)
  }
}

#if DEBUG
  /// UI test stand-in for the server's viewer page: it reports a connection for each ticket, shows
  /// the control mode, and, like the real page, takes typing only with control, showing what came,
  /// so the native controls can be exercised without a desktop.
  enum DesktopFixturePage {
    static let html = """
      <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body{margin:0;font:600 17px -apple-system;display:grid;place-content:center;text-align:center;height:100vh;background:#1d3b2a;color:#fff}</style>
      <p id="mode">Fixture desktop</p><p id="typed"></p>
      <script>
      let control=false,typed='';
      function apply(){const p=new URLSearchParams(location.hash.slice(1));if(!p.get('path'))return;control=p.get('control')==='1';
      document.getElementById('mode').textContent=(control?'Fixture desktop · You have control':'Fixture desktop · Watching')+(p.get('trackpad')==='1'?' · Trackpad':'');
      window.webkit.messageHandlers.computer.postMessage({type:'connected'})}
      window.desktopInput=i=>{if(!control)return false;const k=i.key?'['+i.key+']':String(i.text).replace(/\\n/g,'[enter]');
      typed+=i.control?'[ctrl+'+k+']':k;document.getElementById('typed').textContent='Typed: '+typed;return true};
      window.desktopPaste=t=>typeof t==='string'&&!!t&&window.desktopInput({text:t});
      window.desktopCopied=()=>control?'Fixture clipboard':null;
      window.desktopView=c=>c==='recenter'||c==='resetZoom';
      addEventListener('hashchange',apply);apply()
      </script>
      """
  }
#endif

/// An assistant asking a person to take over the household computer. Its reason and the step it
/// asks for are the assistant's own words. Hermes settles it when the person hands back.
struct ComputerHandoff: Codable, Equatable {
  var epoch: String
  var sessionId: String
  var reason: String
  var whatToDo: String
  /// Tools that act on the household computer, as the Hermes add-on brackets them.
  static func usesComputer(_ tool: String?) -> Bool {
    guard let tool else { return false }
    return tool == "computer_use" || tool.hasPrefix("browser_")
  }
}
struct ComputerHandoffResult: Decodable { var status: String }
/// The computer screen opened from the transcript: Watch, or Take over from a handoff request.
struct ComputerOpening: Identifiable, Equatable {
  let id = UUID()
  var take: Bool
}

/// The card for a handoff request. Take over opens the computer and takes control; Not now declines.
struct ComputerHandoffView: View {
  var request: Attention
  var handoff: ComputerHandoff
  var botId: String
  @Environment(AppStore.self) private var store
  @State private var declining = false
  @State private var error: String?
  private var name: String { store.bootstrap?.bots.first { $0.id == botId }?.name ?? "The assistant" }
  private var control: ComputerStatus.Control? { store.computerStatus?.control }
  private var mine: Bool { control?.kind == "human" && control?.mine == true }
  private var elsewhere: Bool { control?.kind == "human" && control?.mine != true }
  private var unavailable: Bool { store.computerStatus.map { !$0.available || $0.running == false } ?? false }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("\(name) needs you on the computer").font(.subheadline.bold())
      ForEach([("Why", handoff.reason), ("What to do", handoff.whatToDo)], id: \.0) { label, value in
        VStack(alignment: .leading, spacing: 2) {
          Text(label).font(.caption).foregroundStyle(.secondary)
          Text(value).font(.subheadline).textSelection(.enabled)
        }.accessibilityElement(children: .combine)
      }
      Text("In \(name)'s words. \(name) pauses its computer actions while you have control.")
        .font(.caption).foregroundStyle(.secondary)
      if let state { Text(state).font(.footnote).accessibilityIdentifier("handoff.state") }
      HStack {
        Button(mine ? "Open computer" : "Take over", systemImage: "desktopcomputer") { store.openComputer = ComputerOpening(take: !mine) }
          .buttonStyle(.accentProminent).controlSize(.large)
          .disabled(!store.connected || declining || elsewhere || unavailable).accessibilityIdentifier("handoff.take")
        if !mine {
          Button { decline() } label: { Text(declining ? "Sending…" : "Not now").frame(minHeight: 44).padding(.horizontal, 8).contentShape(Rectangle()) }
            .disabled(!store.connected || declining).accessibilityIdentifier("handoff.decline")
        }
      }
      Text("Or send a message instead. That cancels this request so \(name) can read it.")
        .font(.caption).foregroundStyle(.secondary)
      if let error { Text(error).font(.footnote).foregroundStyle(Palette.attention).accessibilityIdentifier("handoff.error") }
    }.task { while !Task.isCancelled { await store.refreshComputer(); try? await Task.sleep(for: .seconds(4)) } }
      .accessibilityElement(children: .contain).accessibilityIdentifier("handoff")
  }
  private var state: String? {
    if mine { return "You have control. Press Hand back on the Computer screen when you're done, and \(name) will continue." }
    if elsewhere { return "\(control?.name ?? "Another household member") has control right now. Take over is available after they hand back." }
    if unavailable { return store.computerStatus?.reason ?? "The household computer isn't running right now." }
    return nil
  }
  private func decline() {
    guard let api = store.api, !declining else { return }
    declining = true; error = nil
    let id = request.id
    Task {
      defer { declining = false }
      do {
        let path = "/bots/\(botId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? botId)/computer-handoffs/\(id)"
        let result: ComputerHandoffResult = try await api.write(path, ["decision": "decline", "epoch": handoff.epoch, "sessionId": handoff.sessionId])
        if result.status == "expired" { error = "This request had already closed. Refresh the conversation to see what happened."; return }
        SettledRequests.shared.remember(botId: botId, requestId: id, text: "You chose Not now. \(name) will continue without it.")
        await store.refreshConversation()
      } catch { self.error = "Couldn't reach Hermes. Try Not now again." }
    }
  }
}

/// How to use the shared desktop by touch, as the web's help shows it. `src/shared/computer-help.json`
/// is the source; ShellFeatureTests checks these match it. `{device}` is this device's name.
enum ComputerHelp {
  struct Item: Equatable { var title: String; var symbol: String; var detail: String }
  struct Section: Equatable { var title: String; var items: [Item] }
  static let title = "Using the computer"
  static let sections: [Section] = [
    Section(title: "Taking control", items: [
      Item(title: "Take over", symbol: "hand.raised", detail: "Tap Take over to use the desktop. Assistants pause until you tap Hand back."),
    ]),
    Section(title: "Touching the screen", items: [
      Item(title: "Scroll", symbol: "arrow.up.and.down", detail: "Drag with two fingers."),
      Item(title: "Click and drag", symbol: "hand.tap", detail: "Tap to click where you tapped. One finger drags."),
      Item(title: "Right-click", symbol: "list.bullet", detail: "Tap with two fingers, or press and hold."),
      Item(title: "Zoom in", symbol: "plus.magnifyingglass", detail: "Pinch to zoom. Zoomed in, two fingers pan instead of scrolling. Reset zoom is in the ⋯ menu."),
    ]),
    Section(title: "Typing and the clipboard", items: [
      Item(title: "Type", symbol: "keyboard", detail: "Tap the keyboard button in the bottom bar."),
      Item(title: "Copy and paste", symbol: "doc.on.clipboard", detail: "Tap the clipboard button in the bottom bar for Copy to {device} and Paste from {device}. Copy on the desktop first."),
    ]),
    Section(title: "When a pointer is easier", items: [
      Item(title: "Trackpad mode", symbol: "cursorarrow.motionlines", detail: "Turn on from the ⋯ menu. Your finger moves the pointer; tap to click there, double-tap and hold to drag. Recenter pointer if it drifts."),
    ]),
  ]
  static func sections(device: String) -> [Section] {
    sections.map { section in
      Section(title: section.title, items: section.items.map {
        Item(title: $0.title, symbol: $0.symbol, detail: $0.detail.replacingOccurrences(of: "{device}", with: device))
      })
    }
  }
}

/// The ? sheet on the Computer screen.
struct ComputerHelpSheet: View {
  var device: String
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      List {
        ForEach(ComputerHelp.sections(device: device), id: \.title) { section in
          Section(section.title) {
            ForEach(section.items, id: \.title) { item in
              Label {
                VStack(alignment: .leading, spacing: 4) {
                  Text(item.title)
                  Text(item.detail).font(.subheadline).foregroundStyle(.secondary)
                }
              } icon: {
                Image(systemName: item.symbol).foregroundStyle(.secondary)
              }.padding(.vertical, 4).accessibilityElement(children: .combine)
            }
          }
        }
      }
      .navigationTitle(ComputerHelp.title).navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button { dismiss() } label: { Image(systemName: "xmark") }
            .accessibilityLabel("Close").accessibilityIdentifier("computerHelpClose")
        }
      }
    }.accessibilityIdentifier("computerHelpSheet")
  }
}
