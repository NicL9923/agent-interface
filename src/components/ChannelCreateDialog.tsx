import { useId, useState } from "react";
import { request } from "../client-api";
import type { Bot } from "../shared/types";
import { Icon } from "./Icon";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { FormMessage } from "./ui/form-message";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

export function ChannelCreateDialog({
  main,
  onClose,
  onCreated,
}: {
  main: Bot;
  onClose: () => void;
  onCreated: (botId: string) => void;
}) {
  const titleId = useId();
  const topicId = useId();
  const [topic, setTopic] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const cleaned = topic.trim().replace(/^#+/, "").trim();
    if (!cleaned || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await request("POST /channels", {
        body: {
          topic: cleaned,
          ...(description.trim() ? { description: description.trim() } : {}),
        },
      });
      onCreated(result.bot.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create topic channel.");
      setBusy(false);
    }
  }

  return (
    <Dialog
      className="settings-sheet channel-create-dialog"
      aria-labelledby={titleId}
      initialFocus={`#${CSS.escape(topicId)}`}
      onCancel={onClose}
      onClose={onClose}
    >
      <header className="sheet-header">
        <h2 id={titleId}>New topic channel</h2>
        <Button className="sheet-close" aria-label="Close channel creator" onClick={onClose}>
          <Icon name="close" />
        </Button>
      </header>
      <form className="sheet-body brain-dump-form" onSubmit={(event) => void submit(event)}>
        <p className="muted">
          Create a focused space under {main.name}. It inherits your model, integrations, and shared
          personal memory automatically.
        </p>
        <label htmlFor={topicId} className="channel-field">
          <span>Topic</span>
          <Input
            id={topicId}
            maxLength={60}
            placeholder="Finances, House Reno, Summer Trip…"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
          />
        </label>
        <label className="channel-field">
          <span>Focus (optional)</span>
          <Textarea
            rows={3}
            maxLength={400}
            placeholder="What should stay organized in this channel?"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        {error && <FormMessage tone="error">{error}</FormMessage>}
        <div className="brain-dump-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" className="primary" disabled={busy || !topic.trim()}>
            {busy ? "Creating…" : "Create channel"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
