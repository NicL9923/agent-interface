import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";

const production = {
  NODE_ENV: "production", APP_ORIGIN: "https://assistants.example.com",
  GOOGLE_CLIENT_ID: "fixture-client", HOUSEHOLD_EMAILS: "one@example.com,two@example.com",
};
const upgrades = {
  HERMES_UPGRADE_ENABLED: "true", HERMES_UPGRADE_ADMINS: "one@example.com",
  HERMES_UPGRADE_CONFIG: "/private/worker.json", HERMES_UPGRADE_STATE_DIR: "/private/state",
  HERMES_UPGRADE_PYTHON: "/usr/bin/python3",
};

describe("integration administrators", () => {
  it("requires household membership and normalizes an explicit administrator list", () => {
    expect(() => loadConfig({ ...production, HERMES_INTEGRATION_ADMINS: "outsider@example.com" }))
      .toThrow("Integration administrators must belong to the household allowlist");
    expect(loadConfig({ ...production, HERMES_INTEGRATION_ADMINS: " TWO@example.com, two@example.com " }).integrationAdmins)
      .toEqual(["two@example.com"]);
  });

  it("inherits update administrators only when no explicit integration policy is supplied", () => {
    expect(loadConfig({ ...production, ...upgrades }).integrationAdmins).toEqual(["one@example.com"]);
    expect(loadConfig({ ...production, ...upgrades, HERMES_INTEGRATION_ADMINS: "" }).integrationAdmins).toEqual([]);
    expect(loadConfig(production).integrationAdmins).toEqual([]);
  });
});
