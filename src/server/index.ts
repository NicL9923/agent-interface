import "node:process";
import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createHermesRuntime } from "./hermes.js";
import { createRuntimeRouter, hermesRuntimeId } from "./runtime-router.js";
import { Store, schemaVersion } from "./store.js";
import { fileSigner } from "./hermes-files.js";
import { safeError } from "./logging.js";
import { SHUTDOWN_EXIT_MS } from "./shutdown.js";
if (existsSync(".env")) loadEnvFile(".env");
const config = loadConfig();
const store = new Store(config.database);
// File identifiers are signed with the database's own key. The Hermes token only verifies older ones,
// and stored ones are re-signed here, before anything reads them, so a token rotation leaves them working.
const files = fileSigner(store.fileKeys(), config.hermesToken);
const references = store.upgradeFileReferences(files);
const hermes = createHermesRuntime({
  url: config.hermesUrl,
  token: config.hermesToken,
  authMode: config.hermesAuthMode,
  qualificationFile: config.hermesQualificationFile,
  files,
});
// Every assistant runs on Hermes until docs/RuntimePlan.md step 2 registers a second runtime and names its assistants.
const runtime = createRuntimeRouter({ runtimes: { [hermesRuntimeId]: hermes }, defaultRuntime: hermesRuntimeId });
// pino writes JSON lines to stdout; systemd keeps them in journald.
const { app, directRoutes } = await createApp({ ...config, logLevel: config.logLevel ?? "info" }, runtime, { store });
if (references.upgraded) app.log.info(references, "Re-signed stored file identifiers with the app's file key");
if (references.unreadable) app.log.warn(references, "Left stored file identifiers that could not be verified");
await app.listen({ host: config.host, port: config.port });
await directRoutes?.start();
app.log.info({ origin: config.origin, schemaVersion, node: process.version }, "WildBots started");
let stopping: Promise<void> | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) return;
    app.log.info({ signal }, "WildBots stopping");
    const deadline = setTimeout(() => {
      app.log.error("WildBots shutdown deadline reached");
      process.exit(1);
    }, SHUTDOWN_EXIT_MS);
    stopping = app.close().then(
      () => { clearTimeout(deadline); app.log.info("WildBots stopped"); process.exit(0); },
      error => { clearTimeout(deadline); app.log.error({ error: safeError(error) }, "WildBots did not stop cleanly"); process.exit(1); },
    );
  });
