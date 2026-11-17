import { afterAll, vi } from "vitest";

// Files install different I/O mocks for the same client API. Re-evaluate app modules
// between files so an earlier import cannot retain the preceding file's mock.
// Process globals still share a worker, which the shuffled run exercises.
vi.resetModules();

// File-scoped stubs from beforeAll must survive every test in that file.
afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
