import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const build = "scripts/build-server.mjs";
const check = "scripts/bun-service-check.mjs";
const bundle = "dist/server/index.js";
const host = "127.0.0.1";

it("reports how to install Bun when the build cannot find it on PATH", async () => {
  await expect(
    run(process.execPath, [build], { cwd: root, env: { PATH: "" }, timeout: 5_000 }),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Bun is missing from PATH") });
});

it(
  "builds and starts the systemd server bundle under Bun 1.4.5",
  { timeout: 25_000 },
  async ({ skip }) => {
    const { stdout } = await run("bun", ["--no-env-file", "-p", "process.execPath"], {
      cwd: root,
      timeout: 5_000,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") skip("Bun is absent from PATH");
      throw error;
    });
    const bun = stdout.trim();
    // Each run gets its own dist and database. Bun resolves dependencies from the worktree's pnpm install.
    const release = await mkdtemp(join(root, "node_modules", ".wildbots-bun-"));
    try {
      await mkdir(join(release, "scripts"));
      await Promise.all([
        cp(join(root, build), join(release, build)),
        cp(join(root, check), join(release, check)),
        cp(join(root, "src"), join(release, "src"), { recursive: true }),
        cp(join(root, "package.json"), join(release, "package.json")),
        cp(join(root, "tsconfig.json"), join(release, "tsconfig.json")),
      ]);
      const preflight = (binary: string) =>
        run(process.execPath, [check, binary], { cwd: release, timeout: 7_000 });

      await expect(preflight("bun")).rejects.toMatchObject({
        stderr: expect.stringContaining("provide the absolute path to Bun"),
      });
      await expect(preflight(join(release, "missing-bun"))).rejects.toMatchObject({
        stderr: expect.stringContaining("Cannot run Bun at "),
      });
      await expect(preflight(process.execPath)).rejects.toMatchObject({
        stderr: expect.stringContaining("Expected Bun 1.4.5"),
      });
      await expect(preflight(bun)).rejects.toMatchObject({
        stderr: expect.stringContaining("Run pnpm run build:server:bun."),
      });

      await run(process.execPath, [build], { cwd: release, timeout: 10_000 });
      expect((await preflight(bun)).stdout).toContain("Bun 1.4.5");
      expect(await readFile(join(release, bundle), "utf8")).toMatch(
        /\/\/# sourceMappingURL=index\.js\.map/,
      );
      expect(await readFile(join(release, "dist/server/terminal-host.js"), "utf8")).toContain(
        "The system terminal could not be attached.",
      );

      const listener = createServer().listen(0, host);
      await once(listener, "listening");
      const { port } = listener.address() as AddressInfo;
      listener.close();
      await once(listener, "close");

      // This value would stop the server at startup if Bun loaded the release's .env.local.
      await writeFile(join(release, ".env.local"), "LOG_LEVEL=invalid\n");
      const child = spawn(bun, ["run", "--no-env-file", "--no-install", bundle], {
        cwd: release,
        env: {
          PATH: process.env.PATH,
          HOST: host,
          PORT: String(port),
          APP_ORIGIN: `http://${host}:${port}`,
          APP_DATABASE: join(release, "app.sqlite"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk));
      const closed = new Promise((resolve) => {
        child.once("error", (error) => (output += error.message));
        child.once("close", (code, signal) => resolve([code, signal]));
      });
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        await expect
          .poll(
            async () => {
              const response = await fetch(`http://${host}:${port}/api/health`, {
                signal: AbortSignal.timeout(1_000),
              });
              return response.json();
            },
            { timeout: 5_000 },
          )
          .toEqual({ ok: true });
        child.kill("SIGTERM");
        expect(await closed, output).toEqual([0, null]);
      } catch (error) {
        throw new Error(`Bundled server failed.\n${output}`, { cause: error });
      } finally {
        clearTimeout(watchdog);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      }
    } finally {
      await rm(release, { recursive: true, force: true });
    }
  },
);
