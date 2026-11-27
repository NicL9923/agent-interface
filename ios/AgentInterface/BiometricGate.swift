import LocalAuthentication
import SwiftUI

/// Outcome of a LocalAuthentication verification check.
enum BiometricOutcome: Equatable, Sendable {
  case authenticated
  case cancelled
  case failed(String)
  case unavailable(String)
}

/// Injectable authentication boundary so unit tests verify every accept, cancel, error, and
/// account-switch/background relock branch offline without showing a system biometric prompt.
protocol BiometricAuthenticating: Sendable {
  var biometryLabel: String { get }
  var biometrySymbol: String { get }
  var isAvailable: Bool { get }
  func authenticate(reason: String) async -> BiometricOutcome
}

struct SystemBiometricAuthenticator: BiometricAuthenticating {
  private func context() -> LAContext {
    let context = LAContext()
    context.localizedFallbackTitle = "Use Passcode"
    return context
  }

  var biometryLabel: String {
    let ctx = context()
    var error: NSError?
    _ = ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
    switch ctx.biometryType {
    case .faceID: return "Face ID"
    case .touchID: return "Touch ID"
    case .opticID: return "Optic ID"
    default: return "Passcode"
    }
  }

  var biometrySymbol: String {
    let ctx = context()
    var error: NSError?
    _ = ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
    switch ctx.biometryType {
    case .faceID: return "faceid"
    case .touchID: return "touchid"
    case .opticID: return "opticid"
    default: return "lock.shield"
    }
  }

  var isAvailable: Bool {
    let ctx = context()
    var error: NSError?
    return ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
  }

  func authenticate(reason: String) async -> BiometricOutcome {
    let ctx = context()
    var policyError: NSError?
    guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
      return .unavailable(policyError?.localizedDescription ?? "Device authentication is not configured on this device.")
    }
    do {
      let ok = try await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
      return ok ? .authenticated : .failed("Authentication did not succeed.")
    } catch let error as LAError {
      switch error.code {
      case .userCancel, .systemCancel, .appCancel:
        return .cancelled
      case .biometryNotAvailable, .biometryNotEnrolled, .passcodeNotSet:
        return .unavailable(error.localizedDescription)
      default:
        return .failed(error.localizedDescription)
      }
    } catch {
      return .failed(error.localizedDescription)
    }
  }
}

/// Gates Vault access, `vault.unlock_prompt`, and sensitive/high-risk approvals behind Face ID /
/// Touch ID (with device passcode fallback). Designed for shared iPads:
/// - Toggle is stored per account scope so one household member's choice never weakens another's.
/// - Unlocked state is strictly in-memory, bound to the exact account `scope`, and cleared
///   immediately on backgrounding, scene deactivation, account change, or sign-out.
/// - Disabling protection requires authentication first.
@MainActor @Observable final class BiometricGate {
  static let shared = BiometricGate()

  /// Which account scope currently has an active in-memory Vault unlock while foregrounded.
  private(set) var unlockedScope: String?
  /// Bumped whenever the per-scope preference changes so Settings and views re-read cleanly.
  private(set) var preferenceVersion = 0

  @ObservationIgnored var authenticator: BiometricAuthenticating
  @ObservationIgnored var defaults: UserDefaults

  init(authenticator: BiometricAuthenticating = SystemBiometricAuthenticator(), defaults: UserDefaults = .standard) {
    self.authenticator = authenticator
    self.defaults = defaults
  }

  var biometryLabel: String { authenticator.biometryLabel }
  var biometrySymbol: String { authenticator.biometrySymbol }
  var isAvailable: Bool { authenticator.isAvailable }

  static func preferenceKey(scope: String) -> String { "native.\(scope).biometricLock" }

  /// Whether biometric protection is turned on for `scope`. Defaults to `false` until enabled.
  func isEnabled(for scope: String?) -> Bool {
    _ = preferenceVersion
    guard let scope, !scope.isEmpty else { return false }
    return defaults.bool(forKey: Self.preferenceKey(scope: scope))
  }

  /// Whether the Vault UI is currently unlocked for `scope`.
  func isVaultUnlocked(for scope: String?) -> Bool {
    guard let scope, !scope.isEmpty else { return false }
    if !isEnabled(for: scope) { return true }
    return unlockedScope == scope
  }

  /// Immediately clears any in-memory unlock grant. Called on backgrounding, sign-out, or account switch.
  func lock() {
    if unlockedScope != nil { unlockedScope = nil }
  }

  /// Enables or disables biometric gating for `scope`. Enabling verifies the user can authenticate;
  /// disabling requires authentication so another person on a shared iPad cannot turn it off.
  func setEnabled(_ enabled: Bool, for scope: String?) async -> BiometricOutcome {
    guard let scope, !scope.isEmpty else { return .failed("Sign in first.") }
    let reason = enabled
      ? "Verify your identity to require \(biometryLabel) for Vault and sensitive approvals."
      : "Verify your identity to turn off \(biometryLabel) protection."
    let outcome = await authenticator.authenticate(reason: reason)
    guard outcome == .authenticated else { return outcome }
    defaults.set(enabled, forKey: Self.preferenceKey(scope: scope))
    if !enabled { unlockedScope = nil }
    preferenceVersion += 1
    return .authenticated
  }

  /// Authenticates for a gated surface. When `requireFresh` is true (used for `vault.unlock_prompt`
  /// and sensitive approvals), always prompts instead of reusing an earlier Vault unlock.
  func verify(reason: String, scope: String?, requireFresh: Bool = false) async -> BiometricOutcome {
    guard let scope, !scope.isEmpty else { return .failed("Sign in first.") }
    guard isEnabled(for: scope) else { return .authenticated }
    if !requireFresh && unlockedScope == scope { return .authenticated }
    let outcome = await authenticator.authenticate(reason: reason)
    if outcome == .authenticated, !requireFresh {
      unlockedScope = scope
    }
    return outcome
  }

  /// Classifies whether approving an approval request is sensitive / high-risk and should require
  /// fresh biometric verification when biometric gating is enabled.
  /// Declining never requires biometrics.
  static func isSensitiveApproval(_ approval: Approval, decision: String, scope: String?) -> Bool {
    guard decision == "approved" else { return false }
    if scope == "always" || scope == "session" { return true }
    if let patterns = approval.patterns, !patterns.isEmpty { return true }
    let command = (approval.command ?? "").lowercased()
    let sensitiveCommandTokens = [
      "sudo ", "rm ", "rm -", "chmod ", "chown ", "dd ", "mkfs", "kill ", "killall ",
      "launchctl ", "systemctl ", "git push", "git reset --hard", "ssh ", "scp ",
      "curl ", "wget ", "security ", "keychain", "passwd", "vault",
    ]
    if sensitiveCommandTokens.contains(where: { command.contains($0) }) || command == "sudo" {
      return true
    }
    let summary = (approval.title + " " + approval.detail).lowercased()
    let sensitiveKeywords = [
      "destructive", "delete", "remove", "credential", "password", "vault", "secret",
      "token", "admin", "root", "sudo", "payment", "purchase", "transfer", "production",
    ]
    return sensitiveKeywords.contains(where: { summary.contains($0) })
  }
}

/// Cover shown over `VaultView` when biometric gating is enabled and the vault is locked.
struct VaultLockedView: View {
  var gate: BiometricGate
  var error: String?
  var busy: Bool
  var unlock: () -> Void
  var body: some View {
    VStack(spacing: 16) {
      Image(systemName: gate.biometrySymbol)
        .font(.system(size: 44))
        .foregroundStyle(Palette.accent)
        .accessibilityHidden(true)
      Text("Passwords & logins locked")
        .font(.title3.bold())
      Text("Authenticate with \(gate.biometryLabel) to view or manage saved logins for this account.")
        .font(.footnote)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
      if let error {
        ErrorBanner(message: error)
      }
      Button {
        unlock()
      } label: {
        Label(busy ? "Authenticating…" : "Unlock with \(gate.biometryLabel)", systemImage: gate.biometrySymbol)
          .frame(minHeight: 30)
      }
      .buttonStyle(.accentProminent)
      .controlSize(.large)
      .disabled(busy)
      .accessibilityIdentifier("vault.biometricUnlock")
    }
    .padding(24)
    .frame(maxWidth: 420)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("vaultLockedView")
  }
}
