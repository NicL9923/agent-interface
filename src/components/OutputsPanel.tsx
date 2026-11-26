import { useEffect, useId, useState } from "react";
import { request } from "../client-api";
import type { DeliverableItem, DeliverableKind } from "../shared/deliverables";
import { eventCalendarFile, eventGoogleCalendarUrl } from "../shared/reply-cards";
import type { Bootstrap } from "../shared/types";
import { EmailDraftCard } from "./EmailDraftCard";
import { Icon } from "./Icon";
import { InlineUi } from "./InlineUi";
import { When } from "./When";
import { Button } from "./ui/button";
import { FormMessage } from "./ui/form-message";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import "./experience.css";

const FILTERS: { value: "all" | DeliverableKind; label: string }[] = [
  { value: "all", label: "All outputs" },
  { value: "view", label: "Interactive views" },
  { value: "card", label: "Cards & drafts" },
  { value: "file", label: "Files" },
];

function kindLabel(item: DeliverableItem) {
  if (item.kind === "view") return "Interactive view";
  if (item.kind === "file") return "File";
  if (item.card?.type === "email") return "Email draft";
  if (item.card?.type === "event") return "Calendar event";
  if (item.card?.type === "itinerary") return "Itinerary";
  return "Checklist";
}

function downloadIcs(title: string, content: string) {
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 40) || "event"
  }.ics`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function OutputsPanel({
  bootstrap,
  onOpenMessage,
}: {
  bootstrap: Bootstrap;
  onOpenMessage: (botId: string, messageId?: string) => void;
}) {
  const searchId = useId();
  const [kind, setKind] = useState<"all" | DeliverableKind>("all");
  const [botId, setBotId] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<DeliverableItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void request("GET /deliverables", {
      query: {
        kind,
        ...(botId ? { botId } : {}),
        ...(query.trim() ? { q: query.trim() } : {}),
      },
      signal: controller.signal,
    })
      .then((res) => {
        setItems(res.items);
        setSelectedId((current) =>
          res.items.some((item) => item.id === current) ? current : (res.items[0]?.id ?? ""),
        );
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Could not load outputs.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [kind, botId, query]);

  const selected = items.find((item) => item.id === selectedId) ?? items[0];

  return (
    <div className="today-panel outputs-panel">
      <div className="outputs-content">
        <div className="outputs-toolbar">
          <div className="outputs-filter-pills" role="tablist" aria-label="Output type">
            {FILTERS.map((filter) => (
              <Button
                key={filter.value}
                role="tab"
                aria-selected={kind === filter.value}
                className={kind === filter.value ? "primary" : undefined}
                onClick={() => setKind(filter.value)}
              >
                {filter.label}
              </Button>
            ))}
          </div>
          <div className="outputs-controls">
            <label htmlFor={searchId} className="sr-only">
              Search outputs
            </label>
            <Input
              id={searchId}
              type="search"
              placeholder="Search views, drafts, files…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <NativeSelect
              aria-label="Filter by assistant"
              value={botId}
              onChange={(event) => setBotId(event.target.value)}
            >
              <option value="">All assistants</option>
              {bootstrap.bots.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>

        {error && <FormMessage tone="error">{error}</FormMessage>}
        {loading && !items.length && (
          <p className="today-empty" role="status">
            Loading outputs…
          </p>
        )}
        {!loading && !items.length && !error && (
          <p className="today-empty">
            No saved interactive views, cards, drafts, or generated files yet.
          </p>
        )}

        {items.length > 0 && (
          <div className="outputs-grid">
            <ul className="outputs-list" aria-label="Deliverables">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`outputs-item${selected?.id === item.id ? " selected" : ""}`}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <strong>{item.title}</strong>
                    <small>
                      {item.botName} · {kindLabel(item)}
                      {item.createdAt && (
                        <>
                          {" "}
                          · <When value={item.createdAt} inline />
                        </>
                      )}
                    </small>
                  </button>
                </li>
              ))}
            </ul>

            {selected && (
              <section className="outputs-preview" aria-label={selected.title}>
                <header className="outputs-preview-header">
                  <div>
                    <p className="eyebrow">
                      {selected.botName} · {kindLabel(selected)}
                    </p>
                    <h2>{selected.title}</h2>
                  </div>
                  <Button onClick={() => onOpenMessage(selected.botId, selected.messageId)}>
                    Open in chat
                  </Button>
                </header>

                {selected.kind === "view" && selected.inlineDoc && (
                  <InlineUi document={selected.inlineDoc} />
                )}

                {selected.kind === "card" && selected.card?.type === "email" && (
                  <EmailDraftCard card={selected.card} />
                )}

                {selected.kind === "card" && selected.card?.type === "event" && (
                  <div className="outputs-card-detail">
                    <p>
                      <strong>Starts:</strong> {selected.card.start}
                    </p>
                    {selected.card.end && (
                      <p>
                        <strong>Ends:</strong> {selected.card.end}
                      </p>
                    )}
                    {selected.card.location && (
                      <p>
                        <strong>Location:</strong> {selected.card.location}
                      </p>
                    )}
                    {selected.card.description && <p>{selected.card.description}</p>}
                    <div className="outputs-card-actions">
                      <a
                        className="button"
                        href={eventGoogleCalendarUrl(selected.card)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open in Google Calendar
                      </a>
                      <Button
                        onClick={() =>
                          downloadIcs(
                            selected.card!.title,
                            eventCalendarFile(selected.card as never),
                          )
                        }
                      >
                        Download ICS
                      </Button>
                    </div>
                  </div>
                )}

                {selected.kind === "card" && selected.card?.type === "checklist" && (
                  <ul className="outputs-checklist">
                    {selected.card.items.map((item) => (
                      <li key={item.id}>{item.text}</li>
                    ))}
                  </ul>
                )}

                {selected.kind === "card" && selected.card?.type === "itinerary" && (
                  <ol className="outputs-checklist">
                    {selected.card.items.map((item) => (
                      <li key={item.id}>
                        <strong>{item.title}</strong>
                        {item.time ? ` · ${item.time}` : ""}
                        {item.detail ? ` — ${item.detail}` : ""}
                      </li>
                    ))}
                  </ol>
                )}

                {selected.kind === "file" && selected.file && (
                  <div className="outputs-file-detail">
                    {selected.file.mime.startsWith("image/") && (
                      <img
                        src={`/api/files/${encodeURIComponent(selected.file.id)}`}
                        alt={selected.file.name}
                        className="outputs-file-image"
                      />
                    )}
                    <p className="muted">
                      {selected.file.mime}
                      {selected.file.size ? ` · ${(selected.file.size / 1024).toFixed(1)} KB` : ""}
                    </p>
                    <a
                      className="button primary"
                      href={`/api/files/${encodeURIComponent(selected.file.id)}`}
                      download={selected.file.name}
                    >
                      <Icon name="download" size={16} /> Download {selected.file.name}
                    </a>
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
