import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { Runtime, User } from "../shared/types.js";
import type { UpgradeControlAction, UpgradeControlRequest, UpgradeInstallRequest, UpgradeStatus } from "../shared/upgrades.js";
import type { Config } from "./config.js";

const phases = ["idle", "checking", "qualifying", "ready", "installing", "verifying", "succeeded", "blocked", "failed", "rolled_back", "recovering", "cancelled"] as const;
const revision = z.object({ revision: z.string().regex(/^[a-f0-9]{40}$/), version: z.string().optional(), notesUrl: z.string().url().optional() });
const stateSchema = z.object({
  phase: z.enum(phases), message: z.string(), current: revision.optional(), candidate: revision.optional(),
  checks: z.array(z.object({ id: z.string(), label: z.string(), status: z.enum(["pending", "running", "passed", "failed"]), detail: z.string().optional() })),
  operationId: z.string().optional(), error: z.string().nullable().transform(value => value ?? undefined).optional(), checkedAt: z.string().optional(), updatedAt: z.string().optional(),
  workerPid: z.number().int().positive().optional(), maintenance: z.boolean().optional(), requestId: z.string().optional(),
}).passthrough();
type WorkerState = z.infer<typeof stateSchema>;
interface InstallReceipt { candidateRevision: string; operationId: string; status: "pending" | "complete"; result?: WorkerState }
const active = new Set(["checking", "qualifying", "installing", "verifying", "recovering"]);
const issue = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const writePrivate = (file: string, value: unknown) => {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try { writeFileSync(descriptor, JSON.stringify(value) + "\n"); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  renameSync(temporary, file);
  const directory = openSync(dirname(file), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
};

/** Installer-owned local worker. Browser requests can name only an already qualified SHA. */
export class HermesUpgrades {
  private readonly stateFile?: string;
  private readonly requestsDirectory?: string;
  private readonly controlsDirectory?: string;
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private config: Config, private runtime: Runtime,
    private launch: (args: { action: "check" | "install" | UpgradeControlAction; operationId: string }) => void = args => {
      const settings = this.config.hermesUpgrade!;
      const child = spawn(settings.python, [resolve("scripts/hermes-upgrade-worker.py"), "--config", settings.workerConfig,
        "--state-dir", settings.stateDirectory, "--action", args.action, "--operation-id", args.operationId],
      { detached: true, stdio: "ignore", env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8" } });
      child.on("error", () => {
        const state = this.read();
        if (state.operationId === args.operationId) this.save({ ...state, phase: "failed", message: "The upgrade worker could not start. Ask the installer to check its configuration.", error: "worker_start_failed" });
      });
      child.unref();
    }) {
    const settings = config.hermesUpgrade;
    if (!settings) return;
    const privatePath = (path: string, directory = false) => {
      if (directory) mkdirSync(path, { recursive: true, mode: 0o700 });
      const info = lstatSync(path);
      if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()) || (directory ? !info.isDirectory() : !info.isFile()))
        throw new Error("Hermes upgrade configuration and state must be owned by the app user and inaccessible to other users");
    };
    privatePath(settings.workerConfig);
    privatePath(settings.stateDirectory, true);
    this.requestsDirectory = join(settings.stateDirectory, "requests");
    privatePath(this.requestsDirectory, true);
    this.controlsDirectory = join(settings.stateDirectory, "controls");
    privatePath(this.controlsDirectory, true);
    this.stateFile = join(settings.stateDirectory, "status.json");
    if (!existsSync(this.stateFile)) this.save({ phase: "idle", checks: [], message: "Check for a Hermes update when you're ready." });
    // Recover a crash between durable admission and the status write. No worker
    // can have started until the admitted status was saved.
    const state = this.read();
    for (const file of readdirSync(this.requestsDirectory).filter(file => file.endsWith(".json"))) {
      try {
        const receipt = JSON.parse(readFileSync(join(this.requestsDirectory, file), "utf8"));
        if (receipt.status === "pending" && receipt.predecessorOperationId === state.operationId && state.phase === "ready" && receipt.admittedState?.operationId === receipt.operationId)
          this.save(stateSchema.parse(receipt.admittedState));
      } catch { /* Damaged admissions keep the maintenance gate closed. */ }
    }
  }
  private save(state: WorkerState) { if (this.stateFile) writePrivate(this.stateFile, { ...state, updatedAt: new Date().toISOString() }); }
  private read(): WorkerState {
    if (!this.stateFile) return { phase: "blocked", checks: [], message: "Hermes upgrades have not been enabled by this installation's administrator." };
    try { return stateSchema.parse(JSON.parse(readFileSync(this.stateFile, "utf8"))); }
    catch { return { phase: "blocked", checks: [], maintenance: true, message: "The upgrade record needs installer review before Hermes can accept changes.", error: "invalid_upgrade_record" }; }
  }
  private async workerHeld() {
    if (!this.config.hermesUpgrade) return false;
    const settings = this.config.hermesUpgrade;
    return new Promise<boolean>(resolveHeld => {
      const probe = spawn(settings.python, ["-c", "import fcntl,os,sys\nf=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT,0o600)\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(1)", join(settings.stateDirectory, "worker.lock")], { stdio: "ignore", timeout: 2000 });
      probe.on("error", () => resolveHeld(true));
      probe.on("exit", code => resolveHeld(code !== 0));
    });
  }
  private recoveryEligibility(state: WorkerState): { restore: boolean; restart: boolean; reason?: string } {
    const none = { restore: false, restart: false };
    try {
      const settings = JSON.parse(readFileSync(this.config.hermesUpgrade!.workerConfig, "utf8"));
      const finish = settings.hooks?.finish;
      const hooks = Boolean(settings.hooks?.recover && settings.hooks?.restart_service || Array.isArray(finish) && finish.at(-1) === "finish" && finish.some((arg: string) => arg.endsWith("/hermes-upgrade-linux.py")));
      const qualification = state.qualification as { stage?: string; currentRevision?: string; currentPatchSha256?: string; candidateRevision?: string; candidatePatchSha256?: string; integrationDigest?: string } | undefined;
      if (!hooks || !qualification?.stage || resolve(dirname(qualification.stage)) !== resolve(settings.stageRoot)) return none;
      const stage = qualification.stage;
      const journalPath = join(stage, "recovery.json"), platformPath = join(stage, "platform.json");
      const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, "utf8")) : undefined;
      if (journal && journal.operationId !== state.operationId) return none;
      if (journal?.releaseStarted) return { ...none, reason: "Admission release may have started. The installer must review Hermes before any restart or rollback." };
      if (journal && !journal.hostHookStarted) return { restore: true, restart: false };
      // An admitted worker which has not started a hook can be cancelled safely.
      if (!journal && !existsSync(platformPath) && state.phase === "installing" && !state.checks.some(check => ["quiescence", "backup", "install"].includes(check.id))) return { restore: true, restart: false };
      if (!existsSync(platformPath)) return none;
      const platform = JSON.parse(readFileSync(platformPath, "utf8"));
      if (Array.isArray(finish) && finish.includes("--config")) {
        const platformConfig = JSON.parse(readFileSync(finish[finish.indexOf("--config") + 1], "utf8"));
        const gate = JSON.parse(readFileSync(platformConfig.maintenanceFile, "utf8"));
        if (gate.operationId !== state.operationId) return { ...none, reason: "The saved maintenance gate has lost ownership. The installer must review recovery." };
      }
      if (platform.operationId !== state.operationId || ["releasing", "finished", "rejected"].includes(platform.phase)) return { ...none, reason: "Native admission ownership or release needs installer review before recovery." };
      const previous = journal?.previousReceipt ? JSON.parse(Buffer.from(journal.previousReceipt, "base64").toString("utf8")) : undefined;
      const deployed = existsSync(settings.qualificationReceipt) ? JSON.parse(readFileSync(settings.qualificationReceipt, "utf8")) : undefined;
      const attested = (receipt: typeof deployed) => receipt?.schemaVersion === 1 && receipt?.checks?.realIntegration === true && receipt?.checks?.hostRegressions === true && typeof receipt?.qualifiedAt === "string" && receipt?.integrationDigest === qualification.integrationDigest;
      const attestsBaseline = (receipt: typeof deployed) => attested(receipt) && receipt?.revision === qualification.currentRevision && receipt?.trackedPatchSha256 === qualification.currentPatchSha256 && receipt?.integrationDigest === qualification.integrationDigest;
      return { restore: attestsBaseline(previous) || attestsBaseline(deployed), restart: attested(deployed) && (attestsBaseline(deployed) || deployed.revision === qualification.candidateRevision && deployed.trackedPatchSha256 === qualification.candidatePatchSha256),
        reason: !attestsBaseline(previous) && !attestsBaseline(deployed) ? "The original qualification receipt is unavailable. Restore cannot be offered; service recovery must verify the recorded installed source." : undefined };
    } catch { return none; }
  }
  private controlIntent(operationId?: string): { action: UpgradeControlAction; requestId: string; status: string; startedAt?: string } | undefined {
    if (!this.controlsDirectory || !operationId) return;
    try {
      const file = join(this.controlsDirectory, `${operationId}.json`);
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
    } catch { return { action: "cancel", requestId: "invalid", status: "pending" }; }
  }
  private pendingInstall() {
    if (!this.requestsDirectory) return false;
    try {
      const state = this.read();
      return readdirSync(this.requestsDirectory).filter(file => file.endsWith(".json")).some(file => {
        const receipt = JSON.parse(readFileSync(join(this.requestsDirectory!, file), "utf8"));
        if (receipt.status === "complete") return false;
        // The worker writes its verified outcome before completing this receipt.
        // A crash between those writes must not leave a completed update paused.
        if (receipt.operationId === state.operationId && file === `${state.requestId}.json` && state.maintenance === false && ["succeeded", "rolled_back", "blocked", "cancelled"].includes(state.phase)) {
          writePrivate(join(this.requestsDirectory!, file), { ...receipt, status: "complete", result: state });
          return false;
        }
        return true;
      });
    }
    catch { return true; }
  }
  maintenance() { return Boolean(this.config.hermesUpgrade && (this.read().maintenance || this.pendingInstall())); }
  private administrator(user: User) { return Boolean(this.config.hermesUpgrade?.adminEmails.includes(user.email.toLowerCase())); }
  private async busyBots() {
    try {
      const status = await this.runtime.status();
      if (!status.connected) return ["Hermes connection unavailable"];
      return (await this.runtime.listBots()).filter(bot => ["thinking", "working", "waiting", "blocked"].includes(bot.activity)).map(bot => bot.name);
    } catch { return ["Hermes activity unavailable"]; }
  }
  async status(user: User): Promise<UpgradeStatus> {
    const state = this.read();
    const available = Boolean(this.config.hermesUpgrade), administrator = this.administrator(user);
    const busyBots = available && !this.maintenance() ? await this.busyBots() : [];
    const starting = Boolean(state.updatedAt && Date.now() - Date.parse(state.updatedAt) < 15000);
    const held = available && await this.workerHeld();
    const abandoned = active.has(state.phase) && !held && !starting;
    const intent = this.controlIntent(state.operationId);
    const controlling = intent?.status === "pending" && (held || Boolean(intent.startedAt && Date.now() - Date.parse(intent.startedAt) < 15000));
    const recovery = this.recoveryEligibility(state);
    const controllable = available && administrator && !!state.operationId && !controlling;
    const maintenance = this.maintenance();
    return { available, phase: abandoned ? "blocked" : state.phase, current: state.current, candidate: state.candidate,
      message: controlling && state.phase !== "recovering" ? "Your recovery request is saved. Waiting for the current command to reach a safe boundary." : maintenance && recovery.reason ? recovery.reason : abandoned ? "The update stopped before it finished. Choose a recovery action to continue safely."
        : available && !administrator ? "This installation's administrator manages Hermes updates." : state.message,
      checks: state.checks, operationId: state.operationId,
      // Only an install admission records a request ID; checks and retries never do.
      operation: state.operationId ? ["installing", "verifying", "recovering", "rolled_back"].includes(state.phase) || state.requestId ? "install" : "check" : undefined,
      controlRequestId: controlling ? intent.requestId : undefined, controlAction: controlling ? intent.action : undefined, error: abandoned ? "worker_interrupted" : state.error,
      checkedAt: state.checkedAt, updatedAt: state.updatedAt, busyBots,
      canCheck: available && administrator && !maintenance && !held && !controlling && (!active.has(state.phase) || abandoned),
      canRetry: controllable && !starting && !held && (!active.has(state.phase) || abandoned) && ["blocked", "failed", "rolled_back", "cancelled"].includes(abandoned ? "blocked" : state.phase) && (!maintenance || recovery.restore),
      canCancel: controllable && (!starting || held) && (active.has(state.phase) || maintenance || state.phase === "ready") && (!maintenance || recovery.restore),
      canRestartService: controllable && !starting && maintenance && recovery.restart && !held,
      canInstall: available && administrator && !maintenance && !busyBots.length && state.phase === "ready" && !!state.candidate && !held && !controlling };
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work, work);
    this.serial = result.catch(() => {});
    return result;
  }
  private authorized(user: User) {
    if (!this.config.hermesUpgrade) throw issue("Hermes upgrades are not enabled on this installation");
    if (!this.administrator(user)) throw issue("Only the installation's designated administrator can manage Hermes upgrades", 403);
  }
  control(user: User, input: UpgradeControlRequest) { return this.exclusive(async () => {
    this.authorized(user);
    input = z.object({ action: z.enum(["retry", "cancel", "restart_service"]), operationId: z.string().uuid(), requestId: z.string().uuid() }).strict().parse(input);
    const receiptFile = join(this.controlsDirectory!, `request-${input.requestId}.json`);
    if (existsSync(receiptFile)) {
      const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
      if (receipt.action !== input.action || receipt.operationId !== input.operationId) throw issue("This recovery request ID already belongs to another action");
      const intent = this.controlIntent(input.operationId);
      const lostLaunch = !intent || intent.requestId === input.requestId && intent.status === "pending" && (!intent.startedAt || Date.now() - Date.parse(intent.startedAt) >= 15000);
      if (receipt.status === "pending" && lostLaunch && this.read().operationId === input.operationId && !await this.workerHeld()) {
        writePrivate(join(this.controlsDirectory!, `${input.operationId}.json`), { ...receipt, startedAt: new Date().toISOString() });
        this.launch({ action: input.action, operationId: input.operationId });
      }
      return this.status(user);
    }
    const status = await this.status(user);
    if (status.operationId !== input.operationId) throw issue("This update changed. Refresh before choosing a recovery action");
    const allowed = input.action === "cancel" ? status.canCancel : input.action === "retry" ? status.canRetry : status.canRestartService;
    if (!allowed) throw issue("This recovery action is unavailable while another operation runs or the update requires installer review");
    const intent = { ...input, status: "pending", startedAt: new Date().toISOString() };
    writePrivate(receiptFile, intent);
    writePrivate(join(this.controlsDirectory!, `${input.operationId}.json`), intent);
    // A running worker consumes cancellation at its next safe command boundary.
    if (!await this.workerHeld()) this.launch({ action: input.action, operationId: input.operationId });
    return this.status(user);
  }); }
  check(user: User) { return this.exclusive(async () => {
    this.authorized(user);
    if (!(await this.status(user)).canCheck) throw issue("An upgrade is already running or requires installer review");
    const operationId = randomUUID();
    this.save({ phase: "checking", checks: [], operationId, message: "Looking for a Hermes update." });
    this.launch({ action: "check", operationId });
    return this.status(user);
  }); }
  install(user: User, input: UpgradeInstallRequest) { return this.exclusive(async () => {
    input = z.object({ candidateRevision: z.string().regex(/^[a-f0-9]{40}$/), requestId: z.string().uuid() }).strict().parse(input);
    this.authorized(user);
    const requestFile = join(this.requestsDirectory!, `${input.requestId}.json`);
    if (existsSync(requestFile)) {
      const receipt = JSON.parse(readFileSync(requestFile, "utf8")) as InstallReceipt;
      if (receipt.candidateRevision !== input.candidateRevision) throw issue("This upgrade request ID was already used for a different revision");
      const current = await this.status(user);
      if (current.operationId === receipt.operationId || !receipt.result) return current;
      const result = receipt.result;
      return { ...current, phase: result.phase, current: result.current, candidate: result.candidate,
        message: result.message, checks: result.checks, operationId: result.operationId,
        error: result.error, checkedAt: result.checkedAt, updatedAt: result.updatedAt, canCheck: false, canInstall: false, canRetry: false, canCancel: false, canRestartService: false };
    }
    const status = await this.status(user);
    if (!status.canInstall || status.candidate?.revision !== input.candidateRevision)
      throw issue(status.busyBots.length ? "Wait for active Hermes work to finish before upgrading" : "Check and qualify this exact Hermes update before installing it");
    const operationId = randomUUID();
    // The pending receipt is also the durable maintenance gate. Persist it before launching.
    const predecessor = this.read();
    const admittedState = { ...predecessor, phase: "installing" as const, requestId: input.requestId, maintenance: true,
      operationId, workerPid: undefined, message: "Installing the qualified Hermes update. Your conversations are saved." };
    writePrivate(requestFile, { candidateRevision: input.candidateRevision, operationId, predecessorOperationId: predecessor.operationId, admittedState, status: "pending" });
    this.save(admittedState);
    this.launch({ action: "install", operationId });
    return this.status(user);
  }); }
}
