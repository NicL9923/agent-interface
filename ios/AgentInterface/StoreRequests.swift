import SwiftUI

/// What a request started under: the account scope and the client it will talk through.
struct RequestContext {
  let api: APIClient
  let scope: String?
  let isCurrent: @MainActor () -> Bool

  /// Call between the steps of multi-step work, so a request gone stale stops before its next write.
  @MainActor func checkCurrent() throws { if !isCurrent() { throw StaleRequest() } }
}

/// Thrown by `RequestContext.checkCurrent`; `AppStore.attempt` reports it as stale, never as a failure.
struct StaleRequest: Error {}

extension AppStore {
  /// Runs a request for a view and keeps a stale one from touching it.
  ///
  /// The scope and client are captured when the request starts. When it ends, the outcome is
  /// returned only if the user is still in that scope on that client, the surrounding task was
  /// not cancelled, and `current` still holds. A latest-wins load passes its own check there,
  /// such as comparing a load ID or the selected row. A stale outcome, success or failure, comes
  /// back as nil, so the answer to an old question never overwrites the new one. A failure is
  /// current when the scope and task still match, even if the client was replaced.
  /// Multi-step work calls `context.checkCurrent()` between steps to stop once it is stale.
  /// Also nil, without running, when no client is connected. `busy` is on from the call until it
  /// returns, so a caller may set it earlier to close the gap before a `Task` starts.
  func attempt<T>(
    busy: Binding<Bool>? = nil, current: () -> Bool = { true },
    _ work: @MainActor (RequestContext) async throws -> T
  ) async -> Result<T, Error>? {
    busy?.wrappedValue = true
    defer { busy?.wrappedValue = false }
    guard let api else { return nil }
    let started = scope
    let context = RequestContext(api: api, scope: started) { [weak self] in
      !Task.isCancelled && self?.scope == started && self?.api === api
    }
    do {
      let value = try await work(context)
      guard !Task.isCancelled, scope == context.scope, self.api === api, current() else { return nil }
      return .success(value)
    } catch {
      guard !(error is StaleRequest), !Task.isCancelled, scope == context.scope, current() else { return nil }
      return .failure(error)
    }
  }

  /// `attempt` for the common case: a current result is returned, and a current failure becomes
  /// the view's `error` text (`failure` maps it, the error's own description by default) with
  /// nil returned. A stale outcome leaves `error` alone. A caller that clears `error` when it
  /// starts does so itself, since only it knows whether a refresh should hide the last failure.
  @discardableResult
  func run<T>(
    busy: Binding<Bool>? = nil, error message: Binding<String?>,
    failure: (Error) -> String = { $0.localizedDescription },
    current: () -> Bool = { true },
    _ work: @MainActor (RequestContext) async throws -> T
  ) async -> T? {
    switch await attempt(busy: busy, current: current, work) {
    case .success(let value)?: return value
    case .failure(let error)?: message.wrappedValue = failure(error); return nil
    case nil: return nil
    }
  }
}
