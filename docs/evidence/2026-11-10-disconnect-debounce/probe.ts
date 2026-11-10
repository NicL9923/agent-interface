// Measurement-only probe for a failed read. Never committed: see docs/ledger for how it was applied.
type Probe = { on: boolean; counts: Record<string, number>; renders: { actual: number }[] };
const probe: Probe = ((globalThis as Record<string, unknown>).__probe as Probe) ?? { on: false, counts: {}, renders: [] };
(globalThis as Record<string, unknown>).__probe = probe;
export const count = (name: string, n = 1) => { if (probe.on) probe.counts[name] = (probe.counts[name] ?? 0) + n; };
export const rendered = (_id: string, _phase: string, actual: number) => { if (probe.on) probe.renders.push({ actual }); };
