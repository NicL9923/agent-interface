import AuthenticationServices
import JavaScriptCore
import XCTest

@testable import AgentInterface

/// The system terminal in the app: the link and trust rules, which screen the status calls for, the
/// bridge script, the confirmation call and the assistant's terminal request.
@MainActor final class TerminalTests: XCTestCase {
  private let base = URL(string: "https://agentui.example.test")!
  private let ticket = String(repeating: "Ab-_0", count: 8) + "xyz"  // 43 characters
  private var path: String { "/api/computer/terminal/ws?ticket=\(ticket)" }
  private func status(_ terminal: String?) throws -> ComputerStatus {
    let extra = terminal.map { #","terminal":\#($0)"# } ?? ""
    return try JSONDecoder().decode(ComputerStatus.self, from: Data(#"{"available":true,"control":{"kind":"idle"}\#(extra)}"#.utf8))
  }

  // MARK: Link and trust rules

  func testOnlyATerminalSocketWithAWellFormedTicketReachesThePage() {
    XCTAssertEqual(ticket.count, 43)
    XCTAssertTrue(TerminalLink.validPath(path))
    for bad in [
      "", "/api/computer/desktop/ws?ticket=\(ticket)", "/api/computer/terminal/ws", "/api/computer/terminal/ws?ticket=",
      "/api/computer/terminal/ws?ticket=\(ticket.dropLast())", "/api/computer/terminal/ws?ticket=\(ticket)x",
      "/api/computer/terminal/ws?ticket=\(ticket.dropLast())%", "/api/computer/terminal/ws?ticket=\(ticket.dropLast())+",
      "/api/computer/terminal/ws?ticket=\(ticket.dropLast())é", "https://evil.example.test/api/computer/terminal/ws?ticket=\(ticket)",
      " /api/computer/terminal/ws?ticket=\(ticket)", "/api/computer/terminal/ws?ticket=\(ticket)&x=1",
    ] { XCTAssertFalse(TerminalLink.validPath(bad), bad) }
    XCTAssertNil(TerminalLink.pageURL(base: base, path: "/api/computer/terminal/ws?ticket=short"), "A bad ticket never becomes a page address")
  }
  func testThePageAddressKeepsTheTicketInTheFragment() throws {
    let url = try XCTUnwrap(TerminalLink.pageURL(base: base, path: path))
    XCTAssertEqual(url.path, "/native/terminal"); XCTAssertNil(url.query)
    XCTAssertEqual(url.fragment, "path=%2Fapi%2Fcomputer%2Fterminal%2Fws%3Fticket%3D\(ticket)")
    XCTAssertFalse(url.absoluteString.contains("?"), "Nothing the server logs carries the ticket")
  }
  func testOnlyTheTerminalPageLoadsAndSpeaks() {
    XCTAssertTrue(TerminalLink.allows(URL(string: "https://agentui.example.test/native/terminal#path=x")!, base: base))
    XCTAssertFalse(TerminalLink.allows(URL(string: "https://agentui.example.test/native/computer")!, base: base), "The desktop page is not the terminal")
    XCTAssertFalse(TerminalLink.allows(URL(string: "https://agentui.example.test/")!, base: base))
    XCTAssertFalse(TerminalLink.allows(URL(string: "https://evil.example.test/native/terminal")!, base: base))
    XCTAssertFalse(TerminalLink.allows(URL(string: "http://agentui.example.test/native/terminal")!, base: base))
    XCTAssertTrue(TerminalLink.allows(URL(string: "about:blank")!, base: base))
    XCTAssertFalse(TerminalLink.allows(URL(string: "about:srcdoc")!, base: base))
    let page = URL(string: "https://agentui.example.test/native/terminal")
    XCTAssertTrue(TerminalLink.trusts(scheme: "https", host: "agentui.example.test", port: 0, page: page, base: base))
    XCTAssertFalse(TerminalLink.trusts(scheme: "https", host: "evil.example.test", port: 0, page: page, base: base))
    XCTAssertFalse(TerminalLink.trusts(scheme: "http", host: "agentui.example.test", port: 0, page: page, base: base))
    XCTAssertFalse(TerminalLink.trusts(scheme: "https", host: "agentui.example.test", port: 8443, page: page, base: base))
    XCTAssertFalse(TerminalLink.trusts(scheme: "https", host: "agentui.example.test", port: 0, page: nil, base: base))
    XCTAssertFalse(TerminalLink.trusts(scheme: "https", host: "agentui.example.test", port: 0, page: URL(string: "https://agentui.example.test/native/computer"), base: base),
      "A message from the desktop page is not the terminal's")
    XCTAssertFalse(TerminalLink.trusts(scheme: "https", host: "agentui.example.test", port: 0, page: URL(string: "about:blank"), base: base))
  }
  func testPageMessagesBecomeEventsAndMalformedOnesAreNothing() {
    typealias Coordinator = TerminalWebView.Coordinator
    XCTAssertEqual(Coordinator.event(type: "connected", body: [:]), .connected)
    XCTAssertEqual(Coordinator.event(type: "disconnected", body: ["reason": "lost"]), .disconnected("lost"))
    XCTAssertEqual(Coordinator.event(type: "failed", body: ["reason": "invalid_ticket"]), .failed("invalid_ticket"))
    XCTAssertEqual(Coordinator.event(type: "ended", body: [:]), .ended)
    XCTAssertEqual(Coordinator.event(type: "focus", body: [:]), .focus)
    XCTAssertEqual(Coordinator.event(type: "error", body: ["message": "Hermes is being maintained."]), .error("Hermes is being maintained."))
    XCTAssertNil(Coordinator.event(type: "error", body: ["message": 7]), "An error without text has nothing to show")
    XCTAssertNil(Coordinator.event(type: "zoom", body: [:]), "The desktop's messages mean nothing here")
  }

  // MARK: Which screen

  func testTheStatusDecidesWhetherToWaitRefuseConfirmOrOpen() throws {
    func step(_ terminal: String?, reauthenticate: Bool = false, confirmedHere: Bool = false) throws -> TerminalLink.Step {
      TerminalLink.step(try status(terminal), reauthenticate: reauthenticate, confirmedHere: confirmedHere)
    }
    XCTAssertEqual(try step(nil), .unavailable(TerminalLink.unavailableReason), "A server without the terminal field")
    XCTAssertEqual(TerminalLink.step(nil, reauthenticate: false, confirmedHere: false), .checking)
    XCTAssertEqual(try step(#"{"available":false,"target":"","reason":"The system terminal is limited to household administrators."}"#),
      .unavailable("The system terminal is limited to household administrators."))
    XCTAssertEqual(try step(#"{"available":false,"target":""}"#), .unavailable(TerminalLink.unavailableReason))
    XCTAssertEqual(try step(#"{"available":false,"target":"","reason":""}"#), .unavailable(TerminalLink.unavailableReason))
    XCTAssertEqual(try step(#"{"available":true,"target":"a@b","confirmationRequired":true}"#), .confirm)
    XCTAssertEqual(try step(#"{"available":true,"target":"a@b","confirmationRequired":true}"#, confirmedHere: true), .shell,
      "A status read from before the confirmation cannot undo it")
    XCTAssertEqual(try step(#"{"available":true,"target":"a@b"}"#), .shell)
    XCTAssertEqual(try step(#"{"available":true,"target":"a@b"}"#, reauthenticate: true, confirmedHere: true), .confirm,
      "The server's own 401 wins over what this screen remembers")
    XCTAssertEqual(try step(#"{"available":false,"target":"","reason":"Off"}"#, reauthenticate: true), .unavailable("Off"))
  }
  func testTerminalStatusDecodesWithEveryFieldOptional() throws {
    let terminal = try XCTUnwrap(try status(#"{"available":true}"#).terminal)
    XCTAssertEqual(terminal, ComputerStatus.Terminal(available: true))
    XCTAssertNil(try status(nil).terminal, "Older servers send none")
    XCTAssertEqual(try status(#"{"available":true,"target":"x@y","confirmationRequired":true}"#).terminal,
      ComputerStatus.Terminal(available: true, target: "x@y", confirmationRequired: true))
  }
  func testOnlyAReauthenticationRefusalSendsThePersonToConfirm() {
    func failure(_ status: Int, _ code: String?) -> APIError { APIError(message: "m", status: status, code: code) }
    XCTAssertTrue(TerminalLink.needsConfirmation(failure(401, "reauthentication_required")))
    XCTAssertFalse(TerminalLink.needsConfirmation(failure(401, "session_expired")), "A lost sign-in is not a lapsed confirmation")
    XCTAssertFalse(TerminalLink.needsConfirmation(failure(403, "reauthentication_required")))
    XCTAssertFalse(TerminalLink.needsConfirmation(URLError(.notConnectedToInternet)))
    XCTAssertTrue(TerminalLink.retryable(URLError(.notConnectedToInternet)))
    XCTAssertTrue(TerminalLink.retryable(failure(503, nil))); XCTAssertTrue(TerminalLink.retryable(failure(429, nil)))
    XCTAssertFalse(TerminalLink.retryable(failure(409, nil)), "A terminal that is not installed stays so on a retry")
    XCTAssertFalse(TerminalLink.retryable(failure(403, nil)))
  }

  // MARK: The shared keyboard

  func testTheTerminalBridgeGetsTheSameKeysAsData() throws {
    let context = try XCTUnwrap(JSContext())
    context.evaluateScript("var window = {}, got = []; window.terminalInput = i => { got.push(i); return true }; window.desktopInput = () => { throw 'wrong bridge' }")
    let text = "a\"); window.terminalInput = null; ('\n</script>\u{2028}🤠"
    for (input, control) in [(DesktopTyping.Input.text(text), false), (.key(.escape), true), (.text("c"), true)] {
      XCTAssertTrue(context.evaluateScript(DesktopTyping.script(input, control: control, bridge: .terminal)).toBool())
    }
    context.setObject(text, forKeyedSubscript: "expected" as NSString)
    XCTAssertTrue(context.evaluateScript("""
      got.length === 3 && got[0].text === expected && !("control" in got[0]) && got[1].key === "escape" && got[1].control === true
        && got[2].text === "c" && got[2].control === true
      """).toBool(), context.evaluateScript("JSON.stringify(got)").toString())
    XCTAssertNil(context.exception)
    // A page that has not loaded its bridge takes nothing and throws nothing.
    context.evaluateScript("window = {}")
    XCTAssertFalse(context.evaluateScript(DesktopTyping.script(.text("x"), control: false, bridge: .terminal)).toBool())
    XCTAssertNil(context.exception)
  }
  func testAShellGetsReturnAsTheEnterKeyButTheDesktopKeepsItsText() throws {
    let context = try XCTUnwrap(JSContext())
    context.evaluateScript("var window = {}, got = []; window.terminalInput = i => { got.push(i); return true }; window.desktopInput = i => { got.push(i); return true }")
    for newline in ["\n", "\r"] { context.evaluateScript(DesktopTyping.script(.text(newline), control: false, bridge: .terminal)) }
    context.evaluateScript(DesktopTyping.script(.text("ls\n"), control: false, bridge: .terminal))
    context.evaluateScript(DesktopTyping.script(.text("\n"), control: false, bridge: .desktop))
    XCTAssertEqual(context.evaluateScript("JSON.stringify(got)").toString(),
      #"[{"key":"enter"},{"key":"enter"},{"text":"ls\n"},{"text":"\n"}]"#)
  }
  func testBothBridgesNameTheirOwnFunctions() {
    XCTAssertEqual(DesktopTyping.Bridge.desktop.inputFunction, "desktopInput"); XCTAssertEqual(DesktopTyping.Bridge.desktop.pasteFunction, "desktopPaste")
    XCTAssertEqual(DesktopTyping.Bridge.terminal.inputFunction, "terminalInput"); XCTAssertEqual(DesktopTyping.Bridge.terminal.pasteFunction, "terminalPaste")
    XCTAssertTrue(DesktopTyping.script(.key(.tab), control: false).hasPrefix("window.desktopInput"), "The desktop stays the default")
    // Every key the accessory row can send is one the terminal page's table knows.
    XCTAssertEqual(DesktopTyping.Key.allCases.map(\.rawValue),
      ["enter", "tab", "backspace", "escape", "delete", "left", "up", "right", "down", "home", "end", "pageUp", "pageDown"])
  }

  // MARK: Confirming it's you

  func testConfirmingSendsTheCodeWithItsProofUnderThisDevicesToken() async throws {
    let server = FakeServer()
    server.reply = .init(status: 200, body: #"{"confirmedAt":"2026-11-07T12:00:00.000Z"}"#)
    let store = AppStore(); let api = server.api(token: "device-token"); store.api = api
    let pkce = try PKCE()
    try await store.redeemConfirmation(code: "one-time-code", pkce: pkce, through: api)
    let request = try XCTUnwrap(server.lastRequest)
    XCTAssertEqual(request.url?.path, "/api/auth/native/confirm"); XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-token")
    XCTAssertEqual(try server.lastJSON() as? [String: String], ["code": "one-time-code", "state": pkce.state, "codeVerifier": pkce.verifier])
  }
  func testAConfirmationTheServerRefusesSaysWhy() async throws {
    let server = FakeServer()
    for (status, body, message) in [
      (403, #"{"error":"Use the same Google account you signed in with."}"#, "Use the same Google account you signed in with."),
      (401, #"{"error":"That confirmation is too old. Try again."}"#, "That confirmation is too old. Try again."),
    ] {
      server.reply = .init(status: status, body: body)
      let store = AppStore(); let api = server.api(); store.api = api
      do { try await store.redeemConfirmation(code: "c", pkce: try PKCE(), through: api); XCTFail("The refusal reaches the screen") }
      catch { XCTAssertEqual(TerminalView.confirmMessage(error), message) }
    }
    XCTAssertNil(TerminalView.confirmMessage(ASWebAuthenticationSessionError(.canceledLogin)), "Closing the browser is not an error to show")
  }
  // MARK: The assistant's request

  private func waiting(_ attention: String) throws -> Conversation {
    let json = #"{"botId":"kitchen","messages":[],"activity":{"state":"blocked"},"approvals":[],"files":[],"attention":[\#(attention)]}"#
    return try JSONDecoder().decode(Conversation.self, from: Data(json.utf8))
  }
  func testTerminalRequestDecodesAndAMessageStillClosesIt() throws {
    let json = #"{"id":"t1","kind":"terminal","title":"Use the terminal?","detail":"Sign in.","terminal":{"epoch":"e","sessionId":"s","reason":"Sign in.","whatToDo":"Run it.","command":"sudo tailscale up"}}"#
    let conversation = try waiting(json)
    let request = try XCTUnwrap(conversation.attention?.first)
    XCTAssertEqual(request.kind, "terminal")
    XCTAssertEqual(request.terminal, TerminalRequest(epoch: "e", sessionId: "s", reason: "Sign in.", whatToDo: "Run it.", command: "sudo tailscale up"))
    XCTAssertNil(request.computer); XCTAssertNil(request.connection)
    XCTAssertTrue(WaitingInput.closes(request, userId: "one"))
    XCTAssertEqual(WaitingInput.placeholder(conversation, userId: "one"), "Or reply here instead…")
    let bare = try waiting(#"{"id":"t2","kind":"terminal","title":"t","detail":"d","terminal":{"epoch":"e","sessionId":"s","reason":"r","whatToDo":"w"}}"#)
    XCTAssertNil(bare.attention?.first?.terminal?.command, "The command is optional")
  }
  func testOnlyOneVisibleLineIsEverPastedAtThePrompt() {
    XCTAssertEqual(TerminalRequest.pasteable("sudo tailscale up --ssh"), "sudo tailscale up --ssh")
    XCTAssertEqual(TerminalRequest.pasteable("echo 'héllo 🤠'"), "echo 'héllo 🤠'")
    for refused in [
      nil, "", "   ", "ls\nrm -rf ~", "ls\r", "ls\u{1B}[2J", "ls\u{7}", "ls\ttab", "ls\u{200B}", "ls\u{202E}gnp.exe", "ls\u{2028}x", "ls\u{2029}x", "ls\u{0}", "ls\u{7F}",
    ] { XCTAssertNil(TerminalRequest.pasteable(refused), String(describing: refused)) }
  }
  func testDecisionCarriesTheRequestsEpochAndSession() throws {
    let request = TerminalRequest(epoch: "e", sessionId: "s", reason: "r", whatToDo: "w")
    for decision in [TerminalDecision.done, TerminalDecision.decline] {
      let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(TerminalDecision(decision, for: request))) as? [String: String])
      XCTAssertEqual(body, ["decision": decision, "epoch": "e", "sessionId": "s"])
    }
    XCTAssertEqual(TerminalDecision.done, "done"); XCTAssertEqual(TerminalDecision.decline, "decline")
    XCTAssertEqual(try JSONDecoder().decode(TerminalRequestResult.self, from: Data(#"{"status":"expired"}"#.utf8)).status, "expired")
  }
  func testATicketDecodesWithItsShellSessionAndWaitsOutItsLife() throws {
    let ended = try JSONDecoder().decode(TerminalTicket.self, from: Data(#"{"path":"/p","expiresAt":"2026-11-07T12:00:30.000Z","sessionId":"abc","target":"u@h"}"#.utf8))
    XCTAssertEqual(ended.sessionId, "abc"); XCTAssertEqual(ended.target, "u@h")
    XCTAssertNil(try JSONDecoder().decode(TerminalTicket.self, from: Data(#"{"path":"/p","expiresAt":"x"}"#.utf8)).sessionId)
    let now = try XCTUnwrap(ServerDate.parse("2026-11-07T12:00:00Z"))
    XCTAssertEqual(DesktopLink.connectWait(expiresAt: "2026-11-07T12:00:30Z", now: now), .seconds(30))
    XCTAssertNil(DesktopLink.connectWait(expiresAt: "soon", now: Date()))
  }
}
