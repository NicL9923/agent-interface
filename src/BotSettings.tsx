import { preparePortrait } from "./portrait-upload";
import { Dialog } from "./components/ui/dialog";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type {
  Avatar as AvatarConfig,
  Bootstrap,
  Bot,
  BotInput,
  Routine,
} from "./shared/types";
import { api, ApiError, request } from "./client-api";
import { routeUrl, type ApiResponse } from "./shared/api";
import { routineRoomChoices, type GroupCatalog } from "./shared/collaboration";
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
import { AutomationPanel, LearningPanel, SkillLocks } from "./components/AutomationPanel";
import { VaultPanel } from "./components/VaultPanel";
import { VoicePicker } from "./components/VoicePicker";
import { RoutineEnhancements, RoutineSchedulePreview } from "./components/RoutineEnhancements";
import { interactiveReplyInstructions } from "./shared/reply-cards";
import { routinePresets } from "./shared/routine-presets";
import { runsHidden, withRunsShown } from "./shared/routine-runs";
import { usePreferenceEdits, type PreferenceEdit } from "./app/use-preference-edits";
import { AdvancedRoutineFields } from "./components/AdvancedRoutineFields";
import "./app/home.css";
const settingsSections = [
  { id: "profile", label: "Profile" },
  { id: "behavior", label: "Behavior" },
  { id: "access", label: "Access" },
  { id: "automation", label: "Automation" },
  { id: "memory", label: "Memory & learning" },
] as const;
type SettingsTab = (typeof settingsSections)[number]["id"];
/** A phone shows the section list first; this is where Back returns. */
type SettingsPlace = SettingsTab | "index";
const sectionLabel = (id: SettingsTab) => settingsSections.find(section => section.id === id)!.label;
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
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function LoadedBotSettings({
  bot,
  bootstrap,
  onClose,
  onSaved,
  onCreated,
  onDeleted,
  onOpenRoutine,
  editPreferences,
  loading,
}: {
  loading?: { error: string; retry(): void };
  bot: Bot | "new";
  bootstrap: Bootstrap;
  onClose: () => void;
  onSaved: () => void;
  /** Called once a new assistant exists, so the app can open its conversation. */
  onCreated?: (botId: string) => void;
  onDeleted?: (botId: string) => void;
  onOpenRoutine?: (botId: string, routineId: string) => void;
  /** Saves this person's preferences, for "Show runs in chat". */
  editPreferences?: (edit: PreferenceEdit) => Promise<void>;
}) {
  // Creating saves the assistant and then its avatar. Once it exists, this same sheet edits it,
  // so an avatar that failed to save is still here to retry.
  const [created, setCreated] = useState<Bot | null>(null);
  const existing = created ?? (bot === "new" ? null : bot);
  const [step, setStep] = useState<"look" | "role">("look");
  const [avatarFailure, setAvatarFailure] = useState("");
  const compactSettings = useCompactSettings();
  const [tab, setTab] = useState<SettingsTab>("profile");
  // On a phone the sheet opens on the section list; wider layouts always show a section.
  const [atIndex, setAtIndex] = useState(true);
  const showingIndex = compactSettings && atIndex;
  const section: SettingsTab | null = existing && !showingIndex ? tab : null;
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [memorySaving, setMemorySaving] = useState(false);
  type Confirmation = { kind: "discard" | "personal" } | { kind: "model"; message: string } | { kind: "memory"; place: SettingsPlace };
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const pendingMemoryPlace = confirmation?.kind === "memory" ? confirmation.place : null;
  const setPendingMemoryPlace = (place: SettingsPlace | null) => setConfirmation(current => place ? { kind: "memory", place } : current?.kind === "memory" ? null : current);
  useEffect(() => { if (!memoryDirty) setPendingMemoryPlace(null); }, [memoryDirty]);
  const advanced = bootstrap.preferences.presentation === "advanced";
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
  const catalogOptions = (kind: "tools" | "skills") => ({ botId: existing?.id, active: section === "behavior", supported: bootstrap.capabilities[kind].supported, report: setError });
  const toolsDraft = useCatalogDraft("tools", catalogOptions("tools"));
  const skillsDraft = useCatalogDraft("skills", catalogOptions("skills"));
  const formDirty = !same(form, baseline.form);
  // An avatar whose first save failed still needs saving, even when it matches the default.
  const avatarDirty = !same(avatar, baseline.avatar) || !!avatarFailure;
  // Everything the one Save changes button sends. Memory keeps its own Save.
  const configDirty = formDirty || avatarDirty || toolsDraft.staged || skillsDraft.staged;
  const unsaved = configDirty || memoryDirty;
  const portraitIncomplete = avatar.mode === "portrait" && !avatar.src;
  const confirmDiscard = confirmation?.kind === "discard";
  const setConfirmDiscard = (show: boolean) => setConfirmation(current => show ? { kind: "discard" } : current?.kind === "discard" ? null : current);
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
  const routinesResource = useResource(existing && section === "automation" && bootstrap.capabilities.routines.supported ? routeUrl("GET /routines", {}) : null, { load: (_, signal) => request("GET /routines", { signal }) });
  const routines = (routinesResource.data || []).filter(routine => routine.botId === existing?.id);
  const confirmModel = confirmation?.kind === "model" ? confirmation.message : null;
  const setConfirmModel = (message: string | null) => setConfirmation(current => message ? { kind: "model", message } : current?.kind === "model" ? null : current);
  // Making a shared or ownerless assistant personal hides it from everyone else, so it asks first.
  const confirmPersonal = confirmation?.kind === "personal";
  const setConfirmPersonal = (show: boolean) => setConfirmation(current => show ? { kind: "personal" } : current?.kind === "personal" ? null : current);
  const [personalConfirmed, setPersonalConfirmed] = useState(false);
  const shownError = error || routinesResource.error;
  const [prompt, setPrompt] = useState("");
  const [portraitOperation, setPortraitOperation] = useState<"upload" | "generate" | null>(null);
  const portraitNotice = section === "profile" && notice?.startsWith("Portrait ") ? notice : "";
  const portraitNextStep = bootstrap.capabilities.uploads?.supported
    ? bootstrap.capabilities.portraitGeneration?.supported ? "Upload or generate a portrait before saving." : "Upload a portrait before saving."
    : bootstrap.capabilities.portraitGeneration?.supported ? "Generate a portrait before saving." : "Portraits are unavailable. Choose Geometric or Mascot.";
  const portraitPromptLimit = prompt.length > 2000
    ? `The description is ${(prompt.length - 2000).toLocaleString()} character${prompt.length - 2000 === 1 ? "" : "s"} over the ${(2000).toLocaleString()} limit. Shorten the text to generate a portrait.`
    : prompt.length >= 1800 ? `${prompt.length.toLocaleString()} of ${(2000).toLocaleString()} characters` : "";
  // The banner sits above the fold on phones, so the save button reports its own progress.
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(savedTimer.current), []);
  const progress = (key: string) => saving === key ? "saving" : saved === key ? "saved" : undefined;
  const errorBanner = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (shownError) errorBanner.current?.scrollIntoView?.({ block: "nearest" }); }, [shownError]);
  // Each creation step, each section, and the created assistant's first view start at the top.
  useEffect(() => { dialog.current?.querySelector(".settings-content")?.scrollTo?.(0, 0); }, [step, created, tab, showingIndex]);
  const dialog = useRef<HTMLDialogElement>(null);
  // Focus moves to the name only once Profile, which holds it, has rendered.
  const [focusName, setFocusName] = useState(0);
  useEffect(() => { if (focusName) dialog.current?.querySelector<HTMLInputElement>("#assistant-name")?.focus(); }, [focusName]);
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
    setSaving("config");
    let saved: Bot;
    try {
      saved = await request("POST /bots", { body: { ...submitted, confirmModel: confirmed } });
      setConfirmModel(null);
    } finally { setSaving(null); }
    onCreated?.(saved.id);
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
    setTab("profile");
    setAtIndex(false);
    if (failure) setAvatarFailure(failure);
    else setNotice(`${saved.name} is ready. Upload or generate its portrait here, then save it.`);
  }, { onError: cause => { if (cause instanceof ApiError && cause.confirmRequired) { setConfirmModel(cause.message); return null; } } });
  /**
   * Saves every unsaved part of the configuration in turn. Each part that saves becomes its new
   * baseline, so after a failure, saving again sends only what is still unsaved.
   */
  const saveChanges = (confirmed = false, personal = personalConfirmed) => {
    if (loading) return;
    if (!existing) return createBot(form, confirmed);
    if (!configDirty || portraitIncomplete) return;
    const submitted = form;
    // Save changes sits outside the Profile form, so its required name is checked here.
    if (formDirty && !submitted.name.trim()) {
      // Moving to Profile clears messages, so the reason is set after it.
      if (section !== "profile") go("profile");
      setError("Give your assistant a name.");
      setFocusName(count => count + 1);
      return;
    }
    personal = personal && !submitted.shared;
    if (formDirty && !submitted.shared && !(existing.shared === false && existing.ownerId) && !personal) {
      setConfirmPersonal(true);
      return;
    }
    setConfirmPersonal(false);
    setPersonalConfirmed(personal);
    const chosenAvatar = avatar;
    return run(
      async () => {
        if (formDirty) {
          await request("PATCH /bots/:id", {
            params: { id: existing.id },
            body: { ...submitted, confirmModel: confirmed, ...(personal ? { confirmPrivate: true } : {}) },
          });
          setConfirmModel(null);
          setBaseline((current) => ({ ...current, form: submitted }));
        }
        if (avatarDirty) {
          await request("PUT /bots/:id/avatar", { params: { id: existing.id }, body: chosenAvatar });
          setBaseline((current) => ({ ...current, avatar: chosenAvatar }));
          setAvatarFailure("");
        }
        if (toolsDraft.staged) await toolsDraft.save(existing.id);
        if (skillsDraft.staged) await skillsDraft.save(existing.id);
      },
      !formDirty ? "Saved" : submitted.shared ? "Changes saved for both household members." : "Assistant saved.",
      "config",
    );
  };
  const uploadPortrait = async (file: File | undefined) => {
    if (!file || !existing) return;
    setPortraitOperation("upload");
    try { await run(async () => {
      const data = new FormData();
      data.append("file", await preparePortrait(file));
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
  const focusTitle = () => dialog.current?.querySelector<HTMLElement>("#assistant-settings-title")?.focus();
  const go = (place: SettingsPlace, discardMemory = false) => {
    if (memorySaving) return;
    const current: SettingsPlace = showingIndex ? "index" : tab;
    if (current === "memory" && place !== current && memoryDirty && !discardMemory) { setPendingMemoryPlace(place); return; }
    if (place === "index") setAtIndex(true);
    else { setTab(place); setAtIndex(false); }
    setError("");
    setNotice("");
    // A phone replaces the whole view, so focus starts again at its heading.
    if (compactSettings) requestAnimationFrame(focusTitle);
  };
  const summaries: Record<SettingsTab, string> = {
    profile: form.shared ? "Shared with your household" : "Personal",
    behavior: existing?.modelName || form.model || "No model chosen",
    access: "Connections and logins",
    automation: "Routines, goals, tasks and triggers",
    memory: "What it remembers and learns",
  };
  const mcpServers = [...new Set([...(existing?.availableMcpServers ?? []), ...(form.enabledMcpServers ?? [])])].sort();
  // Profile and Behavior always offer Save; elsewhere, the phone's section list included, it appears
  // once there is something to save, so leaving a section never hides unsaved changes.
  const saveBarShown = !!existing && (section === "profile" || section === "behavior" || configDirty);
  const submitChanges = (event: FormEvent) => { event.preventDefault(); void saveChanges(); };
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
        {existing && compactSettings && !atIndex && !loading && (
          <Button className="icon-button settings-back" aria-label="All settings" disabled={memorySaving} onClick={() => go("index")}>
            <Icon name="back" />
          </Button>
        )}
        <div>
          <p className="eyebrow">{!existing ? `New assistant · Step ${step === "look" ? 1 : 2} of 2` : compactSettings && !atIndex ? savedName : "Assistant settings"}</p>
          <h2 id="assistant-settings-title" tabIndex={-1}>{!existing ? step === "look" ? "Name and look" : "Role and model" : compactSettings && !atIndex ? sectionLabel(tab) : savedName}</h2>
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
          focusTitle();
          loading.retry();
        }}>Retry settings</Button>}
      </div> : <>
      {/* Sections need the assistant to exist, so they appear once it does. */}
      {existing && !compactSettings && <nav className="settings-tabs" aria-label="Settings sections">
        {settingsSections.map(({ id, label }) => (
          <Button
            type="button"
            aria-current={tab === id ? "page" : undefined}
            key={id}
            disabled={memorySaving}
            onClick={() => go(id)}
          >
            {label}
          </Button>
        ))}
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
        {pendingMemoryPlace && <SettingsConfirmation title="Leave memory without saving?"
          detail="Your unsaved memory edits will be lost. Save them before leaving if you want to keep them."
          confirmLabel="Discard edits and leave" danger busy={false}
          fallbackFocus={() => dialog.current?.querySelector<HTMLElement>("#assistant-settings-title") ?? null}
          onCancel={() => setPendingMemoryPlace(null)}
          onConfirm={() => { const place = pendingMemoryPlace; setPendingMemoryPlace(null); setMemoryDirty(false); go(place, true); }} />}
        {confirmPersonal && existing && <SettingsConfirmation
          title={`Make ${savedName} personal?`}
          detail="It will disappear for the rest of the household, along with its conversation, routines and group chats."
          confirmLabel="Make it personal" danger busy={busy}
          fallbackFocus={() => dialog.current?.querySelector<HTMLElement>("[data-settings-save]:not(:disabled)") ?? dialog.current?.querySelector<HTMLElement>("#assistant-settings-title") ?? null}
          onCancel={() => setConfirmPersonal(false)}
          onConfirm={() => { setConfirmPersonal(false); void saveChanges(false, true); }} />}
        {confirmModel && <SettingsConfirmation
          title="Use this model?" detail={confirmModel} confirmLabel="Confirm this model" busy={busy}
          fallbackFocus={() => dialog.current?.querySelector<HTMLElement>("[data-settings-save]:not(:disabled)") ?? dialog.current?.querySelector<HTMLElement>("#assistant-settings-title") ?? null}
          onCancel={() => setConfirmModel(null)}
          onConfirm={() => { setConfirmModel(null); void saveChanges(true); }} />}
        {avatarFailure && existing && (
          <div className="capability-note avatar-failure" role="alert">
            <p>{existing.name} was created, but its avatar didn't save: {avatarFailure} Your choice is still here.</p>
            <div className="actions">
              <Button type="button" className="primary" disabled={busy} onClick={() => void saveChanges()}>Retry avatar</Button>
            </div>
          </div>
        )}
        {existing && showingIndex && (
          <nav aria-label="Settings sections" className="settings-index">
            <div className="settings-group">
              {settingsSections.map(({ id, label }) => (
                <Button type="button" className="settings-row" key={id} disabled={memorySaving} onClick={() => go(id)}>
                  <span className="row-text"><span className="row-label">{label}</span><small>{summaries[id]}</small></span>
                  <Icon name="chevron" size={18} className="row-chevron" />
                </Button>
              ))}
            </div>
          </nav>
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
            focusTitle();
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
        {!existing && step === "role" && (
          <form onSubmit={submitChanges}>
            {unavailable("botConfiguration")}
            <DescriptionField form={form} setForm={setForm} />
            <BehaviorFields form={form} setForm={setForm} busy={busy} profile={undefined} bootstrap={bootstrap}
              onModelChange={() => { setConfirmModel(null); setError(""); }} onFavoritesSaved={onSaved} />
            <SharingField form={form} setForm={setForm} />
            <div className="actions sticky-actions settings-save-actions">
              <Button type="button" disabled={busy} onClick={() => {
                setStep("look"); setError(""); setConfirmModel(null);
                focusTitle();
              }}>Back</Button>
              <Button
                type="submit" data-settings-save
                aria-label={busy ? "Creating assistant" : "Create assistant"}
                className="primary with-progress"
                disabled={busy || !form.model || !bootstrap.capabilities.botConfiguration.supported}
              >
                {busy ? <><Icon name="spinner" className="spin" size={16} />Creating…</> : "Create"}
              </Button>
            </div>
          </form>
        )}
        {existing && section === "profile" && (
          <form onSubmit={submitChanges} className="settings-profile">
            {unavailable("botConfiguration")}
            <label>
              Name
              <Input
                id="assistant-name"
                required
                maxLength={100}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <DescriptionField form={form} setForm={setForm} />
            <SharingField form={form} setForm={setForm} />
            <h2 className="settings-profile-heading">Avatar</h2>
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
                  <p className="muted">PNG, JPEG, or WebP, up to 15 MB.</p>
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
            <div className="settings-profile-group">
              <VoicePicker key={existing.id} botId={existing.id} name={savedName} voice={existing.voice}
                liveVoice={bootstrap.capabilities.liveVoice} onSaved={() => { setNotice(""); onSaved(); }} />
            </div>
            <div className="settings-danger-zone">
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
            </div>
          </form>
        )}
        {existing && section === "behavior" && (
          <form onSubmit={submitChanges}>
            {unavailable("botConfiguration")}
            <BehaviorFields form={form} setForm={setForm} busy={busy} profile={existing.id} bootstrap={bootstrap}
              onModelChange={() => { setConfirmModel(null); setError(""); }} onFavoritesSaved={onSaved} />
            <CatalogEditor draft={toolsDraft} supported={bootstrap.capabilities.tools.supported} note={unavailable("tools")} busy={busy} />
            <SkillLocks botId={existing.id}>{(extras, messages) =>
              <CatalogEditor draft={skillsDraft} supported={bootstrap.capabilities.skills.supported} note={<>{unavailable("skills")}{messages}</>}
                busy={busy} extras={extras} />}</SkillLocks>
          </form>
        )}
        {existing && section === "access" && <>
          <section className="settings-section" aria-labelledby="settings-connections-heading">
            <h2 id="settings-connections-heading">Connections</h2>
            <IntegrationList profile={existing.id} bots={bootstrap.bots} accountScope={bootstrap.user.id} />
          </section>
          <section className="settings-section"><VaultPanel key={existing.id} botId={existing.id} /></section>
          {advanced && <section className="settings-section mcp-servers" role="group" aria-labelledby="settings-mcp-heading">
            <h2 id="settings-mcp-heading">MCP servers</h2>
            <p className="muted">Turn on the MCP servers this assistant may use. Save changes to apply them.</p>
            {mcpServers.length ? <div className="capability-list">{mcpServers.map(name => (
              <label className="capability-item" key={name}>
                <Input type="checkbox" checked={form.enabledMcpServers?.includes(name) ?? false} disabled={busy || !bootstrap.capabilities.botConfiguration.supported}
                  onChange={event => setForm({ ...form, enabledMcpServers: event.target.checked
                    ? [...(form.enabledMcpServers ?? []), name] : (form.enabledMcpServers ?? []).filter(id => id !== name) })} />
                <span><strong>{name}</strong>{!existing.availableMcpServers?.includes(name) && existing.availableMcpServers && <small>Saved, but Hermes no longer reports it</small>}</span>
              </label>
            ))}</div> : <p className="muted">No MCP servers are configured for this assistant. Add one under Connections.</p>}
          </section>}
        </>}
        {existing && section === "automation" && <>
          <section className="settings-section" aria-labelledby="settings-routines-heading">
            <h2 id="settings-routines-heading">Routines</h2>
            {unavailable("routines")}
            <RoutineManager
              onOpenRoutine={onOpenRoutine}
              botId={existing.id}
              routines={routines}
              reload={routinesResource.reload}
              bootstrap={bootstrap}
              actions={actions}
              editPreferences={editPreferences}
              advanced={advanced}
            />
          </section>
          <section className="settings-section"><AutomationPanel key={existing.id} botId={existing.id} bots={bootstrap.bots} accountScope={bootstrap.user.id} routines={routinesResource} /></section>
        </>}
        {existing && section === "memory" && <>
          <section className="settings-section"><MemoryPanel key={existing.id} botId={existing.id} onDirtyChange={setMemoryDirty} onSavingChange={setMemorySaving} /></section>
          <section className="settings-section"><LearningPanel key={existing.id} botId={existing.id} advanced={advanced} /></section>
        </>}
        {saveBarShown && existing && (
          <div className="actions sticky-actions settings-save-actions">
            <p className="avatar-operation" role="status">{portraitOperation
              ? <><Icon name="spinner" className="spin" size={16} />{portraitOperation === "upload" ? "Uploading portrait…" : "Generating portrait…"}</>
              : portraitNotice || (portraitIncomplete ? portraitNextStep : "")}</p>
            <Button
              type="button" data-settings-save
              className="primary with-progress"
              disabled={busy || !configDirty || portraitIncomplete || !form.model || !bootstrap.capabilities.botConfiguration.supported}
              onClick={() => void saveChanges()}
            >
              <SaveProgress state={progress("config")} label="Save changes" />
            </Button>
          </div>
        )}
      </div>
      </>}
    </Dialog>
  );
}

function DescriptionField({ form, setForm }: { form: BotInput; setForm: (form: BotInput) => void }) {
  return <label htmlFor="assistant-description">
    <span id="assistant-description-label">Description</span>
    <Textarea id="assistant-description" aria-labelledby="assistant-description-label" rows={2}
      value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
  </label>;
}

function SharingField({ form, setForm }: { form: BotInput; setForm: (form: BotInput) => void }) {
  return <>
    <label className="checkbox-label">
      <Input type="checkbox" checked={form.shared} onChange={(e) => setForm({ ...form, shared: e.target.checked })} />{" "}
      Shared with your household
    </label>
    <p className="muted">
      {form.shared
        ? "This assistant has one shared model. Provider and model changes are visible to both people."
        : "Only you see a personal assistant in WildBots. Anyone with Hermes dashboard access can still reach its memory and logins."}
    </p>
  </>;
}

/** Instructions and model, shared by creation's second step and the Behavior section. */
function BehaviorFields({ form, setForm, busy, profile, bootstrap, onModelChange, onFavoritesSaved }: {
  form: BotInput; setForm: (form: BotInput) => void; busy: boolean; profile: string | undefined; bootstrap: Bootstrap;
  onModelChange: () => void; onFavoritesSaved: () => void;
}) {
  return <>
    <label htmlFor="assistant-instructions">
      <span id="assistant-instructions-label">Instructions</span>
      <Textarea id="assistant-instructions" aria-labelledby="assistant-instructions-label" rows={7}
        value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })}
        placeholder="How should this assistant help?" />
    </label>
    <div className="interactive-replies-setting"><Button type="button" disabled={busy || form.instructions.includes(interactiveReplyInstructions)}
      onClick={() => setForm({ ...form, instructions: `${form.instructions.trim()}\n\n${interactiveReplyInstructions}`.trim() })}>
      {form.instructions.includes(interactiveReplyInstructions) ? "Interactive replies enabled" : "Enable interactive replies"}</Button>
      <p className="muted">Adds instructions for checklists, itineraries and calendar proposals. Save changes to apply them.</p></div>
    <ModelSelector
      value={{ provider: form.provider || "", model: form.model }}
      profile={profile}
      favorites={bootstrap.preferences.modelFavorites || []}
      disabled={busy || !bootstrap.capabilities.botConfiguration.supported}
      onChange={({ provider, model }) => { setForm({ ...form, provider, model }); onModelChange(); }}
      onFavoritesSaved={onFavoritesSaved}
    />
  </>;
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
  editPreferences,
  advanced,
}: {
  onOpenRoutine?: (botId: string, routineId: string) => void;
  editPreferences?: (edit: PreferenceEdit) => Promise<void>;
  /** Advanced presentation shows per-routine overrides; Simple keeps them as saved. */
  advanced: boolean;
  botId: string;
  routines: Routine[];
  reload: () => Promise<void>;
  bootstrap: Bootstrap;
  /** The settings sheet's own action, so its error banner and busy state cover routines too. */
  actions: ReturnType<typeof useAction>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  // Showing runs in chat is this person's view of the conversation, not part of the routine.
  const [preferences, commitPreferences] = usePreferenceEdits(bootstrap.preferences, editPreferences ?? (async () => {}));
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
    roomIds: [],
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
  // Group chats a routine can post in. A routine whose rooms the server could not read has no roomIds,
  // and so does a form while the catalog loads: neither shows nor sends rooms, so a save never drops one.
  const groups = useResource<GroupCatalog>(supported ? "/groups" : null);
  const roomChoices = routineRoomChoices(groups.data, bot, bootstrap.bots);
  const roomNames = (ids: string[] = []) => ids.map(id => groups.data?.rooms.find(room => room.room_id === id)?.name).filter(Boolean).join(", ");
  const roomsShown = !!groups.data?.routineDelivery && form.roomIds !== undefined && (roomChoices.length > 0 || form.roomIds.length > 0);
  return (
    <div className="routine-manager">
      <p className="muted">
        Routines keep working when you are away. Choose notification recipients
        explicitly.
      </p>
      <h3>Routine recipes</h3>
      <div className="routine-presets" aria-label="Routine recipes">{routinePresets.map(preset => <Button type="button" className="routine-preset" key={preset.id} disabled={busy || !supported}
        onClick={() => { setEditing(null); setPreviewedSchedule(""); setFocusEditor(true); setForm({ botId, name: preset.name, prompt: preset.prompt, schedule: preset.schedule, enabled: false, recipientIds: [bootstrap.user.id], roomIds: [], contextFrom: ["self"] }); }}>
        <strong>{preset.name}</strong><small>{preset.description}</small></Button>)}</div>
      {routines.length > 0 && <h3>Saved routines</h3>}
      {routines.map((routine) => (
        <article className="routine-card" key={routine.id}>
          <h4>{routine.name}</h4>
          <dl className="routine-meta"><div><dt>Schedule</dt><dd><code>{routine.schedule}</code></dd></div><div><dt>Status</dt><dd><span className={routine.enabled ? "routine-status" : "routine-status paused"}>{routine.enabled ? "Active" : "Paused"}</span></dd></div>
            {roomNames(routine.roomIds) && <div><dt>Posts in</dt><dd>{roomNames(routine.roomIds)}</dd></div>}</dl>
          <p className="routine-prompt">{routine.prompt}</p>
          <RoutineEnhancements key={`${bootstrap.user.id}:${routine.id}`} routine={routine} userId={bootstrap.user.id} disabled={busy || !supported} onOpenResults={onOpenRoutine ? () => onOpenRoutine(botId, routine.id) : undefined} />
          {editPreferences && <label className="checkbox-label routine-chat-toggle">
            <Input type="checkbox" checked={!runsHidden(preferences, botId, routine.id)}
              onChange={event => { const shown = event.target.checked; commitPreferences(value => withRunsShown(value, botId, routine.id, shown)); }} />
            <span>Show runs in chat<small className="muted">Each run appears in {bootstrap.bots.find(bot => bot.id === botId)?.name ?? "this assistant"}'s conversation for you.</small></span>
          </label>}
          <div className="actions routine-management-actions">
            <Button
              disabled={busy}
              onClick={() =>
                void action(() =>
                  request("PUT /routines/:id", { params: { id: routine.id }, body: {
                      ...routine,
                      enabled: !routine.enabled,
                      recipientIds: routine.recipientIds || [],
                      // Pausing leaves where it posts alone.
                      roomIds: undefined,
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
            const body = { ...form, recipientIds: (form.recipientIds || []).filter((id) => recipients.some((user) => user.id === id)),
              roomIds: roomsShown ? form.roomIds!.filter(id => roomChoices.some(room => room.room_id === id)) : undefined };
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
              roomIds: [],
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
        {advanced && <AdvancedRoutineFields key={`advanced-${editing ?? "new"}`} value={form} onChange={setForm} routines={routines} editing={editing} />}
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
        {roomsShown && <>
          <fieldset>
            <legend>Also post results in these group chats</legend>
            {roomChoices.map(room => (
              <label className="checkbox-label" key={room.room_id}>
                <Input type="checkbox" checked={form.roomIds!.includes(room.room_id)}
                  onChange={event => setForm({ ...form, roomIds: event.target.checked
                    ? [...form.roomIds!, room.room_id] : form.roomIds!.filter(id => id !== room.room_id) })} />
                {room.name}
              </label>
            ))}
          </fieldset>
          <p className="muted">Results appear in the group as a message from this routine. Assistants answer it only when it @mentions them.</p>
        </>}
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
                  roomIds: [],
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
