import { defineConfig } from "vitest/config";
// Runs only the streaming parse benchmark; `npm test` never picks it up.
export default defineConfig({
  test: {
    include: [".agents/tools/streaming-parse-bench.test.ts"],
    environment: "jsdom",
    setupFiles: ["tests/setup-ui.ts"],
    testTimeout: 600_000,
  },
});
