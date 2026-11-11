import Foundation

/// A message this person sent and Hermes accepted, kept after its echo leaves. A steer and a send
/// Hermes queued or redirected are saved without the sender, so once the echo is gone the row would
/// otherwise read as another member's. It lives in memory with the session that sent it, so it ends
/// with the account, and a chat keeps its newest `SentEcho.ownSendsKept`. The anchor keeps an older row
/// with the same words from matching, so a send without one (restored after a relaunch, before the
/// chat was read) claims only a row Hermes named for it. A record ends with its echo when the echo
/// leaves with its copy not shown (see `nextSends`), as for a send Hermes never saved under its own
/// words, such as a steer joined with another into one row. Equal words cannot tell two rows apart,
/// so the label is a hint, not a binding. Ported from the web's src/app/sent-echo.ts.
struct OwnSend: Equatable {
  var requestId: String
  var messageId: String?
  var botId: String
  var senderId: String
  var text: String
  var after: String?
}

extension Bot {
  /// A private assistant has one member who can write in its chat. Any other chat could hold
  /// another member's words, as on the web's `isPrivateAssistant`.
  var othersCanWrite: Bool { !(!shared && ownerId != nil) }
}

extension SentEcho {
  /// How many of a chat's own sends are remembered.
  static let ownSendsKept = 20
  /// What a person who cannot be told from a no-sender row is called: it could be any member's.
  static let unknownSender = "Household member"

  /// The index of Hermes's copy of a message in the conversation, or nil. Hermes names a staged
  /// prompt by its request ID. Other rows, such as image-only prompts, are matched by their words
  /// after the message that was last when it was sent; empty `text` matches no words. A row another
  /// member sent is never the copy, and `skipping` holds rows already claimed.
  static func copyIndex(requestId: String, messageId: String?, text: String, after: String?, senderId: String,
    in messages: [Message], skipping: Set<String> = []) -> Int?
  {
    if let named = messages.firstIndex(where: { ($0.id == requestId || $0.id == messageId) && !skipping.contains($0.id) }) { return named }
    let words = trimmed(text)
    guard !words.isEmpty else { return nil }
    var start = 0
    if let after {
      // Without its anchor, an older message with the same words could pass for this one.
      guard let anchor = messages.firstIndex(where: { $0.id == after }) else { return nil }
      start = anchor + 1
    }
    return messages[start...].firstIndex {
      $0.role == "user" && trimmed($0.text) == words && !skipping.contains($0.id) && ($0.sender == nil || $0.sender?.id == senderId)
    }
  }

  /// The saved rows that are this person's own sends, by the match the echo makes. Each send claims one
  /// row, the first that fits after its anchor, so another member's later message with the same words,
  /// which has no send of the person's behind it, stays unclaimed.
  static func ownRows(_ sends: [OwnSend], in conversation: Conversation?) -> Set<String> {
    var claimed = Set<String>()
    guard let conversation else { return claimed }
    for send in sends where send.botId == conversation.botId {
      // Without its anchor, words could match an older row of another member's; only an ID is evidence.
      if let index = copyIndex(requestId: send.requestId, messageId: send.messageId, text: send.after == nil ? "" : send.text,
        after: send.after, senderId: send.senderId, in: conversation.messages, skipping: claimed)
      {
        claimed.insert(conversation.messages[index].id)
      }
    }
    return claimed
  }

  /// The person's sends after a change: one is added when Hermes accepts it, from the echo it had until
  /// then, and the other person's, or sends past a chat's newest `ownSendsKept`, are dropped. A send ends
  /// with its echo when the echo leaves while its own chat is open and its copy is not shown, the evidence
  /// the echo itself uses that no copy is coming: Hermes joined it with other steers, or merged or dropped
  /// its queued text. Time cannot bound it, since a queued send may wait as long as the work before it.
  /// `before` and `after` are the echoes of the same change.
  static func nextSends(_ sends: [OwnSend], before: [SentEcho], after: [SentEcho], receipt: Receipt?, sender: Sender?,
    conversation: Conversation?) -> [OwnSend]
  {
    var next = sends.filter { $0.senderId == sender?.id }
    if let receipt, receipt.admitted, let sender,
      let echo = before.first(where: { $0.request.requestId == receipt.requestId && $0.sender.id == sender.id }),
      !next.contains(where: { $0.requestId == echo.request.requestId })
    {
      next.append(OwnSend(requestId: echo.request.requestId, messageId: echo.messageId ?? receipt.messageId, botId: echo.request.botId,
        senderId: sender.id, text: echo.request.text, after: echo.after))
      let ofChat = next.filter { $0.botId == echo.request.botId }
      let dropped = Set(ofChat.prefix(max(0, ofChat.count - ownSendsKept)).map(\.requestId))
      if !dropped.isEmpty { next.removeAll { dropped.contains($0.requestId) && $0.botId == echo.request.botId } }
    }
    if let conversation {
      next.removeAll { send in
        conversation.botId == send.botId
          && before.contains { $0.request.requestId == send.requestId } && !after.contains { $0.request.requestId == send.requestId }
          && copyIndex(requestId: send.requestId, messageId: send.messageId, text: send.text, after: send.after, senderId: send.senderId,
            in: conversation.messages) == nil
      }
    }
    return next
  }
}
