import { defineConfig } from "vitest/config";

// Only paths with reproduced shared-worker failures are isolated. All 79 prior
// exceptions were retired after fixing jsdom focus-fixup fake-timer deadlocks,
// timer spy restoration ordering, and file-scoped DOM/URL/navigator cleanup;
// see docs/ledger/2026-11-19-platform-improvements.md.
const isolated: string[] = [];
export default defineConfig({
  test: {
    isolate: false,
    environment: "node",
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/reset-modules.ts", "tests/setup-ui.ts"],
    testTimeout: 15000,
    projects: [
      {
        extends: true,
        test: {
          name: "shared",
          include: ["tests/**/*.test.ts"],
          isolate: false,
          exclude: isolated,
        },
      },
      ...(isolated.length
        ? [
            {
              extends: true as const,
              test: { name: "browser-and-socket-contracts", isolate: true, include: isolated },
            },
          ]
        : []),
    ],
  },
});
