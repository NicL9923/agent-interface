import { useSyncExternalStore } from "react";
import { formatFull, formatWhen } from "../time";
import type { Instant, WhenOptions } from "../time";
// One timer for every visible timestamp, aligned to the minute and stopped when none are mounted.
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
const minute = () => Math.floor(Date.now() / 60_000);
function tick() {
  timer = setTimeout(() => {
    tick();
    listeners.forEach(listener => listener());
  }, 60_000 - Date.now() % 60_000);
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) tick();
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    clearTimeout(timer);
    timer = undefined;
  };
}
export const useMinute = () => useSyncExternalStore(subscribe, minute);
export function When({ value, className, ...options }: { value: Instant; className?: string } & Pick<WhenOptions, "inline" | "relative" | "from">) {
  useMinute();
  const label = formatWhen(value, options);
  if (!label) return null;
  return <time className={className} dateTime={typeof value === "string" ? value : new Date(value).toISOString()} title={formatFull(value)}>{label}</time>;
}
