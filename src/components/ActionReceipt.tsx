import type { ToolCall } from '../shared/types';
import { receipt } from '../shared/discovery';
export function ActionReceipt({call}:{call:ToolCall}) {
  const value=receipt(call);
  return <details className={`action-receipt${value.failed?' failed':''}`}><summary>{value.label} · {call.name}</summary><p className="muted">Outcome reported by the tool. Review its result to confirm what changed.</p><pre>{value.text}</pre>{value.links.map(url=><a key={url} href={url} target="_blank" rel="noreferrer">Open reported result</a>)}</details>;
}
