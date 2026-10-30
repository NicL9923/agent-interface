import { useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { AttentionRequest } from "../shared/types";
import { request as apiRequest } from "../client-api";
import { Icon } from "../components/Icon";
import { attentionAnchor, joinAnswer, nextUnanswered, optionForKey, toggleOption } from "./transcript-logic";

type Question = NonNullable<AttentionRequest["questions"]>[number];
/** One question's answer as the card holds it: chosen options, and the person's own words when they chose to write them. */
type Draft = { selected: string[]; own: boolean; text: string };
const empty: Draft = { selected: [], own: false, text: "" };
/** The text a question sends. */
export function answerText(question: Question, draft: Draft = empty) {
  if (!question.options?.length) return draft.text;
  if (question.multiple) return joinAnswer(draft.selected, draft.own ? draft.text : "");
  return draft.own ? draft.text : draft.selected[0] ?? "";
}

export function AttentionCard({ request, botId, report }: { request: AttentionRequest; botId: string; report(message: string): void }) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false);
  const [settled, setSettled] = useState(false);
  const guidance = useId();
  const questions = request.questions ?? [];
  const answers = Object.fromEntries(questions.map(question => [question.id, answerText(question, drafts[question.id])]));
  const card = useRef<HTMLElement>(null);
  // A pointer choice or a number key moves on; arrow keys stay so options can be browsed.
  const pointer = useRef(false);
  const update = (question: Question, change: (draft: Draft) => Draft) =>
    setDrafts(current => ({ ...current, [question.id]: change(current[question.id] ?? empty) }));
  const advance = (index: number, next: Record<string, string>) => {
    const following = nextUnanswered(questions, next, index);
    // The DOM settles first, so a revealed field or the enabled Send button can take focus.
    requestAnimationFrame(() => {
      const root = card.current;
      if (!root) return;
      const target = following === undefined
        ? root.querySelector<HTMLElement>("button[type=submit]")
        : root.querySelector<HTMLElement>(`[data-question="${following}"] input:checked, [data-question="${following}"] input, [data-question="${following}"] textarea`);
      target?.focus();
    });
  };
  const field = (index: number) => requestAnimationFrame(() =>
    card.current?.querySelector<HTMLTextAreaElement>(`[data-question="${index}"] textarea`)?.focus());
  // Choosing "Write my own answer" goes to its field. A single choice moves on to the next question.
  const choose = (question: Question, index: number, option: string | null, moveOn: boolean) => {
    const draft = drafts[question.id] ?? empty;
    if (question.multiple) {
      update(question, current => option === null ? { ...current, own: !current.own } : { ...current, selected: toggleOption(question.options!, current.selected, option) });
      if (option === null && !draft.own) field(index);
      return;
    }
    update(question, current => option === null ? { ...current, own: true, selected: [] } : { ...current, own: false, selected: [option] });
    if (option === null) field(index);
    else if (moveOn) advance(index, { ...answers, [question.id]: option });
  };
  const keys = (question: Question, index: number) => (event: KeyboardEvent) => {
    pointer.current = false;
    if (event.target instanceof HTMLTextAreaElement) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const options = question.options ?? [];
    const pick = optionForKey(event.key, options.length + 1);
    if (pick === undefined) return;
    event.preventDefault();
    if (question.multiple && pick < options.length) card.current?.querySelectorAll<HTMLInputElement>(`[data-question="${index}"] .option-card input`)[pick]?.focus();
    choose(question, index, pick < options.length ? options[pick] : null, true);
  };
  return (
    <article className="approval-card attention-card" ref={card} {...attentionAnchor(request.kind, request.id)}>
      <p className="eyebrow">{request.kind === "clarify" ? "A question for you" : "Continue in Hermes"}</p>
      <h2>{request.title}</h2>
      <p>{request.detail}</p>
      {request.kind === "clarify" && (
        <form aria-busy={busy || undefined} onSubmit={(event) => {
          event.preventDefault();
          if (busy || settled) return;
          setBusy(true);
          report("");
          void apiRequest("POST /bots/:id/requests/:approvalId", { params: { id: botId, approvalId: request.id }, body: { answers } })
            .then(() => setSettled(true))
            .catch((error) => report(error.message))
            .finally(() => setBusy(false));
        }}>
          {questions.map((question, index) => {
            const draft = drafts[question.id] ?? empty;
            const options = question.options ?? [];
            // Every question carries its index, so moving on can focus a free-text one too.
            if (!options.length) return <label className="question-field" key={question.id} data-question={index}>
              {question.prompt}
              <textarea rows={2} required disabled={settled} aria-label={question.prompt} placeholder="Your answer" maxLength={10000} value={draft.text}
                onChange={(event) => update(question, current => ({ ...current, text: event.target.value }))} />
            </label>;
            const kind = question.multiple ? "checkbox" : "radio";
            const name = `${request.id}:${question.id}`;
            return <fieldset className="question" key={question.id} disabled={settled} data-question={index} onKeyDown={keys(question, index)}
              onPointerDown={() => { pointer.current = true; }}>
              <legend>{question.prompt}{question.multiple && <span className="muted"> Choose any that apply.</span>}</legend>
              <div className="option-cards">
                {[...options, null].map((option, position) => {
                  const checked = option === null ? draft.own : draft.selected.includes(option);
                  return <label className={`option-card${checked ? " checked" : ""}`} key={position}>
                    <input type={kind} name={name} checked={checked} onChange={() => {
                      const moveOn = pointer.current;
                      pointer.current = false;
                      choose(question, index, option, moveOn);
                    }} />
                    <span className="option-mark" aria-hidden="true">{checked && <Icon name="check" size={14} />}</span>
                    <span className="option-label">{option ?? "Write my own answer"}</span>
                    {position < 9 && <kbd className="option-key" aria-hidden="true">{position + 1}</kbd>}
                  </label>;
                })}
              </div>
              {draft.own && <textarea rows={2} className="own-answer" required aria-label={`Your answer: ${question.prompt}`} placeholder="Your answer" maxLength={10000}
                value={draft.text} onChange={(event) => update(question, current => ({ ...current, text: event.target.value }))} />}
            </fieldset>;
          })}
          <p className="question-guidance" id={guidance} role="status">{settled ? "Answers sent." : questions.some(question => !answers[question.id]?.trim()) ? "Answer every question to send." : "Ready to send."}</p>
          <button type="submit" className="primary with-progress" aria-describedby={guidance} disabled={busy || settled || questions.some(question => !answers[question.id]?.trim())}>
            {busy && <Icon name="spinner" className="spin" size={16} />}
            {busy ? "Sending answers…" : settled ? "Answers sent" : "Send answers"}
          </button>
        </form>
      )}
      {request.kind === "official" && (
        <p className="muted">
          Open the official Hermes interface to handle this request. Return here
          when it is complete.
        </p>
      )}
    </article>
  );
}
