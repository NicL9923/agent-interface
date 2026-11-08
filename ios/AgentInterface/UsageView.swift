import SwiftUI

/// Plan limits and credits for the provider accounts the household's assistants use, as the web's Usage panel shows them.
struct UsageView: View {
  var close: (() -> Void)? = nil
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @Environment(\.colorScheme) private var scheme
  private let clock = MinuteClock.shared
  @State private var loading = false
  @State private var error: String?
  /// The account a reset is being spent on. Every reset button waits while one is out.
  @State private var resetting: String?
  /// What happened to the last reset on each account, until the sheet closes.
  @State private var outcomes: [String: String] = [:]
  @State private var confirming: UsageAccount?
  /// One ID per reset asked for, by account. A failed attempt keeps it, so trying again can never spend a second reset.
  @State private var resetIds: [String: String] = [:]
  private var overview: UsageOverview? { store.accountUsage }

  var body: some View {
    NavigationStack {
      List {
        if let error { Section { ErrorBanner(message: error) } }
        if let overview {
          if overview.accounts.isEmpty {
            Section { Text("None of your assistants uses an account that reports limits yet.").foregroundStyle(Palette.muted) }
              .accessibilityIdentifier("usage.empty")
          }
          ForEach(overview.accounts) { account in accountSection(account) }
          footer(overview)
        } else if loading {
          Section { HStack { Spacer(); ProgressView(); Spacer() } }.listRowBackground(Color.clear)
        }
      }.listSectionSpacing(18).contentMargins(.top, 12, for: .scrollContent)
        .householdListBackground().accessibilityIdentifier("usage.list")
        .viewHeader("Usage", "Plan limits and credits for the accounts your assistants use.")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { close?() ?? dismiss() }.accessibilityIdentifier("usage.close") } }
        .task { await load(refresh: false) }
        .onChange(of: store.scope) { _, _ in dismiss() }
        .confirmationDialog(confirmTitle, isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
          titleVisibility: .visible, presenting: confirming) { account in
          let wasted = AccountUsage.resetWouldBeWasted(account)
          Button(wasted ? "Use reset anyway" : "Use reset", role: wasted ? .destructive : nil) { Task { await reset(account, force: wasted) } }
            .accessibilityIdentifier("usage.confirmReset")
          Button("Cancel", role: .cancel) {}
        } message: { account in Text(confirmMessage(account)) }
    }
  }

  // MARK: Accounts
  private func accountSection(_ account: UsageAccount) -> some View {
    Section {
      HStack(spacing: 10) {
        ProviderIcon(provider: account.provider, size: 20)
        VStack(alignment: .leading, spacing: 2) {
          Text(AccountUsage.name(account.provider)).font(.headline)
          if let plan = account.plan { Text(plan).font(.subheadline).foregroundStyle(Palette.muted) }
        }
        Spacer(minLength: 8)
        if account.fallbackOnly {
          Text("Fallback").font(.caption.weight(.semibold)).foregroundStyle(Palette.muted)
            .padding(.horizontal, 8).padding(.vertical, 3).background(Palette.line.opacity(0.5), in: Capsule())
        }
      }.accessibilityElement(children: .combine).accessibilityAddTraits(.isHeader)
      ForEach(Array(account.windows.enumerated()), id: \.offset) { _, window in windowRow(window) }
      ForEach(Array(account.details.enumerated()), id: \.offset) { _, line in Text(line).font(.subheadline) }
      if let reason = account.unavailableReason { Text(reason).font(.footnote).foregroundStyle(Palette.muted) }
      if account.bankedResets > 0 { resetRow(account) }
      if let message = outcomes[account.key] {
        Text(message).font(.footnote).foregroundStyle(Palette.muted).accessibilityIdentifier("usage.outcome.\(account.key)")
      }
      let names = AccountUsage.assistantNames(account, bots: store.bootstrap?.bots ?? [])
      if !names.isEmpty {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text("Used by").foregroundStyle(Palette.muted)
          Text(ListFormatter.localizedString(byJoining: names)).frame(maxWidth: .infinity, alignment: .leading)
        }.font(.footnote).accessibilityElement(children: .combine)
      }
    }.listRowBackground(Palette.raised(scheme))
  }

  private func windowRow(_ window: UsageWindow) -> some View {
    let phrase = window.resetsAt.map { AccountUsage.resetPhrase($0, now: clock.now) }.flatMap { $0.isEmpty ? nil : $0 } ?? window.detail
    return VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .firstTextBaseline) {
        Text(window.label).font(.subheadline.weight(.medium))
        Spacer(minLength: 8)
        Text(window.usedPercent.map { "\(Int($0.rounded()))% used" } ?? "Not reported").font(.subheadline).foregroundStyle(Palette.muted)
      }
      if let percent = window.usedPercent {
        ProgressView(value: min(max(percent, 0), 100), total: 100).tint(color(AccountUsage.level(percent))).accessibilityHidden(true)
      }
      if let phrase { Text(phrase).font(.footnote).foregroundStyle(Palette.muted) }
    }.accessibilityElement(children: .combine)
  }
  private func color(_ level: AccountUsage.Level) -> Color {
    switch level { case .ok: Palette.accent; case .warn: Palette.attention; case .alarm: Palette.danger }
  }

  // MARK: Resets
  private func resetRow(_ account: UsageAccount) -> some View {
    HStack {
      Text(AccountUsage.countPhrase(account.bankedResets, "banked reset")).font(.subheadline)
      Spacer(minLength: 8)
      Button("Use a reset") { confirming = account }.buttonStyle(.bordered).controlSize(.small)
        .disabled(resetting != nil).accessibilityIdentifier("usage.reset.\(account.key)")
    }
  }
  private var confirmTitle: String {
    guard let confirming else { return "" }
    return AccountUsage.resetWouldBeWasted(confirming) ? "Use a reset early?" : "Use a banked reset?"
  }
  private func confirmMessage(_ account: UsageAccount) -> String {
    AccountUsage.resetWouldBeWasted(account)
      ? "No limit is used up yet. A reset restores the full allowance, so using it now wastes most of it."
      : "This restores this account's session and weekly limits now. You'll have \(account.bankedResets - 1) left."
  }
  private func reset(_ account: UsageAccount, force: Bool) async {
    guard resetting == nil else { return }
    resetting = account.key; error = nil
    defer { resetting = nil }
    let scope = store.scope
    do {
      let requestId = resetIds[account.key] ?? UUID().uuidString
      resetIds[account.key] = requestId
      let result = try await store.resetAccountUsage(account, force: force, requestId: requestId)
      resetIds[account.key] = nil
      guard scope == store.scope else { return }
      outcomes[account.key] = AccountUsage.resetOutcome(result)
      // The server could not read the account again, so the counts shown are stale: read them.
      if result.account == nil { error = await store.refreshAccountUsage(refresh: true) }
    } catch { if scope == store.scope { self.error = error.localizedDescription } }
  }

  // MARK: Footer
  @ViewBuilder private func footer(_ overview: UsageOverview) -> some View {
    Section {
      HStack {
        if let fetched = AccountUsage.newestFetch(overview.accounts) {
          Text("Updated \(Self.relative(fetched, now: clock.now))").font(.footnote).foregroundStyle(Palette.muted)
        }
        Spacer(minLength: 8)
        if loading { ProgressView().controlSize(.small) }
        Button("Refresh") { Task { await load(refresh: true) } }.buttonStyle(.bordered).controlSize(.small)
          .disabled(loading || resetting != nil).accessibilityIdentifier("usage.refresh")
      }
      if !overview.unavailableBots.isEmpty {
        Text("Usage unavailable for \(AccountUsage.countPhrase(overview.unavailableBots.count, "assistant")).")
          .font(.footnote).foregroundStyle(Palette.muted).accessibilityIdentifier("usage.unavailableBots")
      }
    }.listRowBackground(Color.clear)
  }
  /// "5 minutes ago". A read a moment ahead of this device's clock is "now", not "in 3 seconds".
  static func relative(_ date: Date, now: Date, locale: Locale = .current) -> String {
    let formatter = RelativeDateTimeFormatter()
    formatter.locale = locale; formatter.unitsStyle = .full; formatter.dateTimeStyle = .named
    return formatter.localizedString(for: min(date, now), relativeTo: now)
  }

  private func load(refresh: Bool) async {
    guard !loading else { return }
    loading = true; error = nil
    defer { loading = false }
    error = await store.refreshAccountUsage(refresh: refresh)
  }
}
