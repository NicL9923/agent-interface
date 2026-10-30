import { Dialog } from "./components/ui/dialog";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { useEffect, useId, useRef, useState } from "react";
import type {
  Avatar as AvatarConfig,
  Bootstrap,
  Bot,
  BotInput,
  Routine,
} from "./shared/types";
import { api, ApiError, request, write } from "./client-api";
import { routeUrl, type ApiResponse } from "./shared/api";
import { useAction } from "./app/use-action";
import { useCatalogDraft } from "./app/use-catalog-draft";
import { useResource } from "./app/use-resource";
import { CatalogEditor } from "./components/CatalogEditor";
import { SettingsConfirmation } from "./components/SettingsConfirmation";
import { FormMessage } from "./components/ui/form-message";
import { IntegrationList } from "./components/IntegrationsPanel";
import { Icon } from "./components/Icon";
import { defaultAvatar } from "./components/Avatar";
import { AvatarEditor } from "./components/AvatarEditor";
import { ModelSelector } from "./components/ModelSelector";
import { MemoryPanel } from "./components/MemoryPanel";
import { AutomationPanel, LearningPanel } from "./components/AutomationPanel";
import { VaultPanel } from "./components/VaultPanel";
import { RoutineEnhancements, RoutineSchedulePreview } from "./components/RoutineEnhancements";
import { interactiveReplyInstructions } from "./shared/reply-cards";
import { routinePresets } from "./shared/routine-presets";
import { AdvancedRoutineFields } from "./components/AdvancedRoutineFields";
const settingsSections = ["details", "avatar", "connections", "tools", "skills", "routines", "work", "learning", "memory", "logins"] as const;
type SettingsTab = (typeof settingsSections)[number];
/** A lean roster row lacks some fields, so each one has a safe default. A missing bot takes the first one's model. */
function formFromBot(bot: Bot | null, fallback?: Bot): BotInput {
  const modelSource = bot?.model ? bot : fallback;
  return {
    name: bot?.name || "",
    description: bot?.description || "",
    instructions: bot?.instructions || "",
    model: modelSource?.model || "",
    provider: modelSource?.provider,
    shared: bot?.shared ?? true,
    enabledMcpServers: bot?.enabledMcpServers ?? [],
  };
}
function useCompactSettings() {
  const query = "(max-width: 620px)";
  const [compact, setCompact] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const changed = () => setCompact(media.matches);
    changed();
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  return compact;
}
function LoadedBotSettings({
  bot,
  bootstrap,
  onClose,
  onSaved,
  onDeleted,
  onOpenRoutine,
  loading,
}: {
  loading?: { error: string; retry(): void };
  bot: Bot | "new";
  bootstrap: Bootstrap;
  onClose: () => void;
  onSaved: () => void;
  onDeleted?: (botId: string) => void;
  onOpenRoutine?: (botId: string, routineId: string) => void;
}) {
  // Creating saves the assistant and then its avatar. Once it exists, this same sheet edits it,
  // so an avatar that failed to save is still here to retry.
  const [created, setCreated] = useState<Bot | null>(null);
  const existing = created ?? (bot === "new" ? null : bot);
  const [step, setStep] = useState<"look" | "role">("look");
  const [avatarFailure, setAvatarFailure] = useState("");
  const [tab, setTab] = useState<SettingsTab>("details");
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [memorySaving, setMemorySaving] = useState(false);
  const [pendingMemoryTab, setPendingMemoryTab] = useState<SettingsTab | null>(null);
  useEffect(() => { if (!memoryDirty) setPendingMemoryTab(null); }, [memoryDirty]);
  const compactSettings = useCompactSettings();
  const overflowMenu = useRef<HTMLDetailsElement>(null);
  const overflowTrigger = useRef<HTMLElement>(null);
  const overflowMenuId = useId();
  // What the form and avatar last matched on the server; saves move it forward.
  const [baseline, setBaseline] = useState<{ form: BotInput; avatar: AvatarConfig }>(() => ({
    form: formFromBot(existing, bootstrap.bots[0]),
    avatar: existing?.avatar || defaultAvatar,
  }));
  const savedName = baseline.form.name || existing?.name || "";
  // The dialog stays mounted while detail loads; only authoritative detail seeds the form.
  const wasLoading = useRef(!!loading);
  useEffect(() => {
    if (loading) { wasLoading.current = true; return; }
    if (!wasLoading.current || !existing) return;
    wasLoading.current = false;
    const form = formFromBot(existing);
    setBaseline({ form, avatar: existing.avatar || defaultAvatar });
    setForm(form);
    setAvatar(existing.avatar || defaultAvatar);
  }, [loading, existing]);
  const [form, setForm] = useState<BotInput>(baseline.form);
  const [avatar, setAvatar] = useState<AvatarConfig>(baseline.avatar);
  const actions = useAction();
  const { busy, error, notice, setError, setNotice } = actions;
  const catalogOptions = (kind: "tools" | "skills") => ({ botId: existing?.id, active: tab === kind, supported: bootstrap.capabilities[kind].supported, report: setError });
  const toolsDraft = useCatalogDraft("tools", catalogOptions("tools"));
  const skillsDraft = useCatalogDraft("skills", catalogOptions("skills"));
  const unsaved = JSON.stringify([form, avatar]) !== JSON.stringify([baseline.form, baseline.avatar])
    || toolsDraft.staged || skillsDraft.staged || memoryDirty;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const beforePrompt = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!confirmDiscard) return;
    beforePrompt.current = document.activeElement as HTMLElement | null;
    keepEditing.current?.focus();
  }, [confirmDiscard]);
  // The prompt unmounts its own focused button, so focus goes back to where the reader was.
  const resumeEditing = () => {
    const target = beforePrompt.current;
    setConfirmDiscard(false);
    (target?.isConnected && dialog.current?.contains(target) ? target
      : dialog.current?.querySelector<HTMLElement>("#assistant-settings-title"))?.focus();
  };
  useEffect(() => { if (!unsaved) setConfirmDiscard(false); }, [unsaved]);
  // Escape and the close button both land here, so nothing is discarded without asking.
  const requestClose = () => memorySaving ? undefined : unsaved ? setConfirmDiscard(true) : onClose();
  const routinesResource = useResource(existing && tab === "routines" && bootstrap.capabilities.routines.supported ? routeUrl("GET /routines", {}) : null, { load: (_, signal) => request("GET /routines", { signal }) });
  const routines = (routinesResource.data || []).filter(routine => routine.botId === existing?.id);
  const [confirmModel, setConfirmModel] = useState<string | null>(null);
  // Making a shared or ownerless assistant personal hides it from everyone else, so it asks first.
  const [confirmPersonal, setConfirmPersonal] = useState(false);
  const [personalConfirmed, setPersonalConfirmed] = useState(false);
  const shownError = error || routinesResource.error;
  const [prompt, setPrompt] = useState("");
  const [portraitOperation, setPortraitOperation] = useState<"upload" | "generate" | null>(null);
  const portraitNotice = tab === "avatar" && notice?.startsWith("Portrait ") ? notice : "";
  const portraitNextStep = bootstrap.capabilities.uploads?.supported
    ? bootstrap.capabilities.portraitGeneration?.supported ? "Upload or generate a portrait before saving." : "Upload a portrait before saving."
    : bootstrap.capabilities.portraitGeneration?.supported ? "Generate a portrait before saving." : "Portraits are unavailable. Choose Geometric or Mascot.";
  const portraitPromptLimit = prompt.length > 2000
    ? `The description is ${(prompt.length - 2000).toLocaleString()} character${prompt.length - 2000 === 1 ? "" : "s"} over the ${(2000).toLocaleString()} limit. Shorten the text to generate a portrait.`
    : prompt.length >= 1800 ? `${prompt.length.toLocaleString()} of ${(2000).toLocaleString()} characters` : "";
  // The banner sits above the fold on phones, so each save button reports its own progress.
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(savedTimer.current), []);
  const progress = (key: string) => saving === key ? "saving" : saved === key ? "saved" : undefined;
  const errorBanner = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (shownError) errorBanner.current?.scrollIntoView?.({ block: "nearest" }); }, [shownError]);
  // Each creation step, and the created assistant's first view, starts at the top, where its message is.
  useEffect(() => { dialog.current?.querySelector(".settings-content")?.scrollTo?.(0, 0); }, [step, created]);
  const dialog = useRef<HTMLDialogElement>(null);
  const run = (action: () => Promise<unknown>, success = "Saved", key?: string) => actions.run(async () => {
    if (key) { setSaving(key); setSaved(null); clearTimeout(savedTimer.current); }
    try { await action(); } finally { if (key) setSaving(null); }
    if (key) {
      setSaved(key);
      savedTimer.current = setTimeout(() => setSaved(current => current === key ? null : current), 2500);
    }
    onSaved();
  }, {
    success,
    onError: cause => {
      if (cause instanceof ApiError && cause.code === "private_confirmation_required") { setConfirmPersonal(true); return null; }
      if (cause instanceof ApiError && cause.confirmRequired) { setConfirmModel(cause.message); return null; }
    },
  });
  const createBot = (submitted: BotInput, confirmed: boolean) => actions.run(async () => {
    setSaving("details");
    let saved: Bot;
    try {
      saved = await request("POST /bots", { body: { ...submitted, confirmModel: confirmed } });
      setConfirmModel(null);
    } finally { setSaving(null); }
    const chosen = avatar;
    // Portraits are stored with the assistant, so a portrait is added once it exists.
    const portraitNext = chosen.mode === "portrait" && !chosen.src;
    let failure = "";
    if (!portraitNext) {
      try { await request("PUT /bots/:id/avatar", { params: { id: saved.id }, body: chosen }); }
      catch (e) { failure = (e as Error).message || "The avatar could not be saved."; }
    }
    onSaved();
    if (!failure && !portraitNext) return onClose();
    setCreated(saved);
    setBaseline({ form: submitted, avatar: saved.avatar || defaultAvatar });
    setTab("avatar");
    if (failure) setAvatarFailure(failure);
    else setNotice(`${saved.name} is ready. Upload or generate its portrait here, then save it.`);
  }, { onError: cause => { if (cause instanceof ApiError && cause.confirmRequired) { setConfirmModel(cause.message); return null; } } });
  const saveAvatar = () => void run(async () => {
    const submitted = avatar;
    await request("PUT /bots/:id/avatar", { params: { id: existing!.id }, body: submitted });
    setBaseline((current) => ({ ...current, avatar: submitted }));
    setAvatarFailure("");
  }, "Avatar saved", "avatar");
  const saveBot = (confirmed = false, personal = personalConfirmed) => {
    if (loading) return;
    const submitted = form;
    personal = personal && !submitted.shared;
    if (!existing) return createBot(submitted, confirmed);
    if (existing && !submitted.shared && !(existing.shared === false && existing.ownerId) && !personal) {
      setConfirmPersonal(true);
      return;
    }
    setConfirmPersonal(false);
    setPersonalConfirmed(personal);
    return run(
      async () => {
        await request("PATCH /bots/:id", {
          params: { id: existing.id },
          body: { ...submitted, confirmModel: confirmed, ...(personal ? { confirmPrivate: true } : {}) },
        });
        setConfirmModel(null);
        setBaseline((current) => ({ ...current, form: submitted }));
      },
      submitted.shared
        ? "Changes saved for both household members."
        : "Assistant saved.",
      "details",
    );
  };
  const uploadPortrait = async (file: File | undefined) => {
    if (!file || !existing) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 2_000_000) {
      setError("Choose a PNG, JPEG, or WebP portrait no larger than 2 MB.");
      return;
    }
    setPortraitOperation("upload");
    try { await run(async () => {
      const data = new FormData();
      data.append("file", file);
      // Multipart, so the mapped route is posted with a form body instead of through request().
      const result = await api<ApiResponse<"POST /bots/:id/uploads">>(
        routeUrl("POST /bots/:id/uploads", { id: existing.id }),
        { method: "POST", body: data },
      );
      setAvatar({
        mode: "portrait",
        src: result.url || `/api/files/${encodeURIComponent(result.id)}`,
        origin: "uploaded",
      });
    }, "Portrait ready to save."); } finally { setPortraitOperation(null); }
  };
  const generatePortrait = async () => {
    if (!existing || !prompt.trim() || prompt.length > 2000) return;
    setPortraitOperation("generate");
    try {
      await run(async () => {
        const result = await request("POST /bots/:id/portrait", { params: { id: existing.id }, body: { prompt } });
        setAvatar({ mode: "portrait", src: result.url || `/api/files/${encodeURIComponent(result.id)}`, origin: "generated" });
      }, "Portrait ready to save.");
    } finally { setPortraitOperation(null); }
  };
  const unavailable = (
    key:
      | "botConfiguration"
      | "tools"
      | "skills"
      | "routines"
      | "portraitGeneration"
      | "uploads",
  ) =>
    !bootstrap.capabilities[key].supported ? (
      <p className="capability-note">
        {bootstrap.capabilities[key].reason ||
          "This capability is unavailable from the connected Hermes installation."}
      </p>
    ) : null;
  const selectTab = (section: SettingsTab, fromOverflow = false, discardMemory = false) => {
    if (memorySaving) return;
    if (tab === "memory" && section !== tab && memoryDirty && !discardMemory) {
      if (overflowMenu.current) overflowMenu.current.open = false;
      if (fromOverflow) overflowTrigger.current?.focus();
      setPendingMemoryTab(section); return;
    }
    setTab(section);
    setError("");
    setNotice("");
    if (overflowMenu.current) overflowMenu.current.open = false;
    if (fromOverflow) overflowTrigger.current?.focus();
  };
  return (
    <Dialog
      ref={dialog}
      fallbackFocus={() => [".chat-identity", ".bot-rail [aria-label='Settings']", "[aria-label='Back to assistants']"]
        .map(selector => document.querySelector<HTMLElement>(selector))
        .find(control => control && !control.closest("[inert]")) ?? null}
      className="settings-dialog"
      aria-labelledby="assistant-settings-title"
      onCancel={(event) => {
        if (memorySaving) { event.preventDefault(); return; }
        if (!unsaved) return onClose();
        event.preventDefault();
        setConfirmDiscard(true);
      }}
      onClose={() => {
        // Closing and reopening in one pass, as Strict Mode does, queues an event for a dialog that is open.
        if (dialog.current?.open) return;
        if (memorySaving) { dialog.current?.showModal(); return; }
        // A second Escape can close the dialog without a cancelable event, so put it back.
        if (!unsaved) return onClose();
        dialog.current?.showModal();
        setConfirmDiscard(true);
      }}
    >
      <header>
        <div>
          <p className="eyebrow">{existing ? "Assistant settings" : `New assistant · Step ${step === "look" ? 1 : 2} of 2`}</p>
          <h2 id="assistant-settings-title" tabIndex={-1}>{existing ? savedName : step === "look" ? "Name and look" : "Role and model"}</h2>
        </div>
        <Button
          className="icon-button"
          aria-label="Close assistant settings"
          onClick={requestClose}
          disabled={memorySaving}
        >
          <Icon name="close" />
        </Button>
      </header>
      {loading ? <div className="settings-content settings-load-state">
        <p role={loading.error ? "alert" : "status"}>{loading.error || "Loading assistant settings…"}</p>
        {loading.error && <Button onClick={() => {
          dialog.current?.querySelector<HTMLElement>("#assistant-settings-title")?.focus();
          loading.retry();
        }}>Retry settings</Button>}
      </div> : <>
      {/* Sections that need the assistant to exist appear once it does. */}
      {existing && <nav className={`settings-tabs${compactSettings ? " settings-tabs-mobile" : ""}`} aria-label="Settings sections">
        {(compactSettings ? settingsSections.slice(0, 2) : settingsSections).map((t) => (
          <Button
            type="button"
            aria-current={tab === t ? "page" : undefined}
            key={t}
            disabled={memorySaving}
            onClick={() => selectTab(t)}
          >
            {t}
          </Button>
        ))}
        {compactSettings && <details className="settings-tabs-overflow" ref={overflowMenu}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !overflowMenu.current?.open) return;
            event.preventDefault();
            event.stopPropagation();
            overflowMenu.current.open = false;
            overflowTrigger.current?.focus();
          }}>
          <summary className="settings-more-trigger" ref={overflowTrigger} aria-controls={overflowMenuId}
            aria-current={settingsSections.slice(2).includes(tab) ? "page" : undefined}
            aria-label={settingsSections.slice(2).includes(tab) ? `More settings, ${tab}` : "More settings"}>
            <span>{settingsSections.slice(2).includes(tab) ? tab : "More"}</span><Icon name="chevron" size={16} />
          </summary>
          <div className="settings-more-menu" id={overflowMenuId}>
            {settingsSections.slice(2).map((section) => <Button type="button" key={section} disabled={memorySaving}
              aria-current={tab === section ? "page" : undefined} onClick={() => selectTab(section, true)}>{section}</Button>)}
          </div>
        </details>}
      </nav>}
      <div className="settings-content">
        {shownError && <FormMessage tone="error" ref={errorBanner}>{shownError}</FormMessage>}
        {notice && !portraitNotice && <FormMessage tone="notice">{notice}</FormMessage>}
        {confirmDiscard && (
          <div className="capability-note" role="alert">
            <p>Discard your unsaved changes?</p>
            <div className="actions">
              <Button type="button" className="danger" onClick={onClose}>Discard changes</Button>
              <Button type="button" ref={keepEditing} onClick={resumeEditing}>Keep editing</Button>
            </div>
          </div>
        )}
        {pendingMemoryTab && <SettingsConfirmation title="Leave memory without saving?"
          detail="Your unsaved memory edits will be lost. Save them before leaving if you want to keep them."
          confirmLabel="Discard edits and leave" danger busy={false}
          fallbackFocus={() => dialog.current?.querySelector<HTMLElement>("#assistant-settings-title") ?? null}
          onCancel={() => setPendingMemoryTab(null)}
          onConfirm={() => { const section = pendingMemoryTab; setPendingMemoryTab(null); setMemoryDirty(false); selectTab(section, false, true); }} />}
        {confirmPersonal && existing && <SettingsConfirmation
          title={`Make ${savedName} personal?`}
          detail="It will disappear for the rest of the household, along with its conversation, routines and group chats."
          confirmLabel="Make it personal" danger busy={busy}
          fallbackFocus={() => dialog.current?.querySelector<HTMLElement>("[data-settings-save]:not(:disabled)") ?? dialog.current?.querySelector<HTMLElement>("#assistant-settings-title") ?? null}
          onCancel={() => setConfirmPersonal(false)}
          onConfirm={() => { setConfirmPersonal(false); void saveBot(false, true); }} />}
        {confirmModel && <SettingsConfirmation
          title="Use this model?" detail={confirmModel} confirmLabel="Confirm this model" busy={busy}
          fallbackFocus={() => dialog.current?.querySelector<HTMLElement>("[data-settings-save]:not(:disabled)") ?? dialog.current?.querySelector<HTMLElement>("#assistant-settings-title") ?? null}
          onCancel={() => setConfirmModel(null)}
          onConfirm={() => { setConfirmModel(null); void saveBot(true); }} />}
        {avatarFailure && existing && (
          <div className="capability-note avatar-failure" role="alert">
            <p>{existing.name} was created, but its avatar didn't save: {avatarFailure} Your choice is still here.</p>
            <div className="actions">
              <Button type="button" className="primary" disabled={busy} onClick={saveAvatar}>Retry avatar</Button>
            </div>
          </div>
        )}
        {!existing && step === "look" && (
          <form className="create-look" onSubmit={(e) => {
            e.preventDefault();
            const name = form.name.trim();
            const taken = bootstrap.bots.some((item) => item.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase());
            if (!name || taken) {
              setError(name ? "An assistant with this name already exists. Choose another name." : "Give your assistant a name.");
              dialog.current?.querySelector<HTMLInputElement>("#create-name")?.focus();
              return;
            }
            setError("");
            setStep("role");
            dialog.current?.querySelector<HTMLElement>("#assistant-settings-title")?.focus();
          }}>
            {unavailable("botConfiguration")}
            <label>
              Name
              <Input id="create-name" maxLength={100} autoComplete="off" placeholder="Like Ranch hand or Homework helper"
                value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); setError(""); }} />
            </label>
            <AvatarEditor avatar={avatar} onChange={setAvatar} name={form.name.trim() || "New assistant"}
              portraitControls={avatar.mode === "portrait" && <p className="muted">
                Portraits are stored with the assistant, so you'll upload or generate one right after you create it.</p>} />
            <div className="actions sticky-actions settings-save-actions">
              <Button type="submit" className="primary" aria-label="Next: role and model" disabled={!bootstrap.capabilities.botConfiguration.supported}>Next</Button>
            </div>
          </form>
        )}
        {(existing ? tab === "details" : step === "role") && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveBot();
            }}
          >
            {unavailable("botConfiguration")}
            {existing && <label>
              Name
              <Input
                required
                maxLength={100}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>}
            <label htmlFor="assistant-description">
              <span id="assistant-description-label">Description</span>
              <Textarea id="assistant-description" aria-labelledby="assistant-description-label" rows={2}
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
              />
            </label>
            <label htmlFor="assistant-instructions">
              <span id="assistant-instructions-label">Instructions</span>
              <Textarea id="assistant-instructions" aria-labelledby="assistant-instructions-label"
                rows={7}
                value={form.instructions}
                onChange={(e) =>
                  setForm({ ...form, instructions: e.target.value })
                }
                placeholder="How should this assistant help?"
              />
            </label>
            <div className="interactive-replies-setting"><Button type="button" disabled={busy || form.instructions.includes(interactiveReplyInstructions)}
              onClick={() => setForm({ ...form, instructions: `${form.instructions.trim()}\n\n${interactiveReplyInstructions}`.trim() })}>
              {form.instructions.includes(interactiveReplyInstructions) ? "Interactive replies enabled" : "Enable interactive replies"}</Button>
              <p className="muted">Adds instructions for checklists, itineraries and calendar proposals. Save changes to apply them.</p></div>
            <ModelSelector
              value={{ provider: form.provider || "", model: form.model }}
              profile={existing?.id}
              favorites={bootstrap.preferences.modelFavorites || []}
              disabled={busy || !bootstrap.capabilities.botConfiguration.supported}
              onChange={({ provider, model }) => {
                setForm({ ...form, provider, model });
                setConfirmModel(null);
                setError("");
              }}
              onFavoritesSaved={onSaved}
            />
            <label className="checkbox-label">
              <Input
                type="checkbox"
                checked={form.shared}
                onChange={(e) => setForm({ ...form, shared: e.target.checked })}
              />{" "}
              Shared with your household
            </label>
            <p className="muted">
              {form.shared
                ? "This assistant has one shared model. Provider and model changes are visible to both people."
                : "Only you see a personal assistant in WildBots. Anyone with Hermes dashboard access can still reach its memory and logins."}
            </p>
            <label>
              Enabled existing MCP servers
              <Input
                value={form.enabledMcpServers?.join(", ") || ""}
                onChange={(e) =>
                  setForm({
                    ...form,
                    enabledMcpServers: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="Existing server ids, separated by commas"
              />
            </label>
            <p className="muted">
              Only existing Hermes connections can be configured here.
            </p>
            <div className="actions sticky-actions settings-save-actions">
              {!existing && <Button type="button" disabled={busy} onClick={() => {
                setStep("look"); setError(""); setConfirmModel(null);
                dialog.current?.querySelector<HTMLElement>("#assistant-settings-title")?.focus();
              }}>Back</Button>}
              <Button
                type="submit" data-settings-save
                aria-label={existing ? undefined : busy ? "Creating assistant" : "Create assistant"}
                className="primary with-progress"
                disabled={
                  busy || !form.model || !bootstrap.capabilities.botConfiguration.supported
                }
              >
                {existing ? <SaveProgress state={progress("details")} label="Save changes" />
                  : busy ? <><Icon name="spinner" className="spin" size={16} />Creating…</> : "Create"}
              </Button>
            </div>
              {existing && <div className="settings-danger-zone">
                <DeleteBot
                  bot={{...existing, name:savedName}}
                  busy={busy}
                  supported={bootstrap.capabilities.botConfiguration.supported}
                  remove={() =>
                    void run(async () => {
                      onDeleted?.(existing.id);
                      await request("DELETE /bots/:id", { params: { id: existing.id } });
                      onClose();
                    }, "Assistant deleted")
                  }
                />
              </div>}
          </form>
        )}
        {existing && tab === "avatar" && (
          <>
            <AvatarEditor
              compactPreview
              avatar={avatar}
              onChange={setAvatar}
              name={savedName}
              portraitControls={avatar.mode === "portrait" && (
                <div className="avatar-portrait-group">
                  <p className="muted">
                    Portraits stay still. Activity appears in a separate state
                    indicator.
                  </p>
                  <fieldset className="avatar-portrait-group"><legend>Upload a portrait</legend>
                  <label>
                    Image file
                    <Input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      disabled={busy || !bootstrap.capabilities.uploads.supported}
                      onChange={(e) => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; void uploadPortrait(file); }}
                    />
                  </label>
                  <p className="muted">PNG, JPEG, or WebP, up to 2 MB.</p>
                  {unavailable("uploads")}
                  </fieldset>
                  <fieldset className="avatar-portrait-group"><legend>Generate a portrait</legend>
                  <label>
                    Describe a portrait
                    <Textarea
                      rows={3}
                      aria-describedby={portraitPromptLimit ? "portrait-prompt-count" : undefined}
                      aria-invalid={prompt.length > 2000 || undefined}
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder="Describe the portrait you want…"
                    />
                  </label>
                  {portraitPromptLimit && <p className="portrait-prompt-limit" data-invalid={prompt.length > 2000} id="portrait-prompt-count">{portraitPromptLimit}</p>}
                  <Button
                    disabled={busy || !prompt.trim() || prompt.length > 2000 || !bootstrap.capabilities.portraitGeneration.supported}
                    onClick={() => void generatePortrait()}
                  >
                    Generate portrait
                  </Button>
                  {unavailable("portraitGeneration")}
                  </fieldset>
                </div>
              )}
            />
            {avatar.mode === "portrait" && !avatar.src && <p className="muted">{portraitNextStep}</p>}
            <div className="actions sticky-actions avatar-save-actions">
              <p className="avatar-operation" role="status">{portraitOperation
                ? <><Icon name="spinner" className="spin" size={16} />{portraitOperation === "upload" ? "Uploading portrait…" : "Generating portrait…"}</>
                : portraitNotice}</p>
              <Button
                className="primary with-progress"
                disabled={busy || (avatar.mode === "portrait" && !avatar.src)}
                onClick={saveAvatar}
              >
                <SaveProgress state={progress("avatar")} label="Save avatar" />
              </Button>
            </div>
          </>
        )}
        {existing && (tab === "tools" || tab === "skills") && (() => {
          const draft = tab === "tools" ? toolsDraft : skillsDraft;
          return <CatalogEditor draft={draft} supported={bootstrap.capabilities[tab].supported} note={unavailable(tab)} busy={busy}
            progress={<SaveProgress state={progress(tab)} label={`Save ${tab}`} />}
            onSave={() => void run(() => draft.save(existing.id), "Saved", tab)} />;
        })()}
        {existing && tab === "connections" && <IntegrationList profile={existing.id} bots={bootstrap.bots} accountScope={bootstrap.user.id} />}
        {existing && tab === "work" && <AutomationPanel key={existing.id} botId={existing.id} bots={bootstrap.bots} accountScope={bootstrap.user.id} />}
        {existing && tab === "learning" && <LearningPanel key={existing.id} botId={existing.id} />}
        {existing && tab === "memory" && <MemoryPanel key={existing.id} botId={existing.id} onDirtyChange={setMemoryDirty} onSavingChange={setMemorySaving} />}
        {existing && tab === "logins" && <VaultPanel key={existing.id} botId={existing.id} />}
        {existing && tab === "routines" && (
          <>
            {unavailable("routines")}
              <RoutineManager
                onOpenRoutine={onOpenRoutine}
                botId={existing.id}
                routines={routines}
                reload={routinesResource.reload}
                bootstrap={bootstrap}
                actions={actions}
              />
          </>
        )}
      </div>
      </>}
    </Dialog>
  );
}

function DeleteBot({ bot, busy, supported, remove }: {
  bot: Bot; busy: boolean; supported: boolean; remove(): void;
}) {
  const [confirm, setConfirm] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <Button ref={trigger} className="danger" disabled={busy || !supported} onClick={() => setConfirm(true)}>Delete assistant</Button>
    {confirm && <SettingsConfirmation title={`Delete ${bot.name}?`}
      detail="This deletes the assistant in Hermes and removes its settings from WildBots."
      confirmLabel="Yes, delete" cancelLabel="Keep assistant" danger busy={busy}
      fallbackFocus={() => trigger.current && !trigger.current.disabled ? trigger.current : document.getElementById("assistant-settings-title")}
      onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); remove(); }} />}
  </>;
}
function RoutineManager({
  onOpenRoutine,
  botId,
  routines,
  reload,
  bootstrap,
  actions,
}: {
  onOpenRoutine?: (botId: string, routineId: string) => void;
  botId: string;
  routines: Routine[];
  reload: () => Promise<void>;
  bootstrap: Bootstrap;
  /** The settings sheet's own action, so its error banner and busy state cover routines too. */
  actions: ReturnType<typeof useAction>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const editor = useRef<HTMLFormElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  function focusRoutine(id: string) {
    const button = editButtons.current.get(id);
    button?.scrollIntoView({ block: "nearest" });
    button?.focus({ preventScroll: true });
  }
  const editorId = useId();
  const [focusEditor, setFocusEditor] = useState(false);
  useEffect(() => {
    if (!focusEditor) return;
    editor.current?.scrollIntoView({ block: "start" });
    nameInput.current?.focus({ preventScroll: true });
    setFocusEditor(false);
  }, [focusEditor]);
  const [form, setForm] = useState<Omit<Routine, "id">>({
    botId,
    name: "",
    prompt: "",
    schedule: "",
    enabled: true,
    recipientIds: [],
    contextFrom: ["self"],
  });
  const { busy } = actions;
  const [deleteId, setDeleteId] = useState("");
  const [previewedSchedule, setPreviewedSchedule] = useState("");
  const supported = bootstrap.capabilities.routines.supported;
  // Only its owner can receive a private assistant's results.
  const bot = bootstrap.bots.find((b) => b.id === botId);
  const recipients = bot && !bot.shared && bot.ownerId
    ? bootstrap.household.filter((user) => user.id === bot.ownerId)
    : bootstrap.household;
  const action = (work: () => Promise<unknown>) => actions.run(async () => {
    await work();
    await reload();
  });
  return (
    <div className="routine-manager">
      <p className="muted">
        Routines keep working when you are away. Choose notification recipients
        explicitly.
      </p>
      <h3>Routine recipes</h3>
      <div className="routine-presets" aria-label="Routine recipes">{routinePresets.map(preset => <Button type="button" className="routine-preset" key={preset.id} disabled={busy || !supported}
        onClick={() => { setEditing(null); setPreviewedSchedule(""); setFocusEditor(true); setForm({ botId, name: preset.name, prompt: preset.prompt, schedule: preset.schedule, enabled: false, recipientIds: [bootstrap.user.id], contextFrom: ["self"] }); }}>
        <strong>{preset.name}</strong><small>{preset.description}</small></Button>)}</div>
      {routines.length > 0 && <h3>Saved routines</h3>}
      {routines.map((routine) => (
        <article className="routine-card" key={routine.id}>
          <h4>{routine.name}</h4>
          <dl className="routine-meta"><div><dt>Schedule</dt><dd><code>{routine.schedule}</code></dd></div><div><dt>Status</dt><dd><span className={routine.enabled ? "routine-status" : "routine-status paused"}>{routine.enabled ? "Active" : "Paused"}</span></dd></div></dl>
          <p className="routine-prompt">{routine.prompt}</p>
          <RoutineEnhancements key={`${bootstrap.user.id}:${routine.id}`} routine={routine} userId={bootstrap.user.id} disabled={busy || !supported} onOpenResults={onOpenRoutine ? () => onOpenRoutine(botId, routine.id) : undefined} />
          <div className="actions routine-management-actions">
            <Button
              disabled={busy}
              onClick={() =>
                void action(() =>
                  request("PUT /routines/:id", { params: { id: routine.id }, body: {
                      ...routine,
                      enabled: !routine.enabled,
                      recipientIds: routine.recipientIds || [],
                    } }),
                )
              }
            >
              {routine.enabled ? "Pause" : "Resume"}
            </Button>
            <Button ref={node => { if (node) editButtons.current.set(routine.id, node); else editButtons.current.delete(routine.id); }}
              onClick={() => {
                setEditing(routine.id);
                setFocusEditor(true);
                setPreviewedSchedule("");
                setForm(routine);
              }}
            >
              Edit
            </Button>
            {deleteId === routine.id ? (
              <>
                <Button
                  className="danger"
                  onClick={() =>
                    void action(() =>
                      request("DELETE /routines/:id", { params: { id: routine.id } }),
                    )
                  }
                >
                  Confirm delete
                </Button>
                <Button onClick={() => setDeleteId("")}>Cancel</Button>
              </>
            ) : (
              <Button
                className="danger"
                onClick={() => setDeleteId(routine.id)}
              >
                Delete
              </Button>
            )}
          </div>
        </article>
      ))}
      <form ref={editor} aria-labelledby={`${editorId}-heading`}
        onSubmit={(e) => {
          e.preventDefault();
          if (previewedSchedule !== form.schedule) { actions.setError("Preview the schedule before saving this routine."); return; }
          if (form.noAgent && !form.script?.trim()) { actions.setError("Script-only routines require a profile script."); return; }
          if (!form.prompt.trim() && !form.script?.trim() && !form.skills?.length) { actions.setError("Add instructions, a skill, or a profile script."); return; }
          void action(async () => {
            const body = { ...form, recipientIds: (form.recipientIds || []).filter((id) => recipients.some((user) => user.id === id)) };
            await (editing ? request("PUT /routines/:id", { params: { id: editing }, body }) : request("POST /routines", { body }));
            if (editing) focusRoutine(editing);
            setEditing(null);
            setPreviewedSchedule("");
            setForm({
              botId,
              name: "",
              prompt: "",
              schedule: "",
              enabled: true,
              recipientIds: [],
              contextFrom: ["self"],
            });
          });
        }}
      >
        <h3 id={`${editorId}-heading`}>{editing ? "Edit routine" : "New routine"}</h3>
        <label>
          Name
          <Input ref={nameInput}
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label>
          Instructions
          <Textarea
            required={!form.noAgent && !form.script?.trim() && !form.skills?.length}
            rows={4}
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
          />
        </label>
        <label>
          Schedule
          <Input
            required
            value={form.schedule}
            onChange={(e) => setForm({ ...form, schedule: e.target.value })}
            className="routine-schedule"
            placeholder="Hermes schedule expression"
          />
        </label>
        <RoutineSchedulePreview key={`schedule-${editing || "new"}`} botId={botId} schedule={form.schedule} onReady={setPreviewedSchedule} />
        <AdvancedRoutineFields key={`advanced-${editing ?? "new"}`} value={form} onChange={setForm} routines={routines} editing={editing} />
        <label className="checkbox-label">
          <Input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />{" "}
          Enabled
        </label>
        <fieldset>
          <legend>Notify these household members</legend>
          {recipients.map((user) => (
            <label className="checkbox-label" key={user.id}>
              <Input
                type="checkbox"
                checked={form.recipientIds?.includes(user.id) || false}
                onChange={(e) =>
                  setForm({
                    ...form,
                    recipientIds: e.target.checked
                      ? [...(form.recipientIds || []), user.id]
                      : (form.recipientIds || []).filter(
                          (id) => id !== user.id,
                        ),
                  })
                }
              />
              {user.name}
            </label>
          ))}
        </fieldset>
        <p className="muted">
          No selected recipients means no completion notification. Routine
          results remain in the assistant conversation.
        </p>
        <div className="actions">
          <Button type="submit" className="primary" disabled={busy || !supported || previewedSchedule !== form.schedule || !form.schedule.trim()}>
            {busy ? "Saving…" : editing ? "Save routine" : "Add routine"}
          </Button>
          {editing && (
            <Button
              type="button"
              onClick={() => {
                focusRoutine(editing);
                setEditing(null);
                setPreviewedSchedule("");
                setForm({
                  botId,
                  name: "",
                  prompt: "",
                  schedule: "",
                  enabled: true,
                  recipientIds: [],
                  contextFrom: ["self"],
                });
              }}
            >
              Cancel edit
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

function SaveProgress({ state, label }: { state?: "saving" | "saved"; label: string }) {
  return state === "saving" ? <><Icon name="spinner" className="spin" size={16} />Saving…</>
    : state === "saved" ? <><Icon name="check" size={16} />Saved</> : <>{label}</>;
}

/** Lean roster rows cannot initialize a writable form. */
export function BotSettings(props: Parameters<typeof LoadedBotSettings>[0]) {
  const botId = props.bot === "new" ? undefined : props.bot.id;
  const hasConfiguration = props.bot === "new" || typeof props.bot.instructions === "string";
  const detail = useResource<ApiResponse<"GET /bots/:id">>(botId && !hasConfiguration ? routeUrl("GET /bots/:id", { id: botId }) : null, {
    validate: value => { if (typeof value.instructions !== "string") throw new Error("Assistant settings are incomplete. Try again."); },
  });
  const ready = hasConfiguration || detail.data?.id === botId;
  return <LoadedBotSettings {...props} key={botId ?? "new"}
    bot={detail.data?.id === botId ? detail.data! : props.bot}
    loading={ready ? undefined : { error: detail.error, retry: () => void detail.reload() }} />;
}
