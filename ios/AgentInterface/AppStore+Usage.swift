import Foundation

extension AppStore {
  /// Reads the accounts' limits. `refresh` asks Hermes to read the providers again instead of answering from the server's last read.
  /// A read for an account that has since changed is dropped. Returns the error's words, or nil on success.
  @discardableResult func refreshAccountUsage(refresh: Bool = false) async -> String? {
    guard let api, let scope else { return nil }
    let generation = accountUsageGeneration
    do {
      let overview: UsageOverview = try await api.get("/usage/accounts" + (refresh ? "?refresh=1" : ""))
      if scope == self.scope, generation == accountUsageGeneration { accountUsage = overview; accountUsageReadAt = Date() }
      return nil
    } catch { return scope == self.scope ? error.localizedDescription : nil }
  }
  /// Reads the accounts again once the last read is a minute old, which the server would answer from its own read anyway.
  func refreshAccountUsageIfStale(now: Date = Date()) async {
    if let readAt = accountUsageReadAt, accountUsage != nil, now.timeIntervalSince(readAt) < 60 { return }
    await refreshAccountUsage()
  }
  /// Spends a banked reset. The server answers with the account as Hermes reads it afterwards, which replaces the shown one.
  func resetAccountUsage(_ account: UsageAccount, force: Bool, requestId: String) async throws -> ResetResult {
    guard let api else { throw APIError(message: "You are signed out.", status: 0) }
    let scope = self.scope
    // A read already on its way started before this reset, so its answer is dropped when it lands.
    accountUsageGeneration += 1
    let result: ResetResult = try await api.write("/usage/accounts/\(APIClient.component(account.key))/reset", ResetRequest(confirmed: true, requestId: requestId, force: force))
    if scope == self.scope, let updated = result.account, var overview = accountUsage,
       let index = overview.accounts.firstIndex(where: { $0.key == updated.key }) {
      overview.accounts[index] = updated
      accountUsage = overview
    }
    return result
  }
}
