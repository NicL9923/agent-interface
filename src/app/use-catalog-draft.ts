import { useEffect, useRef, useState } from "react";
import { request } from "../client-api";
import type { Skill, Tool } from "../shared/types";

export type CatalogKind = "tools" | "skills";
type CatalogItem = Tool | Skill;
const enabled = (item: CatalogItem) => item.enabled || "required" in item && !!item.required;
const enabledKey = (items: CatalogItem[]) => items.filter(enabled).map(item => item.id).sort().join("\n");

/**
 * The enabled tools or skills of one assistant. Choices wait for their own Save button, so the
 * loaded or saved choice is the baseline, and `staged` reports edits that have not been saved.
 */
export function useCatalogDraft(kind: CatalogKind, { botId, active, supported, report }: {
  botId: string | undefined;
  /** True while the section is on screen; each visit loads again unless choices are staged. */
  active: boolean;
  supported: boolean;
  report: (message: string) => void;
}) {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [baseline, setBaseline] = useState<string>();
  const [status, setStatus] = useState<"loading" | "ready" | "error">();
  const [attempt, setAttempt] = useState(0);
  const staged = baseline !== undefined && enabledKey(items) !== baseline;
  const stagedNow = useRef(staged);
  stagedNow.current = staged;
  const reportNow = useRef(report);
  reportNow.current = report;
  useEffect(() => {
    if (!active || !botId) return;
    // Reloading would replace choices that are still waiting for their Save button.
    if (stagedNow.current) { setStatus("ready"); return; }
    if (!supported) return;
    const controller = new AbortController();
    setStatus("loading");
    request(`GET /bots/:id/${kind}`, { params: { id: botId }, signal: controller.signal })
      .then(loaded => {
        if (controller.signal.aborted) return;
        setItems(loaded);
        setBaseline(enabledKey(loaded));
        setStatus("ready");
      })
      .catch(cause => {
        if (controller.signal.aborted) return;
        reportNow.current((cause as Error).message);
        setStatus("error");
      });
    return () => controller.abort();
  }, [kind, active, botId, supported, attempt]);
  return {
    kind,
    items,
    staged,
    ready: active && status === "ready",
    failed: active && status === "error",
    toggle: (id: string, enabled: boolean) => setItems(current => current.map(item => item.id === id ? { ...item, enabled } : item)),
    retry: () => { reportNow.current(""); setAttempt(value => value + 1); },
    /** Saves the enabled choices and makes them the new baseline. */
    async save(id: string) {
      const submitted = items;
      await request(`PUT /bots/:id/${kind}`, { params: { id }, body: { ids: submitted.filter(enabled).map(item => item.id) } });
      setBaseline(enabledKey(submitted));
    },
  };
}
export type CatalogDraft = ReturnType<typeof useCatalogDraft>;
