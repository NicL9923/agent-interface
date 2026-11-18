/**
 * Turns an async event handler into one that returns nothing, which is what React's event props declare. A rejection
 * is no longer swallowed by the event system: it reaches the window's unhandled-rejection handler as before, so a
 * handler that can fail should catch inside.
 */
export function fire<Args extends unknown[]>(
  handler: (...args: Args) => Promise<unknown>,
): (...args: Args) => void {
  return (...args) => {
    void handler(...args);
  };
}
