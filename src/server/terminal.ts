import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";

const host = fileURLToPath(new URL("./terminal-host.py", import.meta.url));
export class SystemTerminal {
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  readonly target: string;
  private readonly dependencies: boolean;
  get available() {
    return Boolean(this.dependencies && this.config && spawnSync("tmux", ["-N", "-S", join(this.config.stateDirectory, "tmux.sock"), "show-options", "-s"], {timeout: 2000}).status === 0);
  }
  get reason() {
    return this.available ? undefined : this.dependencies
      ? "The system terminal service is not running on this host."
      : "The installer has not enabled the system terminal on this host.";
  }
  constructor(private readonly config: Config["computerTerminal"]) {
    this.target = `${userInfo().username}@${hostname()}${config ? ` · ${config.cwd}` : ""}`;
    this.dependencies = Boolean(config && existsSync(config.python) && existsSync(config.cwd)
      && spawnSync("tmux", ["-V"], {timeout: 2000}).status === 0);
    if (this.dependencies && config) {
      mkdirSync(config.stateDirectory, {recursive: true, mode: 0o700});
      const info = lstatSync(config.stateDirectory);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid?.())
        throw new Error("Computer state must be an owner-only directory owned by the app account");
    }
  }
  sessionId(userId: string) {
    return "member-" + createHash("sha256").update(userId).digest("hex").slice(0, 32);
  }
  /** Member shell names on the running tmux server. */
  sessions() {
    if (!this.available || !this.config) return [];
    const result = spawnSync("tmux", ["-N", "-S", join(this.config.stateDirectory, "tmux.sock"), "list-sessions", "-F", "#{session_name}"],
      {timeout: 2000, encoding: "utf8"});
    if (result.status !== 0) return [];
    return result.stdout.split("\n").filter(name => /^member-[a-f0-9]{32}$/.test(name));
  }
  private arguments(sessionId: string) {
    if (!this.available || !this.config) throw Object.assign(new Error(this.reason), {statusCode: 409});
    return [host, "--socket", join(this.config.stateDirectory, "tmux.sock"),
      "--session", sessionId, "--cwd", this.config.cwd];
  }
  attach(userId: string) {
    const args = this.arguments(this.sessionId(userId));
    const child = spawn(this.config!.python, args, {stdio: ["pipe", "pipe", "pipe"],
      env: {PATH: process.env.PATH, LANG: process.env.LANG, PYTHONUNBUFFERED: "1"}});
    this.children.add(child);
    child.once("close", () => this.children.delete(child));
    return child;
  }
  end(userId: string) {
    return this.endSession(this.sessionId(userId));
  }
  async endSession(sessionId: string) {
    const args = this.arguments(sessionId);
    const child = spawn(this.config!.python, [...args, "--end"], {stdio: "ignore",
      env: {PATH: process.env.PATH, LANG: process.env.LANG}});
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error("Terminal could not be ended")));
    });
  }
  close() {
    for (const child of this.children) child.stdin.end();
  }
}
