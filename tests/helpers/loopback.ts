import { createServer } from "node:net";

/**
 * A second loopback address, for tests that need two direct-route listeners. Linux routes all of 127.0.0.0/8
 * to its loopback adapter; macOS has only 127.0.0.1 until lo0 is given an alias. Without one, the server logs
 * that the route could not listen and leaves it out, which a test would report only as a missing route.
 */
export const SECOND_LOOPBACK = "127.0.0.2";

/** Fails with the fix when this machine cannot listen on SECOND_LOOPBACK. */
export async function requireSecondLoopback() {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, SECOND_LOOPBACK, resolve);
    });
  } catch (error) {
    throw new Error(`This machine cannot listen on ${SECOND_LOOPBACK} (${(error as NodeJS.ErrnoException).code}). ` +
      `On macOS give it to the loopback adapter: sudo ifconfig lo0 alias ${SECOND_LOOPBACK} up. README.md, "Validate", says how to keep it across restarts.`);
  } finally {
    if (server.listening) server.close();
  }
}
