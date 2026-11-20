import ClientWebSocket from "ws";
import type { ComputerAttachment } from "../shared/computer.js";
import type { GroupRequest, GroupResponse, GroupRoom } from "../shared/collaboration.js";
import { hermesMaintenanceSendMessage } from "../shared/errors.js";
import jobFields from "../shared/hermes-job-fields.json" with { type: "json" };
import { httpError } from "./http-error.js";
import { TransportError, type Wire } from "./hermes-transport.js";

/**
 * The JSON-RPC errors `agent-interface.submit` answers before it admits anything, so the message was not sent and its
 * draft is still the person's (src/hermes/extension.py; tests/hermes_send_lanes_test.py and
 * tests/hermes_extension_journal_test.py pin that each leaves no receipt and calls nothing in Hermes):
 *  409    Hermes is being upgraded, answered before the handler runs.
 *  5035   the backend is retiring, or maintenance took the lease first, answered before the send is queued.
 *  -32602 the parameters are invalid, or the profile's canonical conversation is not the one named, answered before its receipt.
 *  4093   the request ID already belongs to a different input; that earlier input's receipt is untouched.
 * Any other error, and every failure of the connection itself, may have followed admission and stays uncertain.
 */
export const BEFORE_ADMISSION = new Set([409, 5035, -32602, 4093]);

/**
 * Refusals that pass: Hermes will take the same request once the upgrade ends or the backend is back. A retry carries one
 * request ID for its failed turn, and the app keeps a rejected receipt for good, so a retry refused for one of these stays
 * uncertain. Its reviewed resend then asks Hermes again. A new message takes a fresh ID and keeps its draft, so it may be rejected.
 */
export const TEMPORARY_REFUSAL = new Set([409, 5035]);

export function beforeAdmissionMessage(code: number, detail?: string): string {
  if (code === 409) return hermesMaintenanceSendMessage;
  const reason = detail?.trim().replace(/[.\s]+$/, "");
  return reason
    ? `Hermes did not accept this message: ${reason}. Your draft is saved.`
    : "Hermes did not accept this message. Your draft is saved.";
}

/**
 * Native cron job fields the app reads as routine settings, and those Hermes's scheduler writes as
 * bookkeeping. Anything else Hermes holds with a value can change how the job runs without the app
 * seeing it: a monitor script, a working directory, a pinned endpoint, or a setting a later Hermes adds.
 */
const KNOWN_FIELDS = new Set([...jobFields.routine, ...jobFields.status]);

/** The native fields that are set and are neither. Private `_` bookkeeping and an unlimited `repeat` count as unset. */
export function nativeOverrides(job: Wire): string[] {
  const set = (value: unknown) =>
    value !== null &&
    value !== undefined &&
    value !== "" &&
    value !== false &&
    !(Array.isArray(value) && !value.length) &&
    !(typeof value === "object" && !Array.isArray(value) && !Object.keys(value as object).length);
  return Object.entries(job ?? {})
    .filter(
      ([key, value]) =>
        !KNOWN_FIELDS.has(key) &&
        !key.startsWith("_") &&
        set(value) &&
        !(
          key === "repeat" &&
          typeof value === "object" &&
          value !== null &&
          (value as Wire).times == null
        ),
    )
    .map(([key]) => key)
    .sort();
}

/**
 * Sets the conversation's speed with one write. Hermes checks model support only for Fast and
 * Ultrafast; Auto on a model without fast mode runs at normal speed. Nothing here writes a speed the
 * person did not pick, because each write changes the live session at once, even mid-reply.
 */
export async function changeSpeed(
  word: string,
  setSpeed: (word: string) => Promise<Wire>,
): Promise<void> {
  let set: Wire;
  try {
    set = await setSpeed(word);
  } catch (error) {
    if (!(error instanceof TransportError) || error.rpcCode !== 4002) throw error;
    // Hermes versions before Auto answer "unknown fast mode".
    if (word === "auto" && /unknown fast mode/i.test(error.rpcMessage ?? ""))
      throw httpError(
        409,
        "This Hermes version does not have Auto speed. Update Hermes to use it.",
      );
    throw httpError(
      409,
      `${word.charAt(0).toUpperCase()}${word.slice(1)} speed is not available for this model.`,
    );
  }
  if (word === "auto" && set.value !== "auto")
    throw httpError(409, "Hermes did not confirm Auto speed. Update Hermes to use it.");
}

/**
 * The live session's speed word. A status read through config.set changes nothing and reports the
 * session's own tier. config.get is lossy: it reports Auto as "normal" and falls back to the profile
 * default when the session pins Normal, so it is used only on a Hermes without status, which has no Auto.
 * Hermes's first-turn-only Cold mode, which the app does not offer, reads as normal. Any other word is
 * returned as is, so the caller refuses it as unreadable instead of guessing.
 */
export async function readSpeed(
  setSpeed: (word: string) => Promise<Wire>,
  getSpeed: () => Promise<Wire>,
): Promise<unknown> {
  let value: unknown;
  try {
    value = (await setSpeed("status")).value;
  } catch (error) {
    if (!(error instanceof TransportError) || error.rpcCode !== 4002) throw error;
    value = (await getSpeed()).value;
  }
  return value === "cold" ? "normal" : value;
}

/** Executes one hosted group-chat operation against Hermes's JSON-RPC group coordinator. */
export async function hermesGroupRequest(
  rpc: (method: string, params: Wire) => Promise<Wire>,
  input: GroupRequest,
): Promise<GroupResponse> {
  if (input.operation === "list") {
    let capability: Wire;
    try {
      capability = await rpc("groups.capabilities", {});
    } catch (error) {
      if (error instanceof TransportError && error.rpcCode === -32601)
        return {
          supported: false,
          canSend: false,
          rooms: [],
          reason: "This Hermes version does not expose hosted group chats.",
        };
      throw error;
    }
    if (
      capability.protocol_version !== 2 ||
      !["groups.list", "groups.state", "groups.log"].every((method) =>
        capability.methods?.includes(method),
      )
    )
      return {
        supported: false,
        canSend: false,
        rooms: [],
        reason: "This Hermes group protocol is not supported by this app.",
      };
    const rooms: GroupRoom[] = [];
    let offset = 0;
    for (let page = 0; page < 10; page++) {
      const value = await rpc("groups.list", { limit: 100, offset });
      rooms.push(...value.rooms);
      if (value.next_offset == null) break;
      offset = value.next_offset;
    }
    const canSend =
      capability.driver === true &&
      ["groups.create", "groups.send", "groups.stop", "groups.approve"].every((method) =>
        capability.methods?.includes(method),
      );
    // Room settings and routine posts into rooms arrived in the same Hermes change, behind groups.context.
    const settings = capability.methods?.includes("groups.context") === true;
    return {
      supported: true,
      canSend,
      rooms,
      settings,
      routineDelivery: settings,
      ...(!canSend
        ? {
            reason:
              "Hermes group history is available. Its group coordinator must be running to create rooms or send messages.",
          }
        : {}),
    };
  }
  const room_id = input.roomId;
  if (input.operation === "state") return (await rpc("groups.state", { room_id })) as GroupResponse;
  if (input.operation === "log")
    return (await rpc("groups.log", {
      room_id,
      since_seq: input.since,
      limit: 200,
    })) as GroupResponse;
  const catalog = await rpc("groups.capabilities", {});
  if (input.operation === "context") {
    // Room settings are a room-log write, not a discussion turn, so they need no running coordinator.
    if (catalog.protocol_version !== 2 || !catalog.methods?.includes("groups.context"))
      throw httpError(
        409,
        "This Hermes version cannot save group settings. Update Hermes to change them.",
      );
    // Routing is always sent: Hermes keeps the room's current routing only when it is omitted.
    return (await rpc("groups.context", {
      room_id,
      event_id: input.requestId,
      purpose: input.purpose,
      notes: input.notes,
      routing: input.routing,
      lead_member_id: input.leadMemberId,
    })) as GroupResponse;
  }
  if (catalog.protocol_version !== 2 || catalog.driver !== true)
    throw httpError(
      409,
      "The Hermes group coordinator is unavailable. Refresh before trying again.",
    );
  if (input.operation === "create")
    return (await rpc("groups.create", {
      room_id,
      name: input.name,
      members: input.members,
    })) as GroupResponse;
  if (input.operation === "send")
    return (await rpc("groups.send", {
      room_id,
      event_id: input.requestId,
      payload: { text: input.text, thread_id: input.threadId },
    })) as GroupResponse;
  if (input.operation === "stop")
    return (await rpc("groups.stop", { room_id, cancel_id: input.requestId })) as GroupResponse;
  return (await rpc("groups.approve", {
    room_id,
    member_id: input.memberId,
    task_id: input.taskId,
    execution_generation: input.generation,
    choice: input.choice,
    request_id: input.requestId,
  })) as GroupResponse;
}

/** Opens the upstream WebSocket to Hermes's shared desktop display proxy. */
export function openComputerDisplaySocket(
  origin: URL | undefined,
  attachment: ComputerAttachment,
): ClientWebSocket {
  if (
    !origin ||
    attachment.path !== "/api/display/ws" ||
    !/^[A-Za-z0-9_-]{20,200}$/.test(attachment.ticket)
  )
    throw new Error("Hermes returned an invalid computer attachment.");
  const url = new URL(attachment.path, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("display_ticket", attachment.ticket);
  return new ClientWebSocket(url, {
    maxPayload: 4 * 1024 * 1024,
    followRedirects: false,
    handshakeTimeout: 10_000,
  });
}
