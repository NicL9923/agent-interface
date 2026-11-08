import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Runtime } from "../shared/types.js";
import type { TerminalRequestResult } from "../shared/computer.js";
import { signedIn } from "./auth.js";
import type { Config } from "./config.js";
import type { Store } from "./store.js";
import { visibleTo } from "./bot-access.js";
import { httpError } from "./http-error.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const params = z.object({ id, requestId: id }).strict();
const body = z.object({ decision: z.enum(["done", "decline"]), epoch: id, sessionId: id }).strict();

/**
 * Done or Not now on an assistant's terminal request. Opening the terminal itself goes through
 * the ordinary terminal routes, so it keeps their administrator and fresh sign-in rules. Done is
 * a claim that the person used the terminal, so only a terminal administrator may make it. Not
 * now is open to anyone who can see the chat, because a member who cannot use the terminal must
 * still be able to turn the assistant away.
 */
export async function installTerminalRequestRoutes(app: FastifyInstance, config: Config, store: Store, runtime: Runtime) {
  app.post("/api/bots/:id/terminal-requests/:requestId", async (req): Promise<TerminalRequestResult> => {
    const path = params.parse(req.params), input = body.parse(req.body), user = signedIn(req);
    if (!visibleTo(store, path.id, user.id)) throw httpError(404, "Assistant not found");
    if (!runtime.computerRequest) throw httpError(409, "The Hermes terminal request integration is unavailable.");
    if (input.decision === "done" && !(config.computerTerminalAdmins ?? []).includes(user.email.toLowerCase()))
      throw httpError(403, "Only a terminal administrator can open the terminal.");
    const result = await runtime.computerRequest({ action: "terminal_request", decision: input.decision, profile: path.id, requestId: path.requestId,
      epoch: input.epoch, sessionId: input.sessionId, actorId: user.id, actorName: user.name }) as unknown as Partial<TerminalRequestResult>;
    if (result?.status !== "ok" && result?.status !== "expired") throw httpError(502, "Hermes returned an invalid answer for this terminal request");
    return { status: result.status };
  });
}
