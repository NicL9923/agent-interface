import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { Runtime, User } from "../shared/types.js";
import type { UpgradeInstallRequest, UpgradeStatus } from "../shared/upgrades.js";
import type { Config } from "./config.js";

const phases = ["idle", "checking", "qualifying", "ready", "installing", "verifying", "succeeded", "blocked", "failed", "rolled_back"] as const;
const revision = z.object({ revision: z.string().regex(/^[a-f0-9]{40}$/), version: z.string().optional(), notesUrl: z.string().url().optional() });
const stateSchema = z.object({
  phase: z.enum(phases), message: z.string(), current: revision.optional(), candidate: revision.optional(),
  checks: z.array(z.object({ id: z.string(), label: z.string(), status: z.enum(["pending", "running", "passed", "failed"]), detail: z.string().optional() })),
  operationId: z.string().optional(), error: z.string().optional(), checkedAt: z.string().optional(), updatedAt: z.string().optional(),
  workerPid: z.number().int().positive().optional(), maintenance: z.boolean().optional(), requestId: z.string().optional(),
}).passthrough();
type WorkerState = z.infer<typeof stateSchema>;
interface InstallReceipt { candidateRevision: string; operationId: string; status: "pending" | "complete"; result?: WorkerState }
const active = new Set(["checking", "qualifying", "installing", "verifying"]);
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
const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

/** Installer-owned local worker. Browser requests can name only an already qualified SHA. */
export class HermesUpgrades {
  private readonly stateFile?: string;
  private readonly requestsDirectory?: string;
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private config: Config, private runtime: Runtime,
    private launch: (args: { action: "check" | "install"; operationId: string }) => void = args => {
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
    this.stateFile = join(settings.stateDirectory, "status.json");
    if (!existsSync(this.stateFile)) this.save({ phase: "idle", checks: [], message: "Check for a Hermes update when you're ready." });
  }
  private save(state: WorkerState) { if (this.stateFile) writePrivate(this.stateFile, { ...state, updatedAt: new Date().toISOString() }); }
  private read(): WorkerState {
    if (!this.stateFile) return { phase: "blocked", checks: [], message: "Hermes upgrades have not been enabled by this installation's administrator." };
    try { return stateSchema.parse(JSON.parse(readFileSync(this.stateFile, "utf8"))); }
    catch { return { phase: "blocked", checks: [], maintenance: true, message: "The upgrade record needs installer review before Hermes can accept changes.", error: "invalid_upgrade_record" }; }
  }
  private pendingInstall() {
    if (!this.requestsDirectory) return false;
    try { return readdirSync(this.requestsDirectory).filter(file => file.endsWith(".json")).some(file => JSON.parse(readFileSync(join(this.requestsDirectory!, file), "utf8")).status !== "complete"); }
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
    const abandoned = active.has(state.phase) && !alive(state.workerPid) && !starting;
    const maintenance = this.maintenance();
    return { available, phase: abandoned ? "blocked" : state.phase, current: state.current, candidate: state.candidate,
      message: abandoned ? "The update stopped before it finished. Ask the installer to review its durable record; it will not run again automatically."
        : available && !administrator ? "This installation's administrator manages Hermes updates." : state.message,
      checks: state.checks, operationId: state.operationId, error: abandoned ? "worker_interrupted" : state.error,
      checkedAt: state.checkedAt, updatedAt: state.updatedAt, busyBots,
      canCheck: available && administrator && !maintenance && (!active.has(state.phase) || abandoned),
      canInstall: available && administrator && !maintenance && !busyBots.length && state.phase === "ready" && !!state.candidate };
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
        error: result.error, checkedAt: result.checkedAt, updatedAt: result.updatedAt, canInstall: false };
    }
    const status = await this.status(user);
    if (!status.canInstall || status.candidate?.revision !== input.candidateRevision)
      throw issue(status.busyBots.length ? "Wait for active Hermes work to finish before upgrading" : "Check and qualify this exact Hermes update before installing it");
    const operationId = randomUUID();
    // The pending receipt is also the durable maintenance gate. Persist it before launching.
    writePrivate(requestFile, { candidateRevision: input.candidateRevision, operationId, status: "pending" });
    this.save({ ...this.read(), phase: "installing", requestId: input.requestId, maintenance: true,
      operationId, workerPid: undefined, message: "Installing the qualified Hermes update. Your conversations are saved." });
    this.launch({ action: "install", operationId });
    return this.status(user);
  }); }
}
