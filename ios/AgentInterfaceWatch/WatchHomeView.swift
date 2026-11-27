import SwiftUI

/// Apple Watch companion home: shows who needs you, who is working, one-tap Review / Decline / Stop
/// actions, and quick wrist dictation to queue a draft to a pinned assistant on iPhone.
struct WatchHomeView: View {
  var session: WatchSessionManager
  var body: some View {
    NavigationStack {
      Group {
        if let snapshot = session.snapshot, !snapshot.assistants.isEmpty {
          List {
            if let status = session.statusMessage {
              Section {
                Text(status).font(.footnote).foregroundStyle(.secondary)
              }
            }
            let ordered = snapshot.ordered
            let attention = ordered.filter(\.needsAttention)
            let working = ordered.filter(\.isWorking)
            let pinned = ordered.filter { $0.pinned && !$0.needsAttention && !$0.isWorking }
            if !attention.isEmpty {
              Section("Needs you") {
                ForEach(attention) { assistantRow($0, snapshot: snapshot) }
              }
            }
            if !working.isEmpty {
              Section("Working") {
                ForEach(working) { assistantRow($0, snapshot: snapshot) }
              }
            }
            if !pinned.isEmpty {
              Section("Pinned") {
                ForEach(pinned) { pinnedRow($0) }
              }
            }
            if attention.isEmpty && working.isEmpty && pinned.isEmpty {
              Section {
                Label("All caught up", systemImage: "checkmark.circle.fill")
                  .foregroundStyle(.green)
                ForEach(ordered.prefix(4)) { pinnedRow($0) }
              }
            }
            Section {
              Button {
                session.refresh()
              } label: {
                Label(session.busy ? "Refreshing…" : "Refresh", systemImage: "arrow.clockwise")
              }
              .disabled(session.busy)
              Text("Updated \(snapshot.generatedAt, style: .relative) ago")
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
          }
        } else {
          VStack(spacing: 10) {
            Image(systemName: "bubble.left.and.bubble.right")
              .font(.title2)
              .foregroundStyle(.teal)
            Text("Open WildBots on iPhone")
              .font(.headline)
              .multilineTextAlignment(.center)
            Text("Sign in on iPhone to see assistants and queue drafts from your wrist.")
              .font(.caption2)
              .foregroundStyle(.secondary)
              .multilineTextAlignment(.center)
          }
          .padding()
        }
      }
      .navigationTitle("WildBots")
    }
  }

  private func assistantRow(_ assistant: WidgetSnapshot.Assistant, snapshot: WidgetSnapshot) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(assistant.name).font(.headline).lineLimit(1)
        Spacer()
        if let status = assistant.status {
          Text(status).font(.caption2).foregroundStyle(assistant.needsAttention ? .orange : .blue)
        }
      }
      if let preview = assistant.lastMessage, !preview.isEmpty {
        Text(preview).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
      }
      if assistant.needsAttention {
        HStack(spacing: 6) {
          Button("Review") { session.review(assistant) }
            .buttonStyle(.borderedProminent)
            .tint(.teal)
          if let approvalId = assistant.approvalId, !approvalId.isEmpty {
            Button("Decline", role: .destructive) { session.decline(assistant, approvalId: approvalId) }
              .buttonStyle(.bordered)
          }
        }
        .font(.caption2)
      } else if assistant.isWorking, let runId = assistant.runId, !runId.isEmpty {
        Button("Stop", role: .destructive) { session.stop(assistant, runId: runId) }
          .buttonStyle(.bordered)
          .font(.caption2)
      }
    }
    .padding(.vertical, 2)
  }

  private func pinnedRow(_ assistant: WidgetSnapshot.Assistant) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(assistant.name).font(.headline).lineLimit(1)
      TextFieldLink(prompt: Text("Draft for \(assistant.name)")) {
        Label("Dictate draft", systemImage: "mic.fill")
          .font(.caption2)
      } onSubmit: { text in
        session.queueDraft(to: assistant, text: text)
      }
    }
    .padding(.vertical, 2)
  }
}
