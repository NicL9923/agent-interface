import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiBody } from "../shared/api.js";
import { routineRoomId } from "../shared/collaboration.js";
import type { CapabilityKey, Runtime } from "../shared/types.js";
import { apiRoute } from "./api-route.js";
import { signedIn } from "./auth.js";
import { routineById, visibleTo, type Roster } from "./bot-access.js";
import { assertDeliveryPrivate, routineRooms, routinesFor } from "./collaboration.js";
import { allowedIdentity, type Config } from "./config.js";
import { routineTargetsAfter } from "./delivery-targets.js";
import { assertRoutineEditable } from "./experience.js";
import { httpError } from "./http-error.js";
import { serialDelivery } from "./routine-delivery.js";
import { id } from "./schemas.js";
import type { Store } from "./store.js";

/** Listing, creating, changing and deleting routines. Running, pausing and trials live in experience.ts. */
export function installRoutineRoutes(app: FastifyInstance, collaborators: {
  config: Config;
  runtime: Runtime;
  store: Store;
  roster: Roster;
  requireCapability: (key: CapabilityKey) => Promise<void>;
}) {
  const { config, runtime, store, roster, requireCapability } = collaborators;
  apiRoute(app, "GET /routines", {}, async (req) => {
    await requireCapability("routines");
    const userId = signedIn(req).id;
    const all = await runtime.routines();
    store.adoptLegacyRecipients(all);
    return routinesFor(runtime, store, roster, userId, all.filter(r => visibleTo(store, r.botId, userId)).map((r) => ({
      ...r,
      recipientIds: store.getRoutineRecipients(r.botId, r.id),
    })));
  });
  const routineSchema = z
      .object({
        botId: id,
        name: z.string().min(1).max(100),
        prompt: z.string().max(50000),
        schedule: z.string().min(1).max(500),
        enabled: z.boolean(),
        recipientIds: z.array(id).max(20),
        roomIds: z.array(z.string().max(200).regex(routineRoomId)).max(10).optional(),
        skills: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
        model: z.string().trim().max(500).nullable().optional(),
        provider: z.string().trim().max(200).nullable().optional(),
        enabledToolsets: z.array(z.string().trim().min(1).max(200)).max(100).nullable().optional(),
        script: z.string().trim().max(2000).nullable().optional(),
        noAgent: z.boolean().optional(),
        contextFrom: z.array(z.string().trim().min(1).max(200)).max(100).nullable().optional(),
      });
  const saveRoutine = async (
    userId: string,
    input: ApiBody<"POST /routines">,
    routineId?: string,
  ) => {
    const all = routineId || input.contextFrom?.some(ref => ref !== 'self') ? await runtime.routines() : [];
    // Hermes lets two assistants hold jobs with one ID; this save is for the named assistant's.
    const previous = routineId ? all.find(row => row.id === routineId && row.botId === input.botId) : undefined;
    if (routineId && (!previous || previous.botId !== input.botId)) throw httpError(404, "Routine not found");
    // Compare against native state before forwarding updates. This also preserves
    // uneditable settings and avoids revalidating an untouched, missing script/source.
    for (const key of ['skills','model','provider','enabledToolsets','script','noAgent','contextFrom'] as const) {
      if (previous && input[key] !== undefined && JSON.stringify(input[key]) === JSON.stringify(previous[key])) delete input[key];
    }
    const effective = { ...previous, ...input };
    if (effective.noAgent && !effective.script?.trim()) throw httpError(400, "Script-only routines require a script from this assistant's scripts directory.");
    if (!effective.prompt.trim() && !effective.script?.trim() && !effective.skills?.length)
      throw httpError(400, "Add instructions, a skill, or a profile script for this routine to run.");
    // 41dfcf2c dashboard _cron_string_list converts [] to None. Do not turn a
    // deliberate zero-tool restriction into unrestricted access silently.
    if (Array.isArray(input.enabledToolsets) && input.enabledToolsets.length === 0)
      throw httpError(400, "Select at least one toolset or use profile tools. This Hermes dashboard cannot save an empty toolset allowlist.");
    if (input.contextFrom?.some(ref => ref !== 'self' && !all.some(row => row.id === ref && row.botId === input.botId)))
      throw httpError(400, "Context sources must be existing routines for this assistant.");
    if ((input.model !== undefined || input.provider !== undefined) && (effective.model || effective.provider)) {
      if (!runtime.modelOptions) throw httpError(409, "Model choices are unavailable. Keep the existing model or try again after reconnecting.");
      const catalog = await runtime.modelOptions(input.botId);
      const provider = catalog.providers.find(row => row.id === effective.provider || row.aliases?.includes(effective.provider ?? ''));
      if (!provider || !provider.authenticated || effective.model && !provider.models.some(row => row.id === effective.model && row.available))
        throw httpError(400, "Choose a model from an existing connected provider, or use the assistant's model.");
    }
    if (
      input.recipientIds.some((id) => {
        const user = store.getUser(id);
        return !user || !allowedIdentity(config, user);
      })
    )
      throw httpError(
        400,
        "Routine recipients must be signed-in household members",
      );
    // Nobody else would ever receive a private assistant's results, so do not pretend they will.
    const owner = store.presentation(input.botId);
    if (owner.shared === false && owner.ownerId && input.recipientIds.some(id => id !== owner.ownerId))
      throw httpError(400, "Only you can receive your personal assistant's routine results.", { code: "private_recipients" });
    // Checked last, so a refused routine never waits on Hermes's room catalog. Saves run one at a time
    // with sharing changes, which recheck routine rooms.
    const routine = await serialDelivery(store, async () => {
      // Read again in this turn: a save or sharing change ahead in the queue may have changed its rooms.
      const current = routineId ? (await runtime.routines()).find(row => row.id === routineId && row.botId === input.botId) : undefined;
      if (routineId && (!current || current.botId !== input.botId)) throw httpError(404, "Routine not found");
      if (input.roomIds !== undefined) {
        const rooms = await routineRooms(runtime, store, userId, input, current?.roomIds);
        if (rooms === undefined) delete input.roomIds; else input.roomIds = rooms;
      }
      // An enabled routine delivers, so every room it will post in is checked, including any its owner
      // cannot see and any written outside the app, even when this save changes none of them.
      if (input.enabled) {
        await assertDeliveryPrivate(runtime, store, input.botId, routineTargetsAfter(current, input.botId, input.roomIds));
      }
      return runtime.saveRoutine(input, routineId);
    });
    if (routineId) store.adoptLegacyRecipients(all);
    store.routineRecipients(input.botId, routine.id, input.recipientIds);
    const [saved] = await routinesFor(runtime, store, roster, userId, [{ ...effective, ...routine, recipientIds: input.recipientIds }]);
    return saved;
  };
  apiRoute(app, "POST /routines", { body: routineSchema, before: async () => requireCapability("routines") }, async (req, input) => saveRoutine(signedIn(req).id, input));
  // A save names its assistant, so a trial of another assistant's routine with the same ID never blocks it.
  apiRoute(app, "PUT /routines/:id", { body: routineSchema, before: async req => { await requireCapability("routines"); await assertRoutineEditable(runtime, store, req.params.id, (req.body as { botId?: unknown } | undefined)?.botId); } }, async (req, input) => saveRoutine(signedIn(req).id, input, req.params.id));
  apiRoute(app, "DELETE /routines/:id", {}, async (req) => {
    await requireCapability("routines");
    // Hermes lets two assistants hold jobs with one ID, so the ID means the copy this person can see,
    // and Hermes is told its assistant. Without that, Hermes picks the copy itself, which may be hidden.
    const routine = routineById(await runtime.routines(), req.params.id, store, signedIn(req).id);
    if (!routine) throw httpError(404, "Routine not found");
    await assertRoutineEditable(runtime, store, routine.id, routine.botId);
    // Hermes treats the profile as a hint and deletes another assistant's copy when this one is gone
    // (hermes_cli/web_routers/cron.py _job_owner_profile), and nothing in it deletes strictly by profile
    // without changing the add-on. So deletions run one at a time with the other routine changes, and
    // each reads the routines again just before, deleting nothing unless this assistant's copy is still there.
    await serialDelivery(store, async () => {
      const all = await runtime.routines();
      if (!all.some(other => other.id === routine.id && other.botId === routine.botId)) throw httpError(404, "Routine not found");
      store.adoptLegacyRecipients(all);
      await runtime.deleteRoutine(routine.id, routine.botId);
      store.routineRecipients(routine.botId, routine.id, []);
    });
    return { ok: true };
  });
}
