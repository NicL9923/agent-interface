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
  it("has path data for every mark", () => {
    for (const path of Object.values(providerIconPaths)) expect(path).toMatch(/^M[\d.-]/);
  });
});
