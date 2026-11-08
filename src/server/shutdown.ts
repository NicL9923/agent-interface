import type { Socket } from "node:net";
import type { FastifyInstance } from "fastify";

export const SHUTDOWN_GRACE_MS = 25000;
// Leave cleanup time after forcing connections closed, before the process watchdog exits.
export const SHUTDOWN_EXIT_MS = SHUTDOWN_GRACE_MS + 5000;

/** Stop reusing finished responses, then force any remaining connections after the grace period. */
export function installShutdown(app: FastifyInstance) {
  const sockets = new Set<Socket>();
  let draining = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  app.server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const clearDeadline = () => { clearTimeout(deadline); deadline = undefined; };
  app.server.once("close", clearDeadline);
  app.addHook("onClose", async () => clearDeadline());
  app.addHook("preClose", async () => {
    draining = true;
    deadline = setTimeout(() => {
      app.log.warn({ connections: sockets.size }, "Closing connections after the shutdown grace period");
      // Node's closeAllConnections skips upgraded sockets. Raw connections cover those too,
      // along with peers that never sent a request and responses that could not finish.
      for (const socket of sockets) socket.destroy();
    }, SHUTDOWN_GRACE_MS);
    deadline.unref();
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    if (draining) reply.header("Connection", "close");
    return payload;
  });
  app.addHook("onResponse", async () => {
    // A streamed response may have sent its headers before shutdown began.
    if (draining) app.server.closeIdleConnections();
  });
}
