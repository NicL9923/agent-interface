import XCTest
@testable import AgentInterface

/// Email drafts, forms and T3 Code thread launches read the same here as on the web; see
/// tests/reply-cards.test.ts, tests/t3-code.test.ts and tests/retry-id.test.ts.
final class ReplyActionCardsTests: XCTestCase {
  private func cards(_ cards: [[String: Any]]) -> [ReplyCard]? {
    let data = try! JSONSerialization.data(withJSONObject: ["version": 1, "cards": cards])
    return ReplyCards.parse("```agent-ui\n" + String(decoding: data, as: UTF8.self) + "\n```").first?.cards
  }
  private let draft: [String: Any] = ["id": "reply", "type": "email", "title": "Reply to Sam", "to": ["sam@example.com"], "cc": ["ann@example.com"],
    "subject": "Saturday", "body": "Hi Sam,\nSee you then."]
  private let fields: [[String: Any]] = [
    ["id": "city", "label": "Destination", "kind": "text", "required": true],
    ["id": "nights", "label": "Nights", "kind": "number", "value": 2],
    ["id": "when", "label": "Arrive", "kind": "date", "value": "2026-11-20"],
    ["id": "pace", "label": "Pace", "kind": "choice", "options": ["Relaxed", "Packed"], "value": "Relaxed"],
    ["id": "room", "label": "Room", "kind": "select", "options": ["King", "Twin"]],
    ["id": "extras", "label": "Extras", "kind": "multi", "options": ["Breakfast", "Parking"], "required": true],
    ["id": "pets", "label": "Bringing the dog", "kind": "toggle", "value": true],
    ["id": "notes", "label": "Notes", "kind": "textarea", "help": "Anything else"],
  ]
  private var form: [String: Any] { ["id": "trip", "type": "form", "title": "Trip details", "fields": fields] }
  private func field(_ change: [String: Any], at index: Int) -> [String: Any] {
    var copy = fields; copy[index].merge(change) { $1 }
    return ["id": "trip", "type": "form", "title": "Trip details", "fields": copy]
  }

  func testEmailDraftsOpenInMailOrGmailAndCopyAsTheWebDoes() throws {
    let card = try XCTUnwrap(cards([draft])?.first)
    XCTAssertEqual(EmailDraft.mailto(card)?.absoluteString, "mailto:sam@example.com?cc=ann@example.com&subject=Saturday&body=Hi%20Sam%2C%0D%0ASee%20you%20then.")
    let gmail = try XCTUnwrap(EmailDraft.gmail(card).flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) })
    XCTAssertEqual(Dictionary(uniqueKeysWithValues: (gmail.queryItems ?? []).map { ($0.name, $0.value ?? "") }),
      ["view": "cm", "fs": "1", "to": "sam@example.com", "cc": "ann@example.com", "su": "Saturday", "body": "Hi Sam,\nSee you then."])
    XCTAssertEqual(EmailDraft.text(card), "To: sam@example.com\nCc: ann@example.com\nSubject: Saturday\n\nHi Sam,\nSee you then.")
    let bare = try XCTUnwrap(cards([["id": "x", "type": "email", "title": "X", "body": "Just this & that? Café +1"]])?.first)
    XCTAssertEqual(EmailDraft.mailto(bare)?.absoluteString, "mailto:?body=Just%20this%20%26%20that%3F%20Caf%C3%A9%20%2B1")
    XCTAssertTrue(EmailDraft.gmail(bare)?.absoluteString.contains("%2B1") == true, "Gmail reads a bare + as a space")
    // Headers are trimmed as the web trims them.
    XCTAssertEqual(cards([draft.merging(["to": [" sam@example.com "], "subject": " Saturday "]) { $1 }])?.first?.to, ["sam@example.com"])
  }

  func testEmailDraftsKeepEveryMalformedDraftAsCode() {
    for change: [String: Any] in [["to": ["Sam <sam@example.com>"]], ["to": ["sam@example.com, ann@example.com"]], ["cc": ["sam@"]], ["to": []],
      ["to": (0..<21).map { "p\($0)@example.com" }], ["to": "sam@example.com"], ["body": "  \n "], ["body": String(repeating: "x", count: 20_001)],
      ["subject": " "], ["bcc": ["x@example.com"]]] {
      XCTAssertNil(cards([draft.merging(change) { $1 }]), "\(change)")
    }
  }

  func testFormsAcceptEveryFieldKindAndKeepAnInvalidOneAsCode() throws {
    let card = try XCTUnwrap(cards([form])?.first)
    XCTAssertEqual(card.fields?.map(\.kind), ["text", "number", "date", "choice", "select", "multi", "toggle", "textarea"])
    XCTAssertEqual(card.fields?[1].value, .text("2"))
    XCTAssertEqual(FormAnswers.start(card), ["city": .text(""), "nights": .text("2"), "when": .text("2026-11-20"), "pace": .text("Relaxed"),
      "room": .text(""), "extras": .list([]), "pets": .toggle(true), "notes": .text("")])
    let invalid: [([String: Any], Int)] = [
      (["kind": "slider"], 0), (["options": ["A"]], 0), (["options": "Relaxed, Packed"], 3), (["options": ["King", " King"]], 4),
      (["options": (0..<21).map { "o\($0)" }], 4), (["options": []], 4), (["options": ["King", "  "]], 4), (["options": ["King", String(repeating: "x", count: 201)]], 4),
      (["value": "Frantic"], 3), (["value": ["Spa"]], 5), (["value": ["Parking", "Parking"]], 5), (["value": "2026-02-30"], 2),
      (["value": "two"], 1), (["value": "0x10"], 1), (["value": "1."], 1), (["value": "Infinity"], 1), (["value": "1e309"], 1),
      (["value": "yes"], 6), (["required": "yes"], 0), (["label": " "], 0), (["id": "has space"], 0), (["max": 3], 1),
      (["help": String(repeating: "x", count: 501)], 7), (["placeholder": String(repeating: "x", count: 201)], 0),
    ]
    for (change, index) in invalid { XCTAssertNil(cards([field(change, at: index)]), "\(change)") }
    for value in ["0", "-2", "2.5", ".5", "1e3", "-1.5E-2"] { XCTAssertNotNil(cards([field(["value": value], at: 1)]), value) }
    XCTAssertNil(cards([["id": "trip", "type": "form", "title": "T", "fields": [["id": "pace", "label": "Pace", "kind": "choice"]]]]))
    XCTAssertNil(cards([["id": "trip", "type": "form", "title": "T", "fields": []]]))
    XCTAssertNil(cards([["id": "trip", "type": "form", "title": "T", "fields": [fields[0], fields[0]]]]))
    XCTAssertNil(cards([form.merging(["submitLabel": String(repeating: "x", count: 41)]) { $1 }]))
  }

  func testFormAnswersNameEachProblemAndReadAsTheWebWritesThem() throws {
    let card = try XCTUnwrap(cards([form])?.first)
    let start = FormAnswers.start(card)
    XCTAssertEqual(FormAnswers.problems(card, start), ["city": "This one needs an answer.", "extras": "Choose at least one."])
    var wrong = start; wrong["city"] = .text("Marfa"); wrong["extras"] = .list(["Parking"]); wrong["nights"] = .text("lots")
    wrong["when"] = .text("2026-13-01"); wrong["room"] = .text("Suite"); wrong["pets"] = .text("yes")
    XCTAssertEqual(FormAnswers.problems(card, wrong), ["nights": "Enter a number.", "when": "Enter a real date.", "room": "Choose one of the options.", "pets": "Turn this on or off."])
    var answers = start; answers["city"] = .text(" Marfa "); answers["extras"] = .list(["Breakfast", "Parking"]); answers["pets"] = .toggle(false)
    answers["notes"] = .text("Late check-in\nQuiet room")
    XCTAssertEqual(FormAnswers.text(card, answers), ["My answers to \"Trip details\":", "- Destination: Marfa", "- Nights: 2", "- Arrive: 2026-11-20", "- Pace: Relaxed",
      "- Extras: Breakfast, Parking", "- Bringing the dog: No", "- Notes:", "  Late check-in", "  Quiet room"].joined(separator: "\n"))
  }

  /// docs/native-api.md lists these vectors; the web checks the same ones.
  func testFormRequestIdsMatchTheWebsVectors() {
    XCTAssertEqual(FormAnswers.requestId(formKey: "k3y_A-b", botId: "ranch", messageId: "msg-42", cardId: "trip", attempt: 0), "1ab28536-230d-4777-84cf-8dcda31bb28c")
    XCTAssertEqual(FormAnswers.requestId(formKey: "k3y_A-b", botId: "ranch", messageId: "msg-42", cardId: "trip", attempt: 3), "76bbd8a5-8259-4c9e-8b2b-3b3fa7bec9d2")
    XCTAssertEqual(FormAnswers.requestId(formKey: "café", botId: "👋", messageId: "m", cardId: "c", attempt: 1), "f2ec6d4c-7663-410f-88ba-49c4a6921df8")
  }

  private let launchArgs = #"{"title":"Fix the gate sensor","message":"The north gate sensor reports open when it is shut.\nFind out why.","workspaceStrategy":{"type":"worktree","branch":"fix/gate-sensor"}}"#
  private let answer = #"{"threadId":"t-1","link":"https://app.t3.codes/threads/env-1/t-1","projectId":"p","modelSelection":{"provider":"claudeAgent","model":"claude-opus-5-5"},"runId":"r","status":"queued"}"#
  private func launch(_ status: String = "completed", name: String = "mcp_t3code_t3_thread_launch", result: String? = nil, error: String? = nil) -> ToolCall {
    let wrapped = String(decoding: try! JSONSerialization.data(withJSONObject: ["result": answer]), as: UTF8.self)
    return ToolCall(id: "c1", name: name, arguments: launchArgs, status: status, result: status == "completed" ? result ?? wrapped : nil, error: error)
  }

  func testT3ThreadLaunchesReadHermesWrappingAndOpenOnlyHostedLinks() throws {
    let thread = try XCTUnwrap(T3Thread.from(launch()))
    XCTAssertEqual(thread.state, .started)
    XCTAssertEqual(thread.title, "Fix the gate sensor")
    XCTAssertEqual(thread.prompt, "The north gate sensor reports open when it is shut. Find out why.")
    XCTAssertEqual(thread.model, "Claude Opus 5.5")
    XCTAssertEqual(thread.workspace, "New worktree on fix/gate-sensor")
    XCTAssertEqual(thread.url?.absoluteString, "https://app.t3.codes/threads/env-1/t-1")
    let both = String(decoding: try JSONSerialization.data(withJSONObject: ["result": "Started.", "structuredContent": try JSONSerialization.jsonObject(with: Data(answer.utf8))]), as: UTF8.self)
    XCTAssertEqual(T3Thread.from(launch(result: both))?.url?.absoluteString, "https://app.t3.codes/threads/env-1/t-1")
    XCTAssertEqual(T3Thread.from(launch("running"))?.state, .starting)
    XCTAssertNil(T3Thread.from(launch("running"))?.url)
    XCTAssertEqual(T3Thread.from(launch("failed", error: "Project not found"))?.error, "Project not found")
    XCTAssertEqual(T3Thread.from(launch(result: #"{"error":"Runtime mode exceeds this client's ceiling"}"#))?.error, "Runtime mode exceeds this client's ceiling")
    XCTAssertEqual(T3Thread.from(launch(result: #"{"result":"Done"}"#))?.error, "T3 Code didn't report the new thread.")
    for name in ["t3_thread_launcher", "mcp_t3code_t3_thread_launch_now", "t3_thread_list", "terminal"] { XCTAssertNil(T3Thread.from(launch(name: name)), name) }
    XCTAssertNotNil(T3Thread.from(launch(name: "mcp__t3-code__t3_thread_launch")))
    XCTAssertEqual(T3Thread.url("<t3-thread://v2/env-1/thread.1>")?.absoluteString, "https://app.t3.codes/threads/env-1/thread%2E1")
    XCTAssertEqual(T3Thread.url("t3-thread://v2/env%201/t(2)")?.absoluteString, "https://app.t3.codes/threads/env%201/t%282%29")
    XCTAssertEqual(T3Thread.url("https://t3.example.com/threads/env/thread")?.absoluteString, "https://t3.example.com/threads/env/thread")
    XCTAssertEqual(T3Thread.url("https://app.t3.codes/threads/env-1/thread%2E1")?.absoluteString, "https://app.t3.codes/threads/env-1/thread%2E1",
      "A hosted link keeps its escaped IDs")
    for link: Any in ["t3-thread://v1/thread_1", "http://app.t3.codes/threads/env/thread", "javascript:alert(1)//threads/a/b", "https://app.t3.codes/settings",
      "https://user:secret@app.t3.codes/threads/env/thread", "https://app.t3.codes/threads/env/thread/extra", 42] {
      XCTAssertNil(T3Thread.url(link), "\(link)")
    }
  }

  /// Where Swift's own string rules differ from JavaScript's, the cards follow JavaScript's.
  func testCardsMeasureTrimCompareAndWriteAsJavaScriptDoes() throws {
    // Explicit nulls are not absent fields, and only a number field may start with a JSON number.
    for change: [String: Any] in [["subject": NSNull()], ["to": NSNull()]] { XCTAssertNil(cards([draft.merging(change) { $1 }]), "\(change)") }
    for (change, index) in [(["required": NSNull()], 0), (["options": NSNull()], 0), (["value": NSNull()], 0), (["value": 42], 0)] as [([String: Any], Int)] {
      XCTAssertNil(cards([field(change, at: index)]), "\(change)")
    }
    // Lengths are UTF-16 units: 10,001 emoji are 20,002 of them.
    XCTAssertNil(cards([draft.merging(["body": String(repeating: "🐎", count: 10_001)]) { $1 }]))
    XCTAssertNotNil(cards([draft.merging(["body": String(repeating: "🐎", count: 10_000)]) { $1 }]))
    // A label is measured after trimming, and trimming takes JavaScript's spaces, U+FEFF among them.
    let padded = try XCTUnwrap(cards([field(["label": "\u{FEFF} Destination " + String(repeating: " ", count: 300)], at: 0)])?.first)
    XCTAssertEqual(padded.fields?.first?.label, "Destination")
    XCTAssertEqual(JS.trim("\u{85}Trip\u{85}"), "\u{85}Trip\u{85}", "JavaScript does not trim NEL")
    // Canonically equivalent options are still two different strings.
    let composed = "Caf\u{E9}", decomposed = "Cafe\u{301}"
    XCTAssertNotNil(cards([field(["options": [composed, decomposed]], at: 4)]))
    XCTAssertNil(cards([field(["options": [composed, "Twin"], "value": decomposed], at: 4)]))
    // A JSON number reads as JavaScript's String(number) writes it.
    for (value, text) in [(2.0, "2"), (2.5, "2.5"), (1e-7, "1e-7"), (0.000001, "0.000001"), (1.5e20, "150000000000000000000"), (1e21, "1e+21"), (-0.25, "-0.25")] {
      XCTAssertEqual(JS.number(value), text)
    }
    XCTAssertNil(cards([field(["value": "\u{0663}"], at: 1)]), "Arabic-Indic digits are not a number to JavaScript")
  }

  /// Two spellings of "Café" are two options on the web, so picking one never picks the other here.
  func testChoosingTellsCanonicallyEquivalentOptionsApart() {
    let composed = "Caf\u{E9}", decomposed = "Cafe\u{301}"
    XCTAssertNotEqual(FormValue.text(composed), FormValue.text(decomposed))
    XCTAssertNotEqual(FormValue.list([composed]), FormValue.list([decomposed]))
    XCTAssertEqual(FormAnswers.choose(composed, kind: "multi", from: []), .list([composed]))
    XCTAssertEqual(FormAnswers.choose(decomposed, kind: "multi", from: [composed]), .list([composed, decomposed]))
    XCTAssertEqual(FormAnswers.choose(composed, kind: "multi", from: [composed, decomposed]), .list([decomposed]))
    XCTAssertEqual(FormAnswers.choose(decomposed, kind: "choice", from: [composed]), .text(decomposed))
  }

  /// The web's `mayReplace` cases: a stale copy of a card never undoes another copy's progress.
  func testAStaleCopyOfAFormUndoesNoOtherCopysProgress() {
    func record(_ attempt: Int, _ state: String, _ requestId: String? = nil) -> SavedFormReply {
      SavedFormReply(attempt: attempt, answers: [:], state: state, requestId: requestId)
    }
    func elsewhere(_ record: SavedFormReply) -> SavedFormReply { var copy = record; copy.elsewhere = true; return copy }
    let cases: [(String, SavedFormReply?, SavedFormReply, Int?, String?, Bool)] = [
      ("nothing saved yet", nil, record(0, "editing"), nil, nil, true),
      ("a later attempt's record", record(1, "sent"), record(0, "sent"), nil, nil, false),
      ("moving on from the attempt saved", record(0, "checking", "a"), record(1, "editing"), 0, nil, true),
      ("moving on from an attempt another copy moved past", record(1, "sent"), record(1, "editing"), 0, nil, false),
      ("typing over a sent record of the same attempt", record(1, "sent"), record(1, "editing"), nil, nil, false),
      ("typing over another copy's request on its way", record(1, "checking", "a"), record(1, "editing"), nil, nil, false),
      ("typing over an interrupted record", record(1, "interrupted"), record(1, "editing"), nil, nil, false),
      ("sending again over a sent record", record(1, "sent"), record(1, "checking", "a"), nil, nil, false),
      ("the owner's request refused outright", record(1, "checking", "a"), record(1, "editing"), nil, "a", true),
      ("another request's refusal", record(1, "checking", "a"), record(1, "editing"), nil, "b", false),
      ("sending from editing", record(1, "editing"), record(1, "checking", "a"), nil, nil, true),
      ("a request settling as sent", record(1, "checking", "a"), record(1, "sent"), nil, nil, true),
      ("only knowing the answers went, over a record that holds them", record(1, "sent"), elsewhere(record(1, "sent")), nil, nil, false),
      ("the answers that went, over a record that only knows they went", elsewhere(record(1, "sent")), record(1, "sent"), nil, nil, true),
      ("a restart, which only ever follows acceptance, over a sent record", record(1, "sent"), elsewhere(record(1, "interrupted")), nil, nil, true),
      ("a stale acceptance over a restart", record(1, "interrupted"), record(1, "sent"), nil, nil, false),
    ]
    for (name, stored, next, from, owns, allowed) in cases {
      XCTAssertEqual(FormRecords.mayReplace(stored, with: next, from: from, owns: owns), allowed, name)
    }
    // Learning of a restart from another copy's request keeps the answers that copy saw admitted.
    let known = SavedFormReply(attempt: 1, answers: ["city": .text("Austin")], state: "sent")
    let restart = SavedFormReply(attempt: 1, answers: ["city": .text("")], state: "interrupted", elsewhere: true)
    XCTAssertEqual(FormRecords.keepingKnownAnswers(known, restart), SavedFormReply(attempt: 1, answers: ["city": .text("Austin")], state: "interrupted"))
    var checking = known; checking.state = "checking"
    var otherAttempt = known; otherAttempt.attempt = 0
    for stored in [checking, otherAttempt, elsewhere(known)] { XCTAssertEqual(FormRecords.keepingKnownAnswers(stored, restart), restart) }
    // Whichever arrives first, the admitted answers and the later status end up in one record.
    let interruptedKnown = SavedFormReply(attempt: 1, answers: ["city": .text("Austin")], state: "interrupted")
    XCTAssertEqual(FormRecords.nextRecord(restart, known), interruptedKnown)
    XCTAssertEqual(FormRecords.nextRecord(known, restart), interruptedKnown)
    XCTAssertNil(FormRecords.nextRecord(restart, checking))
    XCTAssertNil(FormRecords.nextRecord(restart, elsewhere(known)))
  }

  func testAnswerTextSplitsAndTrimsAsTheWebDoes() throws {
    let card = try XCTUnwrap(cards([["id": "f", "type": "form", "title": "  Trip  ", "fields": [["id": "a", "label": "A", "kind": "textarea"]]]])?.first)
    XCTAssertEqual(FormAnswers.text(card, ["a": .text("one\r\ntwo")]), "My answers to \"Trip\":\n- A:\n  one\n  two")
    XCTAssertEqual(FormAnswers.text(card, ["a": .text("one\rtwo")]), "My answers to \"Trip\":\n- A: one\rtwo", "Without a line feed it stays on one line")
    XCTAssertEqual(FormAnswers.text(card, ["a": .text("\u{FEFF}Marfa\u{2028}")]), "My answers to \"Trip\":\n- A: Marfa")
  }

  func testModelNamesMatchTheWebsFormatter() {
    for (slug, name) in [("claude-opus-5-5", "Claude Opus 5.5"), ("gpt-6.1-terra", "GPT-6.1-Terra"), ("anthropic/claude-sonnet-5-5", "anthropic/Claude Sonnet 5.5"),
      ("grok-4-7", "Grok 4 7"), ("my-custom-model", "my-custom-model")] {
      XCTAssertEqual(ModelNames.format(slug), name, slug)
    }
  }
}
