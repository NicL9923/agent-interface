import { useEffect, useRef, useState } from 'react';
import { api, write } from '../client-api';
import type { RoutineOutput, RoutineResult } from '../shared/collaboration';
import { MessageMarkdown } from './MessageMarkdown';
import './collaboration.css';

export function RoutineResults({ botId, routineId, userId, resultId, onClose }: { botId: string; routineId: string; userId: string; resultId?: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [runs, setRuns] = useState<RoutineResult[]>([]);
  const [selected, setSelected] = useState(resultId || '');
  const [output, setOutput] = useState<RoutineOutput | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const path = `/bots/${encodeURIComponent(botId)}/routines/${encodeURIComponent(routineId)}/results`;
  useEffect(() => { const previous = document.activeElement as HTMLElement; dialog.current?.showModal(); return () => { dialog.current?.close(); previous?.focus(); }; }, []);
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
  return <dialog ref={dialog} className="routine-results-dialog" aria-labelledby="routine-results-title" onCancel={onClose}>
    <div className="panel-header"><h2 id="routine-results-title">Routine results</h2><button onClick={onClose} aria-label="Close routine results">Close</button></div>
    <p className="muted">Recent runs saved by Hermes, including scheduled runs and trials.</p>
    <button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)}>Refresh results</button>
    {error && <p role="alert" className="form-error">{error}</p>}
    {loading && <p role="status">Loading routine history…</p>}
    {!loading && !runs.length && !error && <p>No saved runs yet. Run the routine or return after its next scheduled run.</p>}
    {!!runs.length && <label>Run<select value={selected} onChange={event => setSelected(event.target.value)}>{runs.map(run => <option key={run.id} value={run.id}>{run.startedAt ? new Date(run.startedAt).toLocaleString() : run.title}</option>)}</select></label>}
    {selected && !output && !error && <p role="status">Loading output…</p>}
    {output && <div className="routine-output"><button onClick={()=>void write("/saved",{kind:"routine",botId,routineId,resultId:selected,title:(runs.find(run=>run.id===selected)?.title||"Routine output").slice(0,120)}).then(()=>setError("Saved to your saved items.")).catch(e=>setError((e as Error).message))}>Save output</button>{output.previewOnly && <p className="capability-note">Hermes exposes a preview for this script run. Its full output is available in the native cron output files.</p>}
      {!output.messages.length && <p>No assistant output was saved for this run.</p>}
      {output.messages.map(message => <article key={message.id}><MessageMarkdown text={message.text} />{message.files?.map(file => <a className="file-link" key={file.id} href={file.url || `/api/files/${encodeURIComponent(file.id)}`} target="_blank" rel="noreferrer">{file.name}</a>)}</article>)}
    </div>}
  </dialog>;
}
