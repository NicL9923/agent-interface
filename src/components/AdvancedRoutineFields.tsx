import { useEffect, useState } from "react";
import { request } from "../client-api";
import type { ModelCatalog, Routine, Skill, Tool } from "../shared/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type Draft = Omit<Routine, "id">;
/** Native overrides stay untouched until a control explicitly changes them. */
export function AdvancedRoutineFields({ value, onChange, routines, editing }: {
  value: Draft; onChange: (next: Draft) => void; routines: Routine[]; editing: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<Skill[]>();
  const [tools, setTools] = useState<Tool[]>();
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [errors, setErrors] = useState<string[]>([]);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setErrors([]); setSkills(undefined); setTools(undefined); setCatalog(undefined);
    const params = { id: value.botId }, signal = controller.signal;
    void Promise.allSettled([
      request("GET /bots/:id/skills", { params, signal }).then(rows => { if (!Array.isArray(rows)) throw new Error("Unreadable skills catalog"); if (!controller.signal.aborted) setSkills(rows); }),
      request("GET /bots/:id/tools", { params, signal }).then(rows => { if (!Array.isArray(rows)) throw new Error("Unreadable toolsets catalog"); if (!controller.signal.aborted) setTools(rows); }),
      request("GET /models", { query: { botId: value.botId }, signal }).then(rows => { if (!Array.isArray(rows.providers)) throw new Error("Unreadable model catalog"); if (!controller.signal.aborted) setCatalog(rows); }),
    ]).then(results => { if (!controller.signal.aborted) setErrors(results.flatMap((result, index) => result.status === "rejected" ? [`Could not load ${["skills", "toolsets", "models"][index]}. ${result.reason instanceof Error ? result.reason.message : "Try again."}`] : [])); });
    return () => controller.abort();
  }, [open, value.botId, retry]);
  const set = (patch: Partial<Draft>) => onChange({ ...value, ...patch });
  const toggle = (items: string[], id: string, checked: boolean) => checked ? [...items, id] : items.filter(item => item !== id);
  const selectedProvider = catalog?.providers.find(row => row.id === value.provider || row.aliases?.includes(value.provider ?? ""));
  const refs = value.contextFrom ?? [];
  const sameProfile = routines.filter(row => row.botId === value.botId && row.id !== editing);
  const names = (rows: { id: string; name: string }[] | undefined, selected: string[]) => [
    ...(rows ?? []), ...selected.filter(id => !rows?.some(row => row.id === id)).map(id => ({ id, name: `${id} (saved, unavailable)` })),
  ];
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary style={{ minHeight: 44, paddingBlock: 10, cursor: "pointer" }}>Advanced</summary>
    {open && <div>
      <p className="muted">Overrides apply only to this routine. Saved settings stay in place unless you change them.</p>
      {errors.length > 0 && <div role="alert">{errors.map(error => <p key={error}>{error}</p>)}<Button type="button" onClick={() => setRetry(n => n + 1)}>Retry advanced choices</Button></div>}
      <label className="checkbox-label"><Input type="checkbox" checked={value.noAgent === true} onChange={event => set({ noAgent: event.target.checked })} />Run the script without a model</label>
      <label>Profile script<Input value={value.script ?? ""} onChange={event => set({ script: event.target.value || null })} placeholder="reports/morning.py" required={value.noAgent === true} /></label>
      <p className="muted">An existing file inside this assistant's Hermes scripts directory. With the agent, its output becomes context. Script-only execution skips the model, but delivery to Bot Chat starts a separate model turn. Shell commands are not supported.</p>
      <fieldset disabled={value.noAgent === true}>
        <legend>Agent settings</legend>
        {value.noAgent && <p className="muted">These settings are kept and are used when the agent is enabled.</p>}
        <label>Provider<select value={value.provider ?? ""} onChange={event => set({ provider: event.target.value || null, model: null })}>
          <option value="">Use assistant provider</option>
          {value.provider && !selectedProvider && <option value={value.provider}>{value.provider} (saved)</option>}
          {catalog?.providers.map(row => <option key={row.id} value={row.id} disabled={!row.authenticated}>{row.name}{row.authenticated ? "" : " (disconnected)"}</option>)}
          {selectedProvider && selectedProvider.id !== value.provider && <option value={value.provider!}>{value.provider} (saved alias)</option>}
        </select></label>
        <label>Model<select value={value.model ?? ""} disabled={!selectedProvider} onChange={event => set({ model: event.target.value || null })}>
          <option value="">Use assistant model</option>
          {value.model && !selectedProvider?.models.some(row => row.id === value.model) && <option value={value.model}>{value.model} (saved)</option>}
          {selectedProvider?.models.map(row => <option key={row.id} value={row.id} disabled={!row.available}>{row.name}{row.available ? "" : " (unavailable)"}</option>)}
        </select></label>
        {!catalog && !errors.length && <p role="status">Loading model choices...</p>}
        {catalog?.providers.length === 0 && <p className="muted">No providers reported. Existing pins are preserved.</p>}
        <Button type="button" onClick={() => set({ provider: null, model: null })}>Use assistant model and provider</Button>
        <fieldset><legend>Skills to load</legend>
          {!skills && !errors.length && <p role="status">Loading skills...</p>}
          {skills?.length === 0 && <p className="muted">No skills reported for this assistant.</p>}
          {names(skills, value.skills ?? []).map(row => <label className="checkbox-label" key={row.id}><Input type="checkbox" checked={value.skills?.includes(row.id) ?? false} onChange={event => set({ skills: toggle(value.skills ?? [], row.id, event.target.checked) })} />{row.name}</label>)}
        </fieldset>
        <fieldset><legend>Toolsets</legend>
          <label className="checkbox-label"><Input type="checkbox" checked={value.enabledToolsets == null} onChange={event => set({ enabledToolsets: event.target.checked ? null : (tools ?? []).filter(row => row.enabled).map(row => row.id) })} />Use profile tools</label>
          {value.enabledToolsets != null && <>
            {!tools && !errors.length && <p role="status">Loading toolsets...</p>}
            {tools?.length === 0 && <p className="muted">No toolsets reported for this assistant.</p>}
            {names(tools, value.enabledToolsets).map(row => <label className="checkbox-label" key={row.id}><Input type="checkbox" checked={value.enabledToolsets!.includes(row.id)} onChange={event => set({ enabledToolsets: toggle(value.enabledToolsets!, row.id, event.target.checked) })} />{row.name}</label>)}
            {value.enabledToolsets.length === 0 && <p role="status">No tools allowed. Existing zero-tool settings are preserved, but Hermes cannot save a new empty selection here. Select a toolset or use profile tools.</p>}
          </>}
        </fieldset>
        <fieldset><legend>Context from previous runs</legend>
          <label className="checkbox-label"><Input type="checkbox" checked={refs.includes("self")} onChange={event => set({ contextFrom: toggle(refs, "self", event.target.checked) })} />Include this routine's previous result</label>
          <p className="muted">Include the latest result from other routines for this assistant. This does not change when they run.</p>
          {sameProfile.length === 0 && <p className="muted">No other routines for this assistant.</p>}
          {names(sameProfile, refs.filter(ref => ref !== "self")).map(row => <label className="checkbox-label" key={row.id}><Input type="checkbox" checked={refs.includes(row.id)} onChange={event => set({ contextFrom: toggle(refs, row.id, event.target.checked) })} />{row.name}</label>)}
        </fieldset>
      </fieldset>
    </div>}
  </details>;
}
