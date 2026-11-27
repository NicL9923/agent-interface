/** Real PTY/tmux acceptance for src/server/terminal-host.ts under Bun. */

import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const HOST = fileURLToPath(new URL("../src/server/terminal-host.ts", import.meta.url));
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const hasBun = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;

it(
  "preserves shell across reconnects, resizes, interrupts, scrubs env, and handles large pastes",
  { timeout: 30_000 },
  async ({ skip }) => {
    if (!hasTmux || !hasBun) skip("Real terminal acceptance requires tmux and bun");

    const directory = mkdtempSync(join(tmpdir(), "computer-terminal-"));
    const socket = join(directory, "tmux.sock");
    const session = `member-${"a".repeat(32)}`;
    const baseArgs = [
      "run",
      "--no-env-file",
      "--no-install",
      HOST,
      "--socket",
      socket,
      "--session",
      session,
      "--cwd",
      directory,
    ];

    const server = spawn(
      "bun",
      [
        "run",
        "--no-env-file",
        "--no-install",
        HOST,
        "--serve",
        "--socket",
        socket,
        "--cwd",
        directory,
      ],
      { stdio: "ignore" },
    );

    const clients: ChildProcessWithoutNullStreams[] = [];

    const waitForTmux = async () => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (
          spawnSync("tmux", ["-N", "-S", socket, "show-options", "-s"], { stdio: "ignore" })
            .status === 0
        ) {
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("The independent tmux supervisor did not start");
    };

    const attach = () => {
      const proc = spawn("bun", baseArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          HERMES_TOKEN: "PRIVATE_SERVICE_FIXTURE",
          OPENAI_API_KEY: "PRIVATE_PROVIDER_FIXTURE",
        },
      });
      clients.push(proc);
      return proc;
    };

    const send = (proc: ChildProcessWithoutNullStreams, value: Record<string, unknown>) => {
      proc.stdin.write(`${JSON.stringify(value)}\n`);
    };

    const waitOutput = (
      proc: ChildProcessWithoutNullStreams,
      expected: string,
      timeoutMs = 8_000,
    ) =>
      new Promise<string>((resolve, reject) => {
        let pending = "";
        let output = "";
        const timer = setTimeout(() => {
          cleanup();
          reject(
            new Error(`Timed out waiting for ${JSON.stringify(expected)}: ${output.slice(-500)}`),
          );
        }, timeoutMs);
        const onData = (chunk: Buffer) => {
          pending += chunk.toString("utf8");
          let nl = pending.indexOf("\n");
          while (nl !== -1) {
            const line = pending.slice(0, nl);
            pending = pending.slice(nl + 1);
            const value = JSON.parse(line) as { type?: string; data?: string };
            if (value.type === "error") {
              cleanup();
              reject(new Error(`Terminal emitted error: ${line}`));
              return;
            }
            if (value.data) output += value.data;
            nl = pending.indexOf("\n");
          }
          if (output.includes(expected)) {
            cleanup();
            resolve(output);
          }
        };
        const onClose = () => {
          cleanup();
          reject(new Error(`Terminal exited before expected output: ${output.slice(-500)}`));
        };
        const cleanup = () => {
          clearTimeout(timer);
          proc.stdout.off("data", onData);
          proc.off("close", onClose);
        };
        proc.stdout.on("data", onData);
        proc.once("close", onClose);
      });

    try {
      await waitForTmux();
      const first = attach();
      send(first, { type: "resize", columns: 100, rows: 32 });
      send(first, {
        type: "input",
        data: `export COMPUTER_PERSISTED='shared-🌵'; printf '\\nENV=%s:%s SIZE=' "\${HERMES_TOKEN-unset}" "\${OPENAI_API_KEY-unset}"; stty size\n`,
      });
      // tmux's status line occupies one of the attached terminal rows.
      const output = await waitOutput(first, "ENV=unset:unset SIZE=31 100");
      expect(output).not.toContain("PRIVATE_SERVICE_FIXTURE");
      expect(output).not.toContain("PRIVATE_PROVIDER_FIXTURE");

      // Abrupt death of the attachment preserves the supervisor-owned shell.
      first.kill("SIGKILL");
      await new Promise((r) => first.once("exit", r));

      const second = attach();
      send(second, {
        type: "input",
        data: `printf '\\nPERSIST=%s\\n' "$COMPUTER_PERSISTED"\n`,
      });
      await waitOutput(second, "PERSIST=shared-🌵");

      send(second, { type: "input", data: "sleep 30\n" });
      await new Promise((r) => setTimeout(r, 200));
      send(second, { type: "input", data: "\u0003printf '\\nINTERRUPT=%s\\n' survived\n" });
      await waitOutput(second, "INTERRUPT=survived");

      // Large paste arrives without loss or deadlock.
      const payload = Buffer.from("bounded-paste-🌵".repeat(8000), "utf8");
      const expectedHash = createHash("sha256").update(payload).digest("hex");
      const readerCode = `const crypto=require("node:crypto");const target=${payload.length};process.stdin.setRawMode(true);process.stdin.resume();const chunks=[];let got=0;console.log("RAW_READY");process.stdin.on("data",(c)=>{chunks.push(c);got+=c.length;if(got>=target){const buf=Buffer.concat(chunks).subarray(0,target);process.stdin.setRawMode(false);console.log("PASTE_HASH="+crypto.createHash("sha256").update(buf).digest("hex"));process.exit(0);}});`;
      send(second, {
        type: "input",
        data: `node -e ${JSON.stringify(readerCode)}\n`,
      });
      await waitOutput(second, "RAW_READY\r\n");
      const text = payload.toString("utf8");
      for (let start = 0; start < text.length; start += 3000) {
        send(second, { type: "input", data: text.slice(start, start + 3000) });
      }
      await waitOutput(second, `PASTE_HASH=${expectedHash}`, 15_000);

      execFileSync("bun", [...baseArgs, "--end"], { timeout: 5_000 });
      await new Promise((r) => second.once("exit", r));
      const hasSession = spawnSync("tmux", ["-S", socket, "has-session", "-t", `=${session}`], {
        stdio: "ignore",
      });
      expect(hasSession.status).not.toBe(0);
    } finally {
      for (const proc of clients) {
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }
      spawnSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
      if (server.exitCode === null) server.kill("SIGTERM");
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
