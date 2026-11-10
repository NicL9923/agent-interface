// Measurement-only probe. Never committed: see docs/ledger for how it was applied.
type Probe = { on: boolean; body: boolean; counts: Record<string, number>; renders: { phase: string; actual: number; body: boolean }[] };
const probe: Probe = ((globalThis as Record<string, unknown>).__probe as Probe) ?? { on: false, body: false, counts: {}, renders: [] };
(globalThis as Record<string, unknown>).__probe = probe;
export const count = (name: string, n = 1) => { if (probe.on) probe.counts[name] = (probe.counts[name] ?? 0) + n; };
/** The Conversation component's own body ran in this commit, as it does when its props change. */
export const conversationBody = () => { probe.body = true; count("Conversation.body"); };
export const rendered = (_id: string, phase: string, actual: number) => {
  if (probe.on) probe.renders.push({ phase, actual, body: probe.body });
  probe.body = false;
};
