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
  /// The server's native viewer page with the ticket and control mode in its fragment, which never
  /// reaches the server or its logs. The page reconnects when the path changes and only switches
  /// input on or off when `control` changes.
  static func pageURL(base: URL, path: String, control: Bool) -> URL? {
    var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
    components?.path = "/native/computer"
    components?.query = nil
    components?.percentEncodedFragment = fragment(path: path, control: control)
    return components?.url
  }
  static func fragment(path: String, control: Bool) -> String {
    "path=\(encode(path))&control=\(control ? 1 : 0)"
  }
  /// encodeURIComponent's escaping, which the page reverses.
  private static func encode(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.!~*'()")) ?? ""
  }
  /// How long a page may take to connect with a ticket: until the ticket expires, and at least a
  /// second. A page that has not connected by then needs a fresh ticket. Nil for an unreadable expiry.
  static func connectWait(_ ticket: DesktopTicket, now: Date) -> Duration? {
    guard let expires = ServerDate.parse(ticket.expiresAt) else { return nil }
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
/// The viewer watches until Take over; Hand back returns the desktop to the assistants. The VPS
/// terminal stays in the browser.
struct ComputerView: View {
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
  private var status: ComputerStatus? { store.computerStatus }
  var body: some View {
    VStack(spacing: 0) {
      toolbar
      if let message = error ?? desktop.error ?? status?.reason { notice(message) }
      screen.frame(maxWidth: .infinity, maxHeight: .infinity)
      footer
    }.background(Palette.surface(scheme))
      .navigationTitle("Computer").navigationBarTitleDisplayMode(.inline)
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
      }
  }
  private var toolbar: some View {
    HStack(alignment: .center, spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Circle().fill(phase == .connected ? Palette.accent : Palette.muted).frame(width: 8, height: 8).accessibilityHidden(true)
          Text(ownerLabel).font(.subheadline.weight(.semibold))
        }
        Text(desktop.held ? "Assistants are paused while you use the desktop." : "Take over to use the mouse and keyboard.")
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
  private var ownerLabel: String {
    if desktop.held { return "You have control" }
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
        DesktopWebView(base: api.baseURL, path: ticket.path, control: input, event: received)
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
      if let url = try? store.api?.url("/?computer=1") {
        HStack(spacing: 16) {
          Link(destination: url) { Label("Open in Safari", systemImage: "safari") }.accessibilityIdentifier("computerSafari")
          Link(destination: url) { Label("Terminal", systemImage: "terminal") }.accessibilityIdentifier("computerTerminal")
            .accessibilityHint("Opens the VPS terminal in Safari, with its own sign-in")
        }.font(.footnote)
      }
      Text("The desktop and browser logins stay on the server when you leave this screen.").font(.caption).foregroundStyle(.secondary)
    }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
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
  enum Event: Equatable { case connected, disconnected(String?), failed(String?) }
  var base: URL
  var path: String
  var control: Bool
  var event: (Event) -> Void
  func makeCoordinator() -> Coordinator { Coordinator(self) }
  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.userContentController.add(WeakHandler(context.coordinator), name: "computer")
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = context.coordinator
    view.isOpaque = false
    view.backgroundColor = .clear
    view.scrollView.isScrollEnabled = false
    view.scrollView.contentInsetAdjustmentBehavior = .never
    return view
  }
  func updateUIView(_ view: WKWebView, context: Context) {
    context.coordinator.parent = self
    let fragment = DesktopLink.fragment(path: path, control: control)
    guard fragment != context.coordinator.applied else { return }
    if context.coordinator.loaded {
      // The page follows its fragment: a new path reconnects, a new control mode only switches input.
      view.evaluateJavaScript("location.hash = \(Self.literal(fragment))")
    } else if !context.coordinator.loading {
      context.coordinator.loading = true
      #if DEBUG
        if base.host?.hasSuffix(".native-fixture.invalid") == true {
          view.loadHTMLString(DesktopFixturePage.html, baseURL: base)
          return
        }
      #endif
      guard let url = DesktopLink.pageURL(base: base, path: path, control: control) else { return }
      context.coordinator.applied = fragment
      view.load(URLRequest(url: url))
      return
    }
    context.coordinator.applied = fragment
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
      let fragment = DesktopLink.fragment(path: parent.path, control: parent.control)
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
      default: break
      }
    }
  }
  /// The content controller keeps its handlers alive; this keeps it from keeping the coordinator.
  private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
      target?.userContentController(controller, didReceive: message)
    }
  }
}

#if DEBUG
  /// UI test stand-in for the server's viewer page: it reports a connection for each ticket and
  /// shows the control mode, so the native controls can be exercised without a desktop.
  enum DesktopFixturePage {
    static let html = """
      <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body{margin:0;font:600 17px -apple-system;display:grid;place-items:center;height:100vh;background:#1d3b2a;color:#fff}</style>
      <p id="mode">Fixture desktop</p>
      <script>
      function apply(){const p=new URLSearchParams(location.hash.slice(1));if(!p.get('path'))return;
      document.getElementById('mode').textContent=p.get('control')==='1'?'Fixture desktop · You have control':'Fixture desktop · Watching';
      window.webkit.messageHandlers.computer.postMessage({type:'connected'})}
      addEventListener('hashchange',apply);apply()
      </script>
      """
  }
#endif
