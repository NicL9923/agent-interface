import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { providerIconKey, providerIconPaths } from "../src/shared/provider-icon";

describe("providerIconKey", () => {
  it.each([
    ["anthropic", "anthropic"], ["claude", "anthropic"], ["claude-code", "anthropic"],
    ["openai", "openai"], ["openai-codex", "openai"], ["openai-api", "openai"], ["chatgpt", "openai"],
    ["gemini", "google"], ["google", "google"], ["google-gemini-cli", "google"], ["google-ai-studio", "google"],
    ["xai", "xai"], ["xai-oauth", "xai"], ["grok", "xai"], ["x-ai", "xai"],
    ["openrouter", "openrouter"], ["nous", "nous"], ["nous-portal", "nous"],
    ["ollama", "ollama"], ["ollama-cloud", "ollama"], ["mistral", "mistral"], ["deepseek", "deepseek"],
    [" Anthropic ", "anthropic"],
    // A custom or unfamiliar provider is not guessed at. A look-alike name must not borrow a mark.
    ["custom:house", "generic"], ["lmstudio", "generic"], ["openaix", "generic"], ["", "generic"], [undefined, "generic"],
  ] as const)("%s gets the %s mark", (slug, key) => expect(providerIconKey(slug)).toBe(key));
  it("draws the iOS marks from the same paths, as ios/tools/sync-provider-icons.mjs writes them", () => {
    const catalog = "ios/AgentInterface/Assets.xcassets/ProviderIcons";
    for (const [key, path] of Object.entries(providerIconPaths)) {
      const svg = readFileSync(`${catalog}/provider-${key}.imageset/provider-${key}.svg`, "utf8");
      expect(svg, `Run node --import tsx ios/tools/sync-provider-icons.mjs: ${key} is out of step`).toContain(`<path d="${path}"/>`);
    }
  });
  it("lists every mark in the Swift table", () => {
    const swift = readFileSync("ios/AgentInterface/ProviderIcon.swift", "utf8");
    const keys = /case ([a-z, ]+)\n  var assetName/.exec(swift)![1].split(",").map(key => key.trim());
    expect(keys.sort()).toEqual(Object.keys(providerIconPaths).sort());
  });
});
