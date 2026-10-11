import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { FileRef } from "../shared/types";
import { api, uploadFile, write } from "../client-api";
import { draftKey, localRead, localSave, sameDraft } from "./storage";
import type { Draft, LocalUpload, Pending } from "./storage";
type Epoch = RefObject<number>;
export function useDraft({ botId, userId, identityEpoch, setError }: {
  botId: string;
  userId?: string;
  identityEpoch: Epoch;
  setError(update: string | ((previous: string) => string)): void;
}) {
  const [draft, setDraft] = useState<Draft>({ text: "", attachments: [] });
  const [draftReady, setDraftReady] = useState(false);
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
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const ready = useRef(draftReady);
  ready.current = draftReady;
  const [uploads, setUploads] = useState<LocalUpload[]>([]);
  // Object URLs for attachments uploaded from this device, so chips show the image without a download.
  const [previews, setPreviews] = useState<Record<string, { url: string; botId: string }>>({});
  const controllers = useRef(new Map<string, AbortController>());
  const queue = useRef(Promise.resolve());
  const patch = (id: string, change: Partial<LocalUpload>) =>
    setUploads(current => current.map(item => item.id === id ? { ...item, ...change } : item));
  // Returns false when the upload was canceled or the account changed meanwhile, so nothing was written.
  const attach = async (uploadUser: string, uploadBot: string, result: FileRef, live: () => boolean) => {
    const shown = () => latestDraft.current.botId === uploadBot && latestDraft.current.userId === uploadUser;
    // A draft still loading from the server would replace a file added to it now.
    const settle = async () => {
      while (live() && shown() && !ready.current) await new Promise(resolve => setTimeout(resolve, 250));
    };
    const visible = () => {
      if (!live() || !shown() || !ready.current) return false;
      setDraft(previous => previous.botId === uploadBot && previous.userId === uploadUser
        ? { ...previous, attachments: [...previous.attachments, result], dirty: true } : previous);
      return true;
    };
    await settle();
    if (!live()) return false;
    if (visible()) return true;
    // The person moved to another assistant; add the file to the draft it was meant for.
    const key = draftKey(uploadUser, uploadBot);
    let saved = localRead<Draft>(key);
    if (!saved) {
      const loaded = await api<Draft | null>(`/bots/${encodeURIComponent(uploadBot)}/draft`);
      // They may have come back while the saved draft loaded.
      await settle();
      if (!live()) return false;
      if (visible()) return true;
      saved = localRead<Draft>(key) ?? loaded ?? { text: "", attachments: [] };
    }
    const target = { ...saved, attachments: [...saved.attachments, result], dirty: true };
    if (!live()) return false;
    localSave(key, target);
    void write(`/bots/${encodeURIComponent(uploadBot)}/draft`, target, "PUT").catch(() => {});
    return true;
  };
  const run = async (item: LocalUpload, controller: AbortController, epoch: number) => {
    if (controller.signal.aborted || epoch !== identityEpoch.current) return;
    patch(item.id, { status: "uploading", progress: 0, error: undefined });
    try {
      const result = await uploadFile<FileRef>(`/bots/${encodeURIComponent(item.botId)}/uploads`, item.file, {
        signal: controller.signal,
        onProgress: sent => patch(item.id, sent >= 1 ? { progress: 1, status: "processing" } : { progress: sent }),
      });
      if (controller.signal.aborted || epoch !== identityEpoch.current) return;
      const live = () => !controller.signal.aborted && epoch === identityEpoch.current;
      if (!await attach(item.userId, item.botId, { ...result, size: result.size ?? item.file.size }, live)) return;
      if (item.preview) setPreviews(current => ({ ...current, [result.id]: { url: item.preview!, botId: item.botId } }));
      setUploads(current => current.filter(entry => entry.id !== item.id));
    } catch (e) {
      if (controller.signal.aborted || epoch !== identityEpoch.current) return;
      patch(item.id, { status: "failed", error: (e as Error).message });
    } finally {
      controllers.current.delete(item.id);
    }
  };
  const start = (item: LocalUpload) => {
    const controller = new AbortController();
    controllers.current.set(item.id, controller);
    const epoch = identityEpoch.current;
    // One at a time keeps a batch in the order it was added. A retried file joins after those already uploaded.
    queue.current = queue.current.then(() => run(item, controller, epoch));
  };
  const upload = (files: File[], target: string) => {
    if (!userId || !files.length) return;
    const added = files.map((file): LocalUpload => ({
      id: crypto.randomUUID(), botId: target, userId, file, status: "queued", progress: 0,
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
    }));
    setUploads(current => [...current, ...added]);
    added.forEach(start);
  };
  const retryUpload = (id: string) => {
    const item = uploads.find(entry => entry.id === id);
    if (!item || item.status !== "failed") return;
    patch(id, { status: "queued", progress: 0, error: undefined });
    start(item);
  };
  const cancelUpload = (id: string) => {
    controllers.current.get(id)?.abort();
    setUploads(current => {
      const item = current.find(entry => entry.id === id);
      if (item?.preview) URL.revokeObjectURL(item.preview);
      return current.filter(entry => entry.id !== id);
    });
  };
  const clearUploads = () => {
    controllers.current.forEach(controller => controller.abort());
    controllers.current.clear();
    setUploads(current => { current.forEach(item => item.preview && URL.revokeObjectURL(item.preview)); return []; });
    setPreviews(current => { Object.values(current).forEach(item => URL.revokeObjectURL(item.url)); return {}; });
  };
  const latest = useRef({ uploads, previews });
  latest.current = { uploads, previews };
  useEffect(() => () => {
    controllers.current.forEach(controller => controller.abort());
    latest.current.uploads.forEach(item => item.preview && URL.revokeObjectURL(item.preview));
    Object.values(latest.current.previews).forEach(item => URL.revokeObjectURL(item.url));
  }, []);
  // Release previews once their attachment leaves this assistant's draft, by removal or by sending.
  useEffect(() => {
    if (!draft.botId) return;
    const kept = new Set(draft.attachments.map(file => file.id));
    const stale = Object.entries(previews).filter(([id, item]) => item.botId === draft.botId && !kept.has(id));
    if (!stale.length) return;
    stale.forEach(([, item]) => URL.revokeObjectURL(item.url));
    setPreviews(current => Object.fromEntries(Object.entries(current).filter(([id]) => !stale.some(([staleId]) => staleId === id))));
  }, [draft, previews]);
  // A failed file still blocks sending, so a message never goes out quietly missing it.
  const uploading = uploads.some(item => item.botId === botId);
  return { draft, setDraft, draftReady, uploads: uploads.filter(item => item.botId === botId), previews, uploading, upload, retryUpload, cancelUpload, clearUploads };
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
