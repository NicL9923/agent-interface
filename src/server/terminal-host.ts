#!/usr/bin/env bun
/** A bounded PTY attachment to an app-owned tmux server. Detach preserves the shell. */

import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";

declare const Bun: {
  spawn: (
    cmd: string[],
    options: {
      cwd?: string;
      env?: Record<string, string>;
      stdin?: "inherit" | "ignore" | "pipe";
      stdout?: "inherit" | "ignore" | "pipe";
      stderr?: "inherit" | "ignore" | "pipe";
      terminal?: {
        cols: number;
        rows: number;
        name?: string;
        data: (terminal: BunTerminal, data: Uint8Array) => void;
      };
    },
  ) => {
    pid: number;
    exited: Promise<number>;
    kill: (signal?: number | string) => void;
    terminal?: BunTerminal;
  };
};

interface BunTerminal {
  write: (data: string | Uint8Array) => number;
  resize: (cols: number, rows: number) => void;
  close: () => void;
}

function shellEnvironment(): Record<string, string> {
  const account = userInfo();
  // Never let service/provider credentials enter a human shell or the tmux server.
  return {
    HOME: account.homedir,
    USER: account.username,
    LOGNAME: account.username,
    SHELL: account.shell || "/bin/bash",
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    LANG: process.env.LANG || "C.UTF-8",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };
}

function emit(value: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      socket: { type: "string" },
      session: { type: "string" },
      cwd: { type: "string" },
      end: { type: "boolean", default: false },
      serve: { type: "boolean", default: false },
    },
  });

  const socket = values.socket;
  const session = values.session;
  const cwd = values.cwd;
  const end = Boolean(values.end);
  const serve = Boolean(values.serve);

  if (!socket || !cwd) {
    throw new Error("Missing required --socket or --cwd");
  }
  if (serve && (session || end)) {
    throw new Error("The terminal supervisor does not attach a session");
  }
  if (!serve && !/^member-[a-f0-9]{32}$/.test(session ?? "")) {
    throw new Error("Invalid terminal identity");
  }
  if (!isAbsolute(socket) || !isAbsolute(cwd)) {
    throw new Error("Terminal paths must be absolute");
  }

  const env = shellEnvironment();

  if (serve) {
    // Foreground server owns pane processes independently of app cgroups.
    // -D also disables exit-empty, so the first member may attach later.
    const server = Bun.spawn(["tmux", "-f", "/dev/null", "-S", socket, "-D"], {
      cwd,
      env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => server.kill(sig));
    }
    const code = await server.exited;
    process.exit(code);
  }

  // A missing supervisor must fail rather than spawn a server in the app unit.
  const baseCommand = ["tmux", "-N", "-f", "/dev/null", "-S", socket];
  if (end) {
    const exists = spawnSync(
      baseCommand[0],
      [...baseCommand.slice(1), "has-session", "-t", `=${session}`],
      {
        env,
        stdio: "ignore",
      },
    );
    if (exists.status === 0) {
      const killed = spawnSync(
        baseCommand[0],
        [...baseCommand.slice(1), "kill-session", "-t", `=${session}`],
        { env, stdio: "ignore" },
      );
      if (killed.status !== 0) {
        throw new Error("Could not kill terminal session");
      }
    }
    return;
  }

  const decoder = new TextDecoder("utf-8");
  const child = Bun.spawn(
    [...baseCommand, "new-session", "-A", "-s", session!, "-c", cwd, env.SHELL, "-l"],
    {
      cwd,
      env,
      terminal: {
        cols: 80,
        rows: 24,
        name: "xterm-256color",
        data(_term, data) {
          const text = decoder.decode(data, { stream: true });
          if (text) emit({ type: "output", data: text });
        },
      },
    },
  );

  const term = child.terminal!;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try {
      term.close();
    } catch {
      /* Already closed. */
    }
    try {
      // SIGHUP detaches this tmux client, not its shell.
      child.kill("SIGHUP");
    } catch {
      /* Already gone. */
    }
  };

  let pending = Buffer.alloc(0);
  let fatalError: unknown = null;

  const done = new Promise<void>((resolve, reject) => {
    const finish = () => {
      cleanup();
      if (fatalError) reject(fatalError);
      else resolve();
    };

    void child.exited.then(() => {
      const tail = decoder.decode();
      if (tail) emit({ type: "output", data: tail });
      process.stdin.pause();
      finish();
    });

    process.stdin.on("data", (chunk: Buffer | string) => {
      try {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        pending = Buffer.concat([pending, bytes]);
        if (pending.length > 131072) {
          throw new Error("Terminal input exceeds limit");
        }
        let nl = pending.indexOf(0x0a);
        while (nl !== -1) {
          const line = pending.subarray(0, nl).toString("utf8");
          pending = pending.subarray(nl + 1);
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.type === "input") {
            const text = message.data;
            if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 16384) {
              throw new Error("Invalid terminal input");
            }
            term.write(text);
          } else if (message.type === "resize") {
            const cols = message.columns;
            const rows = message.rows;
            if (
              typeof cols !== "number" ||
              typeof rows !== "number" ||
              !Number.isInteger(cols) ||
              !Number.isInteger(rows) ||
              cols < 2 ||
              cols > 500 ||
              rows < 2 ||
              rows > 300
            ) {
              throw new Error("Invalid terminal size");
            }
            term.resize(cols, rows);
          } else {
            throw new Error("Unknown terminal message");
          }
          nl = pending.indexOf(0x0a);
        }
      } catch (error) {
        fatalError = error;
        process.stdin.pause();
        finish();
      }
    });

    process.stdin.on("end", finish);
    process.stdin.on("close", finish);
    process.stdin.on("error", finish);
  });

  emit({ type: "ready" });
  await done;
  await child.exited.catch(() => undefined);
}

main().catch(() => {
  // Exceptions can carry host paths. Keep these out of browser output.
  emit({ type: "error", message: "The system terminal could not be attached." });
  process.exit(1);
});
