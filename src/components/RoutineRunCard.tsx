import { memo, useId, useState } from "react";
import { request } from "../client-api";
import { routeUrl } from "../shared/api";
import { runStatusLabel, runTone, type RoutineRun } from "../shared/routine-runs";
import { useAction } from "../app/use-action";
import { useResource } from "../app/use-resource";
import { Icon } from "./Icon";
import { MessageMarkdown } from "./MessageMarkdown";
import { When } from "./When";
import "./routine-runs.css";

/** Whether the status word shows beside the name, because the run needs a look. */
const flagged = (run: RoutineRun) => run.status === "failed" || run.status === "running" || run.status === "succeeded" && !!run.deliveryFailed;

/**
 * One routine run in the conversation, collapsed by default: a status dot, the routine's name,
 * when it ran and a line of its output. Opened, it reads the run's output and offers Save output,
 * All results and hiding this routine's runs from the chat.
 */
export const RoutineRunCard = memo(function RoutineRunCard({ run, botId, onResults, onHide }: {
  run: RoutineRun;
  botId: string;
  onResults(routineId: string, resultId: string): void;
  onHide(routineId: string, routineName: string): void;
}) {
  const [open, setOpen] = useState(false);
  const body = useId();
  const status = runStatusLabel(run);
  const at = run.startedAt ?? run.finishedAt!;
  const params = { botId, routineId: run.routineId, resultId: run.id };
  // Read only once opened; a running run reads again when it finishes.
  const output = useResource(open ? routeUrl("GET /bots/:botId/routines/:routineId/results/:resultId", params) : null, {
    load: (_, signal) => request("GET /bots/:botId/routines/:routineId/results/:resultId", { params, signal }),
    deps: [run.status, run.finishedAt],
  });
  const save = useAction();
  const preview = (run.status === "failed" ? run.error || run.preview : run.preview)?.trim();
  return <article className={`routine-run run-${runTone(run)}${open ? " open" : ""}`} data-place-id={`run:${run.routineId}:${run.id}`} data-run-id={run.id}>
    <button type="button" className="routine-run-summary" aria-expanded={open} aria-controls={body} onClick={() => setOpen(value => !value)}>
      <span className="run-dot" aria-hidden="true" />
      <span className="routine-run-heading">
        <span className="routine-run-name">{run.routineName}</span>
        <span className="routine-run-meta">
          {!open && <span className={flagged(run) ? "routine-run-state" : "sr-only"}>{status}</span>}
          <When value={at} inline />
        </span>
        {!open && preview && <span className="routine-run-preview">{preview}</span>}
      </span>
      <span className="routine-run-chevron" aria-hidden="true" />
    </button>
    {open && <div className="routine-run-body" id={body}>
      <dl className="routine-run-facts">
        <div><dt>Status</dt><dd><span className="run-dot" aria-hidden="true" />{status}</dd></div>
        {run.startedAt && <div><dt>Started</dt><dd><When value={run.startedAt} /></dd></div>}
        {run.finishedAt && run.status !== "running" && <div><dt>Finished</dt><dd><When value={run.finishedAt} from={run.startedAt} /></dd></div>}
      </dl>
      {run.status === "failed" && run.error && <p className="routine-run-error">{run.error}</p>}
      {run.deliveryFailed && <p className="routine-run-note">Hermes couldn't deliver this output where the routine sends it.</p>}
      {output.error ? <p className="routine-run-note" role="alert">{output.error}</p>
        : !output.data ? <p className="routine-run-note" role="status"><Icon name="spinner" className="spin" size={14} /> Loading output…</p>
        : <div className="routine-run-output">
          {output.data.previewOnly && <p className="routine-run-note">Hermes saved a preview of this script run. The full output stays in its cron output files.</p>}
          {!output.data.messages.length && <p className="routine-run-note">No output was saved for this run.</p>}
          {output.data.messages.map(message => <div key={message.id} className="routine-run-message">
            <MessageMarkdown text={message.text} />
            {message.files?.map(file => <a className="file-link" key={file.id} href={file.url || `/api/files/${encodeURIComponent(file.id)}`} target="_blank" rel="noreferrer">
              <span><Icon name="file" size={16} /> {file.name}</span>
            </a>)}
          </div>)}
        </div>}
      {(save.error || save.notice) && <p className={save.error ? "routine-run-error" : "routine-run-note"} role="status">{save.error || save.notice}</p>}
      <div className="routine-run-actions">
        <button type="button" disabled={!output.data || save.busy}
          onClick={() => void save.run(() => request("POST /saved", { body: { kind: "routine", botId, routineId: run.routineId, resultId: run.id, title: run.routineName.slice(0, 120) } }), { success: "Saved to your saved items." })}>
          <Icon name={save.busy ? "spinner" : "bookmark"} className={save.busy ? "spin" : undefined} size={16} />Save output
        </button>
        <button type="button" onClick={() => onResults(run.routineId, run.id)}><Icon name="external" size={16} />All results</button>
        <button type="button" onClick={() => onHide(run.routineId, run.routineName)}>Hide this routine in chat</button>
      </div>
    </div>}
  </article>;
});
