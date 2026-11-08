import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Refuses to run on a Node outside package.json engines; see tests/global-setup.ts.
    globalSetup: ["tests/global-setup.ts"],
    // Teardown and the React act flag for every jsdom file; node files skip it.
    setupFiles: ["tests/setup-ui.ts"],
    testTimeout: 15000,
  },
});
