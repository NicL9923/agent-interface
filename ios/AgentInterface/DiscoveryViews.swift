import SwiftUI

struct SearchHit: Decodable, Identifiable {
  var botId: String; var botName: String; var sessionId: String; var title: String; var snippet: String; var routineId: String?; var resultId: String?; var messageId: String?; var offset: Int?
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
      _tab = State(initialValue: captureTab)
      if captureTab == "search" { _query = State(initialValue: "dinner") }
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
      if let error { Section { ErrorBanner(message:error) } }
      if let notice { Section { Text(notice) } }
      if busy { ProgressView() }
      if let page {
        Section("Conversation history") {
          Button { self.page = nil; historyRequest = nil } label: { Label("Back to results", systemImage: "chevron.left") }
          Text("Read from Hermes. This view does not change the assistant’s active conversation.").font(.footnote).foregroundStyle(.secondary)
          Button("Save conversation") { Task { await perform { api in
            let _: SavedItem = try await api.write("/saved",SavedPointer(botId:page.botId,kind:"session",sessionId:page.sessionId,title:Self.conversationTitle(hits,page.sessionId))); notice = Self.savedNotice
          } } }.disabled(busy)
          ForEach(page.messages) { message in
            HistoryMessageRow(message: message, recipient: name(page.botId), saved: savedMessage == message.id,
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
          ForEach(hits) { hit in Button { open(hit) } label: { HStack(spacing:12) { VStack(alignment:.leading,spacing:4) { Text(hit.title).font(.headline).foregroundStyle(Color.primary);Text(hit.botName).font(.caption).foregroundStyle(Palette.muted);Text(String(hit.snippet.replacingOccurrences(of:"<[^>]*>",with:"",options:.regularExpression).prefix(300))).lineLimit(4).font(.footnote).foregroundStyle(Palette.muted) }.frame(maxWidth:.infinity,alignment:.leading);Image(systemName:"chevron.right").font(.caption).foregroundStyle(.secondary) } }.accessibilityIdentifier("nativeSearchResult-" + hit.sessionId) }
        } footer: { Text("Searches answers, attachment names and routine previews across your assistants.") }
      } else if tab == "saved" {
        Section {
          if saved.isEmpty { Text("No saved items yet. Save a conversation from search or an output from routine results.").foregroundStyle(.secondary) }
          ForEach(saved) { item in
            HStack(spacing:12) {
              Button { if let session = item.sessionId { Task { await history(item.botId,session,item.offset ?? 0,item.messageId) } } else if let routineId = item.routineId { store.routineResult = RoutineResultDestination(botId:item.botId,routineId:routineId,resultId:item.resultId) } } label: {
                VStack(alignment:.leading,spacing:4) { Text(item.title).font(.headline).foregroundStyle(Color.primary);Text("\(name(item.botId)) · \(item.kind == "routine" ? "Routine output" : "Conversation")").font(.caption).foregroundStyle(Palette.muted) }.frame(maxWidth:.infinity,alignment:.leading)
              }.buttonStyle(.borderless).accessibilityIdentifier("savedItem-" + item.id)
              Button("Remove") { Task { await perform { api in let _: EmptyResponse = try await api.write("/saved/\(APIClient.component(item.id))",[String:String](),method:"DELETE");saved.removeAll { $0.id == item.id } } } }
                .buttonStyle(.bordered).controlSize(.small).accessibilityLabel("Remove \(item.title)")
            }
          }
        } header: { Text("Links to original conversations and routine outputs. Removed originals may be unavailable.").textCase(nil).font(.footnote) }
      } else {
        Section {
          HStack(alignment:.top,spacing:12) {
            Text("Upcoming work, recent failures and who receives results.").font(.footnote).foregroundStyle(.secondary).frame(maxWidth:.infinity,alignment:.leading)
            Button("Refresh") { Task { await perform { api in overview = try await api.get("/automations") } } }.buttonStyle(.bordered).controlSize(.small).disabled(busy).accessibilityIdentifier("refreshAutomations")
          }
          if overview?.routines.isEmpty == true { Text("No routines yet. Create one in assistant settings.") }
          ForEach(overview?.routines ?? []) { row in
            VStack(alignment:.leading,spacing:6) {
              Text(row.name).font(.headline)
              Text("\(name(row.botId)) · \(row.enabled ? "Enabled" : "Paused")").font(.subheadline)
              Text((row.enabled && row.nextRunAt != nil ? "Next: \(When.format(row.nextRunAt!))" : "No upcoming run reported") + (row.lastStatus.map { " · Last result: \($0)" } ?? "")).font(.footnote)
              if let failure = row.lastError ?? row.lastDeliveryError { Text(failure).foregroundStyle(Palette.danger).font(.footnote) }
              Text("Notify: \(notifyNames(row))").font(.footnote)
              HStack {
                Button("View outputs") { store.routineResult = RoutineResultDestination(botId:row.botId,routineId:row.id) }
                Button(row.enabled ? "Pause" : "Resume") { Task { await perform { api in let _:EmptyResponse = try await api.write("/routines/\(APIClient.component(row.id))/state",["enabled":!row.enabled],method:"PATCH"); overview = try await api.get("/automations") } } }.disabled(busy)
              }.buttonStyle(.bordered)
            }
          }
        }
        Section {
          ForEach(overview?.usage ?? [],id:\.botId) { usage in
            VStack(alignment:.leading,spacing:4) { Text(name(usage.botId)).font(.headline);Text("\(usage.sessions) sessions · \(usage.inputTokens.formatted()) input / \(usage.outputTokens.formatted()) output tokens");Text("Reported cost: \(cost(usage.actualCost))\(usage.partial && usage.actualCost != nil ? " (partial)" : "") · Estimate: \(cost(usage.estimatedCost))") }.font(.footnote)
          }
          if let overview, !overview.unavailableBots.isEmpty { Text("Usage unavailable for \(overview.unavailableBots.count) assistant(s).") }
        } header: { Text("Usage over 30 days") } footer: { Text("Recorded main-session usage. Estimates and provider invoices may differ. Auxiliary calls are not included.") }
      }
    }.householdListBackground().viewHeader("Search & saved", "Past answers, saved items and automations")
      .onAppear { Task { await load() } }.onChange(of:tab) { _,_ in page=nil;historyRequest=nil;Task { await load() } }
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
      .onChange(of:store.scope) { _,_ in loadId=UUID();hits=[];saved=[];overview=nil;page=nil;error=nil;Task { await load() } }
      .refreshable { await load() }
  }
  /// The web's search box `maxLength`; the query sent is the trimmed text.
  static let queryLimit = 200
  static func clip(_ value:String)->String { value.count > queryLimit ? String(value.prefix(queryLimit)) : value }
  static func trimmed(_ value:String)->String { value.trimmingCharacters(in:.whitespacesAndNewlines) }
  private static let savedNotice = "Saved. Find it in Saved items."
  private func saveReply(_ message: Message, _ page: HistoryPage) {
    Task { await perform { api in
      let _: SavedItem = try await api.write("/saved", SavedPointer(botId: page.botId, kind: "session", sessionId: page.sessionId, messageId: message.id, offset: page.offset, title: Self.replyTitle(message.text)))
      notice = Self.savedNotice
    } }
  }
  /// A saved conversation keeps the title its search hit showed.
  static func conversationTitle(_ hits:[SearchHit],_ sessionId:String)->String {
    let title = String((hits.first { $0.sessionId == sessionId }?.title ?? "").prefix(120))
    return title.isEmpty ? "Saved conversation" : title
  }
  static func replyTitle(_ text:String)->String {
    let title = String(text.replacingOccurrences(of:"[#*_`]",with:" ",options:.regularExpression).trimmingCharacters(in:.whitespacesAndNewlines).prefix(120))
    return title.isEmpty ? "Saved reply" : title
  }
  private func notifyNames(_ row:Routine)->String {
    let names = (row.recipientIds ?? []).map { id in store.bootstrap?.household.first { $0.id == id }?.name ?? "Household member" }
    return names.isEmpty ? "No routine recipients selected" : names.joined(separator:", ")
  }
  private func name(_ id:String)->String { store.bootstrap?.bots.first { $0.id == id }?.name ?? "Assistant" }
  private func cost(_ value:Double?)->String { value.map { String(format:"$%.2f",$0) } ?? "Unknown" }
  private func perform(_ action:(APIClient)async throws->Void) async {
    guard let api=store.api else { return };let scope=store.scope;let request=UUID();loadId=request;busy=true;error=nil;notice=nil
    defer { if scope==store.scope && request==loadId { busy=false } }
    do { try await action(api) } catch { if scope==store.scope && request==loadId { self.error=error.localizedDescription } }
    if scope != store.scope { hits=[];saved=[];overview=nil;page=nil;notice=nil }
  }
  private func load() async { await perform { api in if tab=="saved" { saved=try await api.get("/saved") };if tab=="automations" { overview=try await api.get("/automations") } } }
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
      Task { await history(hit.botId, hit.sessionId, hit.offset ?? 0, hit.messageId, searchHit: true) }
    }
  }
  /// The message to open in the live conversation, when the hit is in its assistant's current session.
  static func liveMessage(_ hit: SearchHit, bots: [Bot]) -> String? {
    guard hit.routineId == nil, let messageId = hit.messageId,
      let session = bots.first(where: { $0.id == hit.botId })?.sessionId, session == hit.sessionId else { return nil }
    return messageId
  }
  private func history(_ bot:String,_ session:String,_ offset:Int=0,_ messageId:String?=nil,searchHit:Bool=false) async {
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
      savedMessage=messageId;page=result;if messageId != nil { scrollRequest=UUID() }
    }
  }
}
/// A message in a history page, as the web's DiscoveryPanel shows it: activity folded away, an
/// agent exchange as its card, a tool call as its receipt, and a person's text as plain text.
struct HistoryMessageRow: View {
  var message: Message
  var recipient: String
  var saved: Bool
  var save: (() -> Void)?
  var busy = false
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Text(label).font(.caption).foregroundStyle(.secondary)
        if let save { Button("Save reply", action: save).font(.caption).buttonStyle(.borderless).disabled(busy) }
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
  private var label: String {
    message.presentationOrigin?.kind == "scheduled" ? "Scheduled" : message.isInternalActivity ? "Activity" : message.role.capitalized
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
      Text("Outcome reported by the tool. Review its result to confirm what changed.").font(.caption).foregroundStyle(.secondary)
      ToolOutputView(text: call.error ?? call.result ?? "Hermes did not report an outcome.", label: "Result from \(call.name)").font(.footnote)
      ForEach(["url", "html_url", "web_url", "link"], id: \.self) { key in
        if let value = result[key] as? String, let url = URL(string: value), ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
          Link("Open reported result", destination: url)
        }
      }
    }.padding(12).background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
  }
}
