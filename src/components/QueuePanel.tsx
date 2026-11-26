import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiError, queueApi } from "../client-api";
import { MAX_MESSAGE_TEXT, routeUrl } from "../shared/api";
import type { BotQueue, QueuedMessage } from "../shared/queue";
import type { Bootstrap, Bot } from "../shared/types";
import { botCapability } from "../app/harness";
import { useAction } from "../app/use-action";
import { useResource } from "../app/use-resource";
import { QUEUE_EVENT } from "../app/use-conversation";
import { Icon } from "./Icon";
import "./queue-panel.css";

/** How often the queue is read while a turn runs or messages wait. */
export const QUEUE_POLL_MS = 3000;
const STARTED =
  "That message already started, so it can't be changed. The queue now shows what is still waiting.";

type Focus = { id: string; control: "edit" | "up" | "down" };

/**
 * Messages sent during a turn on a harness without native steering wait here for the next turn. The
 * panel appears above the message box only while at least one waits, and never for a Hermes bot.
 */
export function QueuePanel({ boot, bot, active }: { boot: Bootstrap; bot: Bot; active: boolean }) {
  // Most bots have no queue, so they mount none of its state: typing in their chat stays one commit
  // per keystroke (tests/keystroke-delta-work.test.ts).
  const supported = !!botCapability(boot, bot, "queueManagement")?.supported;
  return supported ? <LiveQueue bot={bot} active={active} /> : null;
}

function LiveQueue({ bot, active }: { bot: Bot; active: boolean }) {
  const [waiting, setWaiting] = useState(false);
  const queue = useResource<BotQueue>(routeUrl("GET /bots/:id/queue", { id: bot.id }), {
    load: (_, signal) => queueApi.read(bot.id, signal),
    // A turn that ends starts the next queued message, so the queue is read again then.
    deps: [active],
    pollMs: active || waiting ? QUEUE_POLL_MS : undefined,
    wake: true,
    onData: (value) => setWaiting(value.items.length > 0),
  });
  const reloadQueue = queue.reload;
  useEffect(() => {
    const onQueue = (event: Event) => {
      const detail = (event as CustomEvent<{ botId?: string }>).detail;
      if (detail?.botId === bot.id) void reloadQueue();
    };
    window.addEventListener(QUEUE_EVENT, onQueue);
    return () => window.removeEventListener(QUEUE_EVENT, onQueue);
  }, [bot.id, reloadQueue]);
  const items = queue.data?.items ?? [];
  const action = useAction();
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const controls = useRef(new Map<string, HTMLElement>());
  const focusNext = useRef<Focus | null>(null);
  const headingId = useId();
  // Moving an item moves its row, which can drop focus; it lands back on the same control,
  // or the other move button once that one stops applying.
  useEffect(() => {
    const next = focusNext.current;
    if (!next) return;
    focusNext.current = null;
    const control = (name: Focus["control"]) =>
      controls.current.get(`${next.id}:${name}`) as HTMLButtonElement | undefined;
    const target = control(next.control);
    const fallback = next.control === "up" ? control("down") : control("up");
    (target && !target.disabled
      ? target
      : fallback && !fallback.disabled
        ? fallback
        : target
    )?.focus();
  }, [queue.data, editing]);
  // An item that left the queue, because it started or another device removed it, ends its edit.
  useEffect(() => {
    if (editing && queue.data && !queue.data.items.some((item) => item.id === editing.id))
      setEditing(null);
  }, [queue.data, editing]);
  if (!items.length) return null;

  const change = (
    work: () => Promise<BotQueue>,
    done: string,
    then?: { focus?: Focus; finishEdit?: boolean },
  ) =>
    void action.run(
      async () => {
        const next = await work();
        setWaiting(next.items.length > 0);
        queue.setData(next);
        if (then?.finishEdit) setEditing(null);
        if (then?.focus) focusNext.current = then.focus;
        setAnnouncement(done);
      },
      {
        onError: (cause) => {
          if (!(cause instanceof ApiError) || cause.status !== 409) return;
          void queue.reload();
          return STARTED;
        },
      },
    );
  const move = (item: QueuedMessage, index: number, direction: "up" | "down") =>
    change(
      () =>
        queueApi.reorder(
          bot.id,
          item.id,
          direction === "up" ? items[index - 1]!.id : (items[index + 2]?.id ?? null),
        ),
      direction === "up" ? "Moved up." : "Moved down.",
      { focus: { id: item.id, control: direction } },
    );
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const { id, text } = editing;
    change(() => queueApi.edit(bot.id, id, text), "Saved the queued message.", {
      finishEdit: true,
      focus: { id, control: "edit" },
    });
  };
  const ref = (key: string) => (element: HTMLElement | null) => {
    if (element) controls.current.set(key, element);
    else controls.current.delete(key);
  };
  return (
    <section className="queue-panel" aria-labelledby={headingId}>
      <h2 className="queue-heading" id={headingId}>
        <Icon name="scroll" size={15} />
        {items.length === 1 ? "1 message queued" : `${items.length} messages queued`}
        <span className="queue-hint">· sends after the current reply</span>
      </h2>
      <ol className="queue-list">
        {items.map((item, index) => {
          const original = item.text;
          const draft = editing?.id === item.id ? editing.text : null;
          const preview = original.trim() || (item.attachments?.length ? "Attachments only" : "");
          return (
            <li className="queue-item" key={item.id}>
              {draft !== null ? (
                <form className="queue-edit" onSubmit={save}>
                  <label className="sr-only" htmlFor={`queue-edit-${item.id}`}>
                    Edit queued message {index + 1}
                  </label>
                  <textarea
                    id={`queue-edit-${item.id}`}
                    rows={2}
                    autoFocus
                    maxLength={MAX_MESSAGE_TEXT}
                    value={draft}
                    disabled={action.busy}
                    onChange={(event) => setEditing({ id: item.id, text: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key !== "Escape") return;
                      event.preventDefault();
                      event.stopPropagation();
                      setEditing(null);
                      focusNext.current = { id: item.id, control: "edit" };
                    }}
                  />
                  <div className="queue-actions">
                    <button
                      type="submit"
                      className="primary"
                      disabled={action.busy || !draft.trim() || draft === original}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      disabled={action.busy}
                      onClick={() => {
                        setEditing(null);
                        focusNext.current = { id: item.id, control: "edit" };
                      }}
                    >
                      Keep original
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <p className="queue-text">{preview}</p>
                  <div className="queue-actions">
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Edit queued message ${index + 1}`}
                      title="Edit"
                      ref={ref(`${item.id}:edit`)}
                      disabled={action.busy || !!editing}
                      onClick={() => setEditing({ id: item.id, text: original })}
                    >
                      <Icon name="pencil" size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Move queued message ${index + 1} up`}
                      title="Move up"
                      ref={ref(`${item.id}:up`)}
                      disabled={action.busy || !!editing || index === 0}
                      onClick={() => move(item, index, "up")}
                    >
                      <Icon name="chevron-up" size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Move queued message ${index + 1} down`}
                      title="Move down"
                      ref={ref(`${item.id}:down`)}
                      disabled={action.busy || !!editing || index === items.length - 1}
                      onClick={() => move(item, index, "down")}
                    >
                      <Icon name="chevron-down" size={16} />
                    </button>
                    <button
                      type="button"
                      className="queue-send"
                      aria-label={`Send queued message ${index + 1} now`}
                      disabled={action.busy || !!editing}
                      onClick={() =>
                        change(() => queueApi.sendNow(bot.id, item.id), "Sending it now.")
                      }
                    >
                      <Icon name="send" size={14} />
                      <span>Send now</span>
                    </button>
                    <button
                      type="button"
                      className="icon-button queue-cancel"
                      aria-label={`Cancel queued message ${index + 1}`}
                      title="Cancel"
                      disabled={action.busy || !!editing}
                      onClick={() =>
                        change(() => queueApi.cancel(bot.id, item.id), "Cancelled the message.")
                      }
                    >
                      <Icon name="close" size={16} />
                    </button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ol>
      {action.error && (
        <p className="queue-error" role="alert">
          {action.error}
        </p>
      )}
      <p className="sr-only" role="status">
        {announcement}
      </p>
    </section>
  );
}
