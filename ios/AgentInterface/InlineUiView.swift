import SwiftUI
import WebKit

struct InlineDocument: Decodable, Hashable {
  var version: Int
  var title: String
  var html: String
  static func parse(_ source: String) -> InlineDocument? {
    guard source.utf16.count <= 100_000, let data = source.data(using: .utf8),
      let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      Set(raw.keys) == ["version", "title", "html"],
      let doc = try? JSONDecoder().decode(Self.self, from: data), doc.version == 1,
      !doc.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      doc.title.utf16.count <= 200, !doc.html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { return nil }
    return doc
  }
}

struct InlineUiView: View {
  var document: InlineDocument
  @Environment(\.colorScheme) private var scheme
  @State private var height: CGFloat = 240
  @State private var generation = 0
  @State private var source = false
  @State private var failed = false
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if failed { Text("This view couldn't load. Try resetting it or inspect its source.").font(.caption) }
      InlineWebView(document: document, dark: scheme == .dark, height: $height, failed: $failed)
        .id(document).id(generation).frame(height: height)
      HStack {
        Text("\(document.title) · Generated view").font(.caption).foregroundStyle(.secondary)
        Spacer()
        Button("Reset view") { height = 240; failed = false; generation += 1 }.font(.caption)
      }
      DisclosureGroup("View source", isExpanded: $source) {
        ScrollView { Text(document.html).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 300)
      }.font(.caption)
    }
  }
}

private struct InlineWebView: UIViewRepresentable {
  var document: InlineDocument
  var dark: Bool
  @Binding var height: CGFloat
  @Binding var failed: Bool
  func makeCoordinator() -> Coordinator { Coordinator(self) }
  func makeUIView(context: Context) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.userContentController.add(context.coordinator, name: "size")
    let web = WKWebView(frame: .zero, configuration: config)
    web.allowsLinkPreview = false
    web.isOpaque = false; web.backgroundColor = .clear
    web.scrollView.backgroundColor = .clear
    web.navigationDelegate = context.coordinator
    web.loadHTMLString(page, baseURL: nil)
    return web
  }
  func updateUIView(_ web: WKWebView, context: Context) {
    context.coordinator.parent = self
    if context.coordinator.dark != dark {
      context.coordinator.dark = dark
      web.evaluateJavaScript("document.documentElement.style.colorScheme='\(dark ? "dark" : "light")';document.querySelector('iframe').contentWindow.postMessage({type:'theme',dark:\(dark)}, '*')")
    }
  }
  static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
    web.stopLoading(); web.configuration.userContentController.removeScriptMessageHandler(forName: "size")
  }
  private var page: String {
    let policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; frame-src 'none'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    let inner = """
    <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="\(policy)"><style>html{color-scheme:light;--background:#faf8f2;--foreground:#282c27;--muted-foreground:#697268;--card:#fffdf7;--border:#d9ded2;--primary:#246f59;--primary-foreground:#faf8f2;--radius:12px;color:var(--foreground);font:15px system-ui;background:transparent}html.dark{color-scheme:dark;--background:#1b211e;--foreground:#f1efdf;--muted-foreground:#a6b4a7;--card:#222c25;--border:#3a483d;--primary:#8bd2b2;--primary-foreground:#1b211e}body{margin:0;display:flow-root;overflow-wrap:anywhere}*{box-sizing:border-box}img,svg,canvas{max-width:100%}button,input,select,textarea{font:inherit}input,select,textarea{max-width:100%}</style><script>document.documentElement.classList.toggle('dark',\(dark));addEventListener('message',e=>{if(e.source===parent&&e.data?.type==='theme')document.documentElement.classList.toggle('dark',e.data.dark)});addEventListener('DOMContentLoaded',()=>{let last=0;new ResizeObserver(()=>{requestAnimationFrame(()=>{const h=Math.ceil(document.body.getBoundingClientRect().height);if(h!==last){last=h;parent.postMessage({height:h},'*')}})}).observe(document.body)})</script></head><body>\(document.html)</body></html>
    """
    let escaped = inner.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "<", with: "&lt;")
    return """
    <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="\(policy.replacingOccurrences(of: "frame-src 'none'", with: "frame-src about:"))"><style>html,body{margin:0;background:transparent;color-scheme:\(dark ? "dark" : "light")}iframe{width:100%;height:100vh;border:0;display:block}</style></head><body><iframe sandbox="allow-scripts" title="Interactive content" srcdoc="\(escaped)"></iframe><script>addEventListener('message',e=>{if(e.source===document.querySelector('iframe').contentWindow&&Number.isFinite(e.data?.height))webkit.messageHandlers.size.postMessage(e.data.height)})</script></body></html>
    """
  }
  final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    var parent: InlineWebView
    var dark: Bool
    init(_ parent: InlineWebView) { self.parent = parent; dark = parent.dark }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
      guard message.frameInfo.isMainFrame, let value = message.body as? Double, value.isFinite else { return }
      parent.height = CGFloat(min(1600, max(80, value)))
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
      // Only the initial local document and its sandboxed srcdoc may load.
      let url = action.request.url?.absoluteString ?? ""
      decisionHandler(action.navigationType == .other && ["about:blank", "about:srcdoc"].contains(url) ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { parent.failed = true }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { parent.failed = true }
  }
}
