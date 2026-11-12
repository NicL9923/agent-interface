import { defineConfig } from "vitest/config";
// Runs only the turn freeze measurement; `npm test` never picks it up.
export default defineConfig({
  test: {
    include: [".agents/tools/measure-turn-freeze.test.ts"],
    environment: "node",
    testTimeout: 600_000,
  },
});
