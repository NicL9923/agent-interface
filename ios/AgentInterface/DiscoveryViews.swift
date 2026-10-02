import SwiftUI

struct SearchHit: Decodable, Identifiable {
  var botId: String; var botName: String; var sessionId: String; var title: String; var snippet: String; var routineId: String?; var resultId: String?
  var id: String { botId + ":" + sessionId }
}
struct SearchResponse: Decodable { var hits: [SearchHit]; var unavailableBots: [String] }
struct HistoryPage: Decodable { var botId: String; var sessionId: String; var messages: [Message]; var offset: Int; var hasMore: Bool }
struct SavedItem: Codable, Identifiable { var id: String; var botId: String; var kind: String; var sessionId: String?; var routineId: String?; var resultId: String?; var messageId: String?; var offset: Int?; var title: String; var createdAt: String }
struct SavedPointer: Encodable { var botId: String; var kind: String; var sessionId: String?; var routineId: String?; var resultId: String?; var messageId: String?; var offset: Int?; var title: String }
struct UsageSummary: Decodable { var botId: String; var sessions: Int; var inputTokens: Int; var outputTokens: Int; var actualCost: Double?; var estimatedCost: Double?; var partial: Bool }
struct AutomationOverview: Decodable { var routines: [Routine]; var usage: [UsageSummary]; var unavailableBots: [String] }
struct Starter: Decodable, Identifiable { var id: String; var title: String; var prompt: String }
struct DiscoveryView: View {
  @EnvironmentObject private var store: AppStore
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
  var body: some View {
    List {
      Section { Picker("View", selection:$tab) { Text("Search").tag("search"); Text("Saved").tag("saved"); Text("Automations").tag("automations") }.pickerStyle(.segmented) }
      if let error { Section { ErrorBanner(message:error) } }
      if let notice { Section { Text(notice) } }
      if busy { ProgressView() }
      if let page {
        Section("Conversation history") {
          Button("Back to results") { self.page = nil }
          Text("Read from Hermes without changing the active conversation.").font(.footnote).foregroundStyle(.secondary)
          Button("Save conversation") { Task { await perform { api in
            let _: SavedItem = try await api.write("/saved",SavedPointer(botId:page.botId,kind:"session",sessionId:page.sessionId,title:"Saved conversation")); notice = "Saved."
          } } }
          ForEach(page.messages) { message in VStack(alignment:.leading,spacing:8) { if message.role=="assistant" { Button("Save reply") { Task { await perform { api in let _:SavedItem=try await api.write("/saved",SavedPointer(botId:page.botId,kind:"session",sessionId:page.sessionId,messageId:message.id,offset:page.offset,title:String(message.text.prefix(120))));notice="Saved." } } } };Text(message.role.capitalized).font(.caption).foregroundStyle(.secondary); if let call=message.toolCall { ActionReceiptView(call:call) } else { MarkdownView(text:message.text) }; ForEach(message.files ?? []) { file in FileAttachmentView(file:file) } } }
          HStack { Button("Previous") { Task { await history(page.botId,page.sessionId,max(0,page.offset-100)) } }.disabled(page.offset==0); Spacer(); Button("Next") { Task { await history(page.botId,page.sessionId,page.offset+100) } }.disabled(!page.hasMore) }
        }
      } else if tab == "search" {
        Section {
          HStack {
            TextField("Search answers, files, or a topic",text:$query).submitLabel(.search).onSubmit { Task { await search() } }
            Button { Task { await search() } } label: { Image(systemName:"magnifyingglass") }.accessibilityLabel("Search").buttonStyle(.borderless)
              .disabled(query.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || busy).accessibilityIdentifier("nativeSearchSubmit")
          }
          ForEach(hits) { hit in Button { if let routine=hit.routineId { store.routineResult=RoutineResultDestination(botId:hit.botId,routineId:routine,resultId:hit.resultId) } else { Task { await history(hit.botId,hit.sessionId) } } } label: { VStack(alignment:.leading,spacing:4) { Text(hit.title).font(.headline);Text(hit.botName).font(.caption);Text(hit.snippet.replacingOccurrences(of:"<[^>]*>",with:"",options:.regularExpression)).lineLimit(4).font(.footnote) } }.accessibilityIdentifier("nativeSearchResult-" + hit.sessionId) }
        } footer: { Text("Searches answers, attachment names and routine previews across your assistants.") }
      } else if tab == "saved" {
        Section {
          if saved.isEmpty { Text("Save a conversation from search or an output from routine results.").foregroundStyle(.secondary) }
          ForEach(saved) { item in
            Button(item.title) { if let session = item.sessionId { Task { await history(item.botId,session,item.offset ?? 0,item.messageId) } } else if let routineId = item.routineId { store.routineResult = RoutineResultDestination(botId:item.botId,routineId:routineId,resultId:item.resultId) } }
            .swipeActions { Button("Remove",role:.destructive) { Task { await perform { api in let _: EmptyResponse = try await api.write("/saved/\(APIClient.component(item.id))",[String:String](),method:"DELETE");saved.removeAll { $0.id == item.id } } } } }
          }
        } footer: { Text("Original content may be unavailable if deleted in Hermes.") }
      } else {
        Section("Routines") {
          if overview?.routines.isEmpty == true { Text("No routines yet. Create one in assistant settings.") }
          ForEach(overview?.routines ?? []) { row in
            VStack(alignment:.leading,spacing:6) {
              Text(row.name).font(.headline)
              Text("\(name(row.botId)) · \(row.enabled ? "Enabled" : "Paused")").font(.subheadline)
              if row.enabled, let next = row.nextRunAt.flatMap(ServerDate.parse) { Text("Next: \(next.formatted())").font(.footnote) }
              if let status = row.lastStatus { Text("Last result: \(status)").font(.footnote) }
              if let failure = row.lastError ?? row.lastDeliveryError { Text(failure).foregroundStyle(Palette.danger).font(.footnote) }
              Text("Notify: \((row.recipientIds ?? []).compactMap { id in store.bootstrap?.household.first { $0.id == id }?.name }.joined(separator:", "))").font(.footnote)
              HStack {
                Button("View outputs") { store.routineResult = RoutineResultDestination(botId:row.botId,routineId:row.id) }
                Button(row.enabled ? "Pause" : "Resume") { Task { await perform { api in let _:EmptyResponse = try await api.write("/routines/\(APIClient.component(row.id))/state",["enabled":!row.enabled],method:"PATCH"); overview = try await api.get("/automations") } } }
              }.buttonStyle(.bordered)
            }
          }
        }
        Section {
          ForEach(overview?.usage ?? [],id:\.botId) { usage in
            VStack(alignment:.leading,spacing:4) { Text(name(usage.botId)).font(.headline);Text("\(usage.sessions) sessions · \(usage.inputTokens) input / \(usage.outputTokens) output tokens");Text("Reported: \(cost(usage.actualCost))\(usage.partial && usage.actualCost != nil ? " (partial)" : "") · Estimate: \(cost(usage.estimatedCost))") }.font(.footnote)
          }
          if let overview, !overview.unavailableBots.isEmpty { Text("Usage unavailable for \(overview.unavailableBots.count) assistant(s).") }
        } header: { Text("Usage over 30 days") } footer: { Text("Recorded main-session usage. Auxiliary calls and provider invoices may differ.") }
      }
    }.householdListBackground().navigationTitle("Search & saved").disabled(busy)
      .onAppear { Task { await load() } }.onChange(of:tab) { _,_ in page=nil;Task { await load() } }
      .onChange(of:store.scope) { _,_ in loadId=UUID();hits=[];saved=[];overview=nil;page=nil;error=nil;Task { await load() } }
      .refreshable { await load() }
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
  private func search() async { await perform { api in let result:SearchResponse=try await api.get("/search?q=\(query.addingPercentEncoding(withAllowedCharacters:.alphanumerics) ?? "")");hits=result.hits;notice=result.unavailableBots.isEmpty ? (hits.isEmpty ? "No matching conversations." : nil) : "Some assistants could not be searched." } }
  private func history(_ bot:String,_ session:String,_ offset:Int=0,_ messageId:String?=nil) async { await perform { api in let result:HistoryPage=try await api.get("/bots/\(APIClient.component(bot))/history/\(APIClient.component(session))?offset=\(offset)");if let messageId,!result.messages.contains(where:{$0.id==messageId}) { throw APIError(message:"The saved reply is unavailable. Its original history changed in Hermes.",status:404) };page=result } }
}
struct StarterActionsView: View {
  var starters: [Starter]
  var add: (Starter) -> Void
  @EnvironmentObject private var store: AppStore
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
  var body:some View { DisclosureGroup("\(label) · \(call.name)") { Text("Outcome reported by the tool. Review its result to confirm what changed.").font(.caption).foregroundStyle(.secondary);Text(String((call.error ?? call.result ?? "Hermes did not report an outcome.").prefix(4000))).font(.footnote).textSelection(.enabled);ForEach(["url","html_url","web_url","link"],id:\.self) { key in if let value=result[key] as? String,let url=URL(string:value),["https","http"].contains(url.scheme?.lowercased() ?? "") { Link("Open reported result",destination:url) } } }.padding(12).background(.quaternary,in:RoundedRectangle(cornerRadius:12)) }
}
