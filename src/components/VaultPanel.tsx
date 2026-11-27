import { useEffect, useId, useRef, useState } from "react";
import { ApiError, request } from "../client-api";
import { routeUrl } from "../shared/api";
import { useAction } from "../app/use-action";
import { useResource } from "../app/use-resource";
import type { AddVaultLogin, ProfileVault, VaultSourceName } from "../shared/vault";
import { FormMessage } from "./ui/form-message";
import "./vault.css";

const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function validOrigin(value: string) {
  try {
    const url = new URL(value.trim());
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/"
    );
  } catch {
    return false;
  }
}

function validSecretName(value: string) {
  return SECRET_NAME.test(value.trim());
}

export function VaultPanel({ botId }: { botId: string }) {
  const addButton = useRef<HTMLButtonElement>(null);
  const addSecretButton = useRef<HTMLButtonElement>(null);
  const reloadButton = useRef<HTMLButtonElement>(null);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const keepButton = useRef<HTMLButtonElement>(null);
  const unlockButtons = useRef(new Map<VaultSourceName, HTMLButtonElement>());
  const returnToUnlock = useRef<VaultSourceName | null>(null);
  const returnToRemove = useRef<string | null>(null);
  const returnToAdd = useRef(false);
  const returnToAddSecret = useRef(false);
  const returnToReload = useRef(false);
  const removePromptId = useId();
  const removeSecretPromptId = useId();
  const errorId = useId();
  const errorMessage = useRef<HTMLParagraphElement>(null);
  const lockButtons = useRef(new Map<VaultSourceName, HTMLButtonElement>());
  const [uncertain, setUncertain] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addingSecret, setAddingSecret] = useState(false);
  const [remove, setRemove] = useState<string | null>(null);
  const [removeSecret, setRemoveSecret] = useState<string | null>(null);
  const [unlock, setUnlock] = useState<VaultSourceName | null>(null);
  const [password, setPassword] = useState("");
  const [otpSecret, setOtpSecret] = useState("");
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [master, setMaster] = useState("");
  const [form, setForm] = useState<Omit<AddVaultLogin, "password" | "otpSecret">>({
    label: "",
    origin: "",
    identifier: "",
    identifierType: "email",
  });
  const path = routeUrl("GET /bots/:id/vault", { id: botId });
  const vaultResource = useResource<ProfileVault>(path, {
    errorMessage: () =>
      "Could not load this assistant's saved logins and secrets. Check the connection and reload.",
    onData: () => setUncertain(false),
  });
  const { data: vault, loading } = vaultResource;
  const action = useAction();
  const { busy } = action;
  const error = action.error || vaultResource.error;
  const clearSecretFields = () => {
    setPassword("");
    setOtpSecret("");
    setSecretValue("");
    setMaster("");
  };
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") clearSecretFields();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", clearSecretFields);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", clearSecretFields);
    };
  }, []);
  // Reloading is how a person reviews an uncertain change, so it retires that warning.
  function reload() {
    returnToReload.current = true;
    clearSecretFields();
    action.setError("");
    void vaultResource.reload();
  }
  async function mutate(work: () => Promise<unknown>, success: string) {
    if (loading || uncertain) return;
    clearSecretFields();
    await action.run(work, {
      success,
      onSuccess: () => {
        setRemove(null);
        setRemoveSecret(null);
        setUnlock(null);
        setAdding(false);
        setAddingSecret(false);
        setSecretName("");
        void vaultResource.reload();
      },
      onError: (cause) => {
        // Definite 4xx rejections (other than ambiguous 409 state conflicts) mean the server refused
        // before mutating the vault, so report the reason without locking the panel.
        if (
          cause instanceof ApiError &&
          cause.status >= 400 &&
          cause.status < 500 &&
          cause.status !== 409
        ) {
          return `${cause.message} Secret fields have been cleared.`;
        }
        setUncertain(true);
        return "WildBots could not confirm this change. Reload and review the saved entries before trying again. Secret fields have been cleared.";
      },
    });
  }
  const disabled = busy || loading || uncertain;
  const trimmedOrigin = form.origin.trim();
  const originInvalid = trimmedOrigin.length > 0 && !validOrigin(trimmedOrigin);
  const trimmedSecretName = secretName.trim();
  const secretNameInvalid = trimmedSecretName.length > 0 && !validSecretName(trimmedSecretName);
  useEffect(() => {
    if (busy || loading) return;
    if (uncertain) {
      if (!unlock) returnToUnlock.current = null;
      reloadButton.current?.focus();
      errorMessage.current?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (returnToReload.current) {
      reloadButton.current?.focus();
      returnToReload.current = false;
      return;
    }
    if (remove || removeSecret) {
      keepButton.current?.focus();
      return;
    }
    if (returnToRemove.current) {
      const trigger = removeButtons.current.get(returnToRemove.current);
      (trigger && !trigger.disabled
        ? trigger
        : !disabled
          ? addButton.current
          : reloadButton.current
      )?.focus();
      returnToRemove.current = null;
    }
    if (!unlock && returnToUnlock.current) {
      const trigger =
        unlockButtons.current.get(returnToUnlock.current) ||
        lockButtons.current.get(returnToUnlock.current);
      (trigger && !trigger.disabled ? trigger : reloadButton.current)?.focus();
      returnToUnlock.current = null;
    }
    if (!adding && returnToAdd.current) {
      (!disabled ? addButton.current : reloadButton.current)?.focus();
      returnToAdd.current = false;
    }
    if (!addingSecret && returnToAddSecret.current) {
      (!disabled ? addSecretButton.current : reloadButton.current)?.focus();
      returnToAddSecret.current = false;
    }
  }, [remove, removeSecret, adding, addingSecret, unlock, busy, loading, disabled, uncertain]);
  const secrets = vault?.secrets ?? [];
  return (
    <section className="vault-panel">
      <div className="vault-heading">
        <h2>Passwords &amp; logins</h2>
        <div className="vault-heading-actions">
          <button
            ref={addButton}
            type="button"
            aria-expanded={adding}
            disabled={disabled}
            onClick={() => {
              returnToAdd.current = true;
              returnToAddSecret.current = false;
              returnToUnlock.current = null;
              returnToRemove.current = null;
              setRemove(null);
              setRemoveSecret(null);
              setAddingSecret(false);
              if (!adding)
                setForm({ label: "", origin: "", identifier: "", identifierType: "email" });
              setAdding(!adding);
              clearSecretFields();
              setUnlock(null);
            }}
          >
            Add login
          </button>
          <button
            ref={addSecretButton}
            type="button"
            aria-expanded={addingSecret}
            disabled={disabled}
            onClick={() => {
              returnToAddSecret.current = true;
              returnToAdd.current = false;
              returnToUnlock.current = null;
              returnToRemove.current = null;
              setRemove(null);
              setRemoveSecret(null);
              setAdding(false);
              if (!addingSecret) setSecretName("");
              setAddingSecret(!addingSecret);
              clearSecretFields();
              setUnlock(null);
            }}
          >
            Add secret
          </button>
          <button
            ref={reloadButton}
            className="vault-reload"
            type="button"
            aria-describedby={uncertain ? errorId : undefined}
            disabled={busy || loading}
            onClick={reload}
          >
            Reload logins
          </button>
        </div>
      </div>
      <p className="muted">
        Manage this assistant's encrypted WildBots vault. Passwords and secrets stay out of your
        conversation and draft; usernames, labels, and secret names are visible metadata.
      </p>
      {vault && (
        <p className="capability-note">
          <strong>Assistant: {vault.profile}.</strong> {vault.notice}
        </p>
      )}
      {loading && <p role="status">Loading WildBots vault...</p>}
      {error && (
        <FormMessage ref={errorMessage} id={errorId} tone="error">
          {error}
        </FormMessage>
      )}
      {action.notice && <FormMessage tone="notice">{action.notice}</FormMessage>}
      {adding && (
        <form
          className="vault-form"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            const normalizedOrigin = form.origin.trim();
            if (!validOrigin(normalizedOrigin)) {
              action.setError(
                "Enter the website address through the hostname, such as https://example.com.",
              );
              return;
            }
            const trimmedOtp = otpSecret.trim();
            const input: AddVaultLogin = {
              label: form.label.trim(),
              origin: normalizedOrigin,
              identifierType: form.identifierType,
              identifier: form.identifier.trim(),
              password,
              ...(trimmedOtp ? { otpSecret: trimmedOtp } : {}),
            };
            void mutate(
              () => request("POST /bots/:id/vault/logins", { params: { id: botId }, body: input }),
              "Login saved in WildBots.",
            );
          }}
        >
          <label>
            Label
            <input
              autoFocus
              required
              maxLength={200}
              value={form.label}
              disabled={disabled}
              onChange={(event) => setForm({ ...form, label: event.target.value })}
              placeholder="Ranch supply account"
            />
          </label>
          <label>
            Website address
            <input
              required
              type="url"
              maxLength={2048}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-invalid={originInvalid || undefined}
              value={form.origin}
              disabled={disabled}
              onChange={(event) => setForm({ ...form, origin: event.target.value })}
              placeholder="https://example.com"
            />
          </label>
          {originInvalid && (
            <FormMessage tone="error">
              Enter the website address through the hostname, such as https://example.com.
            </FormMessage>
          )}
          <p className="muted">
            Use the exact website, such as https://example.com, without a page path. WildBots checks
            the website before filling credentials.
          </p>
          <label>
            Identifier type
            <select
              value={form.identifierType}
              disabled={disabled}
              onChange={(event) =>
                setForm({
                  ...form,
                  identifierType: event.target.value as AddVaultLogin["identifierType"],
                })
              }
            >
              <option value="email">Email</option>
              <option value="username">Username</option>
              <option value="phone">Phone</option>
            </select>
          </label>
          <label>
            {form.identifierType === "email"
              ? "Email"
              : form.identifierType === "phone"
                ? "Phone"
                : "Username"}
            <input
              required
              maxLength={1000}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={form.identifier}
              disabled={disabled}
              onChange={(event) => setForm({ ...form, identifier: event.target.value })}
            />
          </label>
          <label>
            Password
            <input
              required
              type="password"
              maxLength={4096}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={password}
              disabled={disabled}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label>
            Authenticator secret (optional)
            <input
              type="password"
              maxLength={4000}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={otpSecret}
              disabled={disabled}
              onChange={(event) => setOtpSecret(event.target.value)}
              placeholder="Base32 TOTP setup key"
            />
          </label>
          <div className="actions">
            <button
              className="primary"
              disabled={
                disabled ||
                !form.label.trim() ||
                !form.identifier.trim() ||
                !password ||
                !validOrigin(form.origin)
              }
            >
              {busy ? "Saving..." : "Save login"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setAdding(false);
                clearSecretFields();
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {addingSecret && (
        <form
          className="vault-form"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            const normalizedName = secretName.trim();
            if (!validSecretName(normalizedName)) {
              action.setError(
                "Secret names use letters, numbers, dots, dashes, and underscores, up to 128 characters.",
              );
              return;
            }
            const value = secretValue;
            void mutate(
              () =>
                request("POST /bots/:id/vault/secrets", {
                  params: { id: botId },
                  body: { name: normalizedName, value },
                }),
              "Secret saved in WildBots.",
            );
          }}
        >
          <label>
            Secret name
            <input
              autoFocus
              required
              maxLength={128}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-invalid={secretNameInvalid || undefined}
              value={secretName}
              disabled={disabled}
              onChange={(event) => setSecretName(event.target.value)}
              placeholder="API_TOKEN"
            />
          </label>
          {secretNameInvalid && (
            <FormMessage tone="error">
              Secret names use letters, numbers, dots, dashes, and underscores, up to 128
              characters.
            </FormMessage>
          )}
          <label>
            Secret value
            <input
              required
              type="password"
              maxLength={20000}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={secretValue}
              disabled={disabled}
              onChange={(event) => setSecretValue(event.target.value)}
            />
          </label>
          <p className="muted">
            Encrypted at rest and available to this assistant's tools by name. Saving an existing
            name replaces its value.
          </p>
          <div className="actions">
            <button
              className="primary"
              disabled={disabled || !validSecretName(secretName) || !secretValue}
            >
              {busy ? "Saving..." : "Save secret"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setAddingSecret(false);
                setSecretName("");
                clearSecretFields();
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {vault && (
        <>
          <div>
            <h3>Saved logins</h3>
            {!vault.items.length && (
              <p className="muted">No saved logins in the enabled sources.</p>
            )}
            {vault.items.map((item) => (
              <article className="vault-entry" key={item.id}>
                <div className="vault-entry-heading">
                  <h4>{item.label}</h4>
                  <small className="vault-source-tag">
                    {item.backend === "local"
                      ? "WildBots vault"
                      : item.backend === "onepassword"
                        ? "1Password"
                        : "Bitwarden"}
                  </small>
                </div>
                <p className="vault-identifier">{item.identifier}</p>
                <p className="vault-origin">{item.origin}</p>
                {item.hasOtp && <small>Includes a saved authenticator secret.</small>}
                {item.canRemove &&
                  (remove === item.id ? (
                    <div className="vault-remove-confirmation">
                      <p id={removePromptId}>Remove {item.label} from WildBots?</p>
                      <div className="actions">
                        <button
                          aria-describedby={removePromptId}
                          type="button"
                          className="danger"
                          disabled={disabled}
                          onClick={() =>
                            void mutate(
                              () =>
                                request("DELETE /bots/:id/vault/logins/:itemId", {
                                  params: { id: botId, itemId: item.id },
                                }),
                              "Login removed from WildBots.",
                            )
                          }
                        >
                          Remove login
                        </button>
                        <button
                          ref={keepButton}
                          type="button"
                          aria-describedby={removePromptId}
                          disabled={busy}
                          onClick={() => setRemove(null)}
                        >
                          Keep login
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      ref={(node) => {
                        if (node) removeButtons.current.set(item.id, node);
                        else removeButtons.current.delete(item.id);
                      }}
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        returnToRemove.current = item.id;
                        setRemoveSecret(null);
                        setRemove(item.id);
                      }}
                    >
                      Remove...
                    </button>
                  ))}
              </article>
            ))}
          </div>
          <div>
            <h3>Saved secrets</h3>
            {!secrets.length && (
              <p className="muted">No saved API keys or custom secrets for this assistant.</p>
            )}
            {secrets.map((secret) => (
              <article className="vault-entry" key={secret.name}>
                <div className="vault-entry-heading">
                  <h4>
                    <code>{secret.name}</code>
                  </h4>
                  <small className="vault-source-tag">WildBots vault</small>
                </div>
                {secret.canRemove &&
                  (removeSecret === secret.name ? (
                    <div className="vault-remove-confirmation">
                      <p id={removeSecretPromptId}>Remove secret {secret.name} from WildBots?</p>
                      <div className="actions">
                        <button
                          aria-describedby={removeSecretPromptId}
                          type="button"
                          className="danger"
                          disabled={disabled}
                          onClick={() =>
                            void mutate(
                              () =>
                                request("DELETE /bots/:id/vault/secrets/:name", {
                                  params: { id: botId, name: secret.name },
                                }),
                              "Secret removed from WildBots.",
                            )
                          }
                        >
                          Remove secret
                        </button>
                        <button
                          ref={keepButton}
                          type="button"
                          aria-describedby={removeSecretPromptId}
                          disabled={busy}
                          onClick={() => setRemoveSecret(null)}
                        >
                          Keep secret
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      ref={(node) => {
                        const key = `secret:${secret.name}`;
                        if (node) removeButtons.current.set(key, node);
                        else removeButtons.current.delete(key);
                      }}
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        returnToRemove.current = `secret:${secret.name}`;
                        setRemove(null);
                        setRemoveSecret(secret.name);
                      }}
                    >
                      Remove...
                    </button>
                  ))}
              </article>
            ))}
          </div>
          <div>
            <h3>Vault sources</h3>
            {vault.sources.map((source) => (
              <div className="vault-source" key={source.name}>
                <div className="vault-source-summary">
                  <div>
                    <strong>{source.displayName}</strong>
                    <p className="muted">
                      {!source.installed
                        ? "CLI is not installed"
                        : source.name === "local"
                          ? "Available to this assistant"
                          : !source.enabled
                            ? "Disabled"
                            : source.unlocked
                              ? "Unlocked for this assistant"
                              : "Locked"}
                    </p>
                  </div>
                  <div className="vault-source-actions">
                    {source.canToggle && (
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={source.enabled}
                          disabled={disabled}
                          onChange={(event) => {
                            const enabled = event.target.checked;
                            void mutate(
                              () =>
                                request("PUT /bots/:id/vault/sources/:source", {
                                  params: { id: botId, source: source.name },
                                  body: { enabled },
                                }),
                              enabled ? "Vault source enabled." : "Vault source disabled.",
                            );
                          }}
                        />{" "}
                        Use {source.displayName}
                      </label>
                    )}
                    {source.canUnlock && unlock !== source.name && (
                      <button
                        ref={(node) => {
                          if (node) unlockButtons.current.set(source.name, node);
                          else unlockButtons.current.delete(source.name);
                        }}
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          returnToAdd.current = false;
                          returnToAddSecret.current = false;
                          returnToRemove.current = null;
                          setRemove(null);
                          setRemoveSecret(null);
                          returnToUnlock.current = source.name;
                          setUnlock(source.name);
                          clearSecretFields();
                          setAdding(false);
                          setAddingSecret(false);
                        }}
                      >
                        Unlock
                      </button>
                    )}
                    {source.canLock && (
                      <button
                        ref={(node) => {
                          if (node) lockButtons.current.set(source.name, node);
                          else lockButtons.current.delete(source.name);
                        }}
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          returnToUnlock.current = source.name;
                          void mutate(
                            () =>
                              request("POST /bots/:id/vault/sources/:source/lock", {
                                params: { id: botId, source: source.name },
                                body: {},
                              }),
                            "Vault source locked.",
                          );
                        }}
                      >
                        Lock
                      </button>
                    )}
                  </div>
                </div>
                {unlock === source.name && (
                  <form
                    className="vault-unlock-form"
                    autoComplete="off"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const value = master;
                      void mutate(
                        () =>
                          request("POST /bots/:id/vault/sources/:source/unlock", {
                            params: { id: botId, source: source.name },
                            body: { password: value },
                          }),
                        "Vault source unlocked for this assistant.",
                      );
                    }}
                  >
                    <label>
                      Master password
                      <input
                        autoFocus
                        required
                        type="password"
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        maxLength={4096}
                        value={master}
                        disabled={disabled}
                        onChange={(event) => setMaster(event.target.value)}
                      />
                    </label>
                    <div className="actions">
                      <button className="primary" disabled={disabled || !master}>
                        Unlock source
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setUnlock(null);
                          setMaster("");
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
