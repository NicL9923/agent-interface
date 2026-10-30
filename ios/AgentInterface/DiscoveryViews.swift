import SwiftUI

struct SearchHit: Decodable, Identifiable {
  var botId: String; var botName: String; var sessionId: String; var title: String; var snippet: String; var routineId: String?; var resultId: String?; var messageId: String?; var offset: Int?
  var updatedAt: String? = nil
  var id: String { botId + ":" + sessionId }
}
struct SearchResponse: Decodable { var hits: [SearchHit]; var unavailableBots: [String] }
struct HistoryPage: Decodable { var botId: String; var sessionId: String; var messages: [Message]; var offset: Int; var hasMore: Bool; var targetMessageId: String? }
struct SavedItem: Codable, Identifiable { var id: String; var botId: String; var kind: String; var sessionId: String?; var routineId: String?; var resultId: String?; var messageId: String?; var offset: Int?; var title: String; var createdAt: String }
struct SavedPointer: Encodable { var botId: String; var kind: String; var sessionId: String?; var routineId: String?; var resultId: String?; var messageId: String?; var offset: Int?; var title: String }
struct UsageSummary: Decodable { var botId: String; var sessions: Int; var inputTokens: Int; var outputTokens: Int; var actualCost: Double?; var estimatedCost: Double?; var partial: Bool }
struct AutomationOverview: Decodable { var routines: [Routine]; var usage: [UsageSummary]; var unavailableBots: [String] }
struct Starter: Decodable, Identifiable { var id: String; var title: String; var prompt: String }
/// Searches on their way. Any change to the query makes every one still pending stale, and an
/// answer applies only while the query is still the one it was asked for, success or failure. So a
/// submitted search overtaken by typing, even back to the query already shown, never replaces it.
struct SearchRequests: Equatable {
  private(set) var token = 0
  mutating func queryChanged() { token += 1 }
  mutating func start() -> Int { token += 1; return token }
  func applies(_ request: Int, asked: String, query: String) -> Bool {
    request == token && asked == DiscoveryView.trimmed(query)
  }
}
struct DiscoveryView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var scheme
  private struct Bookmark: Hashable { var botId: String; var sessionId: String; var messageId: String? }
  @State private var pinned: Set<Bookmark> = []
  @State private var pageTitle = "Conversation history"
  @State private var tab = "search"
  @State private var query = ""
  @State private var hits: [SearchHit] = []
  @State private var saved: [SavedItem] = []
  @State private var overview: AutomationOverview?
  @State private var page: HistoryPage?
  @State private var error: String?
  @State private var notice: String?
  @State private var busy = false
  @State private var loadId = UUID()
  /// The history being opened. Leaving the tab forgets it, so a late page cannot replace the new tab.
  @State private var historyRequest: UUID?
  /// The saved reply a history page opened at, highlighted and scrolled to as on the web.
  @State private var savedMessage: String?
  @State private var scrollRequest: UUID?
  @FocusState private var searchFocused: Bool
  /// Numbers each search, so only the latest one's results are shown.
  @State private var requests = SearchRequests()
  /// The query the shown results answer, so a debounce after Enter does not search again.
  @State private var searchedQuery = ""
  @State private var searching = false
  init() {
    #if DEBUG
    if let captureTab = DebugFixtures.captureDiscoveryTab {
      _tab = State(initialValue: captureTab == "history" ? "search" : captureTab)
      if captureTab == "search" || captureTab == "history" { _query = State(initialValue: "dinner") }
    }
    #endif
  }
  var body: some View {
    ScrollViewReader { proxy in
      list.onChange(of: scrollRequest) { _, _ in
        guard let savedMessage else { return }
        Task { @MainActor in withAnimation { proxy.scrollTo(savedMessage, anchor: .top) } }
      }
    }
    .onAppear(perform: focusSearchIfAsked).onChange(of: store.searchFocusPending) { _, _ in focusSearchIfAsked() }
  }
  /// Cmd+F from anywhere opens Search with the keyboard ready.
  private func focusSearchIfAsked() {
    guard store.searchFocusPending else { return }
    store.searchFocusPending = false
    tab = "search"
    Task { @MainActor in searchFocused = true }
  }
  private var list: some View {
    List {
      Section { Picker("View", selection:$tab) { Text("Search").tag("search"); Text("Saved items").tag("saved"); Text("Automations").tag("automations") }.pickerStyle(.segmented) }
      if page == nil, let error { Section { ErrorBanner(message:error) } }
      if let notice { Section { Text(notice) } }
      if busy { ProgressView() }
      if let page {
        Section {
          Text("Read from Hermes. This view does not change the assistant's active conversation.").font(.footnote).foregroundStyle(Palette.muted)
          Button(pinned.contains(bookmark(page)) ? "Saved" : "Save conversation") {
            savePointer(SavedPointer(botId: page.botId, kind: "session", sessionId: page.sessionId, title: knownConversationTitle(page.botId, page.sessionId)))
          }.buttonStyle(.bordered).tint(Palette.messageMetadata).controlSize(.regular).frame(minHeight: 44).disabled(busy || pinned.contains(bookmark(page)))
          ForEach(page.messages) { message in
            HistoryMessageRow(message: message, recipient: name(page.botId), userId: store.bootstrap?.user.id ?? "", saved: savedMessage == message.id,
              isPinned: pinned.contains(bookmark(page, message.id)),
              save: message.role == "assistant" && !message.isInternalActivity ? { saveReply(message, page) } : nil, busy: busy).id(message.id)
          }
          HStack { Button("Previous page") { Task { await history(page.botId,page.sessionId,max(0,page.offset-100)) } }.disabled(busy || page.offset==0); Spacer(); Button("Next page") { Task { await history(page.botId,page.sessionId,page.offset+100) } }.disabled(busy || !page.hasMore) }
        }
      } else if tab == "search" {
        Section {
          HStack {
            TextField("Answers, files, or a topic",text:Binding(get:{ query },set:{ query=Self.clip($0) })).submitLabel(.search).onSubmit { Task { await search() } }.accessibilityLabel("Search conversations").focused($searchFocused)
            if searching { ProgressView().controlSize(.small).accessibilityLabel("Searching") }
            Button("Search") { Task { await search() } }.buttonStyle(.bordered).controlSize(.small)
              .disabled(Self.trimmed(query).isEmpty || busy).accessibilityIdentifier("nativeSearchSubmit")
          }
          ForEach(hits) { hit in
            Button { open(hit) } label: {
              HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                  Text(hit.title).font(.headline).foregroundStyle(Color.primary)
                  Text(searchMeta(hit)).font(.caption).foregroundStyle(Palette.muted)
                  Text(String(hit.snippet.replacingOccurrences(of: "<[^>]*>", with: "", options: .regularExpression).prefix(300)))
                    .lineLimit(4).font(.footnote).foregroundStyle(Palette.muted)
                }.frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(Palette.muted)
              }
            }.accessibilityIdentifier("nativeSearchResult-" + hit.sessionId)
          }
        } footer: { Text("Searches answers, attachment names and routine previews across your assistants.") }
      } else if tab == "saved" {
        Section {
          if saved.isEmpty { Text("No saved items yet. Save a conversation from search or an output from routine results.").foregroundStyle(Palette.muted) }
          ForEach(saved) { item in
            HStack(spacing: 12) {
              Button {
                if let session = item.sessionId { Task { await history(item.botId, session, item.offset ?? 0, item.messageId, title: item.title) } }
                else if let routineId = item.routineId { store.routineResult = RoutineResultDestination(botId: item.botId, routineId: routineId, resultId: item.resultId) }
              } label: {
                VStack(alignment: .leading, spacing: 4) {
                  Text(item.title).font(.headline).foregroundStyle(Color.primary)
                  Text("\(name(item.botId)) · \(item.kind == "routine" ? "Routine output" : item.messageId != nil ? "Reply" : "Conversation") · Saved \(When.format(item.createdAt))")
                    .font(.caption).foregroundStyle(Palette.muted)
                }.frame(maxWidth: .infinity, alignment: .leading)
              }.buttonStyle(.borderless).accessibilityIdentifier("savedItem-" + item.id)
              Button(role: .destructive) { removeSaved(item) } label: { Text("Remove").frame(minWidth: 44, minHeight: 44) }
                .buttonStyle(.borderless).disabled(busy).accessibilityLabel("Remove \(item.title)")
            }.swipeActions {
              Button(role: .destructive) { removeSaved(item) } label: { Label("Remove", systemImage: "trash") }.disabled(busy)
            }
          }
        } header: { Text("Links to original conversations and routine outputs. Removed originals may be unavailable.").textCase(nil).font(.footnote) }
      } else {
        Section {
          HStack(alignment:.top,spacing:12) {
            Text("Upcoming work, recent failures, recipients and 30-day usage.").font(.footnote).foregroundStyle(Palette.muted).frame(maxWidth:.infinity,alignment:.leading)
            Button("Refresh") { Task { await perform { api in overview = try await api.get("/automations") } } }.buttonStyle(.bordered).controlSize(.small).disabled(busy).accessibilityIdentifier("refreshAutomations")
          }
          if overview?.routines.isEmpty == true { Text("No routines yet. Create one in assistant settings.") }
          ForEach(overview?.routines ?? []) { row in automationRow(row) }
        }
        Section {
          ForEach(overview?.usage ?? [],id:\.botId) { usage in
            VStack(alignment:.leading,spacing:4) { Text(name(usage.botId)).font(.headline);Text("\(usage.sessions) sessions · \(usage.inputTokens.formatted()) input / \(usage.outputTokens.formatted()) output tokens");Text("Reported cost: \(cost(usage.actualCost))\(usage.partial && usage.actualCost != nil ? " (partial)" : "") · Estimate: \(cost(usage.estimatedCost))") }.font(.footnote)
          }
          if let overview, !overview.unavailableBots.isEmpty { Text("Usage unavailable for \(overview.unavailableBots.count) assistant(s).") }
        } header: { Text("Usage over 30 days") } footer: { Text("Recorded main-session usage. Estimates and provider invoices may differ. Auxiliary calls are not included.") }
      }
    }.householdListBackground().viewHeader("Search & saved", "Past answers, saved items and automations")
      .safeAreaInset(edge: .top, spacing: 0) { if let page { historyToolbar(page) } }
      .onAppear { Task {
        await load()
        #if DEBUG
        if DebugFixtures.captureDiscoveryTab == "history" {
          await search()
          if let hit = hits.first { await history(hit.botId, hit.sessionId, hit.offset ?? 0, hit.messageId, searchHit: true, title: hit.title) }
        }
        #endif
      } }.onChange(of:tab) { _,_ in page=nil;historyRequest=nil;Task { await load() } }
      // Results follow typing after a short pause, as on the web; Enter still searches at once.
      // Any change to the query makes a search still on its way stale, typed or submitted.
      .onChange(of: query) { _, _ in requests.queryChanged(); searching = false }
      .task(id: query) {
        guard tab == "search", page == nil else { return }
        do { try await Task.sleep(for: Self.searchDelay) } catch { return }
        let text = Self.trimmed(query)
        if text.count < Self.minimumQuery { requests.queryChanged(); searching = false; searchedQuery = ""; hits = []; if notice != nil { notice = nil }; return }
        if text != searchedQuery { await search() }
      }
      .onChange(of:store.scope) { _,_ in loadId=UUID();hits=[];saved=[];pinned=[];overview=nil;page=nil;error=nil;Task { await load() } }
      .refreshable { await load() }
  }
  /// The web's search box `maxLength`; the query sent is the trimmed text.
  static let queryLimit = 200
  static func clip(_ value:String)->String { value.count > queryLimit ? String(value.prefix(queryLimit)) : value }
  static func trimmed(_ value:String)->String { value.trimmingCharacters(in:.whitespacesAndNewlines) }
  private static let savedNotice = "Saved. Find it in Saved items."
  private func bookmark(_ page: HistoryPage, _ message: String? = nil) -> Bookmark {
    Bookmark(botId: page.botId, sessionId: page.sessionId, messageId: message)
  }
  private func savePointer(_ pointer: SavedPointer) {
    guard let session = pointer.sessionId else { return }
    let key = Bookmark(botId: pointer.botId, sessionId: session, messageId: pointer.messageId), owner = store.scope
    Task {
      guard !busy, !pinned.contains(key) else { return }
      await perform { api in
        let _: SavedItem = try await api.write("/saved", pointer)
        guard owner == store.scope else { return }
        pinned.insert(key)
        if page?.botId == pointer.botId, page?.sessionId == session { notice = Self.savedNotice }
      }
    }
  }
  private func saveReply(_ message: Message, _ page: HistoryPage) {
    savePointer(SavedPointer(botId: page.botId, kind: "session", sessionId: page.sessionId, messageId: message.id, offset: page.offset, title: Self.replyTitle(message.text)))
  }
  private func removeSaved(_ item: SavedItem) {
    Task { guard !busy else { return }; await perform { api in
      let _: EmptyResponse = try await api.write("/saved/\(APIClient.component(item.id))", [String:String](), method: "DELETE")
      saved.removeAll { $0.id == item.id }
      if item.kind == "session", let session = item.sessionId { pinned.remove(Bookmark(botId: item.botId, sessionId: session, messageId: item.messageId)) }
    } }
  }
  private func knownConversationTitle(_ bot: String, _ session: String) -> String {
    if let title = hits.first(where: { $0.botId == bot && $0.sessionId == session })?.title { return String(title.prefix(120)) }
    return saved.first { $0.botId == bot && $0.sessionId == session && $0.messageId == nil }?.title ?? "Saved conversation"
  }
  private func searchMeta(_ hit: SearchHit) -> String {
    let kind = hit.routineId != nil ? "Routine output" : Self.liveMessage(hit, bots: store.bootstrap?.bots ?? []) != nil ? "Current chat" : "Past conversation"
    return "\(name(hit.botId, fallback: hit.botName)) · \(kind)" + (hit.updatedAt.map { " · Updated \(When.format($0))" } ?? "")
  }
  private func historyToolbar(_ page: HistoryPage) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Button { self.page = nil; historyRequest = nil; error = nil; notice = nil } label: { Label("Back to results", systemImage: "chevron.left") }
        .buttonStyle(.bordered).controlSize(.regular)
      Text(pageTitle).font(.headline).lineLimit(2)
      Text("\(name(page.botId)) · Read-only history").font(.caption).foregroundStyle(Palette.muted)
      if let error { ErrorBanner(message: error) }
    }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.vertical, 8)
      .background(Palette.surface(scheme)).overlay(alignment: .bottom) { Divider() }
  }
  private func automationRow(_ row: Routine) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(row.name).font(.headline)
      HStack {
        Text(name(row.botId)).font(.subheadline)
        Text(row.enabled ? "Enabled" : "Paused").font(.caption.weight(.semibold)).foregroundStyle(Palette.muted)
          .padding(.horizontal, 8).padding(.vertical, 2).overlay(Capsule().strokeBorder(Palette.line))
      }
      Text(!row.enabled ? "Paused. No runs until you resume." : row.nextRunAt.map { "Next: \(When.format($0))" } ?? "No upcoming run reported")
        .font(.footnote).foregroundStyle(Palette.muted)
      if let status = row.lastStatus {
        Text("Last result: \(Self.routineResultLabel(status))").font(.footnote)
          .foregroundStyle(row.lastError != nil || row.lastDeliveryError != nil ? Palette.danger : Palette.muted)
      }
      if let failure = row.lastError ?? row.lastDeliveryError { Text(failure).foregroundStyle(Palette.danger).font(.footnote) }
      Text("Notify: \(notifyNames(row))").font(.footnote).foregroundStyle(Palette.muted)
      HStack {
        Button("View outputs") { store.routineResult = RoutineResultDestination(botId: row.botId, routineId: row.id) }
        Button(row.enabled ? "Pause" : "Resume") { Task { await perform { api in
          let _: EmptyResponse = try await api.write("/routines/\(APIClient.component(row.id))/state", ["enabled": !row.enabled], method: "PATCH")
          overview = try await api.get("/automations")
        } } }.disabled(busy)
      }.buttonStyle(.bordered).controlSize(.large)
    }
  }
  static func routineResultLabel(_ value: String) -> String {
    switch value {
    case "ok", "success", "succeeded": "Succeeded"
    case "error", "failed": "Failed"
    case "delivery_failed": "Delivery failed"
    case "running": "Running"
    case "pending": "Pending"
    case "skipped": "Skipped"
    case "cancelled": "Canceled"
    default: value
    }
  }
  /// A saved conversation keeps the title its search hit showed.
  static func conversationTitle(_ hits:[SearchHit],_ sessionId:String)->String {
    let title = String((hits.first { $0.sessionId == sessionId }?.title ?? "").prefix(120))
    return title.isEmpty ? "Saved conversation" : title
  }
  static func replyTitle(_ text:String)->String {
    let first = text.components(separatedBy: .newlines).first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? ""
    let title = first.replacingOccurrences(of: "^\\s*(?:#{1,6}\\s+|[-+*]\\s+|\\d+[.)]\\s+)", with: "", options: .regularExpression)
      .replacingOccurrences(of: "[`*]", with: "", options: .regularExpression)
      .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else { return "Saved reply" }
    guard title.count > 80 else { return title }
    let prefix = String(title.prefix(79))
    return (prefix.lastIndex(of: " ").map { String(prefix[..<$0]) } ?? prefix) + "…"
  }
  private func notifyNames(_ row:Routine)->String {
    let names = (row.recipientIds ?? []).map { id in store.bootstrap?.household.first { $0.id == id }?.name ?? "Household member" }
    return names.isEmpty ? "No routine recipients selected" : names.joined(separator:", ")
  }
  private func name(_ id:String, fallback: String = "Assistant")->String { store.bootstrap?.bots.first { $0.id == id }?.name ?? fallback }
  private func cost(_ value:Double?)->String { value.map { String(format:"$%.2f",$0) } ?? "Unknown" }
  private func perform(_ action:(APIClient)async throws->Void) async {
    guard let api=store.api else { return };let scope=store.scope;let request=UUID();loadId=request;busy=true;error=nil;notice=nil
    defer { if scope==store.scope && request==loadId { busy=false } }
    do { try await action(api) } catch { if scope==store.scope && request==loadId { self.error=error.localizedDescription } }
    if scope != store.scope { hits=[];saved=[];pinned=[];overview=nil;page=nil;notice=nil }
  }
  private func load() async { await perform { api in if tab=="saved" { saved=try await api.get("/saved"); pinned = Set(saved.compactMap { item in item.kind == "session" ? item.sessionId.map { Bookmark(botId: item.botId, sessionId: $0, messageId: item.messageId) } : nil }) };if tab=="automations" { overview=try await api.get("/automations") } } }
  /// Typing waits this long before searching; at least two characters are needed.
  static let searchDelay: Duration = .milliseconds(300)
  static let minimumQuery = 2
  /// Searches for the current query. A slower answer to an earlier query is dropped.
  private func search() async {
    let text = Self.trimmed(query)
    guard !text.isEmpty, let api = store.api else { return }
    let request = requests.start(), scope = store.scope
    searching = true; error = nil
    defer { if request == requests.token { searching = false } }
    do {
      let result: SearchResponse = try await api.get("/search?q=\(text.addingPercentEncoding(withAllowedCharacters:.alphanumerics) ?? "")")
      guard !Task.isCancelled, requests.applies(request, asked: text, query: query), scope == store.scope else { return }
      searchedQuery = text
      hits = result.hits
      notice = result.unavailableBots.isEmpty ? (hits.isEmpty ? "No matching conversations." : nil) : "Could not search \(result.unavailableBots.count) assistant(s)."
      AccessibilityNotification.Announcement(Self.resultsAnnouncement(hits.count)).post()
    } catch {
      guard !Task.isCancelled, requests.applies(request, asked: text, query: query), scope == store.scope else { return }
      self.error = error.localizedDescription
    }
  }
  static func resultsAnnouncement(_ count: Int) -> String { count == 0 ? "No matching conversations" : count == 1 ? "1 result" : "\(count) results" }
  /// A hit in an assistant's current conversation opens that conversation at the message, so the
  /// person can reply there. Older sessions and routine results open their read-only history.
  private func open(_ hit: SearchHit) {
    if let routine = hit.routineId {
      store.routineResult = RoutineResultDestination(botId: hit.botId, routineId: routine, resultId: hit.resultId)
    } else if let messageId = Self.liveMessage(hit, bots: store.bootstrap?.bots ?? []) {
      Task { await store.openConversation(botId: hit.botId, atMessage: messageId) }
    } else {
      Task { await history(hit.botId, hit.sessionId, hit.offset ?? 0, hit.messageId, searchHit: true, title: hit.title) }
    }
  }
  /// The message to open in the live conversation, when the hit is in its assistant's current session.
  static func liveMessage(_ hit: SearchHit, bots: [Bot]) -> String? {
    guard hit.routineId == nil, let messageId = hit.messageId,
      let session = bots.first(where: { $0.id == hit.botId })?.sessionId, session == hit.sessionId else { return nil }
    return messageId
  }
  private func history(_ bot:String,_ session:String,_ offset:Int=0,_ messageId:String?=nil,searchHit:Bool=false,title:String?=nil) async {
    let title = title ?? (page?.botId == bot && page?.sessionId == session ? pageTitle : knownConversationTitle(bot, session))
    let request = UUID(); historyRequest = request; let scope = store.scope
    await perform { api in
      let target = messageId.map { "&messageId=" + APIClient.component($0) } ?? ""
      let path = "/bots/\(APIClient.component(bot))/history/\(APIClient.component(session))"
      let result: HistoryPage
      var requestedMessage = messageId
      do { result = try await api.get("\(path)?offset=\(offset)\(target)") }
      catch let error as APIError where searchHit && messageId != nil && error.status == 404 {
        guard historyRequest == request, scope == store.scope else { return }
        result = try await api.get("\(path)?offset=0")
        requestedMessage = nil
      }
      guard historyRequest == request, scope == store.scope else { return }
      let messageId = result.targetMessageId ?? requestedMessage
      if let messageId,!result.messages.contains(where:{$0.id==messageId}) { throw APIError(message:"The saved reply is unavailable. Its original history changed in Hermes.",status:404) }
      savedMessage=messageId;pageTitle=title;page=result;if messageId != nil { scrollRequest=UUID() }
    }
  }
}
/// A message in a history page, as the web's DiscoveryPanel shows it: activity folded away, an
/// agent exchange as its card, a tool call as its receipt, and a person's text as plain text.
struct HistoryMessageRow: View {
  var message: Message
  var recipient: String
  var userId: String = ""
  var saved: Bool
  var isPinned = false
  var save: (() -> Void)?
  var busy = false
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        if let label { Text(label).font(.caption).foregroundStyle(Palette.muted) }
        if let save { Button(isPinned ? "Saved" : "Save reply", action: save).font(.subheadline).buttonStyle(.bordered).tint(Palette.messageMetadata).controlSize(.regular).frame(minHeight: 44).disabled(busy || isPinned) }
      }
      content
      ForEach(message.files ?? []) { FileAttachmentView(file: $0) }
    }.padding(.leading, saved ? 12 : 0)
      .overlay(alignment: .leading) {
        // The web marks the saved reply with an accent border; VoiceOver hears it as well.
        if saved {
          Rectangle().fill(Palette.accent).frame(width: 3)
            .accessibilityElement().accessibilityLabel("Saved reply").accessibilityIdentifier("savedReplyMarker-" + message.id)
        }
      }
  }
  private var label: String? {
    if message.presentationOrigin?.kind == "scheduled" { return "Scheduled" }
    if message.isInternalActivity { return "Activity" }
    if message.toolCall != nil || message.isAgentExchange { return nil }
    if message.role == "assistant" { return recipient }
    if message.role == "user" { return message.sender?.id == userId ? "You" : message.sender?.name ?? "User" }
    return message.role.capitalized
  }
  @ViewBuilder private var content: some View {
    if message.isInternalActivity {
      DisclosureGroup(message.presentationOrigin?.title ?? "Activity details") { MarkdownView(text: message.text) }
    } else if message.isAgentExchange {
      AgentExchangeView(message: message, recipient: recipient)
    } else if let call = message.toolCall {
      ActionReceiptView(call: call)
    } else if message.isReply {
      MarkdownView(text: message.text)
    } else {
      Text(message.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}
struct StarterActionsView: View {
  var starters: [Starter]
  var add: (Starter) -> Void
  @Environment(AppStore.self) private var store
  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack { ForEach(starters) { item in Button(item.title) { add(item) }.buttonStyle(.bordered).disabled(!store.draftReady) } }
    }
  }
}
struct ActionReceiptView:View {
  var call:ToolCall
  private var result:[String:Any] { (call.result?.data(using:.utf8)).flatMap { try? JSONSerialization.jsonObject(with:$0) as? [String:Any] } ?? [:] }
  var label:String {
    if call.status=="failed" || result["success"] as? Bool == false || result["ok"] as? Bool == false || result["error"] != nil || (result["exit_code"] as? Int).map({$0 != 0}) == true { return "Tool failed" }
    if call.status=="running" { return "Action in progress" }
    return result["success"] as? Bool == true || result["ok"] as? Bool == true ? "Tool reported success" : "Tool finished"
  }
  var body:some View {
    DisclosureGroup("\(label) · \(call.name)") {
      Text("Outcome reported by the tool. Review its result to confirm what changed.").font(.caption).foregroundStyle(Palette.muted)
      ToolOutputView(text: call.error ?? call.result ?? "Hermes did not report an outcome.", label: "Result from \(call.name)").font(.footnote)
      ForEach(["url", "html_url", "web_url", "link"], id: \.self) { key in
        if let value = result[key] as? String, let url = URL(string: value), ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
          Link("Open reported result", destination: url)
        }
      }
    }.padding(12).background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
  }
}
