import type { FileRef, Message, ToolCall } from "../../shared/types";
import type { Artifact } from "../../shared/artifacts";
import type { Turn } from "../transcript-window";

export const sameFile = (a: FileRef, b: FileRef) =>
  a === b ||
  (a.id === b.id && a.name === b.name && a.mime === b.mime && a.size === b.size && a.url === b.url);
const sameCall = (a?: ToolCall, b?: ToolCall) =>
  a === b ||
  (!!a &&
    !!b &&
    a.id === b.id &&
    a.name === b.name &&
    a.status === b.status &&
    a.arguments === b.arguments &&
    a.result === b.result &&
    a.error === b.error &&
    a.startedAt === b.startedAt &&
    a.completedAt === b.completedAt);
const sameOrigin = (a?: Message["origin"], b?: Message["origin"]) =>
  a === b ||
  (!!a &&
    !!b &&
    a.kind === b.kind &&
    a.visibility === b.visibility &&
    a.title === b.title &&
    a.name === b.name &&
    a.handle === b.handle);
function sameMessage(a: Message, b: Message) {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.role === b.role &&
    a.text === b.text &&
    a.interim === b.interim &&
    a.createdAt === b.createdAt &&
    a.reasoning === b.reasoning &&
    a.toolName === b.toolName &&
    a.runId === b.runId &&
    a.sender?.id === b.sender?.id &&
    a.sender?.name === b.sender?.name &&
    sameOrigin(a.origin, b.origin) &&
    sameCall(a.toolCall, b.toolCall) &&
    (a.files === b.files ||
      (!!a.files &&
        !!b.files &&
        a.files.length === b.files.length &&
        a.files.every((file, index) => sameFile(file, b.files![index]))))
  );
}
const sameMessages = (a: Message[], b: Message[]) =>
  a === b || (a.length === b.length && a.every((message, index) => sameMessage(message, b[index])));
export function sameTurn(a: Turn, b: Turn) {
  if (a === b) return true;
  if (
    a.replyAt !== b.replyAt ||
    a.reasoning.length !== b.reasoning.length ||
    a.reasoning.some((part, index) => part !== b.reasoning[index])
  )
    return false;
  if (
    !sameMessages(a.messages, b.messages) ||
    a.tools.size !== b.tools.size ||
    a.order.length !== b.order.length ||
    a.order.some((id, index) => id !== b.order[index])
  )
    return false;
  const left = [...a.tools],
    right = [...b.tools];
  return left.every(
    ([id, message], index) => id === right[index][0] && sameMessage(message, right[index][1]),
  );
}

export const sameFiles = (
  a?: { replyId: string; artifacts: Artifact[] },
  b?: { replyId: string; artifacts: Artifact[] },
) =>
  a === b ||
  (!!a &&
    !!b &&
    a.replyId === b.replyId &&
    a.artifacts.length === b.artifacts.length &&
    a.artifacts.every((artifact, index) => sameFile(artifact.file, b.artifacts[index].file)));
