import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { FileRef, SavedDraft } from "../shared/types";
import { api, ApiError, uploadFile, write } from "../client-api";
import { contentHash, mergeDraft, nextSeq, savedDraft } from "./draft-merge";
import { draftKey, isSentCopy, localRead, localSave, sameDraft } from "./storage";
import type { Draft, LocalUpload, Pending } from "./storage";
type Epoch = RefObject<number>;
type SetDraft = (update: (current: Draft) => Draft) => void;
const draftPath = (botId: string) => `/bots/${encodeURIComponent(botId)}/draft`;
// Keepalive requests in flight share a 64 KiB budget, and the browser rejects one over it. A
// save that does not fit is sent as an ordinary request instead.
const KEEPALIVE_BYTES = 60_000;
let keepaliveBytes = 0;
// Saves in flight per draft. A copy is not marked saved while an older save may still land.
const inFlight = new Map<string, number>();
// Consecutive failed saves per draft, for the retry backoff: 1 s, 2 s, 4 s, up to 30 s.
const failures = new Map<string, number>();
/**
 * Saves a draft on its base revision, then merges the response into the open copy and the cached
 * copy. Afterwards one rule holds: a copy left unsaved with no save in flight saves again, from
 * the persistence effect for the open draft (`settle`), or here for a draft no longer shown.
 */
async function saveDraft(options: {
  userId: string;
  botId: string;
  draft: Draft;
  setDraft: SetDraft;
  /** False once the identity changed, so nothing is written for the wrong person. */
  live(): boolean;
  shown(): boolean;
  /** Lets the open draft's persistence effect check the rule again. */
  settle?(): void;
  keepalive?: boolean;
}, retries = 3): Promise<void> {
  const { userId, botId, draft, setDraft, live, shown, keepalive } = options;
  if (!live()) return;
  const key = draftKey(userId, botId);
  const seq = draft.seq ?? 0;
  const body = { text: draft.text, attachments: draft.attachments, baseRevision: draft.baseRevision ?? 0 };
  let server: SavedDraft;
  let conflict = false;
  inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
  const bytes = keepalive ? new Blob([JSON.stringify(body)]).size : 0;
  const budgeted = keepalive && keepaliveBytes + bytes <= KEEPALIVE_BYTES;
  if (budgeted) keepaliveBytes += bytes;
  try {
    server = savedDraft(await (budgeted
      ? write<SavedDraft>(draftPath(botId), body, "PUT", { keepalive: true })
      : write<SavedDraft>(draftPath(botId), body, "PUT")));
  } catch (e) {
    if (!(e instanceof ApiError && e.code === "draft_conflict")) {
      // A failed or timed-out save leaves the copy unsaved: check the rule again after a backoff.
      const count = (failures.get(key) ?? 0) + 1;
      failures.set(key, count);
      setTimeout(() => {
        if (!live()) return;
        options.settle?.();
        const cached = localRead<Draft>(key);
        if (cached?.dirty && !inFlight.has(key) && !shown()) void saveDraft({ ...options, draft: cached }, retries);
      }, Math.min(30_000, 1000 * 2 ** (count - 1)));
      return;
    }
    server = savedDraft(e.data?.draft);
    conflict = true;
  } finally {
    if (budgeted) keepaliveBytes -= bytes;
    const left = (inFlight.get(key) ?? 1) - 1;
    if (left > 0) inFlight.set(key, left); else inFlight.delete(key);
  }
  failures.delete(key);
  if (!live()) return;
  const settled = !inFlight.has(key);
  // Applied to the copy as it is now. A 409 for the latest edit is the server's word, even if older.
  const update = (local: Draft) =>
    mergeDraft(local, server, { settled, authoritative: conflict && settled && (local.seq ?? 0) === seq }).draft;
  const cached = localRead<Draft>(key);
  const next = cached ? update(cached) : undefined;
  if (next) localSave(key, next);
  setDraft(current => current.botId === botId && current.userId === userId ? update(current) : current);
  options.settle?.();
  if (next?.dirty && !inFlight.has(key) && retries > 0 && !shown())
    await saveDraft({ ...options, draft: next }, retries - 1);
}
export function useDraft({ botId, userId, identityEpoch, setError }: {
  botId: string;
  userId?: string;
  identityEpoch: Epoch;
  setError(update: string | ((previous: string) => string)): void;
}) {
  const [draft, setDraftState] = useState<Draft>({ text: "", attachments: [] });
  // A change that leaves the copy unsaved with new content is a local edit and gets a new sequence.
  const setDraft = useCallback((update: Draft | ((current: Draft) => Draft)) => setDraftState(current => {
    const next = typeof update === "function" ? update(current) : update;
    return next !== current && next.dirty && !sameDraft(next, current) ? { ...next, seq: nextSeq() } : next;
  }), []);
  const [draftReady, setDraftReady] = useState(false);
  useEffect(() => {
    if (!botId || !userId) return;
    let live = true;
    setDraftReady(false);
    const cached = localRead<Draft>(draftKey(userId, botId));
    // A cached copy is shown at once, but the server's copy is still read, and read again while
    // the page is shown: it may have been edited or sent from another device since.
    let draftLoaded = false;
    let loadingDraft = false;
    setDraft({ ...(cached || { text: "", attachments: [] }), botId, userId });
    if (cached) setDraftReady(true);
    // Personal drafts remain available even when the separate executor is down.
    const loadDraft = async () => {
      if (loadingDraft) return;
      loadingDraft = true;
      try {
        const saved = savedDraft(await api<SavedDraft | null>(draftPath(botId)));
        if (!live) return;
        draftLoaded = true;
        setDraft(current => mergeDraft(current, saved, { settled: !inFlight.has(draftKey(userId, botId)) }).draft);
        setDraftReady(true);
        setError(previous => previous.startsWith("Your saved draft could not be loaded.") ? "" : previous);
      } catch (e) {
        // Unsaved text on screen is already the person's draft, and a loaded draft stays usable;
        // keep retrying quietly.
        if (live && !draftLoaded && !cached?.dirty) setError(`Your saved draft could not be loaded. Retrying. ${(e as Error).message}`);
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
      const loaded = savedDraft(await api<SavedDraft | null>(draftPath(uploadBot)));
      // They may have come back while the saved draft loaded.
      await settle();
      if (!live()) return false;
      if (visible()) return true;
      saved = localRead<Draft>(key) ?? { text: loaded.text, attachments: loaded.attachments, baseRevision: loaded.revision, baseHash: contentHash(loaded) };
    }
    const target = { ...saved, attachments: [...saved.attachments, result], dirty: true };
    if (!live()) return false;
    localSave(key, target);
    void saveDraft({ userId: uploadUser, botId: uploadBot, draft: target, setDraft, live, shown });
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
  setDraft: SetDraft;
  draftReady: boolean;
  botId: string;
  userId?: string;
  identityEpoch: Epoch;
  offline: boolean;
  appUnavailable: boolean;
  pending: Pending | null;
}) {
  // Assigned during render, so an effect cleanup sees where the person is going.
  const open = useRef({ botId, userId });
  open.current = { botId, userId };
  // Advanced after every save response, so the effect checks again whether the draft needs one.
  const [settled, setSettled] = useState(0);
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
    if (!draft.dirty || offline || appUnavailable || pending && pending.botId === botId && isSentCopy(draft) && sameDraft(pending, draft)) return;
    const epoch = identityEpoch.current;
    let saved = false;
    const save = (keepalive = false) => {
      if (saved) return;
      saved = true;
      stop();
      void saveDraft({
        userId: user, botId, draft, setDraft, keepalive,
        live: () => epoch === identityEpoch.current,
        shown: () => open.current.botId === botId && open.current.userId === user,
        settle: () => setSettled(count => count + 1),
      });
    };
    // A closing or hidden page may never run the timer.
    const leave = () => save(true);
    const hide = () => { if (document.visibilityState === "hidden") save(true); };
    // One save at a time: a save in flight checks again when its response is merged.
    const timer = inFlight.has(draftKey(user, botId)) ? undefined : setTimeout(save, 350);
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", hide);
    function stop() {
      clearTimeout(timer);
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", hide);
    }
    return () => {
      stop();
      // Leaving this assistant sends the pending edit now. A newer edit here replaces it instead.
      if (open.current.botId !== botId || open.current.userId !== user) save(true);
    };
  }, [draft, botId, draftReady, userId, offline, appUnavailable, pending, settled]);
}
