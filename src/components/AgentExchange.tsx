import type { Bot, Message } from '../shared/types';
import { exchangePartner } from '../shared/main-assistant';
import { Button } from './ui/button';
import { createContext, useContext, type ReactNode } from 'react';
import { agentEnvelope } from '../shared/collaboration';
import { messageOrigin } from '../shared/message-origin';
import { Avatar } from './Avatar';
import { When } from './When';
import { Icon } from './Icon';
import './collaboration.css';

export function isAgentExchange(message: Message) {
  return messageOrigin(message)?.kind === 'agent';
}
/** An assistant can narrate a handoff and make its tool call in the same saved row. Keep both. */
export function exchangeMessage(message: Message): Message | undefined {
  const narration = message.role === 'assistant' && (!!message.text.trim() || !!message.files?.length);
  if (isAgentExchange(message) && message.toolCall?.name !== 'message_agent') {
    if (message.toolCall && !narration) return undefined;
    return message.toolCall ? { ...message, toolCall: undefined } : message;
  }
  if (isAgentExchange(message) && !narration) return message;
  if (message.toolCall?.name !== 'message_agent') return undefined;
  return { ...message, id: `agent-call:${message.id}`, role: 'tool', text: '', files: undefined,
    origin: { kind: 'agent', visibility: 'activity' } };
}
/** Provenance can also mark an assistant's ordinary tool calls as agent activity. Keep those in work. */
export function exchangeWork(message: Message): Message | undefined {
  if (isAgentExchange(message) && message.toolCall && message.toolCall.name !== 'message_agent') {
    return { ...message, role: 'tool', text: '', origin: undefined, files: undefined };
  }
  return exchangeMessage(message) ? undefined : message;
}
/** One saved row can contain a reply and a handoff, or a reply and an ordinary tool call. */
export function exchangeDisplay(message: Message): Message[] {
  const exchange = exchangeMessage(message);
  if (exchange && exchange.id !== message.id) return [{ ...message, toolCall: undefined }, exchange];
  if (isAgentExchange(message) && message.toolCall && message.toolCall.name !== 'message_agent') {
    const work = { ...exchangeWork(message)!, id: `agent-tool:${message.id}` };
    return exchange ? [exchange, work] : [work];
  }
  return [exchange ?? message];
}
/** Opens another assistant's chat from a transcript; App.tsx listens. */
export const OPEN_CHAT_EVENT = 'wildbots:open-chat';
/** This person's assistants and the open chat, so a handoff deep in a turn's fold can offer the other chat. */
export const ExchangeBots = createContext<{ bots: Bot[]; currentBotId: string }>({ bots: [], currentBotId: '' });
function exchange(message: Message, recipient: string, bots: Bot[], currentBotId: string) {
  const envelope = agentEnvelope(message);
  const origin = messageOrigin(message);
  const incoming = envelope || (message.role === 'user' && origin?.name ? { name: origin.name, text: message.text } : null);
  let target = origin?.name || 'another assistant', body = '';
  if (!incoming) {
    try { const args = JSON.parse(message.toolCall?.arguments || '{}'); if (typeof args.target === 'string') target = args.target; if (typeof args.message === 'string') body = args.message; } catch { /* Keep the native result available. */ }
  }
  // A reply inherits the sender's origin, but travels back to that sender. Prefer a stable handle
  // over a display name when Hermes supplies one. Resolve only against this person's roster.
  const partner = exchangePartner(message, incoming ? origin?.handle || envelope?.handle || incoming.name : !message.toolCall ? origin?.handle || origin?.name : undefined, bots, currentBotId);
  const current = bots.find(bot => bot.id === currentBotId);
  const other = { bot: partner, name: partner?.name ?? incoming?.name ?? target };
  const here = { bot: current, name: recipient };
  return { incoming, body, partner, sender: incoming ? other : here, receiver: incoming ? here : other };
}
type Participant = { bot?: Bot; name: string };
function ExchangeRoute({ sender, receiver }: { sender: Participant; receiver: Participant }) {
  const face = (person: Participant) => person.bot
    ? <span aria-hidden="true"><Avatar avatar={person.bot.avatar} botId={person.bot.id} name={person.name} size={28} reducedMotion /></span>
    : <span className="agent-exchange-unknown" aria-hidden="true"><Icon name="robot" size={18} /></span>;
  return <span className="agent-exchange-route" role="group" aria-label={`${sender.name} to ${receiver.name}`}>
    <span className="agent-exchange-person">{face(sender)}<strong>{sender.name}</strong></span>
    <span aria-hidden="true"> → </span>
    <span className="agent-exchange-person">{face(receiver)}<strong>{receiver.name}</strong></span>
  </span>;
}
/** Contiguous runs only. An intervening tool, human message or reply always breaks a run. */
export function exchangeRuns(messages: Message[]): Message[][] {
  const runs: Message[][] = [];
  const shown = messages.flatMap(exchangeDisplay);
  for (const message of shown) {
    const last = runs.at(-1);
    if (last && isAgentExchange(message) && isAgentExchange(last[0])) last.push(message);
    else runs.push([message]);
  }
  return runs;
}
/** One exchange stays readable; consecutive exchanges share a closed disclosure. */
export function AgentExchangeGroup({ messages, recipient, children }: { messages: Message[]; recipient: string; children: ReactNode }) {
  const { bots, currentBotId } = useContext(ExchangeBots);
  if (messages.length < 2) return children;
  const routes = messages.map(message => exchange(message, recipient, bots, currentBotId));
  const unique = routes.filter((route, index) => routes.findIndex(other => other.sender.name === route.sender.name && other.receiver.name === route.receiver.name) === index);
  const failed = messages.filter(message => message.toolCall?.status === 'failed').length;
  const sending = messages.some(message => message.toolCall?.status === 'running');
  return <details className="agent-exchange-group">
    <summary><span className="agent-exchange-routes">{unique.map((route, index) => <ExchangeRoute key={index} {...route} />)}</span>
      <span className="agent-exchange-count">{messages.length} bot messages</span>
      {failed > 0 && <span className="danger">{failed} failed</span>}
      {sending && <span className="muted">Sending…</span>}
    </summary>
    <div className="agent-exchange-messages">{children}</div>
  </details>;
}
export function AgentExchange({ message, recipient }: { message: Message; recipient: string }) {
  const { bots, currentBotId } = useContext(ExchangeBots);
  const { incoming, body, partner, sender, receiver } = exchange(message, recipient, bots, currentBotId);
  const open = partner && <Button className="agent-exchange-open" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail: { botId: partner.id } }))}>
    Open {partner.name}'s chat</Button>;
  return <div className="agent-exchange">
    <div className="agent-exchange-label"><ExchangeRoute sender={sender} receiver={receiver} /><span className="muted">Bot message</span></div>
    {incoming || !message.toolCall ? <div className="message-text">{incoming?.text ?? message.text}</div> : <>
    {body && <p className="message-text">{body}</p>}
    <details><summary>{message.toolCall.status === 'running' ? 'Sending message…' : message.toolCall.status === 'failed' ? 'Delivery failed' : 'View handoff and response'}</summary>
      <pre>{message.toolCall?.error || message.toolCall?.result || message.text || 'Waiting for Hermes to report delivery.'}</pre>
    </details></>}
    <div className="agent-exchange-footer">{open}{message.createdAt && <When value={message.createdAt} />}</div>
  </div>;
}
