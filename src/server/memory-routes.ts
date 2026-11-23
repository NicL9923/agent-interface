import type { FastifyInstance, FastifyRequest } from "fastify";
import { NotFound } from "../shared/errors.js";
import {
  learningSettingsBody,
  type WireLearningSettings,
  type WireMemoryEntry,
  type WireRevision,
  type WireSkill,
} from "../shared/memory.js";
import { apiRoute } from "./api-route.js";
import { notFound, visible, type Roster } from "./bot-access.js";
import { httpError } from "./http-error.js";
import type { LearningSettings, MemorySkillsRepository, Revision } from "./store-memory.js";
import type { Store } from "./store.js";

const iso = (ms: number) => new Date(ms).toISOString();
const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));
export const wireRevision = ({ botId: _, ...revision }: Revision): WireRevision => ({
  ...revision,
  createdAt: iso(revision.createdAt),
  decidedAt: isoOrNull(revision.decidedAt),
});
const wireSettings = ({ botId: _, ...settings }: LearningSettings): WireLearningSettings => ({
  ...settings,
  lastPrunedAt: isoOrNull(settings.lastPrunedAt),
});
const wireItem = <T extends { botId: string; createdAt: number; updatedAt: number }>({
  botId: _,
  ...item
}: T) => ({ ...item, createdAt: iso(item.createdAt), updatedAt: iso(item.updatedAt) });

/**
 * The review screens for each bot's memory and skills: what it knows, what is waiting for approval, its full
 * history, the auto-apply setting, and approve, reject and undo. Only someone who sees the bot reaches any of it,
 * and a revision of another bot is missing here, exactly as a made-up ID is.
 */
export function installMemoryRoutes(
  app: FastifyInstance,
  {
    store,
    memory,
    roster,
  }: {
    store: Pick<Store, "presentation">;
    memory: MemorySkillsRepository;
    roster: Pick<Roster, "exists">;
  },
) {
  const member = (req: FastifyRequest<{ Params: { id: string } }>) => {
    const user = req.user;
    if (!user) throw httpError(401, "Sign in required", { code: "session_expired" });
    if (!visible(store.presentation(req.params.id), user.id))
      throw new NotFound(notFound.error, notFound.code);
    return user;
  };
  const before = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    member(req);
    if (!(await roster.exists(req.params.id))) throw new NotFound(notFound.error, notFound.code);
  };
  const actor = (req: FastifyRequest<{ Params: { id: string } }>) => `user:${member(req).id}`;

  apiRoute(app, "GET /bots/:id/learning", { before }, async (req) => {
    member(req);
    const botId = req.params.id;
    return {
      settings: wireSettings(memory.settings(botId)),
      entries: memory.listEntries(botId).map((entry) => wireItem(entry) satisfies WireMemoryEntry),
      skills: memory.listSkills(botId).map((skill) => wireItem(skill) satisfies WireSkill),
      pending: memory.listPending(botId).map(wireRevision),
    };
  });

  apiRoute(app, "GET /bots/:id/learning/revisions", { before }, async (req) => {
    member(req);
    return { revisions: memory.listRevisions(req.params.id).map(wireRevision) };
  });

  apiRoute(
    app,
    "PUT /bots/:id/learning/settings",
    { before, body: learningSettingsBody },
    async (req, { autoApply }) => {
      member(req);
      return wireSettings(memory.updateSettings(req.params.id, { autoApply }));
    },
  );

  apiRoute(
    app,
    "POST /bots/:id/learning/proposals/:revisionId/approve",
    { before },
    async (req) => ({
      revision: wireRevision(memory.approve(req.params.id, req.params.revisionId, actor(req))),
    }),
  );

  apiRoute(
    app,
    "POST /bots/:id/learning/proposals/:revisionId/reject",
    { before },
    async (req) => ({
      revision: wireRevision(
        memory.rejectProposal(req.params.id, req.params.revisionId, actor(req)),
      ),
    }),
  );

  apiRoute(app, "POST /bots/:id/learning/revisions/:revisionId/undo", { before }, async (req) => ({
    revision: wireRevision(memory.undo(req.params.id, req.params.revisionId, actor(req))),
  }));
}
