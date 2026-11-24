import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { userInfo } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const username = /^[a-z_][a-z0-9_-]{0,31}$/;
const envName = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const locale = ["LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ", "TERM"];
const systemPath = "/usr/local/bin:/usr/bin:/bin";
const graceMs = 1_000;

export function validateHarnessOsUser(osUser: string): void {
  if (!username.test(osUser) || /\s/.test(osUser))
    throw new Error("Invalid Unix user for a harness process.");
}

/** The effective account when the server must switch users, also used to provision workspace access. */
export function otherHarnessUser(osUser?: string): string | undefined {
  if (osUser === undefined) return undefined;
  validateHarnessOsUser(osUser);
  return osUser === userInfo().username ? undefined : osUser;
}

export const reservedHarnessEnvironment = (key: string) =>
  /^(?:HOME$|USER$|LOGNAME$|SHELL$|PATH$|LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|SUDO_|WILDBOTS_|HERMES_|APP_|APNS_|VAPID_|MAC_LINK_|COMPUTER_|SSH_|XDG_|BASH_ENV$|ENV$)/i.test(
    key,
  );

function explicitEnvironment(overrides: Record<string, string> = {}) {
  const env: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(overrides)) {
    if (!envName.test(key) || reservedHarnessEnvironment(key) || value.includes("\0"))
      throw new Error(`Invalid harness environment override: ${key}`);
    env[key] = value;
  }
  return env;
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return false;
  }
}

// sudo relays signals to this supervisor. It owns the actual command's group, so it can
// reach every member even when the server's Unix user has no permission to signal them.
const supervise = `
  const { spawn } = require("node:child_process");
  const { userInfo } = require("node:os");
  const [keys, command, ...args] = process.argv.slice(1);
  const { homedir, username, shell } = userInfo();
  const env = {
    HOME: homedir, USER: username, LOGNAME: username, SHELL: shell ?? "/bin/sh",
    PATH: homedir + "/.local/bin:${systemPath}",
  };
  for (const key of JSON.parse(keys)) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const child = spawn(command, args, { env, detached: true, stdio: "inherit" });
  let closing = false;
  function signal(value) {
    if (!child.pid) return false;
    try {
      process.kill(-child.pid, value);
      return true;
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      return false;
    }
  }
  function close(code) {
    if (closing) return;
    closing = true;
    if (!signal("SIGTERM")) process.exit(code);
    setTimeout(() => {
      signal("SIGKILL");
      process.exit(code);
    }, ${graceMs});
  }
  process.on("SIGTERM", () => close(143));
  process.on("SIGHUP", () => close(129));
  child.once("exit", (code) => close(code ?? 1));
  child.once("error", (error) => {
    console.error(error.message);
    close(1);
  });
`;

export interface HarnessProcessOptions {
  cwd: string;
  osUser?: string;
  /** Session-scoped values supplied by trusted server configuration. */
  env?: Record<string, string>;
}

export function spawnHarnessProcess(
  command: string,
  args: readonly string[],
  options: HarnessProcessOptions,
): { child: ChildProcessWithoutNullStreams; close: () => Promise<void> } {
  const otherUser = otherHarnessUser(options.osUser);
  const explicit = explicitEnvironment(options.env);
  const ambient = Object.fromEntries(locale.map((key) => [key, process.env[key]]));
  const { homedir, username, shell } = userInfo();
  const env = otherUser
    ? { PATH: systemPath, ...ambient, ...explicit }
    : {
        PATH: `${homedir}/.local/bin:${systemPath}`,
        HOME: homedir,
        USER: username,
        LOGNAME: username,
        SHELL: shell ?? "/bin/sh",
        ...ambient,
        ...explicit,
      };
  const argv = otherUser
    ? [
        "-n",
        "-u",
        otherUser,
        ...(Object.keys(explicit).length
          ? [`--preserve-env=${Object.keys(explicit).join(",")}`]
          : []),
        "--",
        process.execPath,
        "-e",
        supervise,
        "--",
        JSON.stringify([...locale, ...Object.keys(explicit)]),
        command,
        ...args,
      ]
    : args;
  const child = spawn(otherUser ? "/usr/bin/sudo" : command, argv, {
    cwd: options.cwd,
    env,
    detached: true,
    shell: false,
    stdio: "pipe",
  });
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    const done = () => {
      exited = true;
      resolve();
    };
    child.once("exit", done);
    child.once("error", done);
  });
  let closing: Promise<void> | undefined;

  async function teardown() {
    const pid = child.pid;
    if (pid === undefined) return;
    if (otherUser) {
      if (exited || !child.kill("SIGTERM")) return;
      const finished = await Promise.race([
        exit.then(() => true),
        delay(graceMs * 2, false, { ref: false }),
      ]);
      if (!finished) child.kill("SIGKILL");
    } else if (signalGroup(pid, "SIGTERM")) {
      // The group can outlive its leader, including when the leader just exited on TERM.
      const deadline = Date.now() + graceMs;
      while (Date.now() < deadline && signalGroup(pid, 0)) await delay(25);
      signalGroup(pid, "SIGKILL");
    }
    await exit;
  }
  const close = () => (closing ??= teardown());
  if (!otherUser) child.once("exit", () => void close().catch(() => {}));
  return { child, close };
}
