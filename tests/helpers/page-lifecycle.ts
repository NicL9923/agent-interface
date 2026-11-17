/** Standalone entries keep browser listeners for a page lifetime. End that lifetime
 * after a test file when the jsdom worker is reused by another page fixture. */
export function trackPageLifetime(bridgeKeys: string[]): () => void {
  const addDescriptor = Object.getOwnPropertyDescriptor(window, "addEventListener");
  const add = window.addEventListener;
  const listeners: Parameters<Window["addEventListener"]>[] = [];
  const bridges = bridgeKeys.map((name) => Object.getOwnPropertyDescriptor(window, name));
  const socket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(window, "addEventListener", {
    configurable: true,
    writable: true,
    value: (...args: Parameters<Window["addEventListener"]>) => {
      listeners.push(args);
      add.apply(window, args);
    },
  });
  return () => {
    for (const [type, listener, options] of listeners)
      window.removeEventListener(type, listener, options);
    if (addDescriptor) Object.defineProperty(window, "addEventListener", addDescriptor);
    else Reflect.deleteProperty(window, "addEventListener");
    bridgeKeys.forEach((name, index) => {
      if (bridges[index]) Object.defineProperty(window, name, bridges[index]!);
      else Reflect.deleteProperty(window, name);
    });
    if (socket) Object.defineProperty(globalThis, "WebSocket", socket);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  };
}
