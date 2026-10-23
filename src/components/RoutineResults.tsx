import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { NativeSelect } from "./ui/native-select";
import { useState } from 'react';
import { write } from '../client-api';
import { useAction } from '../app/use-action';
import { useResource } from '../app/use-resource';
import { FormMessage } from './ui/form-message';
import type { RoutineOutput, RoutineResult } from '../shared/collaboration';
import { MessageMarkdown } from './MessageMarkdown';
import './collaboration.css';
import { formatWhen } from '../time';
import { useMinute } from './When';

export function RoutineResults({ botId, routineId, userId, resultId, onClose }: { botId: string; routineId: string; userId: string; resultId?: string; onClose: () => void }) {
  useMinute();
  const [selected, setSelected] = useState(resultId || '');
  const path = `/bots/${encodeURIComponent(botId)}/routines/${encodeURIComponent(routineId)}/results`;
  const list = useResource<RoutineResult[]>(path, {
    onData: value => setSelected(current => value.some(run => run.id === current) ? current : value[0]?.id || ''),
  });
  const output = useResource<RoutineOutput>(selected ? `${path}/${encodeURIComponent(selected)}` : null);
  const save = useAction();
  const runs = list.data || [];
  const loading = list.loading;
  const error = save.error || list.error || output.error;
  const refresh = () => { void list.reload(); void output.reload(); };
  return <Dialog className="routine-results-dialog" aria-labelledby="routine-results-title" onCancel={onClose}>
    <div className="panel-header"><h2 id="routine-results-title">Routine results</h2><Button onClick={onClose} aria-label="Close routine results">Close</Button></div>
    <p className="muted">Recent runs saved by Hermes, including scheduled runs and trials.</p>
    <Button type="button" disabled={loading} onClick={refresh}>Refresh results</Button>
    {error && <FormMessage tone="error">{error}</FormMessage>}{save.notice && <FormMessage tone="notice">{save.notice}</FormMessage>}
    {loading && <p role="status">Loading routine history…</p>}
    {!loading && !runs.length && !error && <p>No saved runs yet. Run the routine or return after its next scheduled run.</p>}
    {!!runs.length && <label>Run<NativeSelect value={selected} onChange={event => setSelected(event.target.value)}>{runs.map(run => <option key={run.id} value={run.id}>{run.startedAt && formatWhen(run.startedAt) || run.title}</option>)}</NativeSelect></label>}
    {selected && !output.data && !error && <p role="status">Loading output…</p>}
    {output.data && <div className="routine-output"><Button disabled={save.busy} onClick={()=>void save.run(()=>write("/saved",{kind:"routine",botId,routineId,resultId:selected,title:(runs.find(run=>run.id===selected)?.title||"Routine output").slice(0,120)}),{success:"Saved to your saved items."})}>Save output</Button>{output.data.previewOnly && <p className="capability-note">Hermes exposes a preview for this script run. Its full output is available in the native cron output files.</p>}
      {!output.data.messages.length && <p>No assistant output was saved for this run.</p>}
      {output.data.messages.map(message => <article key={message.id}><MessageMarkdown text={message.text} />{message.files?.map(file => <a className="file-link" key={file.id} href={file.url || `/api/files/${encodeURIComponent(file.id)}`} target="_blank" rel="noreferrer">{file.name}</a>)}</article>)}
    </div>}
  </Dialog>;
}
