import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { NativeSelect } from "./ui/native-select";
import { useEffect, useState } from 'react';
import { api, write } from '../client-api';
import type { RoutineOutput, RoutineResult } from '../shared/collaboration';
import { MessageMarkdown } from './MessageMarkdown';
import './collaboration.css';
import { formatWhen } from '../time';
import { useMinute } from './When';

export function RoutineResults({ botId, routineId, userId, resultId, onClose }: { botId: string; routineId: string; userId: string; resultId?: string; onClose: () => void }) {
  useMinute();
  const [runs, setRuns] = useState<RoutineResult[]>([]);
  const [selected, setSelected] = useState(resultId || '');
  const [output, setOutput] = useState<RoutineOutput | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const path = `/bots/${encodeURIComponent(botId)}/routines/${encodeURIComponent(routineId)}/results`;
  useEffect(() => {
    let live = true; setLoading(true); setError('');
    void api<RoutineResult[]>(path).then(value => { if (live) { setRuns(value); setSelected(current => value.some(run => run.id === current) ? current : value[0]?.id || ''); } })
      .catch(e => { if (live) setError((e as Error).message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [path, revision]);
  useEffect(() => {
    let live = true; setOutput(null);
    if (selected) void api<RoutineOutput>(`${path}/${encodeURIComponent(selected)}`).then(value => { if (live) { setOutput(value); setError(''); } }).catch(e => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [path, selected, revision]);
  return <Dialog className="routine-results-dialog" aria-labelledby="routine-results-title" onCancel={onClose}>
    <div className="panel-header"><h2 id="routine-results-title">Routine results</h2><Button onClick={onClose} aria-label="Close routine results">Close</Button></div>
    <p className="muted">Recent runs saved by Hermes, including scheduled runs and trials.</p>
    <Button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)}>Refresh results</Button>
    {error && <p role="alert" className="form-error">{error}</p>}
    {loading && <p role="status">Loading routine history…</p>}
    {!loading && !runs.length && !error && <p>No saved runs yet. Run the routine or return after its next scheduled run.</p>}
    {!!runs.length && <label>Run<NativeSelect value={selected} onChange={event => setSelected(event.target.value)}>{runs.map(run => <option key={run.id} value={run.id}>{run.startedAt && formatWhen(run.startedAt) || run.title}</option>)}</NativeSelect></label>}
    {selected && !output && !error && <p role="status">Loading output…</p>}
    {output && <div className="routine-output"><Button onClick={()=>void write("/saved",{kind:"routine",botId,routineId,resultId:selected,title:(runs.find(run=>run.id===selected)?.title||"Routine output").slice(0,120)}).then(()=>setError("Saved to your saved items.")).catch(e=>setError((e as Error).message))}>Save output</Button>{output.previewOnly && <p className="capability-note">Hermes exposes a preview for this script run. Its full output is available in the native cron output files.</p>}
      {!output.messages.length && <p>No assistant output was saved for this run.</p>}
      {output.messages.map(message => <article key={message.id}><MessageMarkdown text={message.text} />{message.files?.map(file => <a className="file-link" key={file.id} href={file.url || `/api/files/${encodeURIComponent(file.id)}`} target="_blank" rel="noreferrer">{file.name}</a>)}</article>)}
    </div>}
  </Dialog>;
}
