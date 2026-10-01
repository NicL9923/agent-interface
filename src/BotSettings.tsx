import { useEffect, useRef, useState } from "react";
import type {
  Avatar as AvatarConfig,
  Bootstrap,
  Bot,
  BotInput,
  FileRef,
  Routine,
  Skill,
  Tool,
} from "./shared/types";
import { api, ApiError, write } from "./client-api";
import { IntegrationList } from "./components/IntegrationsPanel";
import { Avatar, avatarColors, defaultAvatar } from "./components/Avatar";
export function BotSettings({
  bot,
  bootstrap,
  onClose,
  onSaved,
}: {
  bot: Bot | "new";
  bootstrap: Bootstrap;
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = bot === "new" ? null : bot;
  const [tab, setTab] = useState("details");
  const [form, setForm] = useState<BotInput>({
    name: existing?.name || "",
    description: existing?.description || "",
    instructions: existing?.instructions || "",
    model: existing?.model || bootstrap.bots[0]?.model || "",
    provider: existing?.provider || bootstrap.bots[0]?.provider || "",
    shared: existing?.shared ?? true,
    enabledMcpServers: existing?.enabledMcpServers || [],
  });
  const modelChoices = Array.from(
    new Map(
      bootstrap.bots.map((b) => [
        JSON.stringify([b.provider || "", b.model]),
        { provider: b.provider || "", model: b.model },
      ]),
    ).values(),
  );
  const [avatar, setAvatar] = useState<AvatarConfig>(
    existing?.avatar || defaultAvatar,
  );
  const [tools, setTools] = useState<Tool[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [catalog, setCatalog] = useState<{
    tab: string;
    botId: string;
    status: "loading" | "ready" | "error";
  }>();
  const [catalogRetry, setCatalogRetry] = useState(0);
  const catalogReady = catalog?.tab === tab &&
    catalog.botId === existing?.id && catalog.status === "ready";
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [error, setError] = useState("");
  const [confirmModel, setConfirmModel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    if (!existing) return;
    let current = true;
    const id = encodeURIComponent(existing.id);
    if ((tab === "tools" || tab === "skills") && bootstrap.capabilities[tab].supported) {
      setCatalog({ tab, botId: existing.id, status: "loading" });
      void api<Skill[]>(`/bots/${id}/${tab}`)
        .then((items) => {
          if (!current) return;
          if (tab === "tools") setTools(items);
          else setSkills(items);
          setCatalog({ tab, botId: existing.id, status: "ready" });
        })
        .catch((e) => {
          if (!current) return;
          setError(e.message);
          setCatalog({ tab, botId: existing.id, status: "error" });
        });
    }
    if (tab === "routines" && bootstrap.capabilities.routines.supported)
      void api<Routine[]>("/routines")
        .then((result) => {
          if (current) setRoutines(result.filter((r) => r.botId === existing.id));
        })
        .catch((e) => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [tab, existing?.id, catalogRetry, bootstrap.capabilities.tools.supported,
    bootstrap.capabilities.skills.supported, bootstrap.capabilities.routines.supported]);
  const run = async (action: () => Promise<unknown>, success = "Saved") => {
    setBusy(true);
    setError("");
    try {
      await action();
      setNotice(success);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.confirmRequired) setConfirmModel(true);
    } finally {
      setBusy(false);
    }
  };
  const saveBot = (confirmed = false) =>
    run(
      async () => {
        await write(
          existing ? `/bots/${encodeURIComponent(existing.id)}` : "/bots",
          { ...form, confirmModel: confirmed },
          existing ? "PATCH" : "POST",
        );
        setConfirmModel(false);
        if (!existing) onClose();
      },
      existing?.shared
        ? "Changes saved for both household members."
        : "Assistant saved.",
    );
  const uploadPortrait = async (file: File | undefined) => {
    if (!file || !existing) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 2_000_000) {
      setError("Choose a PNG, JPEG, or WebP portrait no larger than 2 MB.");
      return;
    }
    await run(async () => {
      const data = new FormData();
      data.append("file", file);
      const result = await api<FileRef>(
        `/bots/${encodeURIComponent(existing.id)}/uploads`,
        { method: "POST", body: data },
      );
      setAvatar({
        mode: "portrait",
        src: result.url || `/api/files/${encodeURIComponent(result.id)}`,
        origin: "uploaded",
      });
    }, "Portrait uploaded. Save avatar to apply it.");
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
  return (
    <dialog
      ref={dialog}
      className="settings-dialog"
      aria-labelledby="assistant-settings-title"
      onCancel={onClose}
      onClose={onClose}
    >
      <header>
        <div>
          <p className="eyebrow">Assistant settings</p>
          <h2 id="assistant-settings-title">{existing?.name || "New assistant"}</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close assistant settings"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <nav className="settings-tabs" aria-label="Settings sections">
        {["details", "avatar", "connections", "tools", "skills", "routines"].map((t) => (
          <button
            aria-current={tab === t ? "page" : undefined}
            key={t}
            onClick={() => {
              setTab(t);
              setError("");
              setNotice("");
            }}
          >
            {t}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="form-notice" role="status">
            {notice}
          </p>
        )}
        {confirmModel && (
          <div className="capability-note">
            <p>
              Hermes requires confirmation for this provider and model. Review
              the reported warning above before continuing.
            </p>
            <div className="actions">
              <button disabled={busy} onClick={() => void saveBot(true)}>
                Confirm this model
              </button>
              <button onClick={() => setConfirmModel(false)}>
                Keep editing
              </button>
            </div>
          </div>
        )}
        {tab === "details" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveBot();
            }}
          >
            {unavailable("botConfiguration")}
            <label>
              Name
              <input
                required
                maxLength={100}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label>
              Description
              <input
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
              />
            </label>
            <label>
              Instructions
              <textarea
                rows={7}
                value={form.instructions}
                onChange={(e) =>
                  setForm({ ...form, instructions: e.target.value })
                }
                placeholder="How should this assistant help?"
              />
            </label>
            <label>
              Connected model
              <select
                required
                value={JSON.stringify([form.provider || "", form.model])}
                onChange={(event) => {
                  const [provider, model] = JSON.parse(event.target.value);
                  setForm({ ...form, provider, model });
                }}
              >
                <option value={JSON.stringify(["", ""])}>
                  Choose a connected model
                </option>
                {!modelChoices.some(
                  (choice) =>
                    choice.provider === (form.provider || "") &&
                    choice.model === form.model,
                ) &&
                  form.model && (
                    <option
                      value={JSON.stringify([form.provider || "", form.model])}
                    >
                      Advanced: {form.provider} / {form.model}
                    </option>
                  )}
                {modelChoices.map((choice) => (
                  <option
                    key={JSON.stringify([choice.provider, choice.model])}
                    value={JSON.stringify([choice.provider, choice.model])}
                  >
                    {choice.provider} / {choice.model}
                  </option>
                ))}
              </select>
            </label>
            <details className="model-advanced">
              <summary>Advanced model choice</summary>
              <div className="form-row">
                <label>
                  Existing provider
                  <input
                    required
                    list="known-providers"
                    value={form.provider}
                    onChange={(e) =>
                      setForm({ ...form, provider: e.target.value })
                    }
                  />
                  <datalist id="known-providers">
                    {Array.from(
                      new Set(modelChoices.map((c) => c.provider)),
                    ).map((provider) => (
                      <option key={provider}>{provider}</option>
                    ))}
                  </datalist>
                </label>
                <label>
                  Model
                  <input
                    required
                    list="known-models"
                    value={form.model}
                    onChange={(e) =>
                      setForm({ ...form, model: e.target.value })
                    }
                  />
                  <datalist id="known-models">
                    {Array.from(new Set(modelChoices.map((c) => c.model))).map(
                      (model) => (
                        <option key={model}>{model}</option>
                      ),
                    )}
                  </datalist>
                </label>
              </div>
            </details>
            <p className="muted">
              Use a provider already connected in Hermes. Add new sign-ins in
              the official Hermes interface.
            </p>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={form.shared}
                onChange={(e) => setForm({ ...form, shared: e.target.checked })}
              />{" "}
              Shared with your household
            </label>
            {form.shared && (
              <p className="muted">
                This assistant has one shared model. Provider and model changes
                are visible to both people.
              </p>
            )}
            <label>
              Enabled existing MCP servers
              <input
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
              Only existing Hermes connections can be configured here. Personal
              assistants organize work; they do not isolate private data.
            </p>
            <div className="actions">
              <button
                className="primary"
                disabled={
                  busy || !bootstrap.capabilities.botConfiguration.supported
                }
              >
                {busy
                  ? "Saving…"
                  : existing
                    ? "Save changes"
                    : "Create assistant"}
              </button>
              {existing && (
                <DeleteBot
                  bot={existing}
                  busy={busy}
                  supported={bootstrap.capabilities.botConfiguration.supported}
                  remove={() =>
                    void run(async () => {
                      await api(`/bots/${encodeURIComponent(existing.id)}`, {
                        method: "DELETE",
                      });
                      onClose();
                    }, "Assistant deleted")
                  }
                />
              )}
            </div>
          </form>
        )}
        {tab === "avatar" && (
          <>
            <div className="avatar-settings-preview">
              <Avatar
                avatar={avatar}
                state="idle"
                size={115}
                name={existing?.name}
              />
            </div>
            <label>
              Avatar mode
              <select
                value={avatar.mode}
                onChange={(e) =>
                  setAvatar(
                    e.target.value === "geometric"
                      ? defaultAvatar
                      : e.target.value === "mascot"
                        ? {
                            mode: "mascot",
                            family: "fox",
                            color: "#FF9800",
                            eyes: "oval",
                            accessory: "none",
                          }
                        : { mode: "portrait", src: "", origin: "uploaded" },
                  )
                }
              >
                <option value="geometric">Geometric</option>
                <option value="mascot">Animated mascot</option>
                <option value="portrait">Static portrait</option>
              </select>
            </label>
            {avatar.mode === "geometric" && (
              <label>
                Shape
                <select
                  value={avatar.shape}
                  onChange={(e) =>
                    setAvatar({
                      ...avatar,
                      shape: e.target.value as typeof avatar.shape,
                    })
                  }
                >
                  {[
                    "blob",
                    "pebble",
                    "squircle",
                    "capsule",
                    "triangle",
                    "hex",
                    "cloud",
                    "drop",
                    "circle",
                  ].map((shape) => (
                    <option key={shape}>{shape}</option>
                  ))}
                </select>
              </label>
            )}
            {avatar.mode === "mascot" && (
              <label>
                Mascot family
                <select
                  value={avatar.family}
                  onChange={(e) =>
                    setAvatar({
                      ...avatar,
                      family: e.target.value as typeof avatar.family,
                    })
                  }
                >
                  {["sprout", "fox", "bear"].map((family) => (
                    <option key={family}>{family}</option>
                  ))}
                </select>
              </label>
            )}
            {avatar.mode !== "portrait" ? (
              <>
                <fieldset>
                  <legend>Color</legend>
                  <div className="palette">
                    {avatarColors.map((color) => (
                      <button
                        key={color}
                        className={avatar.color === color ? "selected" : ""}
                        style={{ background: color }}
                        aria-label={`Color ${color}`}
                        aria-pressed={avatar.color === color}
                        onClick={() => setAvatar({ ...avatar, color })}
                      />
                    ))}
                  </div>
                  <label>
                    Custom color
                    <input
                      type="color"
                      value={avatar.color}
                      onChange={(e) =>
                        setAvatar({ ...avatar, color: e.target.value })
                      }
                    />
                  </label>
                </fieldset>
                <div className="form-row">
                  <label>
                    Eyes
                    <select
                      value={avatar.eyes}
                      onChange={(e) =>
                        setAvatar({
                          ...avatar,
                          eyes: e.target.value as typeof avatar.eyes,
                        })
                      }
                    >
                      {["oval", "round", "visor", "spark"].map((eyes) => (
                        <option key={eyes}>{eyes}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Accessory
                    <select
                      value={avatar.accessory}
                      onChange={(e) =>
                        setAvatar({
                          ...avatar,
                          accessory: e.target.value as typeof avatar.accessory,
                        })
                      }
                    >
                      {["none", "hat", "glasses"].map((accessory) => (
                        <option key={accessory}>{accessory}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {(["eyeWidth", "eyeHeight", "eyeSpacing"] as const).map(
                  (key, i) => (
                    <label key={key}>
                      {["Eye width", "Eye height", "Eye spacing"][i]}
                      <input
                        type="range"
                        min="0.6"
                        max="1.5"
                        step="0.05"
                        value={avatar[key] ?? 1}
                        onChange={(e) =>
                          setAvatar({
                            ...avatar,
                            [key]: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                  ),
                )}
              </>
            ) : (
              <>
                <p className="muted">
                  Portraits stay still. Activity appears in a separate state
                  indicator.
                </p>
                <label>
                  Upload portrait
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    disabled={
                      !existing ||
                      busy ||
                      !bootstrap.capabilities.uploads.supported
                    }
                    onChange={(e) => void uploadPortrait(e.target.files?.[0])}
                  />
                </label>
                <p className="muted">PNG, JPEG, or WebP, up to 2 MB.</p>
                {unavailable("uploads")}
                <label>
                  Generate a portrait
                  <textarea
                    rows={3}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="Describe the portrait you want…"
                  />
                </label>
                <button
                  disabled={
                    !existing ||
                    busy ||
                    !prompt.trim() ||
                    !bootstrap.capabilities.portraitGeneration.supported
                  }
                  onClick={() =>
                    void run(async () => {
                      const result = await write<FileRef>(
                        `/bots/${encodeURIComponent(existing!.id)}/portrait`,
                        { prompt },
                      );
                      setAvatar({
                        mode: "portrait",
                        src:
                          result.url ||
                          `/api/files/${encodeURIComponent(result.id)}`,
                        origin: "generated",
                      });
                    }, "Portrait generated. Save avatar to apply it.")
                  }
                >
                  Generate portrait
                </button>
                {unavailable("portraitGeneration")}
              </>
            )}
            {!existing && (
              <p className="muted">
                Create the assistant before saving an avatar.
              </p>
            )}
            <div className="actions">
              <button
                className="primary"
                disabled={
                  !existing ||
                  busy ||
                  (avatar.mode === "portrait" && !avatar.src)
                }
                onClick={() =>
                  void run(
                    () =>
                      write(
                        `/bots/${encodeURIComponent(existing!.id)}/avatar`,
                        avatar,
                        "PUT",
                      ),
                    "Avatar saved",
                  )
                }
              >
                Save avatar
              </button>
            </div>
          </>
        )}
        {(tab === "tools" || tab === "skills") && (
          <>
            {unavailable(tab)}
            {!existing ? (
              <p>Create the assistant before configuring its capabilities.</p>
            ) : (
              <>
                {bootstrap.capabilities[tab].supported && !catalogReady && (
                  catalog?.tab === tab && catalog.status === "error" ? (
                    <button onClick={() => { setError(""); setCatalogRetry((value) => value + 1); }}>
                      Retry loading {tab}
                    </button>
                  ) : <p role="status">Loading {tab}…</p>
                )}
                {(tab === "tools" ? tools : skills).map((item) => (
                  <label className="capability-item" key={item.id}>
                    <input
                      type="checkbox"
                      checked={
                        item.enabled || ("required" in item && !!item.required)
                      }
                      disabled={busy || !catalogReady || !bootstrap.capabilities[tab].supported || ("required" in item && !!item.required)}
                      onChange={(e) => {
                        if (tab === "tools")
                          setTools((items) =>
                            items.map((t) =>
                              t.id === item.id
                                ? { ...t, enabled: e.target.checked }
                                : t,
                            ),
                          );
                        else
                          setSkills((items) =>
                            items.map((s) =>
                              s.id === item.id
                                ? { ...s, enabled: e.target.checked }
                                : s,
                            ),
                          );
                      }}
                    />
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.description}</small>
                      {"required" in item && !!item.required && (
                        <small>Required by Hermes</small>
                      )}
                    </span>
                  </label>
                ))}
                {catalogReady && bootstrap.capabilities[tab].supported &&
                  !(tab === "tools" ? tools : skills).length && (
                    <p className="muted">No {tab} were reported by Hermes.</p>
                  )}
                <button
                  className="primary"
                  disabled={busy || !catalogReady || !bootstrap.capabilities[tab].supported}
                  onClick={() =>
                    void run(() =>
                      write(
                        `/bots/${encodeURIComponent(existing.id)}/${tab}`,
                        {
                          ids: (tab === "tools" ? tools : skills)
                            .filter((item) => item.enabled)
                            .map((item) => item.id),
                        },
                        "PUT",
                      ),
                    )
                  }
                >
                  Save {tab}
                </button>
              </>
            )}
          </>
        )}
        {tab === "connections" && (existing ? <IntegrationList profile={existing.id} bots={bootstrap.bots} accountScope={bootstrap.user.id} /> : <p>Create the assistant before connecting its services.</p>)}
        {tab === "routines" && (
          <>
            {unavailable("routines")}
            {!existing ? (
              <p>Create the assistant before adding routines.</p>
            ) : (
              <RoutineManager
                botId={existing.id}
                routines={routines}
                setRoutines={setRoutines}
                bootstrap={bootstrap}
                report={setError}
              />
            )}
          </>
        )}
      </div>
    </dialog>
  );
}
function DeleteBot({
  bot,
  busy,
  supported,
  remove,
}: {
  bot: Bot;
  busy: boolean;
  supported: boolean;
  remove: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return confirm ? (
    <>
      <span>Delete {bot.name}?</span>
      <button type="button" className="danger" disabled={busy} onClick={remove}>
        Yes, delete
      </button>
      <button type="button" onClick={() => setConfirm(false)}>Keep assistant</button>
    </>
  ) : (
    <button
      type="button"
      className="danger"
      disabled={busy || !supported}
      onClick={() => setConfirm(true)}
    >
      Delete assistant
    </button>
  );
}
function RoutineManager({
  botId,
  routines,
  setRoutines,
  bootstrap,
  report,
}: {
  botId: string;
  routines: Routine[];
  setRoutines: (v: Routine[]) => void;
  bootstrap: Bootstrap;
  report: (s: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<Omit<Routine, "id">>({
    botId,
    name: "",
    prompt: "",
    schedule: "",
    enabled: true,
    recipientIds: [],
  });
  const [busy, setBusy] = useState(false);
  const [deleteId, setDeleteId] = useState("");
  const supported = bootstrap.capabilities.routines.supported;
  const refresh = async () =>
    setRoutines(
      (await api<Routine[]>("/routines")).filter((r) => r.botId === botId),
    );
  const action = async (work: () => Promise<unknown>) => {
    setBusy(true);
    report("");
    try {
      await work();
      await refresh();
    } catch (e) {
      report((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="muted">
        Routines keep working when you are away. Choose notification recipients
        explicitly.
      </p>
      {routines.map((routine) => (
        <article className="routine-card" key={routine.id}>
          <h3>{routine.name}</h3>
          <p>{routine.schedule}</p>
          <small>{routine.enabled ? "Active" : "Paused"}</small>
          <p>{routine.prompt}</p>
          <div className="actions">
            <button
              disabled={busy}
              onClick={() =>
                void action(() =>
                  write(
                    `/routines/${encodeURIComponent(routine.id)}`,
                    {
                      ...routine,
                      enabled: !routine.enabled,
                      recipientIds: routine.recipientIds || [],
                    },
                    "PUT",
                  ),
                )
              }
            >
              {routine.enabled ? "Pause" : "Resume"}
            </button>
            <button
              onClick={() => {
                setEditing(routine.id);
                setForm(routine);
              }}
            >
              Edit
            </button>
            {deleteId === routine.id ? (
              <>
                <button
                  className="danger"
                  onClick={() =>
                    void action(() =>
                      api(`/routines/${encodeURIComponent(routine.id)}`, {
                        method: "DELETE",
                      }),
                    )
                  }
                >
                  Confirm delete
                </button>
                <button onClick={() => setDeleteId("")}>Cancel</button>
              </>
            ) : (
              <button
                className="danger"
                onClick={() => setDeleteId(routine.id)}
              >
                Delete
              </button>
            )}
          </div>
        </article>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action(async () => {
            await write(
              editing
                ? `/routines/${encodeURIComponent(editing)}`
                : "/routines",
              form,
              editing ? "PUT" : "POST",
            );
            setEditing(null);
            setForm({
              botId,
              name: "",
              prompt: "",
              schedule: "",
              enabled: true,
              recipientIds: [],
            });
          });
        }}
      >
        <h3>{editing ? "Edit routine" : "New routine"}</h3>
        <label>
          Name
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label>
          Instructions
          <textarea
            required
            rows={4}
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
          />
        </label>
        <label>
          Schedule
          <input
            required
            value={form.schedule}
            onChange={(e) => setForm({ ...form, schedule: e.target.value })}
            placeholder="Hermes schedule expression"
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />{" "}
          Enabled
        </label>
        <fieldset>
          <legend>Notify these household members</legend>
          {bootstrap.household.map((user) => (
            <label className="checkbox-label" key={user.id}>
              <input
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
          <button className="primary" disabled={busy || !supported}>
            {busy ? "Saving…" : editing ? "Save routine" : "Add routine"}
          </button>
          {editing && (
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setForm({
                  botId,
                  name: "",
                  prompt: "",
                  schedule: "",
                  enabled: true,
                  recipientIds: [],
                });
              }}
            >
              Cancel edit
            </button>
          )}
        </div>
      </form>
    </>
  );
}
