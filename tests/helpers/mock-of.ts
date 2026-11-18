import { vi, type MockedFunction } from "vitest";

/** The mock installed at `owner[key]`, read by name so asserting on a stubbed platform method is not an unbound reference. */
export function mockOf<T extends object, K extends keyof T>(owner: T, key: K): MockedFunction<Extract<T[K], (...args: never[]) => unknown>> {
  return vi.mocked(owner[key]) as never;
}
