import type { ErrorCode } from "../shared/errors.js";
import type { Submission, SubmissionReceipt } from "../shared/types.js";
import { httpError } from "./http-error.js";
import type { DraftRepository } from "./store-drafts.js";
import type { StoreDatabase } from "./store-database.js";

/** Why this server rejected a submission itself, recorded so a retry is judged by it rather than by its text. */
export type RejectionReason = Extract<ErrorCode, "interruption_pending">;
type StoredReceipt = SubmissionReceipt & { reason?: RejectionReason };
// Releases before reasons were recorded stored only this exact sentence. It stays frozen even if
// the message clients see is reworded, and is checked only for rows that carry no reason.
const legacyInterruptionMessage = "Review the interrupted task before starting another message.";
const legacyReason = (receipt: SubmissionReceipt): RejectionReason | undefined =>
  receipt.status === "rejected" && receipt.message === legacyInterruptionMessage ? "interruption_pending" : undefined;

/** Message admission receipts, run participants and approval attribution. */
export class SubmissionRepository {
  constructor(private readonly database: StoreDatabase, private readonly drafts: DraftRepository) {}
  private get db() { return this.database.db; }
  intent(input: Submission): {
    created: boolean;
    receipt: SubmissionReceipt;
    input: Submission;
  } {
    return this.database.transaction(() => {
      const previous = this.submission(input.requestId);
      if (previous) {
        if (JSON.stringify(previous.input) !== JSON.stringify(input))
          throw httpError(409, "This submission ID was already used for different content");
        return { created: false, ...previous };
      }
      const receipt: SubmissionReceipt = {
        requestId: input.requestId,
        status: "uncertain",
        message:
          "Waiting for confirmed Hermes admission. This message will never be automatically resent.",
      };
      this.db
        .prepare("INSERT INTO submissions VALUES(?,?,?,?,?,?)")
        .run(
          input.requestId,
          input.botId,
          input.senderId,
          JSON.stringify(input),
          JSON.stringify(receipt),
          Date.now(),
        );
      return { created: true, receipt, input };
    });
  }
  submission(id: string) {
    const row = this.db
      .prepare("SELECT payload,receipt FROM submissions WHERE request_id=?")
      .get(id) as { payload: string; receipt: string } | undefined;
    if (!row) return undefined;
    const { reason, ...receipt } = JSON.parse(row.receipt) as StoredReceipt;
    return { input: JSON.parse(row.payload) as Submission, receipt, reason: reason ?? legacyReason(receipt) };
  }
  submissionForMessage(botId: string, messageId: string) {
    const row = this.db
      .prepare(
        "SELECT request_id FROM submissions WHERE bot_id=? AND json_extract(receipt,'$.messageId')=?",
      )
      .get(botId, messageId) as { request_id: string } | undefined;
    return row ? this.submission(row.request_id) : undefined;
  }
  pending() {
    // Matches the submissions_status expression index; settled history is never scanned.
    return (
      this.db.prepare("SELECT request_id FROM submissions WHERE json_extract(receipt,'$.status')='uncertain' ORDER BY created_at").all() as {
        request_id: string;
      }[]
    ).map((r) => this.submission(r.request_id)!);
  }
  /** A reason stays with the stored receipt, never with the one clients receive. */
  receipt(receipt: SubmissionReceipt, reason?: RejectionReason) {
    this.database.transaction(() => {
      const previous = this.submission(receipt.requestId);
      const stored: StoredReceipt = reason ? { ...receipt, reason } : receipt;
      this.db
        .prepare("UPDATE submissions SET receipt=? WHERE request_id=?")
        .run(JSON.stringify(stored), receipt.requestId);
      const row = this.submission(receipt.requestId);
      // A retry resends an earlier message, never the draft, which stays the person's own.
      if (row && receipt.status === "accepted" && previous?.receipt.status !== "accepted" && row.input.retryOf === undefined)
        this.drafts.clearSubmittedDraft(row.input.senderId, row.input.botId, {
          text: row.input.text, attachments: row.input.attachments ?? [],
        }, row.input.draftBaseRevision);
      if (row && receipt.runId)
        this.participate(receipt.runId, row.input.senderId);
    });
  }
  participate(runId: string, userId: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO participants VALUES(?,?)")
      .run(runId, userId);
  }
  participants(runId: string) {
    return (this.db.prepare("SELECT user_id FROM participants WHERE run_id=?").all(runId) as { user_id: string }[]).map(row => row.user_id);
  }
  attributeApproval(
    id: string,
    botId: string,
    userId: string,
    decision: string,
  ) {
    this.db
      .prepare("INSERT INTO approval_attribution VALUES(?,?,?,?,?)")
      .run(id, botId, userId, decision, Date.now());
  }
  /** Records who sent a group chat message, keyed by the event Hermes appended for it. */
  attributeGroupMessage(roomId: string, eventId: string, userId: string) {
    this.db.prepare("INSERT OR IGNORE INTO group_senders(room_id,event_id,user_id,created_at) VALUES(?,?,?,?)").run(roomId, eventId, userId, Date.now());
  }
  /** The recorded sender of each of these group events that has one. */
  groupSenders(roomId: string, eventIds: string[]) {
    const senders = new Map<string, string>();
    const read = this.db.prepare("SELECT user_id AS userId FROM group_senders WHERE room_id=? AND event_id=?");
    for (const eventId of new Set(eventIds)) {
      const row = read.get(roomId, eventId) as { userId: string } | undefined;
      if (row) senders.set(eventId, row.userId);
    }
    return senders;
  }
  approval(id: string) {
    return this.db
      .prepare(
        "SELECT user_id AS userId,decision FROM approval_attribution WHERE approval_id=?",
      )
      .get(id);
  }
}
