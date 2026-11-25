import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";

const production = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://assistants.example.com",
  GOOGLE_CLIENT_ID: "fixture-client",
  HOUSEHOLD_EMAILS: "one@example.com,two@example.com",
};

describe("integration administrators", () => {
  it("requires household membership and normalizes an explicit administrator list", () => {
    expect(() => loadConfig({ ...production, INTEGRATION_ADMINS: "outsider@example.com" })).toThrow(
      "Integration administrators must belong to the household allowlist",
    );
    expect(
      loadConfig({ ...production, INTEGRATION_ADMINS: " TWO@example.com, two@example.com " })
        .integrationAdmins,
    ).toEqual(["two@example.com"]);
    expect(
      loadConfig({ ...production, HERMES_INTEGRATION_ADMINS: "one@example.com" }).integrationAdmins,
    ).toEqual(["one@example.com"]);
  });

  it("defaults to empty when no integration administrators are configured", () => {
    expect(loadConfig({ ...production, INTEGRATION_ADMINS: "" }).integrationAdmins).toEqual([]);
    expect(loadConfig(production).integrationAdmins).toEqual([]);
  });
});
