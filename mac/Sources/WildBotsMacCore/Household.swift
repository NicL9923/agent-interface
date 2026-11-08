import CryptoKit
import Foundation
import Security

public struct HouseholdError: Error, LocalizedError, Equatable {
  public var message: String
  public var status: Int
  public var code: String?
  public init(message: String, status: Int, code: String? = nil) {
    self.message = message
    self.status = status
    self.code = code
  }
  public var errorDescription: String? { message }
}

public enum ServerAddress {
  /// A bare host becomes HTTPS. HTTP is accepted only for this Mac itself, for development.
  /// Paths, queries and credentials in the address are refused rather than guessed at.
  public static func normalize(_ input: String) -> URL? {
    var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.hasSuffix("/") { text.removeLast() }
    guard !text.isEmpty else { return nil }
    if !text.contains("://") { text = "https://" + text }
    guard let components = URLComponents(string: text), let scheme = components.scheme?.lowercased(),
      let host = components.host?.lowercased(), !host.isEmpty, components.user == nil, components.password == nil,
      components.path.isEmpty, components.query == nil, components.fragment == nil
    else { return nil }
    let loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
    guard scheme == "https" || (scheme == "http" && loopback) else { return nil }
    var clean = URLComponents()
    clean.scheme = scheme
    clean.host = components.host
    clean.port = components.port
    return clean.url
  }
}

/// The PKCE request for one sign-in, as in docs/native-api.md.
public struct PKCE: Sendable {
  public let verifier: String
  public let state: String
  public init() throws {
    func random() throws -> String {
      var bytes = [UInt8](repeating: 0, count: 32)
      guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
        throw HouseholdError(message: "Could not create a secure sign-in request.", status: 0)
      }
      return Data(bytes).base64URLEncoded
    }
    verifier = try random()
    state = try random()
  }
  public var challenge: String { Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncoded }

  public func signInURL(server: URL) -> URL {
    var components = URLComponents(url: server.appendingPathComponent("native/sign-in"), resolvingAgainstBaseURL: false)!
    components.queryItems = [
      URLQueryItem(name: "state", value: state), URLQueryItem(name: "code_challenge", value: challenge),
      URLQueryItem(name: "code_challenge_method", value: "S256"),
    ]
    return components.url!
  }

  public func code(from url: URL) throws -> String {
    guard url.scheme == "agentinterface", url.host == "auth", url.path == "/callback",
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      components.queryItems?.first(where: { $0.name == "state" })?.value == state,
      let code = components.queryItems?.first(where: { $0.name == "code" })?.value, !code.isEmpty
    else {
      throw HouseholdError(message: "The sign-in response did not match this Mac's request. Start again.", status: 401)
    }
    return code
  }
}

extension Data {
  var base64URLEncoded: String {
    base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}

public struct EnrollmentRequest: Codable, Equatable, Sendable {
  public var name: String
  public var model: String?
  public var osVersion: String?
  public var appVersion: String?
  public init(name: String, model: String?, osVersion: String?, appVersion: String?) {
    self.name = name
    self.model = model
    self.osVersion = osVersion
    self.appVersion = appVersion
  }

  /// `name` is 1 to 64 characters and the rest at most 64, as the server requires.
  public var validationError: String? {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty || trimmed.utf16.count > 64 { return "Name this Mac with 1 to 64 characters." }
    return nil
  }

  public var clamped: EnrollmentRequest {
    func clip(_ value: String?) -> String? { value.map { String($0.prefix(64)) } }
    return EnrollmentRequest(
      name: name.trimmingCharacters(in: .whitespacesAndNewlines), model: clip(model), osVersion: clip(osVersion),
      appVersion: clip(appVersion))
  }
}

/// The few app-server calls the Mac app makes while linking. Requests carry no cookies and no
/// Origin, as native clients must.
public struct HouseholdAPI: Sendable {
  public let server: URL
  let session: URLSession

  public init(server: URL, session: URLSession? = nil) {
    self.server = server
    if let session {
      self.session = session
    } else {
      let config = URLSessionConfiguration.ephemeral
      config.httpCookieStorage = nil
      config.httpShouldSetCookies = false
      config.urlCache = nil
      config.timeoutIntervalForRequest = 20
      self.session = URLSession(configuration: config)
    }
  }

  public struct AuthConfig: Decodable { public var nativeAuthVersion: Int? }
  public struct Exchange: Decodable { public var token: String }
  public struct Enrollment: Decodable, Equatable {
    public var deviceId: String
    public var credential: String
    public var name: String
  }

  public func requireNativeAuth() async throws {
    let config: AuthConfig = try await send("GET", "/api/auth/config", body: Optional<String>.none, bearer: nil)
    guard config.nativeAuthVersion == 1 else {
      throw HouseholdError(message: "Update this app server to a version with native sign-in, then retry.", status: 409)
    }
  }

  public func exchange(code: String, pkce: PKCE) async throws -> String {
    let result: Exchange = try await send(
      "POST", "/api/auth/native/exchange", body: ["code": code, "state": pkce.state, "codeVerifier": pkce.verifier],
      bearer: nil)
    return result.token
  }

  public func enroll(_ request: EnrollmentRequest, bearer: String) async throws -> Enrollment {
    try await send("POST", "/api/mac/devices", body: request.clamped, bearer: bearer)
  }

  /// The signed-in person's own personal assistants, to offer when adding grants.
  public func personalAssistants(bearer: String) async throws -> [KnownAssistant] {
    struct Bootstrap: Decodable {
      struct User: Decodable { var id: String }
      struct Bot: Decodable {
        var id: String
        var name: String
        var shared: Bool?
        var ownerId: String?
      }
      var user: User
      var bots: [Bot]
    }
    let bootstrap: Bootstrap = try await send("GET", "/api/bootstrap", body: Optional<String>.none, bearer: bearer)
    return bootstrap.bots.filter { $0.shared != true && $0.ownerId == bootstrap.user.id }
      .map { KnownAssistant(id: $0.id, name: $0.name) }
  }

  public func logout(bearer: String) async throws {
    let _: Empty = try await send("POST", "/api/auth/logout", body: [String: String](), bearer: bearer)
  }

  /// Revokes this Mac with its own device credential, so it leaves the owner's list at once.
  public func unlinkSelf(_ credential: DeviceCredential) async throws {
    let _: Empty = try await send(
      "DELETE", "/api/mac/link", body: Optional<String>.none, bearer: nil,
      authorization: "Device \(credential.deviceId).\(credential.credential)")
  }

  struct Empty: Decodable {}
  struct ServerFailure: Decodable {
    var error: String?
    var message: String?
    var code: String?
  }

  func send<Body: Encodable, Response: Decodable>(
    _ method: String, _ path: String, body: Body?, bearer: String?, authorization: String? = nil
  ) async throws -> Response {
    var request = URLRequest(url: server.appendingPathComponent(String(path.dropFirst())))
    request.httpMethod = method
    request.httpShouldHandleCookies = false
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
    if let authorization { request.setValue(authorization, forHTTPHeaderField: "Authorization") }
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONEncoder().encode(body)
    }
    let (data, response) = try await session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      let failure = try? JSONDecoder().decode(ServerFailure.self, from: data)
      throw HouseholdError(
        message: failure?.message ?? failure?.error ?? "The server answered \(status).", status: status, code: failure?.code)
    }
    if Response.self == Empty.self { return Empty() as! Response }
    do {
      return try JSONDecoder().decode(Response.self, from: data)
    } catch {
      throw HouseholdError(message: "The server's answer to \(path) could not be read.", status: status)
    }
  }
}

/// The device credential, with the server it belongs to, in the login Keychain.
public struct KeychainCredentialStore: CredentialStore {
  public static let service = "dev.agentinterface.mac.link"
  let account: String
  public init(account: String = "device") { self.account = account }

  private var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service, kSecAttrAccount as String: account]
  }

  public func load() -> DeviceCredential? {
    var query = self.query
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
    return try? JSONDecoder().decode(DeviceCredential.self, from: data)
  }

  public func save(_ credential: DeviceCredential) throws {
    SecItemDelete(query as CFDictionary)
    var item = query
    item[kSecValueData as String] = try JSONEncoder().encode(credential)
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    item[kSecAttrLabel as String] = "WildBots for Mac link"
    let status = SecItemAdd(item as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw HouseholdError(message: "This Mac's link could not be saved in the Keychain (\(status)).", status: 0)
    }
  }

  public func delete() { SecItemDelete(query as CFDictionary) }
}
