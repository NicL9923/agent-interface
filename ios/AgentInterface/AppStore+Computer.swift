import SwiftUI

// The shared desktop's status and control.
extension AppStore {
  /// A failed read keeps the last known status, like the web panel, which only notes it can't reach the computer.
  func refreshComputer() async {
    guard let api, api.token != nil, !sessionExpired, computerWrites == 0 else { return }
    let currentGeneration = generation, writes = computerEpoch
    guard let value: ComputerStatus = try? await api.get("/computer"), currentGeneration == generation,
      writes == computerEpoch
    else { return }
    computerStatus = value
  }
  /// Takes over or hands back the shared desktop for a viewer, through the client the screen opened
  /// it with. The raw outcome always comes back, even once the account changed, since cleanup needs
  /// it; its status reaches the store only for that same client and account, and when `publish`
  /// still says so. Status reads are ordered against it: one started before or during it is
  /// dropped, so an older read never undoes it.
  func controlComputer(_ action: String, viewerId: String, through client: APIClient, scope account: String?,
    publish: @MainActor () -> Bool = { true }) async -> Result<ComputerStatus, Error>
  {
    computerEpoch += 1
    computerWrites += 1
    defer { computerWrites -= 1; computerEpoch += 1 }
    do {
      let next: ComputerStatus = try await client.write("/computer/control", ["action": action, "viewerId": viewerId])
      if api === client, scope == account, !sessionExpired, publish() { computerStatus = next }
      return .success(next)
    } catch { return .failure(error) }
  }
  /// Waits for the cleanup or the deadline, whichever comes first. The cleanup keeps running past
  /// the deadline; only this wait ends, so a slow hand back never holds sign-out up.
  func awaitDesktopCleanup() async {
    guard let cleanup = desktopCleanup else { return }
    let wait = desktopCleanupWait
    awaitingDesktopCleanup = true
    defer { awaitingDesktopCleanup = false }
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      let once = ResumeOnce(continuation)
      let deadline = Task { @MainActor in
        // Timer: sign-out never waits longer than this for the desktop's hand back.
        try? await Task.sleep(for: wait)
        once.resume()
      }
      Task { @MainActor in
        await cleanup.value
        deadline.cancel()
        once.resume()
      }
    }
  }
}
