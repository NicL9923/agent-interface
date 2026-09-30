import "node:process";
import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createHermesRuntime } from "./hermes.js";
if (existsSync(".env")) loadEnvFile(".env");
const config = loadConfig();
const runtime = createHermesRuntime({
  url: config.hermesUrl,
  token: config.hermesToken,
  authMode: config.hermesAuthMode,
});
const { app } = await createApp(config, runtime);
await app.listen({ host: config.host, port: config.port });
console.log(`Agent Interface listening at ${config.origin}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void app.close().then(() => process.exit(0)));
