import "node:process";
import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { fileSigner } from "./file-signer.js";
import { composeServerRuntime } from "./native-harness.js";
import { Store, schemaVersion } from "./store.js";
import { safeError } from "./logging.js";
import { SHUTDOWN_EXIT_MS } from "./shutdown.js";
if (existsSync(".env")) loadEnvFile(".env");
const config = loadConfig();
const store = new Store(config.database);
const files = fileSigner(store.fileKeys());
const references = store.upgradeFileReferences(files);
const server = await composeServerRuntime({ config, store, files });
// pino writes JSON lines to stdout; systemd keeps them in journald.
const { app, directRoutes, macs } = await createApp(
  { ...config, logLevel: config.logLevel ?? "info" },
  server.runtime,
  { store, probeHarnesses: server.probeHarnesses, closeServices: () => server.close() },
);
server.attachMacs(macs);
if (server.sweptQueueItems)
  app.log.warn(
    { sweptQueueItems: server.sweptQueueItems },
    "Interrupted queued messages left running before the restart",
  );
if (references.upgraded)
  app.log.info(references, "Re-signed stored file identifiers with the app's file key");
if (references.unreadable)
  app.log.warn(references, "Left stored file identifiers that could not be verified");
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
      () => {
        clearTimeout(deadline);
        app.log.info("WildBots stopped");
        process.exit(0);
      },
      (error) => {
        clearTimeout(deadline);
        app.log.error({ error: safeError(error) }, "WildBots did not stop cleanly");
        process.exit(1);
      },
    );
  });
