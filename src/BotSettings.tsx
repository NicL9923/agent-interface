import { preparePortrait } from "./portrait-upload";
import { savedPreferences } from "./app/main-assistant";
import { Dialog } from "./components/ui/dialog";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { stayAlso, useCloseRequest, type SheetClose } from "./app/close-request";
import type { Avatar as AvatarConfig, Bootstrap, Bot } from "./shared/types";
import { defaultHarness, harnessLabel, harnessOf, type BotForm } from "./app/harness";
import { api, ApiError, request } from "./client-api";
import { routeUrl, type ApiResponse } from "./shared/api";
import { useAction } from "./app/use-action";
import { useCatalogDraft } from "./app/use-catalog-draft";
import { useResource } from "./app/use-resource";
import { CatalogEditor } from "./components/CatalogEditor";
import { SettingsConfirmation } from "./components/SettingsConfirmation";
import { FormMessage } from "./components/ui/form-message";
import { Icon } from "./components/Icon";
import { defaultAvatar } from "./components/Avatar";
import { AvatarEditor } from "./components/AvatarEditor";
import { MemoryPanel } from "./components/MemoryPanel";
import { LearningPanel, SkillLocks } from "./components/automation/SkillsLearning";
import { ApprovalSettingsPanel } from "./components/ApprovalSettingsPanel";
import { VaultPanel } from "./components/VaultPanel";
import { VoicePicker } from "./components/VoicePicker";
import type { PreferenceEdit } from "./app/use-preference-edits";
import "./app/home.css";
import {
  BehaviorFields,
  DeleteBot,
  DescriptionField,
  SaveProgress,
  SharingField,
} from "./app/bot-settings/BotFields";
import { RoutineManager } from "./app/bot-settings/RoutineManager";
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
const sectionLabel = (id: SettingsTab) =>
  settingsSections.find((section) => section.id === id)!.label;
/**
 * A lean roster row lacks some fields, so each one has a safe default. A missing bot takes the first
 * one's model and the first harness the server offers.
 */
function formFromBot(bot: Bot | null, boot: Bootstrap): BotForm {
  const modelSource = bot?.model ? bot : boot.bots[0];
  return {
    harness: bot ? harnessOf(bot) : defaultHarness(boot),
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
  const [compact, setCompact] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
  );
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
  closer,
}: {
  loading?: { error: string; retry(): void };
  /** Where this sheet offers its own close to the app. See close-request.ts. */
  closer?: RefObject<SheetClose | null>;
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
  type Confirmation =
    | { kind: "discard" | "personal" | "main" }
    | { kind: "model"; message: string }
    | { kind: "memory"; place: SettingsPlace };
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const pendingMemoryPlace = confirmation?.kind === "memory" ? confirmation.place : null;
  const setPendingMemoryPlace = (place: SettingsPlace | null) =>
    setConfirmation((current) =>
      place ? { kind: "memory", place } : current?.kind === "memory" ? null : current,
    );
  useEffect(() => {
    if (!memoryDirty) setPendingMemoryPlace(null);
  }, [memoryDirty]);
  const advanced = bootstrap.preferences.presentation === "advanced";
  // What the form and avatar last matched on the server; saves move it forward.
  const [baseline, setBaseline] = useState<{ form: BotForm; avatar: AvatarConfig }>(() => ({
    form: formFromBot(existing, bootstrap),
    avatar: existing?.avatar || defaultAvatar,
  }));
  const savedName = baseline.form.name || existing?.name || "";
  // The dialog stays mounted while detail loads; only authoritative detail seeds the form.
  const wasLoading = useRef(!!loading);
  useEffect(() => {
    if (loading) {
      wasLoading.current = true;
      return;
    }
    if (!wasLoading.current || !existing) return;
    wasLoading.current = false;
    const form = formFromBot(existing, bootstrap);
    setBaseline({ form, avatar: existing.avatar || defaultAvatar });
    setForm(form);
    setAvatar(existing.avatar || defaultAvatar);
  }, [loading, existing]);
  const [form, setForm] = useState<BotForm>(baseline.form);
  const [avatar, setAvatar] = useState<AvatarConfig>(baseline.avatar);
  const actions = useAction();
  const { busy, error, notice, setError, setNotice } = actions;
  const catalogOptions = (kind: "tools" | "skills") => ({
    botId: existing?.id,
    active: section === "behavior",
    supported: bootstrap.capabilities[kind].supported,
    report: setError,
  });
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
  const setConfirmDiscard = (show: boolean) =>
    setConfirmation((current) =>
      show ? { kind: "discard" } : current?.kind === "discard" ? null : current,
    );
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
    (target?.isConnected && dialog.current?.contains(target)
      ? target
      : dialog.current?.querySelector<HTMLElement>("#assistant-settings-title")
    )?.focus();
  };
  useEffect(() => {
    if (!unsaved) setConfirmDiscard(false);
  }, [unsaved]);
  // Escape and the close button both land here, so nothing is discarded without asking.
  const requestClose = () =>
    memorySaving ? undefined : unsaved ? setConfirmDiscard(true) : onClose();
  // The app asks too, as when a notification is tapped: the same question, and if the person keeps
  // editing, whatever asked does not go ahead. Saving clears the question the same way.
  const stay = useRef<(() => void) | null>(null);
  useCloseRequest(closer, (onStay) => {
    if (memorySaving) return onStay();
    if (!unsaved) return onClose();
    stay.current = stayAlso(stay.current, onStay);
    setConfirmDiscard(true);
  });
  useEffect(() => {
    if (confirmDiscard || !stay.current) return;
    const kept = stay.current;
    stay.current = null;
    kept();
  }, [confirmDiscard]);
  const routinesResource = useResource(
    existing && section === "automation" && bootstrap.capabilities.routines.supported
      ? routeUrl("GET /routines", {})
      : null,
    { load: (_, signal) => request("GET /routines", { signal }) },
  );
  const routines = (routinesResource.data || []).filter(
    (routine) => routine.botId === existing?.id,
  );
  const confirmModel = confirmation?.kind === "model" ? confirmation.message : null;
  const setConfirmModel = (message: string | null) =>
    setConfirmation((current) =>
      message ? { kind: "model", message } : current?.kind === "model" ? null : current,
    );
  // Making a shared or ownerless assistant personal hides it from everyone else, so it asks first.
  const confirmPersonal = confirmation?.kind === "personal";
  const setConfirmPersonal = (show: boolean) =>
    setConfirmation((current) =>
      show ? { kind: "personal" } : current?.kind === "personal" ? null : current,
    );
  const [personalConfirmed, setPersonalConfirmed] = useState(false);
  const shownError = error || routinesResource.error;
  const [prompt, setPrompt] = useState("");
  const [portraitOperation, setPortraitOperation] = useState<"upload" | "generate" | null>(null);
  const portraitNotice = section === "profile" && notice?.startsWith("Portrait ") ? notice : "";
  const portraitNextStep = bootstrap.capabilities.uploads?.supported
    ? bootstrap.capabilities.portraitGeneration?.supported
      ? "Upload or generate a portrait before saving."
      : "Upload a portrait before saving."
    : bootstrap.capabilities.portraitGeneration?.supported
      ? "Generate a portrait before saving."
      : "Portraits are unavailable. Choose Geometric or Mascot.";
  const portraitPromptLimit =
    prompt.length > 2000
      ? `The description is ${(prompt.length - 2000).toLocaleString()} character${prompt.length - 2000 === 1 ? "" : "s"} over the ${(2000).toLocaleString()} limit. Shorten the text to generate a portrait.`
      : prompt.length >= 1800
        ? `${prompt.length.toLocaleString()} of ${(2000).toLocaleString()} characters`
        : "";
  // The banner sits above the fold on phones, so the save button reports its own progress.
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(savedTimer.current), []);
  const progress = (key: string) =>
    saving === key ? "saving" : saved === key ? "saved" : undefined;
  const errorBanner = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (shownError) errorBanner.current?.scrollIntoView?.({ block: "nearest" });
  }, [shownError]);
  // Each creation step, each section, and the created assistant's first view start at the top.
  useEffect(() => {
    dialog.current?.querySelector(".settings-content")?.scrollTo?.(0, 0);
  }, [step, created, tab, showingIndex]);
  const dialog = useRef<HTMLDialogElement>(null);
  // Focus moves to the name only once Profile, which holds it, has rendered.
  const [focusName, setFocusName] = useState(0);
  useEffect(() => {
    if (focusName) dialog.current?.querySelector<HTMLInputElement>("#assistant-name")?.focus();
  }, [focusName]);
  const run = (action: () => Promise<unknown>, success = "Saved", key?: string) =>
    actions.run(
      async () => {
        if (key) {
          setSaving(key);
          setSaved(null);
          clearTimeout(savedTimer.current);
        }
        try {
          await action();
        } finally {
          if (key) setSaving(null);
        }
        if (key) {
          setSaved(key);
          savedTimer.current = setTimeout(
            () => setSaved((current) => (current === key ? null : current)),
            2500,
          );
        }
        onSaved();
      },
      {
        success,
        onError: (cause) => {
          if (cause instanceof ApiError && cause.code === "private_confirmation_required") {
            setConfirmPersonal(true);
            return null;
          }
          if (cause instanceof ApiError && cause.code === "main_share_confirmation_required") {
            setConfirmation({ kind: "main" });
            return null;
          }
          if (cause instanceof ApiError && cause.confirmRequired) {
            setConfirmModel(cause.message);
            return null;
          }
          // Sharing ended this assistant being main before Hermes refused; reload so the screen shows that, beside the message.
          if (savedPreferences(cause)) onSaved();
        },
      },
    );
  const createBot = (submitted: BotForm, confirmed: boolean) =>
    actions.run(
      async () => {
        setSaving("config");
        let saved: Bot;
        try {
          saved = await request("POST /bots", { body: { ...submitted, confirmModel: confirmed } });
          setConfirmModel(null);
        } finally {
          setSaving(null);
        }
        onCreated?.(saved.id);
        const chosen = avatar;
        // Portraits are stored with the assistant, so a portrait is added once it exists.
        const portraitNext = chosen.mode === "portrait" && !chosen.src;
        let failure = "";
        if (!portraitNext) {
          try {
            await request("PUT /bots/:id/avatar", { params: { id: saved.id }, body: chosen });
          } catch (e) {
            failure = (e as Error).message || "The avatar could not be saved.";
          }
        }
        onSaved();
        if (!failure && !portraitNext) return onClose();
        setCreated(saved);
        setBaseline({ form: submitted, avatar: saved.avatar || defaultAvatar });
        setTab("profile");
        setAtIndex(false);
        if (failure) setAvatarFailure(failure);
        else
          setNotice(`${saved.name} is ready. Upload or generate its portrait here, then save it.`);
      },
      {
        onError: (cause) => {
          if (cause instanceof ApiError && cause.confirmRequired) {
            setConfirmModel(cause.message);
            return null;
          }
        },
      },
    );
  /**
   * Saves every unsaved part of the configuration in turn. Each part that saves becomes its new
   * baseline, so after a failure, saving again sends only what is still unsaved.
   */
  const saveChanges = (confirmed = false, personal = personalConfirmed, mainCleared = false) => {
    if (loading) return;
    if (!existing) return createBot(form, confirmed);
    if (!configDirty || portraitIncomplete) return;
    const submitted = form;
    // The harness goes only when it changed: on a new server, sending it starts a fresh session.
    const { harness, ...fields } = submitted;
    const harnessChange = harness !== baseline.form.harness ? { harness } : {};
    // Save changes sits outside the Profile form, so its required name is checked here.
    if (formDirty && !submitted.name.trim()) {
      // Moving to Profile clears messages, so the reason is set after it.
      if (section !== "profile") go("profile");
      setError("Give your assistant a name.");
      setFocusName((count) => count + 1);
      return;
    }
    personal = personal && !submitted.shared;
    if (
      formDirty &&
      !submitted.shared &&
      !(existing.shared === false && existing.ownerId) &&
      !personal
    ) {
      setConfirmPersonal(true);
      return;
    }
    // Sharing your main assistant ends it being main and turns off its check-ins, so that needs a yes too.
    if (
      formDirty &&
      submitted.shared &&
      existing.shared === false &&
      bootstrap.preferences.mainBotId === existing.id &&
      !mainCleared
    ) {
      setConfirmation({ kind: "main" });
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
            body: {
              ...fields,
              ...harnessChange,
              confirmModel: confirmed,
              ...(personal ? { confirmPrivate: true } : {}),
              ...(mainCleared ? { confirmMainCleared: true } : {}),
            },
          });
          setConfirmModel(null);
          setBaseline((current) => ({ ...current, form: submitted }));
        }
        if (avatarDirty) {
          await request("PUT /bots/:id/avatar", {
            params: { id: existing.id },
            body: chosenAvatar,
          });
          setBaseline((current) => ({ ...current, avatar: chosenAvatar }));
          setAvatarFailure("");
        }
        if (toolsDraft.staged) await toolsDraft.save(existing.id);
        if (skillsDraft.staged) await skillsDraft.save(existing.id);
      },
      !formDirty
        ? "Saved"
        : submitted.shared
          ? "Changes saved for both household members."
          : "Assistant saved.",
      "config",
    );
  };
  const uploadPortrait = async (file: File | undefined) => {
    if (!file || !existing) return;
    setPortraitOperation("upload");
    try {
      await run(async () => {
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
      }, "Portrait ready to save.");
    } finally {
      setPortraitOperation(null);
    }
  };
  const generatePortrait = async () => {
    if (!existing || !prompt.trim() || prompt.length > 2000) return;
    setPortraitOperation("generate");
    try {
      await run(async () => {
        const result = await request("POST /bots/:id/portrait", {
          params: { id: existing.id },
          body: { prompt },
        });
        setAvatar({
          mode: "portrait",
          src: result.url || `/api/files/${encodeURIComponent(result.id)}`,
          origin: "generated",
        });
      }, "Portrait ready to save.");
    } finally {
      setPortraitOperation(null);
    }
  };
  const unavailable = (
    key: "botConfiguration" | "tools" | "skills" | "routines" | "portraitGeneration" | "uploads",
  ) =>
    !bootstrap.capabilities[key].supported ? (
      <p className="capability-note">
        {bootstrap.capabilities[key].reason ||
          "This capability is unavailable from the connected Hermes installation."}
      </p>
    ) : null;
  const focusTitle = () =>
    dialog.current?.querySelector<HTMLElement>("#assistant-settings-title")?.focus();
  const go = (place: SettingsPlace, discardMemory = false) => {
    if (memorySaving) return;
    const current: SettingsPlace = showingIndex ? "index" : tab;
    if (current === "memory" && place !== current && memoryDirty && !discardMemory) {
      setPendingMemoryPlace(place);
      return;
    }
    if (place === "index") setAtIndex(true);
    else {
      setTab(place);
      setAtIndex(false);
    }
    setError("");
    setNotice("");
    // A phone replaces the whole view, so focus starts again at its heading.
    if (compactSettings) requestAnimationFrame(focusTitle);
  };
  const modelSummary = existing?.modelName || form.model || "No model chosen";
  const savedHarness = baseline.form.harness;
  const summaries: Record<SettingsTab, string> = {
    profile: form.shared ? "Shared with your household" : "Personal",
    // Simple view names the harness only once there is more than Hermes to tell apart.
    behavior:
      savedHarness && (advanced || savedHarness !== "hermes")
        ? `${harnessLabel(savedHarness)} · ${modelSummary}`
        : modelSummary,
    access: "Logins and approvals",
    automation: "Scheduled routines",
    memory: "What it remembers and learns",
  };
  const mcpServers = [
    ...new Set([...(existing?.availableMcpServers ?? []), ...(form.enabledMcpServers ?? [])]),
  ].sort();
  // Profile and Behavior always offer Save; elsewhere, the phone's section list included, it appears
  // once there is something to save, so leaving a section never hides unsaved changes.
  const saveBarShown =
    !!existing && (section === "profile" || section === "behavior" || configDirty);
  const submitChanges = (event: FormEvent) => {
    event.preventDefault();
    void saveChanges();
  };
  return (
    <Dialog
      ref={dialog}
      fallbackFocus={() =>
        [".chat-identity", ".bot-rail [aria-label='Settings']", "[aria-label='Back to assistants']"]
          .map((selector) => document.querySelector<HTMLElement>(selector))
          .find((control) => control && !control.closest("[inert]")) ?? null
      }
      className="settings-dialog"
      aria-labelledby="assistant-settings-title"
      onCancel={(event) => {
        if (memorySaving) {
          event.preventDefault();
          return;
        }
        if (!unsaved) return onClose();
        event.preventDefault();
        setConfirmDiscard(true);
      }}
      onClose={() => {
        // Closing and reopening in one pass, as Strict Mode does, queues an event for a dialog that is open.
        if (dialog.current?.open) return;
        if (memorySaving) {
          dialog.current?.showModal();
          return;
        }
        // A second Escape can close the dialog without a cancelable event, so put it back.
        if (!unsaved) return onClose();
        dialog.current?.showModal();
        setConfirmDiscard(true);
      }}
    >
      <header>
        {existing && compactSettings && !atIndex && !loading && (
          <Button
            className="icon-button settings-back"
            aria-label="All settings"
            disabled={memorySaving}
            onClick={() => go("index")}
          >
            <Icon name="back" />
          </Button>
        )}
        <div>
          <p className="eyebrow">
            {!existing
              ? `New assistant · Step ${step === "look" ? 1 : 2} of 2`
              : compactSettings && !atIndex
                ? savedName
                : "Assistant settings"}
          </p>
          <h2 id="assistant-settings-title" tabIndex={-1}>
            {!existing
              ? step === "look"
                ? "Name and look"
                : "Role and model"
              : compactSettings && !atIndex
                ? sectionLabel(tab)
                : savedName}
          </h2>
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
      {loading ? (
        <div className="settings-content settings-load-state">
          <p role={loading.error ? "alert" : "status"}>
            {loading.error || "Loading assistant settings…"}
          </p>
          {loading.error && (
            <Button
              onClick={() => {
                focusTitle();
                loading.retry();
              }}
            >
              Retry settings
            </Button>
          )}
        </div>
      ) : (
        <>
          {/* Sections need the assistant to exist, so they appear once it does. */}
          {existing && !compactSettings && (
            <nav className="settings-tabs" aria-label="Settings sections">
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
            </nav>
          )}
          <div className="settings-content">
            {shownError && (
              <FormMessage tone="error" ref={errorBanner}>
                {shownError}
              </FormMessage>
            )}
            {notice && !portraitNotice && <FormMessage tone="notice">{notice}</FormMessage>}
            {confirmDiscard && (
              <div className="capability-note" role="alert">
                <p>Discard your unsaved changes?</p>
                <div className="actions">
                  <Button type="button" className="danger" onClick={onClose}>
                    Discard changes
                  </Button>
                  <Button type="button" ref={keepEditing} onClick={resumeEditing}>
                    Keep editing
                  </Button>
                </div>
              </div>
            )}
            {pendingMemoryPlace && (
              <SettingsConfirmation
                title="Leave memory without saving?"
                detail="Your unsaved memory edits will be lost. Save them before leaving if you want to keep them."
                confirmLabel="Discard edits and leave"
                danger
                busy={false}
                fallbackFocus={() =>
                  dialog.current?.querySelector<HTMLElement>("#assistant-settings-title") ?? null
                }
                onCancel={() => setPendingMemoryPlace(null)}
                onConfirm={() => {
                  const place = pendingMemoryPlace;
                  setPendingMemoryPlace(null);
                  setMemoryDirty(false);
                  go(place, true);
                }}
              />
            )}
            {confirmPersonal && existing && (
              <SettingsConfirmation
                title={`Make ${savedName} personal?`}
                detail="It will disappear for the rest of the household, along with its conversation, routines and group chats."
                confirmLabel="Make it personal"
                danger
                busy={busy}
                fallbackFocus={() =>
                  dialog.current?.querySelector<HTMLElement>(
                    "[data-settings-save]:not(:disabled)",
                  ) ??
                  dialog.current?.querySelector<HTMLElement>("#assistant-settings-title") ??
                  null
                }
                onCancel={() => setConfirmPersonal(false)}
                onConfirm={() => {
                  setConfirmPersonal(false);
                  void saveChanges(false, true);
                }}
              />
            )}
            {confirmation?.kind === "main" && existing && (
              <SettingsConfirmation
                title={`Share ${savedName} with the household?`}
                detail={
                  bootstrap.preferences.mainBotId === existing.id
                    ? `${savedName} is your main assistant. Sharing it ends that${bootstrap.preferences.checkIns?.enabled ? " and turns off its check-ins" : ""}, and everyone in the household will see its chat.`
                    : `${savedName} still has check-ins from when it was your main assistant. Sharing it turns them off, and everyone in the household will see its chat.`
                }
                confirmLabel="Share it"
                danger
                busy={busy}
                fallbackFocus={() =>
                  dialog.current?.querySelector<HTMLElement>(
                    "[data-settings-save]:not(:disabled)",
                  ) ??
                  dialog.current?.querySelector<HTMLElement>("#assistant-settings-title") ??
                  null
                }
                onCancel={() => setConfirmation(null)}
                onConfirm={() => {
                  setConfirmation(null);
                  void saveChanges(false, personalConfirmed, true);
                }}
              />
            )}
            {confirmModel && (
              <SettingsConfirmation
                title="Use this model?"
                detail={confirmModel}
                confirmLabel="Confirm this model"
                busy={busy}
                fallbackFocus={() =>
                  dialog.current?.querySelector<HTMLElement>(
                    "[data-settings-save]:not(:disabled)",
                  ) ??
                  dialog.current?.querySelector<HTMLElement>("#assistant-settings-title") ??
                  null
                }
                onCancel={() => setConfirmModel(null)}
                onConfirm={() => {
                  setConfirmModel(null);
                  void saveChanges(true);
                }}
              />
            )}
            {avatarFailure && existing && (
              <div className="capability-note avatar-failure" role="alert">
                <p>
                  {existing.name} was created, but its avatar didn't save: {avatarFailure} Your
                  choice is still here.
                </p>
                <div className="actions">
                  <Button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => void saveChanges()}
                  >
                    Retry avatar
                  </Button>
                </div>
              </div>
            )}
            {existing && showingIndex && (
              <nav aria-label="Settings sections" className="settings-index">
                <div className="settings-group">
                  {settingsSections.map(({ id, label }) => (
                    <Button
                      type="button"
                      className="settings-row"
                      key={id}
                      disabled={memorySaving}
                      onClick={() => go(id)}
                    >
                      <span className="row-text">
                        <span className="row-label">{label}</span>
                        <small>{summaries[id]}</small>
                      </span>
                      <Icon name="chevron" size={18} className="row-chevron" />
                    </Button>
                  ))}
                </div>
              </nav>
            )}
            {!existing && step === "look" && (
              <form
                className="create-look"
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = form.name.trim();
                  const taken = bootstrap.bots.some(
                    (item) => item.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
                  );
                  if (!name || taken) {
                    setError(
                      name
                        ? "An assistant with this name already exists. Choose another name."
                        : "Give your assistant a name.",
                    );
                    dialog.current?.querySelector<HTMLInputElement>("#create-name")?.focus();
                    return;
                  }
                  setError("");
                  setStep("role");
                  focusTitle();
                }}
              >
                {unavailable("botConfiguration")}
                <label>
                  Name
                  <Input
                    id="create-name"
                    maxLength={100}
                    autoComplete="off"
                    placeholder="Like Ranch hand or Homework helper"
                    value={form.name}
                    onChange={(e) => {
                      setForm({ ...form, name: e.target.value });
                      setError("");
                    }}
                  />
                </label>
                <AvatarEditor
                  avatar={avatar}
                  onChange={setAvatar}
                  name={form.name.trim() || "New assistant"}
                  portraitControls={
                    avatar.mode === "portrait" && (
                      <p className="muted">
                        Portraits are stored with the assistant, so you'll upload or generate one
                        right after you create it.
                      </p>
                    )
                  }
                />
                <div className="actions sticky-actions settings-save-actions">
                  <Button
                    type="submit"
                    className="primary"
                    aria-label="Next: role and model"
                    disabled={!bootstrap.capabilities.botConfiguration.supported}
                  >
                    Next
                  </Button>
                </div>
              </form>
            )}
            {!existing && step === "role" && (
              <form onSubmit={submitChanges}>
                {unavailable("botConfiguration")}
                <DescriptionField form={form} setForm={setForm} />
                <BehaviorFields
                  form={form}
                  setForm={setForm}
                  busy={busy}
                  profile={undefined}
                  savedHarness={undefined}
                  bootstrap={bootstrap}
                  onModelChange={() => {
                    setConfirmModel(null);
                    setError("");
                  }}
                  onFavoritesSaved={onSaved}
                />
                <SharingField form={form} setForm={setForm} />
                <div className="actions sticky-actions settings-save-actions">
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setStep("look");
                      setError("");
                      setConfirmModel(null);
                      focusTitle();
                    }}
                  >
                    Back
                  </Button>
                  <Button
                    type="submit"
                    data-settings-save
                    aria-label={busy ? "Creating assistant" : "Create assistant"}
                    className="primary with-progress"
                    disabled={
                      busy || !form.model || !bootstrap.capabilities.botConfiguration.supported
                    }
                  >
                    {busy ? (
                      <>
                        <Icon name="spinner" className="spin" size={16} />
                        Creating…
                      </>
                    ) : (
                      "Create"
                    )}
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
                  portraitControls={
                    avatar.mode === "portrait" && (
                      <div className="avatar-portrait-group">
                        <p className="muted">
                          Portraits stay still. Activity appears in a separate state indicator.
                        </p>
                        <fieldset className="avatar-portrait-group">
                          <legend>Upload a portrait</legend>
                          <label>
                            Image file
                            <Input
                              type="file"
                              accept="image/png,image/jpeg,image/webp"
                              disabled={busy || !bootstrap.capabilities.uploads.supported}
                              onChange={(e) => {
                                const file = e.currentTarget.files?.[0];
                                e.currentTarget.value = "";
                                void uploadPortrait(file);
                              }}
                            />
                          </label>
                          <p className="muted">PNG, JPEG, or WebP, up to 15 MB.</p>
                          {unavailable("uploads")}
                        </fieldset>
                        <fieldset className="avatar-portrait-group">
                          <legend>Generate a portrait</legend>
                          <label>
                            Describe a portrait
                            <Textarea
                              rows={3}
                              aria-describedby={
                                portraitPromptLimit ? "portrait-prompt-count" : undefined
                              }
                              aria-invalid={prompt.length > 2000 || undefined}
                              value={prompt}
                              onChange={(e) => setPrompt(e.target.value)}
                              placeholder="Describe the portrait you want…"
                            />
                          </label>
                          {portraitPromptLimit && (
                            <p
                              className="portrait-prompt-limit"
                              data-invalid={prompt.length > 2000}
                              id="portrait-prompt-count"
                            >
                              {portraitPromptLimit}
                            </p>
                          )}
                          <Button
                            disabled={
                              busy ||
                              !prompt.trim() ||
                              prompt.length > 2000 ||
                              !bootstrap.capabilities.portraitGeneration.supported
                            }
                            onClick={() => void generatePortrait()}
                          >
                            Generate portrait
                          </Button>
                          {unavailable("portraitGeneration")}
                        </fieldset>
                      </div>
                    )
                  }
                />
                <div className="settings-profile-group">
                  <VoicePicker
                    key={existing.id}
                    botId={existing.id}
                    name={savedName}
                    voice={existing.voice}
                    liveVoice={bootstrap.capabilities.liveVoice}
                    onSaved={() => {
                      setNotice("");
                      onSaved();
                    }}
                  />
                </div>
                <div className="settings-danger-zone">
                  <DeleteBot
                    bot={{ ...existing, name: savedName }}
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
                <BehaviorFields
                  form={form}
                  setForm={setForm}
                  busy={busy}
                  profile={existing.id}
                  savedHarness={savedHarness}
                  bootstrap={bootstrap}
                  onModelChange={() => {
                    setConfirmModel(null);
                    setError("");
                  }}
                  onFavoritesSaved={onSaved}
                />
                <CatalogEditor
                  draft={toolsDraft}
                  supported={bootstrap.capabilities.tools.supported}
                  note={unavailable("tools")}
                  busy={busy}
                />
                <SkillLocks botId={existing.id}>
                  {(extras, messages) => (
                    <CatalogEditor
                      draft={skillsDraft}
                      supported={bootstrap.capabilities.skills.supported}
                      note={
                        <>
                          {unavailable("skills")}
                          {messages}
                        </>
                      }
                      busy={busy}
                      extras={extras}
                    />
                  )}
                </SkillLocks>
              </form>
            )}
            {existing && section === "access" && (
              <>
                <section className="settings-section">
                  <VaultPanel key={existing.id} botId={existing.id} />
                </section>
                <section className="settings-section" aria-labelledby="settings-approvals-heading">
                  <ApprovalSettingsPanel key={existing.id} botId={existing.id} name={savedName} />
                </section>
                {advanced && (
                  <section
                    className="settings-section mcp-servers"
                    role="group"
                    aria-labelledby="settings-mcp-heading"
                  >
                    <h2 id="settings-mcp-heading">MCP servers</h2>
                    <p className="muted">
                      Turn on the MCP servers this assistant may use. Save changes to apply them.
                    </p>
                    {mcpServers.length ? (
                      <div className="capability-list">
                        {mcpServers.map((name) => (
                          <label className="capability-item" key={name}>
                            <Input
                              type="checkbox"
                              checked={form.enabledMcpServers?.includes(name) ?? false}
                              disabled={busy || !bootstrap.capabilities.botConfiguration.supported}
                              onChange={(event) =>
                                setForm({
                                  ...form,
                                  enabledMcpServers: event.target.checked
                                    ? [...(form.enabledMcpServers ?? []), name]
                                    : (form.enabledMcpServers ?? []).filter((id) => id !== name),
                                })
                              }
                            />
                            <span>
                              <strong>{name}</strong>
                              {!existing.availableMcpServers?.includes(name) &&
                                existing.availableMcpServers && (
                                  <small>Saved, but Hermes no longer reports it</small>
                                )}
                            </span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <p className="muted">No MCP servers are configured for this assistant.</p>
                    )}
                  </section>
                )}
              </>
            )}
            {existing && section === "automation" && (
              <>
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
              </>
            )}
            {existing && section === "memory" && (
              <>
                <section className="settings-section">
                  <MemoryPanel
                    key={existing.id}
                    botId={existing.id}
                    onDirtyChange={setMemoryDirty}
                    onSavingChange={setMemorySaving}
                  />
                </section>
                <section className="settings-section">
                  <LearningPanel key={existing.id} botId={existing.id} advanced={advanced} />
                </section>
              </>
            )}
            {saveBarShown && existing && (
              <div className="actions sticky-actions settings-save-actions">
                <p className="avatar-operation" role="status">
                  {portraitOperation ? (
                    <>
                      <Icon name="spinner" className="spin" size={16} />
                      {portraitOperation === "upload"
                        ? "Uploading portrait…"
                        : "Generating portrait…"}
                    </>
                  ) : (
                    portraitNotice || (portraitIncomplete ? portraitNextStep : "")
                  )}
                </p>
                <Button
                  type="button"
                  data-settings-save
                  className="primary with-progress"
                  disabled={
                    busy ||
                    !configDirty ||
                    portraitIncomplete ||
                    !form.model ||
                    !bootstrap.capabilities.botConfiguration.supported
                  }
                  onClick={() => void saveChanges()}
                >
                  <SaveProgress state={progress("config")} label="Save changes" />
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}

export function BotSettings(props: Parameters<typeof LoadedBotSettings>[0]) {
  const botId = props.bot === "new" ? undefined : props.bot.id;
  const hasConfiguration = props.bot === "new" || typeof props.bot.instructions === "string";
  const detail = useResource<ApiResponse<"GET /bots/:id">>(
    botId && !hasConfiguration ? routeUrl("GET /bots/:id", { id: botId }) : null,
    {
      validate: (value) => {
        if (typeof value.instructions !== "string")
          throw new Error("Assistant settings are incomplete. Try again.");
      },
    },
  );
  const ready = hasConfiguration || detail.data?.id === botId;
  return (
    <LoadedBotSettings
      {...props}
      key={botId ?? "new"}
      bot={detail.data?.id === botId ? detail.data! : props.bot}
      loading={ready ? undefined : { error: detail.error, retry: () => void detail.reload() }}
    />
  );
}
