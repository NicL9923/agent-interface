import type { Bot, Message } from '../shared/types';
import { exchangePartner } from '../shared/main-assistant';
import { Button } from './ui/button';
import { createContext, useContext } from 'react';
import { agentEnvelope } from '../shared/collaboration';
import { messageOrigin } from '../shared/message-origin';
import './collaboration.css';

export function isAgentExchange(message: Message) {
  return messageOrigin(message)?.kind === 'agent';
}
/** Opens another assistant's chat from a transcript; App.tsx listens. */
export const OPEN_CHAT_EVENT = 'wildbots:open-chat';
/** This person's assistants and the open chat, so a handoff deep in a turn's fold can offer the other chat. */
export const ExchangeBots = createContext<{ bots: Bot[]; currentBotId: string }>({ bots: [], currentBotId: '' });
export function AgentExchange({ message, recipient }: { message: Message; recipient: string }) {
  // A handoff to or from one of this person's assistants offers its chat; anyone else's is never named.
  const { bots, currentBotId } = useContext(ExchangeBots);
  const envelope = agentEnvelope(message);
  const origin = messageOrigin(message);
  const incoming = envelope || (message.role === 'user' && origin?.name ? { name: origin.name, text: message.text } : null);
  let target = origin?.name || 'another assistant', body = '';
  if (!incoming) {
    try { const args = JSON.parse(message.toolCall?.arguments || '{}'); if (typeof args.target === 'string') target = args.target; if (typeof args.message === 'string') body = args.message; } catch { /* Keep the native result available. */ }
  }
  const partner = exchangePartner(message, incoming?.name, bots, currentBotId);
  const open = partner && <Button className="agent-exchange-open" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail: { botId: partner.id } }))}>
    Open {partner.name}'s chat</Button>;
  return <div className="agent-exchange">
    <div className="agent-exchange-label"><span aria-hidden="true">↔</span><strong>{incoming ? `${incoming.name} → ${recipient}` : `${recipient} → ${target}`}</strong><span className="muted">Agent message</span></div>
    {incoming ? <div className="message-text">{incoming.text}</div> : <details><summary>{message.toolCall?.status === 'running' ? 'Sending message…' : message.toolCall?.status === 'failed' ? 'Delivery failed' : 'View handoff and response'}</summary>
      {body && <p className="message-text">{body}</p>}
      <pre>{message.toolCall?.error || message.toolCall?.result || message.text || 'Waiting for Hermes to report delivery.'}</pre>
    </details>}
    {open}
  </div>;
}
