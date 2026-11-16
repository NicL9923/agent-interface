/** The browser lock boundary shared by independently loaded tabs in jsdom. */
export function browserLocks() {
  const waiting = new Map<string, Promise<unknown>>();
  return { request<T>(name: string, work: () => Promise<T> | T): Promise<T> {
    if (name !== "agent-interface:auth-operation" && name !== "agent-interface:auth-epoch") throw new Error(`Unconfigured browser lock: ${name}`);
    const next = (waiting.get(name) ?? Promise.resolve()).catch(() => {}).then(work);
    waiting.set(name, next);
    return next;
  } };
}
