import type { Message } from '../shared/types';
import { agentEnvelope } from '../shared/collaboration';
import { messageOrigin } from '../shared/message-origin';
import './collaboration.css';

export function isAgentExchange(message: Message) {
  return messageOrigin(message)?.kind === 'agent';
}
export function AgentExchange({ message, recipient }: { message: Message; recipient: string }) {
  const envelope = agentEnvelope(message);
  const origin = messageOrigin(message);
  const incoming = envelope || (message.role === 'user' && origin?.name ? { name: origin.name, text: message.text } : null);
  let target = origin?.name || 'another assistant', body = '';
  if (!incoming) {
    try { const args = JSON.parse(message.toolCall?.arguments || '{}'); if (typeof args.target === 'string') target = args.target; if (typeof args.message === 'string') body = args.message; } catch { /* Keep the native result available. */ }
  }
  return <div className="agent-exchange">
    <div className="agent-exchange-label"><span aria-hidden="true">↔</span><strong>{incoming ? `${incoming.name} → ${recipient}` : `${recipient} → ${target}`}</strong><span className="muted">Agent message</span></div>
    {incoming ? <div className="message-text">{incoming.text}</div> : <details><summary>{message.toolCall?.status === 'running' ? 'Sending message…' : message.toolCall?.status === 'failed' ? 'Delivery failed' : 'View handoff and response'}</summary>
      {body && <p className="message-text">{body}</p>}
      <pre>{message.toolCall?.error || message.toolCall?.result || message.text || 'Waiting for Hermes to report delivery.'}</pre>
    </details>}
  </div>;
}
