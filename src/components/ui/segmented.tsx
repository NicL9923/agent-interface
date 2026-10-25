import { useId, useRef } from "react";
import "./segmented.css";

export type SegmentOption<T extends string> = { value: T; label: string; /** Spoken and shown on hover when the label is abbreviated. */ name?: string };

/**
 * A compact single choice, like a native segmented control. It is a radio group: Tab reaches the
 * chosen segment, arrows move and choose, Home and End jump. While `busy`, it keeps focus but
 * ignores changes, so a save in progress cannot be stacked or knock focus out of the group.
 */
export function Segmented<T extends string>({ label, value, options, busy = false, onChange }: {
  label: string;
  value: T;
  options: readonly SegmentOption<T>[];
  busy?: boolean;
  onChange(value: T): void;
}) {
  const labelId = useId();
  const group = useRef<HTMLDivElement>(null);
  const index = options.findIndex(option => option.value === value);
  const choose = (next: number) => {
    const option = options[next];
    if (!option || busy) return;
    group.current?.querySelectorAll<HTMLButtonElement>("[role='radio']")[next]?.focus();
    if (option.value !== value) onChange(option.value);
  };
  return <div className="segmented-field">
    <span className="segmented-label" id={labelId}>{label}</span>
    <div ref={group} className="segmented" role="radiogroup" aria-labelledby={labelId} aria-busy={busy || undefined}
      onKeyDown={event => {
        const last = options.length - 1, from = Math.max(index, 0);
        const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? (from + 1) % options.length
          : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (from - 1 + options.length) % options.length
          : event.key === "Home" ? 0 : event.key === "End" ? last : -1;
        if (next < 0) return;
        event.preventDefault();
        choose(next);
      }}>
      {options.map((option, position) => <button key={option.value} type="button" role="radio"
        aria-checked={option.value === value} aria-label={option.name} title={option.name}
        aria-disabled={busy || undefined} tabIndex={position === (index < 0 ? 0 : index) ? 0 : -1}
        onClick={() => choose(position)}>{option.label}</button>)}
    </div>
  </div>;
}
