import "node:process";
import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createHermesRuntime } from "./hermes.js";
import { schemaVersion } from "./store.js";
import { safeError } from "./logging.js";
if (existsSync(".env")) loadEnvFile(".env");
const config = loadConfig();
const runtime = createHermesRuntime({
  url: config.hermesUrl,
  token: config.hermesToken,
  authMode: config.hermesAuthMode,
  qualificationFile: config.hermesQualificationFile,
});
// pino writes JSON lines to stdout; systemd keeps them in journald.
const { app } = await createApp({ ...config, logLevel: config.logLevel ?? "info" }, runtime);
await app.listen({ host: config.host, port: config.port });
app.log.info({ origin: config.origin, schemaVersion, node: process.version }, "WildBots started");
let stopping: Promise<void> | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) return;
    app.log.info({ signal }, "WildBots stopping");
    const deadline = setTimeout(() => {
      app.log.error("WildBots shutdown deadline reached");
      process.exit(1);
    }, 30000);
    stopping = app.close().then(
      () => { clearTimeout(deadline); app.log.info("WildBots stopped"); },
      error => { clearTimeout(deadline); app.log.error({ error: safeError(error) }, "WildBots did not stop cleanly"); process.exit(1); },
    );
  });
