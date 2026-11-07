/**
 * Display names for models. Hermes's own models.dev cache supplies the name when it has one, read
 * through the add-on without the network. Otherwise the slug is formatted here, the way T3 Code does.
 */
import type { ModelChoice } from '../shared/types.js';
import { formatModelSlugName } from '../shared/model-name.js';

// The formatter is shared with the web client, which names the model a T3 Code thread runs on.
export { formatModelSlugName };

export interface ModelNameRow extends ModelChoice { name: string | null }
type Lookup = (models: ModelChoice[]) => Promise<ModelNameRow[]>;

const KEPT_MS = 10 * 60_000;
// An add-on that cannot answer, or an answer that failed, is asked again sooner than a real answer.
const RETRY_MS = 60_000;
// A roster read waits this long for names before it shows formatted ones. The lookup keeps going.
const WAIT_MS = 1_500;
const key = (model: ChoiceLike) => `${model.provider}\u0000${model.model}`;
type ChoiceLike = { provider?: string; model: string };

/**
 * Remembers the add-on's names. `name` never waits: it answers from what is remembered, and falls
 * back to the formatter. `load` asks the add-on for pairs it has not remembered, in one batch.
 */
export function createModelNames(lookup: (() => Lookup) | undefined, now = () => Date.now()) {
  const kept = new Map<string, { name: string | null; until: number }>();
  const asking = new Map<string, Promise<void>>();
  const name = (model: ChoiceLike) => (model.provider ? kept.get(key(model))?.name : undefined) ?? formatModelSlugName(model.model);
  async function load(models: ChoiceLike[]) {
    const ask = lookup?.();
    if (!ask) return;
    // A model with no provider has no catalog entry to read.
    const missing = [...new Map(models.filter((model): model is ModelChoice => !!model.provider && !!model.model && (kept.get(key(model))?.until ?? 0) <= now())
      .map(model => [key(model), { provider: model.provider, model: model.model }])).values()];
    if (!missing.length) return;
    const waiting = missing.filter(model => !asking.has(key(model)));
    if (waiting.length) {
      const batch = (async () => {
        try {
          const rows = await ask(waiting);
          const answered = new Set<string>();
          for (const row of rows) {
            if (typeof row?.provider !== 'string' || typeof row.model !== 'string') continue;
            answered.add(key(row));
            kept.set(key(row), { name: typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 200) : null, until: now() + KEPT_MS });
          }
          for (const model of waiting) if (!answered.has(key(model))) kept.set(key(model), { name: null, until: now() + RETRY_MS });
        } catch {
          for (const model of waiting) kept.set(key(model), { name: null, until: now() + RETRY_MS });
        }
      })();
      for (const model of waiting) asking.set(key(model), batch);
      void batch.finally(() => { for (const model of waiting) asking.delete(key(model)); });
    }
    const pending = [...new Set(missing.map(model => asking.get(key(model))).filter((value): value is Promise<void> => !!value))];
    if (pending.length) await Promise.race([Promise.all(pending), new Promise(done => setTimeout(done, WAIT_MS).unref?.())]);
  }
  return { name, load };
}
