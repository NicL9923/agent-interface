import AppKit
import SwiftUI
import WildBotsMacCore

enum ActivityText {
  static func verb(_ action: String) -> String {
    switch action {
    case "run": return "Ran"
    case "read_file": return "Read"
    case "write_file": return "Wrote"
    case "list_dir": return "Listed"
    case "screenshot": return "Took a screenshot of"
    default: return "Asked for"
    }
  }
  static func ability(_ ability: Ability) -> String {
    switch ability {
    case .filesRead: return "read files"
    case .filesWrite: return "write files"
    case .run: return "run commands"
    case .screenshot: return "take screenshots"
    }
  }
  static func status(_ status: LinkStatus, linked: Bool) -> String {
    switch status {
    case .linked: return "Connected"
    case .connecting: return "Connecting…"
    case .retrying(let at, let reason): return "\(reason) Retrying \(at.formatted(.relative(presentation: .numeric)))."
    case .stopped(let reason): return reason
    case .unlinked(let reason): return reason ?? (linked ? "Not connected" : "Not linked")
    }
  }
}

struct MenuContent: View {
  @Environment(AppModel.self) private var model
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    Text(ActivityText.status(model.status, linked: model.isLinked))
    if model.activeCount > 0 { Text("\(model.activeCount) action\(model.activeCount == 1 ? "" : "s") running") }
    Divider()
    if model.isLinked {
      Button(model.policy.paused ? "Resume assistants" : "Pause assistants") { model.setPaused(!model.policy.paused) }
        .keyboardShortcut("p")
    }
    Button("Open WildBots…") { open("link") }
    Button("Activity…") { open("activity") }
    Divider()
    Button("Quit WildBots") { NSApp.terminate(nil) }.keyboardShortcut("q")
  }

  private func open(_ section: String) {
    UserDefaults.standard.set(section, forKey: "section")
    openWindow(id: "main")
    NSApp.activate(ignoringOtherApps: true)
  }
}

struct MainView: View {
  @Environment(AppModel.self) private var model
  @AppStorage("section") private var section = "link"

  var body: some View {
    NavigationSplitView {
      List(selection: $section) {
        Label("Link", systemImage: "link").tag("link")
        Label("Folders", systemImage: "folder").tag("folders")
        Label("Assistants", systemImage: "person.2").tag("assistants")
        Label("Activity", systemImage: "list.bullet.rectangle").tag("activity")
        Label("Options", systemImage: "gearshape").tag("options")
      }
      .navigationSplitViewColumnWidth(min: 160, ideal: 180)
    } detail: {
      Group {
        switch section {
        case "folders": FoldersView()
        case "assistants": AssistantsView()
        case "activity": ActivityView()
        case "options": OptionsView()
        default: LinkView()
        }
      }
      .frame(minWidth: 480, minHeight: 420)
    }
    .alert(
      "WildBots", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } }),
      actions: { Button("OK") { model.error = nil } }, message: { Text(model.error ?? "") })
  }
}

struct LinkView: View {
  @Environment(AppModel.self) private var model
  @State private var confirmUnlink = false

  var body: some View {
    @Bindable var model = model
    Form {
      if let credential = model.credential {
        Section("This Mac") {
          LabeledContent("Linked as", value: credential.name)
          LabeledContent("Household", value: credential.server)
          LabeledContent("Status", value: ActivityText.status(model.status, linked: true))
          if model.policy.paused { Label("Assistants are paused.", systemImage: "pause.circle") }
        }
        Section {
          if case .stopped = model.status { Button("Reconnect") { model.reconnect() } }
          Button("Unlink this Mac…", role: .destructive) { confirmUnlink = true }
        } footer: {
          Text("Unlinking ends the connection and deletes this Mac's credential. Revoke it in WildBots Settings > Macs to remove it from the list there.")
        }
      } else {
        Section {
          TextField("Household address", text: $model.serverText, prompt: Text("https://agentui.example.com"))
          TextField("Name for this Mac", text: $model.macName)
          Button(model.linking ? "Linking…" : "Link this Mac") { Task { await model.linkThisMac() } }
            .disabled(model.linking || model.serverText.isEmpty)
        } header: {
          Text("Link this Mac")
        } footer: {
          Text("Sign in with your household Google account in the system browser. The Mac keeps its own credential in the Keychain and ends your sign-in once it is linked.")
        }
        if case .unlinked(let reason?) = model.status { Section { Label(reason, systemImage: "exclamationmark.triangle") } }
      }
    }
    .formStyle(.grouped)
    .navigationTitle("Link")
    .confirmationDialog("Unlink this Mac?", isPresented: $confirmUnlink) {
      Button("Unlink", role: .destructive) { Task { await model.unlink() } }
    } message: {
      Text("Running actions stop and assistants can no longer use this Mac. Your folders and assistant choices stay on this Mac.")
    }
  }
}

struct FoldersView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    Form {
      Section {
        ForEach(model.policy.folders) { folder in
          HStack {
            VStack(alignment: .leading) {
              Text(folder.name)
              Text(folder.path).font(.caption).foregroundStyle(.secondary)
              if let problem = model.folderErrors[folder.path] {
                Text(problem).font(.caption).foregroundStyle(.red)
              }
            }
            Spacer()
            if folder != model.policy.folders.first {
              Button("Make first") { model.moveFolderToTop(folder) }.help("Relative paths and commands start in the first folder.")
            }
            Button(role: .destructive) { model.removeFolder(folder) } label: { Image(systemName: "minus.circle") }
              .buttonStyle(.borderless).help("Remove")
          }
        }
        Button("Add folder…") { choose() }
      } header: {
        Text("Folders")
      } footer: {
        Text("Assistants can read and write only inside these folders. Commands start in the first one. Your home folder itself, ~/Library, /Applications and system folders cannot be added, and credential folders such as .ssh stay off limits inside them.")
      }
    }
    .formStyle(.grouped)
    .navigationTitle("Folders")
  }

  private func choose() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.prompt = "Share folder"
    if panel.runModal() == .OK, let url = panel.url { model.addFolder(url) }
  }
}

struct AssistantsView: View {
  @Environment(AppModel.self) private var model
  @State private var newId = ""
  @State private var newName = ""

  var body: some View {
    Form {
      ForEach(model.policy.grants) { grant in
        Section {
          ForEach(Ability.allCases, id: \.self) { ability in
            Toggle(label(ability), isOn: Binding(
              get: { grant.abilities.contains(ability) },
              set: { model.setAbility(ability, $0, for: grant.assistantId) }))
          }
          Toggle("Also when unattended", isOn: Binding(get: { grant.unattended }, set: { model.setUnattended($0, for: grant.assistantId) }))
            .help("Allow these in scheduled and messaging runs, when nobody is in a WildBots chat with the assistant.")
          Button("Remove \(grant.assistantName)", role: .destructive) { model.removeAssistant(grant.assistantId) }
        } header: {
          Text("\(grant.assistantName) (\(grant.assistantId))")
        }
      }
      Section {
        let offered = model.policy.knownAssistants.filter { model.policy.grant(for: $0.id) == nil }
        ForEach(offered) { assistant in
          HStack {
            Text(assistant.name)
            Spacer()
            Button("Add") { model.addAssistant(id: assistant.id, name: assistant.name) }
          }
        }
        TextField("Assistant ID", text: $newId, prompt: Text("patch"))
        TextField("Name", text: $newName, prompt: Text("Patch"))
        Button("Add assistant") {
          model.addAssistant(id: newId, name: newName)
          newId = ""
          newName = ""
        }.disabled(newId.trimmingCharacters(in: .whitespaces).isEmpty)
      } header: {
        Text("Add an assistant")
      } footer: {
        Text("Only your own personal assistants can use this Mac, and nothing is allowed until you switch it on. An assistant that asks without permission appears in Activity with an Allow button.")
      }
    }
    .formStyle(.grouped)
    .navigationTitle("Assistants")
  }

  private func label(_ ability: Ability) -> String {
    switch ability {
    case .filesRead: return "Files: read and list"
    case .filesWrite: return "Write files"
    case .run: return "Run commands"
    case .screenshot: return "Screenshot"
    }
  }
}

struct ActivityView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    List {
      if model.activity.isEmpty { Text("Nothing yet.").foregroundStyle(.secondary) }
      ForEach(model.activity) { entry in
        VStack(alignment: .leading, spacing: 2) {
          HStack {
            Text(entry.assistantName ?? entry.assistantId).bold()
            if entry.scheduled { Text("unattended").font(.caption).padding(.horizontal, 4).background(.quaternary, in: Capsule()) }
            Spacer()
            Text(entry.at.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary)
          }
          Text("\(ActivityText.verb(entry.action)) \(entry.detail)").lineLimit(3).textSelection(.enabled)
          HStack {
            Text(entry.outcome == "ok" ? (entry.note ?? "Done") : "\(entry.outcome): \(entry.note ?? "")")
              .font(.caption).foregroundStyle(entry.outcome == "ok" ? Color.secondary : Color.orange)
            if let ability = entry.allowSuggestion, !(model.policy.grant(for: entry.assistantId)?.abilities.contains(ability) ?? false) {
              Spacer()
              Button("Allow to \(ActivityText.ability(ability))") { model.allow(entry) }.controlSize(.small)
            }
          }
        }
        .padding(.vertical, 2)
      }
    }
    .navigationTitle("Activity")
    .toolbar { Button("Clear") { model.clearActivity() }.disabled(model.activity.isEmpty) }
  }
}

struct OptionsView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    Form {
      Section {
        Toggle(
          "Notify me when an assistant acts unattended",
          isOn: Binding(get: { model.notifyUnattended }, set: { model.setNotifyUnattended($0) }))
        Toggle("Keep this Mac awake while plugged in", isOn: Binding(get: { model.keepAwake }, set: { model.setKeepAwake($0) }))
        if model.keepAwake {
          Text(model.holdingAwake ? "Keeping this Mac awake now." : "Not holding the Mac awake: it needs to be linked, connected, not paused and on power.")
            .font(.caption).foregroundStyle(.secondary)
        }
        Toggle("Open at login", isOn: Binding(get: { model.launchAtLogin }, set: { model.setLaunchAtLogin($0) }))
      } footer: {
        Text("Staying awake cannot stop sleep when you close the lid without an external display, choose Sleep, or the battery runs low. A sleeping Mac is offline.")
      }
      Section("Screenshots") {
        LabeledContent("Screen Recording", value: model.screenPermission.rawValue.capitalized)
        if model.screenPermission != .granted { Button("Allow screen recording…") { model.requestScreenAccess() } }
        LabeledContent("Screen", value: model.screenLocked ? "Locked" : "Unlocked")
      }
    }
    .formStyle(.grouped)
    .navigationTitle("Options")
  }
}
