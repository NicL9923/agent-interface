import { useEffect, useState } from "react";
import type { RefObject } from "react";
import type { FileRef } from "../shared/types";
import { api, write } from "../client-api";
import { draftKey, localRead, localSave, sameDraft } from "./storage";
import type { Draft, Pending } from "./storage";
type Epoch = RefObject<number>;
export function useDraft({ botId, userId, identityEpoch, setError }: {
  botId: string;
  userId?: string;
  identityEpoch: Epoch;
  setError(update: string | ((previous: string) => string)): void;
}) {
  const [draft, setDraft] = useState<Draft>({ text: "", attachments: [] });
  const [draftReady, setDraftReady] = useState(false);
  const [uploading, setUploading] = useState(false);
  useEffect(() => {
    if (!botId || !userId) return;
    let live = true;
    setDraftReady(false);
    const cached = localRead<Draft>(draftKey(userId, botId));
    let draftLoaded = !!cached?.dirty;
    let loadingDraft = false;
    setDraft({ ...(cached || { text: "", attachments: [] }), botId, userId });
    if (cached) setDraftReady(true);
    // Personal drafts remain available even when the separate executor is down.
    const loadDraft = async () => {
      if (draftLoaded || loadingDraft) return;
      loadingDraft = true;
      try {
        const saved = await api<Draft | null>(`/bots/${encodeURIComponent(botId)}/draft`);
        if (!live) return;
        draftLoaded = true;
        setDraft(current => current.dirty ? current : { ...(saved || { text: "", attachments: [] }), botId, userId });
        setDraftReady(true);
        setError(previous => previous.startsWith("Your saved draft could not be loaded.") ? "" : previous);
      } catch (e) {
        if (live) setError(`Your saved draft could not be loaded. Retrying. ${(e as Error).message}`);
      } finally {
        loadingDraft = false;
      }
    };
    void loadDraft();
    const wake = () => {
      if (navigator.onLine !== false && document.visibilityState !== "hidden") void loadDraft();
    };
    const timer = setInterval(wake, 1500);
    window.addEventListener("online", wake);
    window.addEventListener("agent-interface:reconnect", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("online", wake);
      window.removeEventListener("agent-interface:reconnect", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [botId, userId]);
  const upload = async (files: FileList | null) => {
    if (!files || !userId) return;
    const uploadBot = botId;
    const uploadUser = userId;
    const epoch = identityEpoch.current;
    let targetDraft = { ...draft };
    setUploading(true);
    setError("");
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        const result = await api<FileRef>(
          `/bots/${encodeURIComponent(uploadBot)}/uploads`,
          { method: "POST", body: form },
        );
        if (epoch !== identityEpoch.current) return;
        targetDraft =
          localRead<Draft>(draftKey(uploadUser, uploadBot)) || targetDraft;
        targetDraft = {
          ...targetDraft,
          attachments: [...targetDraft.attachments, result],
          dirty: true,
        };
        localSave(draftKey(uploadUser, uploadBot), targetDraft);
        void write(
          `/bots/${encodeURIComponent(uploadBot)}/draft`,
          targetDraft,
          "PUT",
        ).catch(() => {});
        setDraft((current) =>
          current.botId === uploadBot && current.userId === uploadUser
            ? { ...current, attachments: [...current.attachments, result], dirty: true }
            : current,
        );
      }
    } catch (e) {
      if (epoch === identityEpoch.current) setError((e as Error).message);
    } finally {
      if (epoch === identityEpoch.current) setUploading(false);
    }
  };
  return { draft, setDraft, draftReady, uploading, setUploading, upload };
}
export function useDraftPersistence({ draft, setDraft, draftReady, botId, userId, identityEpoch, offline, appUnavailable, pending }: {
  draft: Draft;
  setDraft(update: (current: Draft) => Draft): void;
  draftReady: boolean;
  botId: string;
  userId?: string;
  identityEpoch: Epoch;
  offline: boolean;
  appUnavailable: boolean;
  pending: Pending | null;
}) {
  useEffect(() => {
    if (
      !userId ||
      !botId ||
      !draftReady ||
      draft.botId !== botId ||
      draft.userId !== userId
    )
      return;
    const user = userId;
    localSave(draftKey(user, botId), draft);
    if (!draft.dirty || offline || appUnavailable || pending && pending.botId === botId && sameDraft(pending, draft)) return;
    const epoch = identityEpoch.current;
    const timer = setTimeout(
      () =>
        void write(
          `/bots/${encodeURIComponent(botId)}/draft`,
          draft,
          "PUT",
        ).then(() => {
          if (epoch !== identityEpoch.current) return;
          const key = draftKey(user, botId);
          const cached = localRead<Draft>(key);
          if (cached && sameDraft(cached, draft))
            localSave(key, {...cached, dirty: false});
          setDraft(current => current === draft ? {...current, dirty: false} : current);
        }).catch(() => {}),
      350,
    );
    return () => clearTimeout(timer);
  }, [draft, botId, draftReady, userId, offline, appUnavailable, pending]);
}
