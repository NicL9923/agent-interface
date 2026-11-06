import type { Talk } from "../app/use-talk";
import { Icon } from "./Icon";
import "./talk.css";

const statusText = (talk: Talk, name: string) => ({
  idle: "",
  connecting: "Connecting…",
  listening: "Listening",
  thinking: `${name} is thinking`,
  working: `${name} is working on it`,
  speaking: `${name} is speaking`,
})[talk.status];

/** The live conversation above the composer: what is happening, the latest words from each side, mute and end. */
export function TalkPanel({ talk, name }: { talk: Talk; name: string }) {
  if (talk.status === "idle") {
    const message = talk.error || talk.notice;
    if (!message) return null;
    return <div className={`talk-panel talk-message${talk.error ? " talk-error" : ""}`} role={talk.error ? "alert" : "status"}>
      <Icon name={talk.error ? "alert" : "talk"} size={16} />
      <p>{message}</p>
      <button type="button" className="icon-button" aria-label="Dismiss" onClick={talk.dismiss}><Icon name="close" size={14} /></button>
    </div>;
  }
  const { you, assistant } = talk.captions;
  return <section className="talk-panel" data-talk-status={talk.status} aria-label={`Live talk with ${name}`}>
    <div className="talk-head">
      <span className="talk-meter" aria-hidden="true"><i /><i /><i /><i /><i /></span>
      <p className="talk-status" role="status">{statusText(talk, name)}{talk.muted ? " · muted" : ""}</p>
      <div className="talk-actions">
        <button type="button" aria-label="Mute microphone" aria-pressed={talk.muted} disabled={talk.status === "connecting"} onClick={talk.toggleMute}>
          <Icon name={talk.muted ? "micOff" : "mic"} size={16} /><span>{talk.muted ? "Unmute" : "Mute"}</span>
        </button>
        <button type="button" className="talk-end" aria-label="End talk" onClick={talk.end}><Icon name="stop" size={14} /><span>End</span></button>
      </div>
    </div>
    {(you || assistant) && <div className="talk-captions">
      {you && <p><span className="talk-who">You</span>{you}</p>}
      {assistant && <p><span className="talk-who">{name}</span>{assistant}</p>}
    </div>}
    {talk.error && <p className="talk-inline-error" role="alert">{talk.error}</p>}
  </section>;
}
