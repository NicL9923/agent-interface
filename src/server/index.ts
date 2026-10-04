import "node:process";
import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createHermesRuntime } from "./hermes.js";
import { schemaVersion } from "./store.js";
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
app.log.info({ origin: config.origin, schemaVersion, node: process.version }, "Agent Interface started");
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    app.log.info({ signal }, "Agent Interface stopping");
    void app.close().then(
      () => { app.log.info("Agent Interface stopped"); process.exit(0); },
      error => { app.log.error({ err: error }, "Agent Interface did not stop cleanly"); process.exit(1); },
    );
  });
