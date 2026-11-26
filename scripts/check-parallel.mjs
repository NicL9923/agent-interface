import { spawn } from "node:child_process";

// All five checks own their prerequisites. None consumes another check's output.
const checks = ["lint", "format:check", "typecheck", "build", "test"];
const results = await Promise.allSettled(
  checks.map(
    (name) =>
      new Promise((resolve, reject) => {
        const child = spawn("pnpm", ["run", name], { stdio: "inherit", shell: false });
        child.on("error", reject);
        child.on("exit", (code, signal) => {
          console.log(`check ${name}: ${signal || code}`);
          if (code === 0) resolve();
          else reject(new Error(`${name} failed with ${signal || code}`));
        });
      }),
  ),
);
for (const result of results) {
  if (result.status === "rejected") console.error(result.reason);
}
process.exitCode = results.some((result) => result.status === "rejected") ? 1 : 0;
