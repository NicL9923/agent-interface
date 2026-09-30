import CryptoKit
import Foundation
import Security

struct APIError: Error, LocalizedError {
  var message: String
  var status: Int
  var code: String? = nil
  var confirmRequired = false
  var errorDescription: String? { message }
}
struct SecureToken {
  static let service = "dev.agentinterface.native"
  static func read(host: String) -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: host, kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data
    else { return nil }
    return String(data: data, encoding: .utf8)
  }
  static func save(_ token: String?, host: String) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: host,
    ]
    SecItemDelete(query as CFDictionary)
    guard let token else { return }
    var value = query
    value[kSecValueData as String] = Data(token.utf8)
    value[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(value as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw APIError(
        message: "The sign-in token could not be saved in Keychain (\(status)).", status: 0)
    }
  }
}
struct PKCE {
  let verifier: String
  let state: String
  init() throws {
    func random() throws -> String {
      var bytes = [UInt8](repeating: 0, count: 32)
      guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
        throw APIError(message: "Could not create a secure sign-in request.", status: 0)
      }
      return Data(bytes).base64URLEncoded
    }
    verifier = try random()
    state = try random()
  }
  var challenge: String { Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncoded }
  func code(from url: URL) throws -> String {
    guard url.scheme == "agentinterface", url.host == "auth", url.path == "/callback",
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      components.queryItems?.first(where: { $0.name == "state" })?.value == state,
      let code = components.queryItems?.first(where: { $0.name == "code" })?.value, !code.isEmpty
    else {
      throw APIError(
        message: "The sign-in response did not match this device's request. Start sign-in again.",
        status: 401)
    }
    return code
  }
}
extension Data {
  var base64URLEncoded: String {
    base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(
      of: "/", with: "_"
    ).replacingOccurrences(of: "=", with: "")
  }
}

@MainActor final class APIClient {
  var baseURL: URL
  var token: String?
  var csrf: String?
  var localCookieAuth = false
  let session: URLSession
  init(baseURL: URL, session: URLSession? = nil) {
    self.baseURL = baseURL
    if let session {
      self.session = session
    } else {
      let config = URLSessionConfiguration.ephemeral
      config.urlCache = nil
      config.requestCachePolicy = .reloadIgnoringLocalCacheData
      config.timeoutIntervalForRequest = 20
      config.timeoutIntervalForResource = 60
      config.httpCookieStorage = HTTPCookieStorage()
      self.session = URLSession(
        configuration: config, delegate: SameOriginRedirectDelegate(origin: baseURL),
        delegateQueue: nil)
    }
    token = SecureToken.read(host: baseURL.absoluteString)
  }
  static func component(_ value: String) -> String {
    value.addingPercentEncoding(
      withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_")))!
  }
  func url(_ path: String) throws -> URL {
    guard path.hasPrefix("/"), !path.hasPrefix("//"),
      let url = URL(string: path, relativeTo: baseURL)?.absoluteURL, url.host == baseURL.host,
      url.scheme == baseURL.scheme, url.port == baseURL.port
    else { throw APIError(message: "Invalid application file address.", status: 0) }
    return url
  }
  func data(
    path: String, method: String = "GET", body: Data? = nil, contentType: String? = nil,
    authenticated: Bool = true
  ) async throws -> Data {
    var request = URLRequest(url: try url(path))
    request.httpMethod = method
    request.httpBody = body
    request.timeoutInterval = method == "GET" ? 20 : 60
    if authenticated, let token {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    if localCookieAuth && method != "GET" {
      request.setValue(baseURL.absoluteString, forHTTPHeaderField: "Origin")
      request.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token")
    }
    if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
    request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
    let (data, response): (Data, URLResponse)
    do { (data, response) = try await session.data(for: request) } catch is CancellationError {
      throw CancellationError()
    } catch {
      if (error as? URLError)?.code == .cancelled { throw CancellationError() }
      throw APIError(
        message:
          "Can't reach the app server. Your draft is kept; sent messages will be checked before retrying.",
        status: 503, code: "CONNECTION_UNAVAILABLE")
    }
    guard let response = response as? HTTPURLResponse else {
      throw APIError(message: "The server returned an invalid response.", status: 502)
    }
    guard (200..<300).contains(response.statusCode) else {
      let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      throw APIError(
        message: object?["detail"] as? String ?? object?["error"] as? String
          ?? "Request failed (\(response.statusCode)).", status: response.statusCode,
        code: object?["code"] as? String,
        confirmRequired: object?["confirmRequired"] as? Bool ?? false)
    }
    return data
  }
  func get<T: Decodable>(_ path: String) async throws -> T {
    try decode(await data(path: "/api" + path))
  }
  func publicGet<T: Decodable>(_ path: String) async throws -> T {
    try decode(await data(path: "/api" + path, authenticated: false))
  }
  func publicWrite<T: Decodable, V: Encodable>(_ path: String, _ value: V) async throws -> T {
    try decode(
      await data(
        path: "/api" + path, method: "POST", body: JSONEncoder().encode(value),
        contentType: "application/json", authenticated: false))
  }
  func write<T: Decodable, V: Encodable>(_ path: String, _ value: V, method: String = "POST")
    async throws -> T
  {
    try decode(
      await data(
        path: "/api" + path, method: method, body: JSONEncoder().encode(value),
        contentType: "application/json"))
  }
  func delete(_ path: String) async throws {
    _ = try await data(path: "/api" + path, method: "DELETE")
  }
  private func decode<T: Decodable>(_ data: Data) throws -> T {
    do { return try JSONDecoder().decode(T.self, from: data) } catch {
      throw APIError(
        message:
          "The app server returned an unreadable response. Check that its version supports this client.",
        status: 502, code: "INVALID_RESPONSE")
    }
  }
  func upload(botId: String, name: String, mime: String, data: Data) async throws -> FileRef {
    guard
      ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain"]
        .contains(mime), data.count <= 20 * 1024 * 1024
    else {
      throw APIError(
        message: "Choose an image, PDF, or plain-text file no larger than 20 MB.", status: 400)
    }
    let boundary = "AgentInterface-\(UUID().uuidString)"
    let safeName = name.replacingOccurrences(of: "\"", with: "_").replacingOccurrences(
      of: "\r", with: "_"
    ).replacingOccurrences(of: "\n", with: "_")
    var body = Data(
      "--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\nContent-Type: \(mime)\r\n\r\n"
        .utf8)
    body.append(data)
    body.append(Data("\r\n--\(boundary)--\r\n".utf8))
    return try decode(
      await self.data(
        path: "/api/bots/\(Self.component(botId))/uploads", method: "POST", body: body,
        contentType: "multipart/form-data; boundary=\(boundary)"))
  }
}

private final class SameOriginRedirectDelegate: NSObject, URLSessionTaskDelegate,
  @unchecked Sendable
{
  let origin: URL
  init(origin: URL) { self.origin = origin }
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    guard let url = request.url, url.scheme == origin.scheme, url.host == origin.host,
      url.port == origin.port
    else {
      completionHandler(nil)
      return
    }
    completionHandler(request)
  }
}
