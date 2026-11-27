import {
  execFile,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import { httpError } from "./http-error.js";

const execFileAsync = promisify(execFile);
const host = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts") ? "./terminal-host.ts" : "./terminal-host.js",
    import.meta.url,
  ),
);
// Cache tmux liveness briefly so rapid status polls do not spawn a subprocess on every request.
const AVAILABILITY_TTL_MS = 2_000;

export class SystemTerminal {
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  readonly target: string;
  private readonly dependencies: boolean;
  private cachedAvailability?: { value: boolean; expiresAt: number };
  private availabilityCheck?: Promise<boolean>;

  private async probeAvailable(): Promise<boolean> {
    if (!this.dependencies || !this.config) return false;
    try {
      await execFileAsync(
        "tmux",
        ["-N", "-S", join(this.config.stateDirectory, "tmux.sock"), "show-options", "-s"],
        { timeout: 2000 },
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Checks whether the tmux server is reachable without blocking the event loop. */
  async isAvailable(): Promise<boolean> {
    if (!this.dependencies || !this.config) return false;
    const now = Date.now();
    if (this.cachedAvailability && this.cachedAvailability.expiresAt > now)
      return this.cachedAvailability.value;
    this.availabilityCheck ??= this.probeAvailable()
      .then((value) => {
        this.cachedAvailability = { value, expiresAt: Date.now() + AVAILABILITY_TTL_MS };
        return value;
      })
      .finally(() => {
        this.availabilityCheck = undefined;
      });
    return this.availabilityCheck;
  }

  async getReason(): Promise<string | undefined> {
    return (await this.isAvailable())
      ? undefined
      : this.dependencies
        ? "The system terminal service is not running on this host."
        : "The installer has not enabled the system terminal on this host.";
  }

  constructor(private readonly config: Config["computerTerminal"]) {
    this.target = `${userInfo().username}@${hostname()}${config ? ` · ${config.cwd}` : ""}`;
    this.dependencies = Boolean(
      config &&
      existsSync(host) &&
      existsSync(config.cwd) &&
      (config.runtime.startsWith("/")
        ? existsSync(config.runtime)
        : spawnSync(config.runtime, ["--version"], { timeout: 2000 }).status === 0) &&
      spawnSync("tmux", ["-V"], { timeout: 2000 }).status === 0,
    );
    if (this.dependencies && config) {
      mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
      const info = lstatSync(config.stateDirectory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.mode & 0o077 ||
        info.uid !== process.getuid?.()
      )
        throw new Error("Computer state must be an owner-only directory owned by the app account");
    }
  }
  sessionId(userId: string) {
    return "member-" + createHash("sha256").update(userId).digest("hex").slice(0, 32);
  }
  /** Member shell names on the running tmux server. */
  async sessions(): Promise<string[]> {
    if (!(await this.isAvailable()) || !this.config) return [];
    try {
      const { stdout } = await execFileAsync(
        "tmux",
        [
          "-N",
          "-S",
          join(this.config.stateDirectory, "tmux.sock"),
          "list-sessions",
          "-F",
          "#{session_name}",
        ],
        { timeout: 2000, encoding: "utf8" },
      );
      return stdout.split("\n").filter((name) => /^member-[a-f0-9]{32}$/.test(name));
    } catch {
      return [];
    }
  }
  private arguments(sessionId: string) {
    if (!this.dependencies || !this.config)
      throw httpError(409, "The installer has not enabled the system terminal on this host.");
    return [
      "run",
      "--no-env-file",
      "--no-install",
      host,
      "--socket",
      join(this.config.stateDirectory, "tmux.sock"),
      "--session",
      sessionId,
      "--cwd",
      this.config.cwd,
    ];
  }
  attach(userId: string) {
    const args = this.arguments(this.sessionId(userId));
    const child = spawn(this.config!.runtime, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, LANG: process.env.LANG },
    });
    this.children.add(child);
    child.once("close", () => this.children.delete(child));
    return child;
  }
  end(userId: string) {
    return this.endSession(this.sessionId(userId));
  }
  async endSession(sessionId: string) {
    if (!(await this.isAvailable()))
      throw httpError(
        409,
        (await this.getReason()) ?? "The system terminal service is not running on this host.",
      );
    const args = this.arguments(sessionId);
    const child = spawn(this.config!.runtime, [...args, "--end"], {
      stdio: "ignore",
      env: { PATH: process.env.PATH, LANG: process.env.LANG },
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("Terminal could not be ended")),
      );
    });
  }
  close() {
    for (const child of this.children) child.stdin.end();
  }
}
