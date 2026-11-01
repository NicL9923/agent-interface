import type { Conversation } from "../shared/types";
import { SecureRequestCard, SettledReceipt } from "../components/SecureRequestCard";
import { ComputerHandoffCard } from "../components/ComputerHandoffCard";
import { AttentionCard } from "./AttentionCard";
import { useSettledRequests } from "./waiting-input";

/**
 * The requests an assistant is waiting on, in the transcript after its live row. A request this
 * tab just settled keeps a one-line receipt for a moment after Hermes stops listing it.
 */
export function AttentionList({ conversation, botId, userId, assistantName, disconnected, report }: {
  conversation: Conversation | null | undefined; botId: string; userId: string; assistantName?: string;
  disconnected: boolean; report: (message: string) => void;
}) {
  const settled = useSettledRequests(botId);
  const listed = new Set(conversation?.attention?.map(request => request.id));
  return <>
    {settled.filter(item => !listed.has(item.requestId)).map(item => <SettledReceipt key={`settled:${item.requestId}`} requestId={item.requestId} text={item.text} />)}
    {conversation?.attention?.map(request => request.kind === "secure" && request.secure ? <SecureRequestCard
      key={`${userId}:${botId}:${request.id}:${JSON.stringify(request.secure)}`}
      request={request.secure} requestId={request.id} botId={botId} ownerId={userId}
      title={request.title} detail={request.detail} assistantName={assistantName}
    /> : request.kind === "computer" && request.computer ? <ComputerHandoffCard
      key={`${userId}:${botId}:${request.id}`} handoff={request.computer} requestId={request.id} botId={botId}
      assistantName={assistantName} disconnected={disconnected}
    /> : <AttentionCard key={request.id} request={request} disconnected={disconnected} botId={botId} report={report} />)}
  </>;
}
