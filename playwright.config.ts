import { defineConfig, devices } from "@playwright/test";
import { port } from "./e2e/ports.js";

// Run `npm run build` first: the server in e2e/server.ts serves dist/client.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx tsx e2e/server.ts",
    url: `http://127.0.0.1:${port}/api/auth/config`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
