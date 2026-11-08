import XCTest

@testable import WildBotsMacCore

final class HouseholdTests: XCTestCase {
  func testServerAddressNormalization() {
    let cases: [(String, String?)] = [
      ("agentui.wildflowersranch.com", "https://agentui.wildflowersranch.com"),
      ("  https://agentui.example/  ", "https://agentui.example"),
      ("https://agentui.example:8443", "https://agentui.example:8443"),
      ("http://localhost:3000", "http://localhost:3000"),
      ("http://127.0.0.1:3000", "http://127.0.0.1:3000"),
      ("http://agentui.example", nil),
      ("https://agentui.example/app", nil),
      ("https://user:pw@agentui.example", nil),
      ("https://agentui.example?x=1", nil),
      ("ftp://agentui.example", nil),
      ("", nil),
    ]
    for (input, expected) in cases {
      XCTAssertEqual(ServerAddress.normalize(input)?.absoluteString, expected, input)
    }
  }

  func testLinkEndpointUsesTheWebSocketSchemeAndPath() {
    XCTAssertEqual(LinkEndpoint.url(server: "https://agentui.example")?.absoluteString, "wss://agentui.example/api/mac/link")
    XCTAssertEqual(LinkEndpoint.url(server: "http://localhost:3000")?.absoluteString, "ws://localhost:3000/api/mac/link")
  }

  func testSignInCallbackMustMatchThisRequest() throws {
    let pkce = try PKCE()
    let good = URL(string: "agentinterface://auth/callback?code=abc&state=\(pkce.state)")!
    XCTAssertEqual(try pkce.code(from: good), "abc")
    let bad = [
      "other://auth/callback?code=abc&state=\(pkce.state)",
      "agentinterface://evil/callback?code=abc&state=\(pkce.state)",
      "agentinterface://auth/elsewhere?code=abc&state=\(pkce.state)",
      "agentinterface://auth/callback?code=abc&state=wrong",
      "agentinterface://auth/callback?code=&state=\(pkce.state)",
      "agentinterface://auth/callback?state=\(pkce.state)",
    ]
    for text in bad {
      XCTAssertThrowsError(try pkce.code(from: URL(string: text)!), text) { error in
        XCTAssertEqual((error as? HouseholdError)?.status, 401, text)
      }
    }
    let url = pkce.signInURL(server: URL(string: "https://agentui.example")!)
    let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    XCTAssertEqual(url.path, "/native/sign-in")
    XCTAssertEqual(items.first { $0.name == "code_challenge_method" }?.value, "S256")
    XCTAssertEqual(items.first { $0.name == "code_challenge" }?.value, pkce.challenge)
    XCTAssertNotEqual(pkce.challenge, pkce.verifier)
  }

  func testEnrollmentNameLimits() {
    XCTAssertNotNil(EnrollmentRequest(name: "  ", model: nil, osVersion: nil, appVersion: nil).validationError)
    XCTAssertNotNil(EnrollmentRequest(name: String(repeating: "m", count: 65), model: nil, osVersion: nil, appVersion: nil).validationError)
    XCTAssertNil(EnrollmentRequest(name: String(repeating: "m", count: 64), model: nil, osVersion: nil, appVersion: nil).validationError)
    let clamped = EnrollmentRequest(name: " Mac ", model: String(repeating: "x", count: 80), osVersion: "27", appVersion: nil).clamped
    XCTAssertEqual(clamped.name, "Mac")
    XCTAssertEqual(clamped.model?.count, 64)
  }
}

final class EmbeddedPolicyTests: XCTestCase {
  /// The Swift constants are generated from the vendored files; this fails when they drift.
  func testEmbeddedPoliciesMatchTheVendoredFiles() throws {
    let sandbox = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("Sandbox")
    let pairs = [
      ("seatbelt_base_policy.sbpl", EmbeddedPolicies.base),
      ("seatbelt_read_only_platform_defaults.sbpl", EmbeddedPolicies.platformDefaults),
      ("seatbelt_network_policy.sbpl", EmbeddedPolicies.network),
    ]
    for (file, embedded) in pairs {
      let text = try String(contentsOf: sandbox.appendingPathComponent(file), encoding: .utf8)
      XCTAssertEqual(text.trimmingCharacters(in: .newlines), embedded.trimmingCharacters(in: .newlines),
        "\(file) changed; run mac/tools/embed-policies.sh")
    }
  }

  func testTheGeneratedPolicyNeverIncludesThePreferencesPolicy() {
    let policy = SandboxPolicy.build(SandboxConfig(home: "/Users/t", grantedFolders: ["/Users/t/dev"], tempDir: "/private/tmp/x", appDataDir: "/Users/t/a"))
    // cfprefsd can hand out other apps' preferences, so it stays out while reads are restricted.
    XCTAssertFalse(policy.contains("com.apple.cfprefsd"))
    XCTAssertFalse(policy.contains("(allow network-outbound)\n"), "unrestricted outbound would open Unix sockets")
  }

  func testPathsAreEscapedForLiteralsAndRegexes() {
    XCTAssertEqual(SandboxPolicy.quote(#"/a "b" \c"#), #""/a \"b\" \\c""#)
    XCTAssertEqual(SandboxPolicy.regexEscape("/a.b(c)+[d]"), #"/a\.b\(c\)\+\[d\]"#)
    XCTAssertEqual(SandboxPolicy.caseInsensitive(".ssh"), #"\.[sS][sS][hH]"#)
  }
}
